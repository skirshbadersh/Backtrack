# Roadmap: remaining work per PRD v4.1

_Approved plan, October 11, 2026. Owner key: **C** = Claude builds it, **F** = founder only._


## Context
Done so far on `claude/backtrack-prd-v4-pxruum`:
- **Engine.** Approval binding (G3), stale-state gate (G4), verification (G5), compensation (G6), item edit/reject (G7) and exactly-once with crash resume (G8).
- **GitHub connector.** REST transport, App-token auth and an in-memory simulation.
- **CLI demo and web review UI.** The UI covers the sandbox, all required states and a design system.
- **Tests.** 53 unit/API tests and 11 browser checks.

The PRD's first milestone works offline. Still to do: finish Phase 0 for real (live GitHub, `npx`, typed SDK, landing page, validation signals), pass the go/no-go gate, then the conditional 6-week MVP and the Phase 1+ rollout.

**Decisions taken:**
- **MVP stack:** keep the current TypeScript engine and vanilla UI, and add Postgres (Supabase), a durable job runner and hosting behind the existing JSON API. No Next.js rewrite.
- **Public name:** not chosen yet. Anything public (landing page, npm publish, posts, marketplace) is gated on the rename. Everything else proceeds under a placeholder.

**Owner key:** **C** = Claude builds it. **F** = founder only (decisions, accounts, money, legal, posting).

**PRD inconsistency to note:** the main text makes Jira the second connector, but one risk-register row says "Linear is the default second connector". This plan follows the main text (Jira, then Notion, Linear deferred). The stray row in `docs/PRD.md` is annotated as superseded.

---

## Phase 0 remainder (target: the 2-week validation window)

Ordered by dependency. Items 1–5 need no name, so they can start now.

**1. Live GitHub verification (C + F, ~1 day).** The top risk: none of the live path has touched real GitHub.
- F: create a disposable repo, register a GitHub App with Issues read/write and Metadata read, and install it. Give the session a token or App credentials.
- C:
  - Run `npm run demo -- --repo … --yes` and `npm run serve -- --repo … --yes`.
  - Confirm GitHub silently drops a non-assignable assignee. If it doesn't, switch demo beat 4 to a different real no-op, or label it simulated in live mode, as the PRD requires.
  - Fix whatever breaks: pagination, label auto-create, 404 on label removal, request ids.
  - Note that Node's `fetch` ignores `HTTPS_PROXY`.
- C: document least privilege for each endpoint in `docs/github-permissions.md`, as the PRD asks ("permission sets confirmed per endpoint").
- Code: `src/github/rest.ts`, `src/github/app-auth.ts`, `src/demo/run.ts`.

**2. Typed SDK + submit CLI (C, ~1.5 days). ✅ Done Oct 11:** `src/sdk`, `bt-demo submit/status`, agent bearer token, `examples/triage-agent.ts`. The PRD keeps the "typed SDK / CLI" in prototype scope.
- `src/sdk/client.ts`: `submit(changeSet)`, `waitForDecision(id, {timeoutMs})`, `getReceipt(id)`. It polls `GET /api/tx/:id` and fails closed (unreachable server → the write never happens). Zero dependencies.
- Agent auth for the API: a per-workspace bearer token checked in `src/server/api.ts`. It is only needed before the server is reachable beyond loopback.
- CLI: `bt-demo submit file.json [--wait]`, which prints the decision and receipt.
- Reuse `validateChangeSet` (`src/validate.ts`) client-side for early errors.

**3. Claude Code PreToolUse hook for dogfooding (C, ~1 day). ✅ Done Oct 11:** `bt-demo hook claude-code`, see `adapters/claude-code/README.md`. Changed from the plan: the hook always denies the original call and the engine performs the reviewed write, so nothing is written twice or unverified. PRD Days 7–10: "dogfood the Claude Code hook daily".
- `adapters/claude-code/hook.ts` maps a deferred GitHub-issue tool call to a one-action change set through the SDK. It exits non-zero (blocking the tool) unless the transaction ends `verified`.
- Includes a dogfooding log of confusion points (`docs/dogfood-log.md`, F fills it in).
- Marked experimental; no other adapters in Phase 0, per scope.

**4. `npx` packaging (C, ~0.5 day, publish gated on the name). ✅ Done Oct 11:** `src/brand.ts`, `npm run test:pack`.
- Make `npm pack` produce a working tarball (`dist` + `web`, a `prepare` build) and test `npx ./pkg.tgz demo` and `serve` in CI.
- Keep the product name in one constant (`src/brand.ts`) used by the CLI, page title and User-Agent, so the rename is a single edit.

**5. Opt-in CLI telemetry (C, ~1 day). ✅ Done Oct 11:** `src/telemetry`, `docs/telemetry.md`, and a reference collector. It sends nothing until a collector URL exists. Needed for two validation metrics: "3 runs against own repo" and "2 people run it twice".
- It is off by default. A `--telemetry` flag or env variable turns it on, and the first run says what is sent.
- Events: `demo_started`, `demo_completed` with mode (sandbox/live), beat outcomes, an anonymous install id and the version. No payloads, repo names, tokens or titles.
- Collector: a tiny endpoint on the same host as the landing page (item 7). Test that no secret or payload field can be emitted.

**6. 60-second demo recording (C, ~0.5 day).**
- Script the six beats in Playwright with `recordVideo` (Chromium and ffmpeg are already present).
- Output to `docs/media/demo.webm`, with an optional GIF made by ffmpeg.
- Reuse the flow in `e2e/review.e2e.ts`.

**7. Landing page + early access (C builds, F decides and hosts; public launch gated on the name).**
- The hero is the duplicate-retry and verification-failure demo, in the PRD's demo order. It cites Atlassian MCP #132, Notion MCP #258 and GitHub MCP #3426.
- Form: one diagnostic question ("Which system did your last agent mistake touch?"), which system they'd connect, whether they'd pay for a pilot, and whether hosted execution is an objection (an open PRD question).
- Paid-pilot waitlist: Stripe Checkout in setup mode (card on file, no charge). F owns the Stripe account.
- Built as a static page in `site/` with the same tokens as `.interface-design/system.md`, but with a marketing layout. Posts to the collector from item 5. No "undo" language, per the positioning rules.

**8. Rename (F, then C ~0.5 day).**
- F: shortlist names, check domains and registries, have counsel run a knock-out search.
- C: swap `src/brand.ts`, the package name, docs and page. Leave the neutral `bt-idem` marker as is.

**9. Launch and measurement (F, with C support).**
- F: Show HN, r/LangChain, r/ClaudeAI, and the LangChain / Preloop / MCP Discords. Then async follow-ups with everyone who ran the CLI.
- C: `docs/validation-tracker.md` mapping each substitute metric to its threshold and source: 10 qualified runs or forms, 6 diagnostic answers, 5 unprompted correct restatements, 3 own-repo runs, 2 repeat users, 1 card on file. Also a script that summarizes collector data against those thresholds.

**Phase 0 gate (F decides, using the tracker):** continue to MVP, reposition adapter-first, reposition verification-only, or stop, per the PRD go/no-go table. Also record whether community comments mention grouped review unprompted, the PRD's test for that unvalidated pillar.

---

## Conditional MVP (6 weeks, only if the gate says continue)

Each item is C unless noted. The first two are prerequisites for everything else.

**M0. Generalize the connector contract (~2 days).**
- Today's types are GitHub-specific: `ResourceRef = IssueRef`, `Snapshot = IssueSnapshot`, and `Postcondition` fields are issue fields (`src/types.ts`, `src/connector.ts`).
- Change to: `ResourceRef = { kind, connector, id fields }`, snapshot = `Record<string, Json>` with a per-connector field schema, and postconditions as generic `{field, op: equals|includes|excludes|exists, value}`.
- `OperationSpec` stays as is. `evaluatePostcondition`/`pickFields` become generic.
- All existing tests must pass unchanged in behaviour.

**M1. Persistence + fail-closed (~4 days).**
- A `Store` interface pulled out of `Engine` (`#txs`, `Ledger`), with in-memory and Postgres implementations. Tables follow the PRD data model.
- `events` is append-only, enforced by revoking UPDATE/DELETE and a trigger, with the hash chain kept.
- The commit lock becomes a row lock or advisory lock, replacing the in-process `#locks` Set (`src/engine.ts`).
- Execution fails closed if approval, policy or ledger persistence is unavailable (a PRD acceptance criterion). Add tests that kill the DB mid-commit and check that resume works through the existing `#resumeDrift` / in-doubt logic.

**M2. Durable execution (~2 days).** Commit runs as a Trigger.dev or Inngest job. The API returns `queued`, the UI polls through queued → executing → outcome, and a crash or redeploy resumes through the same `commit()` resume path. Benchmark idempotency against Temporal-style Run ID + Activity ID keys, as the PRD notes.

**M3. Workspaces, auth, roles (~3 days).**
- Supabase auth (GitHub OAuth) and submitter / reviewer / administrator roles.
- Reviewer identity comes from the session, replacing `--reviewer`. Agents use per-workspace API keys.
- Approvals record the authenticated actor.

**M4. GitHub App installation flow (~2 days).** An install link plus an installation webhook. Block installation when granted permissions exceed the documented need (PRD risk rule). Per-installation tokens come from the existing `githubAppTokenProvider`.

**M5. Webhooks (~2 days).**
- Verify `X-Hub-Signature-256`, return 2xx within 30s and process asynchronously, validate event and action types, deduplicate by `X-GitHub-Delivery`, and recover missed deliveries through the redelivery API.
- Use issue events to mark pending transactions "changed since preview" before commit, as an early warning layered on the G4 reread.

**M6. Second connector: Jira (~5 days).**
- Operations: transition, assign, labels, fields, comment.
- Idempotency strategy per operation: natural-key reread, plus issue or comment entity properties as markers where no key exists. The receipt says `none` where neither works.
- Reversible round-trip tests, matching `test/roundtrip.test.ts`. Optionally execute through Nango or Pipedream.
- F: a Jira Cloud test site.

**M7. Adapters (~4 days).**
- The LangGraph interrupt adapter (Python), which turns a HITL middleware interrupt into a transaction and resumes with the decision.
- A Python SDK mirroring `src/sdk`.
- An MCP server using the 2026-07-28 multi-round-trip elicitation pattern (pending review → resume). The PRD lists this as a functional requirement.

**M8. Review UX for rubber-stamp risk (~3 days).** PRD mitigations: risk-ranked ordering, a "changed since last review" view, and an optional auto-approve for low-risk reversible items gated by G4/G5. Also wire up the unused `changes_requested` state (send back to agent), inbox filters, and multi-reviewer display. Follow `.interface-design/system.md`.

**M9. Observability and metrics (~2 days).**
- Sentry with payload scrubbing, and PostHog with session replay off on review surfaces and no payloads.
- MVP metrics: time to decision, share modified before commit, planted-bad detection, conflict rate, verified rate, duplicate side effects (should be 0), compensation success, weekly active teams, four-week retention.
- Monitoring and alerts.

**M10. Security pass (~1 day + F).** Run `/security-review`. Secrets in Doppler or 1Password. Document least privilege. F: a patent freedom-to-operate review before any *signed* receipts; current receipts are hash-chained, not signed, so keep them that way until then.

---

## Phase 1+ (each gated on behaviour, per the PRD Rollout)
- **Third connector:** Notion. Linear stays deferred until public write incidents or a design partner asks.
- **Self-hosted executor (Phase 2):** only if hosted execution proves the top objection (form answers). The engine's execute-and-verify half runs in the customer's environment, with the review UI hosted.
- **More adapters:** Cloudflare Code Mode, gateway interceptors (Docker / ToolHive / TrueFoundry / Bifrost), and distribution through gotoHuman, an n8n node, HubSpot and Atlassian Forge.
- **Pricing experiments:** deposit, then paid pilot, then team subscription. F.
- **Research (F, or C via web research):**
  - A fourth competitive pass.
  - Verify Paragon ActionKit's idempotency semantics (key scope, TTL, same-key-different-payload).
  - Revisit interviews with Jira admins and RevOps on stale state and grouped review if 5+ async conversations open up.

---

## Suggested next three steps
1. Live GitHub verification (item 1). It needs F to provide a disposable repo and an App or token.
2. Typed SDK + submit CLI (item 2), then the Claude Code hook (item 3), so dogfooding can start.
3. `npx` packaging + telemetry + recording (items 4–6), so the landing page has a working demo the day the name is cleared.

## Verification (per item)
- Every C item lands with tests in the existing style: `npm run check` (typecheck plus unit and API tests) and `npm run test:e2e` for UI changes.
- Live items are verified by running against the disposable repo, with the receipt and ledger attached.
- Telemetry and analytics get a test asserting no payload or secret fields.
- Connectors must pass reversible round-trip tests before an operation is advertised as reversible.
- Each step is committed and pushed to `claude/backtrack-prd-v4-pxruum`.
