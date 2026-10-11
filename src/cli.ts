#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runDemo, type DemoOptions } from "./demo/run.ts";
import { githubAppTokenProvider } from "./github/app-auth.ts";
import { RestGitHub, type TokenProvider } from "./github/rest.ts";

const HELP = `Usage: bt-demo demo [options]

Runs the Phase 0 demo: grouped review, exactly-once commit under retry,
post-write verification, reviewable compensation and the stale-state gate.

Without --repo it runs against an in-memory GitHub simulation and makes no
network calls. With --repo it creates four issues in that repository and
writes to them, so use a disposable repository.

Options:
  --repo owner/name       Disposable repository to run against (live mode)
  --yes                   Confirm live writes to --repo
  --assignee login        A user who can be assigned in --repo (default: repo owner)
  --unassignable login    A user who cannot be assigned there (default: octocat in live mode)
  --ledger-out file       Write the ledger as JSON lines when done
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? "demo";
  if (values.help || command !== "demo") {
    console.log(HELP);
    return values.help ? 0 : 1;
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

  const result = await runDemo({
    ...(live ? { live } : {}),
    ...(values.unassignable ? { unassignable: values.unassignable } : live ? { unassignable: "octocat" } : {}),
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
