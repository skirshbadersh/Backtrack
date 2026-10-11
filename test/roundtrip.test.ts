import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GITHUB_OPERATIONS } from "../src/github/operations.ts";
import type { ActionInput } from "../src/types.ts";
import { OWNER, REPO, approveAndCommit, changeSet, issue, setup } from "./helpers.ts";

/**
 * PRD: every operation advertised as reversible must pass an automated
 * round-trip test before it ships. Apply the action, compensate it through the
 * normal review flow, and require the target to be back in its prior state.
 */
const CASES: ActionInput[] = [
  { id: "a", operation: "issue.update_title", target: issue(1), params: { title: "Renamed" } },
  { id: "a", operation: "issue.add_labels", target: issue(1), params: { labels: ["bug", "needs-triage"] } },
  { id: "a", operation: "issue.remove_labels", target: issue(1), params: { labels: ["needs-triage"] } },
  { id: "a", operation: "issue.add_assignees", target: issue(3), params: { assignees: ["maintainer"] } },
  { id: "a", operation: "issue.remove_assignees", target: issue(3), params: { assignees: ["priya"] } },
  { id: "a", operation: "issue.set_state", target: issue(2), params: { state: "closed", state_reason: "not_planned" } },
];

describe("reversible round trips", () => {
  for (const input of CASES) {
    it(`${input.operation} ${JSON.stringify(input.params)} round-trips`, async () => {
      const { engine, gh } = setup();
      const before = await gh.getIssue(OWNER, REPO, input.target.number);
      await engine.submit(changeSet([input]));
      const { result } = await approveAndCommit(engine, "tx-1");
      assert.ok(result.outcome === "committed" && result.receipt.outcome === "verified");
      assert.notDeepEqual(await gh.getIssue(OWNER, REPO, input.target.number), before);

      const { transaction: comp } = await engine.proposeCompensation("tx-1", ["a"], "@rev");
      const { result: undone } = await approveAndCommit(engine, comp.id);
      assert.ok(undone.outcome === "committed" && undone.receipt.outcome === "verified");
      const after = await gh.getIssue(OWNER, REPO, input.target.number);
      assert.deepEqual({ ...after, state_reason: null }, { ...before, state_reason: null });
    });
  }

  it("covers every operation the connector advertises as reversible", () => {
    const reversible = [...GITHUB_OPERATIONS.values()]
      .filter((op) => op.recovery({ state: "closed", title: "x", labels: ["x"], assignees: ["x"], body: "x" }).class === "reversible")
      .map((op) => op.name)
      .sort();
    assert.deepEqual(reversible, [...new Set(CASES.map((c) => c.operation))].sort());
  });

  it("compensates only what the action changed", async () => {
    const { engine, gh } = setup();
    await engine.submit(changeSet([{ id: "a", operation: "issue.add_labels", target: issue(1), params: { labels: ["bug", "needs-triage"] } }]));
    await approveAndCommit(engine, "tx-1");
    const { transaction: comp } = await engine.proposeCompensation("tx-1", ["a"], "@rev");
    assert.deepEqual(comp.revisions[0]!.actions[0]!.params, { labels: ["bug"] }, "needs-triage was there before and stays");
    await approveAndCommit(engine, comp.id);
    assert.deepEqual((await gh.getIssue(OWNER, REPO, 1)).labels, ["needs-triage"]);
  });
});
