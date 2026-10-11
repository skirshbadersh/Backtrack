import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { handlePreToolUse, type HookOutput } from "../src/adapters/claude-code/hook.ts";
import { ReviewClient } from "../src/sdk/client.ts";
import type { Sandbox } from "../src/server/sandbox.ts";
import { startServer } from "../src/server/serve.ts";

let base: string;
let sandbox: Sandbox;
let close: () => void;
let client: ReviewClient;

before(async () => {
  const s = await startServer({ port: 0, reviewer: "@hook-reviewer" });
  base = s.url;
  sandbox = s.sandbox!;
  close = () => s.server.close();
  client = new ReviewClient({ baseUrl: base, pollIntervalMs: 20 });
});
after(() => close());

const deps = (waitMs = 5000) => ({ client, waitMs, workspaceId: "ws-claude-code", initiator: "@dev", serverUrl: base, pollIntervalMs: 20 });
let session = 0;
const call = (tool_name: string, tool_input: Record<string, unknown>, session_id = `session-${++session}`) => ({ hook_event_name: "PreToolUse", session_id, tool_name, tool_input, tool_use_id: "toolu_x" });
const reason = (o: HookOutput | null) => {
  assert.ok(o, "expected a decision");
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny", "the original tool call must never run");
  return o.hookSpecificOutput.permissionDecisionReason;
};

/** Plays the reviewer: waits for the transaction to appear, then commits (or rejects) it. */
async function reviewWhenSubmitted(match: (outcome: string) => boolean, act: "commit" | "reject" = "commit") {
  for (let i = 0; i < 200; i++) {
    const state = (await (await fetch(`${base}api/state`)).json()) as { inbox: Array<{ id: string; status: string; requested_outcome: string }> };
    const row = state.inbox.find((r) => r.id.startsWith("cc-") && r.status === "pending_review" && match(r.requested_outcome));
    if (row) {
      const post = (p: string, b: unknown) => fetch(`${base}api/tx/${row.id}/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<Record<string, any>>);
      if (act === "reject") return post("reject", { reason: "not this one" });
      const detail = (await (await fetch(`${base}api/tx/${row.id}`)).json()) as Record<string, any>;
      const { approval } = await post("approve", { revision: detail.transaction.revisions.length });
      return post("commit", { approval_id: approval.id });
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("transaction never appeared");
}

describe("Claude Code hook", () => {
  it("ignores tools it does not handle", async () => {
    assert.equal(await handlePreToolUse(call("Bash", { command: "ls" }), deps()), null);
  });

  it("routes a comment through review, reports VERIFIED, and the comment lands exactly once", async () => {
    const input = call("mcp__github__add_issue_comment", { owner: "acme", repo: "widgets", issue_number: 191, body: "Docs fix is in review." });
    const [out] = await Promise.all([handlePreToolUse(input, deps()), reviewWhenSubmitted((o) => o.includes("comment"))]);
    const text = reason(out);
    assert.match(text, /OUTCOME: VERIFIED/);
    assert.match(text, /do not call the tool again/);
    assert.equal(sandbox.gh.comments("acme", "widgets", 191).length, 1);

    const writes = sandbox.gh.writes.length;
    const retried = reason(await handlePreToolUse(input, deps()));
    assert.match(retried, /already proposed/);
    assert.match(retried, /VERIFIED/);
    assert.equal(sandbox.gh.writes.length, writes, "a retried identical call writes nothing");
  });

  it("turns label and assignee replacement into explicit adds and removes", async () => {
    // #184 starts with ["needs-triage"] and no assignees.
    const input = call("mcp__github__issue_write", { method: "update", owner: "acme", repo: "widgets", issue_number: 184, labels: ["bug", "p2"], assignees: ["maintainer"], title: "Crash on save" });
    const [out] = await Promise.all([handlePreToolUse(input, deps()), reviewWhenSubmitted((o) => o.includes("relabel"))]);
    assert.match(reason(out), /VERIFIED/);
    const issue = await sandbox.gh.getIssue("acme", "widgets", 184);
    assert.deepEqual(issue.labels, ["bug", "p2"]);
    assert.deepEqual(issue.assignees, ["maintainer"]);
    assert.equal(issue.title, "Crash on save");
  });

  it("reports a rejection with the reviewer's reason and writes nothing", async () => {
    const writes = sandbox.gh.writes.length;
    const input = call("mcp__github__issue_write", { method: "update", owner: "acme", repo: "widgets", issue_number: 207, state: "closed", state_reason: "not_planned" });
    const [out] = await Promise.all([handlePreToolUse(input, deps()), reviewWhenSubmitted((o) => o.includes("close"), "reject")]);
    assert.match(reason(out), /REJECTED by the reviewer: "not this one"/);
    assert.equal(sandbox.gh.writes.length, writes);
    assert.equal((await sandbox.gh.getIssue("acme", "widgets", 207)).state, "open");
  });

  it("stops waiting before the hook timeout and says nothing was written yet", async () => {
    const out = await handlePreToolUse(call("mcp__github__add_issue_comment", { owner: "acme", repo: "widgets", issue_number: 195, body: "later" }), deps(100));
    assert.match(reason(out), /STILL AWAITING REVIEW/);
  });

  it("blocks unsupported calls without proposing anything", async () => {
    const before = ((await (await fetch(`${base}api/state`)).json()) as { inbox: unknown[] }).inbox.length;
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ method: "create", owner: "acme", repo: "widgets", title: "New" }, "mcp__github__issue_write", /creating issues/],
      [{ method: "update", owner: "acme", repo: "widgets", issue_number: 184, title: "x", body: "new body" }, "mcp__github__issue_write", /field\(s\) body/],
      [{ method: "update", owner: "acme", repo: "widgets", issue_number: 184, state: "closed", state_reason: "duplicate" }, "mcp__github__issue_write", /duplicate/],
      [{ owner: "acme", repo: "widgets", issue_number: 184, reaction: "+1" }, "mcp__github__add_issue_comment", /reactions/],
      [{ owner: "acme", repo: "widgets", body: "no number" }, "mcp__github__add_issue_comment", /issue_number/],
    ];
    for (const [input, tool, why] of cases) {
      const text = reason(await handlePreToolUse(call(tool, input), deps()));
      assert.match(text, why);
      assert.match(text, /Nothing was written/);
    }
    const after = ((await (await fetch(`${base}api/state`)).json()) as { inbox: unknown[] }).inbox.length;
    assert.equal(after, before);
  });

  it("reports a no-op instead of proposing an empty change", async () => {
    const text = reason(await handlePreToolUse(call("mcp__github__issue_write", { method: "update", owner: "acme", repo: "widgets", issue_number: 195, labels: [] }), deps()));
    assert.match(text, /already in the requested state/);
  });

  it("fails closed when the review server is unreachable", async () => {
    const dead = { ...deps(), client: new ReviewClient({ baseUrl: "http://127.0.0.1:9", requestTimeoutMs: 2000 }), serverUrl: "http://127.0.0.1:9" };
    const text = reason(await handlePreToolUse(call("mcp__github__add_issue_comment", { owner: "acme", repo: "widgets", issue_number: 184, body: "hi" }), dead));
    assert.match(text, /unreachable.*fail closed.*Nothing was written/s);
  });

  it("the CLI command speaks the hook protocol on stdin/stdout and always exits 0", async () => {
    const run = (stdin: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn("node", ["src/cli.ts", "hook", "claude-code"], { env: { ...process.env, BT_SERVER: base } });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("exit", (code) => resolve({ code, out }));
        child.stdin.end(stdin);
      });
    const blocked = await run(JSON.stringify(call("mcp__github__issue_write", { method: "create", owner: "acme", repo: "widgets", title: "x" })));
    assert.equal(blocked.code, 0);
    assert.match(JSON.parse(blocked.out).hookSpecificOutput.permissionDecisionReason, /creating issues/);
    const ignored = await run(JSON.stringify(call("Read", { file_path: "/etc/hosts" })));
    assert.deepEqual([ignored.code, ignored.out], [0, ""]);
    const garbage = await run("not json");
    assert.equal(JSON.parse(garbage.out).hookSpecificOutput.permissionDecision, "deny");
  });
});
