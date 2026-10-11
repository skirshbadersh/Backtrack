export type EngineErrorCode =
  | "invalid_change_set"
  | "unknown_connector"
  | "unknown_operation"
  | "contradictory_actions"
  | "transaction_conflict"
  | "not_found"
  | "invalid_state"
  | "stale_revision"
  | "nothing_to_approve"
  | "blocked_by_policy"
  | "approval_invalid"
  | "approval_expired"
  | "transaction_expired"
  | "commit_in_progress"
  | "not_compensatable";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly details: string[];

  constructor(code: EngineErrorCode, message: string, details: string[] = []) {
    super(details.length ? `${message}: ${details.join("; ")}` : message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}
