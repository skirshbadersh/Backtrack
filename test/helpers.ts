import { Engine } from "../src/engine.ts";
import { GitHubIssuesConnector } from "../src/github/connector.ts";
import { MemoryGitHub } from "../src/github/memory.ts";
import { SCHEMA_VERSION, type ActionInput, type ChangeSetInput, type IssueRef } from "../src/types.ts";

export const OWNER = "acme";
export const REPO = "widgets";

export function issue(number: number): IssueRef {
  return { kind: "github.issue", owner: OWNER, repo: REPO, number };
}

export class FakeClock {
  t = Date.parse("2026-10-11T12:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export function setup(opts: { approvalTtlMs?: number } = {}) {
  const gh = new MemoryGitHub();
  gh.addRepo(OWNER, REPO, ["maintainer", "priya"]);
  gh.seedIssue(OWNER, REPO, { number: 1, title: "crash on save", labels: ["needs-triage"] });
  gh.seedIssue(OWNER, REPO, { number: 2, title: "dup?", labels: ["needs-triage"] });
  gh.seedIssue(OWNER, REPO, { number: 3, title: "slow", labels: [], assignees: ["priya"] });
  const clock = new FakeClock();
  const engine = new Engine({ connectors: [new GitHubIssuesConnector(gh)], now: clock.now, ...opts });
  return { gh, engine, clock };
}

export function changeSet(actions: ActionInput[], overrides: Partial<ChangeSetInput> = {}): ChangeSetInput {
  return {
    schema_version: SCHEMA_VERSION,
    transaction_id: "tx-1",
    workspace_id: "ws-test",
    source_agent: "test-agent",
    initiator: "@maintainer",
    requested_outcome: "test outcome",
    connector: "github",
    actions,
    ...overrides,
  };
}

/** A small mixed batch: title, label add/remove, assignee, comment, close (comment before close). */
export function mixedChangeSet(overrides: Partial<ChangeSetInput> = {}): ChangeSetInput {
  return changeSet(
    [
      { id: "t", operation: "issue.update_title", target: issue(1), params: { title: "Crash on save" } },
      { id: "ladd", operation: "issue.add_labels", target: issue(1), params: { labels: ["bug"] } },
      { id: "lrm", operation: "issue.remove_labels", target: issue(1), params: { labels: ["needs-triage"] } },
      { id: "as", operation: "issue.add_assignees", target: issue(1), params: { assignees: ["maintainer"] } },
      { id: "c", operation: "issue.add_comment", target: issue(2), params: { body: "Closing as duplicate of #1" } },
      { id: "x", operation: "issue.set_state", target: issue(2), params: { state: "closed", state_reason: "not_planned" } },
    ],
    { dependencies: [{ before: "c", after: "x" }], ...overrides },
  );
}

export async function approveAndCommit(engine: Engine, id: string, reviewer = "@rev") {
  const approval = engine.approve(id, reviewer);
  return { approval, result: await engine.commit(id, approval.id) };
}
