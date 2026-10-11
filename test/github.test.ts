import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalize, hashOf } from "../src/canonical.ts";
import { runDemo } from "../src/demo/run.ts";
import { Engine } from "../src/engine.ts";
import { appJwt, githubAppTokenProvider } from "../src/github/app-auth.ts";
import { GitHubIssuesConnector } from "../src/github/connector.ts";
import { RestGitHub } from "../src/github/rest.ts";
import { GitHubHttpError } from "../src/github/transport.ts";
import { changeSet, issue } from "./helpers.ts";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake GitHub REST server backed by one issue, recording every request. */
function fakeGitHub() {
  const calls: Call[] = [];
  const state = { title: "crash on save", labels: [{ name: "needs-triage" }], assignees: [] as Array<{ login: string }>, comments: [] as string[] };
  let seq = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body });
    const headers = new Headers({ "x-github-request-id": `REQ-${++seq}` });
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      return new Response(JSON.stringify(payload), { status, headers });
    };
    const path = new URL(url).pathname;
    if (path === "/repos/acme/widgets/issues/1" && method === "GET") {
      return json(200, { number: 1, title: state.title, state: "open", state_reason: null, labels: state.labels, assignees: state.assignees });
    }
    if (path === "/repos/acme/widgets/issues/1" && method === "PATCH") {
      state.title = body.title ?? state.title;
      return json(200, {});
    }
    if (path === "/repos/acme/widgets/issues/1/comments" && method === "GET") {
      const page = new URL(url).searchParams.get("page");
      if (!page) return json(200, [{ body: "first page" }], { link: '<https://api.github.com/repos/acme/widgets/issues/1/comments?per_page=100&page=2>; rel="next"' });
      return json(200, state.comments.map((b) => ({ body: b })));
    }
    if (path === "/repos/acme/widgets/issues/1/comments" && method === "POST") {
      state.comments.push(body.body);
      return json(201, {});
    }
    if (path === "/repos/acme/widgets/issues/1/labels" && method === "POST") return json(403, { message: "Resource not accessible by integration" });
    return json(404, { message: "Not Found" });
  }) as typeof fetch;
  return { calls, state, fetchImpl };
}

describe("REST transport", () => {
  it("sends versioned, authenticated requests, follows pagination and records request ids", async () => {
    const fake = fakeGitHub();
    const rest = new RestGitHub({ token: async () => "ghs_secret_token", fetch: fake.fetchImpl });
    const connector = new GitHubIssuesConnector(rest);
    const snap = await connector.read(issue(1));
    assert.equal(snap.title, "crash on save");
    assert.deepEqual(snap.labels, ["needs-triage"]);
    assert.ok(fake.calls.some((c) => c.url.includes("page=2")), "followed the Link header");
    const first = fake.calls[0]!;
    assert.equal(first.headers.authorization, "Bearer ghs_secret_token");
    assert.equal(first.headers["x-github-api-version"], "2022-11-28");
    const res = await rest.updateIssue("acme", "widgets", 1, { title: "x" });
    assert.match(res.requestId, /^REQ-\d+$/);
  });

  it("maps API errors to GitHubHttpError with the request id", async () => {
    const fake = fakeGitHub();
    const rest = new RestGitHub({ token: async () => "t", fetch: fake.fetchImpl });
    await assert.rejects(rest.addLabels("acme", "widgets", 1, ["bug"]), (e: unknown) => e instanceof GitHubHttpError && e.status === 403 && /^REQ-/.test(e.requestId ?? ""));
  });

  it("runs a full commit against the REST API without the token ever reaching the ledger", async () => {
    const fake = fakeGitHub();
    const rest = new RestGitHub({ token: async () => "ghs_secret_token", fetch: fake.fetchImpl });
    const engine = new Engine({ connectors: [new GitHubIssuesConnector(rest)] });
    await engine.submit(
      changeSet([
        { id: "t", operation: "issue.update_title", target: issue(1), params: { title: "Crash on save" } },
        { id: "c", operation: "issue.add_comment", target: issue(1), params: { body: "Triaged." } },
      ]),
    );
    const approval = engine.approve("tx-1", "@rev");
    const result = await engine.commit("tx-1", approval.id);
    assert.ok(result.outcome === "committed" && result.receipt.outcome === "verified");
    assert.match(fake.state.comments[0]!, /<!-- bt-idem:[0-9a-f]{32} -->$/);
    assert.ok(result.receipt.actions.every((a) => a.attempted.request_ids.every((id) => id.startsWith("REQ-"))));
    assert.ok(!engine.ledger.toJSONL().includes("ghs_secret_token"));
  });
});

describe("GitHub App auth", () => {
  it("signs an RS256 JWT and mints a least-privilege installation token, cached until near expiry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const at = new Date("2026-10-11T12:00:00Z");
    const jwt = appJwt("12345", pem, at);
    const [h, p, s] = jwt.split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url")));
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    assert.equal(payload.iss, "12345");
    assert.ok(payload.exp - payload.iat <= 600);

    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ token: `ghs_${requests.length}`, expires_at: "2026-10-11T13:00:00Z" }), { status: 201 });
    }) as typeof fetch;
    const provider = githubAppTokenProvider({ appId: "12345", privateKeyPem: pem, installationId: "99", fetch: fetchImpl, now: () => at });
    assert.equal(await provider(), "ghs_1");
    assert.equal(await provider(), "ghs_1");
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /\/app\/installations\/99\/access_tokens$/);
    assert.deepEqual(requests[0]!.body, { permissions: { issues: "write", metadata: "read" } });
  });
});

describe("canonical hashing", () => {
  it("is independent of key order and rejects lossy values", () => {
    assert.equal(hashOf({ b: 1, a: [1, { d: 2, c: 3 }] }), hashOf({ a: [1, { c: 3, d: 2 }], b: 1 }));
    assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
    assert.throws(() => canonicalize({ a: Number.NaN }));
    assert.throws(() => canonicalize([undefined]));
  });
});

describe("demo", () => {
  it("runs all six beats offline with the expected outcomes", async () => {
    const lines: string[] = [];
    const result = await runDemo({ log: (l) => lines.push(l) });
    assert.equal(result.duplicateWrites, 0);
    assert.equal(result.conflictWritesBeforeStop, 0);
    assert.ok(result.ledgerIntact);
    assert.deepEqual(result.outcomes, {
      triage: "verification_failed",
      compensation: "verified",
      triage_after_compensation: "compensated",
      followup_first_commit: "conflicted",
      followup_after_rebase: "verified",
    });
    assert.ok(lines.join("\n").includes("VERIFICATION FAILED"));
  });
});
