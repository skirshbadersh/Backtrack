# Backtrack PRD v4

Oct 11, 2026 · @Saul Azcuy-Batet

> "Backtrack" is a codename only. See [Naming](#naming).

## Document status

Version 4.1 (October 11, 2026) re-centers the product on the half of the loop that public evidence actually supports, replaces the interview-based validation plan with asynchronous substitutes, and changes the connector order. Status: validation prototype approved; production MVP conditional. Owner: solo founder. Pursuit score: 68/100 (78 in v2, 74 in v3.0, 73 in v3.1, 70 in v4.0).

**Why 70.** An October 10 sweep of public complaints (about 24 dated, linkable items from January to October 2026, plus six vendor surveys) found that the pain is real but lives in a different place than v3 assumed. The strongest, most repeatable failures are duplicate or replayed writes and writes that reported success but did not apply, in Jira, Notion, Slack and Zendesk, including on Atlassian's and Notion's own official MCP servers. Those map directly onto idempotent commit, post-write verification and compensation, which no neighbor ships for SaaS writes. Three things pull the score down: nobody in public is asking for grouped or batch review, so the signature review screen is an unvalidated bet; there are zero public incidents of state changing between preview and execute, so the stale-state gate is unvalidated too; and the founder cannot run interviews, so the validation plan now rests on weaker, asynchronous signals. The thesis survives; the pitch order and the connector order change.

**Why 68, not 70 (October 11 third pass).** A third competitive pass covering the previously unverified groups found no one shipping stale-state reread (G4) or post-write verification (G5) for agent-proposed SaaS writes, which keeps the thesis alive. Two points come off for two reasons. First, exactly-once commit, which v4.0 made the lead capability, is now contested by claim: Paragon ActionKit says it enforces idempotency keys on every third-party action call. The claim rests on a promotional blog post, not API docs, but a funded competitor is already telling the market the same story. Second, the trademark check against the USPTO's own records confirms that "Backtrack" is not clearable even as a compound mark, which adds a rename to the pre-launch critical path. The defensible position is therefore the combination G3 + G4 + G5 + G8 with a reviewable compensation model, which nobody claims, rather than any single guarantee.

**What changed from v3.1.**

- Lead with verified, idempotent commit; grouped review becomes the surface those guarantees live in, not the headline.
- Second connector is Jira (most severe, vendor-confirmed public failures), third is Notion. Linear is deprioritized: no public bad-write reports and the highest native-absorption risk.
- Validation plan rebuilt around public evidence, a landing page with one diagnostic question, a runnable CLI demo, a Show HN, and a paid-pilot waitlist, with the interview metrics mapped to measurable substitutes.
- Risk register gains three rows: grouped review unvalidated, stale-state gate unvalidated, and weaker validation signal without interviews.

## Product decision

Backtrack will be a transactional commit layer for operational changes proposed by AI agents, sold on one promise: **the write you approved is the write that happens, exactly once, and you get proof it landed.** A reviewer sees a grouped set of proposed changes, edits or rejects individual actions, and approves the exact payload. Backtrack then rereads the target, commits idempotently through a constrained executor, rereads again to verify, and offers recovery as a new reviewable transaction.

The wedge, in the order public evidence supports it:

1. **Exactly-once commit.** Duplicate and replayed writes are the most common public failure (seven items, including Atlassian's own MCP server creating two Jira tickets per call and LangGraph re-running an approved write on resume). Every Backtrack action carries an idempotency key derived from the approved payload hash; a retry returns the original receipt rather than writing again. Boundary: exactly-once holds only where the target API accepts an idempotency key or where Backtrack can detect a prior commit by reread. Each connector documents which of the three strategies it uses (native key, natural-key reread, or none), and where it is "none" the receipt says so. Paragon ActionKit claims the same guarantee at the action layer; Backtrack's version is bound to a reviewed payload and proven by reread, not asserted by the executor.
2. **Postcondition verification.** "Returned success but did not apply" is the second most common failure (Notion's official MCP ignoring a trash request, Zendesk and Jira servers returning `success: true` on writes that never landed or landed wrong). Backtrack rereads the target after every write; an HTTP 200 is not success until declared postconditions hold. No product in three sweeps ships this for SaaS writes.
3. **Reviewable compensation.** Recovery is a new transaction through the same review, with irreversible residue (notifications already sent, comments already seen) stated plainly. Never an automatic unwind. Insycle's CRM undo is a CSV re-import it calls "a recovery process, not an undo button"; agent-undo and Cloudflare Code Mode unwind automatically.
4. **Stale-state blocking.** Reread immediately before execution; stop if anything changed since approval. Kept because it costs almost nothing once the verifier exists, but demoted: no public incident reports describe this failure. Paragon's duplicate-write lookup is the nearest thing anyone ships, and it checks for a prior create, not for drift since approval.

Grouped semantic review with before/after diffs and item-level edit/reject remains the surface the reviewer works in, and it is where Backtrack differs from a per-call approval prompt. It is no longer the headline, because no public source asks for it and approval prompts are approved 93–97% of the time regardless. The screen earns its place by making the four guarantees above legible, not by itself.

**What Backtrack is not.** Not a universal undo system, a backup or disaster-recovery product, an MCP firewall or gateway, an observability suite, an identity or governance control plane, or a code or pull-request review tool. Those are owned by Rubrik and Veeam, the gateway cohort, Okta, Microsoft and SailPoint, and GitHub, VS Code and Linear.

**Connectors.** First: GitHub issue operations, kept for the fastest safe demo and because its official MCP server has a documented duplicate-write problem. Second: Jira, where the public evidence is most severe and vendor-confirmed, and where Backtrack's exactly-once and verification guarantees are orthogonal to the pre-execution review Atlassian is building. Third: Notion. Linear drops to a later phase. A six-week production MVP is authorized only if Phase 0 meets the thresholds in the validation plan.

## Problem

Teams keep useful agent workflows read-only because they cannot evaluate consequences before a write or prove what happened after one. The market has partly solved this since v2, so the problem statement now separates what is commodity from what is still open.

| Problem | Status in Oct 2026 | Who addresses it | What remains unsolved |
|---|---|---|---|
| Fragmented intent: one request becomes many tool calls, each approved alone | Partly solved | LangChain HITL middleware batches pending calls; semantic-saga-mcp groups steps | No one shows the grouped business outcome with before/after object diffs for SaaS writes |
| Approval drift: target state changes between preview and execution | Unsolved for SaaS | CogniRunner 6.1 checks an unchanged target, Jira admin ops only (vendor claim, unverified) | No product rereads GitHub, Linear or CRM objects before committing |
| Ambiguous reversibility: "undo" promised where only compensation exists | Vocabulary converging | Veeam and Rubrik define reversible vs compensating; Cloudflare Code Mode ships per-method revert | Compensation runs automatically; none presents it as a reviewable transaction with residual effects stated |
| Weak outcome evidence: a 200 response is treated as success | Unsolved | Docker post-interceptors and Arcade post-execution hooks exist as hook points, with nothing built on them | No product rereads the target and checks declared postconditions |
| Approval fatigue: prompt on everything or on nothing | Partly solved | Every gateway offers per-tool allow/deny/ask; MintMCP and TrueFoundry hold single calls | Risk-based gating at the transaction level, not the call level, is still rare |

The practical consequence is that a team wanting the full loop today assembles it from four products (a gateway for holds, a framework for batching, a saga library for compensation, and hand-written verification) or builds it in-house. Public GitHub issues from companies specifying their own "change set engine with dry-run, stale refusal and undo" show that build-it-yourself is the main alternative for 5–50 person teams.

**What the public record says (sweep of October 10, 2026).** About 24 dated, linkable complaints, feature requests and incident reports from January to October 2026 describe agents or agent connectors making wrong writes to non-code SaaS systems. The pattern is clear and it is not the one v3 led with.

| Failure category | Public items | Backtrack capability | Validation status |
|---|---|---|---|
| Duplicate or replayed write | 7 | Exactly-once commit (idempotency key from payload hash) | Validated; strongest evidence |
| Reported success but did not apply, or applied wrong | 4 verified, 2 unverified | Postcondition verification by reread | Validated |
| Approval gate broken, bypassed or uninformative | 5 | Payload-bound approval; prompt shows the diff, not the tool name | Validated |
| Wrong target object | 3 | Before/after diff per object | Partly validated |
| Irreversible side effect (message sent, comment visible) | 3 | Recovery classes; residue stated | Validated as a limit, not a fix |
| No rollback or undo | 3 | Reviewable compensation | Validated |
| No grouped preview or diff | 2 | Grouped review screen | Weak |
| Approval fatigue | 1 anecdote plus surveys | Risk-ranked diffs, changed-since-last-review | Validated by survey data |
| State changed between preview and execute | 0 direct | Stale-state gate | Unvalidated |

Systems by public pain: Slack (6 items, mostly irreversible sends, poor fit), Jira and JSM (3, highest severity, vendor-confirmed), Notion (3, both official-MCP bugs on-thesis), Zendesk (2 plus 2 unverified), framework-level (4), Salesforce (2), GitHub issues, HubSpot, Asana and Linear (1 each). Survey data from Anthropic, CSA, OneTrust, Optro and Gravitee puts unintended agent actions in business processes at roughly 30–41% of agent-deploying organizations, and manual review catching 13.6% of harmful actions versus 89% for automated checks. Every survey is vendor-commissioned and none isolates SaaS record writes.

## Competitive landscape

No product checked ships the integrated loop as of October 11, 2026, after three sweeps and a delta check covering roughly 80 products. The eight capabilities below are the feature language for the rest of this document. G2 exists only for CRM bulk jobs (Insycle) and document text (Tiptap), not for agent-proposed SaaS writes; G4 and G5 are unshipped everywhere; G6 is shipped only as automatic rollback; G8 is claimed by Paragon ActionKit in marketing but unverified in its docs.

| Code | Capability |
|---|---|
| G1 | Multi-action semantic grouping into one reviewable transaction |
| G2 | Before/after object diffs for non-code SaaS writes |
| G3 | Approval bound to the exact normalized payload, with expiry |
| G4 | Pre-execution stale-state detection by rereading the target |
| G5 | Postcondition verification by rereading the target after execution |
| G6 | Recovery classes, with compensation as a reviewable transaction |
| G7 | Item-level edit or reject within a batch |
| G8 | Exactly-once commit under retry, keyed to the approved payload and proven by reread |

**Tier 1: nearest neighbors.** Products that ship two or more of the seven, or sit on the same buyer.

| Product | Category | Has | Lacks | Threat (1–5) |
|---|---|---|---|---|
| Cloudflare Code Mode + Workflows | Developer platform | Per-write approval with expiry, durable pause, per-method revert, individual approve/reject (partial G1, G3, G6, G7) | G2, G4, G5; compensation is automatic; marked experimental | 4 |
| LangChain / LangGraph HITL middleware | Agent framework | Batched pending calls with per-item approve/edit/reject (G7, partial G1) | G2–G6; no review UI; warns that edits may cause re-execution | 4 |
| Arcade.dev | Tool-execution runtime | Pre- and post-execution hooks, $72M raised, Cisco investment Sept 2026 | All seven; hooks are empty insertion points | 4 |
| Preloop | HITL / control plane | Free Apache-2.0 per-call approvals; markets Jira/GitHub issue automation to the same buyer | All seven beyond per-call; open GitHub issues plan exact-argument approval binding and no-replay polling (G3), not yet shipped | 3 |
| CogniRunner 6.1 (Jira) | Ticketing app | Exact-request binding and unchanged-target check (G3, G4), per vendor article; Marketplace listing confirmed (29 installs) but neither claim appears in the listing or the repo | G1, G2, G5–G7; Jira admin ops only; unverified | 3 |
| MintMCP | MCP gateway | Single-use approval bound to exact call and arguments (G3) | G1, G2, G4–G7 | 3 |
| semantic-saga-mcp | OSS saga executor | Grouped steps, SHA-256 action contracts, versioned compensation (G1, G6, partial G3) | G2, G4, G5, G7; no review UX; solo maintainer | 2 |
| Microsoft Copilot Studio Hooks (preview, Oct 2026) | Agent platform | Pre-tool-use hook can check, change or block a call; post-tool-use hook can change or log the result (DIY substrate for G4) | G2, G5; no target reread; hooks fail open; only agents on the GitHub Copilot harness | 3 |
| Paragon ActionKit | Embedded-integration platform | Idempotency keys, risk-tiered approval gates, dry runs, duplicate-write checks, per-action log (G1, G3-lite); sells to SaaS vendors embedding agents in their products | G2, G4, G5, reviewable G6; different buyer; the idempotency, dry-run and dedupe claims come from a July 2026 promotional post with an unremoved editorial note and are unverified in ActionKit's API docs | 4 (raised Oct 11) |
| Insycle | CRM data operations (HubSpot, Salesforce) | Preview with full before/after report, per-record before/after values with a Run ID (G2 for CRM); now positions as data integrity for the agentic CRM | Writes are human-run bulk jobs, not agent proposals; several modules have no preview; undo is CSV re-import; no G3, G4, G5 | 3 |
| Salus (YC W26) | Runtime guardrails | Validates state-mutating tool calls against policy and an evidence cache before execution; HITL escalation; lists idempotency as a feature | G1, G2, G5, G6, G7; policy-centric, not review-centric; two founders, reported $3.7M (unverified) | 3 |
| Windmill / gotoHuman | Approval pages and inboxes | Hosted approval page with forms, timeouts, group restriction (Windmill); review inbox with edit fields and n8n node (gotoHuman) | No diffs, no payload hash, no reread; both are distribution partners as much as neighbors | 2 |

**Tier 2: distribution partners.** Products with pause/resume or hook plumbing that explicitly leave the review step to someone else. Backtrack should integrate with these, not compete.

- Execution substrates: Nango Actions, Pipedream Connect, Composio before_execute.
- Gateway hooks: Docker MCP Gateway interceptors, ToolHive validating webhooks, TrueFoundry pending results, Bifrost explicit execution, Kong and agentgateway plugins, IBM ContextForge plugins.
- Policy authorities that expect an external approver: AWS AgentCore Policy (approvalStatus supplied by your orchestration), Gemini Managed Agents hooks.
- Pause primitives: LangGraph interrupt, Claude Code PreToolUse hooks, OpenAI Agents SDK needs_approval, Temporal, Inngest, Trigger.dev.

Added October 11: gotoHuman (reviewers already live in its inbox; Backtrack supplies binding, reread and commit), an n8n community node (n8n's own review step shows raw JSON parameters), the HubSpot MCP-server app component, the Atlassian Marketplace via Forge, and Paragon as a connector backend if its idempotency claims verify in its docs. Idempotency design should be benchmarked against Trigger.dev (scoped keys with TTLs), Inngest (explicit warning that steps are not exactly-once externally), Temporal (Run ID plus Activity ID key derivation) and Windmill PR #11450 (a concurrent-approval race).

**Tier 3: platform absorption risks.** Native platforms that could ship grouped issue or record review and remove the first connector's reason to exist.

| Platform | Evidence | Risk |
|---|---|---|
| Linear | Agent "awaiting approval" state, issue drafts, Diffs, third-party app approvals (Sept 14, 2026); agents author about 25% of new issues per CEO | Highest |
| GitHub | Copilot approval UX in CLI and JetBrains (Sept 22, 2026); cloud agent MCP tools run without approval; no batch issue-review signal | Medium |
| Atlassian | Rovo agents GA May 2026; Oct 6, 2026 Atlassian–OpenAI partnership: high-impact Jira actions from ChatGPT and Codex can be reviewed before they run, and assign-work-to-agents-then-review-results is being explored; no diffs, stale-state check or verification | High (raised Oct 9) |
| Microsoft, Google, Salesforce, OpenAI, Anthropic | Per-action or per-instance approvals only | Low for this loop |

**Tier 4: adjacent, not competing.** Rubrik Agent Rewind and Veeam Agent Commander (backup-side undo, enterprise buyers), Okta, Entra Agent ID, SailPoint Agentic Fabric (identity), HumanLayer (pivoted to a coding IDE), Lasso, Lunar, Kong, Solo, Docker, IBM (gateways with allow/deny and at most single-call holds), Undo Ltd. (debugging; name collision only).

Build-it-yourself remains the primary alternative for the target segment. The PRD treats it as a named competitor: Backtrack must be cheaper to adopt than two weeks of in-house work and must be demonstrably more correct on G4 and G5.

Full findings are in the October 5 competitive sweeps, the October 9 delta check, the October 10 public-evidence sweep and the October 11 third pass and trademark check. Still unverified against primary sources: Make, Relay, Lindy, Gumloop, Dust, Glean, Restate, DBOS, Hatchet, the coding platforms, Verity, Aurascape, SealGate, Corsair and Archipelo. All are low-probability threats and are not a reason to delay Phase 0.

## Product promise and positioning

**Promise.** Review an agent's proposed changes like a pull request, commit only what you approved, and get verified evidence that the target system ended up in the state you approved. If it didn't, you'll know before anything else runs.

**Lead message.** "The write you approved is the write that happens, exactly once, with proof." Not "approvals" (a commodity, and approved 93–97% of the time anyway) and not "undo" (owned by Rubrik and Veeam with enterprise buyers, and by a dozen open-source projects with developers).

**Positioning boundaries.** Backtrack will not claim to undo anything, make all agents safe, replace backups, make autonomous risk decisions, or provide compliance. Every action is classified before review:

| Class | Meaning | GitHub example |
|---|---|---|
| Reversible | Prior state can be restored with a supported, tested operation | Restore an issue's previous title or labels |
| Compensatable | The action stands; a corrective action reduces harm | Post a correction after a comment already notified people |
| Irreversible | No reliable restoration or compensation exists | Side effects outside the connector's control |

**Demo order.** Every demo and every landing-page section leads with the two failures people have already reported in public: a retried write that would have created a duplicate issue is returned from the ledger instead, and a write that returned 200 OK but did not apply shows as `verification_failed` rather than `verified`. Reviewable compensation is the third beat. The stale-state block is the fourth, framed as "and we check this too." Grouping, diffs and item-level editing are shown as the surface those guarantees live in, not as the pitch. Exhibits to cite on the page: Atlassian MCP issue #132 (duplicate Jira tickets, fixed by Atlassian with exactly-once execution), Notion MCP issue #258 (success response, page not trashed), GitHub MCP issue #3426 (safe retries request).

## Target users and jobs to be done

**Primary user.** An AI or platform engineer at a 5–50 person technical company who operates an internal agent performing repetitive write actions. They already use GitHub operationally, have at least one agent that proposes or performs changes, keep useful workflows read-only out of caution, can install a GitHub App, and can influence a small tooling purchase without procurement. Many of them are already using LangGraph, Claude Code or a gateway, which is why the distribution architecture meets them there.

**Secondary user.** An engineering manager or technical founder accountable for agent-caused mistakes who wants understandable evidence and reviewer accountability.

**Future users.** Automation consultants managing workflows for several clients; operations teams using agents across project-management and support tools; security teams needing transaction-level controls. Large regulated enterprises are excluded for the first release; that segment is being served by Okta, Microsoft, SailPoint and Veeam.

| Role | Job | Capability |
|---|---|---|
| Reviewer | See the intended outcome and all affected objects as one transaction | G1, G2 |
| Reviewer | Remove or edit one action without rejecting the whole transaction | G7 |
| Reviewer | Know before committing whether an object changed since the preview | G4 |
| Reviewer | Prove after committing that the intended state exists | G5 |
| Reviewer | Recover from a wrong action with limitations stated plainly | G6 |
| Agent builder | Submit typed actions once, pause, resume with a machine-readable decision | G1, G3 |
| Agent builder | Avoid building a custom approval UI, audit log and recovery for each workflow | All |
| Team owner | Know who proposed, approved, changed, executed and compensated each action | G3, ledger |
| Team owner | Set a simple boundary on which actions require review | Risk model |

## First workflow: GitHub issue operations

An agent triages issues and proposes a batch containing title changes, label adds and removes, assignee changes, comments, and close or reopen. GitHub's REST API supports all of these through a GitHub App with issue read/write permissions, so the integration is bounded. The workflow is kept despite being low-stakes because it is the fastest way to a real, safe demo; the validation interviews must test whether a higher-stakes system (Linear, Jira, CRM, Slack) is where the incident cost actually lives.

**Example change set.** Requested outcome: triage issues created during the last release.

| Action | Target | Proposed change | Risk | Recovery |
|---|---|---|---|---|
| Update title | Issue #184 | Clarify title | Low | Reversible |
| Add label | Issue #184 | Add confirmed-bug | Low | Reversible |
| Assign owner | Issue #184 | Assign @alex | Medium | Reversible |
| Add comment | Issue #184 | Publish triage explanation | Medium | Compensatable |
| Close issue | Issue #207 | Close as duplicate of #184 | High | Reversible, notifications remain |

The reviewer edits the title, removes the comment, rejects closure of #207, and commits the rest as one new normalized transaction.

**Demo script (in this order).**

1. Open the transaction; state the outcome in under 30 seconds; find the planted dangerous action (closing #207).
2. Edit the title, reject the comment, commit the remaining four actions.
3. Exactly-once commit: the agent's client times out and resubmits the same change set. Backtrack recognizes the payload hash and idempotency keys, returns the original receipt, and writes nothing. Contrast with the GitHub and Atlassian MCP servers that create duplicates on retry.
4. Verification failure: the assignee write returns 200 but the reread shows @alex is not assigned (simulated for the prototype). The transaction lands in `verification_failed`, not `verified`, and the receipt shows proposed, approved, attempted and actual state side by side.
5. Reviewable compensation: the reviewer asks to revert the title change. Backtrack proposes a new compensation transaction, states which effects cannot be removed, and routes it through the same review and commit flow.
6. Stale-state block: between approval and commit, a teammate has already added a different label to #184. Backtrack rereads, marks the label action conflicted, shows original preview vs current vs proposed, and stops before any write.

## Core experience

The review screen is the signature experience; the conflict and verification states are what make it worth paying for.

**Change-set inbox.** Pending, approved, executing, verified, conflicted, failed and compensated transactions, each showing requested outcome, source agent and initiator, repository, action and object counts, highest risk, reversibility breakdown, creation time and approval expiry.

**Review screen.** Plain-language summary; why the agent proposed it; agent-supplied evidence labeled untrusted; object-by-object before/after diffs; dependencies and ordering; risk and recovery class per action; exact normalized parameters on demand; item-level edit, approve and reject; transaction-level reject and commit. The primary action reads **Commit approved changes**, never "Approve", because approval and execution are distinct events.

**Conflict resolution.** Immediately before execution Backtrack rereads every affected object and compares it with the approved precondition. If anything relevant changed, nothing executes, the item is marked conflicted, the reviewer sees original preview, current state and proposed state, and a new approval is required after rebasing.

**Execution.** The executor accepts only an approved, unexpired, hash-bound payload, runs actions in dependency order, records every attempt with GitHub request IDs, and stops according to the connector's failure policy. Replays are idempotent for supported operations.

**Verification.** After execution Backtrack rereads affected resources and checks declared postconditions. A transaction is verified only when they hold. A mismatch produces `verification_failed` with proposed, approved, attempted and actual state side by side.

**Compensation.** Supported reversible actions can generate a new compensation transaction showing the original action, current state, proposed recovery, and effects that cannot be removed. It goes through the same review and commit flow. Compensation is never silently automatic.

A change detected before commit stops everything and returns to review; a mismatch after commit lands in `verification_failed` rather than `verified`; compensation re-enters the loop as a new transaction instead of running on its own.

## Functional requirements

**Change-set API.** Accepts a versioned schema with `schema_version`, `transaction_id`, `workspace_id`, `source_agent`, `initiator`, `requested_outcome`, `connector`, `actions[]`, `dependencies[]`, `evidence[]`, `expires_at`. Each action carries a stable ID, operation type, target resource, normalized parameters, captured precondition state or version, expected postconditions, risk class, recovery class, and an optional compensation template. Unknown schema versions, operations, or execution-relevant fields fail closed. Submission must work both synchronously and through the MCP 2026-07-28 multi-round-trip elicitation pattern, returning a pending-review state and resuming on approval, so Backtrack works as a drop-in MCP server for Dots, Claude, Codex and Copilot clients.

**Approval binding (G3).** The approval record binds reviewer identity, workspace and connector, transaction ID and schema version, the canonically normalized payload, its hash, approved action IDs, timestamp, expiry, and policy version. Any mutation after approval invalidates it and creates a new revision. The hash and approver identity are written into the receipt. This matches what MintMCP and Aurascape ship at the single-call level and what the OWASP agentic cheat sheet recommends; Backtrack applies it to the whole transaction.

**GitHub connector.** Authenticates as a GitHub App with minimum permissions; reads issue state before preview and again immediately before execution (G4); updates supported fields, labels, assignees, comments and state; records request IDs; rereads for verification (G5). Permission sets are confirmed per endpoint during implementation.

**Webhooks.** Verify the secret, use HTTPS with certificate checks, return 2XX within 30 seconds and process asynchronously, validate event and action types, deduplicate by `X-GitHub-Delivery`, and recover missed deliveries.

**Event ledger.** Append-only at the application level: submitted, hydrated, edited, rejected, approval created or expired, precondition passed or conflicted, execution started, action attempted/succeeded/failed, verification passed or failed, compensation proposed/approved/executed/verified. Corrections are new events.

**Deterministic safety model.** LLMs may explain proposals; they never decide authorization. Deterministic code owns authentication, schema validation, canonicalization and hashing, approval status and expiry, policy checks, precondition comparison, idempotency, ordering, execution, postcondition verification and receipts. The executor is a separate service from any proposing agent.

**Risk model.** Deterministic rules with visible contributing factors; never an opaque model-generated score.

| Condition | Default treatment |
|---|---|
| Read-only action | Outside execution scope |
| Single reversible metadata edit | Low |
| Assignment affecting another user | Medium |
| Comment that sends notifications | Medium; compensatable warning |
| Closing an issue | High |
| More than 10 objects | High; explicit batch warning |
| Unknown operation or recovery class | Block |
| State changed after preview | Conflict; reapproval required |
| Approval expired | Block |
| Connector permission exceeds documented need | Block installation |

**State machine.** `draft`, `pending_review`, `changes_requested`, `approved`, `conflicted`, `queued`, `executing`, `partially_executed`, `verification_failed`, `verified`, `rejected`, `expired`, `compensation_pending`, `compensated`, `compensation_failed`. Only explicit transitions; every transition is an event; terminal states cannot be reopened without a new revision or compensation transaction.

**Data model.** users, workspaces, workspace_members, connectors, connector_installations, transactions, transaction_revisions, actions, approvals, execution_attempts, verification_results, compensation_transactions, events. Secrets and installation tokens never appear in event payloads; sensitive fields are redacted before analytics or error reporting.

## Distribution architecture

Backtrack ships as a review-and-verify engine that plugs into the pause/resume plumbing teams already run, not only as a hosted intermediary they must route everything through. This answers the v2 open question ("SDK, MCP proxy, API gateway, or connector-native?") with "all of them, thinly, on top of one engine," and it converts the "hosted intermediary rejected" risk from a kill risk into a distribution channel.

The core engine (proposal API, hydration, review, policy, executor, verifier, compensation planner, ledger) is one service. Around it, adapters are small and interchangeable.

| Adapter | What it does | Why first |
|---|---|---|
| Typed SDK / CLI (TypeScript, Python) | Submit a change set, await decision, resume | Needed for the validation prototype; zero dependencies |
| LangGraph interrupt handler | Turns a HumanInTheLoopMiddleware interrupt into a Backtrack transaction and feeds the decision back | Largest installed base of the target user; LangChain batches but has no UI, diffs, rereads or verification |
| Claude Code PreToolUse hook | Defers a tool call, submits it, resumes on approval | Already named in v2; cheap; good demo source agent |
| MCP gateway interceptor (Docker, ToolHive, TrueFoundry, Bifrost) | Holds a write at the gateway and sends it to Backtrack for grouped review | Gateways hold single calls and explicitly leave review to the host app |
| Cloudflare Code Mode adapter | Supplies diffs, payload hashing, rereads and receipts to Cloudflare's requiresApproval and revert primitives | Cloudflare is the highest-threat neighbor; plugging in is cheaper than competing |
| Execution through Nango or Pipedream | Use their auth and connector catalogs for connectors beyond GitHub | Avoids building OAuth and API clients per connector |

The hosted executor remains the default. A self-hosted executor (the engine's execute-and-verify half running inside the customer's environment, with the review UI hosted) is a Phase 2 option if interviews confirm that hosted execution is the top objection; it is not built speculatively.

Two constraints follow from this architecture. First, the change-set schema is the product's stable contract; adapters translate into it and never bypass it. Second, every adapter must preserve fail-closed behavior: if Backtrack is unreachable, the write does not happen.

## Interface requirements

The interface should feel like a calm, precise operational instrument, not an AI dashboard. Neutral surfaces with one restrained accent; dense enough for serious review but organized as a narrative from outcome to objects to actions; no gradients, chat bubbles, animated AI imagery or three-card SaaS sections. Risk color is never the only signal; before/after states use typographic and structural contrast rather than heavy red/green; motion communicates state transitions and execution progress only.

**Required states for every primary view.** Loading skeleton, empty, permission error, connector unavailable, stale-state conflict, partial execution, verification failure, expired approval, unsupported recovery. The conflict and verification-failure states get the most design attention because they are the product's differentiators and the states a prospect will screenshot.

**Accessibility.** Full keyboard operation, visible focus, semantic headings and tables, WCAG AA contrast, 44×44 px touch targets, reduced-motion support, no meaning conveyed by color alone.

## Prototype and MVP scope

**Validation prototype (two weeks), must have.** Polished inbox and review screen; one seeded transaction of about 12 actions with planted mistakes; item editing and rejection; risk and recovery labels; exact-parameter disclosure; a real stale-state conflict against a disposable GitHub repository; commit confirmation; execution progress; a verification receipt including one `verification_failed` case; a compensation proposal routed back through review; a real GitHub App connection; two or three real low-risk writes.

**Can be simulated.** The higher-risk closure action, partial-execution failure, approval expiry, multi-reviewer activity, compensation for operations not yet implemented, and the verification-failure trigger. Simulated behavior is labeled during internal testing and never shown to design partners as production functionality.

**Explicitly out of scope for the prototype.** Every adapter except the typed SDK/CLI; a second connector; self-hosted execution; roles beyond a single reviewer.

**Conditional MVP (six weeks after validation).** Workspace authentication; GitHub App installation; GitHub issue connector; typed SDK; durable pause/resume; inbox and transaction detail; item-level edit/reject; approval binding and expiry; conflict detection; deterministic execution; postcondition verification; append-only receipts; tested compensation for supported reversible actions; submitter/reviewer/administrator roles; the LangGraph interrupt adapter; a second connector (Jira, per the October 10 public-evidence sweep; Notion third; Linear deferred); analytics excluding sensitive payloads; monitoring and alerts.

**Non-goals for prototype and MVP.** Code-file or pull-request review; Gmail, payments, databases, cloud infrastructure or deployments; universal MCP traffic inspection; agent discovery, prompt tracing or cost dashboards; autonomous risk scoring presented as authoritative; SSO, SCIM, SOC 2 or retention policies; native mobile; an integration marketplace; user-authored execution scripts; guaranteed rollback across external systems.

## Technical architecture

**Stack.** Next.js with TypeScript for frontend and API; Postgres/Supabase for data and auth; Zod plus versioned JSON Schema for validation; Trigger.dev or Inngest for durable jobs; a GitHub App with least-privilege installation tokens; Vitest and Playwright; Sentry with payload scrubbing; PostHog with session replay off on review surfaces; 1Password or Doppler for secrets; Vercel hosting with background execution delegated to the job provider.

**Core services.**

| Service | Responsibility | Gap capability |
|---|---|---|
| Proposal API | Receives and validates change sets; sync and MCP multi-round-trip submission | G1 |
| Hydration | Reads current target state, prepares semantic before/after diffs | G2 |
| Review | Manages revisions, item decisions, approval binding and expiry | G3, G7 |
| Policy | Applies deterministic risk and gating rules | Risk model |
| Precondition checker | Rereads every affected object immediately before execution; raises conflicts | G4 |
| Executor | Performs only approved, hash-bound actions in dependency order, idempotently | G3 |
| Verifier | Rereads external state after execution, evaluates declared postconditions | G5 |
| Compensation planner | Builds a new reviewable transaction from stored prior state, with residual effects | G6 |
| Ledger | Append-only lifecycle events and receipts | All |

**Connector contract.** Each connector implements `read(resource)`, `write(action)`, `postconditions(action)`, and `compensate(action, priorState)`, and declares a recovery class and an idempotency strategy per operation (native idempotency key, natural-key reread, or none; "none" means exactly-once cannot be promised for that operation and the receipt says so). Every operation advertised as reversible must pass an automated round-trip test before it ships. Connectors beyond GitHub may execute through Nango or Pipedream rather than direct API clients.

**Protocol alignment.** Submission and resume support the MCP 2026-07-28 multi-round-trip pattern so agents can pause for review without long-lived connections. Approval binding follows the OWASP agentic-security guidance to bind actor, tool, target, parameters, time and expiry.

**Claude Code.** PreToolUse hooks can defer a tool call to Backtrack and resume after approval; Claude Code is both a development accelerator and a demonstration source agent. The validation prototype uses a typed test agent or CLI first.

## Acceptance criteria, metrics and validation

**Acceptance criteria.**

- **Review comprehension:** a participant states the outcome within 30 seconds, finds the planted dangerous action, distinguishes the three recovery classes, removes one action and commits the rest unaided, and understands that Commit approved changes performs an external write.
- **Approval integrity (G3):** editing any execution-relevant field invalidates the approval; expired approvals cannot execute; unknown actions cannot execute; replayed requests do not duplicate supported operations.
- **Stale-state (G4):** changing GitHub state after approval produces a conflict before any action executes, every time.
- **Verification (G5):** every executed action has declared postconditions; verification rereads GitHub rather than trusting the write response; a mismatch yields `verification_failed`; receipts distinguish proposed, approved, attempted, actual and compensated state.
- **Recovery (G6):** compensation always creates a separately reviewable transaction; residual effects are stated; every action advertised as reversible passes an automated round-trip test.
- **Reliability and security:** webhook signatures validated; duplicate deliveries deduplicated; no secrets in logs or analytics; least-privilege permissions documented; execution fails closed if approval, policy or audit persistence is unavailable.

**Validation plan (two weeks, no interviews).** The founder cannot run user interviews, so validation uses asynchronous signals that answer the same three questions. Each original interview metric is mapped to a measurable substitute; the substitutes are deliberately harder to game than a conversation.

Days 1–3: high-fidelity prototype with 12 actions, mixed classes, one dangerous action, one duplicate-retry, one verification failure, one compensatable action, one stale-state conflict. Days 4–6: thin real integration (GitHub App auth, issue reads, typed submission, payload hashing and idempotency keys, item decisions, two or three writes, reread verification, append-only history), packaged as `npx demo` that runs the seeded transaction against the user's own disposable repository. Days 7–10: publish a landing page whose hero is the duplicate-retry and verification-failure demo, with one diagnostic question ("Which system did your last agent mistake touch?") and a "Request early access" form that asks which system they would connect and whether they would pay for a pilot; post a 60-second recording to Show HN, r/LangChain, r/ClaudeAI and the LangChain, Preloop and MCP Discords; dogfood the Claude Code hook daily and log every point of confusion. Days 11–14: open a paid-pilot waitlist with a card on file for a discounted pilot; follow up asynchronously with everyone who ran the CLI.

| Original interview metric | Substitute | Threshold |
|---|---|---|
| 10 qualified interviews | Distinct qualified people who run the CLI demo or complete the early-access form | 10 |
| 6 report a concrete incident or manual workflow | Diagnostic-question responses naming a system plus the public-evidence sweep as existence proof | 6 responses, plus the 24 public items already in hand |
| 5 understand the model without explanation | Show HN and community comments that restate the value correctly, unprompted | 5 |
| 3 connect a test repo or share a workflow | CLI runs against the user's own repository (opt-in telemetry) or a real sanitized change set submitted | 3 |
| 2 active design partners | People who run the CLI twice or reply to an async follow-up with a workflow | 2 |
| 1 monetary commitment | Card on file for the paid pilot | 1 |

**What this cannot tell you.** Frequency per team per month, cost per incident, whether reviewers would read a grouped diff or rubber-stamp it, whether stale-state races happen in practice, and who owns budget. Those stay open and are revisited in Phase 1 with the design partners the substitutes produce. If five or more asynchronous conversations become possible during Phase 1, run them, targeted at Jira admins and RevOps or CRM owners, and ask only about stale state and grouped review, because those are the two pillars public evidence does not cover.

**MVP metrics.** Median time from opening a transaction to decision; share of transactions modified before commit; planted-bad-action detection rate; conflict-detection rate before execution; verified execution rate; duplicate side-effect count; compensation success rate; weekly active reviewing teams; four-week design-partner retention; number of workflows customers refuse to run without Backtrack. Raw approval volume is not a target.

**Go/no-go.**

| Decision | Trigger |
|---|---|
| Continue to MVP | All validation metrics met; no severe security or integration blocker |
| Reposition to adapter-first | Users value the engine but reject a hosted intermediary; ship the LangGraph and gateway adapters with self-hosted execution and a hosted review UI |
| Reposition to verification-only | Users reject pre-execution review but demand receipts and verification; treat cautiously, this moves toward observability |
| Stop | Native platform approvals suffice; grouped review shows no advantage; teams will not route real writes; the intermediary adds perceived risk; nobody supplies a workflow, repo, intro or payment; correct recovery needs infrastructure beyond solo capacity |

## Rollout

Four phases, each gated on behavior and commitments. The second connector is Jira and ships in Phase 1 so the product is cross-system early and so the exactly-once and verification guarantees land where the public evidence is most severe; the first adapter ships alongside it so Backtrack rides existing adoption rather than competing with it. Notion is the third connector; Linear is deferred until it shows public write incidents or a design partner asks.

Phase 0 is the only phase with a fixed duration; every later phase runs until its gate is met or the go/no-go table says stop.

**Monetization hypothesis.** Do not finalize pricing before validation. Test a team subscription with an execution allowance, with usage charges later if volume scales infrastructure or value. Early options: refundable design-partner deposit, fixed-scope paid pilot, monthly team subscription after reliable weekly use. No lifetime pricing; the product carries ongoing security, support and connector-maintenance obligations.

## Risks

| Risk | Severity | Change from v2 | Mitigation |
|---|---|---|---|
| Linear ships native grouped issue-operation review | High | New, named | Second connector in Phase 1; cross-system transactions are the moat a single platform cannot copy |
| GitHub ships batch review for Copilot agent issue operations | High | New, named | Same as above; keep the GitHub connector thin and replaceable |
| Cloudflare or a framework ships approve-plus-revert as a free primitive | High | New | Ship the Cloudflare and LangGraph adapters; sell diffs, rereads, verification and reviewable compensation on top of their pause |
| A neighbor adds diffs or batching in one release (LangChain, Preloop, MintMCP) | High | New | Lead on G4 and G5, which need a reread engine, not a UI change; ship adapters so their adoption is Backtrack's distribution |
| Build-it-yourself wins in the target segment | High | New | Adoption in under a day via adapters; tested reversible round-trips they would not write themselves |
| Hosted intermediary rejected | High | Reframed | Adapter-first positioning; self-hosted executor in Phase 2 if interviews confirm |
| First workflow is too low-stakes to drive willingness to pay | Medium | New | Interview question on where the last incident lived; second connector chosen from that answer |
| Approval fatigue | High | Unchanged | Group actions, transaction-level risk gating, never review reads |
| "Undo" promise becomes misleading | High | Unchanged | Recovery classes, residual effects stated, no "undo" in external copy |
| Connector semantics vary | High | Unchanged | Narrow connector contract with tested recovery; execute through Nango or Pipedream where possible |
| Partial execution corrupts intent | High | Unchanged | Dependency planning, preconditions, receipts, explicit partial state |
| Agent-supplied evidence is deceptive | Medium | Unchanged | Treat as untrusted; show source data and exact parameters |
| Patent exposure on signed receipts | Medium | New | ScopeBlind lists provisional patents on decision receipts and gateways; obtain a freedom-to-operate review before shipping signed receipts |
| Solo-founder support burden | High | Unchanged | One connector plus one adapter in validation; design partners before expansion |
| Name conflict | High | Raised from Medium | See Naming |
| Approval-layer commoditization: platforms ship deny/ask/allow and pre-execution review for free (Copilot Studio Hooks, Atlassian–OpenAI, OpenAI Dots boundaries) | High | New (Oct 9) | Lead messaging and pricing with G4, G5 and grouped diffs; treat the approval UI as table stakes; make fail-closed behavior a stated contrast with hooks that fail open |
| Rubber-stamp risk: Anthropic reports Claude Code users approve 93% of permission prompts, and manual review caught 13.6% of dangerous commands vs 89% for automated checks | High | New (Oct 9) | Deterministic G4/G5 checks carry the safety, not the human click; risk-ranked diffs, changed-since-last-review view, auto-approval of low-risk items gated by G4/G5 |
| Atlassian builds pre-execution review into Jira's MCP surface | High | New (Oct 6) | Linear is the default second connector; revisit Jira only if Atlassian's agent-work integration ships and leaves verification gaps |
| Regulatory scrutiny: FTC industry-wide probe into agent risks (confirmed Sept 30, 2026) | Medium (tailwind) | New (Oct 9) | Keep receipts append-only, exportable and tamper-evident; raises the value of provable approvals |
| Grouped review has no public demand: zero explicit asks for batch or grouped approval in the October 10 sweep | High | New (Oct 11) | Demoted from headline to surface; measured in Phase 0 by whether community comments mention it unprompted; if nobody does, ship the engine behind existing approval UIs first |
| Stale-state gate is unvalidated: no public incident describes state changing between preview and execute | Medium | New (Oct 11) | Kept because it is nearly free once the verifier exists; fourth beat in demos; never the pitch |
| Validation without interviews yields weaker, more biased signal (developers who file issues, not the RevOps and support leads who may be the buyers) | High | New (Oct 11) | Substitutes chosen for cost-of-action (run a CLI, enter a card) over stated intent; raise the go bar if signals are ambiguous; revisit interviews in Phase 1 |
| Vendors fix the pain themselves: Atlassian patched its MCP duplicates with exactly-once execution; Notion added a destructive-write guard | High | New (Oct 11) | Sell cross-connector guarantees and the receipt, not a single vendor's bug; idempotency and verification must hold across every connector a team uses, which no single vendor patch provides |
| Exactly-once commit is contested by claim: Paragon ActionKit markets idempotency keys, dry runs and duplicate-write checks at the action layer | High | New (Oct 11) | Never lead with G8 alone; lead with the combination (payload-bound approval, reread before, reread after, exactly-once, reviewable compensation); verify Paragon's claims in its API docs and, if real, treat Paragon as a connector backend rather than a rival |
| Exactly-once cannot be promised on every operation: it depends on the target API accepting idempotency keys or on a natural key Backtrack can reread | Medium | New (Oct 11) | Connector contract declares the strategy per operation; receipts state when exactly-once was not guaranteed; no universal claim in marketing |

## Naming

"Backtrack" is a codename only and must be replaced before any public page, repository or marketplace listing. An October 11 check against the USPTO's own TSDR records (primary source for the two marks that matter) found the name blocked for a developer-tool SaaS. EUIPO, WIPO and UK IPO were not reachable or not searched; the mirror-sourced findings below are labeled.

| Mark | Number | Owner | Status | Goods | Class | Source |
|---|---|---|---|---|---|---|
| BACKTRACK | Reg. 1399271 | TEKLYNX NEWCO | Live, renewed 2016; 40-year renewal was due Jul 1, 2026 with grace to about Jan 1, 2027; no filing shown as of Oct 11 | Software for tracking assets and inventory | 9 | USPTO TSDR |
| BACKTRACKS | Reg. 5316738 | Backtracks, Inc. | Live; Sections 8 and 15 accepted May 2023 | Non-downloadable software for podcast analytics (SaaS) | 42 | USPTO TSDR |
| BACKTRAX | Reg. 6257416 | Overall Parts Solutions | Registered 2021; Section 8 window open until Jan 2027 | Automotive-parts inventory software | 9 | Justia mirror |
| SQL-BACKTRACK | Reg. 2991592 | BMC Software | Renewal was due Sep 2025; current status unconfirmed | Database management software | 9 | Justia mirror |
| BACKTRACK | Serial 97144614 | Pioneering Tech Ventures | Unverified; mirror is stale; app now marketed as Foundify | Mobile app | 9 | Justia mirror |
| BACKTRACK | EUTM 010273209 | Bushnell | Registered, renewed 2021 | GPS receivers | 9 | TrademarkElite mirror |
| Backtrack (unregistered) | — | Yac Inc. (usebacktrack.com) | No filing found; active use in commerce for AI meeting software, likely common-law rights | AI meeting intelligence | — | Site and App Store |

**Verdict.** Standalone "Backtrack" is not clearable: an identical live mark covers software in class 9, and a near-identical live mark covers SaaS in class 42, with Yac's common-law use as the closest market overlap. A compound such as "Backtrack Commit" does not help, because "Commit" is descriptive and "Backtrack" stays the dominant element. A compound works only if the added element is distinctive and dominant, at which point that element is the real brand.

**Requirement.** Pick a coined, distinctive public name before the GitHub-issues connector launches. Build a shortlist tied to review, custody, commit or receipts; avoid anything in the undo/rewind/backtrack family and anything implying guaranteed rollback; search domains, GitHub, marketplaces and registries; then have clearance counsel run a full knock-out search (tmsearch.uspto.gov for 2022–2026 filings including BACKTRACKER and phonetic variants, EUIPO eSearch plus, WIPO Global Brand Database, UK IPO, and a common-law search in developer tools and AI agents) on the chosen name, not on Backtrack.

## Open questions and next action

**Resolved by the sweeps, not by interviews.** Whether anyone ships the loop (no); whether approvals alone are sellable (no); whether gateways are rivals or channels (channels); whether the name is usable (no); where the public pain actually is (duplicates and silent no-ops in Jira, Notion, Slack, Zendesk, not grouped review); which connector is second (Jira).

**Still to resolve through validation.**

- [ ] Do reviewers read a grouped diff, or rubber-stamp it the way they rubber-stamp prompts? (Phase 0 community comments; Phase 1 telemetry on time-to-decision and edit rate)
- [ ] Do stale-state races occur in practice when approval queues are long? (Phase 1 conflict-detection rate)
- [ ] Hosted executor, or execution inside the customer's environment, as the first objection? (early-access form question)
- [ ] Which adapter do early users actually run: LangGraph, Claude Code, a gateway, or Cloudflare? (CLI telemetry)
- [ ] Is HubSpot or Salesforce pain real but unreported because CRM admins do not file GitHub issues? (diagnostic-question responses)
- [ ] Which role owns the purchase?
- [ ] How much review latency is tolerable, and is Slack or email notification sufficient instead of synchronous review?
- [ ] Which events must be retained, and for how long?
- [ ] What incident cost establishes willingness to pay? (waitlist card-on-file rate)
- [ ] Fourth competitive pass on what the third pass could not reach: Make, Relay, Lindy, Gumloop, Dust, Glean, Restate, DBOS, Hatchet, the coding platforms (Devin, Cursor, Windsurf, Replit, Factory), Verity, Aurascape, SealGate, Corsair, Archipelo, and a systematic YC S26/F26 and Product Hunt sweep; verify Paragon ActionKit's idempotency semantics (key scope, TTL, same-key-different-payload handling) in its API reference.

**Immediate next action.** Do not begin with production architecture. Build the high-fidelity review flow and the thin GitHub integration in Phase 0, with the duplicate-retry and the verification failure as the two states the prototype must demonstrate for real, packaged as an npx demo anyone can run against their own disposable repository. The first milestone is complete when a test agent submits a grouped change set, a reviewer alters it, the system binds and commits the approved payload exactly once under retry, a planted no-op write is caught by the reread, and the receipt proves the resulting state. Everything else is secondary until strangers run the demo and someone puts a card on file.
