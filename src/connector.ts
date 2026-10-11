import type {
  IdempotencyStrategy,
  NormalizedAction,
  Postcondition,
  RecoveryClass,
  ResourceRef,
  RiskAssessment,
  Snapshot,
  SnapshotField,
} from "./types.ts";

export type CompensationPlan =
  | { kind: "action"; operation: string; params: Record<string, unknown>; residue: string[] }
  | { kind: "noop"; reason: string }
  | { kind: "irreversible"; reason: string };

/**
 * Pure, deterministic description of one operation. Everything the review,
 * precondition, verification and compensation steps need is derived here; the
 * transport only performs the write.
 */
export interface OperationSpec {
  name: string;
  /** Validates and canonicalizes params. Throws EngineError on anything unexpected. */
  normalize(params: Record<string, unknown>): Record<string, unknown>;
  /** Snapshot fields whose change since preview makes this action stale. */
  relevantFields: readonly SnapshotField[];
  recovery(params: Record<string, unknown>): { class: RecoveryClass; residue: string[] };
  risk(params: Record<string, unknown>): RiskAssessment;
  idempotency: IdempotencyStrategy;
  /** The snapshot as it should look after this action lands. */
  project(snapshot: Snapshot, params: Record<string, unknown>, idempotencyKey: string): Snapshot;
  postconditions(params: Record<string, unknown>, idempotencyKey: string): Postcondition[];
  compensate(params: Record<string, unknown>, prior: Snapshot): CompensationPlan;
  summarize(params: Record<string, unknown>, target: ResourceRef): string;
}

export interface WriteResult {
  request_ids: string[];
}

export interface Connector {
  readonly id: string;
  operation(name: string): OperationSpec | undefined;
  targetKey(target: ResourceRef): string;
  describeTarget(target: ResourceRef): string;
  read(target: ResourceRef): Promise<Snapshot>;
  write(action: NormalizedAction): Promise<WriteResult>;
}

export function evaluatePostcondition(snapshot: Snapshot, p: Postcondition): boolean {
  switch (p.field) {
    case "title":
      return snapshot.title === p.value;
    case "state":
      return snapshot.state === p.value;
    case "labels":
    case "assignees": {
      const has = snapshot[p.field].some((v) => v.toLowerCase() === p.value.toLowerCase());
      return p.op === "includes" ? has : !has;
    }
    case "comment_markers":
      return snapshot.comment_markers.includes(p.value);
  }
}

export function failedPostconditions(snapshot: Snapshot, ps: readonly Postcondition[]): Postcondition[] {
  return ps.filter((p) => !evaluatePostcondition(snapshot, p));
}

export function pickFields(snapshot: Snapshot, fields: readonly SnapshotField[]): Partial<Snapshot> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = structuredClone(snapshot[f]);
  return out as Partial<Snapshot>;
}
