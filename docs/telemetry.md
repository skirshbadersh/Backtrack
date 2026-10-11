# CLI telemetry (opt-in)

**Off by default.** Nothing is sent unless you turn it on:

```sh
bt-demo telemetry on        # remember the choice
bt-demo demo --telemetry    # just this run (or BT_TELEMETRY=1)
bt-demo telemetry off       # stop, and forget the install id
bt-demo telemetry status
```

`DO_NOT_TRACK=1` or `BT_TELEMETRY=0` always wins over the flag and the saved choice.

## Why it exists

The PRD's validation plan has no interviews. It counts behaviour instead:

- distinct people who run the demo;
- how many run it against their own repository (live mode);
- how many come back and run it again.

Those thresholds (10 runs, 3 own-repo runs, 2 repeat users) can't be measured without a
count. That count is all this telemetry provides.

## Exactly what is sent

One small JSON event per milestone:

| Field | Example | Notes |
|---|---|---|
| `props.event` | `demo_started`, `demo_completed`, `demo_failed`, `serve_started` | |
| `props.mode` | `sandbox` or `live` | `live` means `--repo` was used; the repo name is not sent |
| `props.outcomes` | `{"triage": "verification_failed", …}` | Demo beat results, from a fixed list of status words |
| `props.duplicate_writes`, `props.conflict_writes_before_stop` | `0` | Integers, capped at 1000 |
| `props.ledger_intact` | `true` | |
| `props.duration_ms` | `2140` | Capped at one hour |
| `install_id` | random UUID | Created when telemetry is first turned on, stored in `~/.config/bt-prototype/telemetry.json`, deleted by `telemetry off` |
| `cli_version`, `node_major`, `os` | `0.1.0`, `22`, `linux` | `os` is the family only |
| `day` | `2026-10-11` | UTC date, no time of day |

**Never sent:** repository or owner names, issue titles or numbers, change-set content,
reviewer names, tokens, file paths, hostnames, IP addresses.

The schema is enforced twice:
- The CLI can only build events through an allowlist (`src/telemetry/schema.ts`).
- The collector rejects any event with an unknown field or value (`src/telemetry/collector.ts`).

Tests check that hostile input (a repo name, a token, free text) never reaches the wire.

## Delivery

- One attempt with a 1.5-second timeout. Failures are silent and never affect the demo.
- The first time telemetry is on, the CLI prints exactly what it sends.
- No collector is hosted yet (roadmap item 7, alongside the landing page), so `BRAND.telemetryUrl` is unset. Turning telemetry on sends nothing, and the CLI says so. `BT_TELEMETRY_URL` points it at a collector.

## Collector

`bt-demo collector --out events.jsonl --port 4318` runs the reference collector, meant
for the landing-page host:
- It accepts `POST /v1/events` and validates each event against the schema.
- It appends valid events as JSON lines.
- It stores no IP address, user agent or time of day.
