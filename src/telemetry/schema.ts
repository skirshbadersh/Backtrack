/**
 * Opt-in CLI telemetry: the complete list of what can be sent. Events carry only
 * enums, booleans and small integers, never repository names, issue titles,
 * change-set content, tokens, hostnames, paths or IP addresses. The CLI builds
 * events only through `buildEvent`, and the collector rejects anything that fails
 * `validateEvent`, so a field outside this schema can be neither sent nor stored.
 *
 * Purpose (PRD validation plan): count distinct people who run the demo, how many
 * run it against their own repository (live mode), and how many come back.
 */

export const TELEMETRY_SCHEMA = 1;

export type Mode = "sandbox" | "live";

/** Every value a demo beat outcome may take. Anything else is rejected. */
export const OUTCOME_VALUES = [
  "verified",
  "verification_failed",
  "partially_executed",
  "failed",
  "conflicted",
  "compensated",
  "compensation_pending",
  "compensation_failed",
  "pending_review",
  "approved",
  "expired",
  "rejected",
] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

export const OUTCOME_KEYS = ["triage", "compensation", "triage_after_compensation", "followup_first_commit", "followup_after_rebase"] as const;

export type EventProps =
  | { event: "demo_started"; mode: Mode }
  | {
      event: "demo_completed";
      mode: Mode;
      outcomes: Partial<Record<(typeof OUTCOME_KEYS)[number], OutcomeValue>>;
      duplicate_writes: number;
      conflict_writes_before_stop: number;
      ledger_intact: boolean;
      duration_ms: number;
    }
  | { event: "demo_failed"; mode: Mode }
  | { event: "serve_started"; mode: Mode };

export interface TelemetryEvent {
  schema: typeof TELEMETRY_SCHEMA;
  /** Random id created when telemetry is first enabled on a machine; not derived from anything. */
  install_id: string;
  cli_version: string;
  node_major: number;
  os: "linux" | "darwin" | "win32" | "other";
  /** UTC date only (YYYY-MM-DD); no time of day. */
  day: string;
  props: EventProps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MODES: readonly Mode[] = ["sandbox", "live"];
const OSES = ["linux", "darwin", "win32", "other"] as const;

/** The only way the CLI constructs an event. Unknown outcome values are dropped, numbers clamped. */
export function buildEvent(base: { installId: string; cliVersion: string; now?: Date }, props: EventProps): TelemetryEvent {
  const clean = (() => {
    switch (props.event) {
      case "demo_completed": {
        const outcomes: Record<string, OutcomeValue> = {};
        for (const key of OUTCOME_KEYS) {
          const v = props.outcomes[key];
          if (v && (OUTCOME_VALUES as readonly string[]).includes(v)) outcomes[key] = v;
        }
        return {
          event: props.event,
          mode: props.mode,
          outcomes,
          duplicate_writes: clampInt(props.duplicate_writes, 1000),
          conflict_writes_before_stop: clampInt(props.conflict_writes_before_stop, 1000),
          ledger_intact: props.ledger_intact === true,
          duration_ms: clampInt(props.duration_ms, 3_600_000),
        } satisfies EventProps;
      }
      default:
        return { event: props.event, mode: props.mode } as EventProps;
    }
  })();
  const os = (OSES as readonly string[]).includes(process.platform) ? (process.platform as TelemetryEvent["os"]) : "other";
  return {
    schema: TELEMETRY_SCHEMA,
    install_id: base.installId,
    cli_version: base.cliVersion,
    node_major: Number(process.versions.node.split(".")[0]),
    os,
    day: (base.now ?? new Date()).toISOString().slice(0, 10),
    props: clean,
  };
}

/** Strict structural check used by the collector. Returns problems; empty means valid. */
export function validateEvent(v: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(v)) return ["event must be an object"];
  exactKeys(v, ["schema", "install_id", "cli_version", "node_major", "os", "day", "props"], "$", problems);
  if (v.schema !== TELEMETRY_SCHEMA) problems.push("$.schema: unsupported");
  if (typeof v.install_id !== "string" || !UUID.test(v.install_id)) problems.push("$.install_id: must be a v4 uuid");
  if (typeof v.cli_version !== "string" || !SEMVER.test(v.cli_version)) problems.push("$.cli_version: must be semver");
  if (!Number.isInteger(v.node_major) || (v.node_major as number) < 10 || (v.node_major as number) > 99) problems.push("$.node_major: out of range");
  if (!(OSES as readonly unknown[]).includes(v.os)) problems.push("$.os: unknown");
  if (typeof v.day !== "string" || !DAY.test(v.day)) problems.push("$.day: must be YYYY-MM-DD");
  const p = v.props;
  if (!isObj(p)) return [...problems, "$.props: must be an object"];
  if (!MODES.includes(p.mode as Mode)) problems.push("$.props.mode: unknown");
  switch (p.event) {
    case "demo_started":
    case "demo_failed":
    case "serve_started":
      exactKeys(p, ["event", "mode"], "$.props", problems);
      break;
    case "demo_completed": {
      exactKeys(p, ["event", "mode", "outcomes", "duplicate_writes", "conflict_writes_before_stop", "ledger_intact", "duration_ms"], "$.props", problems);
      if (!isObj(p.outcomes)) problems.push("$.props.outcomes: must be an object");
      else
        for (const [k, val] of Object.entries(p.outcomes)) {
          if (!(OUTCOME_KEYS as readonly string[]).includes(k)) problems.push(`$.props.outcomes.${k}: unknown key`);
          if (!(OUTCOME_VALUES as readonly unknown[]).includes(val)) problems.push(`$.props.outcomes.${k}: unknown value`);
        }
      for (const [k, max] of [["duplicate_writes", 1000], ["conflict_writes_before_stop", 1000], ["duration_ms", 3_600_000]] as const) {
        if (!Number.isInteger(p[k]) || (p[k] as number) < 0 || (p[k] as number) > max) problems.push(`$.props.${k}: out of range`);
      }
      if (typeof p.ledger_intact !== "boolean") problems.push("$.props.ledger_intact: must be boolean");
      break;
    }
    default:
      problems.push("$.props.event: unknown");
  }
  return problems;
}

function clampInt(n: number, max: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, allowed: string[], path: string, problems: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${path}.${k}: not allowed`);
}
