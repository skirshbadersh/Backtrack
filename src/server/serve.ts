import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Engine } from "../engine.ts";
import { createHandler, type ApiOptions } from "./api.ts";
import { Sandbox } from "./sandbox.ts";

/** web/ sits at the package root, two levels above both src/server and dist/server. */
export const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

export interface ServeOptions {
  port?: number;
  host?: string;
  reviewer?: string;
  /** Bearer token agents must send to /api/change-sets. Required when binding beyond loopback. */
  agentToken?: string;
  /** Live mode: an engine already wired to a real connector. Omit for the sandbox. */
  live?: { engine: Engine; repo: string };
}

export async function startServer(options: ServeOptions = {}): Promise<{ server: Server; url: string; sandbox?: Sandbox }> {
  let api: ApiOptions;
  let sandbox: Sandbox | undefined;
  const reviewer = options.reviewer ?? "@reviewer";
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host) && !options.agentToken) {
    throw new Error(`refusing to listen on ${host} without an agent token; the reviewer UI has no login yet (roadmap M3), so prefer loopback`);
  }
  const auth = options.agentToken ? { agentToken: options.agentToken } : {};
  if (options.live) {
    const engine = options.live.engine;
    api = { engine: () => engine, reviewer, mode: { kind: "live", repo: options.live.repo }, webRoot: WEB_ROOT, ...auth };
  } else {
    const sb = new Sandbox();
    await sb.seed();
    sandbox = sb;
    api = { engine: () => sb.engine, sandbox: sb, reviewer, mode: { kind: "sandbox" }, webRoot: WEB_ROOT, ...auth };
  }
  const server = createServer(createHandler(api));
  await new Promise<void>((resolve) => server.listen(options.port ?? 4317, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, url: `http://${host}:${port}/`, ...(sandbox ? { sandbox } : {}) };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
