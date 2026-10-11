import { canonicalize, sha256 } from "../../canonical.ts";
import type { ReviewClient } from "../../sdk/client.ts";
import { SdkError } from "../../sdk/client.ts";
import type { AgentStatus } from "../../sdk/protocol.ts";
import { SCHEMA_VERSION, type ActionInput, type ChangeSetInput, type IssueRef } from "../../types.ts";

/**
 * Claude Code PreToolUse hook (experimental, for dogfooding).
 *
 * It intercepts GitHub issue writes made through the official GitHub MCP server
 * and routes them through review. It always DENIES the original tool call: on
 * approval the engine performs the reviewed write itself, then rereads to verify,
 * so letting the tool run as well would write twice and skip verification. The
 * deny reason tells Claude exactly what happened (verified, rejected, still
 * pending, or nothing written).
 *
 * It fails closed: an unsupported field, an unreachable server or an internal
 * error all deny the call with nothing written. Claude Code itself fails OPEN
 * when a hook times out or crashes, so the hook stops waiting before its own
 * timeout, and the settings should also set `"onFailure": "block"`.
 */

export const INTERCEPTED_TOOLS = ["mcp__github__issue_write", "mcp__github__add_issue_comment"] as const;

export interface PreToolUseInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
}

export interface HookDeps {
  client: ReviewClient;
  /** Stop waiting for the reviewer after this long; must be below the hook timeout in settings. */
  waitMs: number;
  workspaceId: string;
  initiator: string;
  serverUrl: string;
  pollIntervalMs?: number;
}

type Mapping = { kind: "actions"; target: IssueRef; actions: ActionInput[]; what: string[] } | { kind: "unsupported"; reason: string } | { kind: "noop"; target: IssueRef };

const ISSUE_WRITE_FIELDS = new Set(["method", "owner", "repo", "issue_number", "title", "state", "state_reason", "labels", "assignees"]);
const COMMENT_FIELDS = new Set(["owner", "repo", "issue_number", "body"]);

export function deny(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** Returns null for tools this hook does not handle, so Claude Code proceeds normally. */
export async function handlePreToolUse(raw: unknown, deps: HookDeps): Promise<HookOutput | null> {
  const input = (raw ?? {}) as PreToolUseInput;
  if (!input.tool_name || !(INTERCEPTED_TOOLS as readonly string[]).includes(input.tool_name)) return null;
  const toolInput = input.tool_input ?? {};
  // Identical retries of the same call in the same session map to the same transaction, so a
  // retried tool call waits on (or returns) the original review instead of proposing it twice.
  const txId = `cc-${sha256(`${input.session_id ?? "no-session"}\n${input.tool_name}\n${canonicalize(toolInput)}`).slice(0, 24)}`;

  try {
    const existing = await deps.client.status(txId).catch((err: unknown) => {
      if (err instanceof SdkError && err.code === "not_found") return null;
      throw err;
    });
    if (existing) return await waitAndReport(txId, deps, true);

    const mapping = await mapToolCall(input.tool_name, toolInput, deps.client);
    if (mapping.kind === "unsupported") return deny(`Not executed: ${mapping.reason} Nothing was written. Writes through this tool are routed through human review, which supports titles, open/close, labels, assignees and plain comments on existing issues.`);
    if (mapping.kind === "noop") return deny(`Nothing to change: ${ref(mapping.target)} is already in the requested state. Nothing was written, and no retry is needed.`);

    const changeSet: ChangeSetInput = {
      schema_version: SCHEMA_VERSION,
      transaction_id: txId,
      workspace_id: deps.workspaceId,
      source_agent: `claude-code${input.session_id ? `@${input.session_id.slice(0, 8)}` : ""}`,
      initiator: deps.initiator,
      requested_outcome: `Claude Code: ${mapping.what.join(", ")} on ${ref(mapping.target)}`,
      connector: "github",
      actions: mapping.actions,
      evidence: [{ label: "Original tool call", content: `${input.tool_name} ${truncate(JSON.stringify(toolInput), 600)}`, source: "Claude Code PreToolUse hook" }],
    };
    await deps.client.submit(changeSet);
    return await waitAndReport(txId, deps, false);
  } catch (err) {
    if (err instanceof SdkError && err.code === "unreachable") {
      return deny(`Not executed: the review server at ${deps.serverUrl} is unreachable, so this write was blocked (fail closed). Nothing was written.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return deny(`Not executed: the review hook failed (${message}). Nothing was written.`);
  }
}

/** Translates a GitHub MCP tool call into change-set actions, or explains why it can't. */
export async function mapToolCall(toolName: string, t: Record<string, unknown>, client: Pick<ReviewClient, "readIssue">): Promise<Mapping> {
  if (toolName === "mcp__github__issue_write" && t.method !== "update") return { kind: "unsupported", reason: "creating issues is not routed through review yet." };
  const target = issueRef(t);
  if (typeof target === "string") return { kind: "unsupported", reason: target };

  if (toolName === "mcp__github__add_issue_comment") {
    if (t.reaction !== undefined || t.comment_id !== undefined) return { kind: "unsupported", reason: "reactions are not routed through review yet." };
    const extra = Object.keys(t).filter((k) => !COMMENT_FIELDS.has(k));
    if (extra.length) return { kind: "unsupported", reason: `unsupported field(s) ${extra.join(", ")}.` };
    if (typeof t.body !== "string" || !t.body.trim()) return { kind: "unsupported", reason: "a comment needs a non-empty body." };
    return { kind: "actions", target, actions: [{ id: "comment", operation: "issue.add_comment", target, params: { body: t.body } }], what: ["comment"] };
  }

  // mcp__github__issue_write, method "update"
  const extra = Object.keys(t).filter((k) => !ISSUE_WRITE_FIELDS.has(k) && t[k] !== undefined);
  if (extra.length) return { kind: "unsupported", reason: `field(s) ${extra.join(", ")} cannot be reviewed yet, so the whole call was blocked rather than applied partially.` };

  const actions: ActionInput[] = [];
  const what: string[] = [];
  if (t.title !== undefined) {
    if (typeof t.title !== "string") return { kind: "unsupported", reason: "title must be a string." };
    actions.push({ id: "title", operation: "issue.update_title", target, params: { title: t.title } });
    what.push("rename");
  }
  if (t.state !== undefined) {
    if (t.state !== "open" && t.state !== "closed") return { kind: "unsupported", reason: 'state must be "open" or "closed".' };
    if (t.state_reason === "duplicate") return { kind: "unsupported", reason: "closing as duplicate is not supported yet; close as completed or not_planned and comment instead." };
    const params = t.state === "open" ? { state: "open", state_reason: "reopened" } : { state: "closed", state_reason: t.state_reason ?? "completed" };
    actions.push({ id: "state", operation: "issue.set_state", target, params });
    what.push(t.state === "open" ? "reopen" : "close");
  }
  if (t.labels !== undefined || t.assignees !== undefined) {
    // The tool replaces the whole set; review needs explicit adds and removes.
    const current = await client.readIssue(target);
    for (const [field, op] of [["labels", "labels"], ["assignees", "assignees"]] as const) {
      const desired = t[field];
      if (desired === undefined) continue;
      if (!Array.isArray(desired) || !desired.every((x) => typeof x === "string")) return { kind: "unsupported", reason: `${field} must be an array of strings.` };
      const norm = (xs: readonly string[]) => xs.map((x) => (field === "assignees" ? x.replace(/^@/, "") : x).toLowerCase());
      const have = norm(current[field]);
      const want = norm(desired);
      const add = desired.filter((_, i) => !have.includes(want[i]!));
      const remove = current[field].filter((_, i) => !want.includes(have[i]!));
      if (add.length) actions.push({ id: `${op}-add`, operation: `issue.add_${op}`, target, params: { [op]: add } });
      if (remove.length) actions.push({ id: `${op}-remove`, operation: `issue.remove_${op}`, target, params: { [op]: remove } });
      if (add.length || remove.length) what.push(field === "labels" ? "relabel" : "reassign");
    }
  }
  if (!actions.length) return t.title === undefined && t.state === undefined && t.labels === undefined && t.assignees === undefined ? { kind: "unsupported", reason: "the call changes nothing reviewable." } : { kind: "noop", target };
  return { kind: "actions", target, actions, what };
}

async function waitAndReport(txId: string, deps: HookDeps, resumed: boolean): Promise<HookOutput> {
  const decision = await deps.client.waitForDecision(txId, { timeoutMs: deps.waitMs, ...(deps.pollIntervalMs ? { pollIntervalMs: deps.pollIntervalMs } : {}) });
  const review = `${deps.serverUrl.replace(/\/+$/, "")}/#/tx/${encodeURIComponent(txId)}`;
  const s = decision.status;
  const prefix = resumed ? `This identical call was already proposed as ${txId}. ` : `This call was intercepted and proposed for review as ${txId}. `;
  switch (decision.outcome) {
    case "verified":
      return deny(`${prefix}OUTCOME: VERIFIED. A reviewer approved it, it was executed through review, and a reread confirmed GitHub is in the approved state. The change is already in place: do not call the tool again.${details(s)}`);
    case "not_verified":
      return deny(`${prefix}OUTCOME: NOT VERIFIED. It was executed, but the reread shows GitHub is not in the approved state. Do not retry blindly; tell the user.${details(s)}`);
    case "rejected":
      return deny(`${prefix}OUTCOME: REJECTED by the reviewer${s.rejection_reason ? `: "${s.rejection_reason}"` : ""}. Nothing was written. Do not retry the same change.`);
    case "expired":
      return deny(`${prefix}OUTCOME: EXPIRED before anyone committed it. Nothing was written.`);
    case "compensated":
      return deny(`${prefix}OUTCOME: executed, then partly or fully reverted by the reviewer. Check with the user before acting on it.${details(s)}`);
    case "timeout":
      return deny(`${prefix}OUTCOME: STILL AWAITING REVIEW (${s.status.replaceAll("_", " ")}). Nothing has been written yet, but a reviewer may still commit it at ${review}. Retrying the identical call will check again instead of proposing it twice.`);
  }
}

function details(s: AgentStatus): string {
  if (!s.receipt) return "";
  const lines = s.receipt.actions.map((a) => {
    const edited = a.proposed && JSON.stringify(a.proposed) !== JSON.stringify(a.approved) ? ` (edited by reviewer to ${JSON.stringify(a.approved)})` : "";
    const mark = a.verification.status === "passed" ? "verified" : a.verification.status === "failed" ? "NOT in approved state" : "not run";
    return `- ${a.summary}: ${mark}${edited}`;
  });
  if (s.rejected_action_ids.length) lines.push(`- rejected by reviewer, never sent: ${s.rejected_action_ids.join(", ")}`);
  return `\nReceipt ${s.receipt.receipt_hash.slice(0, 16)}:\n${lines.join("\n")}`;
}

function issueRef(t: Record<string, unknown>): IssueRef | string {
  const { owner, repo, issue_number } = t;
  if (typeof owner !== "string" || typeof repo !== "string") return "owner and repo are required.";
  if (typeof issue_number !== "number" || !Number.isInteger(issue_number) || issue_number < 1) return "issue_number must be a positive integer.";
  return { kind: "github.issue", owner, repo, number: issue_number };
}

function ref(t: IssueRef): string {
  return `${t.owner}/${t.repo}#${t.number}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
