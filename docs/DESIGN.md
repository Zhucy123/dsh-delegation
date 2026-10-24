# Design notes: how `dsh_bridge.mjs` talks to DSH

This document records **why** the bridge is built the way it is. Most of it is
reverse-engineered behaviour that is not documented anywhere in the DSH UI, and
several items are the fix for a bug that took hours to find. Read this before
changing `dsh_bridge.mjs`.

- [Topology](#topology)
- [Endpoint discovery](#0-endpoint-discovery)
- [Authentication](#1-authentication-sign-a-cookie-from-the-persistent-secret)
- [Session creation](#2-create-sessions-with-workspaceid-not-cwd)
- [Waiting for a reply](#3-push-based-replies-polling-only-as-fallback)
- [Text extraction](#4-take-only-text-blocks)
- [Reading history](#5-filter-system-injections-out-of-history)
- [Matching a reply to a request](#6-locate-the-reply-with-rpcid)
- [Images](#7-images-are-content-parts-not-uploads)
- [Permission blocks](#8-permission-blocks-cannot-be-seen-in-turnend)
- [Steer vs queue](#9-steer-vs-queue)
- [Known limits](#known-limits)

## Topology

```
external program → HTTP RPC → DSH host (desktop 19387 / dsh web 3080) → DSH session
```

**No browser involved.** The DSH UI is itself a client of this RPC, so calling it
directly is both faster and more stable.

**Endpoint auto-discovery**: the desktop app and `dsh web` expose the **same API
surface**, only on different ports.

| Entry point | Port |
| --- | --- |
| DSH desktop app | `127.0.0.1:19387` (preferred) |
| `dsh web` | `127.0.0.1:3080` |

Both share the same `~/.dsh/.credentials.yaml`, so authentication is identical.
`--origin <url>` or `DSH_BRIDGE_URL` pins the endpoint and skips discovery.

## 0. Endpoint discovery

The desktop app's port is **not persisted to disk** — it is not in the process
arguments, in `%APPDATA%\@deepseek-ai\dsh-desktop`, or in `~/.dsh`. It can only
be probed. `discoverOrigin()` order:

1. `DSH_BRIDGE_URL` (explicit — skip discovery)
2. Preferred ports `19387` → `3080`
3. A small scan (`19380–19400`, `3070–3090`)

Every candidate gets a **DSH fingerprint check**: sign a cookie for it, call the
cheapest RPC (`session/modelCatalog`), and require the response to contain
`groups` / `default`. That shape is distinctive enough to reject "some other
service that happens to be listening and returns 200". Discovery + verification
takes roughly 40 ms.

The cookie is **signed per origin** (the authority is part of the signature), and
the cache is keyed by authority, so switching endpoints never leaks a cookie
across them.

## 1. Authentication: sign a cookie from the persistent secret

The launch token is **per-process** (written to `dsh-web-boot.log`) and dies on
every `dsh web` restart — it yields a straight 401 afterwards. The
`client-connection/browser-session` secret inside `~/.dsh/.credentials.yaml` is
persistent, and can be HMAC-signed directly into a 30-day `dsh-auth-*` cookie.

Resolution order: `DSH_COOKIE` → cookie cache → **freshly signed from the
persistent secret (main path)** → launch token fallback.

**Sandbox friendliness**: the cache tries `~/.dsh/` → current directory →
temp directory (override with `DSH_BRIDGE_CACHE`). If none is writable it
**skips the cache** and re-signs every run — functionality is unaffected.
Authentication only needs to **read** `.credentials.yaml`; it never needs write
access to the DSH directory.

## 2. Create sessions with `workspaceId`, not `cwd`

`session.create` accepts one of the two, and **only `workspaceId` goes through
`attachSession`**:

- `cwd` → the session works, but is **not in `workspace.sessionIds`, so the GUI
  sidebar does not show it**
- `workspaceId` → lands at the head of `sessionIds`, **visible in the GUI**

`workspace/create` is **idempotent** (an existing path returns `created:false`
with the original id), so it is safe to use it to resolve a path into an id.

## 3. Push-based replies, polling only as fallback

**Push**: connect to `ws://<discovered endpoint>/api/remote.mux` and open
`session/follow`. DSH pushes every event as it is written, so the call returns the
moment `turn/end` arrives. With `assistantStream: true` you also get incremental
frames (`--progress` uses this). The WebSocket address is **derived from the
endpoint**, never hardcoded.

**Poll fallback**: `session/page` is server-side paginated. When the WS is
unavailable the bridge falls back automatically and reports `via: "poll"` plus a
`streamError` explaining why.

**Deprecated**: polling the local zstd log. It re-read and decompressed the whole
`session.jsonl.zstd` every 400 ms, so cost grew with log size — measured at **5
minutes** for a large session. Push takes ~1.8 s, polling ~2.2 s.

## 3.1 Why the WebSocket client is hand-written

- Node's built-in `WebSocket` **cannot set custom request headers**, and
  `/api/remote.mux` requires a `Cookie`
- The `ws` package is not a dependency of the target project (it merely happens to
  exist in another pnpm store); absolute paths are unreliable
- The whole design is zero-dependency, and this keeps it that way

`dsh_ws.mjs` implements the RFC 6455 handshake, text frames, ping/pong, and
fragment reassembly.

> The DSH server sends periodic **Ping** heartbeats and drops the connection
> after two misses. Pong must be answered automatically or long replies die
> mid-stream.

## 4. Take only `text` blocks

The `content` of an `assistant/message` is an array of blocks (`reasoning` /
`text` / tool blocks / `image`). Only `type === 'text'` is taken — chain of
thought and tool activity are filtered **at the protocol layer**, not by prompt
instructions.

## 5. Filter system injections out of history

Each turn DSH writes several `user/message` events whose `source.kind` is
`runtime-context` / `skill-catalog` / `time-context` and so on. Those are system
context, not conversation. `readMessages` keeps only `kind === 'user'` by
default.

## 6. Locate the reply with `rpcId`

The prompt carries a `requestId`. When reading back, find the `user/message`
whose `source.rpcId` matches, then take only the `assistant/message` events after
it. Multi-turn and concurrent traffic never get crossed.

## 7. Images are content parts, not uploads

```js
{ type: 'image', mediaType: 'image/png', data: '<base64>', name: 'shot.png' }
```

The host **promotes the bytes to a persistent attachment**
(`attachments.admitPromptContent`), so no prior `uploadFile` is needed and the
image stays in history. (There is also a `{ type: 'file', receiptId }` pre-upload
path; it is unused.)

- **Sniff by magic bytes**, do not trust the extension (DSH sniffs too, and a
  mismatch is rejected)
- **RPC argument names are not always `request`**: `session/modelCatalog` takes
  no arguments at all (passing one yields `unexpected "request"`), and
  `session/list` calls it **`_request`**. `rpc()` therefore supports
  `{ argName }` overrides.

## 8. Permission blocks cannot be seen in `turn/end`

**Truncation** is easy: `reason.kind === 'max-tokens'`. It is **sticky** — a later
step completing normally does not downgrade it to `completed` — so the check is
reliable.

**Permission blocks are not**: a denial **does not end the turn**. DSH hands the
refusal to the model as a tool result and it keeps going. The events of the turn
must be scanned:

| Signal | Reliability |
| --- | --- |
| `error.code` ∈ `FS_SANDBOX_DENIED` etc. | highest |
| `approval/asked` + `approval/decided` (rejected/cancelled/unavailable) | high |
| `tool/result` text (`the user rejected tool` / `requires approval` / `no approval channel` / `[sandbox: file access denied`) | medium (wording changes) |

> **Pitfall**: the real shape of `tool/result` is `data.message.content`
> (`{turn, step, message:{role:'tool', content:[...], isError}, error?}`),
> **not `data.content`**. An early implementation read the latter and **missed**
> real sandbox denials. `toolResultText()` now handles multiple shapes and
> prefers structured error codes.

## 9. Steer vs queue

| mode | inbox target | semantics |
| --- | --- | --- |
| `queue` (default) | `next-turn` | append a turn, wait for the current one |
| `steer` | `next-step` | **inject into the current turn**, effective at the next step boundary |

Source: `commands.ts:364-365`, `agent.ts:163-169`.

**Observed behaviour**: asking DSH to count to 80, then sending `--steer` with
"stop, reply only: inserted" mid-turn — within the same turn (the
`agent/inbox/spliced` event carries `target=next-step`), DSH switched at 20.
`queue` instead produces an independent `turn/start`.

**Busy check**: `SessionSummary.running` from `session/list` (argument name
`_request`).

**Design decision: no automatic choice.** The tool exposes `--steer` / `--queue`
plus `status`, and the caller decides by **semantics**. Auto-steering breaks
in-flight work whenever the user actually meant something unrelated, and that
judgement depends on prompt intent, which the tool cannot see.

## Known limits

- **Serial per session**: do not `send` concurrently into the same `sessionId` —
  turns get crossed. Open separate sessions to parallelise.
- **Whether images can be sent depends on the model**, and cannot be checked
  ahead of time (see above).
- **`followSession` handles must be `close()`d**, or the process will not exit.
- **Incremental frame text location**: `onDelta` already picks the text out of
  the chunk (`delta.text` / `text` / `content`). If DSH changes the block shape,
  that one place in `dsh_bridge.mjs` is all that needs updating.
- **`--progress` writes to stderr** by design, so `--json` stdout stays clean and
  parseable.
- **A timeout does not cancel the DSH-side task**: `--timeout-ms` only stops the
  local wait. Use `session/cancel` to actually interrupt.

## Verifying behaviour without ambiguous prompts

An early round of testing produced a false "wrong answer" alarm: the prompt was
"reply only with the queued line", intended as a verbatim echo. DSH read "the
queued line" as *a lookup in history* and answered with an earlier `--steer`
message. It looked like the bridge had picked the wrong reply; the prompt was
simply ambiguous. The same trap appears with "what number did I tell you to
remember?" once several numbers exist in history.

**Rule**: verify with **self-contained, referent-free** prompts ("reply only with
ABC123", not "reply with the previous line"). When an answer looks crossed, read
the raw events from `session/page` first — the model's `reasoning` block usually
shows it deliberating over *which* line the user meant.

## Changelog

- **2026-10-06** Steer vs queue: `sessionStatus()` / `sendSmart()`, the `status`
  subcommand, `--steer` / `--queue`, `mode` and `runningWhenSent` fields.
  (Found that `session/list` names its argument `_request`.)
- **2026-10-03** Two failure classes: `askWithAutoContinue()` for truncation
  auto-continue; `detectPermissionBlock()` for permission blocks that must be
  reported rather than retried. Fixed the `tool/result` shape miss
  (`data.message.content`).
- **2026-09-29 (4)** Desktop app support: `discoverOrigin()` /
  `probeDshOrigin()`, `--origin`. Fixed `dsh_cli.mjs` being re-encoded as GBK by
  `Set-Content -Encoding UTF8`, which corrupted the Chinese text.
- **2026-09-29 (3)** Native image input: `images` option, `--image`,
  `imageCount`; `rpc()` gained `argName`.
- **2026-09-29 (2)** Push-based replies: new `dsh_ws.mjs`, `followSession()` /
  `awaitReplyStreaming()`, `--poll` / `--progress` / `via`.
- **2026-09-29 (1)** First version: persistent-secret auth, `workspaceId` session
  creation, `session/page` instead of zstd polling, structured results and exit
  codes.

> **Do not edit these files with `Set-Content -Encoding UTF8`** — on Windows it
> re-encodes UTF-8 as GBK, corrupting Chinese text and adding a BOM. Use an
> editor or a proper UTF-8 writer.
