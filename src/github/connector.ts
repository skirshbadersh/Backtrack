import type { Connector, OperationSpec, WriteResult } from "../connector.ts";
import { EngineError } from "../errors.ts";
import type { IssueSnapshot, NormalizedAction, ResourceRef } from "../types.ts";
import { GITHUB_OPERATIONS, MARKER_PATTERN, markerComment } from "./operations.ts";
import type { GitHubTransport } from "./transport.ts";

export class GitHubIssuesConnector implements Connector {
  readonly id = "github";
  readonly #transport: GitHubTransport;

  constructor(transport: GitHubTransport) {
    this.#transport = transport;
  }

  operation(name: string): OperationSpec | undefined {
    return GITHUB_OPERATIONS.get(name);
  }

  targetKey(t: ResourceRef): string {
    return `${t.kind}:${t.owner}/${t.repo}#${t.number}`.toLowerCase();
  }

  describeTarget(t: ResourceRef): string {
    return `${t.owner}/${t.repo}#${t.number}`;
  }

  async read(t: ResourceRef): Promise<IssueSnapshot> {
    const [issue, comments] = await Promise.all([
      this.#transport.getIssue(t.owner, t.repo, t.number),
      this.#transport.listCommentBodies(t.owner, t.repo, t.number),
    ]);
    const markers = new Set<string>();
    for (const body of comments) for (const m of body.matchAll(MARKER_PATTERN)) markers.add(m[1]!);
    return {
      title: issue.title,
      state: issue.state,
      state_reason: issue.state_reason,
      labels: [...issue.labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      assignees: [...issue.assignees].map((a) => a.toLowerCase()).sort(),
      comment_markers: [...markers].sort(),
    };
  }

  async write(action: NormalizedAction): Promise<WriteResult> {
    const { owner, repo, number } = action.target;
    const p = action.params;
    const t = this.#transport;
    switch (action.operation) {
      case "issue.update_title":
        return ids(await t.updateIssue(owner, repo, number, { title: p.title as string }));
      case "issue.set_state":
        return ids(await t.updateIssue(owner, repo, number, { state: p.state as string, state_reason: p.state_reason as string }));
      case "issue.add_labels":
        return ids(await t.addLabels(owner, repo, number, p.labels as string[]));
      case "issue.remove_labels": {
        // One DELETE per label; skip labels already absent so a partial earlier attempt does not 404.
        const current = (await t.getIssue(owner, repo, number)).labels.map((l) => l.toLowerCase());
        const results = [];
        for (const label of p.labels as string[]) {
          if (current.includes(label.toLowerCase())) results.push(await t.removeLabel(owner, repo, number, label));
        }
        return ids(...results);
      }
      case "issue.add_assignees":
        return ids(await t.addAssignees(owner, repo, number, p.assignees as string[]));
      case "issue.remove_assignees":
        return ids(await t.removeAssignees(owner, repo, number, p.assignees as string[]));
      case "issue.add_comment":
        return ids(await t.createComment(owner, repo, number, markerComment(p.body as string, action.idempotency_key)));
      default:
        throw new EngineError("unknown_operation", `GitHub connector cannot execute ${action.operation}`);
    }
  }
}

function ids(...results: Array<{ requestId: string }>): WriteResult {
  return { request_ids: results.map((r) => r.requestId) };
}
