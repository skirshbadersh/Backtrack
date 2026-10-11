export interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[];
  assignees: string[];
}

export interface TransportResult {
  requestId: string;
}

/** The small slice of the GitHub REST API the issue connector uses. */
export interface GitHubTransport {
  getIssue(owner: string, repo: string, number: number): Promise<RawIssue>;
  listCommentBodies(owner: string, repo: string, number: number): Promise<string[]>;
  updateIssue(owner: string, repo: string, number: number, patch: { title?: string; state?: string; state_reason?: string }): Promise<TransportResult>;
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<TransportResult>;
  removeLabel(owner: string, repo: string, number: number, label: string): Promise<TransportResult>;
  addAssignees(owner: string, repo: string, number: number, assignees: string[]): Promise<TransportResult>;
  removeAssignees(owner: string, repo: string, number: number, assignees: string[]): Promise<TransportResult>;
  createComment(owner: string, repo: string, number: number, body: string): Promise<TransportResult>;
  /** Not used by the connector; the demo uses it to seed a disposable repository. */
  createIssue(owner: string, repo: string, issue: { title: string; body?: string; labels?: string[] }): Promise<RawIssue>;
}

export class GitHubHttpError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, message: string, requestId?: string) {
    super(`GitHub API ${status}: ${message}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "GitHubHttpError";
    this.status = status;
    this.requestId = requestId;
  }
}
