# dsh-delegation

**Let any coding agent delegate work to a local DeepSeek Harness (DSH) instance —
create a conversation, keep talking in it, send screenshots, and read the answers
back.**

Zero dependencies. Node 18+. Works with the DSH desktop app and `dsh web`.

> [中文说明见下方](#中文版)

---

## English

### What it is

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

### Requirements

- **Node 18+** (uses global `fetch`)
- A running DSH instance: the desktop app, or `dsh web`
- A DSH credential store at `~/.dsh/.credentials.yaml` (created by DSH itself)

### Install

```powershell
# Windows / Codex
git clone <this-repo> "$env:USERPROFILE\.codex\skills\dsh-delegation"
node "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs" doctor
```

```bash
# macOS / Linux
git clone <this-repo> ~/.local/share/dsh-delegation
node ~/.local/share/dsh-delegation/dsh_cli.mjs doctor
```

Or drop the folder anywhere and call it by path — it has no install step and no
build step. `SKILL.md` is the behavioural guide an agent reads; if your agent
supports skills, put this folder in its skills directory (see
[`SKILL.md`](SKILL.md)).

### Quick start

```powershell
$cli = "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs"

node $cli doctor                                              # is DSH reachable?
node $cli new --cwd "C:\my-project" --prompt "explain the build script" --json
node $cli send --session <id> --prompt "now optimise it" --json
node $cli messages --session <id> --limit 20                  # read it all back
```

`doctor` prints the endpoint, how it authenticated, and the default model route:

```
OK  DSH 连接正常
    origin    : http://127.0.0.1:19387 （自动发现）
    认证方式  : persistent-secret
    工作区 id : workspace-...
    默认路由  : provider/model
```

### CLI reference

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

### Images

```powershell
node $cli send --session <id> --prompt "what is wrong with this pose?" --image ".\shot.png"
node $cli send --session <id> --image ".\before.png" --image ".\after.png" --json
```

- Sniffed by **magic bytes**, not extension: `png` / `jpeg` / `webp` / `gif`
- 20 MB per image, 20 per message, 8192 px, 64 MP
- Text is optional if you send at least one image
- **The model must support vision.** This cannot be pre-checked over the Remote
  API — DSH rejects the whole message and the CLI turns that into a readable
  error naming the current route. Switch models and resend.

Sending an image costs tokens; if the file already lives in the workspace and DSH
can open it itself, passing the **path** in the prompt is cheaper.

### Library API

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

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DSH_BRIDGE_URL` | Pin the endpoint, e.g. `http://127.0.0.1:19387` (skips discovery) |
| `DSH_COOKIE` | Use a supplied `dsh-auth-*` cookie instead of resolving one |
| `DSH_BRIDGE_CACHE` | Where to cache the derived cookie |
| `DSH_BOOT_LOG` | Path to `dsh-web-boot.log` for the launch-token fallback |

### Security and privacy

- Talks to **loopback only**. No external network calls, no telemetry.
- Authentication works by **reading** `~/.dsh/.credentials.yaml` and signing a
  session cookie locally with HMAC — it never transmits the secret anywhere, and
  only ever needs read access to that file.
- The cookie cache stores **derived cookies, never the secret**.
- Credentials, cookies and tokens are never printed. Keep it that way.
- It only ever touches a DSH workspace you explicitly pass with `--cwd`.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `找不到正在运行的 DSH 端点` (exit 2) | Neither entry point is up. Open the desktop app or run `dsh web`. |
| Same command works in your shell but not inside your agent | Your agent's sandbox blocks loopback (Codex's offline sandbox does, via a firewall rule). Not a port problem — use a network-enabled execution mode. |
| `doctor` exits 2 on auth | DSH is not running, or `~/.dsh/.credentials.yaml` is missing. |
| Conversation missing from the DSH sidebar | `--cwd` was not the registered workspace path. Re-run `new` with the exact absolute path. |
| `status: "timeout"` | Long task: use `--no-wait` + `messages`, or raise `--timeout-ms`. |
| Process does not exit | A `followSession` handle was not closed. |
| Answer looks like it came from an earlier turn | Suspect an **ambiguous prompt** before the tool. "Reply with the previous line" makes DSH search its history. Verify with self-contained prompts. |

More protocol-level detail, including the reasons behind each design decision, is
in [`docs/DESIGN.md`](docs/DESIGN.md).

### Tests

```bash
node --test tests/
```

The suite covers the pure logic (image sniffing, text extraction, permission
detection, truncation classification). It needs no running DSH.

### License

[MIT](LICENSE).

---

## 中文版

**让任意编码 agent 把活派给本机的 DeepSeek Harness（DSH）：新建对话、持续追问、
发截图、取回回答。**

零依赖，需 Node 18+，桌面端与 `dsh web` 都支持。

### 它是什么

DSH 没有官方的「从别的程序调我」API。但它的 UI 本身就是走 loopback 上的 HTTP RPC
的客户端，所以这个工具直接调同一套 RPC —— 不用浏览器自动化，不用点界面，不用截图。

```
你的 agent ──► dsh_cli.mjs ──► HTTP RPC ──► DSH 宿主 ──► 一个真实的 DSH 对话
                              （或 WebSocket，用于推送式取回）
```

因为对话落在真实的 DSH 工作区里，**你可以在 DSH 侧边栏看着它、手动插话、事后接着聊**，
它不是一个藏起来的旁路通道。

### 为什么不是「起两次命令行」

因为对话有记忆。`new` 建一次会话，后续都用 `send --session` 发给同一个会话，上下文
就完整保留 —— 「先看看这块代码，再改，再跑测试」这种多轮任务才做得像人做的。每次调用
只返回**最终回答**，思维链和工具过程在协议层就被滤掉了。

### 特性

| | |
| --- | --- |
| **会话可持续** | `new` 之后反复 `send` 进同一个会话 |
| **端点自动发现** | 探测桌面端与 `dsh web`，并校验对面确实是 DSH |
| **推送式取回答** | 订阅事件流，`turn/end` 一到即返回（约 2 秒，不是轮询节奏） |
| **原生发图** | PNG / JPEG / WebP / GIF 作为真实内容块发送，模型真的看得见 |
| **插入 vs 排队** | `--steer` 注入当前轮；`--queue`（默认）排到下一轮 |
| **截断自动续写** | 撞到输出上限时自动续发「继续」并拼接片段 |
| **如实报告失败** | 能识别权限/审批受阻，报告而不是假装成功或盲目重试 |
| **零依赖** | 只用 Node 内置模块，手写了极简 WebSocket 客户端 |

### 依赖

- **Node 18+**（用全局 `fetch`）
- 一个在跑的 DSH：桌面端应用或 `dsh web`
- DSH 自己的凭据文件 `~/.dsh/.credentials.yaml`

### 安装

```powershell
# Windows / Codex
git clone <this-repo> "$env:USERPROFILE\.codex\skills\dsh-delegation"
node "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs" doctor
```

```bash
# macOS / Linux
git clone <this-repo> ~/.local/share/dsh-delegation
node ~/.local/share/dsh-delegation/dsh_cli.mjs doctor
```

也可以把目录放到任何位置，用绝对路径调用 —— 没有安装步骤，没有构建步骤。
`SKILL.md` 是给 agent 读的行为规范；如果你的 agent 支持 skills，把整个目录放进它的
skills 目录即可。

### 快速开始

```powershell
$cli = "$env:USERPROFILE\.codex\skills\dsh-delegation\dsh_cli.mjs"

node $cli doctor                                              # 环境自检
node $cli new --cwd "C:\my-project" --prompt "讲讲这个构建脚本" --json
node $cli send --session <id> --prompt "现在优化它" --json
node $cli messages --session <id> --limit 20                  # 把整段对话读回来
```

### 命令行参考

| 子命令 | 作用 |
| --- | --- |
| `doctor` | 连通性、认证方式、工作区 id、默认模型路由 |
| `new` | 在指定工作区（`--cwd`）新建对话，可选地发第一条消息 |
| `send` | 往已有对话里发消息（`--session`） |
| `status` | DSH 现在是否在回答？决定插入还是排队 |
| `messages` | 读对话历史 |

| 参数 | 说明 |
| --- | --- |
| `--cwd <绝对路径>` | **决定会话归入哪个工作区**（GUI 侧边栏可见的位置） |
| `--prompt` / `--prompt-file` | 消息内容（二选一） |
| `--image <路径>` | 附图片（可重复），原生发给模型 |
| `--session <id>` | 复用对话（`send` / `status` / `messages` 必需） |
| `--steer` / `--queue` | 插入当前轮 / 排到下一轮（默认 queue） |
| `--no-wait` | 只发不等，适合长任务 |
| `--timeout-ms` | 等待上限，默认 180000 |
| `--max-continues <n>` / `--no-auto-continue` | 截断自动续写上限，默认 3 |
| `--poll` | 强制轮询（默认推送式） |
| `--progress` | 增量文本实时写 **stderr**（stdout 保持干净） |
| `--origin <URL>` | 显式指定端点，跳过发现 |
| `--limit <n>` | `messages` 条数，默认 50 |
| `--preset <名称>` | 新建会话的 agent 预设 |
| `--json` | 结构化输出 |

返回结构同上。`permission` / `streamError` 只在相应情况出现。按 `status` 分支
（`done` / `empty` / `timeout` / `sent`），不要只看 `text`。

退出码：`0` 成功 · `2` 认证/环境 · `3` 参数或会话错误 · `4` 回答为空 · `5` 超时。

### 插入还是排队

DSH 正在回答（`status` 显示 `running: true`）时：

- 要**打断 / 纠正 / 补充**当前这件事 → `--steer`，下一个 step 边界生效
- 要**另起一件不相关的事** → `--queue`（默认），等当前轮跑完

DSH 空闲时两者等价，用默认值即可。**不要凭猜测 steer** —— 猜错会破坏进行中的工作。

### 发图片

```powershell
node $cli send --session <id> --prompt "这个姿势哪里不对" --image ".\shot.png"
```

- **按 magic bytes 嗅探**，不信扩展名：`png` / `jpeg` / `webp` / `gif`
- 单图 20 MB、单条 20 张、8192 px、6400 万像素
- 只发图不带文本也可以
- **模型必须支持视觉**。这一点无法预检（Remote 面不暴露该能力）；DSH 会拒掉整条
  消息，工具据此给出带当前路由的可读报错。换模型后重发。

图已经在工作区、DSH 自己读得到时，在提示词里给**路径**更省 token（大图/多图尤其如此）。

### 库 API

命令行只是薄壳，自定义需求直接调库：

```js
import {
  connectDsh, createSession, sendPrompt, sendSmart,
  readMessages, askWithAutoContinue,
} from './dsh_bridge.mjs'

const client = await connectDsh()                       // 自动发现 + 认证
const { sessionId } = await createSession(client, { cwd: 'D:\\proj' })

const reply = await sendPrompt(client, {
  sessionId,
  text: '你好',
  onDelta: ({ text }) => process.stderr.write(text),    // 可选：实时增量
})

// 按忙碌状态自动选 steer / queue（preferSteer=true 时忙碌则插入）
await sendSmart(client, { sessionId, text: '...', preferSteer: true })

// 截断感知：自动续写并拼接成完整回答
await askWithAutoContinue(client, { sessionId, text: '写一篇长文', maxContinues: 3 })

const history = await readMessages(client, { sessionId, limit: 50 })
```

底层订阅（自己决定何时结束）：

```js
const handle = await followSession(client, {
  sessionId,
  onEvent: (e) => { if (e.type === 'turn/end') handle.close() },
})
```

> `followSession` 的 handle **必须 `close()`**，否则连接挂着、进程不退出。
> `sendPrompt` 内部已自动收尾。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_BRIDGE_URL` | 固定端点，如 `http://127.0.0.1:19387`（跳过发现） |
| `DSH_COOKIE` | 直接提供 `dsh-auth-*` cookie，跳过解析 |
| `DSH_BRIDGE_CACHE` | 派生 cookie 的缓存位置 |
| `DSH_BOOT_LOG` | launch token 兜底用的 `dsh-web-boot.log` 路径 |

### 安全与隐私

- **只连 loopback**，没有任何外部网络请求，不做遥测。
- 认证是**读取** `~/.dsh/.credentials.yaml` 后用 HMAC 在本地签一个会话 cookie ——
  密钥不上网，也只要求对该文件的读权限。
- cookie 缓存里只有**派生出的 cookie，没有密钥本身**。
- 凭据、cookie、token 一律不打印。
- 只会碰你用 `--cwd` 明确指定的那个 DSH 工作区。

### 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到正在运行的 DSH 端点`（退出码 2） | 两个入口都没起来。开桌面端或跑 `dsh web`。 |
| 你自己终端能跑，在 agent 里不行 | agent 的沙箱封了 loopback（Codex 离线沙箱就有一条防火墙规则）。不是端口问题 —— 换允许网络的执行模式。 |
| `doctor` 退出码 2，提示认证 | DSH 没在跑，或 `~/.dsh/.credentials.yaml` 不存在。 |
| 会话在 DSH 侧边栏看不到 | `--cwd` 不是已注册的工作区路径。用精确的绝对路径重跑 `new`。 |
| `status: "timeout"` | 任务太长：用 `--no-wait` + `messages`，或加大 `--timeout-ms`。 |
| 命令跑完进程不退出 | 有 `followSession` handle 没 close。 |
| 回答「不对」，像是上一轮的 | 先怀疑**提示词有歧义**，不是工具串轮。用自包含、无指代的提示词复验。 |

协议层细节（每条设计决定的原因、踩过的坑）见
[`docs/DESIGN.md`](docs/DESIGN.md)。

### 测试

```bash
node --test tests/
```

覆盖纯逻辑（图片嗅探、文本提取、权限受阻识别、截断判定），不需要 DSH 在跑。

### 许可证

[MIT](LICENSE)。
