import { EngineError } from "./errors.ts";
import type { TxStatus } from "./types.ts";

/** The only transitions the engine may make. Every transition is recorded as a ledger event. */
const TRANSITIONS: Record<TxStatus, readonly TxStatus[]> = {
  draft: ["pending_review", "rejected"],
  pending_review: ["pending_review", "approved", "changes_requested", "rejected", "expired"],
  changes_requested: ["pending_review", "rejected", "expired"],
  // An edit after approval invalidates the approval and returns to review as a new revision.
  approved: ["pending_review", "queued", "conflicted", "rejected", "expired"],
  conflicted: ["pending_review", "rejected", "expired"],
  queued: ["executing", "conflicted"],
  // executing -> executing covers resuming after a crash with attempts in doubt.
  executing: ["executing", "verified", "verification_failed", "partially_executed", "failed"],
  partially_executed: ["compensation_pending"],
  failed: [],
  verification_failed: ["compensation_pending"],
  verified: ["compensation_pending"],
  rejected: [],
  expired: [],
  compensation_pending: ["compensated", "compensation_failed"],
  compensated: [],
  compensation_failed: ["compensation_pending"],
};

export function canTransition(from: TxStatus, to: TxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TxStatus, to: TxStatus): void {
  if (!canTransition(from, to)) {
    throw new EngineError("invalid_state", `illegal transition ${from} -> ${to}`);
  }
}

export const TERMINAL_OUTCOMES: readonly TxStatus[] = ["verified", "verification_failed", "partially_executed", "failed"];
