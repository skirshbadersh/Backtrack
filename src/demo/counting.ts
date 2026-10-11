import type { GitHubTransport } from "../github/transport.ts";

const WRITE_METHODS = ["updateIssue", "addLabels", "removeLabel", "addAssignees", "removeAssignees", "createComment"] as const;

/** Wraps a transport and counts write calls, so the demo can prove a retry wrote nothing. */
export function countingTransport(inner: GitHubTransport): { transport: GitHubTransport; writes: () => number } {
  let count = 0;
  const transport = Object.create(null) as GitHubTransport;
  for (const name of ["getIssue", "listCommentBodies", "createIssue"] as const) {
    (transport as unknown as Record<string, unknown>)[name] = (inner[name] as (...a: unknown[]) => unknown).bind(inner);
  }
  for (const name of WRITE_METHODS) {
    (transport as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      count++;
      return (inner[name] as (...a: unknown[]) => unknown).apply(inner, args);
    };
  }
  return { transport, writes: () => count };
}
