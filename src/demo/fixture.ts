import { SCHEMA_VERSION, type ChangeSetInput, type IssueRef } from "../types.ts";

export interface SeedIssue {
  key: "crash" | "dup" | "docs" | "perf";
  title: string;
  labels: string[];
  body: string;
}

export const SEED_ISSUES: SeedIssue[] = [
  { key: "crash", title: "crash on save", labels: ["needs-triage"], body: "Saving a file named résumé.txt crashes the app (seeded by the demo)." },
  { key: "dup", title: "App crashes when I save", labels: ["needs-triage"], body: "Autosave to a network drive crashes after ~10 minutes (seeded by the demo)." },
  { key: "docs", title: "config docs wrong", labels: ["needs-triage"], body: "The docs give the wrong config path on Windows (seeded by the demo)." },
  { key: "perf", title: "slow", labels: [], body: "Startup takes 9s on a cold cache (seeded by the demo)." },
];

/**
 * The seeded 12-action triage change set from the PRD, with planted mistakes:
 * a7/a8 close the "dup" issue as a duplicate it is not (the dangerous action),
 * a5 posts a premature public comment, and a4 assigns a user who cannot be
 * assigned, which GitHub accepts with a 2xx and silently drops.
 */
export function triageChangeSet(
  owner: string,
  repo: string,
  numbers: Record<SeedIssue["key"], number>,
  people: { owner: string; unassignable: string },
  transactionId = "triage-release-4-2",
): ChangeSetInput {
  const issue = (key: SeedIssue["key"]): IssueRef => ({ kind: "github.issue", owner, repo, number: numbers[key] });
  return {
    schema_version: SCHEMA_VERSION,
    transaction_id: transactionId,
    workspace_id: "ws-demo",
    source_agent: "triage-agent@0.3",
    initiator: `@${people.owner}`,
    requested_outcome: "Triage the issues opened during the 4.2 release",
    connector: "github",
    actions: [
      { id: "a1", operation: "issue.update_title", target: issue("crash"), params: { title: "Crash on save with unicode filename" }, rationale: "Clarify the title" },
      { id: "a2", operation: "issue.add_labels", target: issue("crash"), params: { labels: ["confirmed-bug"] } },
      { id: "a3", operation: "issue.remove_labels", target: issue("crash"), params: { labels: ["needs-triage"] } },
      { id: "a4", operation: "issue.add_assignees", target: issue("crash"), params: { assignees: [people.unassignable] }, rationale: "Owns the file-save module" },
      { id: "a5", operation: "issue.add_comment", target: issue("crash"), params: { body: "Triage: confirmed. Root cause is the unicode path handling in the save dialog; a fix ships in 4.2.1." } },
      { id: "a6", operation: "issue.add_labels", target: issue("dup"), params: { labels: ["duplicate"] } },
      { id: "a7", operation: "issue.add_comment", target: issue("dup"), params: { body: `Closing as a duplicate of #${numbers.crash}.` } },
      { id: "a8", operation: "issue.set_state", target: issue("dup"), params: { state: "closed", state_reason: "not_planned" }, rationale: `Duplicate of #${numbers.crash}` },
      { id: "a9", operation: "issue.update_title", target: issue("docs"), params: { title: "Docs: wrong config file path on Windows" } },
      { id: "a10", operation: "issue.add_labels", target: issue("docs"), params: { labels: ["documentation"] } },
      { id: "a11", operation: "issue.add_assignees", target: issue("docs"), params: { assignees: [people.owner] } },
      { id: "a12", operation: "issue.update_title", target: issue("perf"), params: { title: "Cold-start takes 9s" } },
    ],
    dependencies: [{ before: "a7", after: "a8" }],
    evidence: [
      { label: "Similarity", content: `#${numbers.dup} and #${numbers.crash} both mention "crash" and "save" (0.91 cosine)`, source: "triage-agent embedding search" },
      { label: "Ownership", content: `@${people.unassignable} touched src/save/ in 14 of the last 20 commits`, source: "git log" },
    ],
  };
}

export function followUpChangeSet(owner: string, repo: string, crashNumber: number, initiator: string): ChangeSetInput {
  return {
    schema_version: SCHEMA_VERSION,
    transaction_id: "triage-release-4-2-followup",
    workspace_id: "ws-demo",
    source_agent: "triage-agent@0.3",
    initiator: `@${initiator}`,
    requested_outcome: "Mark the save crash as a release regression",
    connector: "github",
    actions: [{ id: "b1", operation: "issue.add_labels", target: { kind: "github.issue", owner, repo, number: crashNumber }, params: { labels: ["regression"] } }],
  };
}
