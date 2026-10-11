// Review UI for the change-set engine. No framework, no build step.
// Everything agent-supplied is inserted as text nodes only, never as HTML.

const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren that skips null/false, so conditional children never render as "null". */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

// ------------------------------------------------------------------ state

const state = {
  app: null,
  detail: null,
  txId: null,
  tab: "review",
  editing: null,
  openParams: new Set(),
  picks: new Set(),
  focused: null,
  busy: false,
};

const OPEN = ["pending_review", "changes_requested", "approved", "conflicted"];
const COMPENSATABLE = ["verified", "verification_failed", "partially_executed", "compensation_failed"];
const BAD = ["conflicted", "verification_failed", "partially_executed", "failed", "compensation_failed"];
const GOOD = ["verified", "compensated"];

const GLYPH = {
  pending_review: "○", changes_requested: "○", approved: "◑", queued: "◐", executing: "◐",
  conflicted: "✗", verification_failed: "✗", partially_executed: "✗", failed: "✗", compensation_failed: "✗",
  verified: "✓", compensated: "↺", compensation_pending: "↺", rejected: "–", expired: "–", draft: "○",
};

const ERRORS = {
  connector_unavailable: ["GitHub can't be reached", "Nothing was written. Reads and writes resume once the connection is back."],
  permission_error: ["GitHub refused the request", "The installation is missing a permission for this repository. Nothing further was written."],
  approval_expired: ["The approval expired before the commit ran", "Approvals last 30 minutes. Check the current state and commit again."],
  approval_invalid: ["That approval no longer matches this transaction", "Something changed after approval. Review it again."],
  stale_revision: ["This transaction changed while you were reviewing", "You're now looking at the latest revision. Check it before continuing."],
  transaction_expired: ["This change set has expired", "The agent's deadline passed. Ask the agent to propose it again."],
  commit_in_progress: ["A commit is already running", "Its receipt will appear here when it finishes."],
  not_compensatable: ["Recovery isn't available for that selection", ""],
  contradictory_actions: ["That edit would make two actions undo each other", ""],
  invalid_change_set: ["That edit isn't valid", ""],
  nothing_to_approve: ["Every action is rejected", "Reject the whole transaction instead."],
  blocked_by_policy: ["Policy blocks one or more actions", ""],
};

// -------------------------------------------------------------------- api

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (method !== "GET") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw Object.assign(new Error("The review server can't be reached."), { code: "server_unreachable", details: [] });
  }
  const data = await res.json().catch(() => ({ error: { code: "internal", message: "Unreadable response from the server." } }));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? res.statusText), { code: data.error?.code, details: data.error?.details ?? [] });
  return data;
}

// ----------------------------------------------------------------- notices

function notice(kind, title, body, details = []) {
  const region = $("#notice");
  const box = h(
    "div",
    { class: `banner ${kind}`, role: kind === "bad" ? "alert" : "status" },
    h("h2", null, title),
    body ? h("p", null, body) : null,
    details.length ? h("ul", null, details.map((d) => h("li", null, d))) : null,
    h("div", { class: "actions" }, h("button", { class: "btn small quiet", type: "button", onclick: () => fill(region) }, "Dismiss")),
  );
  fill(region, box);
}

function showError(err) {
  const [title, body] = ERRORS[err.code] ?? ["Something went wrong", err.message];
  notice("bad", title, body || err.message, err.details ?? []);
}

function clearNotice() {
  fill($("#notice"));
}

// ------------------------------------------------------------- formatting

function rel(iso) {
  const ms = Date.parse(iso) - Date.now();
  const mins = Math.round(Math.abs(ms) / 60000);
  const span = mins < 1 ? "less than a minute" : mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

function time(iso) {
  return h("time", { datetime: iso, title: new Date(iso).toLocaleString() }, rel(iso));
}

function words(s) {
  return String(s).replaceAll("_", " ");
}

function statusPill(status) {
  const cls = GOOD.includes(status) ? "good" : BAD.includes(status) ? "bad" : status === "approved" ? "live" : "";
  return h("span", { class: `status ${cls}` }, h("span", { "aria-hidden": "true" }, GLYPH[status] ?? "○"), words(status));
}

function riskTag(level) {
  const text = { low: "low risk", medium: "medium risk ▲", high: "high risk ▲▲", block: "blocked ■" }[level] ?? level;
  return h("span", { class: `tag risk-${level}` }, text);
}

function recoveryTag(cls) {
  const text = { reversible: "reversible", compensatable: "compensatable only", irreversible: "irreversible · no recovery" }[cls] ?? cls;
  return h("span", { class: "tag", title: RECOVERY_HELP[cls] }, text);
}

const RECOVERY_HELP = {
  reversible: "The prior state can be restored with a supported, tested operation.",
  compensatable: "The action stands; a corrective action can reduce harm.",
  irreversible: "No reliable restoration or compensation exists.",
};

function ref(t) {
  return `${t.owner}/${t.repo}#${t.number}`;
}

function short(hash, n = 12) {
  return hash ? `${hash.slice(0, n)}…` : "—";
}

function fmtParams(op, p) {
  if (!p) return "—";
  if ("title" in p) return `“${p.title}”`;
  if ("labels" in p) return `${op?.includes("remove") ? "−" : "+"} ${p.labels.join(", ")}`;
  if ("assignees" in p) return `${op?.includes("remove") ? "−" : "+"} ${p.assignees.map((a) => "@" + a).join(", ")}`;
  if ("body" in p) return `“${p.body.length > 70 ? p.body.slice(0, 67) + "…" : p.body}”`;
  if ("state" in p) return `${p.state}${p.state_reason ? ` (${words(p.state_reason)})` : ""}`;
  return JSON.stringify(p);
}

function fmtActual(actual) {
  if (!actual) return "—";
  const parts = [];
  if ("title" in actual) parts.push(`“${actual.title}”`);
  if ("state" in actual) parts.push(actual.state);
  if ("labels" in actual) parts.push(actual.labels.length ? actual.labels.join(", ") : "no labels");
  if ("assignees" in actual) parts.push(actual.assignees.length ? actual.assignees.map((a) => "@" + a).join(", ") : "nobody assigned");
  if ("comment_markers" in actual) parts.push(`${actual.comment_markers.length} marked comment${actual.comment_markers.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function fmtPostcondition(p) {
  if (p.field === "comment_markers") return "expected the comment to be present";
  if (p.op === "equals") return `expected ${p.field} to be “${p.value}”`;
  return `expected ${p.field} to ${p.op === "includes" ? "include" : "exclude"} ${p.field === "assignees" ? "@" : ""}${p.value}`;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------- rail

function renderRail() {
  const app = state.app;
  const mode = $("#mode");
  mode.textContent = app.mode.kind === "live" ? `live · ${app.mode.repo}` : "sandbox";
  mode.classList.toggle("live", app.mode.kind === "live");
  $("#whoami").textContent = `Reviewing as ${app.reviewer}`;

  const inbox = $("#inbox");
  inbox.removeAttribute("aria-busy");
  if (!app.inbox.length) {
    fill(inbox, h("p", { class: "inbox-empty" }, "No change sets yet. Agents submit them to POST /api/change-sets; they appear here for review."));
  } else {
    fill(inbox, 
      ...app.inbox.map((row) =>
        h(
          "a",
          { class: "inbox-item", href: `#/tx/${enc(row.id)}`, "aria-current": row.id === state.txId ? "page" : null },
          h("span", { class: "glyph", "aria-hidden": "true" }, GLYPH[row.status] ?? "○"),
          h("span", { class: "title" }, row.requested_outcome),
          h("span", { class: "sub" }, `${words(row.status)} · ${row.included_count}/${row.action_count} actions · ${row.object_count} objects · ${row.risk.level} risk`),
          h("span", { class: "id" }, row.kind === "compensation" ? `${row.id} · recovery` : row.id),
        ),
      ),
    );
  }
  renderSandbox();
}

function renderSandbox() {
  const box = $("#sandbox");
  const sb = state.app.sandbox;
  if (!sb) return box.setAttribute("hidden", "");
  box.removeAttribute("hidden");
  const tx = state.detail?.transaction;
  const canDrift = tx && ["pending_review", "approved"].includes(tx.status);
  const canRetry = tx && tx.receipt;
  const control = (name, label, opts = {}) =>
    h("button", { class: "btn small", type: "button", disabled: opts.disabled, "aria-pressed": opts.pressed, title: opts.title, onclick: () => runControl(name) }, label);
  fill(box, 
    h("h2", null, "Simulation"),
    h("p", null, "Stand-ins for events outside the reviewer's control. Not product features."),
    h(
      "div",
      { class: "controls" },
      control("drift", "Teammate edits a target", { disabled: !canDrift, title: canDrift ? null : "Open a transaction that is pending review or approved" }),
      control("client-retry", "Agent client retries the commit", { disabled: !canRetry, title: canRetry ? null : "Commit a transaction first" }),
      control("outage", sb.outage ? "GitHub outage: on" : "GitHub outage: off", { pressed: sb.outage ? "true" : "false" }),
      control("fast-forward", `Fast-forward clock 31 min${sb.clock_offset_minutes ? ` (+${sb.clock_offset_minutes})` : ""}`),
      control("follow-up", "Agent submits a follow-up"),
      control("reset", "Reset sandbox"),
    ),
  );
}

async function runControl(name) {
  try {
    const res = await api("POST", `/sandbox/${name}`, { transaction_id: state.txId });
    await refresh();
    notice("note", "Simulation", res.message);
    if (name === "reset") openDefault(true);
  } catch (err) {
    showError(err);
    await refresh().catch(() => {});
  }
}

// ------------------------------------------------------------------- view

function renderView() {
  const view = $("#view");
  const focusKey = document.activeElement?.dataset?.focusKey;
  if (!state.detail) {
    fill(view, 
      h(
        "div",
        { class: "empty" },
        h("h1", null, state.app?.inbox.length ? "Pick a change set to review" : "Nothing to review"),
        h("p", null, state.app?.inbox.length ? "Each change set groups everything one agent request would write. Open one from the inbox." : "When an agent proposes writes, they arrive here grouped as one transaction."),
      ),
    );
    return;
  }
  const d = state.detail;
  const tx = d.transaction;
  const panels = { review: renderReview, receipt: renderReceipt, ledger: renderLedger };
  if (state.tab === "receipt" && !tx.receipt) state.tab = "review";
  const parts = [renderHeader(d), ...renderBanners(d), renderLedgerLine(d), renderTabs(d), h("div", { id: "panel", role: "tabpanel", "aria-labelledby": `tab-${state.tab}` }, panels[state.tab](d)), renderCommitBar(d)];
  fill(view, ...parts.filter(Boolean));
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function renderHeader(d) {
  const tx = d.transaction;
  const rev = tx.revisions.at(-1);
  return h(
    "header",
    null,
    h(
      "div",
      { class: "crumbs" },
      h("span", null, "Inbox"),
      h("span", { "aria-hidden": "true" }, "/"),
      h("span", { class: "mono" }, tx.id),
      h("span", { "aria-hidden": "true" }, "·"),
      h("span", null, `revision ${rev.number}`),
      tx.kind === "compensation" ? h("span", { class: "tag" }, "recovery transaction") : null,
    ),
    h("h1", { class: "outcome", tabindex: "-1", id: "outcome" }, tx.requested_outcome),
    h(
      "p",
      { class: "byline" },
      "Proposed by ",
      h("strong", null, tx.source_agent),
      " for ",
      h("strong", null, tx.initiator),
      " · ",
      time(tx.created_at),
      " · ",
      statusPill(tx.status),
    ),
  );
}

function link(id) {
  return h("a", { href: `#/tx/${enc(id)}`, class: "mono" }, id);
}

function renderBanners(d) {
  const tx = d.transaction;
  const out = [];
  const receipt = tx.receipt;

  if (tx.kind === "compensation" && d.parent) {
    out.push(
      h(
        "section",
        { class: "banner note" },
        h("h2", null, "Recovery is a new transaction"),
        h("p", null, "This compensates actions from ", link(d.parent.id), ". Nothing runs until you commit it, and it goes through the same stale-state check and verification."),
      ),
    );
  }

  switch (tx.status) {
    case "conflicted":
      out.push(
        h(
          "section",
          { class: "banner bad", "aria-labelledby": "conflict-title" },
          h("h2", { id: "conflict-title" }, "Stopped before any write: GitHub changed after approval"),
          h("p", null, "Nothing was sent to GitHub and the approval is void. Compare what you approved with GitHub's current state, then rebase and review again."),
          conflictTable(d.conflicts),
          h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: rebase }, "Rebase onto current state")),
        ),
      );
      break;
    case "verification_failed": {
      const failed = receipt.actions.filter((a) => a.verification.status === "failed");
      out.push(
        h(
          "section",
          { class: "banner bad" },
          h("h2", null, `GitHub accepted every write, but ${failed.length === 1 ? "one didn't" : `${failed.length} didn't`} take effect`),
          h("p", null, "A success response isn't proof. Rereading GitHub after the commit shows these actions are not in the approved state:"),
          h("ul", null, failed.map((a) => h("li", null, h("b", null, a.id), " ", a.summary, " — ", a.verification.failed.map(fmtPostcondition).join("; "), ", found ", fmtActual(a.actual)))),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => setTab("receipt") }, "Open the receipt")),
        ),
      );
      break;
    }
    case "partially_executed":
    case "failed": {
      const bad = receipt.actions.find((a) => a.attempted.status === "failed");
      out.push(
        h(
          "section",
          { class: "banner bad" },
          h("h2", null, tx.status === "failed" ? "Nothing was applied: GitHub rejected the first write" : "Stopped partway: GitHub rejected a write"),
          h("p", null, bad ? `${bad.id} failed: ${bad.attempted.error}. Actions after it were never sent.` : "Actions after the failure were never sent."),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => setTab("receipt") }, "Open the receipt")),
        ),
      );
      break;
    }
    case "verified":
      out.push(h("section", { class: "banner good" }, h("h2", null, "Verified: GitHub is in the state you approved"), h("p", null, "Every declared postcondition held when GitHub was reread after the commit.")));
      break;
    case "compensation_pending":
    case "compensated":
    case "compensation_failed": {
      const child = d.children.at(-1);
      const map = {
        compensation_pending: ["note", "Recovery proposed, waiting for review", "Review and commit it in "],
        compensated: ["good", "Recovered", "The compensation was committed and verified in "],
        compensation_failed: ["bad", "Recovery did not complete", "See what happened in "],
      };
      const [kind, title, lead] = map[tx.status];
      out.push(h("section", { class: `banner ${kind}` }, h("h2", null, title), h("p", null, lead, child ? link(child.id) : "the recovery transaction", ".")));
      break;
    }
    case "rejected":
      out.push(h("section", { class: "banner note" }, h("h2", null, "Rejected"), h("p", null, "Nothing in this change set was written.")));
      break;
    case "expired":
      out.push(h("section", { class: "banner note" }, h("h2", null, "Expired"), h("p", null, "The change set passed its deadline before it was committed. Nothing was written.")));
      break;
    case "approved":
      if (d.active_approval) {
        out.push(
          h(
            "section",
            { class: "banner note" },
            h("h2", null, "Approved, not yet committed"),
            h("p", null, "The approval is bound to payload ", h("code", null, short(d.active_approval.payload_hash, 16)), " and expires ", time(d.active_approval.expires_at), ". Any edit voids it."),
          ),
        );
      }
      break;
    case "pending_review": {
      const last = tx.approvals.at(-1);
      if (last?.status === "expired") {
        out.push(h("section", { class: "banner note" }, h("h2", null, "The earlier approval expired"), h("p", null, "Approvals last 30 minutes. Check the objects below against what you expect, then commit again.")));
      } else if (last?.status === "invalidated" && tx.revisions.at(-1).reason.startsWith("rebased")) {
        out.push(h("section", { class: "banner note" }, h("h2", null, "Rebased onto GitHub's current state"), h("p", null, "The before column now shows what GitHub holds today. Review the result before committing again.")));
      }
      break;
    }
  }
  return out;
}

function conflictTable(conflicts) {
  return h(
    "table",
    { class: "conflict-table" },
    h("caption", { class: "visually-hidden" }, "Fields that changed since preview"),
    h("thead", null, h("tr", null, ["Action", "Field", "You approved against", "GitHub now", "Would have become"].map((t) => h("th", { scope: "col" }, t)))),
    h(
      "tbody",
      null,
      conflicts.map((c) =>
        h(
          "tr",
          null,
          h("td", null, h("span", { class: "mono" }, c.action_id), " · ", ref(c.target)),
          h("td", { class: "mono" }, c.field),
          h("td", null, h("span", { class: "val" }, fmtField(c.previewed))),
          h("td", { class: "current" }, h("span", { class: "val" }, fmtField(c.current)), h("span", { class: "visually-hidden" }, " (changed by someone else)")),
          h("td", null, h("span", { class: "val" }, fmtField(c.proposed))),
        ),
      ),
    ),
  );
}

function fmtField(v) {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  if (typeof v === "string") return `“${v}”`;
  return JSON.stringify(v);
}

function renderLedgerLine(d) {
  const tx = d.transaction;
  const rev = tx.revisions.at(-1);
  const included = rev.actions.filter((a) => rev.decisions[a.id] !== "reject");
  const rec = { reversible: 0, compensatable: 0, irreversible: 0 };
  for (const a of included) rec[a.recovery.class]++;
  const item = (label, ...value) => h("div", null, h("dt", null, label), h("dd", null, ...value));
  return h(
    "dl",
    { class: "ledger-line" },
    item("Objects", String(d.preview.length)),
    item("Actions", `${included.length} of ${rev.actions.length} included`),
    item("Highest risk", h("span", { title: d.risk.factors.join("\n") }, riskTag(d.risk.level))),
    item("Recovery", `${rec.reversible} reversible · ${rec.compensatable} compensatable · ${rec.irreversible} irreversible`),
    tx.receipt ? item("Committed payload", h("span", { class: "mono" }, short(tx.receipt.payload_hash))) : item("Payload", h("span", { class: "mono", title: d.payload_hash ?? "" }, short(d.payload_hash))),
  );
}

function renderTabs(d) {
  const tx = d.transaction;
  const tabs = [
    ["review", "Review", null],
    tx.receipt ? ["receipt", "Receipt", null] : null,
    ["ledger", "Ledger", String(d.events.length)],
  ].filter(Boolean);
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Transaction views", onkeydown: tabKeys },
    tabs.map(([id, label, count]) =>
      h(
        "button",
        { class: "tab", role: "tab", id: `tab-${id}`, type: "button", "aria-selected": state.tab === id ? "true" : "false", tabindex: state.tab === id ? "0" : "-1", "data-focus-key": `tab-${id}`, onclick: () => setTab(id) },
        label,
        count ? h("span", { class: "count" }, count) : null,
      ),
    ),
  );
}

function tabKeys(e) {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const tabs = [...e.currentTarget.querySelectorAll("[role=tab]")];
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  next.click();
  $(`#${next.id}`)?.focus();
}

function setTab(id) {
  state.tab = id;
  renderView();
}

// ----------------------------------------------------------------- review

function editable(tx) {
  return OPEN.includes(tx.status);
}

function renderReview(d) {
  const tx = d.transaction;
  const rev = tx.revisions.at(-1);
  const parts = [];
  if (tx.evidence.length) {
    parts.push(
      h("h2", { class: "section-label" }, "Why the agent proposed this"),
      h(
        "div",
        { class: "evidence" },
        h("span", { class: "untrusted" }, "Agent-supplied · not verified"),
        h("ul", null, tx.evidence.map((e) => h("li", null, h("b", null, e.label, ": "), e.content, e.source ? h("span", { class: "src" }, `  [${e.source}]`) : null))),
      ),
    );
  }
  parts.push(h("h2", { class: "section-label" }, `Affected objects (${d.preview.length})`));
  for (const obj of d.preview) parts.push(renderObject(tx, rev, obj));
  const deps = tx.dependencies.filter((x) => rev.decisions[x.before] !== "reject" && rev.decisions[x.after] !== "reject");
  if (deps.length) parts.push(h("p", { class: "ordering" }, "Runs in order: ", deps.map((x) => `${x.before} before ${x.after}`).join(", "), "."));
  return h("div", null, parts);
}

function renderObject(tx, rev, obj) {
  return h(
    "section",
    { class: "object", "aria-label": ref(obj.target) },
    h("div", { class: "object-head" }, h("span", { class: "ref" }, ref(obj.target)), h("span", { class: "was" }, `“${obj.before.title}”`)),
    diffTable(obj.before, obj.after),
    h("ul", { class: "actions-list" }, obj.actions.map((a) => renderAction(tx, rev, a))),
  );
}

function diffTable(before, after) {
  const rows = [];
  const scalar = (label, b, a, fmt = (v) => v) =>
    rows.push(
      h(
        "tr",
        null,
        h("th", { scope: "row" }, label),
        h("td", { class: "before" }, h("span", { class: "val changed" }, fmt(b))),
        h("td", { class: "after" }, h("span", { class: "val changed" }, fmt(a))),
      ),
    );
  if (before.title !== after.title) scalar("title", before.title, after.title, (v) => `“${v}”`);
  if (before.state !== after.state) scalar("state", before.state, after.state, (v) => (v === after.state && after.state_reason ? `${v} (${words(after.state_reason)})` : v));
  for (const field of ["labels", "assignees"]) {
    const lower = (xs) => xs.map((x) => x.toLowerCase());
    const added = after[field].filter((x) => !lower(before[field]).includes(x.toLowerCase()));
    const removed = before[field].filter((x) => !lower(after[field]).includes(x.toLowerCase()));
    if (!added.length && !removed.length) continue;
    const at = field === "assignees" ? "@" : "";
    const chip = (x, kind) => h("span", { class: `chip ${kind ?? ""}` }, `${at}${x}`, kind ? h("span", { class: "visually-hidden" }, ` (${kind})`) : null);
    rows.push(
      h(
        "tr",
        null,
        h("th", { scope: "row" }, field),
        h("td", { class: "before" }, h("div", { class: "chips" }, before[field].length ? before[field].map((x) => chip(x, removed.includes(x) ? "removed" : null)) : h("span", { class: "val" }, "(none)"))),
        h("td", { class: "after" }, h("div", { class: "chips" }, after[field].length ? after[field].map((x) => chip(x, added.includes(x) ? "added" : null)) : h("span", { class: "val" }, "(none)"))),
      ),
    );
  }
  const newComments = after.comment_markers.filter((m) => !before.comment_markers.includes(m)).length;
  if (newComments) {
    rows.push(
      h("tr", null, h("th", { scope: "row" }, "comments"), h("td", { class: "before" }, h("span", { class: "val" }, "—")), h("td", { class: "after" }, h("span", { class: "val changed" }, `+${newComments} new, notifies subscribers`))),
    );
  }
  if (!rows.length) rows.push(h("tr", { class: "nochange" }, h("td", { colspan: "3" }, "No change: every action on this object is rejected.")));
  return h(
    "table",
    { class: "diff" },
    h("thead", null, h("tr", null, h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Field")), h("th", { scope: "col" }, "Before (GitHub at preview)"), h("th", { scope: "col" }, "After commit"))),
    h("tbody", null, rows),
  );
}

function renderAction(tx, rev, a) {
  const included = rev.decisions[a.id] !== "reject";
  const canEdit = editable(tx);
  const edited = tx.proposed_params[a.id] && !same(tx.proposed_params[a.id], a.params);
  const showResidue = included && a.recovery.residue.length && (a.recovery.class !== "reversible" || a.risk.level !== "low" || tx.kind === "compensation");
  const paramsOpen = state.openParams.has(a.id);
  const li = h(
    "li",
    { class: `action${included ? "" : " rejected"}${state.focused === a.id ? " focused" : ""}`, "data-action": a.id },
    h(
      "button",
      {
        class: "toggle",
        type: "button",
        "aria-pressed": included ? "true" : "false",
        "aria-label": `${included ? "Included" : "Rejected"}: ${a.id}. ${included ? "Reject" : "Restore"} this action`,
        disabled: !canEdit,
        "data-focus-key": `toggle-${a.id}`,
        onclick: () => decide(a.id, included ? "reject" : "include"),
        onfocus: () => (state.focused = a.id),
      },
      h("span", { class: "box", "aria-hidden": "true" }, included ? "✓" : ""),
    ),
    h(
      "div",
      { class: "action-main" },
      h("div", { class: "action-line" }, h("span", { class: "action-id" }, a.id), h("span", { class: "summary" }, a.summary)),
      h("div", { class: "tags" }, riskTag(a.risk.level), recoveryTag(a.recovery.class), edited ? h("span", { class: "tag edited" }, "edited by reviewer") : null, included ? null : h("span", { class: "tag" }, "rejected · will not be sent")),
      a.rationale ? h("p", { class: "rationale" }, a.rationale) : null,
      showResidue ? h("p", { class: "residue" }, a.recovery.residue.join("; ")) : null,
    ),
    h(
      "div",
      { class: "action-tools" },
      canEdit && EDITORS[a.operation]
        ? h("button", { class: "btn small quiet", type: "button", "data-focus-key": `edit-${a.id}`, "data-role": "edit", "aria-expanded": state.editing === a.id ? "true" : "false", onclick: () => toggleEdit(a.id) }, "Edit")
        : null,
      h("button", { class: "btn small quiet", type: "button", "data-focus-key": `params-${a.id}`, "data-role": "params", "aria-expanded": paramsOpen ? "true" : "false", onclick: () => toggleParams(a.id) }, "Parameters"),
    ),
  );
  if (state.editing === a.id) li.append(editForm(a));
  if (paramsOpen) {
    li.append(
      h(
        "div",
        { class: "params" },
        h(
          "pre",
          { "aria-label": `Exact normalized parameters for ${a.id}` },
          JSON.stringify(
            { operation: a.operation, target: a.target, params: a.params, idempotency_key: a.idempotency_key, idempotency_strategy: a.idempotency_strategy, precondition: a.precondition, postconditions: a.postconditions },
            null,
            2,
          ),
        ),
      ),
    );
  }
  return li;
}

const EDITORS = {
  "issue.update_title": { fields: [["title", "Title", "text"]], read: (p) => ({ title: p.title }), write: (v) => ({ title: v.title }) },
  "issue.add_comment": { fields: [["body", "Comment", "textarea"]], read: (p) => ({ body: p.body }), write: (v) => ({ body: v.body }) },
  "issue.add_labels": { fields: [["labels", "Labels (comma-separated)", "text"]], read: (p) => ({ labels: p.labels.join(", ") }), write: (v) => ({ labels: list(v.labels) }) },
  "issue.remove_labels": { fields: [["labels", "Labels (comma-separated)", "text"]], read: (p) => ({ labels: p.labels.join(", ") }), write: (v) => ({ labels: list(v.labels) }) },
  "issue.add_assignees": { fields: [["assignees", "Logins (comma-separated)", "text"]], read: (p) => ({ assignees: p.assignees.join(", ") }), write: (v) => ({ assignees: list(v.assignees) }) },
  "issue.remove_assignees": { fields: [["assignees", "Logins (comma-separated)", "text"]], read: (p) => ({ assignees: p.assignees.join(", ") }), write: (v) => ({ assignees: list(v.assignees) }) },
  "issue.set_state": {
    fields: [["state", "State", ["open", "closed"]], ["state_reason", "Reason", ["completed", "not_planned", "reopened"]]],
    read: (p) => ({ state: p.state, state_reason: p.state_reason }),
    write: (v) => ({ state: v.state, state_reason: v.state === "open" ? "reopened" : v.state_reason === "reopened" ? "completed" : v.state_reason }),
  },
};

function list(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function editForm(a) {
  const ed = EDITORS[a.operation];
  const values = ed.read(a.params);
  const form = h("form", { class: "edit-form", "aria-label": `Edit ${a.id}`, onsubmit: (e) => (e.preventDefault(), saveEdit(a.id, form, ed)) });
  for (const [name, label, kind] of ed.fields) {
    const id = `edit-${a.id}-${name}`;
    form.append(h("label", { for: id }, label));
    if (Array.isArray(kind)) form.append(h("select", { class: "field", id, name }, kind.map((o) => h("option", { value: o, selected: values[name] === o }, words(o)))));
    else if (kind === "textarea") form.append(h("textarea", { class: "field", id, name }, values[name]));
    else form.append(h("input", { class: "field", id, name, type: "text", value: values[name], autocomplete: "off" }));
  }
  form.append(
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save edit"), h("button", { class: "btn quiet", type: "button", onclick: () => toggleEdit(a.id) }, "Cancel")),
  );
  if (state.detail.transaction.status === "approved") form.prepend(h("p", { class: "ordering" }, "Saving voids the current approval."));
  queueMicrotask(() => form.querySelector(".field")?.focus());
  return form;
}

function toggleEdit(id) {
  state.editing = state.editing === id ? null : id;
  renderView();
  if (!state.editing) document.querySelector(`[data-focus-key="edit-${CSS.escape(id)}"]`)?.focus();
}

function toggleParams(id) {
  state.openParams.has(id) ? state.openParams.delete(id) : state.openParams.add(id);
  renderView();
}

async function saveEdit(actionId, form, ed) {
  const values = Object.fromEntries(new FormData(form).entries());
  await mutate("edit", { action_id: actionId, params: ed.write(values) }, () => {
    state.editing = null;
  });
  document.querySelector(`[data-focus-key="edit-${CSS.escape(actionId)}"]`)?.focus();
}

async function decide(actionId, decision) {
  await mutate("decision", { action_id: actionId, decision });
}

async function rebase() {
  await mutate("rebase", {});
  notice("note", "Rebased", "The preview now reflects GitHub's current state. Review it, then commit again.");
}

/** POST a review mutation bound to the revision on screen, then re-render. */
async function mutate(verb, body, onOk) {
  if (state.busy) return;
  state.busy = true;
  try {
    const rev = state.detail.transaction.revisions.at(-1).number;
    state.detail = await api("POST", `/tx/${enc(state.txId)}/${verb}`, { ...body, revision: rev });
    clearNotice();
    onOk?.();
    await refreshApp();
    renderView();
  } catch (err) {
    showError(err);
    await reloadDetail();
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------- commit bar

function renderCommitBar(d) {
  const tx = d.transaction;
  if (!["pending_review", "approved"].includes(tx.status)) return null;
  const rev = tx.revisions.at(-1);
  const included = rev.actions.filter((a) => rev.decisions[a.id] !== "reject");
  const blocked = included.some((a) => a.risk.level === "block");
  return h(
    "div",
    { class: "commit-bar", role: "region", "aria-label": "Commit" },
    h(
      "p",
      { class: "what" },
      included.length ? `${included.length} of ${rev.actions.length} actions will be written to GitHub` : "Every action is rejected",
      h("span", { class: "mono" }, ` · payload ${short(d.payload_hash)}`),
    ),
    h("button", { class: "btn quiet danger", type: "button", onclick: openRejectDialog }, "Reject transaction"),
    h("button", { class: "btn primary", type: "button", id: "commit", disabled: !included.length || blocked, onclick: openCommitDialog }, "Commit approved changes"),
  );
}

function openCommitDialog() {
  const d = state.detail;
  const tx = d.transaction;
  if (!["pending_review", "approved"].includes(tx.status)) return;
  const rev = tx.revisions.at(-1);
  const byId = Object.fromEntries(rev.actions.map((a) => [a.id, a]));
  const order = d.execution_order.map((id) => byId[id]).filter(Boolean);
  if (!order.length) return;
  const lasting = [...new Set(order.filter((a) => a.recovery.class !== "reversible" || a.risk.level !== "low").flatMap((a) => a.recovery.residue))];
  const repos = [...new Set(order.map((a) => `${a.target.owner}/${a.target.repo}`))].join(", ");
  const dlg = $("#confirm");
  fill(dlg, 
    h("h2", { id: "confirm-title" }, "Commit approved changes"),
    h("p", null, `This writes to ${repos} on GitHub now. Approval and execution are recorded as separate events, bound to the exact payload below. GitHub is reread first; if anything changed since your preview, nothing is written.`),
    h("ol", null, order.map((a) => h("li", null, h("span", { class: "mono" }, a.id), " ", a.summary))),
    lasting.length ? h("div", { class: "lasting" }, h("b", null, "These effects stay even if you recover later:"), h("ul", null, lasting.map((r) => h("li", null, r)))) : null,
    h("p", { class: "binding" }, `reviewer ${state.app.reviewer} · revision ${rev.number} · payload sha256 ${d.payload_hash} · approval valid 30 min`),
    h(
      "div",
      { class: "confirm-actions" },
      h("button", { class: "btn", type: "button", id: "confirm-cancel", onclick: () => dlg.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "button", onclick: () => commit(order.length) }, "Commit approved changes"),
    ),
  );
  dlg.showModal();
  $("#confirm-cancel").focus();
}

async function commit(count) {
  const dlg = $("#confirm");
  const d = state.detail;
  const tx = d.transaction;
  const steps = [
    h("li", { class: "active" }, "Bind approval to the payload"),
    h("li", null, `Reread GitHub, write ${count} action${count === 1 ? "" : "s"}, reread to verify`),
    h("li", null, "Issue receipt"),
  ];
  fill(dlg, h("h2", { id: "confirm-title" }, "Committing…"), h("ol", { class: "steps", "aria-live": "polite" }, steps));
  try {
    const approvalId = d.active_approval && tx.status === "approved" ? d.active_approval.id : (await api("POST", `/tx/${enc(tx.id)}/approve`, { revision: tx.revisions.at(-1).number })).approval.id;
    steps[0].className = "done";
    steps[1].className = "active";
    const { result, detail } = await api("POST", `/tx/${enc(tx.id)}/commit`, { approval_id: approvalId });
    steps[1].className = "done";
    steps[2].className = "done";
    state.detail = detail;
    state.tab = result.outcome === "committed" ? "receipt" : "review";
    dlg.close();
    clearNotice();
    await refreshApp();
    renderView();
    $("#outcome")?.focus();
  } catch (err) {
    dlg.close();
    showError(err);
    await refresh();
  }
}

function openRejectDialog() {
  const dlg = $("#confirm");
  const reason = h("textarea", { class: "field", id: "reject-reason", placeholder: "Optional: tell the agent why" });
  fill(dlg, 
    h("h2", { id: "confirm-title" }, "Reject the whole transaction?"),
    h("p", null, "Nothing in it will be written. The agent can propose a new change set."),
    h("label", { for: "reject-reason", class: "visually-hidden" }, "Reason"),
    reason,
    h(
      "div",
      { class: "confirm-actions" },
      h("button", { class: "btn", type: "button", id: "confirm-cancel", onclick: () => dlg.close() }, "Keep reviewing"),
      h(
        "button",
        {
          class: "btn danger",
          type: "button",
          onclick: async () => {
            dlg.close();
            await mutate("reject", { reason: reason.value });
          },
        },
        "Reject transaction",
      ),
    ),
  );
  dlg.showModal();
  $("#confirm-cancel").focus();
}

// ---------------------------------------------------------------- receipt

function renderReceipt(d) {
  const tx = d.transaction;
  const r = tx.receipt;
  const canPick = tx.kind === "change" && COMPENSATABLE.includes(tx.status);
  const rev = tx.revisions.find((x) => x.number === r.revision);
  const recovery = Object.fromEntries(rev.actions.map((a) => [a.id, a.recovery.class]));
  const steps = ["Proposed", "Approved", "Attempted", "Actual"];

  const rows = r.actions.map((a) => {
    const edited = a.proposed && !same(a.proposed, a.approved);
    const diverged = a.verification.status === "failed";
    const executed = a.attempted.status === "written" || a.attempted.status === "already_applied";
    const pickable = canPick && executed && recovery[a.id] !== "irreversible";
    const attempted = {
      written: ["written", a.attempted.request_ids.length ? `request ${a.attempted.request_ids.join(", ")}` : a.attempted.error ?? ""],
      already_applied: ["already in place", "reread showed the effect; no write sent"],
      failed: ["rejected by GitHub", a.attempted.error ?? ""],
      in_doubt: ["in doubt", "resolved on the next resume"],
      not_attempted: ["never sent", "execution stopped earlier"],
    }[a.attempted.status];
    const verdict =
      a.verification.status === "passed"
        ? h("span", { class: "verdict good" }, "✓ verified")
        : diverged
          ? h("span", { class: "verdict bad" }, "✗ not in approved state")
          : h("span", { class: "verdict muted" }, "– not checked");
    return h(
      "tr",
      { class: executed ? "" : "not-run" },
      canPick
        ? h(
            "td",
            { class: "pick" },
            h("input", {
              type: "checkbox",
              "aria-label": `Select ${a.id} for compensation`,
              disabled: !pickable,
              title: pickable ? null : recovery[a.id] === "irreversible" ? "Irreversible: no recovery exists" : "This action was never applied",
              checked: state.picks.has(a.id),
              onchange: (e) => (e.target.checked ? state.picks.add(a.id) : state.picks.delete(a.id), renderView()),
            }),
          )
        : null,
      h("td", { class: "who" }, h("span", { class: "action-id" }, a.id), h("span", { class: "summary" }, a.summary)),
      h("td", { class: "cell", "data-step": "Proposed" }, h("span", { class: "val" }, fmtParams(a.operation, a.proposed))),
      h("td", { class: `cell${edited ? " edited" : ""}`, "data-step": "Approved" }, h("span", { class: "val" }, fmtParams(a.operation, a.approved)), edited ? h("span", { class: "note" }, "edited by reviewer") : null),
      h("td", { class: "cell", "data-step": "Attempted" }, h("span", { class: "val" }, attempted[0]), attempted[1] ? h("span", { class: "note" }, attempted[1]) : null),
      h(
        "td",
        { class: `cell${diverged ? " diverged" : ""}`, "data-step": "Actual" },
        h("span", { class: "val" }, executed ? fmtActual(a.actual) : "—"),
        diverged ? h("span", { class: "note" }, `did not take effect: ${a.verification.failed.map(fmtPostcondition).join("; ")}`) : null,
      ),
      h("td", { "data-step": "Verdict" }, verdict),
    );
  });

  const notGuaranteed = r.actions.filter((a) => a.exactly_once === "not_guaranteed");
  const strategies = [...new Set(r.actions.map((a) => words(a.idempotency_strategy)))].join(", ");
  return h(
    "div",
    null,
    h(
      "table",
      { class: "rail-table" },
      h("caption", { class: "visually-hidden" }, "Each action from proposal to the state GitHub actually holds"),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          canPick ? h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Select")) : null,
          h("th", { scope: "col", class: "who" }, "Action"),
          steps.map((s) => h("th", { scope: "col", class: "step" }, s)),
          h("th", { scope: "col" }, "Verdict"),
        ),
      ),
      h("tbody", null, rows),
    ),
    r.rejected_action_ids.length ? h("p", { class: "ordering" }, `Rejected by the reviewer and never sent: ${r.rejected_action_ids.join(", ")}.`) : null,
    canPick
      ? h(
          "div",
          { class: "compensate-bar" },
          h("button", { class: "btn", type: "button", disabled: !state.picks.size, onclick: proposeCompensation }, `Propose compensation${state.picks.size ? ` for ${[...state.picks].join(", ")}` : ""}`),
          h("p", null, "Creates a new transaction for review. Nothing runs until you commit it."),
        )
      : null,
    h(
      "div",
      { class: "stub", "aria-label": "Receipt" },
      h("div", { class: "seal" }, statusPill(r.outcome), h("b", null, "Receipt")),
      h(
        "dl",
        null,
        [
          ["Transaction", `${r.transaction_id} · revision ${r.revision}`],
          ["Payload", `sha256 ${r.payload_hash}`],
          ["Approved by", `${r.approval.reviewer} at ${new Date(r.approval.approved_at).toLocaleString()}`],
          ["Approval", r.approval.id],
          ["Policy", r.approval.policy_version],
          ["Issued", new Date(r.issued_at).toLocaleString()],
          ["Exactly-once", notGuaranteed.length ? `not guaranteed for ${notGuaranteed.map((a) => a.id).join(", ")}` : `guaranteed for all ${r.actions.length} actions (${strategies})`],
          ["Receipt hash", r.receipt_hash],
          ["Ledger head", r.ledger_head],
        ].flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]),
      ),
    ),
  );
}

async function proposeCompensation() {
  if (state.busy) return;
  state.busy = true;
  try {
    const res = await api("POST", `/tx/${enc(state.txId)}/compensate`, { action_ids: [...state.picks] });
    state.picks.clear();
    if (res.skipped.length) notice("note", "Some actions need no recovery", "", res.skipped.map((s) => `${s.action_id}: ${s.reason}`));
    else clearNotice();
    location.hash = `#/tx/${enc(res.transaction_id)}`;
  } catch (err) {
    showError(err);
  } finally {
    state.busy = false;
  }
}

// ----------------------------------------------------------------- ledger

const IMPORTANT = new Set(["approval_created", "approval_invalidated", "approval_expired", "precondition_conflicted", "action_failed", "verification_failed", "receipt_issued", "commit_replayed", "submit_deduplicated", "compensation_proposed", "action_already_applied"]);

function renderLedger(d) {
  return h(
    "div",
    null,
    h("p", { class: `chain ${d.ledger_intact ? "good" : "bad"}` }, d.ledger_intact ? "✓ Hash chain intact across the whole ledger" : "✗ Hash chain broken: the ledger was altered"),
    h(
      "table",
      { class: "events" },
      h("caption", { class: "visually-hidden" }, "Append-only events for this transaction"),
      h("thead", null, h("tr", null, ["#", "When", "Event", "Actor", "Details", "Hash"].map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        null,
        d.events.map((e) =>
          h(
            "tr",
            { class: IMPORTANT.has(e.type) ? "important" : "" },
            h("td", null, String(e.seq)),
            h("td", null, h("time", { datetime: e.at, title: e.at }, new Date(e.at).toLocaleTimeString())),
            h("td", null, words(e.type)),
            h("td", null, e.actor),
            h("td", { class: "data" }, summarizeData(e)),
            h("td", { title: e.hash }, short(e.hash, 8)),
          ),
        ),
      ),
    ),
  );
}

function summarizeData(e) {
  const d = e.data;
  if (e.type === "status_changed") return `${words(d.from)} → ${words(d.to)}`;
  const s = JSON.stringify(d);
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}

// -------------------------------------------------------------- keyboard

function visibleActions() {
  return [...document.querySelectorAll("#panel .action")];
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (e.key === "?") return void $("#help").showModal();
  if (!state.detail) return;
  const rows = visibleActions();
  const current = rows.findIndex((r) => r.dataset.action === state.focused);
  const focusRow = (i) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    state.focused = row.dataset.action;
    rows.forEach((r) => r.classList.toggle("focused", r === row));
    (row.querySelector(".toggle:not([disabled])") ?? row.querySelector("button"))?.focus();
    row.scrollIntoView({ block: "nearest" });
  };
  const row = rows[current];
  switch (e.key) {
    case "j":
      focusRow(current + 1);
      break;
    case "k":
      focusRow(current < 0 ? 0 : current - 1);
      break;
    case "x":
      row?.querySelector(".toggle:not([disabled])")?.click();
      break;
    case "e":
      row?.querySelector('[data-role="edit"]')?.click();
      break;
    case "p":
      row?.querySelector('[data-role="params"]')?.click();
      break;
    case "c":
      if (!$("#commit")?.disabled) openCommitDialog();
      break;
    default:
      return;
  }
  e.preventDefault();
});

$("#help").addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) $("#help").close();
});

// ----------------------------------------------------------------- routing

async function refreshApp() {
  state.app = await api("GET", "/state");
  renderRail();
}

async function reloadDetail() {
  if (!state.txId) return;
  try {
    state.detail = await api("GET", `/tx/${enc(state.txId)}`);
  } catch (err) {
    if (err.code === "not_found") {
      state.detail = null;
      state.txId = null;
    } else throw err;
  }
  renderView();
}

async function refresh() {
  await refreshApp();
  await reloadDetail();
  renderRail();
}

async function route() {
  const m = /^#\/tx\/(.+)$/.exec(location.hash);
  const id = m ? decodeURIComponent(m[1]) : null;
  const changed = id !== state.txId;
  state.txId = id;
  if (changed) {
    state.editing = null;
    state.openParams.clear();
    state.picks.clear();
    state.focused = null;
  }
  try {
    await refreshApp();
    if (!id) {
      state.detail = null;
      renderView();
      return;
    }
    fill($("#view"), h("div", { class: "skeleton-block wide" }), h("div", { class: "skeleton-block" }), h("div", { class: "skeleton-block tall" }));
    state.detail = await api("GET", `/tx/${enc(id)}`);
    if (changed) state.tab = state.detail.transaction.receipt && !OPEN.includes(state.detail.transaction.status) ? "receipt" : "review";
    renderRail();
    renderView();
    if (changed) $("#outcome")?.focus();
  } catch (err) {
    state.detail = null;
    renderView();
    showError(err);
  }
}

/** Opens the first transaction waiting for review (or the newest), e.g. on first load or after a reset. */
function openDefault(force = false) {
  if ((state.txId && !force) || !state.app?.inbox.length) return;
  const first = state.app.inbox.find((r) => OPEN.includes(r.status)) ?? state.app.inbox[0];
  const target = `#/tx/${enc(first.id)}`;
  if (location.hash === target) {
    state.txId = null; // force a fresh load of the same id
    route();
  } else location.hash = target;
}

window.addEventListener("hashchange", route);
route().then(() => openDefault());
