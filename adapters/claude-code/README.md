# Claude Code hook (experimental, for dogfooding)

A `PreToolUse` hook that routes Claude Code's GitHub issue writes through human review.
When Claude calls the official GitHub MCP server's `mcp__github__issue_write` or
`mcp__github__add_issue_comment`, the hook:

1. Turns the call into a change set and submits it to the review server. Label and
   assignee *replacement* is turned into explicit add/remove actions, using the issue's
   current state.
2. Waits for a reviewer in the web UI.
3. **Always denies the original tool call.** On approval, the review server performs the
   reviewed write itself and rereads GitHub to verify it. Letting the tool run as well
   would write twice and skip verification. The deny reason tells Claude what happened:
   `VERIFIED` (the change is in place, don't retry), `REJECTED` (with the reviewer's
   reason), `NOT VERIFIED`, `STILL AWAITING REVIEW`, or "nothing was written".

An identical retry of the same call in the same session maps to the same transaction.
Retrying therefore checks the existing review again instead of proposing the change twice.

## What it supports

| Tool | Reviewed | Blocked, with a reason, nothing written |
|---|---|---|
| `mcp__github__issue_write` (`method: "update"`) | `title`, `state` (open, or closed as completed / not_planned), `labels`, `assignees` | `method: "create"`, `body`, `milestone`, `type`, `issue_fields`, `duplicate_of`, closing as duplicate |
| `mcp__github__add_issue_comment` | `body` | reactions, `comment_id` |

A call that mixes supported and unsupported fields is blocked as a whole, never applied
partially. Other tools, including `gh issue …` through Bash, are **not** intercepted.

## Setup

1. Run the review server against a repository the token can write to (for dogfooding,
   the throwaway repo):

   ```sh
   GITHUB_TOKEN=… npm run serve -- --repo <you>/throwawaybacktrackrepo --yes
   ```

   Sandbox mode (`npm run serve` with no `--repo`) only knows the simulated
   `acme/widgets` issues.

2. Add the hook to `.claude/settings.json` in the project where you use Claude Code. See
   [`settings.example.json`](settings.example.json):

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "mcp__github__issue_write|mcp__github__add_issue_comment",
           "hooks": [
             { "type": "command", "command": "node /path/to/Backtrack/src/cli.ts hook claude-code", "timeout": 600, "onFailure": "block" }
           ]
         }
       ]
     }
   }
   ```

   After `npm install`ing the package, the command becomes `npx --no-install bt-demo hook claude-code`.

3. Review in the browser at `http://127.0.0.1:4317/`.

## Failing closed

Claude Code **fails open** when a hook times out or crashes: the tool call proceeds,
which here would mean an unreviewed write. Three things guard against that:

- The hook stops waiting after `BT_HOOK_WAIT_SECONDS` (default 540s). That is below the
  600s `timeout`, so it always answers with a deny before Claude Code gives up on it.
- Every internal error, unreachable server or unreadable input becomes a deny, and the
  command always exits 0. (Claude Code treats other exit codes as non-blocking.)
- `"onFailure": "block"` makes Claude Code itself block if the hook still fails. The
  hooks reference says this needs Claude Code v2.1.295 or later; this has not been
  checked against a running Claude Code here. Without it, a hook that crashes before
  printing lets the write through.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BT_SERVER` | `http://127.0.0.1:4317` | Review server |
| `BT_AGENT_TOKEN` | — | Bearer token, if `serve` was started with `--agent-token` |
| `BT_HOOK_WAIT_SECONDS` | `540` | How long to wait for a reviewer; keep below the hook `timeout` |
| `BT_WORKSPACE` | `ws-claude-code` | Workspace id recorded on each change set |
| `BT_INITIATOR` | `@claude-code-user` | Who the agent works for |

## Dogfooding

Use it daily on the throwaway repo, and write down every point of confusion in
[`docs/dogfood-log.md`](../../docs/dogfood-log.md). The PRD treats that log as a Phase 0 signal.
