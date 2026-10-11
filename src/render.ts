import type { InboxRow } from "./engine.ts";
import type { Conflict, NormalizedAction, Receipt, ResourceRef, Snapshot, Transaction } from "./types.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const style = {
  bold: sgr("1"),
  dim: sgr("2"),
  italic: sgr("3"),
  underline: sgr("4"),
  accent: sgr("36"),
  warn: sgr("33"),
  bad: sgr("31"),
  good: sgr("32"),
};

const ref = (t: ResourceRef) => `${t.owner}/${t.repo}#${t.number}`;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleLength(s)));
const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Risk is shown as a word plus a glyph so it never depends on color alone. */
export function riskTag(level: string): string {
  const text = { low: "LOW ·", medium: "MED ▲", high: "HIGH ▲▲", block: "BLOCK ■" }[level] ?? level;
  return level === "high" || level === "block" ? style.bold(style.warn(text)) : level === "medium" ? style.warn(text) : style.dim(text);
}

export function renderInbox(rows: InboxRow[]): string {
  const lines = [style.bold("Change-set inbox"), ""];
  for (const r of rows) {
    lines.push(
      `${pad(style.bold(r.id), 30)} ${pad(statusTag(r.status), 24)} ${pad(riskTag(r.risk.level), 10)} ${r.included_count}/${r.action_count} actions · ${r.object_count} objects · ${r.repositories.join(", ")}`,
    );
    lines.push(
      style.dim(
        `  ${r.requested_outcome}\n  ${r.source_agent} for ${r.initiator} · reversible ${r.recovery.reversible} · compensatable ${r.recovery.compensatable} · irreversible ${r.recovery.irreversible}` +
          (r.approval_expires_at ? ` · approval expires ${r.approval_expires_at}` : ""),
      ),
    );
  }
  return lines.join("\n");
}

export function statusTag(status: string): string {
  const s = status.replaceAll("_", " ");
  if (status === "verified" || status === "compensated") return style.good(`✓ ${s}`);
  if (["conflicted", "verification_failed", "partially_executed", "failed", "compensation_failed"].includes(status)) return style.bold(style.bad(`✗ ${s}`));
  return `○ ${s}`;
}

export function renderReview(
  tx: Transaction,
  risk: { level: string; factors: string[] },
  preview: Array<{ target: ResourceRef; before: Snapshot; after: Snapshot; actions: NormalizedAction[] }>,
): string {
  const rev = tx.revisions.at(-1)!;
  const lines: string[] = [];
  lines.push(style.bold(`${tx.kind === "compensation" ? "Compensation transaction" : "Transaction"} ${tx.id}`) + style.dim(`  revision ${rev.number} · ${tx.status.replaceAll("_", " ")}`));
  lines.push(`${style.bold("Outcome")}   ${tx.requested_outcome}`);
  lines.push(`${style.bold("Proposed")}  by ${tx.source_agent} for ${tx.initiator}`);
  lines.push(`${style.bold("Risk")}      ${riskTag(risk.level)}  ${style.dim(risk.factors.join("; "))}`);
  if (tx.evidence.length) {
    lines.push("", style.bold("Evidence ") + style.warn("(agent-supplied, untrusted)"));
    for (const e of tx.evidence) lines.push(`  ${style.dim("│")} ${e.label}: ${e.content}${e.source ? style.dim(`  [${e.source}]`) : ""}`);
  }
  for (const obj of preview) {
    lines.push("", style.underline(style.bold(ref(obj.target))) + style.dim(`  "${obj.before.title}"`));
    lines.push(...renderDiff(obj.before, obj.after).map((l) => "    " + l));
    for (const a of obj.actions) {
      const rejected = rev.decisions[a.id] === "reject";
      const mark = rejected ? style.dim("✗ rejected ") : style.accent("✓ included ");
      const summary = rejected ? style.dim(a.summary) : a.summary;
      lines.push(`  ${mark}${pad(style.bold(a.id), 5)} ${pad(riskTag(a.risk.level), 9)} ${pad(a.recovery.class, 14)} ${summary}`);
      const worthStating = a.recovery.class !== "reversible" || a.risk.level !== "low" || tx.kind === "compensation";
      if (!rejected && worthStating && a.recovery.residue.length) lines.push(style.dim(`                                          stays even after recovery: ${a.recovery.residue.join("; ")}`));
    }
  }
  const deps = tx.dependencies.filter((d) => rev.decisions[d.before] !== "reject" && rev.decisions[d.after] !== "reject");
  if (deps.length) lines.push("", style.dim(`Ordering: ${deps.map((d) => `${d.before} before ${d.after}`).join(", ")}`));
  return lines.join("\n");
}

export function renderDiff(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push(`${pad("title", 10)}${style.dim(`"${before.title}"`)}  →  ${style.bold(`"${after.title}"`)}`);
  if (before.state !== after.state) out.push(`${pad("state", 10)}${style.dim(before.state)}  →  ${style.bold(after.state)}${after.state_reason ? style.dim(` (${after.state_reason})`) : ""}`);
  for (const field of ["labels", "assignees"] as const) {
    const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
    const added = after[field].filter((x) => !lower(before[field]).includes(x.toLowerCase()));
    const removed = before[field].filter((x) => !lower(after[field]).includes(x.toLowerCase()));
    if (!added.length && !removed.length) continue;
    const at = field === "assignees" ? "@" : "";
    const parts = [...added.map((x) => style.bold(`+${at}${x}`)), ...removed.map((x) => style.dim(`−${at}${x}`))];
    out.push(`${pad(field, 10)}${parts.join("  ")}`);
  }
  const newComments = after.comment_markers.filter((m) => !before.comment_markers.includes(m)).length;
  if (newComments) out.push(`${pad("comments", 10)}${style.bold(`+${newComments} new comment${newComments > 1 ? "s" : ""}`)} ${style.dim("(notifies subscribers)")}`);
  if (!out.length) out.push(style.dim("no change (all actions on this object rejected)"));
  return out;
}

export function renderConflicts(conflicts: Conflict[]): string {
  const lines = [style.bold(style.bad("✗ Stopped before any write: target changed since preview")), ""];
  for (const c of conflicts) {
    lines.push(`  ${style.bold(c.action_id)} on ${ref(c.target)} · field ${style.bold(c.field)}`);
    lines.push(`    ${pad("previewed", 11)}${fmt(c.previewed)}`);
    lines.push(`    ${pad("current", 11)}${style.bold(fmt(c.current))}  ${style.dim("← changed by someone else")}`);
    lines.push(`    ${pad("proposed", 11)}${fmt(c.proposed)}`);
  }
  lines.push("", style.dim("  The approval is invalidated. Rebase onto the current state and review again."));
  return lines.join("\n");
}

export function renderReceipt(receipt: Receipt): string {
  const lines: string[] = [];
  lines.push(`${style.bold("Receipt")} ${receipt.transaction_id} r${receipt.revision}  ${statusTag(receipt.outcome)}`);
  lines.push(style.dim(`  payload ${receipt.payload_hash.slice(0, 16)}… approved by ${receipt.approval.reviewer} at ${receipt.approval.approved_at} · receipt ${receipt.receipt_hash.slice(0, 16)}…`));
  for (const a of receipt.actions) {
    const v = a.verification.status;
    const vTag = v === "passed" ? style.good("✓ verified") : v === "failed" ? style.bold(style.bad("✗ VERIFICATION FAILED")) : style.dim("– not run");
    lines.push("", `  ${pad(style.bold(a.id), 5)} ${a.summary}  ${vTag}`);
    const attempt = a.attempted.status === "written" ? `written · request ${a.attempted.request_ids.join(", ") || "n/a"}` : a.attempted.status.replaceAll("_", " ");
    lines.push(`        ${pad("proposed", 10)}${fmt(a.proposed)}`);
    lines.push(`        ${pad("approved", 10)}${fmt(a.approved)}`);
    lines.push(`        ${pad("attempted", 10)}${attempt}${a.attempted.status !== "not_attempted" && "error" in a.attempted && a.attempted.error ? style.dim(` (${a.attempted.error})`) : ""}`);
    lines.push(`        ${pad("actual", 10)}${v === "failed" ? style.bold(fmt(a.actual)) : fmt(a.actual)}`);
    if (a.exactly_once === "not_guaranteed") lines.push(style.warn(`        exactly-once NOT guaranteed for ${a.operation} (no idempotency strategy)`));
  }
  if (receipt.rejected_action_ids.length) lines.push("", style.dim(`  rejected by reviewer, never sent: ${receipt.rejected_action_ids.join(", ")}`));
  return lines.join("\n");
}

function fmt(v: unknown): string {
  return JSON.stringify(v);
}
