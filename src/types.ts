export const SCHEMA_VERSION = "2026-10-01";
export const POLICY_VERSION = "2026-10-11.1";

export type RiskLevel = "low" | "medium" | "high" | "block";
export type RecoveryClass = "reversible" | "compensatable" | "irreversible";

/**
 * How a connector makes a write exactly-once under retry.
 * - native_key: the target API accepts an idempotency key.
 * - natural_key_reread: a reread can prove whether the write already landed.
 * - none: exactly-once cannot be promised; the receipt says so.
 */
export type IdempotencyStrategy = "native_key" | "natural_key_reread" | "none";

export interface IssueRef {
  kind: "github.issue";
  owner: string;
  repo: string;
  number: number;
}

export type ResourceRef = IssueRef;

/** The connector-normalized view of a target that previews, preconditions and verification compare against. */
export interface IssueSnapshot {
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[];
  assignees: string[];
  /** Idempotency markers found in the issue's comments (natural keys for comment writes). */
  comment_markers: string[];
}

export type Snapshot = IssueSnapshot;
export type SnapshotField = keyof IssueSnapshot;

export type Postcondition =
  | { field: "title"; op: "equals"; value: string }
  | { field: "state"; op: "equals"; value: string }
  | { field: "labels" | "assignees"; op: "includes" | "excludes"; value: string }
  | { field: "comment_markers"; op: "includes"; value: string };

export interface ActionInput {
  id: string;
  operation: string;
  target: ResourceRef;
  params: Record<string, unknown>;
  rationale?: string;
}

/** Ordering constraint: `before` must execute before `after`. */
export interface Dependency {
  before: string;
  after: string;
}

/** Agent-supplied context. Always shown to the reviewer as untrusted. */
export interface Evidence {
  label: string;
  content: string;
  source?: string;
}

export interface ChangeSetInput {
  schema_version: string;
  transaction_id: string;
  workspace_id: string;
  source_agent: string;
  initiator: string;
  requested_outcome: string;
  connector: string;
  actions: ActionInput[];
  dependencies?: Dependency[];
  evidence?: Evidence[];
  expires_at?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  factors: string[];
}

export interface NormalizedAction {
  id: string;
  operation: string;
  target: ResourceRef;
  params: Record<string, unknown>;
  rationale?: string;
  summary: string;
  idempotency_key: string;
  idempotency_strategy: IdempotencyStrategy;
  /** Relevant fields of the target as captured at preview time. */
  precondition: Partial<Snapshot>;
  postconditions: Postcondition[];
  risk: RiskAssessment;
  recovery: { class: RecoveryClass; residue: string[] };
}

export type ItemDecision = "include" | "reject";

export interface Revision {
  number: number;
  created_at: string;
  created_by: string;
  reason: string;
  actions: NormalizedAction[];
  decisions: Record<string, ItemDecision>;
  /** Target snapshots read at hydration, keyed by target key. */
  snapshots: Record<string, Snapshot>;
}

export type TxStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "approved"
  | "conflicted"
  | "queued"
  | "executing"
  | "partially_executed"
  | "failed"
  | "verification_failed"
  | "verified"
  | "rejected"
  | "expired"
  | "compensation_pending"
  | "compensated"
  | "compensation_failed";

export interface Approval {
  id: string;
  transaction_id: string;
  revision: number;
  schema_version: string;
  workspace_id: string;
  connector: string;
  reviewer: string;
  payload_hash: string;
  approved_action_ids: string[];
  approved_at: string;
  expires_at: string;
  policy_version: string;
  status: "active" | "consumed" | "invalidated" | "expired";
}

export type AttemptStatus = "in_doubt" | "written" | "already_applied" | "failed";

export interface AttemptRecord {
  status: AttemptStatus;
  request_ids: string[];
  error?: string;
}

export interface ExecutionRecord {
  approval_id: string;
  payload_hash: string;
  started_at: string;
  /** Target snapshots read at the pre-execution reread; the prior state compensation is planned from. */
  pre_snapshots: Record<string, Snapshot>;
  attempts: Record<string, AttemptRecord>;
}

export interface Conflict {
  action_id: string;
  target: ResourceRef;
  field: SnapshotField;
  previewed: unknown;
  current: unknown;
  proposed: unknown;
}

export interface ReceiptAction {
  id: string;
  operation: string;
  target: ResourceRef;
  summary: string;
  idempotency_key: string;
  idempotency_strategy: IdempotencyStrategy;
  exactly_once: "guaranteed" | "not_guaranteed";
  recovery_class: RecoveryClass;
  proposed: Record<string, unknown> | null;
  approved: Record<string, unknown>;
  attempted: AttemptRecord | { status: "not_attempted"; request_ids: [] };
  actual: Partial<Snapshot> | null;
  verification: { status: "passed" | "failed" | "not_run"; failed: Postcondition[] };
}

export interface Receipt {
  transaction_id: string;
  revision: number;
  kind: "change" | "compensation";
  outcome: "verified" | "verification_failed" | "partially_executed" | "failed";
  payload_hash: string;
  approval: {
    id: string;
    reviewer: string;
    approved_at: string;
    expires_at: string;
    policy_version: string;
  };
  actions: ReceiptAction[];
  rejected_action_ids: string[];
  issued_at: string;
  /** Hash of the ledger head when the receipt was issued; ties the receipt to the event chain. */
  ledger_head: string;
  receipt_hash: string;
}

export interface Transaction {
  id: string;
  kind: "change" | "compensation";
  workspace_id: string;
  connector: string;
  source_agent: string;
  initiator: string;
  requested_outcome: string;
  evidence: Evidence[];
  dependencies: Dependency[];
  expires_at: string | null;
  input_hash: string;
  created_at: string;
  status: TxStatus;
  revisions: Revision[];
  /** Original agent parameters per action id, so receipts can show proposed vs approved. */
  proposed_params: Record<string, Record<string, unknown>>;
  approvals: Approval[];
  execution?: ExecutionRecord;
  receipt?: Receipt;
  compensates?: { transaction_id: string; action_ids: string[] };
  compensated_by: string[];
  /** For compensation transactions: effects of the original action that the compensation cannot remove, per action id. */
  residue_notes: Record<string, string[]>;
}
