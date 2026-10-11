import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimulatedCrash } from "../src/engine.ts";
import { EngineError } from "../src/errors.ts";
import { GitHubHttpError } from "../src/github/transport.ts";
import { Ledger } from "../src/ledger.ts";
import { OWNER, REPO, approveAndCommit, changeSet, issue, mixedChangeSet, setup } from "./helpers.ts";

const code = (c: string) => (err: unknown) => err instanceof EngineError && err.code === c;

describe("intake and validation (fail closed)", () => {
  it("rejects unknown schema versions, unknown fields and unknown operations without storing anything", async () => {
    const { engine, gh } = setup();
    await assert.rejects(engine.submit({ ...mixedChangeSet(), schema_version: "2099-01-01" }), code("invalid_change_set"));
    await assert.rejects(engine.submit({ ...mixedChangeSet(), dry_run: true }), code("invalid_change_set"));
    await assert.rejects(
      engine.submit(changeSet([{ id: "a", operation: "issue.delete", target: issue(1), params: {} }])),
      code("unknown_operation"),
    );
    await assert.rejects(
      engine.submit(changeSet([{ id: "a", operation: "issue.update_title", target: issue(1), params: { title: "x", force: true } }])),
      code("invalid_change_set"),
    );
    assert.equal(engine.list().length, 0);
    assert.equal(gh.writes.length, 0);
  });

  it("rejects dependency cycles and actions that undo each other", async () => {
    const { engine } = setup();
    const cyclic = mixedChangeSet({ dependencies: [{ before: "c", after: "x" }, { before: "x", after: "c" }] });
    await assert.rejects(engine.submit(cyclic), code("invalid_change_set"));
    const contradictory = changeSet([
      { id: "a", operation: "issue.add_labels", target: issue(1), params: { labels: ["bug"] } },
      { id: "b", operation: "issue.remove_labels", target: issue(1), params: { labels: ["bug"] } },
    ]);
    await assert.rejects(engine.submit(contradictory), code("contradictory_actions"));
  });

  it("deduplicates an identical resubmission and refuses a reused id with a different payload", async () => {
    const { engine } = setup();
    const first = await engine.submit(mixedChangeSet());
    const again = await engine.submit(mixedChangeSet());
    assert.equal(first.deduplicated, false);
    assert.equal(again.deduplicated, true);
    assert.equal(engine.list().length, 1);
    await assert.rejects(engine.submit(mixedChangeSet({ requested_outcome: "something else" })), code("transaction_conflict"));
  });

  it("captures preconditions and declares postconditions for every action", async () => {
    const { engine } = setup();
    const { transaction } = await engine.submit(mixedChangeSet());
    for (const a of transaction.revisions[0]!.actions) {
      assert.ok(a.postconditions.length > 0, `${a.id} has postconditions`);
      assert.equal(a.idempotency_key.length, 64);
    }
    const title = transaction.revisions[0]!.actions.find((a) => a.id === "t")!;
    assert.deepEqual(title.precondition, { title: "crash on save" });
  });
});

describe("approval binding (G3)", () => {
  it("editing any action after approval invalidates the approval; nothing executes", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    await engine.editAction("tx-1", "t", { title: "Something else" }, "@rev");
    await assert.rejects(engine.commit("tx-1", approval.id), code("approval_invalid"));
    assert.equal(gh.writes.length, 0);
    assert.equal(engine.get("tx-1").status, "pending_review");
  });

  it("rejecting an item after approval invalidates the approval too", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    await engine.rejectAction("tx-1", "x", "@rev");
    await assert.rejects(engine.commit("tx-1", approval.id), code("approval_invalid"));
    assert.equal(gh.writes.length, 0);
  });

  it("an expired approval cannot execute and the transaction returns to review", async () => {
    const { engine, gh, clock } = setup({ approvalTtlMs: 60_000 });
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    clock.advance(60_001);
    await assert.rejects(engine.commit("tx-1", approval.id), code("approval_expired"));
    assert.equal(gh.writes.length, 0);
    assert.equal(engine.get("tx-1").status, "pending_review");
    const fresh = engine.approve("tx-1", "@rev");
    const result = await engine.commit("tx-1", fresh.id);
    assert.equal(result.outcome, "committed");
  });

  it("an approval never outlives the change set's own expires_at", async () => {
    const { engine, clock } = setup();
    await engine.submit(mixedChangeSet({ expires_at: new Date(clock.t + 10_000).toISOString() }));
    const approval = engine.approve("tx-1", "@rev");
    assert.equal(approval.expires_at, new Date(clock.t + 10_000).toISOString());
    clock.advance(10_000);
    await assert.rejects(engine.commit("tx-1", approval.id), code("transaction_expired"));
    assert.equal(engine.get("tx-1").status, "expired");
  });

  it("refuses to approve a revision the reviewer was not looking at", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await engine.rejectAction("tx-1", "c", "@other");
    assert.throws(() => engine.approve("tx-1", "@rev", { revision: 1 }), code("stale_revision"));
  });

  it("binds the hash of exactly the included actions and records it in the receipt", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await engine.rejectAction("tx-1", "x", "@rev");
    const { approval, result } = await approveAndCommit(engine, "tx-1");
    assert.equal(result.outcome, "committed");
    if (result.outcome !== "committed") return;
    assert.deepEqual(approval.approved_action_ids, ["t", "ladd", "lrm", "as", "c"]);
    assert.equal(result.receipt.payload_hash, approval.payload_hash);
    assert.equal(result.receipt.approval.reviewer, "@rev");
    assert.deepEqual(result.receipt.rejected_action_ids, ["x"]);
  });
});

describe("stale-state gate (G4)", () => {
  const drifts: Array<[string, (gh: ReturnType<typeof setup>["gh"]) => void]> = [
    ["title", (gh) => gh.mutate(OWNER, REPO, 1, (i) => (i.title = "renamed by a human"))],
    ["labels", (gh) => gh.mutate(OWNER, REPO, 1, (i) => i.labels.push("p1"))],
    ["assignees", (gh) => gh.mutate(OWNER, REPO, 1, (i) => i.assignees.push("priya"))],
    ["state", (gh) => gh.mutate(OWNER, REPO, 2, (i) => (i.state = "closed"))],
  ];
  for (const [field, drift] of drifts) {
    it(`a change to ${field} after approval stops everything before any write`, async () => {
      const { engine, gh } = setup();
      await engine.submit(mixedChangeSet());
      const approval = engine.approve("tx-1", "@rev");
      drift(gh);
      const result = await engine.commit("tx-1", approval.id);
      assert.equal(result.outcome, "conflicted");
      if (result.outcome === "conflicted") assert.ok(result.conflicts.some((c) => c.field === field));
      assert.equal(gh.writes.length, 0);
      assert.equal(engine.get("tx-1").status, "conflicted");
      await assert.rejects(engine.commit("tx-1", approval.id), code("approval_invalid"));
    });
  }

  it("rebase re-reads, requires a new approval, then commits against the new state", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    gh.mutate(OWNER, REPO, 1, (i) => i.labels.push("p1"));
    await engine.commit("tx-1", approval.id);
    await engine.rebase("tx-1", "@rev");
    const { result } = await approveAndCommit(engine, "tx-1");
    assert.equal(result.outcome, "committed");
    if (result.outcome === "committed") assert.equal(result.receipt.outcome, "verified");
    assert.deepEqual((await gh.getIssue(OWNER, REPO, 1)).labels, ["bug", "p1"]);
  });
});

describe("exactly-once commit (G8)", () => {
  it("a repeated commit returns the original receipt and writes nothing", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const { approval, result } = await approveAndCommit(engine, "tx-1");
    const writes = gh.writes.length;
    const again = await engine.commit("tx-1", approval.id);
    const third = await engine.commit("tx-1", approval.id);
    assert.equal(gh.writes.length, writes);
    assert.ok(again.outcome === "committed" && again.replayed && third.outcome === "committed" && third.replayed);
    if (result.outcome === "committed" && again.outcome === "committed") assert.equal(again.receipt.receipt_hash, result.receipt.receipt_hash);
    assert.equal(gh.comments(OWNER, REPO, 2).length, 1);
  });

  it("resuming after the executor crashed mid-run never repeats a write", async () => {
    for (let crashAt = 1; crashAt <= 6; crashAt++) {
      const { engine, gh } = setup();
      await engine.submit(mixedChangeSet());
      const approval = engine.approve("tx-1", "@rev");
      gh.afterWrite = () => {
        if (gh.writes.length === crashAt) throw new SimulatedCrash(`died after write ${crashAt}`);
      };
      await assert.rejects(engine.commit("tx-1", approval.id), SimulatedCrash);
      assert.equal(engine.get("tx-1").status, "executing");
      gh.afterWrite = undefined;
      const resumed = await engine.commit("tx-1", approval.id);
      assert.equal(resumed.outcome, "committed", `crashAt=${crashAt}`);
      if (resumed.outcome === "committed") assert.equal(resumed.receipt.outcome, "verified", `crashAt=${crashAt}`);
      assert.equal(gh.writes.length, 6, `crashAt=${crashAt}: one write per action`);
      assert.equal(gh.comments(OWNER, REPO, 2).length, 1, `crashAt=${crashAt}: comment posted once`);
    }
  });

  it("a lost response is resolved by reread instead of a blind retry", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    gh.afterWrite = (w) => {
      if (w.path.endsWith("/comments")) throw new Error("socket hang up");
    };
    const result = await engine.commit("tx-1", approval.id);
    assert.equal(result.outcome, "committed");
    if (result.outcome === "committed") {
      assert.equal(result.receipt.outcome, "verified");
      assert.match(result.receipt.actions.find((a) => a.id === "c")!.attempted.status, /written/);
    }
    assert.equal(gh.comments(OWNER, REPO, 2).length, 1);
  });

  it("a resumed run refuses to continue if someone else changed a pending target meanwhile", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    gh.afterWrite = () => {
      if (gh.writes.length === 1) throw new SimulatedCrash();
    };
    await assert.rejects(engine.commit("tx-1", approval.id), SimulatedCrash);
    gh.afterWrite = undefined;
    gh.mutate(OWNER, REPO, 2, (i) => (i.state = "closed"));
    const result = await engine.commit("tx-1", approval.id);
    assert.equal(result.outcome, "committed");
    if (result.outcome === "committed") assert.equal(result.receipt.outcome, "partially_executed");
  });

  it("concurrent commits of the same approval execute once", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    const [a, b] = await Promise.allSettled([engine.commit("tx-1", approval.id), engine.commit("tx-1", approval.id)]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected");
    assert.equal(gh.writes.length, 6);
  });
});

describe("execution", () => {
  it("runs actions in dependency order", async () => {
    const { engine, gh } = setup();
    await engine.submit(
      changeSet(
        [
          { id: "close", operation: "issue.set_state", target: issue(2), params: { state: "closed" } },
          { id: "comment", operation: "issue.add_comment", target: issue(2), params: { body: "closing" } },
        ],
        { dependencies: [{ before: "comment", after: "close" }] },
      ),
    );
    await approveAndCommit(engine, "tx-1");
    assert.deepEqual(gh.writes.map((w) => w.method), ["POST", "PATCH"]);
  });

  it("stops at the first rejected write and reports partial execution", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    const approval = engine.approve("tx-1", "@rev");
    gh.beforeWrite = (w) => {
      if (w.path.endsWith("/assignees")) throw new GitHubHttpError(403, "Resource not accessible by integration");
    };
    const result = await engine.commit("tx-1", approval.id);
    assert.equal(result.outcome, "committed");
    if (result.outcome !== "committed") return;
    assert.equal(result.receipt.outcome, "partially_executed");
    const status = Object.fromEntries(result.receipt.actions.map((a) => [a.id, a.attempted.status]));
    assert.deepEqual(status, { t: "written", "ladd": "written", "lrm": "written", as: "failed", c: "not_attempted", x: "not_attempted" });
    assert.equal(engine.get("tx-1").status, "partially_executed");
  });

  it("skips a write whose effect is already present instead of repeating it", async () => {
    const { engine, gh } = setup();
    await engine.submit(changeSet([{ id: "a", operation: "issue.add_assignees", target: issue(3), params: { assignees: ["@Priya"] } }]));
    const { result } = await approveAndCommit(engine, "tx-1");
    assert.equal(gh.writes.length, 0);
    if (result.outcome === "committed") assert.equal(result.receipt.actions[0]!.attempted.status, "already_applied");
  });
});

describe("postcondition verification (G5)", () => {
  it("a 2xx write that GitHub silently dropped lands in verification_failed", async () => {
    const { engine } = setup();
    await engine.submit(changeSet([{ id: "a", operation: "issue.add_assignees", target: issue(1), params: { assignees: ["alex"] } }]));
    const { result } = await approveAndCommit(engine, "tx-1");
    assert.equal(result.outcome, "committed");
    if (result.outcome !== "committed") return;
    assert.equal(result.receipt.outcome, "verification_failed");
    const a = result.receipt.actions[0]!;
    assert.equal(a.attempted.status, "written");
    assert.deepEqual(a.actual, { assignees: [] });
    assert.deepEqual(a.verification.failed, [{ field: "assignees", op: "includes", value: "alex" }]);
    assert.equal(engine.get("tx-1").status, "verification_failed");
  });

  it("verification rereads the target rather than trusting the write response", async () => {
    const { engine, gh } = setup();
    await engine.submit(changeSet([{ id: "a", operation: "issue.update_title", target: issue(1), params: { title: "New" } }]));
    // The API "succeeds" but something (a bot, a webhook) immediately reverts the title.
    gh.afterWrite = () => gh.mutate(OWNER, REPO, 1, (i) => (i.title = "crash on save"));
    const { result } = await approveAndCommit(engine, "tx-1");
    if (result.outcome === "committed") assert.equal(result.receipt.outcome, "verification_failed");
    else assert.fail("expected a receipt");
  });
});

describe("reviewable compensation (G6)", () => {
  it("creates a separate transaction that waits for review and states residual effects", async () => {
    const { engine, gh } = setup();
    await engine.submit(mixedChangeSet());
    await approveAndCommit(engine, "tx-1");
    const writes = gh.writes.length;
    const { transaction: comp } = await engine.proposeCompensation("tx-1", ["t", "c", "x"], "@rev");
    assert.equal(comp.kind, "compensation");
    assert.equal(comp.status, "pending_review");
    assert.equal(gh.writes.length, writes, "proposing compensation writes nothing");
    assert.equal(engine.get("tx-1").status, "compensation_pending");
    const actions = comp.revisions[0]!.actions;
    assert.ok(actions.find((a) => a.id === "undo-c")!.recovery.residue.some((r) => /original comment stays visible/.test(r)));
    assert.ok(actions.find((a) => a.id === "undo-x")!.recovery.residue.some((r) => /notifications were already delivered/.test(r)));
    const { result } = await approveAndCommit(engine, comp.id);
    if (result.outcome === "committed") assert.equal(result.receipt.outcome, "verified");
    assert.equal(engine.get("tx-1").status, "compensated");
    assert.equal((await gh.getIssue(OWNER, REPO, 2)).state, "open");
  });

  it("a rejected compensation marks the original compensation_failed so it can be retried", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await approveAndCommit(engine, "tx-1");
    const { transaction: comp } = await engine.proposeCompensation("tx-1", ["t"], "@rev");
    engine.rejectTransaction(comp.id, "@rev", "changed my mind");
    assert.equal(engine.get("tx-1").status, "compensation_failed");
    const { transaction: retry } = await engine.proposeCompensation("tx-1", ["t"], "@rev");
    assert.equal(retry.id, "tx-1.c2");
  });

  it("refuses to compensate actions that never executed", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await engine.rejectAction("tx-1", "x", "@rev");
    await approveAndCommit(engine, "tx-1");
    await assert.rejects(engine.proposeCompensation("tx-1", ["x"], "@rev"), code("not_compensatable"));
  });
});

describe("ledger", () => {
  it("records every lifecycle step in a hash chain that detects tampering", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await approveAndCommit(engine, "tx-1");
    const events = engine.ledger.list();
    const types = new Set(events.map((e) => e.type));
    for (const t of ["submitted", "hydrated", "approval_created", "precondition_passed", "execution_started", "action_attempted", "action_succeeded", "verification_passed", "receipt_issued"] as const) {
      assert.ok(types.has(t), `ledger has ${t}`);
    }
    assert.equal(Ledger.verify(events), null);
    const tampered = events.map((e) => (e.seq === 5 ? { ...e, actor: "@someone-else" } : e));
    assert.equal(Ledger.verify(tampered), 5);
    assert.throws(() => {
      (events[0] as { actor: string }).actor = "x";
    });
  });

  it("every status change is an event", async () => {
    const { engine } = setup();
    await engine.submit(mixedChangeSet());
    await approveAndCommit(engine, "tx-1");
    const path = engine.ledger.list("tx-1").filter((e) => e.type === "status_changed").map((e) => e.data.to);
    assert.deepEqual(path, ["pending_review", "approved", "queued", "executing", "verified"]);
  });
});

describe("risk model", () => {
  it("closing is high, comments and assignments are medium, metadata edits are low", async () => {
    const { engine } = setup();
    const { transaction } = await engine.submit(mixedChangeSet());
    const risk = Object.fromEntries(transaction.revisions[0]!.actions.map((a) => [a.id, a.risk.level]));
    assert.deepEqual(risk, { t: "low", "ladd": "low", "lrm": "low", as: "medium", c: "medium", x: "high" });
    assert.equal(engine.transactionRisk(transaction).level, "high");
  });

  it("more than 10 objects raises the transaction to high with an explicit batch factor", async () => {
    const { engine, gh } = setup();
    for (let n = 10; n < 21; n++) gh.seedIssue(OWNER, REPO, { number: n, title: `issue ${n}` });
    const actions = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, operation: "issue.add_labels", target: issue(10 + i), params: { labels: ["x"] } }));
    const { transaction } = await engine.submit(changeSet(actions));
    const risk = engine.transactionRisk(transaction);
    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some((f) => /11 objects/.test(f)));
  });
});
