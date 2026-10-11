import type { Conflict, Receipt, TxStatus } from "../types.ts";

/**
 * Wire contract between agents (through the SDK) and the review server.
 * The UI uses the richer /api/tx endpoints; agents only ever see this.
 */

/** POST /api/change-sets */
export interface SubmitResponse {
  transaction_id: string;
  status: TxStatus;
  /** True when this exact change set was already submitted; the existing transaction is returned. */
  deduplicated: boolean;
}

/**
 * Where a transaction stands from the agent's point of view.
 * - waiting: a reviewer has not finished (pending review, approved, conflicted, executing).
 * - verified: committed, and every postcondition held on reread. The only `ok` outcome.
 * - not_verified: committed, but GitHub is not in the approved state (verification failed, partial, failed).
 * - rejected: the reviewer rejected the whole change set; nothing was written.
 * - expired: the change set passed its deadline; nothing was written.
 * - compensated: committed, then a reviewer proposed or ran recovery for some of it. Read the receipt.
 */
export type AgentOutcome = "waiting" | "verified" | "not_verified" | "rejected" | "expired" | "compensated";

/** GET /api/change-sets/:id */
export interface AgentStatus {
  transaction_id: string;
  kind: "change" | "compensation";
  status: TxStatus;
  outcome: AgentOutcome;
  /** True only for `verified`. Agents should treat anything else as "the write did not happen as proposed". */
  ok: boolean;
  revision: number;
  /** Reason the reviewer gave when rejecting, if any. */
  rejection_reason: string | null;
  /** Fields that changed since preview, while the transaction is `conflicted`. */
  conflicts: Conflict[];
  /** Present once committed. Shows proposed vs approved params, so the agent can see reviewer edits. */
  receipt: Receipt | null;
  /** Actions the reviewer rejected (from the receipt, or the latest revision while waiting). */
  rejected_action_ids: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: string[] };
}

export function outcomeOf(status: TxStatus): AgentOutcome {
  switch (status) {
    case "verified":
      return "verified";
    case "verification_failed":
    case "partially_executed":
    case "failed":
      return "not_verified";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "compensation_pending":
    case "compensated":
    case "compensation_failed":
      return "compensated";
    default:
      return "waiting";
  }
}
