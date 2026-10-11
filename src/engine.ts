import { randomUUID } from "node:crypto";
import { deepEqual, hashOf } from "./canonical.ts";
import { failedPostconditions, pickFields, type Connector } from "./connector.ts";
import { EngineError } from "./errors.ts";
import { Ledger } from "./ledger.ts";
import { assessTransactionRisk } from "./risk.ts";
import { assertTransition } from "./state.ts";
import {
  POLICY_VERSION,
  SCHEMA_VERSION,
  type ActionInput,
  type Approval,
  type AttemptRecord,
  type ChangeSetInput,
  type Conflict,
  type Dependency,
  type ItemDecision,
  type NormalizedAction,
  type Postcondition,
  type Receipt,
  type ReceiptAction,
  type RecoveryClass,
  type ResourceRef,
  type Revision,
  type RiskAssessment,
  type Snapshot,
  type SnapshotField,
  type Transaction,
  type TxStatus,
} from "./types.ts";
import { validateChangeSet } from "./validate.ts";

export interface EngineOptions {
  connectors: Connector[];
  now?: () => Date;
  /** How long an approval stays valid. Default 30 minutes. */
  approvalTtlMs?: number;
}

export type CommitResult =
  | { outcome: "committed"; replayed: boolean; receipt: Receipt }
  | { outcome: "conflicted"; conflicts: Conflict[] };

export interface InboxRow {
  id: string;
  kind: Transaction["kind"];
  status: TxStatus;
  requested_outcome: string;
  source_agent: string;
  initiator: string;
  repositories: string[];
  action_count: number;
  included_count: number;
  object_count: number;
  risk: RiskAssessment;
  recovery: Record<RecoveryClass, number>;
  created_at: string;
  approval_expires_at: string | null;
}

/**
 * Thrown by test transports to simulate the executor process dying mid-write.
 * The engine never records anything for it, which is exactly what a real crash
 * looks like from the ledger's point of view.
 */
export class SimulatedCrash extends Error {
  override name = "SimulatedCrash";
}

const OPEN_FOR_REVIEW: readonly TxStatus[] = ["pending_review", "changes_requested", "approved", "conflicted"];
const COMPENSATABLE: readonly TxStatus[] = ["verified", "verification_failed", "partially_executed", "compensation_failed"];

/**
 * The deterministic core: proposal intake, hydration, review revisions, approval
 * binding, precondition reread, idempotent execution, postcondition verification,
 * compensation planning and receipts. No model output is consulted for any decision.
 */
export class Engine {
  readonly ledger: Ledger;
  readonly #connectors = new Map<string, Connector>();
  readonly #txs = new Map<string, Transaction>();
  readonly #locks = new Set<string>();
  readonly #now: () => Date;
  readonly #ttl: number;

  constructor(options: EngineOptions) {
    for (const c of options.connectors) this.#connectors.set(c.id, c);
    this.#now = options.now ?? (() => new Date());
    this.#ttl = options.approvalTtlMs ?? 30 * 60_000;
    this.ledger = new Ledger(this.#now);
  }

  // ---------------------------------------------------------------- intake

  /**
   * Validates, normalizes and hydrates a change set. Resubmitting an identical
   * change set returns the existing transaction (whatever its state) instead of
   * creating a second one; reusing a transaction id for a different payload fails.
   */
  async submit(input: unknown): Promise<{ transaction: Transaction; deduplicated: boolean }> {
    const cs = validateChangeSet(input);
    const inputHash = hashOf(cs);
    const existing = this.#txs.get(cs.transaction_id);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        throw new EngineError("transaction_conflict", `transaction ${cs.transaction_id} already exists with a different payload`);
      }
      this.ledger.append(existing.id, "submit_deduplicated", cs.source_agent, { input_hash: inputHash, status: existing.status });
      return { transaction: this.get(existing.id), deduplicated: true };
    }
    const tx = await this.#create(cs, inputHash, "change");
    return { transaction: this.get(tx.id), deduplicated: false };
  }

  get(id: string): Transaction {
    const tx = this.#tx(id);
    this.#expireIfDue(tx);
    return structuredClone(tx);
  }

  list(): InboxRow[] {
    return [...this.#txs.values()].map((tx) => {
      this.#expireIfDue(tx);
      return this.inboxRow(tx);
    });
  }

  inboxRow(tx: Transaction): InboxRow {
    const rev = latest(tx);
    const included = this.#included(rev);
    const recovery: Record<RecoveryClass, number> = { reversible: 0, compensatable: 0, irreversible: 0 };
    for (const a of included) recovery[a.recovery.class]++;
    const active = tx.approvals.find((a) => a.status === "active");
    return {
      id: tx.id,
      kind: tx.kind,
      status: tx.status,
      requested_outcome: tx.requested_outcome,
      source_agent: tx.source_agent,
      initiator: tx.initiator,
      repositories: [...new Set(rev.actions.map((a) => `${a.target.owner}/${a.target.repo}`))],
      action_count: rev.actions.length,
      included_count: included.length,
      object_count: Object.keys(rev.snapshots).length,
      risk: this.transactionRisk(tx),
      recovery,
      created_at: tx.created_at,
      approval_expires_at: active?.expires_at ?? null,
    };
  }

  /** Reads a target's current state through its connector, for adapters that must translate "replace" semantics into explicit actions. */
  async readTarget(connectorId: string, target: ResourceRef): Promise<Snapshot> {
    return this.#connector(connectorId).read(target);
  }

  transactionRisk(tx: Transaction): RiskAssessment {
    const rev = latest(tx);
    const included = this.#included(rev);
    const objects = new Set(included.map((a) => this.#connector(tx.connector).targetKey(a.target)));
    return assessTransactionRisk(included, objects.size);
  }

  /** The before/after view of every affected object, projecting only included actions. */
  preview(id: string): Array<{ target: NormalizedAction["target"]; before: Snapshot; after: Snapshot; actions: NormalizedAction[] }> {
    const tx = this.#tx(id);
    const rev = latest(tx);
    const connector = this.#connector(tx.connector);
    const out = new Map<string, { target: NormalizedAction["target"]; before: Snapshot; after: Snapshot; actions: NormalizedAction[] }>();
    for (const a of rev.actions) {
      const key = connector.targetKey(a.target);
      const before = rev.snapshots[key]!;
      const entry = out.get(key) ?? { target: a.target, before, after: structuredClone(before), actions: [] };
      entry.actions.push(a);
      out.set(key, entry);
    }
    for (const a of this.#ordered(tx, rev)) {
      const entry = out.get(connector.targetKey(a.target))!;
      entry.after = connector.operation(a.operation)!.project(entry.after, a.params, a.idempotency_key);
    }
    return structuredClone([...out.values()]);
  }

  // ---------------------------------------------------------------- review

  async editAction(id: string, actionId: string, params: Record<string, unknown>, reviewer: string): Promise<Transaction> {
    const tx = this.#openForReview(id);
    const rev = latest(tx);
    const action = rev.actions.find((a) => a.id === actionId);
    if (!action) throw new EngineError("not_found", `action ${actionId} not in transaction ${id}`);
    const inputs = rev.actions.map((a) => (a.id === actionId ? { ...toInput(a), params } : toInput(a)));
    const next = await this.#buildRevision(tx, inputs, rev.decisions, reviewer, `edited ${actionId}`);
    this.#invalidateApprovals(tx, reviewer, "revision changed");
    tx.revisions.push(next);
    const edited = next.actions.find((a) => a.id === actionId)!;
    this.ledger.append(tx.id, "action_edited", reviewer, { action_id: actionId, revision: next.number, from: action.params, to: edited.params });
    this.#transition(tx, "pending_review", reviewer);
    return this.get(id);
  }

  async rejectAction(id: string, actionId: string, reviewer: string, reason = ""): Promise<Transaction> {
    return this.#setDecision(id, actionId, "reject", reviewer, reason);
  }

  async restoreAction(id: string, actionId: string, reviewer: string): Promise<Transaction> {
    return this.#setDecision(id, actionId, "include", reviewer, "");
  }

  rejectTransaction(id: string, reviewer: string, reason: string): Transaction {
    const tx = this.#openForReview(id);
    this.#invalidateApprovals(tx, reviewer, "transaction rejected");
    this.ledger.append(tx.id, "transaction_rejected", reviewer, { reason });
    this.#transition(tx, "rejected", reviewer);
    this.#settleParentIfAbandoned(tx, reviewer);
    return this.get(id);
  }

  /** Re-reads every target and creates a new revision against current state. Requires a fresh approval. */
  async rebase(id: string, reviewer: string): Promise<Transaction> {
    const tx = this.#openForReview(id);
    const rev = latest(tx);
    const next = await this.#buildRevision(tx, rev.actions.map(toInput), rev.decisions, reviewer, "rebased onto current state");
    this.#invalidateApprovals(tx, reviewer, "rebased");
    tx.revisions.push(next);
    this.#transition(tx, "pending_review", reviewer);
    return this.get(id);
  }

  /**
   * Binds the reviewer to the exact canonical payload of the current revision.
   * Pass `revision` (what the reviewer was looking at) so a concurrent edit cannot be approved blind.
   */
  approve(id: string, reviewer: string, opts: { revision?: number } = {}): Approval {
    const tx = this.#tx(id);
    if (this.#expireIfDue(tx)) throw new EngineError("transaction_expired", `transaction ${id} expired`);
    if (tx.status !== "pending_review") throw new EngineError("invalid_state", `cannot approve a transaction in ${tx.status}`);
    const rev = latest(tx);
    if (opts.revision !== undefined && opts.revision !== rev.number) {
      throw new EngineError("stale_revision", `reviewed revision ${opts.revision} but current revision is ${rev.number}`);
    }
    const included = this.#ordered(tx, rev);
    if (!included.length) throw new EngineError("nothing_to_approve", "every action is rejected; reject the transaction instead");
    const blocked = included.filter((a) => a.risk.level === "block");
    if (blocked.length) throw new EngineError("blocked_by_policy", "actions blocked by policy", blocked.map((a) => `${a.id}: ${a.risk.factors.join(", ")}`));

    const now = this.#now();
    let expires = now.getTime() + this.#ttl;
    if (tx.expires_at) expires = Math.min(expires, Date.parse(tx.expires_at));
    const approval: Approval = {
      id: `apv_${randomUUID()}`,
      transaction_id: tx.id,
      revision: rev.number,
      schema_version: SCHEMA_VERSION,
      workspace_id: tx.workspace_id,
      connector: tx.connector,
      reviewer,
      payload_hash: hashOf(this.approvedPayload(tx, rev)),
      approved_action_ids: included.map((a) => a.id),
      approved_at: now.toISOString(),
      expires_at: new Date(expires).toISOString(),
      policy_version: POLICY_VERSION,
      status: "active",
    };
    tx.approvals.push(approval);
    this.ledger.append(tx.id, "approval_created", reviewer, {
      approval_id: approval.id,
      revision: rev.number,
      payload_hash: approval.payload_hash,
      approved_action_ids: approval.approved_action_ids,
      rejected_action_ids: rev.actions.filter((a) => rev.decisions[a.id] === "reject").map((a) => a.id),
      expires_at: approval.expires_at,
      policy_version: POLICY_VERSION,
    });
    if (tx.compensates) this.ledger.append(tx.compensates.transaction_id, "compensation_approved", reviewer, { compensation_transaction_id: tx.id });
    this.#transition(tx, "approved", reviewer);
    return structuredClone(approval);
  }

  /** Everything execution-relevant about the included actions. Its hash is what an approval binds to. */
  approvedPayload(tx: Transaction, rev: Revision = latest(tx)) {
    const included = this.#ordered(tx, rev);
    const ids = new Set(included.map((a) => a.id));
    return {
      schema_version: SCHEMA_VERSION,
      workspace_id: tx.workspace_id,
      connector: tx.connector,
      transaction_id: tx.id,
      kind: tx.kind,
      revision: rev.number,
      actions: included.map((a) => ({
        id: a.id,
        operation: a.operation,
        target: a.target,
        params: a.params,
        idempotency_key: a.idempotency_key,
        idempotency_strategy: a.idempotency_strategy,
        precondition: a.precondition,
        postconditions: a.postconditions,
        recovery_class: a.recovery.class,
      })),
      dependencies: tx.dependencies.filter((d) => ids.has(d.before) && ids.has(d.after)),
    };
  }

  // ---------------------------------------------------------------- commit

  /**
   * Executes an approval exactly once. Calling commit again with the same approval
   * returns the original receipt and writes nothing. If the executor died mid-run,
   * calling commit again resumes: actions already recorded or provably applied
   * (by reread) are not written twice.
   */
  async commit(id: string, approvalId: string, actor = "executor"): Promise<CommitResult> {
    const tx = this.#tx(id);
    const approval = tx.approvals.find((a) => a.id === approvalId);
    if (!approval) throw new EngineError("approval_invalid", `approval ${approvalId} does not belong to transaction ${id}`);
    if (tx.receipt) {
      if (tx.receipt.approval.id !== approvalId) throw new EngineError("approval_invalid", "transaction was already committed under a different approval");
      this.ledger.append(tx.id, "commit_replayed", actor, { approval_id: approvalId, receipt_hash: tx.receipt.receipt_hash });
      return { outcome: "committed", replayed: true, receipt: structuredClone(tx.receipt) };
    }
    if (this.#locks.has(tx.id)) throw new EngineError("commit_in_progress", `transaction ${id} is already executing`);
    this.#locks.add(tx.id);
    try {
      const resuming = tx.status === "executing" && tx.execution?.approval_id === approvalId;
      if (!resuming) this.#checkApprovalExecutable(tx, approval, actor);
      else this.ledger.append(tx.id, "execution_resumed", actor, { approval_id: approvalId });

      const connector = this.#connector(tx.connector);
      const rev = tx.revisions.find((r) => r.number === approval.revision)!;
      const actions = this.#ordered(tx, rev);

      // G4: reread every affected object immediately before execution.
      const current = await this.#readAll(connector, actions);
      if (!resuming) {
        this.#transition(tx, "queued", actor);
        const conflicts = this.#conflicts(connector, rev, actions, current);
        if (conflicts.length) {
          for (const c of conflicts) this.ledger.append(tx.id, "precondition_conflicted", actor, { ...c });
          approval.status = "invalidated";
          this.ledger.append(tx.id, "approval_invalidated", actor, { approval_id: approval.id, reason: "target changed since preview" });
          this.#transition(tx, "conflicted", actor);
          return { outcome: "conflicted", conflicts: structuredClone(conflicts) };
        }
        this.ledger.append(tx.id, "precondition_passed", actor, { targets: Object.keys(current) });
        tx.execution = { approval_id: approval.id, payload_hash: approval.payload_hash, started_at: this.#now().toISOString(), pre_snapshots: current, attempts: {} };
        approval.status = "consumed";
        this.#transition(tx, "executing", actor);
        this.ledger.append(tx.id, "execution_started", actor, { approval_id: approval.id, payload_hash: approval.payload_hash, order: actions.map((a) => a.id) });
      }
      const exec = tx.execution!;
      const driftedOnResume = resuming ? this.#resumeDrift(connector, actions, exec, current) : new Set<string>();

      let stopped = false;
      for (const action of actions) {
        const prior = exec.attempts[action.id];
        if (prior && (prior.status === "written" || prior.status === "already_applied")) continue;
        if (stopped) break;
        if (driftedOnResume.has(action.id)) {
          exec.attempts[action.id] = { status: "failed", request_ids: [], error: "target changed while execution was interrupted" };
          this.ledger.append(tx.id, "action_failed", actor, { action_id: action.id, error: exec.attempts[action.id]!.error });
          stopped = true;
          continue;
        }
        stopped = !(await this.#executeAction(tx, connector, action, actor));
      }

      // G5: reread and check declared postconditions; a 2xx response proves nothing on its own.
      const final = await this.#readAll(connector, actions);
      const verification = new Map<string, Postcondition[]>();
      for (const action of actions) {
        const att = exec.attempts[action.id];
        if (!att || (att.status !== "written" && att.status !== "already_applied")) continue;
        const failed = failedPostconditions(final[connector.targetKey(action.target)]!, action.postconditions);
        verification.set(action.id, failed);
        this.ledger.append(tx.id, failed.length ? "verification_failed" : "verification_passed", actor, {
          action_id: action.id,
          ...(failed.length ? { failed } : {}),
          actual: pickFields(final[connector.targetKey(action.target)]!, postconditionFields(action.postconditions)),
        });
      }

      const attempts = actions.map((a) => exec.attempts[a.id]);
      const anyFailed = attempts.some((a) => a?.status === "failed");
      const anyApplied = attempts.some((a) => a?.status === "written" || a?.status === "already_applied");
      const outcome: Receipt["outcome"] = anyFailed
        ? anyApplied
          ? "partially_executed"
          : "failed"
        : [...verification.values()].some((f) => f.length)
          ? "verification_failed"
          : "verified";
      this.#transition(tx, outcome, actor);
      tx.receipt = this.#buildReceipt(tx, rev, approval, actions, final, verification, outcome);
      this.ledger.append(tx.id, "receipt_issued", actor, { outcome, receipt_hash: tx.receipt.receipt_hash });
      if (tx.compensates) this.#settleParent(tx, outcome, actor);
      return { outcome: "committed", replayed: false, receipt: structuredClone(tx.receipt) };
    } finally {
      this.#locks.delete(tx.id);
    }
  }

  // ---------------------------------------------------------- compensation

  /**
   * Plans recovery for executed actions as a brand-new transaction that goes
   * through the same review, approval and commit flow. Never runs on its own.
   */
  async proposeCompensation(
    id: string,
    actionIds: string[],
    actor: string,
  ): Promise<{ transaction: Transaction; skipped: Array<{ action_id: string; reason: string }> }> {
    const tx = this.#tx(id);
    if (!COMPENSATABLE.includes(tx.status) || !tx.execution) {
      throw new EngineError("invalid_state", `cannot compensate a transaction in ${tx.status}`);
    }
    const connector = this.#connector(tx.connector);
    const rev = tx.revisions.find((r) => r.number === tx.receipt!.revision)!;
    const actions: ActionInput[] = [];
    const residue: Record<string, string[]> = {};
    const skipped: Array<{ action_id: string; reason: string }> = [];
    const refused: string[] = [];
    for (const actionId of actionIds) {
      const action = rev.actions.find((a) => a.id === actionId);
      const attempt = tx.execution.attempts[actionId];
      if (!action || !attempt || (attempt.status !== "written" && attempt.status !== "already_applied")) {
        refused.push(`${actionId}: was not executed`);
        continue;
      }
      const prior = tx.execution.pre_snapshots[connector.targetKey(action.target)]!;
      const plan = connector.operation(action.operation)!.compensate(action.params, prior);
      if (plan.kind === "irreversible") refused.push(`${actionId}: ${plan.reason}`);
      else if (plan.kind === "noop") skipped.push({ action_id: actionId, reason: plan.reason });
      else {
        const compId = `undo-${actionId}`;
        actions.push({ id: compId, operation: plan.operation, target: action.target, params: plan.params, rationale: `Compensates ${actionId}: ${action.summary}` });
        residue[compId] = plan.residue;
      }
    }
    if (refused.length) throw new EngineError("not_compensatable", "some actions cannot be compensated", refused);
    if (!actions.length) throw new EngineError("not_compensatable", "nothing to compensate", skipped.map((s) => `${s.action_id}: ${s.reason}`));

    const cs: ChangeSetInput = {
      schema_version: SCHEMA_VERSION,
      transaction_id: `${tx.id}.c${tx.compensated_by.length + 1}`,
      workspace_id: tx.workspace_id,
      source_agent: "compensation-planner",
      initiator: actor,
      requested_outcome: `Compensate ${actionIds.join(", ")} from ${tx.id} ("${tx.requested_outcome}")`,
      connector: tx.connector,
      actions,
    };
    const child = await this.#create(cs, hashOf(cs), "compensation", { transaction_id: tx.id, action_ids: actionIds }, residue);
    tx.compensated_by.push(child.id);
    this.#transition(tx, "compensation_pending", actor);
    this.ledger.append(tx.id, "compensation_proposed", actor, { compensation_transaction_id: child.id, action_ids: actionIds, skipped });
    return { transaction: this.get(child.id), skipped };
  }

  // ------------------------------------------------------------- internals

  async #create(
    cs: ChangeSetInput,
    inputHash: string,
    kind: Transaction["kind"],
    compensates?: Transaction["compensates"],
    residue: Record<string, string[]> = {},
  ): Promise<Transaction> {
    const connector = this.#connector(cs.connector);
    if (cs.expires_at && Date.parse(cs.expires_at) <= this.#now().getTime()) {
      throw new EngineError("transaction_expired", "change set is already past expires_at");
    }
    const tx: Transaction = {
      id: cs.transaction_id,
      kind,
      workspace_id: cs.workspace_id,
      connector: connector.id,
      source_agent: cs.source_agent,
      initiator: cs.initiator,
      requested_outcome: cs.requested_outcome,
      evidence: cs.evidence ?? [],
      dependencies: cs.dependencies ?? [],
      expires_at: cs.expires_at ?? null,
      input_hash: inputHash,
      created_at: this.#now().toISOString(),
      status: "draft",
      revisions: [],
      proposed_params: {},
      approvals: [],
      compensated_by: [],
      residue_notes: residue,
      ...(compensates ? { compensates } : {}),
    };
    this.#topoOrder(cs.actions, tx.dependencies); // rejects cycles before any read
    const decisions = Object.fromEntries(cs.actions.map((a) => [a.id, "include" as const]));
    const rev = await this.#buildRevision(tx, cs.actions, decisions, cs.source_agent, "submitted");
    tx.revisions.push(rev);
    for (const a of rev.actions) tx.proposed_params[a.id] = a.params;
    this.#txs.set(tx.id, tx);
    this.ledger.append(tx.id, "submitted", cs.source_agent, {
      kind,
      input_hash: inputHash,
      initiator: cs.initiator,
      requested_outcome: cs.requested_outcome,
      action_ids: cs.actions.map((a) => a.id),
      ...(compensates ? { compensates } : {}),
    });
    this.ledger.append(tx.id, "hydrated", "hydration", { revision: rev.number, targets: Object.keys(rev.snapshots) });
    this.#transition(tx, "pending_review", "hydration");
    return tx;
  }

  async #buildRevision(
    tx: Transaction,
    inputs: ActionInput[],
    decisions: Record<string, ItemDecision>,
    createdBy: string,
    reason: string,
  ): Promise<Revision> {
    const connector = this.#connector(tx.connector);
    const unknown = inputs.filter((a) => !connector.operation(a.operation)).map((a) => `${a.id}: ${a.operation}`);
    if (unknown.length) throw new EngineError("unknown_operation", "unknown operations are blocked", unknown);

    const snapshots: Record<string, Snapshot> = {};
    for (const a of inputs) {
      const key = connector.targetKey(a.target);
      snapshots[key] ??= await connector.read(a.target);
    }

    const actions: NormalizedAction[] = inputs.map((input) => {
      const spec = connector.operation(input.operation)!;
      const params = spec.normalize(input.params);
      const idempotency_key = hashOf({
        workspace_id: tx.workspace_id,
        connector: connector.id,
        transaction_id: tx.id,
        action_id: input.id,
        operation: input.operation,
        target: input.target,
        params,
      });
      const recovery = spec.recovery(params);
      // A compensation states what the original action left behind, which is what the reviewer needs to know.
      const residue = tx.residue_notes[input.id] ?? recovery.residue;
      return {
        id: input.id,
        operation: input.operation,
        target: input.target,
        params,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        summary: spec.summarize(params, input.target),
        idempotency_key,
        idempotency_strategy: spec.idempotency,
        precondition: pickFields(snapshots[connector.targetKey(input.target)]!, spec.relevantFields),
        postconditions: spec.postconditions(params, idempotency_key),
        risk: spec.risk(params),
        recovery: { class: recovery.class, residue: [...new Set(residue)] },
      };
    });

    const rev: Revision = {
      number: tx.revisions.length + 1,
      created_at: this.#now().toISOString(),
      created_by: createdBy,
      reason,
      actions,
      decisions: { ...decisions },
      snapshots,
    };

    // Included actions must not undo each other: every postcondition has to hold on the projected end state.
    const projected = structuredClone(snapshots);
    const ordered = this.#ordered(tx, rev);
    for (const a of ordered) {
      const key = connector.targetKey(a.target);
      projected[key] = connector.operation(a.operation)!.project(projected[key]!, a.params, a.idempotency_key);
    }
    const contradictions = ordered
      .filter((a) => failedPostconditions(projected[connector.targetKey(a.target)]!, a.postconditions).length)
      .map((a) => `${a.id} is undone by a later action`);
    if (contradictions.length) throw new EngineError("contradictory_actions", "actions in this change set contradict each other", contradictions);
    return rev;
  }

  async #setDecision(id: string, actionId: string, decision: ItemDecision, reviewer: string, reason: string): Promise<Transaction> {
    const tx = this.#openForReview(id);
    const rev = latest(tx);
    if (!rev.actions.some((a) => a.id === actionId)) throw new EngineError("not_found", `action ${actionId} not in transaction ${id}`);
    if (rev.decisions[actionId] === decision) return this.get(id);
    const next = await this.#buildRevision(tx, rev.actions.map(toInput), { ...rev.decisions, [actionId]: decision }, reviewer, `${decision} ${actionId}`);
    this.#invalidateApprovals(tx, reviewer, "revision changed");
    tx.revisions.push(next);
    this.ledger.append(tx.id, decision === "reject" ? "action_rejected" : "action_restored", reviewer, { action_id: actionId, revision: next.number, reason });
    this.#transition(tx, "pending_review", reviewer);
    return this.get(id);
  }

  #checkApprovalExecutable(tx: Transaction, approval: Approval, actor: string): void {
    if (this.#expireIfDue(tx)) throw new EngineError("transaction_expired", `transaction ${tx.id} expired`);
    if (approval.status !== "active") throw new EngineError("approval_invalid", `approval is ${approval.status}`);
    if (tx.status !== "approved") throw new EngineError("invalid_state", `cannot commit a transaction in ${tx.status}`);
    if (this.#now().getTime() >= Date.parse(approval.expires_at)) {
      approval.status = "expired";
      this.ledger.append(tx.id, "approval_expired", actor, { approval_id: approval.id, expires_at: approval.expires_at });
      this.#transition(tx, "pending_review", actor);
      throw new EngineError("approval_expired", `approval expired at ${approval.expires_at}; review again`);
    }
    const rev = latest(tx);
    if (approval.revision !== rev.number || hashOf(this.approvedPayload(tx, rev)) !== approval.payload_hash) {
      approval.status = "invalidated";
      this.ledger.append(tx.id, "approval_invalidated", actor, { approval_id: approval.id, reason: "payload no longer matches approval" });
      throw new EngineError("approval_invalid", "approved payload hash does not match the current revision");
    }
  }

  #conflicts(connector: Connector, rev: Revision, actions: NormalizedAction[], current: Record<string, Snapshot>): Conflict[] {
    const conflicts: Conflict[] = [];
    for (const a of actions) {
      const key = connector.targetKey(a.target);
      const now = current[key]!;
      const proposed = connector.operation(a.operation)!.project(rev.snapshots[key]!, a.params, a.idempotency_key);
      for (const field of Object.keys(a.precondition) as SnapshotField[]) {
        if (!deepEqual(a.precondition[field], now[field])) {
          conflicts.push({ action_id: a.id, target: a.target, field, previewed: a.precondition[field], current: now[field], proposed: proposed[field] });
        }
      }
    }
    return conflicts;
  }

  /**
   * After an interrupted run, a pending action's relevant fields may legitimately
   * differ from the pre-execution state only by effects of this transaction's own
   * earlier actions (applied, or the one in doubt). Anything else is outside drift.
   */
  #resumeDrift(connector: Connector, actions: NormalizedAction[], exec: NonNullable<Transaction["execution"]>, current: Record<string, Snapshot>): Set<string> {
    const withDone = structuredClone(exec.pre_snapshots);
    for (const a of actions) {
      const s = exec.attempts[a.id]?.status;
      if (s === "written" || s === "already_applied") {
        const key = connector.targetKey(a.target);
        withDone[key] = connector.operation(a.operation)!.project(withDone[key]!, a.params, a.idempotency_key);
      }
    }
    const withDoubt = structuredClone(withDone);
    for (const a of actions) {
      if (exec.attempts[a.id]?.status === "in_doubt") {
        const key = connector.targetKey(a.target);
        withDoubt[key] = connector.operation(a.operation)!.project(withDoubt[key]!, a.params, a.idempotency_key);
      }
    }
    const drifted = new Set<string>();
    for (const a of actions) {
      const s = exec.attempts[a.id]?.status;
      if (s === "written" || s === "already_applied") continue;
      const key = connector.targetKey(a.target);
      for (const field of Object.keys(a.precondition) as SnapshotField[]) {
        const ok = deepEqual(current[key]![field], withDone[key]![field]) || deepEqual(current[key]![field], withDoubt[key]![field]);
        if (!ok) drifted.add(a.id);
      }
    }
    return drifted;
  }

  /** Returns false if the action failed and execution must stop. */
  async #executeAction(tx: Transaction, connector: Connector, action: NormalizedAction, actor: string): Promise<boolean> {
    const exec = tx.execution!;
    const key = connector.targetKey(action.target);
    // Natural-key reread: if the target already satisfies every postcondition, the write has
    // landed (from an earlier attempt or otherwise) and repeating it could duplicate effects.
    if (action.idempotency_strategy !== "none") {
      const before = await connector.read(action.target);
      if (!failedPostconditions(before, action.postconditions).length) {
        const wasInDoubt = exec.attempts[action.id]?.status === "in_doubt";
        exec.attempts[action.id] = { status: "already_applied", request_ids: exec.attempts[action.id]?.request_ids ?? [] };
        this.ledger.append(tx.id, "action_already_applied", actor, { action_id: action.id, idempotency_key: action.idempotency_key, resolved_in_doubt: wasInDoubt });
        return true;
      }
    }
    exec.attempts[action.id] = { status: "in_doubt", request_ids: [] };
    this.ledger.append(tx.id, "action_attempted", actor, { action_id: action.id, idempotency_key: action.idempotency_key, target: key });
    try {
      const result = await connector.write(action);
      exec.attempts[action.id] = { status: "written", request_ids: result.request_ids };
      this.ledger.append(tx.id, "action_succeeded", actor, { action_id: action.id, request_ids: result.request_ids });
      return true;
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      // The response was lost or rejected. Reread to learn whether the write landed anyway.
      const message = err instanceof Error ? err.message : String(err);
      const after = await connector.read(action.target).catch(() => null);
      if (after && action.idempotency_strategy !== "none" && !failedPostconditions(after, action.postconditions).length) {
        exec.attempts[action.id] = { status: "written", request_ids: [], error: `response lost (${message}); reread shows the write landed` };
        this.ledger.append(tx.id, "action_succeeded", actor, { action_id: action.id, request_ids: [], resolved_by: "reread", error: message });
        return true;
      }
      const record: AttemptRecord = { status: "failed", request_ids: [], error: message };
      exec.attempts[action.id] = record;
      this.ledger.append(tx.id, "action_failed", actor, { action_id: action.id, error: message });
      return false;
    }
  }

  #buildReceipt(
    tx: Transaction,
    rev: Revision,
    approval: Approval,
    actions: NormalizedAction[],
    final: Record<string, Snapshot>,
    verification: Map<string, Postcondition[]>,
    outcome: Receipt["outcome"],
  ): Receipt {
    const connector = this.#connector(tx.connector);
    const exec = tx.execution!;
    const receiptActions: ReceiptAction[] = actions.map((a) => {
      const failed = verification.get(a.id);
      return {
        id: a.id,
        operation: a.operation,
        target: a.target,
        summary: a.summary,
        idempotency_key: a.idempotency_key,
        idempotency_strategy: a.idempotency_strategy,
        exactly_once: a.idempotency_strategy === "none" ? "not_guaranteed" : "guaranteed",
        recovery_class: a.recovery.class,
        proposed: tx.proposed_params[a.id] ?? null,
        approved: a.params,
        attempted: exec.attempts[a.id] ?? { status: "not_attempted", request_ids: [] },
        actual: pickFields(final[connector.targetKey(a.target)]!, postconditionFields(a.postconditions)),
        verification: failed === undefined ? { status: "not_run", failed: [] } : { status: failed.length ? "failed" : "passed", failed },
      };
    });
    const body: Omit<Receipt, "receipt_hash"> = {
      transaction_id: tx.id,
      revision: rev.number,
      kind: tx.kind,
      outcome,
      payload_hash: approval.payload_hash,
      approval: {
        id: approval.id,
        reviewer: approval.reviewer,
        approved_at: approval.approved_at,
        expires_at: approval.expires_at,
        policy_version: approval.policy_version,
      },
      actions: receiptActions,
      rejected_action_ids: rev.actions.filter((a) => rev.decisions[a.id] === "reject").map((a) => a.id),
      issued_at: this.#now().toISOString(),
      ledger_head: this.ledger.head(),
    };
    return { ...body, receipt_hash: hashOf(body) };
  }

  #settleParent(child: Transaction, outcome: Receipt["outcome"], actor: string): void {
    const parent = this.#txs.get(child.compensates!.transaction_id);
    if (!parent || parent.status !== "compensation_pending") return;
    this.ledger.append(parent.id, "compensation_executed", actor, { compensation_transaction_id: child.id, outcome });
    if (outcome === "verified") {
      this.ledger.append(parent.id, "compensation_verified", actor, { compensation_transaction_id: child.id });
      this.#transition(parent, "compensated", actor);
    } else {
      this.ledger.append(parent.id, "compensation_failed", actor, { compensation_transaction_id: child.id, outcome });
      this.#transition(parent, "compensation_failed", actor);
    }
  }

  #settleParentIfAbandoned(child: Transaction, actor: string): void {
    if (!child.compensates) return;
    const parent = this.#txs.get(child.compensates.transaction_id);
    if (!parent || parent.status !== "compensation_pending") return;
    this.ledger.append(parent.id, "compensation_failed", actor, { compensation_transaction_id: child.id, outcome: child.status });
    this.#transition(parent, "compensation_failed", actor);
  }

  #expireIfDue(tx: Transaction): boolean {
    if (tx.status === "expired") return true;
    if (!tx.expires_at || !OPEN_FOR_REVIEW.includes(tx.status)) return false;
    if (this.#now().getTime() < Date.parse(tx.expires_at)) return false;
    this.#invalidateApprovals(tx, "clock", "transaction expired");
    this.#transition(tx, "expired", "clock");
    this.#settleParentIfAbandoned(tx, "clock");
    return true;
  }

  #invalidateApprovals(tx: Transaction, actor: string, reason: string): void {
    for (const a of tx.approvals) {
      if (a.status !== "active") continue;
      a.status = "invalidated";
      this.ledger.append(tx.id, "approval_invalidated", actor, { approval_id: a.id, reason });
    }
  }

  #openForReview(id: string): Transaction {
    const tx = this.#tx(id);
    if (this.#expireIfDue(tx)) throw new EngineError("transaction_expired", `transaction ${id} expired`);
    if (!OPEN_FOR_REVIEW.includes(tx.status)) throw new EngineError("invalid_state", `transaction ${id} is ${tx.status}; it can no longer be changed`);
    return tx;
  }

  #transition(tx: Transaction, to: TxStatus, actor: string): void {
    assertTransition(tx.status, to);
    const from = tx.status;
    tx.status = to;
    this.ledger.append(tx.id, "status_changed", actor, { from, to });
  }

  async #readAll(connector: Connector, actions: NormalizedAction[]): Promise<Record<string, Snapshot>> {
    const out: Record<string, Snapshot> = {};
    for (const a of actions) {
      const key = connector.targetKey(a.target);
      out[key] ??= await connector.read(a.target);
    }
    return out;
  }

  #included(rev: Revision): NormalizedAction[] {
    return rev.actions.filter((a) => rev.decisions[a.id] !== "reject");
  }

  #ordered(tx: Transaction, rev: Revision): NormalizedAction[] {
    const included = this.#included(rev);
    const order = this.#topoOrder(included, tx.dependencies);
    return order.map((id) => included.find((a) => a.id === id)!);
  }

  /** Kahn's algorithm, ties broken by submission order. Dependencies on excluded actions are ignored. */
  #topoOrder(actions: ReadonlyArray<{ id: string }>, deps: Dependency[]): string[] {
    const ids = actions.map((a) => a.id);
    const present = new Set(ids);
    const indegree = new Map(ids.map((id) => [id, 0]));
    const edges = deps.filter((d) => present.has(d.before) && present.has(d.after));
    for (const d of edges) indegree.set(d.after, indegree.get(d.after)! + 1);
    const out: string[] = [];
    const ready = ids.filter((id) => indegree.get(id) === 0);
    while (ready.length) {
      const id = ready.shift()!;
      out.push(id);
      for (const d of edges.filter((e) => e.before === id)) {
        indegree.set(d.after, indegree.get(d.after)! - 1);
        if (indegree.get(d.after) === 0) {
          ready.push(d.after);
          ready.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
        }
      }
    }
    if (out.length !== ids.length) throw new EngineError("invalid_change_set", "dependencies contain a cycle");
    return out;
  }

  #tx(id: string): Transaction {
    const tx = this.#txs.get(id);
    if (!tx) throw new EngineError("not_found", `transaction ${id} not found`);
    return tx;
  }

  #connector(id: string): Connector {
    const c = this.#connectors.get(id);
    if (!c) throw new EngineError("unknown_connector", `no connector named ${id}`);
    return c;
  }
}

function latest(tx: Transaction): Revision {
  return tx.revisions.at(-1)!;
}

function toInput(a: NormalizedAction): ActionInput {
  return { id: a.id, operation: a.operation, target: a.target, params: a.params, ...(a.rationale !== undefined ? { rationale: a.rationale } : {}) };
}

function postconditionFields(ps: readonly Postcondition[]): SnapshotField[] {
  return [...new Set(ps.map((p) => p.field))];
}
