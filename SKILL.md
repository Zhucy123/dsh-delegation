---
name: dsh-delegation
description: Delegate a task to the local DeepSeek Harness (DSH) instance — create a conversation, keep sending messages into it, send images, and read DSH's replies back for review. Works with both the DSH desktop app and `dsh web` (the endpoint is auto-discovered). Use when the user wants work delegated to DSH, or wants to read/send DSH conversation messages from another agent.
---

# DSH delegation

Delegate work to the local DSH instance through a small Node CLI.

**Never drive the DSH UI with computer use or browser control.** The CLI talks to
the same RPC the UI uses, directly. Browser automation against DSH fails for
reasons unrelated to your task (browser state, tab targeting, rendering) and has
already cost hours of dead ends. If the CLI reports an auth problem, the fix is
in its own auth chain — not in a browser.

## Setup

Requires **Node 18+** (uses global `fetch`). No dependencies to install.

Copy this folder into your agent's skills directory, then call it by absolute
path — it works from any workspace, and the target project is chosen with
`--cwd`, not by your current directory.

```powershell
# Codex
Copy-Item -Recurse . "$env:USERPROFILE\.codex\skills\dsh-delegation"
$cli = "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs"
node $cli doctor
```

```bash
# Claude Code (or any agent that reads a skills directory)
cp -r . ~/.claude/skills/dsh-delegation
node ~/.claude/skills/dsh-delegation/dsh_cli.mjs doctor
```

Add `--json` whenever you plan to parse the output.

### Endpoint (auto-discovered — you never pass it)

DSH serves the same HTTP RPC from either entry point:

| Running | Port |
| --- | --- |
| DSH desktop app | `127.0.0.1:19387` (preferred) |
| `dsh web` | `127.0.0.1:3080` |

The CLI probes, then verifies the endpoint really is DSH (~40 ms). Both share one
credential store, so auth is identical. Override with `--origin <url>` or
`DSH_BRIDGE_URL`. If neither is up it fails with a clear message telling the user
to open the desktop app or run `dsh web` — report that; do not use the browser.

### Commands

| Command | Purpose |
| --- | --- |
| `doctor` | Is DSH reachable, how did it authenticate, what model route is default |
| `new --cwd <abs> --prompt <text\|--prompt-file <path>>` | Create a **new** conversation and send the first message |
| `send --session <id> --prompt <text\|--prompt-file <path>>` | Send into an **existing** conversation (context preserved) |
| `status --session <id>` | Is DSH currently answering? Decides steer vs queue |
| `messages --session <id> [--limit N]` | Read that conversation's history |

Common options: `--json`, `--no-wait`, `--timeout-ms`, `--preset`, `--cwd`,
`--origin`, `--progress` (stream DSH's text live to stderr), `--poll` (force
polling instead of push-based wait), `--image <path>` (repeatable),
`--max-continues <n>` / `--no-auto-continue`, `--steer` / `--queue`.

## Interrupt or queue: your judgement

Two delivery modes. Which to use depends on what the message **means** — the tool
does not guess, because guessing wrong destroys in-flight work.

| Mode | Flag | Behaviour |
| --- | --- | --- |
| **queue** (default) | `--queue` | Appends a **new turn** after the current one finishes |
| **steer** (interrupt) | `--steer` | Injects into the **current turn** at the next step boundary |

Check first if you are unsure:

```powershell
node $cli status --session <id> --json
# → { "running": true, "agentAvailable": true, "title": "..." }
```

Then choose by intent:

| The message is… | Use | Why |
| --- | --- | --- |
| A correction, addition, or change of direction to what DSH is doing now | `--steer` | It must affect the work in progress |
| "Stop / wait / do this instead" | `--steer` | Waiting for the turn to end is too late |
| An unrelated new task | `--queue` | Do not trample running work |
| A follow-up needing the previous answer | `--queue` | It depends on the finished result |

When DSH is idle (`running: false`) the two are equivalent — keep the default.

**Never steer speculatively.** If you have not checked and the message is not
clearly about the current work, use `--queue`.

Notes:
- Steering redirects the turn from the next step onward; it does not discard what
  DSH already produced.
- You cannot steer into a finished turn — `--steer` then behaves like a normal
  new turn.
- Auto-continuation after a truncation always uses `queue` (it means "finish this
  sentence", not an interruption).
- The result reports `mode`, so you can confirm what happened.

## Sending images

Images can be sent **natively** — the model actually sees them; you do not hand
DSH a path and hope it reads the file.

```powershell
node $cli send --session <id> --prompt "What is wrong with this pose?" --image "C:\shot.png"
node $cli send --session <id> --image ".\before.png" --image ".\after.png" --json
```

- Formats `png` / `jpeg` / `webp` / `gif`, detected by file content.
- Limits: 20 MB per image, 20 per message, 8192 px, 64 MP.
- Text is optional when you pass at least one image.
- Result reports `imageCount`.

**The model must support image input.** DSH rejects the whole message otherwise,
naming the current route. There is no way to check ahead — the capability is not
exposed over the Remote API — so send and react: if it fails, tell the user which
model needs switching instead of silently retrying.

**Image or path?** Send the image when the task is "look at this" (screenshots,
reference art, a result you want judged). Give a path when the file already lives
in the workspace and DSH can open it itself — that saves tokens, and matters for
large or numerous images.

## Standard workflow

```powershell
# 0) Confirm the environment once per session
node $cli doctor

# 1) Create a conversation and hand DSH the task
node $cli new --cwd "C:\path\to\your-project" --prompt-file ".\task.md" --json

# 2) Continue in the SAME conversation (DSH remembers context)
node $cli send --session <sessionId> --prompt "follow-up question" --json

# 3) Read the whole thread back for your own review
node $cli messages --session <sessionId> --limit 50 --json
```

`--cwd` decides which DSH **workspace** the conversation lands in, so it appears
in that workspace's sidebar in the DSH UI. Use the project's absolute path.

Waiting is **push-based**: the CLI subscribes to DSH's event stream and returns
the moment the turn ends. If that stream is unavailable it falls back to polling —
`via` tells you which ran (`stream` or `poll`), and `streamError` explains a
fallback. You do not need to handle this.

## Reading the result

`new` / `send` return:

```json
{
  "sessionId": "session-...", "workspaceId": "...",
  "status": "done", "text": "DSH's final answer",
  "turn": 3, "reason": { "kind": "completed" },
  "elapsedMs": 1888, "via": "stream",
  "imageCount": 0, "continued": 0, "truncated": false
}
```

Branch on `status`, never on `text` alone:

| `status` | Meaning | What to do |
| --- | --- | --- |
| `done` | `text` holds the final answer | Review it; this is what you report |
| `empty` | Turn ended with no text | Treat as a failed delegation |
| `timeout` | Still running past `--timeout-ms` | Re-check with `messages`, or raise the timeout |
| `sent` | `--no-wait` was used | Poll later with `messages` |

`permission` appears only when something was blocked (see rule 1).

Exit codes: `0` ok, `2` environment/auth, `3` usage or missing session,
`4` empty reply, `5` timeout.

## Two hard rules

### 1. Permission or approval trouble → tell the user, never re-send

If DSH reports a tool needed approval, was denied, or hit a sandbox boundary,
**that is the user's decision — a new task cannot route around it.** Do not
rephrase, split the task, pick another tool, or start a new conversation hoping to
avoid the check. Stop and tell the user what was blocked and what to do.

The CLI writes a `⚠` block to stderr and adds to the JSON:

```json
"permission": { "blocked": true, "toolName": "pwsh",
  "evidence": "the user rejected tool \"pwsh\"", "count": 1 }
```

Detected from three signals: `approval/asked` / `approval/decided` events with
outcome `rejected` / `cancelled` / `unavailable`, permission text in `tool/result`
(`the user rejected tool …`, `requires approval`, `no approval channel`,
`[sandbox: file access denied …]`), and structured error codes such as
`FS_SANDBOX_DENIED`.

A denial usually does **not** end the turn — DSH hands the refusal to the model as
a tool result and it keeps going — so this cannot be judged from `reason` alone.

Tell the user to do whichever fits: approve the pending request in DSH, change
that session's permission mode / sandbox scope, or grant the tool or directory
access. Then continue the **same** conversation.

Exit code is still `0`: the turn succeeded, the *task* is blocked.

### 2. Output truncation → continue, do not re-send

When a reply hits the output-token ceiling DSH cuts it off; the fix is to say
"continue".

**The CLI does this for you.** On `reason.kind === "max-tokens"` it sends
`继续` ("continue") and concatenates the pieces, up to `--max-continues`
(default 3), reporting `continued` (extra rounds) and `truncated` (true only if
still cut off at the cap).

Use `text` as the complete answer. If `truncated` is `true`, send another
`--prompt "继续"` or raise `--max-continues`. Do **not** re-send the original task —
that restarts the work and wastes output DSH already preserved.

Opt out with `--no-auto-continue` (`--max-continues 0`) to see each truncation.

## Rules

- **One conversation per task.** Reuse the `sessionId` from `new`; a new
  conversation loses context.
- **Never work around a permission denial** (rule 1) or **re-send a truncated
  task** (rule 2).
- **You own the outcome.** Read `text` and any workspace changes before reporting
  or building on them. You are accountable, not DSH.
- **Only the final answer comes back.** Reasoning and tool activity are filtered
  out; `text` is what the user should see.
- **Long jobs:** use `--no-wait`, then poll with `messages`. Add `--progress` if
  the user wants to watch output arrive live.
- **Report failures honestly.** If `doctor` fails or you get exit code 2, say so
  and stop.
- **Never print auth material.** The CLI resolves credentials itself. Do not echo
  tokens, cookies, or `~/.dsh/.credentials.yaml`.

## Sandbox notes

- Needs only to **read** `~/.dsh/.credentials.yaml` and reach loopback; no write
  access to DSH's directory.
- Its cookie cache tries several locations; if none is writable it re-derives the
  cookie each run — slower, still correct. `doctor` reports which path was used.
- It never touches your own workspace's DSH conversation unless you pass that
  workspace's `--cwd` deliberately.

## Related: `dsh headless`

A second, independent path — mention it, do not substitute it silently:

```powershell
dsh headless "run the tests"       # answer one task, print it, exit
dsh --profile headless --json "…"  # machine-readable run events
```

Prefer it for a single self-contained task the user does not need to watch, or
CI-style automation. It works even when the desktop app and `dsh web` are closed.

Two catches: it does **not** share conversations with this path (it rejects a
`--session-id` created through the GUI/RPC path), and it has **no image
parameter**. For anything the user should be able to watch or continue, use this
skill's CLI.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `找不到正在运行的 DSH 端点` (exit 2) | Neither entry point is up. Tell the user to open the desktop app or run `dsh web`. Do **not** use the browser. |
| Same, but the command works in your own terminal | Your host agent's sandbox blocks loopback (e.g. Codex's offline sandbox firewall rule). Not a port or tool problem — use a network-enabled execution mode. |
| `doctor` exits 2, mentions auth | Credentials unresolved. Check DSH is running and `~/.dsh/.credentials.yaml` exists. |
| Exit 3, `session "..." not found` | Wrong or deleted `sessionId`. Call `new` again. |
| Conversation missing from the DSH sidebar | `--cwd` was not the registered workspace path. Re-run `new` with the exact project path. |
| `status: "timeout"` | Long task. Use `--no-wait` + `messages`, or raise `--timeout-ms`. |
| `via: "poll"` plus `streamError` | WebSocket was unavailable; fell back to polling. Harmless. |
| Answer looks wrong, as if from an earlier turn | Suspect an **ambiguous prompt** before suspecting the tool. A message like "reply with the queued one" makes DSH search its history and pick a different line. Verify with self-contained prompts. |
| `不支持图片输入` naming a model | That model has no vision. Tell the user to switch models or drop `--image`. |

## See also

- [`README.md`](README.md) — install, CLI reference, library API
- [`docs/DESIGN.md`](docs/DESIGN.md) — protocol notes and why each design
  decision was made; read before changing the bridge

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
