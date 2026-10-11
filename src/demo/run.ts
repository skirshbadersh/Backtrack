import { Engine } from "../engine.ts";
import { GitHubIssuesConnector } from "../github/connector.ts";
import { MemoryGitHub } from "../github/memory.ts";
import type { GitHubTransport } from "../github/transport.ts";
import { Ledger } from "../ledger.ts";
import { renderConflicts, renderInbox, renderReceipt, renderReview, style } from "../render.ts";
import { countingTransport } from "./counting.ts";
import { SEED_ISSUES, followUpChangeSet, triageChangeSet, type SeedIssue } from "./fixture.ts";

export interface DemoOptions {
  /** A live transport against a disposable repository; omit for the in-memory simulation. */
  live?: { transport: GitHubTransport; owner: string; repo: string; assignee: string };
  unassignable?: string;
  reviewer?: string;
  log?: (line: string) => void;
}

export interface DemoResult {
  engine: Engine;
  outcomes: Record<string, string>;
  duplicateWrites: number;
  conflictWritesBeforeStop: number;
  ledgerIntact: boolean;
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const reviewer = options.reviewer ?? "@reviewer";
  const unassignable = options.unassignable ?? "alex";
  const beat = (n: number, title: string) => log(`\n${style.accent("━".repeat(78))}\n${style.bold(`${n}. ${title}`)}\n`);
  const note = (s: string) => log(style.dim(s));

  // ---- setup: a disposable repo (live) or the in-memory GitHub simulation
  let raw: GitHubTransport;
  let owner: string;
  let repo: string;
  let assignee: string;
  const numbers = {} as Record<SeedIssue["key"], number>;
  if (options.live) {
    ({ transport: raw, owner, repo, assignee } = options.live);
    note(`Seeding ${SEED_ISSUES.length} issues in ${owner}/${repo} (setup, not routed through the engine)…`);
    for (const s of SEED_ISSUES) numbers[s.key] = (await raw.createIssue(owner, repo, { title: s.title, body: s.body, labels: s.labels })).number;
  } else {
    owner = "acme";
    repo = "widgets";
    assignee = "maintainer";
    const mem = new MemoryGitHub();
    mem.addRepo(owner, repo, [assignee, "priya"]);
    [184, 207, 191, 195].forEach((n, i) => {
      const s = SEED_ISSUES[i]!;
      mem.seedIssue(owner, repo, { number: n, title: s.title, labels: s.labels });
      numbers[s.key] = n;
    });
    raw = mem;
    note("Running against the in-memory GitHub simulation. Pass --repo owner/name to use a disposable real repository.");
  }
  const { transport, writes } = countingTransport(raw);
  const engine = new Engine({ connectors: [new GitHubIssuesConnector(transport)] });
  const changeSet = triageChangeSet(owner, repo, numbers, { owner: assignee, unassignable });
  const outcomes: Record<string, string> = {};

  // ---- 1. open the transaction
  beat(1, "An agent proposes 12 changes. Review them as one transaction.");
  const { transaction } = await engine.submit(changeSet);
  log(renderInbox(engine.list()));
  log("");
  log(renderReview(transaction, engine.transactionRisk(transaction), engine.preview(transaction.id)));
  note(`\nThe dangerous action is a8: closing #${numbers.dup} as a duplicate. The evidence is a similarity score, and the issue bodies describe different bugs.`);

  // ---- 2. edit, reject, commit the rest
  beat(2, "Edit one title, reject three actions, commit the rest.");
  await engine.editAction(transaction.id, "a1", { title: "Crash when saving a file with a non-ASCII name" }, reviewer);
  for (const id of ["a5", "a7", "a8"]) await engine.rejectAction(transaction.id, id, reviewer, "planted mistake");
  const reviewed = engine.get(transaction.id);
  log(renderReview(reviewed, engine.transactionRisk(reviewed), engine.preview(reviewed.id)));
  const approval = engine.approve(transaction.id, reviewer, { revision: reviewed.revisions.at(-1)!.number });
  log(`\n${style.bold("Commit approved changes")}  ${style.dim(`approval ${approval.id} binds payload ${approval.payload_hash.slice(0, 16)}… until ${approval.expires_at}`)}`);
  const writesBefore = writes();
  const first = await engine.commit(transaction.id, approval.id);
  if (first.outcome !== "committed") throw new Error("unexpected conflict in beat 2");
  log(`Committed ${first.receipt.actions.length} actions with ${writes() - writesBefore} GitHub writes.`);

  // ---- 3. exactly-once under retry
  beat(3, "The agent's client timed out, so it retries everything.");
  const writesBeforeRetry = writes();
  const resubmit = await engine.submit(changeSet);
  const retry = await engine.commit(transaction.id, approval.id);
  const duplicateWrites = writes() - writesBeforeRetry;
  log(`Resubmitted change set → ${resubmit.deduplicated ? "recognized by payload hash, same transaction" : "NEW TRANSACTION (bug)"}`);
  log(`Retried commit         → ${retry.outcome === "committed" && retry.replayed ? "original receipt returned from the ledger" : "re-executed (bug)"}`);
  log(`GitHub writes caused by the retry: ${style.bold(String(duplicateWrites))}`);
  if (retry.outcome === "committed") {
    log(style.dim(`Receipt hash unchanged: ${retry.receipt.receipt_hash === first.receipt.receipt_hash}`));
  }
  note("A tool that retries the raw API call would have posted every write a second time.");

  // ---- 4. the receipt and the verification failure
  beat(4, "GitHub said 201 for every write. The reread disagrees about one of them.");
  log(renderReceipt(first.receipt));
  outcomes.triage = first.receipt.outcome;
  note(`\na4 got a 2xx, but @${unassignable} cannot be assigned in this repository, so GitHub silently dropped the assignee.`);
  note("The transaction lands in verification_failed, not verified.");

  // ---- 5. reviewable compensation
  beat(5, "Revert the title change. Recovery is a new transaction you review, never an automatic undo.");
  const { transaction: comp } = await engine.proposeCompensation(transaction.id, ["a1"], reviewer);
  log(renderReview(comp, engine.transactionRisk(comp), engine.preview(comp.id)));
  const compApproval = engine.approve(comp.id, reviewer);
  const compResult = await engine.commit(comp.id, compApproval.id);
  if (compResult.outcome === "committed") {
    log("");
    log(renderReceipt(compResult.receipt));
    outcomes.compensation = compResult.receipt.outcome;
  }
  outcomes.triage_after_compensation = engine.get(transaction.id).status;
  log(`\nOriginal transaction is now ${style.bold(outcomes.triage_after_compensation)}.`);

  // ---- 6. stale-state block
  beat(6, "And we check this too: state changed between approval and commit.");
  const follow = await engine.submit(followUpChangeSet(owner, repo, numbers.crash, assignee));
  const followApproval = engine.approve(follow.transaction.id, reviewer);
  note(`Approved. Before the commit runs, a teammate adds "p1" to #${numbers.crash} in the GitHub UI…`);
  await raw.addLabels(owner, repo, numbers.crash, ["p1"]); // bypasses the counter: this is not the engine
  const writesBeforeConflict = writes();
  const blocked = await engine.commit(follow.transaction.id, followApproval.id);
  const conflictWritesBeforeStop = writes() - writesBeforeConflict;
  if (blocked.outcome === "conflicted") log(renderConflicts(blocked.conflicts));
  log(`GitHub writes made before stopping: ${style.bold(String(conflictWritesBeforeStop))}`);
  outcomes.followup_first_commit = blocked.outcome;
  await engine.rebase(follow.transaction.id, reviewer);
  const reapproval = engine.approve(follow.transaction.id, reviewer);
  const afterRebase = await engine.commit(follow.transaction.id, reapproval.id);
  if (afterRebase.outcome === "committed") {
    outcomes.followup_after_rebase = afterRebase.receipt.outcome;
    log(`Rebased onto the current labels, re-approved, committed → ${style.bold(afterRebase.receipt.outcome)}`);
  }

  // ---- ledger
  const events = engine.ledger.list();
  const ledgerIntact = Ledger.verify(events) === null;
  log(`\n${style.accent("━".repeat(78))}`);
  log(`Ledger: ${events.length} append-only events, hash chain ${ledgerIntact ? "intact" : "BROKEN"}, head ${engine.ledger.head().slice(0, 16)}…`);
  log(renderInbox(engine.list()));
  return { engine, outcomes, duplicateWrites, conflictWritesBeforeStop, ledgerIntact };
}
