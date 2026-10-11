/**
 * The product's public-facing names, in one place. "Backtrack" is a codename
 * that is not clearable as a trademark (docs/PRD.md, Naming); when a public name
 * is chosen, change it here, plus `name` and `bin` in package.json.
 */
export const BRAND = {
  /** Shown in CLI help and notices. */
  productName: "Backtrack (codename)",
  /** The command users type; must match the `bin` key in package.json. */
  cli: "bt-demo",
  /** Sent to GitHub as User-Agent. */
  userAgent: "bt-prototype",
  /** Directory name for per-user config (telemetry choice, install id). */
  configDir: "bt-prototype",
  /**
   * Where opt-in telemetry is sent. Unset until the collector is hosted alongside
   * the landing page (roadmap item 7); BT_TELEMETRY_URL overrides it.
   */
  telemetryUrl: null as string | null,
} as const;
