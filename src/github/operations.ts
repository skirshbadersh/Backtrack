import type { CompensationPlan, OperationSpec } from "../connector.ts";
import { EngineError } from "../errors.ts";
import type { IssueSnapshot, ResourceRef } from "../types.ts";
import { strictParams } from "../validate.ts";

/** Hidden marker appended to comment bodies; its presence on reread proves the comment already landed. */
export function commentMarker(idempotencyKey: string): string {
  return `bt-idem:${idempotencyKey.slice(0, 32)}`;
}

export function markerComment(body: string, idempotencyKey: string): string {
  return `${body}\n\n<!-- ${commentMarker(idempotencyKey)} -->`;
}

export const MARKER_PATTERN = /<!-- (bt-idem:[0-9a-f]{32}) -->/g;

const ref = (t: ResourceRef) => `${t.owner}/${t.repo}#${t.number}`;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function stringList(value: unknown, field: string, op: string, check?: (s: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EngineError("invalid_change_set", `${op}.${field} must be a non-empty array of strings`);
  }
  const out = new Map<string, string>();
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) throw new EngineError("invalid_change_set", `${op}.${field} contains a non-string or empty item`);
    const s = v.trim();
    if (check && !check(s)) throw new EngineError("invalid_change_set", `${op}.${field} contains invalid value ${JSON.stringify(s)}`);
    // GitHub compares labels and logins case-insensitively; keep the first spelling.
    if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  }
  return [...out.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

const hasCI = (list: string[], v: string) => list.some((x) => x.toLowerCase() === v.toLowerCase());
const addCI = (list: string[], vs: string[]) => sortCI([...list, ...vs.filter((v) => !hasCI(list, v))]);
const removeCI = (list: string[], vs: string[]) => list.filter((x) => !hasCI(vs, x));
const sortCI = (list: string[]) => [...list].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
const strings = (v: unknown) => v as string[];

const updateTitle: OperationSpec = {
  name: "issue.update_title",
  normalize(params) {
    strictParams(params, ["title"], this.name);
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title || title.length > 256) throw new EngineError("invalid_change_set", "issue.update_title.title must be 1-256 characters");
    return { title };
  },
  relevantFields: ["title"],
  recovery: () => ({ class: "reversible", residue: ["the rename stays visible in the issue timeline"] }),
  risk: () => ({ level: "low", factors: ["single reversible metadata edit"] }),
  idempotency: "natural_key_reread",
  project: (s, p) => ({ ...s, title: p.title as string }),
  postconditions: (p) => [{ field: "title", op: "equals", value: p.title as string }],
  compensate: (p, prior): CompensationPlan =>
    prior.title === p.title
      ? { kind: "noop", reason: "title was already this value before the change" }
      : { kind: "action", operation: "issue.update_title", params: { title: prior.title }, residue: ["both renames stay visible in the issue timeline"] },
  summarize: (p, t) => `Rename ${ref(t)} to "${p.title as string}"`,
};

function labelOp(kind: "add" | "remove"): OperationSpec {
  const name = `issue.${kind}_labels`;
  return {
    name,
    normalize(params) {
      strictParams(params, ["labels"], name);
      return { labels: stringList(params.labels, "labels", name, (s) => s.length <= 50) };
    },
    relevantFields: ["labels"],
    recovery: () => ({ class: "reversible", residue: ["label events stay visible in the issue timeline"] }),
    risk: () => ({ level: "low", factors: ["single reversible metadata edit"] }),
    idempotency: "natural_key_reread",
    project: (s, p) => ({ ...s, labels: kind === "add" ? addCI(s.labels, strings(p.labels)) : removeCI(s.labels, strings(p.labels)) }),
    postconditions: (p) => strings(p.labels).map((value) => ({ field: "labels", op: kind === "add" ? "includes" : "excludes", value })),
    compensate(p, prior) {
      // Only undo what this action changed: labels that were absent (for add) or present (for remove) beforehand.
      const changed = strings(p.labels).filter((l) => (kind === "add" ? !hasCI(prior.labels, l) : hasCI(prior.labels, l)));
      if (!changed.length) return { kind: "noop", reason: `labels were already ${kind === "add" ? "present" : "absent"} before the change` };
      return {
        kind: "action",
        operation: kind === "add" ? "issue.remove_labels" : "issue.add_labels",
        params: { labels: changed },
        residue: ["label events stay visible in the issue timeline"],
      };
    },
    summarize: (p, t) => `${kind === "add" ? "Add" : "Remove"} label${strings(p.labels).length > 1 ? "s" : ""} ${strings(p.labels).join(", ")} ${kind === "add" ? "to" : "from"} ${ref(t)}`,
  };
}

function assigneeOp(kind: "add" | "remove"): OperationSpec {
  const name = `issue.${kind}_assignees`;
  return {
    name,
    normalize(params) {
      strictParams(params, ["assignees"], name);
      const assignees = stringList(params.assignees, "assignees", name, (s) => LOGIN.test(s.replace(/^@/, ""))).map((s) =>
        s.replace(/^@/, "").toLowerCase(),
      );
      if (assignees.length > 10) throw new EngineError("invalid_change_set", `${name}: GitHub accepts at most 10 assignees per call`);
      return { assignees };
    },
    relevantFields: ["assignees"],
    recovery: () => ({
      class: "reversible",
      residue: kind === "add" ? ["assigned users have already been notified"] : ["unassignment stays visible in the issue timeline"],
    }),
    risk: () => ({ level: "medium", factors: ["assignment affecting another user"] }),
    idempotency: "natural_key_reread",
    project: (s, p) => ({
      ...s,
      assignees: kind === "add" ? addCI(s.assignees, strings(p.assignees)) : removeCI(s.assignees, strings(p.assignees)),
    }),
    postconditions: (p) => strings(p.assignees).map((value) => ({ field: "assignees", op: kind === "add" ? "includes" : "excludes", value })),
    compensate(p, prior) {
      const changed = strings(p.assignees).filter((a) => (kind === "add" ? !hasCI(prior.assignees, a) : hasCI(prior.assignees, a)));
      if (!changed.length) return { kind: "noop", reason: `assignees were already ${kind === "add" ? "assigned" : "unassigned"} before the change` };
      return {
        kind: "action",
        operation: kind === "add" ? "issue.remove_assignees" : "issue.add_assignees",
        params: { assignees: changed },
        residue: ["notifications about the original assignment change were already delivered"],
      };
    },
    summarize: (p, t) => `${kind === "add" ? "Assign" : "Unassign"} ${strings(p.assignees).map((a) => "@" + a).join(", ")} ${kind === "add" ? "to" : "from"} ${ref(t)}`,
  };
}

const addComment: OperationSpec = {
  name: "issue.add_comment",
  normalize(params) {
    strictParams(params, ["body"], this.name);
    const body = typeof params.body === "string" ? params.body.trim() : "";
    if (!body || body.length > 60000) throw new EngineError("invalid_change_set", "issue.add_comment.body must be 1-60000 characters");
    if (/<!-- bt-idem:/.test(body)) throw new EngineError("invalid_change_set", "issue.add_comment.body must not contain idempotency markers");
    return { body };
  },
  // A comment does not overwrite anything, so no field makes it stale.
  relevantFields: [],
  recovery: () => ({
    class: "compensatable",
    residue: ["subscribers are notified as soon as the comment posts", "the comment may already have been read or quoted"],
  }),
  risk: () => ({ level: "medium", factors: ["comment sends notifications", "compensatable only, not reversible"] }),
  idempotency: "natural_key_reread",
  project: (s, _p, key) => ({ ...s, comment_markers: [...new Set([...s.comment_markers, commentMarker(key)])].sort() }),
  postconditions: (_p, key) => [{ field: "comment_markers", op: "includes", value: commentMarker(key) }],
  compensate: () => ({
    kind: "action",
    operation: "issue.add_comment",
    params: { body: "Correction: an earlier automated comment on this issue was posted in error. Please disregard it." },
    residue: ["the original comment stays visible", "its notifications were already delivered"],
  }),
  summarize: (p, t) => {
    const body = (p.body as string).replace(/\s+/g, " ");
    return `Comment on ${ref(t)}: "${body.length > 60 ? body.slice(0, 57) + "..." : body}"`;
  },
};

const STATE_REASONS: Record<"open" | "closed", readonly string[]> = {
  open: ["reopened"],
  closed: ["completed", "not_planned"],
};

const setState: OperationSpec = {
  name: "issue.set_state",
  normalize(params) {
    strictParams(params, ["state", "state_reason"], this.name);
    const state = params.state;
    if (state !== "open" && state !== "closed") throw new EngineError("invalid_change_set", 'issue.set_state.state must be "open" or "closed"');
    const reason = params.state_reason ?? (state === "closed" ? "completed" : "reopened");
    if (typeof reason !== "string" || !STATE_REASONS[state].includes(reason)) {
      throw new EngineError("invalid_change_set", `issue.set_state.state_reason must be one of ${STATE_REASONS[state].join(", ")}`);
    }
    return { state, state_reason: reason };
  },
  relevantFields: ["state"],
  recovery: (p) => ({
    class: "reversible",
    residue: [p.state === "closed" ? "subscribers were notified that the issue closed" : "subscribers were notified that the issue reopened"],
  }),
  risk: (p) => (p.state === "closed" ? { level: "high", factors: ["closing an issue"] } : { level: "medium", factors: ["reopening notifies subscribers"] }),
  idempotency: "natural_key_reread",
  project: (s, p) => ({ ...s, state: p.state as IssueSnapshot["state"], state_reason: p.state_reason as string }),
  postconditions: (p) => [{ field: "state", op: "equals", value: p.state as string }],
  compensate: (p, prior) =>
    prior.state === p.state
      ? { kind: "noop", reason: `issue was already ${prior.state} before the change` }
      : {
          kind: "action",
          operation: "issue.set_state",
          params: prior.state === "open" ? { state: "open", state_reason: "reopened" } : { state: "closed", state_reason: prior.state_reason === "not_planned" ? "not_planned" : "completed" },
          residue: ["state-change notifications were already delivered"],
        },
  summarize: (p, t) => (p.state === "closed" ? `Close ${ref(t)} as ${(p.state_reason as string).replace("_", " ")}` : `Reopen ${ref(t)}`),
};

export const GITHUB_OPERATIONS: ReadonlyMap<string, OperationSpec> = new Map(
  [updateTitle, labelOp("add"), labelOp("remove"), assigneeOp("add"), assigneeOp("remove"), addComment, setState].map((s) => [s.name, s]),
);
