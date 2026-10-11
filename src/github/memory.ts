import { GitHubHttpError, type GitHubTransport, type RawIssue, type TransportResult } from "./transport.ts";

export interface RecordedWrite {
  requestId: string;
  method: string;
  path: string;
  body: unknown;
}

/**
 * In-memory stand-in for the GitHub REST API, used by tests and the offline demo.
 * It mirrors the behaviours that matter here, including one real GitHub quirk:
 * adding an assignee who cannot be assigned succeeds with 201 and is silently dropped.
 */
export class MemoryGitHub implements GitHubTransport {
  readonly writes: RecordedWrite[] = [];
  /** Called before every write is applied; throw to simulate a failure. */
  beforeWrite: ((write: Omit<RecordedWrite, "requestId">) => void) | undefined;
  /** Called after every write is applied, before the response returns; throw to simulate a lost response. */
  afterWrite: ((write: RecordedWrite) => void) | undefined;

  #issues = new Map<string, RawIssue>();
  #comments = new Map<string, string[]>();
  #assignable = new Map<string, Set<string>>();
  #nextNumber = new Map<string, number>();
  #requestSeq = 0;

  addRepo(owner: string, repo: string, assignable: string[]): void {
    this.#assignable.set(`${owner}/${repo}`, new Set(assignable.map((a) => a.toLowerCase())));
  }

  seedIssue(owner: string, repo: string, issue: Partial<RawIssue> & { number: number; title: string }): void {
    this.#issues.set(key(owner, repo, issue.number), {
      state: "open",
      state_reason: null,
      labels: [],
      assignees: [],
      ...structuredClone(issue),
    });
    this.#comments.set(key(owner, repo, issue.number), []);
    const repoKey = `${owner}/${repo}`;
    this.#nextNumber.set(repoKey, Math.max(this.#nextNumber.get(repoKey) ?? 1, issue.number + 1));
  }

  /** Direct mutation that bypasses the write log, e.g. a teammate editing in the GitHub UI. */
  mutate(owner: string, repo: string, number: number, fn: (issue: RawIssue) => void): void {
    fn(this.#issue(owner, repo, number));
  }

  comments(owner: string, repo: string, number: number): string[] {
    return [...(this.#comments.get(key(owner, repo, number)) ?? [])];
  }

  async getIssue(owner: string, repo: string, number: number): Promise<RawIssue> {
    return structuredClone(this.#issue(owner, repo, number));
  }

  async listCommentBodies(owner: string, repo: string, number: number): Promise<string[]> {
    this.#issue(owner, repo, number);
    return this.comments(owner, repo, number);
  }

  updateIssue(owner: string, repo: string, number: number, patch: { title?: string; state?: string; state_reason?: string }) {
    return this.#write("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch, () => {
      const issue = this.#issue(owner, repo, number);
      if (patch.title !== undefined) issue.title = patch.title;
      if (patch.state === "open" || patch.state === "closed") {
        issue.state = patch.state;
        issue.state_reason = patch.state_reason ?? null;
      }
    });
  }

  addLabels(owner: string, repo: string, number: number, labels: string[]) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels }, () => {
      const issue = this.#issue(owner, repo, number);
      for (const l of labels) if (!issue.labels.some((x) => x.toLowerCase() === l.toLowerCase())) issue.labels.push(l);
      issue.labels.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    });
  }

  removeLabel(owner: string, repo: string, number: number, label: string) {
    return this.#write("DELETE", `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, null, () => {
      const issue = this.#issue(owner, repo, number);
      const i = issue.labels.findIndex((x) => x.toLowerCase() === label.toLowerCase());
      if (i < 0) throw new GitHubHttpError(404, "Label does not exist");
      issue.labels.splice(i, 1);
    });
  }

  addAssignees(owner: string, repo: string, number: number, assignees: string[]) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/assignees`, { assignees }, () => {
      const issue = this.#issue(owner, repo, number);
      const allowed = this.#assignable.get(`${owner}/${repo}`) ?? new Set();
      for (const a of assignees) {
        // GitHub responds 201 and silently ignores users who cannot be assigned.
        if (allowed.has(a.toLowerCase()) && !issue.assignees.includes(a.toLowerCase())) issue.assignees.push(a.toLowerCase());
      }
      issue.assignees.sort();
    });
  }

  removeAssignees(owner: string, repo: string, number: number, assignees: string[]) {
    return this.#write("DELETE", `/repos/${owner}/${repo}/issues/${number}/assignees`, { assignees }, () => {
      const issue = this.#issue(owner, repo, number);
      issue.assignees = issue.assignees.filter((a) => !assignees.some((x) => x.toLowerCase() === a));
    });
  }

  createComment(owner: string, repo: string, number: number, body: string) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body }, () => {
      this.#issue(owner, repo, number);
      this.#comments.get(key(owner, repo, number))!.push(body);
    });
  }

  async createIssue(owner: string, repo: string, input: { title: string; body?: string; labels?: string[] }): Promise<RawIssue> {
    const repoKey = `${owner}/${repo}`;
    const number = this.#nextNumber.get(repoKey) ?? 1;
    this.seedIssue(owner, repo, { number, title: input.title, labels: [...(input.labels ?? [])] });
    return this.getIssue(owner, repo, number);
  }

  async #write(method: string, path: string, body: unknown, apply: () => void): Promise<TransportResult> {
    this.beforeWrite?.({ method, path, body });
    apply();
    const write = { requestId: `MEM-${String(++this.#requestSeq).padStart(4, "0")}`, method, path, body: structuredClone(body) };
    this.writes.push(write);
    this.afterWrite?.(write);
    return { requestId: write.requestId };
  }

  #issue(owner: string, repo: string, number: number): RawIssue {
    const issue = this.#issues.get(key(owner, repo, number));
    if (!issue) throw new GitHubHttpError(404, `Issue ${owner}/${repo}#${number} not found`);
    return issue;
  }
}

const key = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`.toLowerCase();
