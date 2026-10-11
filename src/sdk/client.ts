import { EngineError } from "../errors.ts";
import type { ChangeSetInput, Receipt } from "../types.ts";
import { validateChangeSet } from "../validate.ts";
import type { AgentOutcome, AgentStatus, ApiErrorBody, SubmitResponse } from "./protocol.ts";

export interface ClientOptions {
  /** Review server origin, e.g. "http://127.0.0.1:4317". */
  baseUrl: string;
  /** Bearer token, if the server was started with one. */
  token?: string;
  /** How often waitForDecision polls. Default 2s. */
  pollIntervalMs?: number;
  /** Per-request timeout. Default 15s. */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export interface WaitOptions {
  /** Give up after this long and return a `timeout` decision. Default 30 minutes, the approval lifetime. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Called whenever the status changes while waiting, e.g. to log "approved, executing". */
  onStatus?: (status: AgentStatus) => void;
}

/**
 * The agent's answer. `ok` is true only when the change set was committed and
 * every postcondition held on reread. Anything else means the proposed writes did
 * not happen as proposed, and the agent must not assume otherwise.
 */
export type Decision =
  | { outcome: Exclude<AgentOutcome, "waiting">; ok: boolean; status: AgentStatus }
  | { outcome: "timeout"; ok: false; status: AgentStatus };

export type SdkErrorCode = "invalid_change_set" | "unreachable" | "unauthorized" | "not_found" | "aborted" | "server_error" | string;

export class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly status: number | null;
  readonly details: string[];

  constructor(code: SdkErrorCode, message: string, status: number | null = null, details: string[] = []) {
    super(details.length ? `${message}: ${details.join("; ")}` : message);
    this.name = "SdkError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Typed client for agents. It never writes to GitHub itself: the review server
 * executes only what a reviewer approved. If the server is unreachable, calls
 * throw and nothing is written, so an agent that stops on error fails closed.
 */
export class ReviewClient {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #poll: number;
  readonly #requestTimeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#poll = options.pollIntervalMs ?? 2000;
    this.#requestTimeout = options.requestTimeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Submits a change set for review. It is validated locally first, so malformed
   * input fails without a network call. Resubmitting the identical change set is
   * safe: the server returns the existing transaction (`deduplicated: true`).
   */
  async submit(changeSet: ChangeSetInput): Promise<SubmitResponse> {
    try {
      validateChangeSet(changeSet);
    } catch (err) {
      if (err instanceof EngineError) throw new SdkError("invalid_change_set", "change set rejected before sending", null, err.details);
      throw err;
    }
    return this.#request<SubmitResponse>("POST", "/api/change-sets", changeSet);
  }

  status(transactionId: string, signal?: AbortSignal): Promise<AgentStatus> {
    return this.#request<AgentStatus>("GET", `/api/change-sets/${encodeURIComponent(transactionId)}`, undefined, signal);
  }

  async getReceipt(transactionId: string): Promise<Receipt | null> {
    return (await this.status(transactionId)).receipt;
  }

  /** Polls until the reviewer's work is done (or the wait times out) and returns the decision. */
  async waitForDecision(transactionId: string, options: WaitOptions = {}): Promise<Decision> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    const interval = options.pollIntervalMs ?? this.#poll;
    let last: AgentStatus | null = null;
    for (;;) {
      if (options.signal?.aborted) throw new SdkError("aborted", "wait aborted");
      const status = await this.status(transactionId, options.signal);
      if (!last || last.status !== status.status || last.revision !== status.revision) options.onStatus?.(status);
      last = status;
      if (status.outcome !== "waiting") return { outcome: status.outcome, ok: status.ok, status };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { outcome: "timeout", ok: false, status };
      await sleep(Math.min(interval, remaining), options.signal);
    }
  }

  /** submit + waitForDecision. */
  async submitAndWait(changeSet: ChangeSetInput, options: WaitOptions = {}): Promise<Decision & { submitted: SubmitResponse }> {
    const submitted = await this.submit(changeSet);
    const decision = await this.waitForDecision(submitted.transaction_id, options);
    return { ...decision, submitted };
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#requestTimeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new SdkError("aborted", "request aborted");
      const reason = timeout.aborted ? `no response within ${this.#requestTimeout}ms` : err instanceof Error ? err.message : String(err);
      throw new SdkError("unreachable", `review server unreachable (${reason}); nothing was written`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new SdkError("server_error", `unreadable response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      const e = (parsed as ApiErrorBody | null)?.error;
      throw new SdkError(e?.code ?? "server_error", e?.message ?? `HTTP ${res.status}`, res.status, e?.details ?? []);
    }
    return parsed as T;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(new SdkError("aborted", "wait aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
