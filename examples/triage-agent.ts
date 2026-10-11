// Minimal agent using the SDK: propose a change set, wait for a human to review
// and commit it, and act only on a verified outcome.
//
//   npm run serve                      # in one terminal (sandbox)
//   node examples/triage-agent.ts      # in another; then review it in the browser
import { ReviewClient, SCHEMA_VERSION, SdkError, type ChangeSetInput } from "../src/sdk/index.ts";

const client = new ReviewClient({
  baseUrl: process.env.BT_SERVER ?? "http://127.0.0.1:4317",
  ...(process.env.BT_AGENT_TOKEN ? { token: process.env.BT_AGENT_TOKEN } : {}),
});

const issue = { kind: "github.issue" as const, owner: "acme", repo: "widgets", number: 195 };
const changeSet: ChangeSetInput = {
  schema_version: SCHEMA_VERSION,
  // A stable id per logical request makes retries safe: resubmitting returns the same transaction.
  transaction_id: `perf-triage-${new Date().toISOString().slice(0, 10)}`,
  workspace_id: "ws-demo",
  source_agent: "example-triage-agent@0.1",
  initiator: "@maintainer",
  requested_outcome: "Label and clarify the cold-start performance report",
  connector: "github",
  actions: [
    { id: "title", operation: "issue.update_title", target: issue, params: { title: "Cold start takes 9s on an empty cache" } },
    { id: "label", operation: "issue.add_labels", target: issue, params: { labels: ["performance"] } },
  ],
  evidence: [{ label: "Report", content: "User measured 9.1s to first window on a cold cache", source: "issue body" }],
};

try {
  const { transaction_id, deduplicated } = await client.submit(changeSet);
  console.log(`${deduplicated ? "Already submitted" : "Submitted"} ${transaction_id}. Review it in the browser; waiting…`);
  const decision = await client.waitForDecision(transaction_id, { onStatus: (s) => console.log(`  ${s.status}`) });
  if (decision.ok) {
    console.log("Verified: GitHub is in the approved state. Continuing.");
  } else {
    // Rejected, expired, timed out, or committed but not verified: do not assume the write happened.
    console.log(`Not verified (${decision.outcome}). Stopping here.`);
    if (decision.status.rejection_reason) console.log(`Reviewer said: ${decision.status.rejection_reason}`);
    process.exitCode = 3;
  }
} catch (err) {
  // Fail closed: if the review server can't be reached, nothing was written.
  console.error(err instanceof SdkError ? `${err.code}: ${err.message}` : err);
  process.exitCode = 1;
}
