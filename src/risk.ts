import type { NormalizedAction, RiskAssessment, RiskLevel } from "./types.ts";

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, block: 3 };

export const BATCH_OBJECT_LIMIT = 10;

export function maxRisk(levels: Iterable<RiskLevel>): RiskLevel {
  let out: RiskLevel = "low";
  for (const l of levels) if (ORDER[l] > ORDER[out]) out = l;
  return out;
}

export function riskRank(level: RiskLevel): number {
  return ORDER[level];
}

/**
 * Transaction-level risk: the highest included action risk, raised by
 * deterministic batch rules. Every factor is visible to the reviewer;
 * nothing here is model-generated.
 */
export function assessTransactionRisk(actions: readonly NormalizedAction[], objectCount: number): RiskAssessment {
  const factors: string[] = [];
  let level = maxRisk(actions.map((a) => a.risk.level));
  for (const a of actions) {
    if (a.risk.level === level && level !== "low") factors.push(`${a.id}: ${a.risk.factors.join(", ")}`);
  }
  if (objectCount > BATCH_OBJECT_LIMIT) {
    level = maxRisk([level, "high"]);
    factors.push(`batch touches ${objectCount} objects (more than ${BATCH_OBJECT_LIMIT})`);
  }
  if (factors.length === 0) factors.push("only low-risk reversible metadata edits");
  return { level, factors };
}
