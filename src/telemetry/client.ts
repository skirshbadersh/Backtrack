import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../brand.ts";
import { buildEvent, type EventProps } from "./schema.ts";

interface StoredConfig {
  enabled: boolean;
  install_id?: string;
  notice_shown?: boolean;
}

export interface TelemetryContext {
  enabled: boolean;
  /** Why it is on or off, for `telemetry status`. */
  reason: string;
  url: string | null;
  send(props: EventProps): Promise<void>;
}

export const NOTICE = `Telemetry is ON (opt-in). Each run sends: an event name (demo_started, demo_completed,
demo_failed, serve_started), sandbox vs live mode, demo beat outcomes (e.g. "verified"),
write counts, a random install id, the CLI version, the Node major version, the OS family
and the date. Never sent: repository names, issue titles, change-set content, tokens,
paths, hostnames. Turn it off with: ${BRAND.cli} telemetry off  (or DO_NOT_TRACK=1)`;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BT_CONFIG_DIR) return env.BT_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, BRAND.configDir);
}

function configPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "telemetry.json");
}

function readConfig(env: NodeJS.ProcessEnv): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), "utf8")) as StoredConfig;
    return { enabled: parsed.enabled === true, ...(parsed.install_id ? { install_id: parsed.install_id } : {}), ...(parsed.notice_shown ? { notice_shown: true } : {}) };
  } catch {
    return { enabled: false };
  }
}

function writeConfig(env: NodeJS.ProcessEnv, c: StoredConfig): void {
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(configPath(env), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/** Persists the user's choice. The install id is created only when telemetry is turned on. */
export function setTelemetry(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const c = readConfig(env);
  writeConfig(env, enabled ? { ...c, enabled: true, install_id: c.install_id ?? randomUUID() } : { enabled: false, ...(c.notice_shown ? { notice_shown: true } : {}) });
}

export function cliVersion(): string {
  try {
    // src/telemetry → package root, and dist/telemetry → package root.
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/**
 * Resolves whether telemetry is on for this run. Off by default. Precedence:
 * DO_NOT_TRACK=1 or BT_TELEMETRY=0 (off) > --telemetry flag or BT_TELEMETRY=1 (on for
 * this run) > the stored choice from `telemetry on|off`.
 */
export function telemetry(opts: { flag?: boolean; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number; notify?: (msg: string) => void } = {}): TelemetryContext {
  const env = opts.env ?? process.env;
  const url = env.BT_TELEMETRY_URL || BRAND.telemetryUrl;
  const stored = readConfig(env);
  let enabled: boolean;
  let reason: string;
  if (env.DO_NOT_TRACK === "1" || env.BT_TELEMETRY === "0") [enabled, reason] = [false, env.DO_NOT_TRACK === "1" ? "DO_NOT_TRACK=1" : "BT_TELEMETRY=0"];
  else if (opts.flag || env.BT_TELEMETRY === "1") [enabled, reason] = [true, opts.flag ? "--telemetry flag" : "BT_TELEMETRY=1"];
  else [enabled, reason] = [stored.enabled, stored.enabled ? `turned on with '${BRAND.cli} telemetry on'` : "off by default"];

  const off: TelemetryContext = { enabled: false, reason, url, send: async () => {} };
  if (!enabled) return off;

  const notify = opts.notify ?? ((m: string) => console.error(m));
  // Enabling (by flag, env or stored choice) creates the install id once and shows the notice once.
  let config = stored;
  if (!config.install_id || !config.notice_shown) {
    config = { ...config, install_id: config.install_id ?? randomUUID(), notice_shown: true };
    notify(NOTICE);
    try {
      writeConfig(env, { ...config, enabled: stored.enabled });
    } catch {
      // An unwritable home directory must never break the CLI; the id is then per-run.
    }
  }
  if (!url) {
    notify("Telemetry is on, but no collector is configured yet (set BT_TELEMETRY_URL); nothing will be sent.");
    return { ...off, enabled: true, reason };
  }
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const base = { installId: config.install_id!, cliVersion: cliVersion() };
  return {
    enabled: true,
    reason,
    url,
    // Best effort: one attempt, short timeout, never throws, never blocks the CLI for long.
    async send(props) {
      try {
        await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildEvent(base, props)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Telemetry failures are invisible by design.
      }
    },
  };
}
