import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { hashOf } from "../canonical.ts";
import type { Engine } from "../engine.ts";
import { EngineError } from "../errors.ts";
import { GitHubHttpError } from "../github/transport.ts";
import { Ledger } from "../ledger.ts";
import { outcomeOf, type AgentStatus, type SubmitResponse } from "../sdk/protocol.ts";
import type { Conflict, Transaction } from "../types.ts";
import type { Sandbox, SandboxControl } from "./sandbox.ts";

export interface ApiOptions {
  /** Returns the current engine (the sandbox replaces its engine on reset). */
  engine: () => Engine;
  sandbox?: Sandbox;
  reviewer: string;
  mode: { kind: "sandbox" } | { kind: "live"; repo: string };
  webRoot: string;
  /** When set, the agent endpoints (/api/change-sets) require `Authorization: Bearer <token>`. */
  agentToken?: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];
  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MAX_BODY = 256 * 1024;
const CONTROLS: readonly SandboxControl[] = ["drift", "client-retry", "outage", "fast-forward", "follow-up", "reset"];
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/**
 * JSON API over the engine plus static files for the review UI. Binds to
 * loopback by default; POSTs must be JSON from the same origin, so another
 * site open in the reviewer's browser cannot drive commits.
 */
export function createHandler(options: ApiOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") assertSameOriginJson(req);
        if (/^\/api\/(change-sets|targets)(\/|$)/.test(url.pathname) && options.agentToken) assertAgentToken(req, options.agentToken);
        const body = req.method === "POST" ? await readJson(req) : {};
        const result = await route(options, req.method ?? "GET", url.pathname, body);
        return send(res, 200, result);
      }
      return await serveStatic(options.webRoot, url.pathname, res);
    } catch (err) {
      const e = toHttpError(err);
      return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    }
  };
}

async function route(o: ApiOptions, method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const engine = o.engine();
  const parts = path.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  const [first, id, verb] = parts;

  if (method === "GET" && first === "state" && parts.length === 1) {
    return {
      reviewer: o.reviewer,
      mode: o.mode,
      sandbox: o.sandbox ? { outage: o.sandbox.outage, clock_offset_minutes: o.sandbox.clockOffsetMinutes } : null,
      inbox: engine.list().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)),
    };
  }

  // Current state of one target, for adapters (e.g. the Claude Code hook) that must turn
  // "set labels to X" into explicit add/remove actions before proposing them.
  if (method === "GET" && first === "targets" && parts.length === 6 && parts[1] === "github" && parts[4] === "issues") {
    const [, , owner, repo, , num] = parts;
    const number = Number(num);
    if (!/^[A-Za-z0-9-]+$/.test(owner!) || !/^[A-Za-z0-9._-]+$/.test(repo!) || !Number.isInteger(number) || number < 1) {
      throw new HttpError(400, "bad_request", "invalid issue reference");
    }
    return engine.readTarget("github", { kind: "github.issue", owner: owner!, repo: repo!, number });
  }

  // Agent endpoints, called through the SDK: submit a change set, then poll its status.
  if (first === "change-sets") {
    if (method === "POST" && parts.length === 1) {
      const { transaction, deduplicated } = await engine.submit(body);
      const res: SubmitResponse = { transaction_id: transaction.id, status: transaction.status, deduplicated };
      return res;
    }
    if (method === "GET" && id && parts.length === 2) return agentStatus(engine, id);
    throw new HttpError(404, "not_found", "no such endpoint");
  }

  if (first === "sandbox" && method === "POST" && parts.length === 2) {
    if (!o.sandbox) throw new HttpError(404, "not_found", "simulation controls exist only in sandbox mode");
    if (!CONTROLS.includes(id as SandboxControl)) throw new HttpError(404, "not_found", `unknown control ${id}`);
    return o.sandbox.control(id as SandboxControl, typeof body.transaction_id === "string" ? body.transaction_id : undefined);
  }

  if (first !== "tx" || !id) throw new HttpError(404, "not_found", "no such endpoint");

  if (method === "GET" && !verb) return detail(engine, id);
  if (method !== "POST" || !verb) throw new HttpError(404, "not_found", "no such endpoint");

  switch (verb) {
    case "edit":
      assertRevision(engine, id, body.revision);
      await engine.editAction(id, str(body.action_id, "action_id"), obj(body.params, "params"), o.reviewer);
      return detail(engine, id);
    case "decision": {
      assertRevision(engine, id, body.revision);
      const actionId = str(body.action_id, "action_id");
      if (body.decision === "reject") await engine.rejectAction(id, actionId, o.reviewer, typeof body.reason === "string" ? body.reason : "");
      else if (body.decision === "include") await engine.restoreAction(id, actionId, o.reviewer);
      else throw new HttpError(400, "bad_request", 'decision must be "reject" or "include"');
      return detail(engine, id);
    }
    case "reject":
      engine.rejectTransaction(id, o.reviewer, typeof body.reason === "string" ? body.reason : "");
      return detail(engine, id);
    case "rebase":
      await engine.rebase(id, o.reviewer);
      return detail(engine, id);
    case "approve": {
      if (typeof body.revision !== "number") throw new HttpError(400, "bad_request", "revision is required: approve what you reviewed");
      const approval = engine.approve(id, o.reviewer, { revision: body.revision });
      return { approval };
    }
    case "commit": {
      const result = await engine.commit(id, str(body.approval_id, "approval_id"), o.reviewer);
      return { result, detail: detail(engine, id) };
    }
    case "compensate": {
      const ids = body.action_ids;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "bad_request", "action_ids must be an array of strings");
      const { transaction, skipped } = await engine.proposeCompensation(id, ids as string[], o.reviewer);
      return { transaction_id: transaction.id, skipped };
    }
    default:
      throw new HttpError(404, "not_found", "no such endpoint");
  }
}

/** What an agent may know about its transaction: outcome, reviewer decisions and the receipt. */
export function agentStatus(engine: Engine, id: string): AgentStatus {
  const tx = engine.get(id);
  const rev = tx.revisions.at(-1)!;
  const events = engine.ledger.list(id);
  const rejection = [...events].reverse().find((e) => e.type === "transaction_rejected");
  const outcome = outcomeOf(tx.status);
  return {
    transaction_id: tx.id,
    kind: tx.kind,
    status: tx.status,
    outcome,
    ok: outcome === "verified",
    revision: rev.number,
    rejection_reason: rejection && typeof rejection.data.reason === "string" && rejection.data.reason ? rejection.data.reason : null,
    conflicts: tx.status === "conflicted" ? lastConflicts(events) : [],
    receipt: tx.receipt ?? null,
    rejected_action_ids: tx.receipt?.rejected_action_ids ?? rev.actions.filter((a) => rev.decisions[a.id] === "reject").map((a) => a.id),
  };
}

/** Everything the review screen needs about one transaction, in one response. */
export function detail(engine: Engine, id: string) {
  const tx = engine.get(id);
  const events = engine.ledger.list(id);
  let payloadHash: string | null = null;
  try {
    payloadHash = tx.revisions.at(-1)!.actions.some((a) => tx.revisions.at(-1)!.decisions[a.id] !== "reject") ? hashOf(engine.approvedPayload(tx)) : null;
  } catch {
    payloadHash = null;
  }
  const related = (txId: string) => {
    try {
      const t = engine.get(txId);
      return { id: t.id, status: t.status, kind: t.kind };
    } catch {
      return null;
    }
  };
  return {
    transaction: tx,
    risk: engine.transactionRisk(tx),
    preview: engine.preview(id),
    payload_hash: payloadHash,
    active_approval: tx.approvals.find((a) => a.status === "active") ?? null,
    execution_order: executionOrder(engine, tx),
    conflicts: tx.status === "conflicted" ? lastConflicts(events) : [],
    parent: tx.compensates ? related(tx.compensates.transaction_id) : null,
    children: tx.compensated_by.map(related).filter(Boolean),
    events,
    ledger_intact: Ledger.verify(engine.ledger.list()) === null,
  };
}

function executionOrder(engine: Engine, tx: Transaction): string[] {
  try {
    return engine.approvedPayload(tx).actions.map((a) => a.id);
  } catch {
    return [];
  }
}

function lastConflicts(events: ReturnType<Engine["ledger"]["list"]>): Conflict[] {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === "status_changed" && e.data.to === "queued") start = i;
  });
  return events.slice(start).filter((e) => e.type === "precondition_conflicted").map((e) => e.data as unknown as Conflict);
}

function assertRevision(engine: Engine, id: string, revision: unknown): void {
  if (revision === undefined) return;
  const current = engine.get(id).revisions.at(-1)!.number;
  if (revision !== current) throw new EngineError("stale_revision", `you were looking at revision ${String(revision)}; the current revision is ${current}`);
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof EngineError) {
    const status: Record<string, number> = {
      not_found: 404,
      invalid_change_set: 400,
      unknown_connector: 400,
      unknown_operation: 400,
      contradictory_actions: 400,
      transaction_conflict: 409,
      invalid_state: 409,
      stale_revision: 409,
      commit_in_progress: 409,
      approval_invalid: 409,
      approval_expired: 409,
      transaction_expired: 409,
      nothing_to_approve: 422,
      blocked_by_policy: 422,
      not_compensatable: 422,
    };
    return new HttpError(status[err.code] ?? 400, err.code, err.message, err.details);
  }
  if (err instanceof GitHubHttpError) {
    if (err.status === 401 || err.status === 403) return new HttpError(502, "permission_error", err.message);
    return new HttpError(502, "connector_error", err.message);
  }
  if (err instanceof TypeError && /fetch failed/.test(err.message)) {
    return new HttpError(503, "connector_unavailable", "GitHub could not be reached");
  }
  if (err instanceof SyntaxError) return new HttpError(400, "bad_request", "request body is not valid JSON");
  console.error(err);
  return new HttpError(500, "internal", "unexpected server error");
}

function assertAgentToken(req: IncomingMessage, expected: string): void {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new HttpError(401, "unauthorized", "agent endpoints need a valid bearer token");
  }
}

function assertSameOriginJson(req: IncomingMessage): void {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "POST bodies must be application/json");
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "forbidden", "cross-origin requests are not allowed");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "bad_request", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = normalize(join(root, rel));
  if (!file.startsWith(normalize(root + sep))) throw new HttpError(404, "not_found", "not found");
  const type = MIME[extname(file)];
  if (!type) throw new HttpError(404, "not_found", "not found");
  const content = await readFile(file).catch(() => {
    throw new HttpError(404, "not_found", "not found");
  });
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(content);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new HttpError(400, "bad_request", `${name} is required`);
  return v;
}

function obj(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "bad_request", `${name} must be an object`);
  return v as Record<string, unknown>;
}

export type TransactionDetail = ReturnType<typeof detail> & { transaction: Transaction };
