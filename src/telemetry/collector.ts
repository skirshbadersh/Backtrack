import { appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { validateEvent } from "./schema.ts";

const MAX_BODY = 4 * 1024;

/**
 * Minimal telemetry collector, meant to run next to the landing page (roadmap item 7).
 * Accepts POST /v1/events, rejects anything outside the schema, and appends valid events
 * as JSON lines. It deliberately stores no IP address, user agent or time of day.
 */
export function createCollector(outFile: string): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/v1/health") return reply(200, { ok: true });
      if (req.method !== "POST" || req.url !== "/v1/events") return reply(404, { error: "not found" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, { error: "json only" });
      const raw = await readBody(req);
      if (raw === null) return reply(413, { error: "too large" });
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        return reply(400, { error: "invalid json" });
      }
      const problems = validateEvent(event);
      if (problems.length) return reply(422, { error: "rejected", problems });
      await appendFile(outFile, JSON.stringify(event) + "\n");
      return reply(204);
    } catch {
      return reply(500, { error: "internal" });
    }
  });
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
