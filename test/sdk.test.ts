import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { EXIT, statusCommand, submitCommand } from "../src/sdk/cli-commands.ts";
import { ReviewClient, SdkError } from "../src/sdk/index.ts";
import { startServer } from "../src/server/serve.ts";
import { SCHEMA_VERSION, type ChangeSetInput } from "../src/types.ts";

const TOKEN = "test-agent-token";
let base: string;
let close: () => void;
let client: ReviewClient;

before(async () => {
  const s = await startServer({ port: 0, agentToken: TOKEN, reviewer: "@sdk-reviewer" });
  base = s.url;
  close = () => s.server.close();
  client = new ReviewClient({ baseUrl: base, token: TOKEN, pollIntervalMs: 20 });
});
after(() => close());

let seq = 0;
function changeSet(actions: ChangeSetInput["actions"], id = `sdk-${++seq}`): ChangeSetInput {
  return { schema_version: SCHEMA_VERSION, transaction_id: id, workspace_id: "ws-demo", source_agent: "sdk-test-agent", initiator: "@maintainer", requested_outcome: `SDK test ${id}`, connector: "github", actions };
}
const label = (n: number, l: string) => ({ id: "a", operation: "issue.add_labels", target: { kind: "github.issue" as const, owner: "acme", repo: "widgets", number: n }, params: { labels: [l] } });

/** Reviewer actions through the UI API, as a person in the browser would. */
async function reviewer(path: string, body: unknown = {}) {
  const res = await fetch(`${base}api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}
async function approveAndCommit(id: string) {
  const detail = await fetch(`${base}api/tx/${id}`).then((r) => r.json() as Promise<Record<string, any>>);
  const { approval } = await reviewer(`/tx/${id}/approve`, { revision: detail.transaction.revisions.at(-1).number });
  return reviewer(`/tx/${id}/commit`, { approval_id: approval.id });
}

describe("ReviewClient", () => {
  it("validates locally before sending anything", async () => {
    let calls = 0;
    const counting = new ReviewClient({ baseUrl: base, token: TOKEN, fetch: (async (...args: Parameters<typeof fetch>) => (calls++, fetch(...args))) as typeof fetch });
    await assert.rejects(counting.submit({ ...changeSet([label(195, "x")]), schema_version: "1999-01-01" }), (e: unknown) => e instanceof SdkError && e.code === "invalid_change_set");
    assert.equal(calls, 0);
  });

  it("requires the bearer token on agent endpoints", async () => {
    const anon = new ReviewClient({ baseUrl: base });
    await assert.rejects(anon.submit(changeSet([label(195, "x")])), (e: unknown) => e instanceof SdkError && e.code === "unauthorized" && e.status === 401);
    const wrong = new ReviewClient({ baseUrl: base, token: "nope" });
    await assert.rejects(wrong.status("triage-release-4-2"), (e: unknown) => e instanceof SdkError && e.code === "unauthorized");
  });

  it("submits, deduplicates a resubmission, and reports waiting until a reviewer acts", async () => {
    const cs = changeSet([label(195, "perf")]);
    const first = await client.submit(cs);
    const again = await client.submit(cs);
    assert.deepEqual([first.deduplicated, again.deduplicated], [false, true]);
    const status = await client.status(cs.transaction_id);
    assert.deepEqual([status.outcome, status.ok, status.status], ["waiting", false, "pending_review"]);
  });

  it("waits for the reviewer to commit and returns a verified decision with the receipt", async () => {
    const cs = changeSet([label(191, "docs")]);
    const seen: string[] = [];
    const waiting = client.submitAndWait(cs, { onStatus: (s) => seen.push(s.status) });
    await new Promise((r) => setTimeout(r, 60));
    await approveAndCommit(cs.transaction_id);
    const decision = await waiting;
    assert.equal(decision.outcome, "verified");
    assert.equal(decision.ok, true);
    assert.equal(decision.status.receipt?.approval.reviewer, "@sdk-reviewer");
    assert.equal(seen[0], "pending_review");
    assert.equal(seen.at(-1), "verified");
  });

  it("reports reviewer edits and rejected actions in the receipt", async () => {
    const cs = changeSet([
      { id: "t", operation: "issue.update_title", target: { kind: "github.issue", owner: "acme", repo: "widgets", number: 195 }, params: { title: "Slow" } },
      { id: "l", operation: "issue.add_labels", target: { kind: "github.issue", owner: "acme", repo: "widgets", number: 195 }, params: { labels: ["wontfix"] } },
    ]);
    await client.submit(cs);
    await reviewer(`/tx/${cs.transaction_id}/edit`, { action_id: "t", params: { title: "Cold start is slow" } });
    await reviewer(`/tx/${cs.transaction_id}/decision`, { action_id: "l", decision: "reject" });
    await approveAndCommit(cs.transaction_id);
    const decision = await client.waitForDecision(cs.transaction_id);
    assert.equal(decision.ok, true);
    const t = decision.status.receipt!.actions.find((a) => a.id === "t")!;
    assert.deepEqual([t.proposed, t.approved], [{ title: "Slow" }, { title: "Cold start is slow" }]);
    assert.deepEqual(decision.status.rejected_action_ids, ["l"]);
  });

  it("a rejected change set returns rejected with the reviewer's reason", async () => {
    const cs = changeSet([label(195, "maybe")]);
    await client.submit(cs);
    await reviewer(`/tx/${cs.transaction_id}/reject`, { reason: "not now" });
    const d = await client.waitForDecision(cs.transaction_id);
    assert.deepEqual([d.outcome, d.ok, d.status.rejection_reason], ["rejected", false, "not now"]);
  });

  it("a write GitHub silently dropped comes back not_verified, ok=false", async () => {
    const cs = changeSet([{ id: "a", operation: "issue.add_assignees", target: { kind: "github.issue", owner: "acme", repo: "widgets", number: 195 }, params: { assignees: ["alex"] } }]);
    await client.submit(cs);
    await approveAndCommit(cs.transaction_id);
    const d = await client.waitForDecision(cs.transaction_id);
    assert.deepEqual([d.outcome, d.ok], ["not_verified", false]);
  });

  it("times out with ok=false while the reviewer has not acted", async () => {
    const cs = changeSet([label(195, "later")]);
    await client.submit(cs);
    const d = await client.waitForDecision(cs.transaction_id, { timeoutMs: 80 });
    assert.deepEqual([d.outcome, d.ok, d.status.status], ["timeout", false, "pending_review"]);
  });

  it("can be aborted", async () => {
    const cs = changeSet([label(195, "abort")]);
    await client.submit(cs);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(client.waitForDecision(cs.transaction_id, { signal: ctrl.signal }), (e: unknown) => e instanceof SdkError && e.code === "aborted");
  });

  it("fails closed when the server is unreachable", async () => {
    const dead = new ReviewClient({ baseUrl: "http://127.0.0.1:9", requestTimeoutMs: 2000 });
    await assert.rejects(dead.submit(changeSet([label(195, "x")])), (e: unknown) => e instanceof SdkError && e.code === "unreachable" && /nothing was written/.test(e.message));
  });

  it("returns not_found for unknown transactions", async () => {
    await assert.rejects(client.status("does-not-exist"), (e: unknown) => e instanceof SdkError && e.code === "not_found" && e.status === 404);
  });
});

describe("submit/status CLI", () => {
  it("submits a file and exits 0, then status exits 5 while waiting and 0 once verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-sdk-"));
    const cs = changeSet([label(184, "cli")]);
    const file = join(dir, "cs.json");
    writeFileSync(file, JSON.stringify(cs));
    const lines: string[] = [];
    const opts = { server: base, token: TOKEN, wait: false, json: true, log: (l: string) => lines.push(l) };
    assert.equal(await submitCommand(file, opts), EXIT.submitted);
    assert.equal(JSON.parse(lines[0]!).submitted.transaction_id, cs.transaction_id);
    assert.equal(await statusCommand(cs.transaction_id, opts), EXIT.waiting);
    await approveAndCommit(cs.transaction_id);
    assert.equal(await statusCommand(cs.transaction_id, opts), EXIT.verified);
  });

  it("submit --wait exits 4 on timeout and 3 when rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-sdk-"));
    const quiet = { server: base, token: TOKEN, json: true, log: () => {} };
    const a = changeSet([label(184, "timeout")]);
    writeFileSync(join(dir, "a.json"), JSON.stringify(a));
    assert.equal(await submitCommand(join(dir, "a.json"), { ...quiet, wait: true, timeoutSec: 0.1 }), EXIT.timeout);
    const b = changeSet([label(184, "rejectme")]);
    writeFileSync(join(dir, "b.json"), JSON.stringify(b));
    const pending = submitCommand(join(dir, "b.json"), { ...quiet, wait: true, timeoutSec: 10 });
    await new Promise((r) => setTimeout(r, 100));
    await reviewer(`/tx/${b.transaction_id}/reject`, { reason: "no" });
    assert.equal(await pending, EXIT.notOk);
  });
});

describe("server guard", () => {
  it("refuses to listen beyond loopback without an agent token", async () => {
    await assert.rejects(startServer({ port: 0, host: "0.0.0.0" }), /agent token/);
  });
});
