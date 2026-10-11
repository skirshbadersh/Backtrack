import { frozenCopy, hashOf } from "./canonical.ts";

export type LedgerEventType =
  | "submitted"
  | "submit_deduplicated"
  | "hydrated"
  | "revision_created"
  | "action_edited"
  | "action_rejected"
  | "action_restored"
  | "transaction_rejected"
  | "status_changed"
  | "approval_created"
  | "approval_invalidated"
  | "approval_expired"
  | "precondition_passed"
  | "precondition_conflicted"
  | "execution_started"
  | "execution_resumed"
  | "action_attempted"
  | "action_succeeded"
  | "action_already_applied"
  | "action_failed"
  | "verification_passed"
  | "verification_failed"
  | "receipt_issued"
  | "commit_replayed"
  | "compensation_proposed"
  | "compensation_approved"
  | "compensation_executed"
  | "compensation_verified"
  | "compensation_failed";

export interface LedgerEvent {
  seq: number;
  at: string;
  transaction_id: string;
  type: LedgerEventType;
  actor: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only, hash-chained event log. Events are frozen on append and there is
 * no update or delete API; corrections are new events. The chain makes after-the-fact
 * edits to an exported log detectable (tamper-evident, not tamper-proof).
 */
export class Ledger {
  #events: LedgerEvent[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  append(transaction_id: string, type: LedgerEventType, actor: string, data: Record<string, unknown> = {}): LedgerEvent {
    const prev_hash = this.head();
    const body = {
      seq: this.#events.length + 1,
      at: this.#now().toISOString(),
      transaction_id,
      type,
      actor,
      data: structuredClone(data),
      prev_hash,
    };
    const event = frozenCopy({ ...body, hash: hashOf(body) });
    this.#events.push(event);
    return event;
  }

  head(): string {
    return this.#events.at(-1)?.hash ?? GENESIS;
  }

  list(transaction_id?: string): readonly LedgerEvent[] {
    return transaction_id ? this.#events.filter((e) => e.transaction_id === transaction_id) : [...this.#events];
  }

  toJSONL(): string {
    return this.#events.map((e) => JSON.stringify(e)).join("\n");
  }

  /** Recomputes the chain. Returns the seq of the first broken event, or null if intact. */
  static verify(events: readonly LedgerEvent[]): number | null {
    let prev = GENESIS;
    for (const e of events) {
      const { hash, ...body } = e;
      if (e.prev_hash !== prev || hashOf(body) !== hash) return e.seq;
      prev = hash;
    }
    return null;
  }
}
