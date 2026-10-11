import { BRAND } from "../brand.ts";
import { GitHubHttpError, type GitHubTransport, type RawIssue, type TransportResult } from "./transport.ts";

export type TokenProvider = () => Promise<string>;

interface RestOptions {
  token: TokenProvider;
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}

/** GitHub REST transport. Tokens stay inside this class and never reach the ledger. */
export class RestGitHub implements GitHubTransport {
  readonly #token: TokenProvider;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;

  constructor(options: RestOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#userAgent = options.userAgent ?? BRAND.userAgent;
    this.#fetch = options.fetch ?? fetch;
  }

  async getIssue(owner: string, repo: string, number: number): Promise<RawIssue> {
    const { body } = await this.#request("GET", `/repos/${owner}/${repo}/issues/${number}`);
    return toRawIssue(body);
  }

  async listCommentBodies(owner: string, repo: string, number: number): Promise<string[]> {
    const bodies: string[] = [];
    let path: string | null = `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
    while (path) {
      const res: { body: unknown; next: string | null } = await this.#request("GET", path);
      for (const c of res.body as Array<{ body?: string | null }>) bodies.push(c.body ?? "");
      path = res.next;
    }
    return bodies;
  }

  updateIssue(owner: string, repo: string, number: number, patch: { title?: string; state?: string; state_reason?: string }) {
    return this.#write("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
  }

  addLabels(owner: string, repo: string, number: number, labels: string[]) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels });
  }

  removeLabel(owner: string, repo: string, number: number, label: string) {
    return this.#write("DELETE", `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
  }

  addAssignees(owner: string, repo: string, number: number, assignees: string[]) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/assignees`, { assignees });
  }

  removeAssignees(owner: string, repo: string, number: number, assignees: string[]) {
    return this.#write("DELETE", `/repos/${owner}/${repo}/issues/${number}/assignees`, { assignees });
  }

  createComment(owner: string, repo: string, number: number, body: string) {
    return this.#write("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  async createIssue(owner: string, repo: string, issue: { title: string; body?: string; labels?: string[] }): Promise<RawIssue> {
    const { body } = await this.#request("POST", `/repos/${owner}/${repo}/issues`, issue);
    return toRawIssue(body);
  }

  async #write(method: string, path: string, payload?: unknown): Promise<TransportResult> {
    const { requestId } = await this.#request(method, path, payload);
    return { requestId };
  }

  async #request(method: string, path: string, payload?: unknown): Promise<{ body: unknown; requestId: string; next: string | null }> {
    const url = path.startsWith("http") ? path : `${this.#baseUrl}${path}`;
    const res = await this.#fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await this.#token()}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": this.#userAgent,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const requestId = res.headers.get("x-github-request-id") ?? "unknown";
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message = (body as { message?: string } | null)?.message ?? res.statusText;
      throw new GitHubHttpError(res.status, message, requestId);
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { body, requestId, next };
  }
}

function toRawIssue(body: unknown): RawIssue {
  const b = body as {
    number: number;
    title: string;
    state: "open" | "closed";
    state_reason?: string | null;
    labels: Array<string | { name?: string }>;
    assignees?: Array<{ login: string }>;
  };
  return {
    number: b.number,
    title: b.title,
    state: b.state,
    state_reason: b.state_reason ?? null,
    labels: b.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    assignees: (b.assignees ?? []).map((a) => a.login.toLowerCase()),
  };
}
