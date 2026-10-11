import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTelemetry, telemetry } from "../src/telemetry/client.ts";
import { createCollector } from "../src/telemetry/collector.ts";
import { buildEvent, validateEvent, type EventProps } from "../src/telemetry/schema.ts";

let collector: Server;
let collectorUrl: string;
let outFile: string;

before(async () => {
  outFile = join(mkdtempSync(join(tmpdir(), "bt-tel-")), "events.jsonl");
  collector = createCollector(outFile);
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const addr = collector.address();
  collectorUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1/events`;
});
after(() => collector.close());

const freshEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ BT_CONFIG_DIR: mkdtempSync(join(tmpdir(), "bt-cfg-")), BT_TELEMETRY_URL: collectorUrl, ...extra });
const events = () => (existsSync(outFile) ? readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const spyFetch = () => {
  const calls: unknown[] = [];
  return { calls, fetch: (async (...args: Parameters<typeof fetch>) => (calls.push(args), new Response(null, { status: 204 }))) as typeof fetch };
};

describe("telemetry client", () => {
  it("is off by default: no config written, no install id, no network", async () => {
    const env = freshEnv();
    const spy = spyFetch();
    const t = telemetry({ env, fetch: spy.fetch, notify: () => {} });
    assert.equal(t.enabled, false);
    await t.send({ event: "demo_started", mode: "sandbox" });
    assert.equal(spy.calls.length, 0);
    assert.equal(existsSync(join(env.BT_CONFIG_DIR!, "telemetry.json")), false);
  });

  it("DO_NOT_TRACK and BT_TELEMETRY=0 beat the flag and the stored choice", () => {
    const env = freshEnv({ DO_NOT_TRACK: "1" });
    setTelemetry(true, env);
    assert.equal(telemetry({ env, flag: true, notify: () => {} }).enabled, false);
    assert.equal(telemetry({ env: { ...env, DO_NOT_TRACK: "", BT_TELEMETRY: "0" }, flag: true, notify: () => {} }).enabled, false);
  });

  it("shows the notice once, keeps one install id, and respects telemetry off", () => {
    const env = freshEnv();
    const notes: string[] = [];
    setTelemetry(true, env);
    telemetry({ env, notify: (m) => notes.push(m) });
    telemetry({ env, notify: (m) => notes.push(m) });
    assert.equal(notes.filter((n) => n.includes("Telemetry is ON")).length, 1);
    const id = JSON.parse(readFileSync(join(env.BT_CONFIG_DIR!, "telemetry.json"), "utf8")).install_id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    setTelemetry(false, env);
    assert.equal(telemetry({ env, notify: () => {} }).enabled, false);
    assert.equal(JSON.parse(readFileSync(join(env.BT_CONFIG_DIR!, "telemetry.json"), "utf8")).install_id, undefined, "turning off forgets the install id");
  });

  it("never throws or hangs when the collector is down", async () => {
    const t = telemetry({ env: freshEnv({ BT_TELEMETRY_URL: "http://127.0.0.1:9/v1/events" }), flag: true, notify: () => {}, timeoutMs: 300 });
    const start = Date.now();
    await t.send({ event: "demo_started", mode: "sandbox" });
    assert.ok(Date.now() - start < 2000);
  });

  it("says so and sends nothing when no collector is configured", async () => {
    const notes: string[] = [];
    const spy = spyFetch();
    const env = freshEnv();
    delete env.BT_TELEMETRY_URL;
    const t = telemetry({ env, flag: true, fetch: spy.fetch, notify: (m) => notes.push(m) });
    await t.send({ event: "demo_started", mode: "sandbox" });
    assert.equal(spy.calls.length, 0);
    assert.ok(notes.some((n) => /no collector is configured/.test(n)));
  });
});

describe("telemetry schema", () => {
  const base = { installId: "6f1c2b9e-3c7d-4a8e-9b1f-2d3e4f5a6b7c", cliVersion: "0.1.0", now: new Date("2026-10-11T15:42:00Z") };

  it("builds only allowlisted fields, drops unknown values, and keeps the date without a time", () => {
    const hostile = {
      event: "demo_completed",
      mode: "live",
      outcomes: { triage: "verification_failed", followup_first_commit: "acme/secret-repo", injected: "x" },
      duplicate_writes: 1e9,
      conflict_writes_before_stop: -4,
      ledger_intact: true,
      duration_ms: 1234.6,
      repo: "acme/secret-repo",
      token: "ghp_secret",
    } as unknown as EventProps;
    const e = buildEvent(base, hostile);
    assert.deepEqual(validateEvent(e), []);
    const text = JSON.stringify(e);
    for (const leak of ["secret", "ghp_", "injected", "15:42"]) assert.ok(!text.includes(leak), `must not contain ${leak}`);
    assert.equal(e.day, "2026-10-11");
    assert.deepEqual((e.props as { outcomes: unknown }).outcomes, { triage: "verification_failed" });
    assert.equal((e.props as { duplicate_writes: number }).duplicate_writes, 1000);
  });

  it("the validator rejects extra fields, free text and out-of-range values", () => {
    const good = buildEvent(base, { event: "demo_started", mode: "sandbox" });
    assert.deepEqual(validateEvent(good), []);
    assert.ok(validateEvent({ ...good, repo: "acme/widgets" }).length);
    assert.ok(validateEvent({ ...good, props: { ...good.props, title: "Crash on save" } }).length);
    assert.ok(validateEvent({ ...good, install_id: "user@example.com" }).length);
    assert.ok(validateEvent({ ...good, day: "2026-10-11T15:42:00Z" }).length);
    assert.ok(validateEvent({ ...good, props: { event: "page_view", mode: "sandbox" } }).length);
  });
});

describe("collector", () => {
  it("stores valid events and rejects everything else", async () => {
    const post = (body: string, type = "application/json") => fetch(collectorUrl, { method: "POST", headers: { "content-type": type }, body });
    const before = events().length;
    const good = buildEvent({ installId: "6f1c2b9e-3c7d-4a8e-9b1f-2d3e4f5a6b7c", cliVersion: "0.1.0" }, { event: "serve_started", mode: "sandbox" });
    assert.equal((await post(JSON.stringify(good))).status, 204);
    assert.equal((await post(JSON.stringify({ ...good, ip: "1.2.3.4" }))).status, 422);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post(JSON.stringify(good), "text/plain")).status, 415);
    assert.equal((await post("x".repeat(10_000))).status, 413);
    assert.equal(events().length, before + 1);
    assert.deepEqual(Object.keys(events().at(-1)).sort(), ["cli_version", "day", "install_id", "node_major", "os", "props", "schema"]);
  });
});

describe("CLI with telemetry", () => {
  it("demo --telemetry sends demo_started and demo_completed with outcomes, nothing else", async () => {
    const env = { ...process.env, ...freshEnv() };
    const before = events().length;
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn("node", ["src/cli.ts", "demo", "--telemetry"], { env, stdio: ["ignore", "ignore", "pipe"] });
      child.on("exit", resolve);
    });
    assert.equal(code, 0);
    const sent = events().slice(before);
    assert.deepEqual(sent.map((e) => e.props.event), ["demo_started", "demo_completed"]);
    assert.equal(sent[1].props.mode, "sandbox");
    assert.equal(sent[1].props.outcomes.triage, "verification_failed");
    assert.equal(sent[1].props.duplicate_writes, 0);
    assert.equal(sent[0].install_id, sent[1].install_id);
  });

  it("demo without the flag sends nothing", async () => {
    const env = { ...process.env, ...freshEnv() };
    const before = events().length;
    await new Promise((resolve) => spawn("node", ["src/cli.ts", "demo"], { env, stdio: "ignore" }).on("exit", resolve));
    assert.equal(events().length, before);
  });
});
