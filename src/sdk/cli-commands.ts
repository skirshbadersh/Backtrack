import { readFileSync } from "node:fs";
import { ReviewClient, SdkError, type Decision } from "./client.ts";
import type { AgentStatus } from "./protocol.ts";

/** Exit codes for `submit --wait` and `status`, so shell agents can branch on them. */
export const EXIT = { verified: 0, submitted: 0, notOk: 3, timeout: 4, waiting: 5, error: 1 } as const;

export interface AgentCliOptions {
  server: string;
  token?: string;
  wait: boolean;
  timeoutSec?: number;
  json: boolean;
  log?: (line: string) => void;
}

export async function submitCommand(file: string | undefined, o: AgentCliOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!file) {
    log("usage: bt-demo submit <change-set.json | -> [--wait] [--server url] [--token t]");
    return EXIT.error;
  }
  const changeSet = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
  const client = new ReviewClient({ baseUrl: o.server, ...(o.token ? { token: o.token } : {}) });
  try {
    const submitted = await client.submit(changeSet);
    if (!o.wait) {
      if (o.json) log(JSON.stringify({ submitted }));
      else log(`${submitted.deduplicated ? "Already submitted" : "Submitted"} ${submitted.transaction_id} (${submitted.status}). Review it at ${o.server.replace(/\/+$/, "")}/#/tx/${encodeURIComponent(submitted.transaction_id)}`);
      return EXIT.submitted;
    }
    if (!o.json) log(`Submitted ${submitted.transaction_id}; waiting for review…`);
    const decision = await client.waitForDecision(submitted.transaction_id, {
      ...(o.timeoutSec ? { timeoutMs: o.timeoutSec * 1000 } : {}),
      onStatus: (s) => {
        if (!o.json) log(`  ${s.status.replaceAll("_", " ")} (revision ${s.revision})`);
      },
    });
    if (o.json) log(JSON.stringify({ submitted, decision }));
    else log(describe(decision));
    return exitFor(decision);
  } catch (err) {
    return fail(err, o, log);
  }
}

export async function statusCommand(id: string | undefined, o: AgentCliOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!id) {
    log("usage: bt-demo status <transaction-id> [--server url] [--token t]");
    return EXIT.error;
  }
  try {
    const status = await new ReviewClient({ baseUrl: o.server, ...(o.token ? { token: o.token } : {}) }).status(id);
    log(o.json ? JSON.stringify(status) : describeStatus(status));
    return status.outcome === "waiting" ? EXIT.waiting : status.ok ? EXIT.verified : EXIT.notOk;
  } catch (err) {
    return fail(err, o, log);
  }
}

function exitFor(d: Decision): number {
  if (d.outcome === "timeout") return EXIT.timeout;
  return d.ok ? EXIT.verified : EXIT.notOk;
}

function describe(d: Decision): string {
  if (d.outcome === "timeout") return `No decision yet (still ${d.status.status.replaceAll("_", " ")}). Nothing has been written unless a reviewer commits.`;
  return describeStatus(d.status);
}

function describeStatus(s: AgentStatus): string {
  const lines = [`${s.transaction_id}: ${s.outcome.replaceAll("_", " ")} (${s.status.replaceAll("_", " ")})`];
  if (s.rejection_reason) lines.push(`  reviewer: ${s.rejection_reason}`);
  if (s.rejected_action_ids.length) lines.push(`  rejected actions, never sent: ${s.rejected_action_ids.join(", ")}`);
  for (const c of s.conflicts) lines.push(`  conflict: ${c.action_id} ${c.field} changed since preview`);
  for (const a of s.receipt?.actions ?? []) {
    const edited = a.proposed && JSON.stringify(a.proposed) !== JSON.stringify(a.approved) ? " (edited by reviewer)" : "";
    lines.push(`  ${a.verification.status === "passed" ? "✓" : a.verification.status === "failed" ? "✗" : "–"} ${a.id} ${a.summary}${edited}`);
  }
  if (s.receipt) lines.push(`  receipt ${s.receipt.receipt_hash.slice(0, 16)}…`);
  return lines.join("\n");
}

function fail(err: unknown, o: AgentCliOptions, log: (l: string) => void): number {
  const e = err instanceof SdkError ? err : new SdkError("error", err instanceof Error ? err.message : String(err));
  if (o.json) log(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }));
  else console.error(`error (${e.code}): ${e.message}`);
  return EXIT.error;
}
