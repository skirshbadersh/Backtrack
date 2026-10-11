import { ReviewClient } from "../../sdk/client.ts";
import { deny, handlePreToolUse, type HookOutput } from "./hook.ts";

/**
 * `bt-demo hook claude-code`: reads the PreToolUse JSON on stdin and prints the
 * decision JSON on stdout. Always exits 0, because Claude Code treats other exit
 * codes as non-blocking errors and would let the tool run; every failure is
 * expressed as a deny instead.
 *
 * Environment:
 *   BT_SERVER              review server (default http://127.0.0.1:4317)
 *   BT_AGENT_TOKEN         bearer token, if the server requires one
 *   BT_HOOK_WAIT_SECONDS   how long to wait for the reviewer (default 540; keep it
 *                          below the hook `timeout` in settings, default 600)
 *   BT_WORKSPACE           workspace id (default ws-claude-code)
 *   BT_INITIATOR           who the agent works for (default @claude-code-user)
 */
export async function claudeCodeHookCommand(stdin: NodeJS.ReadableStream = process.stdin, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  let output: HookOutput | null;
  try {
    const raw = await readAll(stdin);
    const input: unknown = JSON.parse(raw);
    const serverUrl = process.env.BT_SERVER ?? "http://127.0.0.1:4317";
    const token = process.env.BT_AGENT_TOKEN;
    output = await handlePreToolUse(input, {
      client: new ReviewClient({ baseUrl: serverUrl, ...(token ? { token } : {}) }),
      waitMs: Number(process.env.BT_HOOK_WAIT_SECONDS ?? 540) * 1000,
      workspaceId: process.env.BT_WORKSPACE ?? "ws-claude-code",
      initiator: process.env.BT_INITIATOR ?? "@claude-code-user",
      serverUrl,
    });
  } catch (err) {
    output = deny(`Not executed: the review hook could not read its input (${err instanceof Error ? err.message : String(err)}). Nothing was written.`);
  }
  if (output) write(JSON.stringify(output) + "\n");
  return 0;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString("utf8");
}
