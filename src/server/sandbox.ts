import { followUpChangeSet, SEED_ISSUES, triageChangeSet, type SeedIssue } from "../demo/fixture.ts";
import { Engine } from "../engine.ts";
import { EngineError } from "../errors.ts";
import { GitHubIssuesConnector } from "../github/connector.ts";
import { MemoryGitHub } from "../github/memory.ts";
import type { ChangeSetInput } from "../types.ts";

export type SandboxControl = "drift" | "client-retry" | "outage" | "fast-forward" | "follow-up" | "reset";

export interface ControlResult {
  message: string;
  writes?: number;
}

const OWNER = "acme";
const REPO = "widgets";
const ASSIGNEE = "maintainer";

/**
 * An offline world for the review UI: an in-memory GitHub seeded with the demo
 * issues, an engine with a clock that can be fast-forwarded, and controls that
 * simulate what happens outside the reviewer's control (a teammate's edit, a
 * client retry, an outage). Everything the controls do is labeled as simulation.
 */
export class Sandbox {
  gh!: MemoryGitHub;
  engine!: Engine;
  #offsetMs = 0;
  #submitted = new Map<string, ChangeSetInput>();
  #numbers = {} as Record<SeedIssue["key"], number>;

  constructor() {
    this.reset();
  }

  get outage(): boolean {
    return this.gh.outage !== undefined;
  }

  get clockOffsetMinutes(): number {
    return Math.round(this.#offsetMs / 60_000);
  }

  reset(): void {
    this.gh = new MemoryGitHub();
    this.gh.addRepo(OWNER, REPO, [ASSIGNEE, "priya"]);
    [184, 207, 191, 195].forEach((n, i) => {
      const s = SEED_ISSUES[i]!;
      this.gh.seedIssue(OWNER, REPO, { number: n, title: s.title, labels: s.labels });
      this.#numbers[s.key] = n;
    });
    this.#offsetMs = 0;
    this.#submitted.clear();
    this.engine = new Engine({
      connectors: [new GitHubIssuesConnector(this.gh)],
      now: () => new Date(Date.now() + this.#offsetMs),
    });
  }

  /** Submits the seeded 12-action triage change set, as the demo agent would. */
  async seed(): Promise<void> {
    await this.#submit(triageChangeSet(OWNER, REPO, this.#numbers, { owner: ASSIGNEE, unassignable: "alex" }));
  }

  async control(control: SandboxControl, txId?: string): Promise<ControlResult> {
    switch (control) {
      case "reset":
        this.reset();
        await this.seed();
        return { message: "Sandbox reset to the seeded triage change set." };
      case "outage":
        this.gh.outage = this.gh.outage ? undefined : Object.assign(new TypeError("fetch failed"), { cause: "simulated outage" });
        return { message: this.gh.outage ? "GitHub is now unreachable (simulated)." : "GitHub is reachable again." };
      case "fast-forward":
        this.#offsetMs += 31 * 60_000;
        return { message: "Clock moved forward 31 minutes. Open approvals have expired." };
      case "follow-up": {
        const cs = followUpChangeSet(OWNER, REPO, this.#numbers.crash, ASSIGNEE);
        if (this.#submitted.has(cs.transaction_id)) return { message: `${cs.transaction_id} was already submitted.` };
        await this.#submit(cs);
        return { message: `Agent submitted ${cs.transaction_id}.` };
      }
      case "drift":
        return this.#drift(this.#requireTx(txId));
      case "client-retry":
        return this.#clientRetry(this.#requireTx(txId));
    }
  }

  async #submit(cs: ChangeSetInput): Promise<void> {
    await this.engine.submit(cs);
    this.#submitted.set(cs.transaction_id, cs);
  }

  /** A teammate edits, outside the engine, a field the transaction's first included action depends on. */
  #drift(txId: string): ControlResult {
    const tx = this.engine.get(txId);
    const rev = tx.revisions.at(-1)!;
    const action = rev.actions.find((a) => rev.decisions[a.id] !== "reject" && Object.keys(a.precondition).length > 0);
    if (!action) return { message: "No included action depends on target state, so there is nothing to drift." };
    const { owner, repo, number } = action.target;
    const field = Object.keys(action.precondition)[0];
    this.gh.mutate(owner, repo, number, (issue) => {
      if (field === "title") issue.title = `${issue.title} (edited)`;
      else if (field === "labels") issue.labels.push("p1");
      else if (field === "assignees") issue.assignees = issue.assignees.includes("priya") ? issue.assignees.filter((a) => a !== "priya") : [...issue.assignees, "priya"];
      else if (field === "state") issue.state = issue.state === "open" ? "closed" : "open";
    });
    return { message: `A teammate changed ${field} on ${owner}/${repo}#${number} in the GitHub UI (simulated).` };
  }

  /** The agent's client lost the response, so it resubmits the change set and retries the commit. */
  async #clientRetry(txId: string): Promise<ControlResult> {
    const tx = this.engine.get(txId);
    const approval = tx.receipt ? tx.approvals.find((a) => a.id === tx.receipt!.approval.id) : undefined;
    if (!approval) return { message: "Nothing has been committed yet, so there is nothing to retry." };
    const before = this.gh.writes.length;
    const cs = this.#submitted.get(txId);
    const resubmitted = cs ? await this.engine.submit(cs) : undefined;
    const result = await this.engine.commit(txId, approval.id, "agent-client");
    const writes = this.gh.writes.length - before;
    const parts = [
      resubmitted ? (resubmitted.deduplicated ? "Resubmission recognized by payload hash." : "Resubmission created a new transaction.") : "",
      result.outcome === "committed" && result.replayed ? "Commit retry returned the original receipt." : "Commit retry re-executed.",
      `GitHub writes caused by the retry: ${writes}.`,
    ];
    return { message: parts.filter(Boolean).join(" "), writes };
  }

  #requireTx(txId: string | undefined): string {
    if (!txId) throw new EngineError("not_found", "this control needs a transaction");
    return txId;
  }
}
