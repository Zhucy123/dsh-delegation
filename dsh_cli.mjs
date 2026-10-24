#!/usr/bin/env node
/**
 * dsh_cli.mjs —— 把本机 DSH 当子智能体调用的命令行入口。
 *
 * 用法：
 *   # 新建对话并让 DSH 干活，等回答
 *   node dsh_cli.mjs new --cwd "D:\proj" --prompt-file task.md
 *   node dsh_cli.mjs new --cwd "D:\proj" --prompt "你好"
 *
 *   # 在同一对话里继续（--session 复用，上下文保留）
 *   node dsh_cli.mjs send --session <sessionId> --prompt "追问"
 *
 *   # 带图片（模型真的看图，不是拿路径）
 *   node dsh_cli.mjs send --session <id> --prompt "描述这张图" --image "C:\a.png"
 *
 *   # 只发不等（适合长任务）
 *   node dsh_cli.mjs send --session <id> --prompt "..." --no-wait
 *
 *   # 读会话历史
 *   node dsh_cli.mjs messages --session <id> [--limit 50]
 *
 *   # 环境自检
 *   node dsh_cli.mjs doctor
 *
 * 输出：默认打印人类可读结果；加 --json 输出结构化 JSON（供程序解析）。
 * 退出码：0 成功；2 认证/环境失败；3 会话或参数错误；4 DSH 回答为空；5 超时。
 *
 * 端点：自动发现桌面端或 dsh web（同一 API 面，端口不同）。
 * 也可用 --origin 或环境变量 DSH_BRIDGE_URL 显式指定。
 *
 * 重要：本工具**不依赖浏览器**。不要用 computer use / 浏览器控制去操作 DSH 页面，
 * 那既慢又脆；这里直接走 DSH 的 HTTP RPC。
 */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  connectDsh,
  createSession,
  sendPrompt,
  askWithAutoContinue,
  readMessages,
  buildContent,
  currentModelRoute,
  sessionStatus,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_CONTINUES,
} from './dsh_bridge.mjs'

const EXIT = { ok: 0, env: 2, usage: 3, empty: 4, timeout: 5 }

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    command: undefined,
    cwd: process.cwd(),
    prompt: undefined,
    promptFile: undefined,
    session: undefined,
    limit: 50,
    wait: true,
    json: false,
    timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    preset: undefined,
    streaming: true,
    progress: false,
    images: [],
    origin: undefined,
    autoContinue: DEFAULT_MAX_CONTINUES,
    mode: undefined,
  }
  const args = [...argv]
  const command = args.shift()
  if (command === undefined || command === '--help' || command === '-h') {
    options.help = true
    return options
  }
  options.command = command

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--cwd') options.cwd = args[++index]
    else if (arg === '--prompt') options.prompt = args[++index]
    else if (arg === '--prompt-file') options.promptFile = args[++index]
    else if (arg === '--image') options.images.push(args[++index])
    else if (arg === '--origin') options.origin = args[++index]
    else if (arg === '--no-auto-continue') options.autoContinue = 0
    else if (arg === '--max-continues') options.autoContinue = Number(args[++index])
    else if (arg === '--steer') options.mode = 'steer'
    else if (arg === '--queue') options.mode = 'queue'
    else if (arg === '--session') options.session = args[++index]
    else if (arg === '--limit') options.limit = Number(args[++index])
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++index])
    else if (arg === '--preset') options.preset = args[++index]
    else if (arg === '--no-wait') options.wait = false
    else if (arg === '--json') options.json = true
    else if (arg === '--poll') options.streaming = false
    else if (arg === '--progress') options.progress = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new UsageError(`未知参数：${arg}`)
  }
  return options
}

function printHelp() {
  process.stdout.write(`把本机 DSH 当子智能体调用（不走浏览器）。

用法：
  new       新建对话并（可选）发消息
  send      在已有对话里发消息
  status    看某会话当前是否在回答中（决定插入还是排队）
  messages  读对话历史
  doctor    环境自检

通用参数：
  --cwd <绝对路径>     工作目录（new 用；决定会话归入哪个工作区）
  --prompt <文本>      消息内容
  --prompt-file <路径> 从文件读消息
  --image <路径>       附一张图片（可重复）；图片会原生发给模型，
                       不是把路径当文本。支持 png/jpeg/webp/gif。
  --session <id>       会话 id（send/messages 用）
  --preset <名称>      会话预设（new 用，可选）
  --origin <URL>       显式指定 DSH 端点（默认自动发现）
  --no-wait            只发送不等待（长任务推荐）
  --timeout-ms <毫秒>  等待上限（默认 ${DEFAULT_WAIT_TIMEOUT_MS}）
  --limit <条数>       messages 返回条数（默认 50）
  --poll               强制用轮询等待（默认走推送式 WebSocket）
  --progress           实时打印增量文本（写到 stderr）
  --max-continues <次> 输出被 token 上限截断时自动发「继续」的上限
                       （默认 ${DEFAULT_MAX_CONTINUES}；0 = 不自动续写）
  --no-auto-continue   等同 --max-continues 0
  --steer              插入当前轮（DSH 正在回答时打断它，先处理这句）
  --queue              排到下一轮（默认；等 DSH 说完再处理）
  --json               输出结构化 JSON

插入还是排队：
  DSH 正在回答（running=true）时，
    · 要「打断 / 纠正 / 补充」当前这件事 → --steer
    · 要「另起一件不相关的事」 → --queue（默认）
  DSH 空闲时两者等价（都开新一轮），默认 queue 即可。
  先用 status 查当前状态：
    node dsh_cli.mjs status --session <id>

行为约定：
  · 输出被 token 上限截断 → 自动续发「继续」并把片段拼成完整回答；
    单次调用内最多续写 ${DEFAULT_MAX_CONTINUES} 次（超过则 truncated=true）。
  · DSH 侧因权限/审批受阻 → **不重发任务**，而是在 stderr 提示用户去
    批准请求或调整权限；结果 JSON 里带 permission 字段。

示例：
  node dsh_cli.mjs doctor
  node dsh_cli.mjs new --cwd "D:\\\\proj" --prompt "你好" --json
  node dsh_cli.mjs send --session session-xxx --prompt "现在几点了"
  node dsh_cli.mjs messages --session session-xxx --limit 10

带图片（模型真的看图，不是拿路径）：
  node dsh_cli.mjs send --session session-xxx --prompt "描述这张图" --image "C:\\\\a.png"
  node dsh_cli.mjs send --session session-xxx --image "C:\\\\a.png" --image "C:\\\\b.jpg" --json
`)
}

async function resolvePrompt(options) {
  if (options.promptFile !== undefined && options.prompt !== undefined) {
    throw new UsageError('--prompt 和 --prompt-file 只能给一个。')
  }
  if (options.promptFile !== undefined) {
    return (await readFile(path.resolve(options.promptFile), 'utf8')).trim()
  }
  return options.prompt
}

function emit(options, human, payload) {
  if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  else process.stdout.write(human + '\n')
}

/**
 * 构造增量文本回调：--progress 时把流式增量实时写到 stderr，
 * 这样 stdout 仍只有最终结果（--json 可安全解析）。
 */
function progressReporter(options) {
  if (options.progress !== true) return undefined
  let started = false
  return ({ text }) => {
    if (!started) {
      started = true
      process.stderr.write('[DSH 生成中] ')
    }
    process.stderr.write(text)
  }
}

/** 自动续写时在 stderr 报一声，让用户知道发生了截断续写。 */
function continueReporter(options) {
  const quiet = options.json === true && options.progress !== true
  return ({ round }) => {
    if (quiet) return
    process.stderr.write(`\n[已达输出上限，自动发送「继续」第 ${round} 次]\n`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return EXIT.ok }

  if (options.command === 'doctor') {
    const client = await connectDsh({ origin: options.origin, forceDiscover: true })
    const workspaceId = (await client.rpc('workspace/create', { path: path.resolve(options.cwd) }))
      .workspace.workspaceId
    const route = client.route ?? await currentModelRoute(client)
    const note = client.endpoint === 'preferred' ? '（自动发现）'
      : client.endpoint === 'scan' ? '（扫描发现）'
        : client.endpoint === 'env' ? '（来自 DSH_BRIDGE_URL）'
          : '（显式指定）'
    emit(options,
      `OK  DSH 连接正常\n    origin    : ${client.origin} ${note}`
      + `\n    认证方式  : ${client.via}`
      + `\n    工作区 id : ${workspaceId}`
      + `\n    默认路由  : ${route === null ? '(未知)' : `${route.provider}/${route.model}`}`,
      { ok: true, origin: client.origin, endpoint: client.endpoint, via: client.via, workspaceId, route })
    return EXIT.ok
  }

  if (options.command === 'new') {
    const promptText = await resolvePrompt(options)
    const client = await connectDsh({ origin: options.origin })
    const created = await createSession(client, {
      cwd: path.resolve(options.cwd),
      preset: options.preset,
    })
    if (promptText === undefined && options.images.length === 0) {
      emit(options,
        `已新建对话\n    sessionId : ${created.sessionId}\n    workspaceId : ${created.workspaceId}`,
        { ...created, status: 'created' })
      return EXIT.ok
    }
    if (!options.wait) {
      await client.rpc('session/prompt', {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: buildContent(promptText, options.images),
      })
      emit(options,
        `已新建对话并发送（未等待）\n    sessionId : ${created.sessionId}`,
        { ...created, status: 'sent', imageCount: options.images.length })
      return EXIT.ok
    }
    const reply = await askWithAutoContinue(client, {
      sessionId: created.sessionId,
      text: promptText,
      images: options.images,
      timeoutMs: options.timeoutMs,
      streaming: options.streaming,
      maxContinues: options.autoContinue,
      onDelta: progressReporter(options),
      onContinue: continueReporter(options),
    })
    return reportReply(options, created, reply)
  }

  if (options.command === 'send') {
    if (options.session === undefined) throw new UsageError('send 需要 --session <id>。')
    const promptText = await resolvePrompt(options)
    if (promptText === undefined && options.images.length === 0) {
      throw new UsageError('send 需要 --prompt / --prompt-file，或 --image。')
    }
    const client = await connectDsh({ origin: options.origin })
    if (!options.wait) {
      const mode = options.mode ?? 'queue'
      await client.rpc('session/prompt', {
        requestId: randomUUID(),
        sessionId: options.session,
        mode,
        content: buildContent(promptText, options.images),
      })
      emit(options, `已发送（未等待，${mode}），sessionId: ${options.session}`,
        { sessionId: options.session, status: 'sent', mode, imageCount: options.images.length })
      return EXIT.ok
    }
    const reply = await askWithAutoContinue(client, {
      sessionId: options.session,
      text: promptText,
      images: options.images,
      timeoutMs: options.timeoutMs,
      streaming: options.streaming,
      maxContinues: options.autoContinue,
      mode: options.mode,
      onDelta: progressReporter(options),
      onContinue: continueReporter(options),
    })
    return reportReply(options, { sessionId: options.session }, reply)
  }

  if (options.command === 'status') {
    if (options.session === undefined) throw new UsageError('status 需要 --session <id>。')
    const client = await connectDsh({ origin: options.origin })
    const status = await sessionStatus(client, options.session)
    if (status === null) {
      emit(options, `会话不在活动列表里：${options.session}（可能已删除或从未存在）`,
        { sessionId: options.session, found: false })
      return EXIT.usage
    }
    const verdict = status.running
      ? 'DSH 正在回答中 —— 想插话用 --steer，想等它说完再处理用 --queue'
      : 'DSH 空闲 —— 直接发即可（会开新一轮）'
    emit(options,
      `session=${options.session}\n    running          : ${status.running}\n`
      + `    agentAvailable   : ${status.agentAvailable}\n`
      + `    标题             : ${status.title ?? '(无)'}\n`
      + `    → ${verdict}`,
      { sessionId: options.session, found: true, ...status })
    return EXIT.ok
  }

  if (options.command === 'messages') {
    if (options.session === undefined) throw new UsageError('messages 需要 --session <id>。')
    const client = await connectDsh({ origin: options.origin })
    const messages = await readMessages(client, { sessionId: options.session, limit: options.limit })
    const human = messages
      .map((message) => `[${message.role === 'user' ? '我' : 'DSH'}] ${message.text}`)
      .join('\n\n')
    emit(options, human === '' ? '(无消息)' : human,
      { sessionId: options.session, count: messages.length, messages })
    return EXIT.ok
  }

  throw new UsageError(`未知子命令：${options.command}`)
}

function reportReply(options, created, reply) {
  // --progress 写过增量，收尾时换行，避免与最终结果粘在一起
  if (options.progress === true) process.stderr.write('\n')
  const base = {
    sessionId: created.sessionId,
    workspaceId: created.workspaceId ?? null,
    status: reply.status,
    text: reply.text,
    turn: reply.turn,
    reason: reply.reason ?? null,
    elapsedMs: reply.elapsedMs,
    via: reply.via ?? null,
    mode: reply.mode ?? 'queue',
    ...(reply.running === undefined ? {} : { runningWhenSent: reply.running }),
    imageCount: reply.imageCount ?? 0,
    continued: reply.continued ?? 0,
    truncated: reply.truncated ?? false,
    ...(reply.permission === undefined ? {} : { permission: reply.permission }),
    ...(reply.streamError === undefined ? {} : { streamError: reply.streamError }),
  }
  const bits = [reply.via ?? '?']
  if (reply.imageCount > 0) bits.push(`含 ${reply.imageCount} 张图`)
  if (reply.continued > 0) bits.push(`自动续写 ${reply.continued} 次`)
  const suffix = bits.join('，')

  // 权限/审批受阻：这是**用户**要去处理的事，绝不重发任务规避
  if (reply.permission !== undefined) {
    const who = reply.permission.toolName === null ? '某个工具' : `工具 "${reply.permission.toolName}"`
    const tail = reply.permission.evidence === null ? '' : `\n  证据：${reply.permission.evidence}`
    process.stderr.write(
      `\n⚠ DSH 侧因权限/审批受阻（${who}）。\n`
      + '  这需要用户处理，重发任务解决不了：\n'
      + '    · 到 DSH 界面里批准那条待审批请求，或\n'
      + '    · 调整该会话的权限模式 / 沙箱范围，或\n'
      + '    · 授予对应工具或目录的访问权\n'
      + `  然后让 DSH 继续该任务（同一会话 send，不要新建对话）。${tail}\n`,
    )
  }

  if (reply.status === 'done') {
    let human = `DSH 回答（${(reply.elapsedMs / 1000).toFixed(1)}s，${suffix}，session=${created.sessionId}）：\n\n${reply.text}`
    if (reply.truncated === true) {
      human += `\n\n⚠ 已达最大续写次数（${options.autoContinue}），输出可能仍不完整。`
        + '可再发一次 --prompt "继续"，或调大 --max-continues。'
    }
    emit(options, human, base)
    return EXIT.ok
  }
  if (reply.status === 'empty') {
    emit(options, `DSH 结束了这一轮但没有任何文本回答。session=${created.sessionId}`, base)
    return EXIT.empty
  }
  emit(options, `等待 DSH 回答超时（${(reply.elapsedMs / 1000).toFixed(1)}s）。session=${created.sessionId}`, base)
  return EXIT.timeout
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    const isUsage = error instanceof UsageError
    // 会话/分支不存在归到「会话错误(3)」，而不是环境错误(2)
    const isSession = /not found|不存在|unknown session|no such session/i.test(message)
    process.stderr.write(`${isUsage ? '参数错误' : '失败'}：${message}\n`)
    process.exitCode = isUsage || isSession ? EXIT.usage : EXIT.env
  })
