<!-- Language switch: GitHub strips JS, so each language lives in its own file and the badges link between them. -->

[![Switch to 中文](https://img.shields.io/badge/%E5%88%87%E6%8D%A2%E5%88%B0-%E4%B8%AD%E6%96%87-555555?style=for-the-badge)](README.md)
[![Current language](https://img.shields.io/badge/%E5%BD%93%E5%89%8D%E8%AF%AD%E8%A8%80-English-2f81f7?style=for-the-badge)](#)

# dsh-delegation

**Let any coding agent delegate work to a local DeepSeek Harness (DSH) instance — create a conversation, keep talking in it, send screenshots, and read the answers back.**

Zero dependencies · Node 18+ · works with the desktop app and `dsh web`

[Quick start](#quick-start) · [CLI reference](#cli-reference) · [Library API](#library-api) · [Design notes](docs/DESIGN.md) · [Troubleshooting](#troubleshooting)

---

## What it is

DSH has no official "call me from another program" API. But its UI already speaks
a plain HTTP RPC over loopback, so this tool talks to that same RPC directly — no
browser automation, no clicking, no screenshots of the UI.

```
your agent ──► dsh_cli.mjs ──► HTTP RPC ──► DSH host ──► a real DSH conversation
                                (or WebSocket, for push-based replies)
```

Because the conversation lands in a real DSH workspace, **you can watch it in the
DSH sidebar, steer it by hand, or continue it later** — it is not a hidden side
channel.

### Why not just run the CLI twice?

Because a conversation has memory. Delegating via `new` once and then `send`-ing
into the same `sessionId` keeps full context, so a multi-round task (review this,
now fix it, now test it) works the way a person would do it. Each call returns the
final answer only — reasoning and tool noise are filtered out.

### Features

| | |
| --- | --- |
| **Persistent conversations** | `new` then repeated `send` into the same session |
| **Auto-discovered endpoint** | Probes the desktop app and `dsh web`, verifies it is really DSH |
| **Push-based replies** | Subscribes to the event stream; returns the moment the turn ends (~2 s, not a polling cadence) |
| **Native images** | PNG / JPEG / WebP / GIF sent as real content blocks — the model actually sees them |
| **Steer or queue** | `--steer` injects into the running turn; `--queue` (default) appends the next |
| **Truncation handling** | Auto-continues when the reply hits the output ceiling, and stitches the pieces |
| **Honest failure reporting** | Detects permission/approval blocks and reports them instead of pretending or retrying |
| **Zero dependencies** | Node built-ins only, including a small hand-written WebSocket client |

---

## Requirements

- **Node 18+** (uses global `fetch`)
- A running DSH instance: the desktop app, or `dsh web`
- A DSH credential store at `~/.dsh/.credentials.yaml` (created by DSH itself)

## Install

```powershell
# Windows / Codex
git clone https://github.com/Zhucy123/dsh-delegation "$env:USERPROFILE\.codex\skills\dsh-delegation"
node "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs" doctor
```

```bash
# macOS / Linux
git clone https://github.com/Zhucy123/dsh-delegation ~/.local/share/dsh-delegation
node ~/.local/share/dsh-delegation/dsh_cli.mjs doctor
```

Or drop the folder anywhere and call it by path — it has no install step and no
build step. [`SKILL.md`](SKILL.md) is the behavioural guide an agent reads; if
your agent supports skills, put this folder in its skills directory.

## Quick start

```powershell
$cli = "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs"

node $cli doctor                                              # is DSH reachable?
node $cli new --cwd "C:\my-project" --prompt "explain the build script" --json
node $cli send --session <id> --prompt "now optimise it" --json
node $cli messages --session <id> --limit 20                  # read it all back
```

`doctor` prints the endpoint, how it authenticated, the workspace id and the
default model route:

```
OK  DSH connection OK
    origin    : http://127.0.0.1:19387 (auto-discovered)
    auth      : persistent-secret
    workspace : workspace-...
    route     : provider/model
```

---

## CLI reference

| Command | What it does |
| --- | --- |
| `doctor` | Connectivity, auth method, workspace id, default model route |
| `new` | Create a conversation in a workspace (`--cwd`) and optionally send the first message |
| `send` | Send into an existing conversation (`--session`) |
| `status` | Is DSH answering right now? Decides steer vs queue |
| `messages` | Read the conversation history |

| Option | Meaning |
| --- | --- |
| `--cwd <abs path>` | Workspace to create the conversation in — this is what makes it visible in the DSH sidebar |
| `--prompt <text>` / `--prompt-file <path>` | Message content (mutually exclusive) |
| `--image <path>` | Attach an image (repeatable), sent natively to the model |
| `--session <id>` | Reuse a conversation (`send` / `status` / `messages`) |
| `--steer` / `--queue` | Inject into the current turn / append the next turn (default `queue`) |
| `--no-wait` | Send and return immediately — for long jobs |
| `--timeout-ms <n>` | How long to wait for the turn (default 180000) |
| `--max-continues <n>` / `--no-auto-continue` | Truncation auto-continue budget (default 3) |
| `--poll` | Force polling instead of the push-based wait |
| `--progress` | Stream incremental text live to **stderr** (stdout stays clean) |
| `--origin <url>` | Pin the endpoint, skipping discovery |
| `--limit <n>` | Number of messages for `messages` (default 50) |
| `--preset <name>` | Agent preset for a new conversation |
| `--json` | Structured output |

Results:

```json
{
  "sessionId": "session-...", "workspaceId": "...",
  "status": "done", "text": "the final answer",
  "turn": 3, "reason": { "kind": "completed" },
  "elapsedMs": 1888, "via": "stream", "mode": "queue",
  "imageCount": 0, "continued": 0, "truncated": false
}
```

`permission` and `streamError` appear only when relevant. Branch on `status`
(`done` / `empty` / `timeout` / `sent`), never on `text` alone.

Exit codes: `0` ok · `2` environment/auth · `3` usage or missing session ·
`4` empty reply · `5` timeout.

---

## Steer or queue

While DSH is answering (`status` reports `running: true`):

- To **interrupt / correct / add to** what it is doing → `--steer`, effective at
  the next step boundary
- To start **something unrelated** → `--queue` (default), after the current turn

When DSH is idle the two are equivalent, so keep the default. **Never steer
speculatively** — guessing wrong destroys work in progress.

---

## Images

```powershell
node $cli send --session <id> --prompt "what is wrong with this pose?" --image ".\shot.png"
node $cli send --session <id> --image ".\before.png" --image ".\after.png" --json
```

- **Sniffed by magic bytes**, not extension: `png` / `jpeg` / `webp` / `gif`
- 20 MB per image, 20 per message, 8192 px, 64 MP
- Text is optional if you send at least one image
- **The model must support vision.** This cannot be pre-checked over the Remote
  API — DSH rejects the whole message and the CLI turns that into a readable
  error naming the current route. Switch models and resend.

Sending an image costs tokens; if the file already lives in the workspace and DSH
can open it itself, passing the **path** in the prompt is cheaper.

---

## Library API

The CLI is a thin wrapper; use the library directly for anything custom.

```js
import {
  connectDsh, createSession, sendPrompt, sendSmart,
  readMessages, askWithAutoContinue,
} from './dsh_bridge.mjs'

const client = await connectDsh()                       // discover + authenticate
const { sessionId } = await createSession(client, { cwd: '/abs/project' })

const reply = await sendPrompt(client, {
  sessionId,
  text: 'hello',
  onDelta: ({ text }) => process.stderr.write(text),    // optional live stream
})
// → { status, text, turn, seq, reason, elapsedMs, sessionId, via, mode, imageCount }

// Pick steer/queue from the busy state: preferSteer=true means "interrupt if busy"
await sendSmart(client, { sessionId, text: '...', preferSteer: true })

// Truncation-aware: keeps sending "continue" and stitches the pieces
await askWithAutoContinue(client, { sessionId, text: 'write a long essay', maxContinues: 3 })

const history = await readMessages(client, { sessionId, limit: 50 })
// → [{ role, text, seq, time }]
```

Low-level subscription when you want to decide when to stop:

```js
const handle = await followSession(client, {
  sessionId,
  onEvent: (e) => { if (e.type === 'turn/end') handle.close() },
})
```

> A `followSession` handle **must** be closed, or the process never exits.
> `sendPrompt` and friends already do this for you.

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DSH_BRIDGE_URL` | Pin the endpoint, e.g. `http://127.0.0.1:19387` (skips discovery) |
| `DSH_COOKIE` | Use a supplied `dsh-auth-*` cookie instead of resolving one |
| `DSH_BRIDGE_CACHE` | Where to cache the derived cookie |
| `DSH_BOOT_LOG` | Path to `dsh-web-boot.log` for the launch-token fallback |

## Security and privacy

- Talks to **loopback only**. No external network calls, no telemetry.
- Authentication works by **reading** `~/.dsh/.credentials.yaml` and signing a
  session cookie locally with HMAC — it never transmits the secret anywhere, and
  only ever needs read access to that file.
- The cookie cache stores **derived cookies, never the secret**.
- Credentials, cookies and tokens are never printed. Keep it that way.
- It only ever touches a DSH workspace you explicitly pass with `--cwd`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `找不到正在运行的 DSH 端点` (exit 2) | Neither entry point is up. Open the desktop app or run `dsh web`. |
| Same command works in your shell but not inside your agent | Your agent's sandbox blocks loopback (Codex's offline sandbox does, via a firewall rule). Not a port problem — use a network-enabled execution mode. |
| `doctor` exits 2 on auth | DSH is not running, or `~/.dsh/.credentials.yaml` is missing. |
| Conversation missing from the DSH sidebar | `--cwd` was not the registered workspace path. Re-run `new` with the exact absolute path. |
| `status: "timeout"` | Long task: use `--no-wait` + `messages`, or raise `--timeout-ms`. |
| Process does not exit | A `followSession` handle was not closed. |
| Answer looks like it came from an earlier turn | Suspect an **ambiguous prompt** before the tool. "Reply with the previous line" makes DSH search its history. Verify with self-contained prompts. |

Protocol-level detail, including the reasoning behind each design decision, is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Tests

```bash
node --test "tests/*.test.mjs"
```

The suite covers the pure logic (image sniffing, text extraction, permission
detection, truncation classification). It needs no running DSH.

## License

[MIT](LICENSE).

---

[![Switch to 中文](https://img.shields.io/badge/%E5%88%87%E6%8D%A2%E5%88%B0-%E4%B8%AD%E6%96%87-555555?style=for-the-badge)](README.md)
