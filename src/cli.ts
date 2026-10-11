#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND } from "./brand.ts";
import { SEED_ISSUES, triageChangeSet, type SeedIssue } from "./demo/fixture.ts";
import { runDemo, type DemoOptions } from "./demo/run.ts";
import { Engine } from "./engine.ts";
import { githubAppTokenProvider } from "./github/app-auth.ts";
import { GitHubIssuesConnector } from "./github/connector.ts";
import { RestGitHub, type TokenProvider } from "./github/rest.ts";
import { startServer } from "./server/serve.ts";
import { statusCommand, submitCommand } from "./sdk/cli-commands.ts";
import { claudeCodeHookCommand } from "./adapters/claude-code/command.ts";
import { configDir, setTelemetry, telemetry } from "./telemetry/client.ts";
import { createCollector } from "./telemetry/collector.ts";
import type { OutcomeValue } from "./telemetry/schema.ts";

const HELP = `${BRAND.productName}, Phase 0 prototype

Usage: ${BRAND.cli} <demo|serve|submit|status|hook|telemetry> [options]

  demo   Runs the Phase 0 demo in the terminal: grouped review, exactly-once
         commit under retry, post-write verification, reviewable compensation
         and the stale-state gate.
  serve  Starts the web review UI (default http://127.0.0.1:4317/) with the
         seeded change set and simulation controls.
  submit <file|->   Submits a change set (JSON) for review, as an agent would.
                    With --wait, blocks until the reviewer's work is done.
                    Exit codes: 0 verified (or submitted without --wait),
                    3 decided but not verified, 4 timed out, 1 error.
  status <id>       Prints a transaction's agent-facing status (exit 5 = still waiting).
  telemetry on|off|status
                    Opt-in usage telemetry for demo/serve. Off by default; nothing
                    identifying is ever sent (see docs/telemetry.md).
  hook claude-code  Claude Code PreToolUse hook (experimental): routes GitHub issue
                    writes through review. Reads the hook JSON on stdin. See
                    adapters/claude-code/README.md.

Without --repo it runs against an in-memory GitHub simulation and makes no
network calls. With --repo it creates four issues in that repository and
writes to them, so use a disposable repository.

Options:
  --repo owner/name       Disposable repository to run against (live mode)
  --yes                   Confirm live writes to --repo
  --assignee login        A user who can be assigned in --repo (default: repo owner)
  --unassignable login    A user who cannot be assigned there (default: octocat in live mode)
  --ledger-out file       Write the ledger as JSON lines when done (demo)
  --port n                Port for serve (default 4317)
  --host addr             Address for serve (default 127.0.0.1)
  --reviewer name         Reviewer identity shown and recorded by serve (default @reviewer)
  --agent-token t         Require this bearer token on agent endpoints (serve; env BT_AGENT_TOKEN)
  --server url            Review server for submit/status (default http://127.0.0.1:4317, env BT_SERVER)
  --token t               Bearer token for submit/status (env BT_AGENT_TOKEN)
  --wait                  submit: wait for the decision
  --timeout s             submit --wait: give up after s seconds (default 1800)
  --json                  submit/status: machine-readable output
  --telemetry             demo/serve: send opt-in telemetry for this run (env BT_TELEMETRY=1)
  -h, --help              Show this help

Authentication for live mode, in order of preference:
  GitHub App: BT_GITHUB_APP_ID, BT_GITHUB_APP_PRIVATE_KEY_FILE, BT_GITHUB_INSTALLATION_ID
  Token:      GITHUB_TOKEN (fine-grained, Issues read/write on the one repository)`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      yes: { type: "boolean", default: false },
      assignee: { type: "string" },
      unassignable: { type: "string" },
      "ledger-out": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      reviewer: { type: "string" },
      "agent-token": { type: "string" },
      server: { type: "string" },
      token: { type: "string" },
      wait: { type: "boolean", default: false },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
      telemetry: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? "demo";
  if (command === "hook") {
    if (positionals[1] !== "claude-code") {
      console.error("usage: hook claude-code (reads the PreToolUse JSON on stdin)");
      return 1;
    }
    return claudeCodeHookCommand();
  }

  if (command === "telemetry") {
    const sub = positionals[1] ?? "status";
    if (sub === "on" || sub === "off") {
      setTelemetry(sub === "on");
      console.log(`Telemetry ${sub}. Choice saved in ${configDir()}.`);
      return 0;
    }
    if (sub !== "status") {
      console.error("usage: telemetry on|off|status");
      return 1;
    }
    const t = telemetry({ notify: () => {} });
    console.log(`Telemetry is ${t.enabled ? "on" : "off"} (${t.reason}).${t.enabled ? ` Collector: ${t.url ?? "none configured, nothing is sent"}.` : ""}`);
    return 0;
  }

  // Undocumented on purpose: the collector runs on the landing-page host, not on users' machines.
  if (command === "collector") {
    const out = values.out ?? "telemetry-events.jsonl";
    const server = createCollector(out);
    await new Promise<void>((resolve) => server.listen(Number(values.port ?? 4318), values.host ?? "127.0.0.1", resolve));
    const address = server.address();
    console.log(`Telemetry collector on port ${typeof address === "object" && address ? address.port : "?"}, appending to ${out}`);
    return new Promise<number>(() => {});
  }

  if (values.help || !["demo", "serve", "submit", "status"].includes(command)) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  if (command === "submit" || command === "status") {
    const agent = {
      server: values.server ?? process.env.BT_SERVER ?? "http://127.0.0.1:4317",
      ...((values.token ?? process.env.BT_AGENT_TOKEN) ? { token: (values.token ?? process.env.BT_AGENT_TOKEN)! } : {}),
      wait: values.wait,
      ...(values.timeout ? { timeoutSec: Number(values.timeout) } : {}),
      json: values.json,
    };
    return command === "submit" ? submitCommand(positionals[1], agent) : statusCommand(positionals[1], agent);
  }

  let live: DemoOptions["live"];
  if (values.repo) {
    const [owner, repo] = values.repo.split("/");
    if (!owner || !repo) throw new Error("--repo must look like owner/name");
    if (!values.yes) {
      console.error(`Live mode creates 4 issues in ${values.repo} and writes to them. Re-run with --yes to confirm.`);
      return 2;
    }
    live = { transport: new RestGitHub({ token: tokenFromEnv() }), owner, repo, assignee: values.assignee ?? owner };
  }

  const usage = telemetry({ flag: values.telemetry });
  const mode = live ? "live" : "sandbox";

  if (command === "serve") {
    let liveEngine: { engine: Engine; repo: string } | undefined;
    if (live) {
      // Seed a disposable repository and submit the triage change set, as the demo agent would.
      const numbers = {} as Record<SeedIssue["key"], number>;
      for (const s of SEED_ISSUES) numbers[s.key] = (await live.transport.createIssue(live.owner, live.repo, { title: s.title, body: s.body, labels: s.labels })).number;
      const engine = new Engine({ connectors: [new GitHubIssuesConnector(live.transport)] });
      await engine.submit(triageChangeSet(live.owner, live.repo, numbers, { owner: live.assignee, unassignable: values.unassignable ?? "octocat" }));
      liveEngine = { engine, repo: values.repo! };
    }
    const { url } = await startServer({
      ...(values.port ? { port: Number(values.port) } : {}),
      ...(values.host ? { host: values.host } : {}),
      ...(values.reviewer ? { reviewer: values.reviewer } : {}),
      ...((values["agent-token"] ?? process.env.BT_AGENT_TOKEN) ? { agentToken: (values["agent-token"] ?? process.env.BT_AGENT_TOKEN)! } : {}),
      ...(liveEngine ? { live: liveEngine } : {}),
    });
    console.log(`Review UI: ${url}  (${liveEngine ? `live against ${liveEngine.repo}` : `sandbox, no GitHub calls${usage.enabled ? "; telemetry on" : ""}`}; Ctrl+C to stop)`);
    await usage.send({ event: "serve_started", mode });
    return new Promise<number>(() => {});
  }

  await usage.send({ event: "demo_started", mode });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runDemo>>;
  try {
    result = await runDemo({
      ...(live ? { live } : {}),
      ...(values.unassignable ? { unassignable: values.unassignable } : live ? { unassignable: "octocat" } : {}),
    });
  } catch (err) {
    await usage.send({ event: "demo_failed", mode });
    throw err;
  }
  await usage.send({
    event: "demo_completed",
    mode,
    outcomes: result.outcomes as Record<string, OutcomeValue>,
    duplicate_writes: result.duplicateWrites,
    conflict_writes_before_stop: result.conflictWritesBeforeStop,
    ledger_intact: result.ledgerIntact,
    duration_ms: Date.now() - started,
  });
  if (values["ledger-out"]) {
    writeFileSync(values["ledger-out"], result.engine.ledger.toJSONL() + "\n");
    console.log(`Ledger written to ${values["ledger-out"]}`);
  }
  const ok =
    result.duplicateWrites === 0 &&
    result.conflictWritesBeforeStop === 0 &&
    result.ledgerIntact &&
    result.outcomes.followup_first_commit === "conflicted";
  return ok ? 0 : 1;
}

function tokenFromEnv(): TokenProvider {
  const { BT_GITHUB_APP_ID, BT_GITHUB_APP_PRIVATE_KEY_FILE, BT_GITHUB_INSTALLATION_ID, GITHUB_TOKEN } = process.env;
  if (BT_GITHUB_APP_ID && BT_GITHUB_APP_PRIVATE_KEY_FILE && BT_GITHUB_INSTALLATION_ID) {
    return githubAppTokenProvider({
      appId: BT_GITHUB_APP_ID,
      privateKeyPem: readFileSync(BT_GITHUB_APP_PRIVATE_KEY_FILE, "utf8"),
      installationId: BT_GITHUB_INSTALLATION_ID,
    });
  }
  if (GITHUB_TOKEN) return async () => GITHUB_TOKEN;
  throw new Error("live mode needs GitHub App credentials or GITHUB_TOKEN; see --help");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
