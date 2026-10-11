import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer } from "../src/server/serve.ts";

let base: string;
let close: () => void;

before(async () => {
  const s = await startServer({ port: 0, reviewer: "@api-test" });
  base = s.url;
  close = () => s.server.close();
});
after(() => close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}api${path}`, {
    method,
    headers: method === "GET" ? headers : { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const TX = "triage-release-4-2";

describe("review API", () => {
  it("serves the seeded inbox and transaction detail", async () => {
    const state = await call("GET", "/state");
    assert.equal(state.status, 200);
    assert.equal(state.body.mode.kind, "sandbox");
    assert.equal(state.body.inbox[0].id, TX);
    const detail = await call("GET", `/tx/${TX}`);
    assert.equal(detail.body.transaction.revisions.length, 1);
    assert.equal(detail.body.preview.length, 4);
    assert.match(detail.body.payload_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(detail.body.execution_order.slice(5, 8), ["a6", "a7", "a8"]);
  });

  it("rejects cross-origin and non-JSON POSTs", async () => {
    const cross = await call("POST", "/sandbox/reset", {}, { origin: "http://evil.example" });
    assert.equal(cross.status, 403);
    const res = await fetch(`${base}api/sandbox/reset`, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } });
    assert.equal(res.status, 415);
  });

  it("refuses review mutations made against a stale revision", async () => {
    const res = await call("POST", `/tx/${TX}/decision`, { action_id: "a8", decision: "reject", revision: 99 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "stale_revision");
  });

  it("requires the reviewed revision to approve", async () => {
    const res = await call("POST", `/tx/${TX}/approve`, {});
    assert.equal(res.status, 400);
  });

  it("maps a GitHub outage to connector_unavailable and writes nothing", async () => {
    await call("POST", "/sandbox/outage");
    const { body } = await call("POST", `/tx/${TX}/approve`, { revision: 1 });
    const commit = await call("POST", `/tx/${TX}/commit`, { approval_id: body.approval.id });
    assert.equal(commit.status, 503);
    assert.equal(commit.body.error.code, "connector_unavailable");
    await call("POST", "/sandbox/outage");
    assert.equal((await call("GET", `/tx/${TX}`)).body.transaction.status, "approved");
  });

  it("drives drift → conflict → rebase → verified through the API", async () => {
    await call("POST", "/sandbox/reset");
    await call("POST", "/sandbox/follow-up");
    const id = "triage-release-4-2-followup";
    await call("POST", "/sandbox/drift", { transaction_id: id });
    const { body } = await call("POST", `/tx/${id}/approve`, { revision: 1 });
    const blocked = await call("POST", `/tx/${id}/commit`, { approval_id: body.approval.id });
    assert.equal(blocked.body.result.outcome, "conflicted");
    assert.equal(blocked.body.detail.conflicts[0].field, "labels");
    await call("POST", `/tx/${id}/rebase`);
    const again = await call("POST", `/tx/${id}/approve`, { revision: 2 });
    const done = await call("POST", `/tx/${id}/commit`, { approval_id: again.body.approval.id });
    assert.equal(done.body.result.receipt.outcome, "verified");
    assert.equal(done.body.result.receipt.approval.reviewer, "@api-test");
  });

  it("does not serve files outside web/", async () => {
    const res = await fetch(`${base}..%2Fpackage.json`);
    assert.equal(res.status, 404);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  });
});
