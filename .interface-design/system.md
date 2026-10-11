# Interface design system: change review

The source of truth for values is `web/app.css`. This file records the decisions behind
those values so new screens stay consistent. If the two disagree, fix one deliberately;
don't drift.

## Direction

**Who:** an AI or platform engineer at a 5–50 person company, reviewing what an agent
wants to write to GitHub (later Jira, Notion) before it happens, and checking afterwards
what actually landed. They are careful but busy. They have probably approved hundreds
of prompts without reading them, and this screen has to earn a real look.

**The verb:** decide what may be written, then prove what was written.

**Feel:** a chain-of-custody instrument. It is calm, precise and dense enough for serious
review, and it reads as a narrative: outcome → objects → actions → receipt. It is not
an AI dashboard. No gradients, chat bubbles, glow, decorative icons or three-card SaaS
sections (PRD, Interface requirements).

**Domain vocabulary:** custody, ledger, receipt, stub, seal, commit, carbon copy, red
pencil, revision, payload, precondition and postcondition, residue.

## Signature: the custody rail

Every action is traced through the same sequence, **Proposed → Approved → Attempted →
Actual**, followed by a verdict. It is the receipt table (`.rail-table`). The column
headers carry `→` so the path reads left to right, and a step that diverged is marked in
red pencil.

The signature shows up in these places. Reuse it rather than inventing new comparison
layouts:
1. Receipt table: proposed / approved / attempted / actual / verdict.
2. Conflict table: *you approved against* / *GitHub now* / *would have become*.
3. Diff table per object: *before (GitHub at preview)* / *after commit*.
4. "Edited by reviewer" note where approved ≠ proposed.
5. Receipt stub: perforated (dashed) top edge holding the payload hash, approver, receipt hash and ledger head. It's the "seal" at the end of custody.

The same before → after structure applies to anything new that involves change.

## Color: ledger paper, graphite, carbon copy, red pencil

Same hue family throughout. Surfaces differ only in lightness.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#f7f5ef` | `#181916` | Canvas, rail, commit bar |
| `--paper-raised` | `#fbfaf6` | `#1e1f1b` | Object cards, banners, dialogs, stub |
| `--paper-inset` | `#efece4` | `#131411` | Inputs, evidence, parameter blocks (inset = "receives content") |
| `--graphite` | `#22231f` | `#e8e6de` | Primary text |
| `--graphite-2` | `#45463f` | `#c3c1b8` | Secondary text |
| `--graphite-3` | `#66675f` | `#9c9b92` | Metadata, labels (AA on paper) |
| `--graphite-4` | `#8e8e86` | `#75746c` | Decorative only: strike-through color, arrows. Never body text. |
| `--rule` / `-soft` / `-strong` | 14% / 8% / 30% graphite | 13% / 7% / 28% | Border progression: standard / inner separation / controls and emphasis |
| `--carbon` | `#2f4a8a` | `#93abe8` | **The one accent.** Primary action, selected tab, focus ring, focused action, "edited by reviewer" |
| `--redpencil` | `#b0261d` | `#f0897f` | Only for "not what was approved": conflict, failed verification, failed or partial execution, destructive text buttons |
| `--stamp` | `#2b6646` | `#85c7a3` | Verified, recovered |
| `--amber` | `#85560a` | `#ddb05c` | Risk (medium/high) and the "agent-supplied · not verified" label |

`-wash` variants (7–10% alpha) tint banner and cell backgrounds.

Rules:
- Grey builds structure, and color carries meaning. Don't use color for decoration.
- Carbon is the only accent. Don't add a second brand color.
- Red pencil is reserved, so it keeps its force. Rejected items are **not** red. They are struck through in graphite.
- Color is never the only signal. Risk is a word plus a glyph (`low risk`, `medium risk ▲`, `high risk ▲▲`, `blocked ■`). Statuses carry a glyph (`✓ ✗ ○ ◑ ◐ ↺ –`) and a word. Added and removed chips carry `+`/`−` and screen-reader text.
- Dark mode is defined under `prefers-color-scheme: dark` with the same token names. Semantic colors are lighter and slightly desaturated there.

## Typography

- **Prose:** system UI stack (`--prose`). Body 15px/1.5. Summaries and table text 13–14px.
- **Data:** `ui-monospace` stack (`--data`) with tabular numbers, for everything that is an identifier or a value: action ids, refs (`acme/widgets#184`), hashes, parameters, diff values, chips, tags, status pills, and the ledger.
- **Section labels and table headers:** mono, 11px, uppercase, `letter-spacing: 0.06–0.07em`, `--graphite-3`.
- **Headline (outcome):** 24px, weight 640, `letter-spacing: -0.015em`. Dialog titles are 18px/640.
- **Before/after contrast is typographic, not red/green.** Before values are `--graphite-3` and struck through when changed. After values are weight 620–650 in `--graphite`.
- Quote titles and comment bodies with “curly quotes” when shown as values.

## Depth, shape, spacing

- **Depth: borders only.** No shadows (the dialog backdrop is the only dimming). Elevation is a lightness shift between paper, raised and inset, plus rule borders.
- **Radius:** `--r-sm` 3px for tags, chips, inputs and focus. `--r-md` 5px for buttons, banners and evidence. `--r-lg` 8px for object cards, dialogs and the stub. Technical, not soft.
- **Spacing:** 4px base. Use multiples: 4, 8, 12, 16, 24, 32, 40. Section gaps are 24–32px. Card padding is 12–16px. Main gutter is 40px on desktop and 16px on phone.
- **Banners:** 1px border with a 3px left edge in the semantic color, on a wash background.

## Components and patterns

- **Buttons:** at least 44px tall (`.btn.small` is 32px only with a fine pointer). Variants are default (raised), `primary` (carbon fill, one per view), `quiet` (transparent), and `danger` (red-pencil text, never a red fill).
- **Primary action wording:** **"Commit approved changes"**, never "Approve". Approval and execution are distinct events, and the confirmation dialog says so.
- **Destructive or external-write confirmations** (`<dialog>`) list what will run in order, an amber-edged box of "effects that stay even if you recover later", and the binding line (reviewer · revision · payload hash · expiry). Initial focus goes to **Cancel**.
- **Action row:** a 44px include toggle (a checkbox-like box, `aria-pressed`), then id, summary, tags (risk, recovery class, edited, rejected), the agent's rationale ("Agent: …"), and the residue line ("Stays even after recovery: …"), followed by quiet Edit / Parameters buttons. Residue is shown for non-reversible actions, actions at medium risk or above, and every compensation. Low-risk reversible actions stay quiet.
- **Agent-supplied content** sits in an inset block labeled `AGENT-SUPPLIED · NOT VERIFIED` in amber. Insert it as text only, never as HTML.
- **Status banners** go directly under the header, one per state. Wording leads with what happened to GitHub ("Stopped before any write…", "GitHub accepted every write, but one didn't take effect"), then what to do next, then a single action.
- **Ledger line:** the summary strip under the header as a `dl` of mono uppercase labels over values, divided by soft rules (Objects · Actions · Highest risk · Recovery · Payload).
- **Tabs:** Review / Receipt / Ledger. ARIA tablist with arrow-key navigation and a carbon underline on the selected tab.
- **Commit bar:** sticky at the bottom of the main column. It shows what will be written plus the payload hash, then Reject transaction (quiet danger) and Commit approved changes (primary).
- **Simulation controls:** a dashed border marks them as "not product". They are labeled "Simulation" and sit below the inbox (and below the review on phone).
- **Error copy** comes from a code → (title, sentence) map in `app.js`. It always says whether anything was written.

## States every primary view needs

Loading skeleton (static blocks that breathe gently unless reduced motion is on), empty, permission error, connector unavailable, stale-state conflict, partial execution, verification failure, expired approval, unsupported recovery. Conflict and verification failure get the most design attention, because they're the screens people will screenshot.

## Accessibility and motion

Full keyboard operation (`j`/`k`/`x`/`e`/`p`/`c`/`?`). Visible 2px carbon focus ring. Semantic headings and tables with captions. WCAG AA contrast. 44×44px targets. Motion only communicates state or progress, and is fully disabled under `prefers-reduced-motion`. At phone width there is no horizontal scroll, the receipt rows stack with step labels, and action tools drop below the text.

## Implementation notes

- No framework and no build step: `web/index.html`, `web/app.css`, `web/app.js`. Elements are built with `h()` and replaced with `fill()`, which drops null and false children, so conditionals never render as "null".
- The CSP allows only self-hosted scripts and styles: no inline `style` attributes, no external fonts.
- Every new state needs an e2e assertion in `e2e/review.e2e.ts` and, where it helps, a screenshot (`E2E_SCREENSHOTS=dir npm run test:e2e`).
