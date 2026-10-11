import { EngineError } from "./errors.ts";
import { SCHEMA_VERSION, type ChangeSetInput } from "./types.ts";

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "transaction_id",
  "workspace_id",
  "source_agent",
  "initiator",
  "requested_outcome",
  "connector",
  "actions",
  "dependencies",
  "evidence",
  "expires_at",
]);
const ACTION_KEYS = new Set(["id", "operation", "target", "params", "rationale"]);
const TARGET_KEYS = new Set(["kind", "owner", "repo", "number"]);
const DEPENDENCY_KEYS = new Set(["before", "after"]);
const EVIDENCE_KEYS = new Set(["label", "content", "source"]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ACTIONS = 100;

/**
 * Structural validation of an agent-submitted change set. Fails closed: unknown
 * schema versions and unknown keys anywhere are errors, not warnings. Operation
 * parameters are validated later by the connector that owns the operation.
 */
export function validateChangeSet(input: unknown): ChangeSetInput {
  const problems: string[] = [];
  const at = (path: string, msg: string) => problems.push(`${path}: ${msg}`);

  if (!isRecord(input)) throw new EngineError("invalid_change_set", "change set must be an object");

  unknownKeys(input, TOP_LEVEL_KEYS, "$", at);
  if (input.schema_version !== SCHEMA_VERSION) {
    at("$.schema_version", `unsupported schema version ${JSON.stringify(input.schema_version)}; expected ${SCHEMA_VERSION}`);
  }
  for (const key of ["transaction_id", "workspace_id"] as const) {
    if (typeof input[key] !== "string" || !ID_PATTERN.test(input[key])) at(`$.${key}`, "must match " + ID_PATTERN);
  }
  for (const key of ["source_agent", "initiator", "requested_outcome", "connector"] as const) {
    if (!nonEmptyString(input[key])) at(`$.${key}`, "must be a non-empty string");
  }
  if (input.expires_at !== undefined && (typeof input.expires_at !== "string" || Number.isNaN(Date.parse(input.expires_at)))) {
    at("$.expires_at", "must be an ISO-8601 timestamp");
  }

  const actionIds = new Set<string>();
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    at("$.actions", "must be a non-empty array");
  } else if (input.actions.length > MAX_ACTIONS) {
    at("$.actions", `at most ${MAX_ACTIONS} actions per change set`);
  } else {
    input.actions.forEach((action, i) => {
      const path = `$.actions[${i}]`;
      if (!isRecord(action)) return at(path, "must be an object");
      unknownKeys(action, ACTION_KEYS, path, at);
      if (typeof action.id !== "string" || !ID_PATTERN.test(action.id)) at(`${path}.id`, "must match " + ID_PATTERN);
      else if (actionIds.has(action.id)) at(`${path}.id`, `duplicate action id ${action.id}`);
      else actionIds.add(action.id);
      if (!nonEmptyString(action.operation)) at(`${path}.operation`, "must be a non-empty string");
      if (!isRecord(action.params)) at(`${path}.params`, "must be an object");
      if (action.rationale !== undefined && typeof action.rationale !== "string") at(`${path}.rationale`, "must be a string");
      const t = action.target;
      if (!isRecord(t)) return at(`${path}.target`, "must be an object");
      unknownKeys(t, TARGET_KEYS, `${path}.target`, at);
      if (t.kind !== "github.issue") at(`${path}.target.kind`, "unsupported resource kind");
      if (!nonEmptyString(t.owner) || !/^[A-Za-z0-9-]+$/.test(t.owner)) at(`${path}.target.owner`, "invalid owner");
      if (!nonEmptyString(t.repo) || !/^[A-Za-z0-9._-]+$/.test(t.repo)) at(`${path}.target.repo`, "invalid repo");
      if (!Number.isInteger(t.number) || (t.number as number) < 1) at(`${path}.target.number`, "must be a positive integer");
    });
  }

  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies)) at("$.dependencies", "must be an array");
    else
      input.dependencies.forEach((dep, i) => {
        const path = `$.dependencies[${i}]`;
        if (!isRecord(dep)) return at(path, "must be an object");
        unknownKeys(dep, DEPENDENCY_KEYS, path, at);
        for (const end of ["before", "after"] as const) {
          if (typeof dep[end] !== "string" || !actionIds.has(dep[end])) at(`${path}.${end}`, "must reference an action id");
        }
        if (dep.before === dep.after) at(path, "an action cannot depend on itself");
      });
  }

  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence)) at("$.evidence", "must be an array");
    else
      input.evidence.forEach((ev, i) => {
        const path = `$.evidence[${i}]`;
        if (!isRecord(ev)) return at(path, "must be an object");
        unknownKeys(ev, EVIDENCE_KEYS, path, at);
        if (!nonEmptyString(ev.label)) at(`${path}.label`, "must be a non-empty string");
        if (typeof ev.content !== "string") at(`${path}.content`, "must be a string");
        if (ev.source !== undefined && typeof ev.source !== "string") at(`${path}.source`, "must be a string");
      });
  }

  if (problems.length) throw new EngineError("invalid_change_set", "change set rejected", problems);
  return input as unknown as ChangeSetInput;
}

/** Rejects params keys the operation does not define. Used by connector operation specs. */
export function strictParams(params: Record<string, unknown>, allowed: readonly string[], operation: string): void {
  const extra = Object.keys(params).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new EngineError("invalid_change_set", `unknown parameter(s) for ${operation}`, extra);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string, at: (p: string, m: string) => void) {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) at(`${path}.${key}`, "unknown field");
}
