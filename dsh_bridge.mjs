/**
 * dsh_bridge.mjs —— 把本机 DSH 当成外部程序可调用的子智能体。
 *
 * 能力：新建对话 / 持续发消息 / 取回 AI 回答 / 读全量消息。
 * 对上层 agent 是谁没有假设：Codex、Claude Code、一段脚本、CI 都能用。
 *
 * 设计要点（均为实际运行验证过的结论，不是推测）：
 *
 * 0) **端点自动发现**：桌面端与 `dsh web` 提供**同一个** HTTP API 面，只是端口不同。
 *    - 桌面端默认 19387；`dsh web` 默认 3080。
 *    - 两者共用同一份持久 secret，认证方式完全一致 —— 所以同一套代码两条路都通。
 *    - discoverOrigin() 先探首选端口，再小范围扫描，并用 modelCatalog 做**指纹校验**
 *      （确认对面真是 DSH，而不是碰巧 200 的别的服务）。发现+校验约 40ms。
 *    - 可用 DSH_BRIDGE_URL 显式指定，跳过发现。
 *
 * 1) 认证走**持久 secret 直接签 cookie**，不依赖易变的 launch token。
 *    - launch token 是每进程一次的（写进 dsh-web-boot.log），dsh web 一重启就失效，
 *      此时会直接 401。
 *    - 而 ~/.dsh/.credentials.yaml 里的 client-connection/browser-session secret
 *      是持久的，可直接 HMAC 签出 30 天有效的 dsh-auth-* cookie。
 *    - cookie 是**按 origin 签的**（authority 进签名），所以桌面端 / web 各有自己的
 *      cookie，缓存也按 authority 分开存。
 *    - 解析顺序：环境变量 → cookie 缓存 → 持久 secret 现签 → launch token 兜底。
 *
 * 2) 建会话传 **workspaceId**，不要传 cwd。
 *    - 源码结论：session.create 只接受 workspaceId 或 cwd 其一；且**只有传 workspaceId
 *      才会 attachSession**，会话才会出现在 GUI 侧边栏的工作区列表里。
 *    - 行为：传 cwd 建的会话不在 workspace.sessionIds 里（GUI 看不见）；
 *      传 workspaceId 建的会话会进入 sessionIds 首位（GUI 可见）。
 *    - workspace/create 是**幂等**的，已存在则返回 created:false + 原 workspaceId，
 *      所以可以放心用它把路径解析成 id。
 *
 * 3) 取回答默认走**推送式**（WebSocket `session/follow`），轮询仅作兜底。
 *    - 推送：DSH 每写一个事件就立即推来，`turn/end` 一到即返回，无轮询间隔；
 *      并可选拿 assistant 增量帧（边生成边回传）。一轮通常 3-7s。
 *    - 兜底：`session/page` 服务端分页查询（旧的本地 zstd 日志轮询已废弃 ——
 *      它每 400ms 重读并解压整个日志，复杂度随会话增长，实测要 5 分钟）。
 *    - 同理，读历史也用 `session/page`，不碰本地日志。
 *    - WebSocket 因故不可用时 sendPrompt 会**自动回退**轮询，结果 via 字段标明路径。
 *
 * 4) 回答只取 text 块。
 *    assistant/message 的 content 是 block 数组（reasoning/text/tool_use/image…），
 *    只取 type==='text' 才是用户该看的内容，思维链和工具过程必须滤掉。
 *
 * 5) 返回值是**结构化的**，不是裸字符串。
 *    { status, text, turn, seq, elapsedMs, sessionId, via }
 *    status: done | empty | timeout | failed —— 让调用方能区分
 *    「DSH 说了空话」和「DSH 挂了」，而不是静默拿到空串。
 *
 * 依赖：零（只用 Node 内置模块 + 全局 fetch；WebSocket 自行实现于 dsh_ws.mjs，
 * 因为 Node 内置 WebSocket 无法自定义 Cookie 头，而 DSH 的 /api/remote.mux 需要认证）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, extname, basename } from 'node:path'
import { Socket } from 'node:net'
import { connectWebSocket } from './dsh_ws.mjs'

// ---------------------------------------------------------------- 常量

/**
 * DSH WebUI 地址。可用 DSH_BRIDGE_URL 覆盖 —— **显式指定时不做发现**。
 *
 * 注意这是「首选/兜底」值，正常路径由 discoverOrigin() 决定实际端点
 * （桌面端 19387 / `dsh web` 3080，同一 API 面）。
 */
export const DEFAULT_ORIGIN = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080'

/** 优先探测的端口：桌面端默认值，再是 dsh web 默认值。 */
const PREFERRED_PORTS = [19387, 3080]

/** 首选都失败时额外扫描的端口区间（loopback 上连接被拒是瞬时的）。 */
const SCAN_RANGES = [
  [19380, 19400], // 桌面端常见区间
  [3070, 3090],   // dsh web 常见区间
]

/** 单端口 TCP 探测超时。loopback 拒绝是即时的，这个值只兜底。 */
const PROBE_TIMEOUT_MS = 250

/** 发现结果缓存（一次进程内只探一次）。 */
let discovered = null

/** cookie 有效期：与 DSH 默认 cookieMaxAgeDays(30) 对齐。 */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * cookie 缓存位置候选（**只存派生出的 cookie，不存 secret 本身**），按顺序尝试。
 *
 * 为什么要多候选：上层 agent 的沙箱通常**只允许写工作区**，
 * `~/.dsh` 往往不在可写根里 —— 此时写缓存会失败。缓存只是优化
 * （省一次探测），失败不影响功能，但有了可用目录就能生效。
 * 可用 DSH_BRIDGE_CACHE 环境变量显式指定。
 */
function cookieCacheCandidates() {
  const explicit = process.env.DSH_BRIDGE_CACHE
  return [
    ...(explicit ? [explicit] : []),
    join(homedir(), '.dsh', '.dsh-bridge-cookie.json'),
    join(process.cwd(), '.dsh-bridge-cookie.json'),
    join(tmpdir(), 'dsh-bridge-cookie.json'),
  ]
}

/** DSH 凭据文件（内含持久 browser-session secret）。 */
const CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml')

/**
 * launch token 日志（兜底用；易失效），按顺序查找。
 * 通常根本用不到：持久 secret 现签才是主路径。
 * 可用 DSH_BOOT_LOG 显式指定。
 */
const LAUNCH_LOG_PATHS = [
  process.env.DSH_BOOT_LOG,
  join(homedir(), '.dsh', 'dsh-web-boot.log'),
  join(tmpdir(), 'dsh-web-boot.log'),
].filter(Boolean)

/** 单次 RPC 超时。 */
const RPC_TIMEOUT_MS = 20_000
/** 等待一轮回答的默认总超时。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 180_000
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 500

// ---------------------------------------------------------------- 小工具

const b64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

function decodeB64url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

function originOf(origin) {
  return String(origin).replace(/\/+$/u, '')
}

/** 从 origin 推出用于签 cookie 的 authority（host:port）。 */
function authorityOf(origin) {
  const url = new URL(origin)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.hostname}:${port}`
}

// ---------------------------------------------------------------- 端点发现

/** 探测某端口是否有进程监听（loopback，拒绝是瞬时的）。 */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/**
 * 确认某个 origin 后面确实是 DSH（而不是碰巧开着的别的服务）。
 *
 * 做法：为它签一个 cookie，调最廉价的 `session/modelCatalog`，检查返回形状。
 * modelCatalog 一定回 `{ groups, default, ... }`，这个形状足够独特。
 *
 * @returns {Promise<{origin: string, route: object|null}|null>} 不是 DSH 则 null
 */
export async function probeDshOrigin(origin) {
  const minted = mintCookie(origin)
  if (minted === null) return null
  const client = createClient({ origin, cookie: `${minted.name}=${minted.value}` })
  try {
    const value = await client.rpc('session/modelCatalog', {}, { argName: null })
    if (value === null || typeof value !== 'object') return null
    if (!('groups' in value) && !('default' in value)) return null
    return { origin: originOf(origin), route: value.default ?? null }
  } catch {
    return null
  }
}

/**
 * 自动发现正在运行的 DSH 端点。
 *
 * 为什么需要发现：桌面端与 `dsh web` 是**同一个 API 面、不同端口**
 * （实测桌面端 19387、web 3080），而桌面端端口写在运行时、不落盘，
 * 无法从配置文件读出。
 *
 * 顺序：DSH_BRIDGE_URL → 首选端口 → 小范围扫描。每个候选都做 DSH 指纹校验。
 * 结果缓存在进程内（{@link resetDiscovery} 可清除）。
 *
 * @param {{force?: boolean}} [options] - force=true 忽略缓存重新探测
 * @returns {Promise<{origin: string, route: object|null, via: string}>}
 * @throws 找不到任何 DSH 端点时
 */
export async function discoverOrigin({ force = false } = {}) {
  if (discovered !== null && !force) return discovered

  // 1) 环境变量显式指定：信任它，不做指纹校验（用户明确要求）
  if (process.env.DSH_BRIDGE_URL) {
    const origin = originOf(process.env.DSH_BRIDGE_URL)
    discovered = { origin, route: null, via: 'env' }
    return discovered
  }

  // 2) 首选端口
  for (const port of PREFERRED_PORTS) {
    const origin = `http://127.0.0.1:${port}`
    if (!await isPortOpen(port)) continue
    const hit = await probeDshOrigin(origin)
    if (hit !== null) {
      discovered = { ...hit, via: 'preferred' }
      return discovered
    }
  }

  // 3) 小范围扫描
  const scanned = []
  for (const [from, to] of SCAN_RANGES) {
    for (let port = from; port <= to; port += 1) {
      if (PREFERRED_PORTS.includes(port)) continue
      scanned.push(port)
    }
  }
  for (const port of scanned) {
    if (!await isPortOpen(port)) continue
    const hit = await probeDshOrigin(`http://127.0.0.1:${port}`)
    if (hit !== null) {
      discovered = { ...hit, via: 'scan' }
      return discovered
    }
  }

  throw new Error(
    '找不到正在运行的 DSH 端点。\n'
    + '  · 桌面端：打开 DeepSeek Harness 应用\n'
    + '  · 或命令行：dsh web\n'
    + '  · 或显式指定：设置 DSH_BRIDGE_URL（如 http://127.0.0.1:19387）',
  )
}

/** 清除发现缓存（测试或切换端点时用）。 */
export function resetDiscovery() {
  discovered = null
}

// ---------------------------------------------------------------- 认证

/** 读 ~/.dsh/.credentials.yaml 里的持久 browser-session secret。 */
function readPersistentSecret() {
  try {
    const text = readFileSync(CREDENTIALS_PATH, 'utf8')
    const match = text.match(
      /client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*([A-Za-z0-9_-]+)/,
    )
    if (!match) return null
    const secret = decodeB64url(match[1])
    if (secret.byteLength !== 32) return null
    return secret
  } catch {
    return null
  }
}

/** 用持久 secret 现签一个 DSH 会话 cookie（纯本地计算，不发网络请求）。 */
export function mintCookie(origin = DEFAULT_ORIGIN) {
  const secret = readPersistentSecret()
  if (secret === null) return null
  const authority = authorityOf(origin)
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now()
  const expiresAt = issuedAt + COOKIE_MAX_AGE_MS
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  return { name, value: `v1.${body}.${signature}`, authority }
}

/** 读缓存：依次尝试各候选位置，取第一个命中且未过期的。 */
function readCookieCache(origin) {
  const authority = authorityOf(origin)
  for (const path of cookieCacheCandidates()) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const entry = raw?.[authority]
      if (!entry || typeof entry.cookie !== 'string' || typeof entry.expiresAt !== 'number') continue
      if (Date.now() > entry.expiresAt) continue
      return entry.cookie
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

/** 写缓存：写第一个可写的候选位置（沙箱下 ~/.dsh 常不可写，自动落到别处）。 */
function writeCookieCache(origin, cookie) {
  for (const path of cookieCacheCandidates()) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      let raw = {}
      try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { /* 首次写入 */ }
      raw[authorityOf(origin)] = { cookie, expiresAt: Date.now() + COOKIE_MAX_AGE_MS }
      writeFileSync(path, JSON.stringify(raw))
      return path
    } catch {
      /* 该位置不可写 → 换下一个 */
    }
  }
  return null // 全部不可写：不影响功能，只是每次都要重签
}

/** 从 dsh-web-boot.log 里读 launch URL（旧机制，易失效，仅兜底）。 */
function readLaunchUrl() {
  for (const path of LAUNCH_LOG_PATHS) {
    if (!existsSync(path)) continue
    try {
      const text = readFileSync(path, 'utf8')
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/)
      if (match) return match[0]
    } catch { /* 换下一个 */ }
  }
  return null
}

/** 用 launch token 换 cookie（DSH 官方 launch-token 流程：期望 303 + Set-Cookie）。 */
async function exchangeLaunchUrl(launchUrl) {
  const res = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  for (const header of raw) {
    const pair = header.split(';', 1)[0]
    if (pair.startsWith('dsh-auth-') && pair.includes('=')) return pair
  }
  return null
}

/** 探测一个 cookie 是否被接受。 */
async function cookieWorks(origin, cookie) {
  try {
    const res = await fetch(originOf(origin) + '/', {
      redirect: 'manual',
      headers: { cookie },
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    return res.status === 200
  } catch {
    return false
  }
}

/**
 * 解析出一个可用的 cookie。顺序：
 *   1. 环境变量 DSH_COOKIE（显式覆盖，且不再探测）
 *   2. 本地缓存（探测通过才用）
 *   3. 持久 secret 现签（探测通过才用）← 主路径
 *   4. launch token 兑换（兜底）
 * @returns {Promise<{cookie: string, via: string}>}
 */
export async function resolveCookie(origin = DEFAULT_ORIGIN) {
  const fromEnv = process.env.DSH_COOKIE
  if (fromEnv) return { cookie: fromEnv, via: 'env' }

  const cached = readCookieCache(origin)
  if (cached !== null && await cookieWorks(origin, cached)) return { cookie: cached, via: 'cache' }

  const minted = mintCookie(origin)
  if (minted !== null) {
    const cookie = `${minted.name}=${minted.value}`
    if (await cookieWorks(origin, cookie)) {
      writeCookieCache(origin, cookie)
      return { cookie, via: 'persistent-secret' }
    }
  }

  const launchUrl = readLaunchUrl()
  if (launchUrl !== null) {
    const cookie = await exchangeLaunchUrl(launchUrl)
    if (cookie !== null && await cookieWorks(origin, cookie)) {
      writeCookieCache(origin, cookie)
      return { cookie, via: 'launch-token' }
    }
  }

  throw new Error(
    'DSH 认证失败：持久 secret、cookie 缓存、launch token 三条路都不可用。'
    + '请确认 DSH 正在运行（桌面端应用，或命令行 dsh web），或设置 DSH_COOKIE 环境变量。',
  )
}

// ---------------------------------------------------------------- RPC

/** 一个已连接的 DSH 客户端。 */
export function createClient({ origin = DEFAULT_ORIGIN, cookie }) {
  const base = originOf(origin)

  /**
   * 发一次 Remote 调用。
   * @param {string} method - 如 'session/create'
   * @param {object} [payload] - 请求体（放进 args.request）
   * @param {object} [options]
   * @param {string|null} [options.argName] - args 里的字段名；传 null 表示该 RPC **不收参数**
   *   （如 session/modelCatalog，实测传 request 会报 "unexpected request"）。
   */
  async function rpc(method, payload = {}, { argName = 'request' } = {}) {
    const rpcId = randomUUID()
    const endpoint = method.split('/').map(encodeURIComponent).join('/')
    const args = argName === null ? {} : { [argName]: payload }
    const res = await fetch(new URL(`/api/${endpoint}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    const raw = await res.text()
    if (res.status === 401) throw new Error('DSH WebUI 认证已失效（401），请重新连接。')
    if (res.status === 403) throw new Error('DSH 因 Host/Origin 安全校验拒绝了请求（403）。')
    if (!res.ok) throw new Error(`DSH 返回 HTTP ${res.status}：${raw.slice(0, 200)}`)
    let body
    try { body = JSON.parse(raw) } catch { throw new Error(`DSH 对 ${method} 返回了非 JSON 响应。`) }
    if (body?.type !== 'server-response' || body.rpcId !== rpcId) {
      throw new Error(`DSH 对 ${method} 返回了无效的 RPC 响应。`)
    }
    if (body?.result?.ok !== true) {
      throw new Error(body?.result?.error?.message ?? `DSH RPC ${method} 失败。`)
    }
    return body.result.value
  }

  return { origin: base, cookie, rpc }
}

/**
 * 连接 DSH（自动发现端点 + 自动解析认证）。
 *
 * @param {object} [options]
 * @param {string} [options.origin] - 显式指定端点，跳过发现
 * @param {boolean} [options.forceDiscover] - 忽略发现缓存，重新探测
 * @returns {Promise<{origin: string, cookie: string, rpc: Function, via: string,
 *   endpoint: string, route: object|null}>}
 *   via = 认证方式；endpoint = 端点来源（env/preferred/scan/given）
 */
export async function connectDsh({ origin, forceDiscover = false } = {}) {
  let target = origin
  let endpoint = 'given'
  let route = null

  if (target === undefined) {
    if (process.env.DSH_BRIDGE_URL) {
      target = originOf(process.env.DSH_BRIDGE_URL)
      endpoint = 'env'
    } else {
      const found = await discoverOrigin({ force: forceDiscover })
      target = found.origin
      endpoint = found.via
      route = found.route
    }
  }

  let cookie
  let via
  try {
    ({ cookie, via } = await resolveCookie(target))
  } catch (error) {
    // 显式指定的端点连不上时，给出可执行的说明而不是裸 "fetch failed"
    const hint = endpoint === 'given' || endpoint === 'env'
      ? `无法连接到指定的 DSH 端点 ${target}。请确认它正在运行，或用 doctor 自动发现。`
      : (error instanceof Error ? error.message : String(error))
    throw new Error(hint, { cause: error })
  }

  const client = createClient({ origin: target, cookie })
  return { ...client, via, endpoint, route }
}

// ---------------------------------------------------------------- 会话

/**
 * 把工作目录解析成 workspaceId。
 * workspace/create 幂等：已注册则 created:false 并返回原 id。
 */
export async function resolveWorkspaceId(client, cwd) {
  const result = await client.rpc('workspace/create', { path: cwd })
  const workspaceId = result?.workspace?.workspaceId
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error(`无法为路径解析 workspaceId：${cwd}`)
  }
  return workspaceId
}

/**
 * 新建一个对话。
 * 关键：传 workspaceId（不是 cwd），这样会话才会出现在 GUI 的工作区列表里。
 * @returns {Promise<{sessionId: string, workspaceId: string, agentPreset?: string}>}
 */
export async function createSession(client, { cwd, preset } = {}) {
  const workspaceId = await resolveWorkspaceId(client, cwd)
  const created = await client.rpc('session/create', {
    workspaceId,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('DSH 未返回有效的 sessionId。')
  }
  return {
    sessionId,
    workspaceId,
    ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
  }
}

// ---------------------------------------------------------------- 会话状态

/**
 * 查询某会话当前是否有一轮在跑（AI 正在「说话」）。
 *
 * 依据 `session/list` 的 `SessionSummary.running`
 * （api/session-controller/src/types.ts:182），实测可靠。
 *
 * 用途：决定新消息该 **插入**（steer）还是 **排队**（queue）。
 *
 * @returns {Promise<{running: boolean, agentAvailable: boolean, blank: boolean, title: string|null}|null>}
 *   会话不在列表里（如已删除）时返回 null。
 */
export async function sessionStatus(client, sessionId) {
  // 注意：session/list 的参数名是 `_request`（不是常见的 request）
  const value = await client.rpc('session/list', {}, { argName: '_request' })
  const items = Array.isArray(value?.items) ? value.items : []
  const hit = items.find((item) => item.sessionId === sessionId)
  if (hit === undefined) return null
  return {
    running: hit.running === true,
    agentAvailable: hit.agentAvailable === true,
    blank: hit.blank === true,
    title: hit.projections?.values?.title ?? null,
  }
}

/** 当前会话里待处理的队列项（下一轮 + 本轮插入）。 */
export async function pendingQueue(client, sessionId) {
  try {
    const value = await client.rpc('session/list', {}, { argName: '_request' })
    const items = Array.isArray(value?.items) ? value.items : []
    const hit = items.find((item) => item.sessionId === sessionId)
    return hit?.queue ?? null
  } catch {
    return null
  }
}

/** 当前会话日志游标（session/page 的 throughSeq 上界）。 */async function currentCursor(client, sessionId) {
  const projections = await client.rpc('session/projections', { sessionId })
  return typeof projections?.asOfSeq === 'number' ? projections.asOfSeq : 0
}

/** 把 session/page 的 records 拆成事件数组（record 形如 {type:'event', event:{...}}）。 */
function eventsOf(page) {
  const records = Array.isArray(page?.records) ? page.records : []
  return records
    .map((record) => (record && typeof record === 'object' && 'event' in record ? record.event : record))
    .filter((event) => event && typeof event === 'object')
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

/** 从 assistant/message 事件里只取 text 块（滤掉 reasoning / 工具块）。 */
export function extractText(event) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

// ---------------------------------------------------------------- 轮次结局判定

/**
 * 轮次结束原因（TurnEndReasonMap，见 core/session/src/types.ts:201）。
 * 这里只关心对调用方有行动意义的那几种。
 */
export const TURN_REASON = {
  COMPLETED: 'completed',
  MAX_TOKENS: 'max-tokens',
  BLOCKED: 'blocked',
  ABORTED: 'aborted',
  ERROR: 'error',
}

/** 权限/审批类拒绝在工具结果里的特征串（tools/src/index.ts:1754-1765）。 */
const PERMISSION_MARKERS = [
  'requires approval',            // 需要审批但无通道
  'no approval channel',          // 没有审批通道
  'the user rejected tool',       // 用户拒绝了
  'approval for tool',            // 审批被取消（"approval for tool X was cancelled"）
  '[sandbox: file access denied', // 文件沙箱拒绝
  'file access denied',
  'permission denied',
  'is not permitted',
  'access denied',
]

/**
 * 结构化的权限拒绝错误码（比文案更可靠）。
 * 实测 FsError/FS_SANDBOX_DENIED 来自 FS 沙箱（fs-sandbox/src/index.ts:127）。
 */
const PERMISSION_ERROR_CODES = [
  'FS_SANDBOX_DENIED',
  'FS_PERMISSION_DENIED',
  'EACCES',
  'EPERM',
]

/**
 * 从工具结果里提取「权限/审批受阻」的证据。
 *
 * 为什么要从工具结果而非 turn 结局判断：审批被拒**不会**终止轮次 ——
 * DSH 会把拒绝作为工具结果告诉模型，模型继续往下跑（可能换个方式做，也可能卡住）。
 * 所以调用方要自己扫本轮工具结果里的拒绝标记。
 *
 * @param {object[]} events - 本轮事件（streaming 或 polling 拿到的）
 * @param {number} afterSeq - 只看此 seq 之后的事件
 * @returns {{blocked: boolean, toolName: string|null, evidence: string|null, count: number}}
 */
export function detectPermissionBlock(events, afterSeq = 0) {
  let count = 0
  let toolName = null
  let evidence = null
  // callId → 工具名：tool/result 自身不带名字时靠它反查
  const nameByCallId = new Map()

  for (const event of events ?? []) {
    if ((event?.seq ?? 0) <= afterSeq) continue

    if (event.type === 'tool/call') {
      const callId = event.data?.callId ?? event.data?.id
      const name = event.data?.name ?? event.data?.toolName
      if (typeof callId === 'string' && typeof name === 'string') nameByCallId.set(callId, name)
      continue
    }

    // 审批审计事件：最准确的信号
    if (event.type === 'approval/asked') {
      count += 1
      toolName ??= event.data?.toolName ?? null
      evidence ??= event.data?.reason ?? `工具 "${event.data?.toolName ?? '?'}" 请求了审批`
      continue
    }
    if (event.type === 'approval/decided'
      && (event.data?.outcome === 'rejected' || event.data?.outcome === 'cancelled'
        || event.data?.outcome === 'unavailable')) {
      count += 1
      evidence ??= `审批结果：${event.data.outcome}`
      continue
    }
    // 工具结果：先看结构化错误码（更可靠），再看文案
    if (event.type === 'tool/result') {
      const code = event.data?.error?.code
      const text = toolResultText(event)
      const byCode = typeof code === 'string' && PERMISSION_ERROR_CODES.includes(code)
      const byText = PERMISSION_MARKERS.some((needle) => text.includes(needle))
      if (byCode || byText) {
        count += 1
        const callId = event.data?.message?.toolCallId ?? event.data?.callId
        toolName ??= (typeof callId === 'string' ? nameByCallId.get(callId) : undefined)
          ?? event.data?.message?.toolName ?? event.data?.name ?? event.data?.toolName
          ?? event.data?.message?.name ?? null
        evidence ??= (text !== '' ? text : `错误码 ${String(code)}`).slice(0, 300)
      }
    }
  }

  return { blocked: count > 0, toolName, evidence, count }
}

/**
 * 把 tool/result 的内容压成纯文本（便于扫特征串）。
 *
 * 实测真实形态（2026-10-03）：
 *   data = { turn, step, message: { role:'tool', content:[{type:'text',text}], isError }, error? }
 * 注意是 `data.message.content` —— 早期版本误读 `data.content` 会漏检。
 * 这里同时兼容几种历史/变体形态。
 */
function toolResultText(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return ''

  const candidates = [
    data.message?.content,   // ← 实测主路径
    data.content,
    data.result?.content,
    data.output,
    data.text,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((block) => {
          if (typeof block === 'string') return block
          if (block && typeof block.text === 'string') return block.text
          return ''
        })
        .join('\n')
      if (joined.trim() !== '') return joined
    }
  }
  // 有些失败只带 error 对象
  if (data.error && typeof data.error === 'object') {
    return `${data.error.name ?? ''} ${data.error.code ?? ''} ${data.error.message ?? ''}`.trim()
  }
  return ''
}

/** 判断轮次是否因输出 token 上限被截断。 */
export function isMaxTokens(reason) {
  return reason?.kind === TURN_REASON.MAX_TOKENS
}

// ---------------------------------------------------------------- 推送式订阅（§ 流式）

/**
 * 订阅一个会话的事件流（WebSocket + session/follow），**推送式**：
 * DSH 一写事件就立刻推过来，不再轮询。
 *
 * 回调时序：opening snapshot → 后续每个事件。
 * 返回的 handle 必须 close()，否则连接会一直挂着（进程不退出）。
 *
 * @param {object} client - connectDsh() 的返回值（需要其中的 cookie）
 * @param {object} options
 * @param {string} options.sessionId
 * @param {(event: object) => void} [options.onEvent] - 每个会话事件（含 turn/end）
 * @param {(info: {cursor: number}) => void} [options.onSnapshot] - 打开快照（拿到 cursor）
 * @param {(info: {text: string, kind: string}) => void} [options.onDelta] - 增量文本（需 assistantStream）
 * @param {boolean} [options.assistantStream] - 是否要增量帧（默认 true）
 * @param {number} [options.timeoutMs] - 连接与打开超时
 * @returns {Promise<{close: () => void, closed: boolean, cursor: number}>}
 */
export async function followSession(client, {
  sessionId,
  onEvent,
  onSnapshot,
  onDelta,
  assistantStream = true,
  timeoutMs = RPC_TIMEOUT_MS,
} = {}) {
  if (typeof client?.cookie !== 'string' || client.cookie === '') {
    throw new Error('followSession 需要带 cookie 的 client（请用 connectDsh() 的返回值）。')
  }

  const wsUrl = `${client.origin.replace(/^http/, 'ws')}/api/remote.mux`
  const socket = await connectWebSocket(wsUrl, {
    headers: { cookie: client.cookie, origin: client.origin },
    timeoutMs,
  })

  const streamId = `follow-${randomUUID()}`
  const state = { closed: false, cursor: 0, error: null }
  let opened = false

  // 打开失败（会话不存在等）时不要永久挂住
  let rejectOpen
  const openFailure = new Promise((_resolve, reject) => { rejectOpen = reject })
  const opened$ = new Promise((resolve) => {
    const settle = () => { if (!opened) { opened = true; resolve() } }
    state.markOpened = settle
  })

  socket.onMessage((text) => {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message.streamId !== streamId) return

    if (message.type === 'error') {
      const error = new Error(`session/follow 失败：${message.error?.message ?? '未知错误'}`)
      state.error = error
      if (!opened) { opened = true; rejectOpen(error) }
      return
    }
    if (message.type === 'end') return
    if (message.type !== 'item') return

    const value = message.value
    if (value?.type === 'snapshot') {
      state.cursor = typeof value.cursor === 'number' ? value.cursor : 0
      state.markOpened?.()
      onSnapshot?.({ cursor: state.cursor, records: value.records ?? [] })
      return
    }
    if (value?.type === 'event') {
      const event = value.event
      if (typeof event?.seq === 'number') state.cursor = Math.max(state.cursor, event.seq)
      onEvent?.(event)
      return
    }
    if (value?.type === 'assistant-stream') {
      const frame = value.frame
      if (frame?.type === 'chunk') {
        const chunk = frame.chunk
        // 增量块的形状随块类型而变；只挑出文本增量
        const textDelta = chunk?.delta?.text ?? chunk?.text ?? chunk?.content
        if (typeof textDelta === 'string' && textDelta !== '') {
          onDelta?.({ text: textDelta, kind: chunk?.type ?? chunk?.delta?.type ?? 'text' })
        }
      }
    }
  })

  socket.onError((error) => {
    state.error = error
    if (!opened) { opened = true; rejectOpen(error) }
  })
  socket.onClose((info) => {
    state.closed = true
    if (!opened) {
      opened = true
      rejectOpen(new Error(`WebSocket 提前关闭（code=${info.code}）`))
    }
  })

  socket.send(JSON.stringify({
    type: 'open',
    streamId,
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          ...(assistantStream ? { assistantStream: true } : {}),
        },
      },
    },
  }))

  // 等快照到手（或失败）
  await Promise.race([
    opened$,
    openFailure,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('session/follow 打开超时')), timeoutMs).unref?.()),
  ])

  return {
    get cursor() { return state.cursor },
    get closed() { return state.closed },
    get error() { return state.error },
    close() {
      if (state.closed) return
      try { socket.send(JSON.stringify({ type: 'cancel', streamId })) } catch { /* 已断 */ }
      socket.close()
    },
  }
}

/**
 * 用**推送式**等待某条 prompt 的回答完成。
 *
 * 相比轮询 session/page：
 *  - `turn/end` 一到就返回，没有轮询间隔；
 *  - 没有「日志越大越慢」的问题（不读本地日志、不分页）；
 *  - 可经 onDelta 拿到**实时增量文本**（边生成边回传）。
 *
 * 若 WebSocket 不可用，调用方应回退到 pollForReply()。
 *
 * @returns {Promise<{status:'done'|'empty'|'timeout', text: string, turn: number|null,
 *   seq: number|null, reason: unknown, elapsedMs: number, sessionId: string, via: 'stream'}>}
 */
export async function awaitReplyStreaming(client, {
  sessionId,
  requestId,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  onDelta,
} = {}) {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('awaitReplyStreaming 需要 requestId。')
  }
  const startedAt = Date.now()

  // 本轮的 user/message（用于定位 seq）与 assistant 文本
  let userSeq = null
  const texts = []
  const events = [] // 本轮全部事件，供权限/审批检测
  let turnEnd = null
  let resolveDone
  const done$ = new Promise((resolve) => { resolveDone = resolve })

  const handle = await followSession(client, {
    sessionId,
    onEvent(event) {
      if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) {
        if (userSeq === null) userSeq = event.seq ?? 0
        return
      }
      // 只认本轮（seq > userSeq）的事件
      if (userSeq === null) return
      if ((event.seq ?? 0) <= userSeq) return

      events.push(event)

      if (event.type === 'assistant/message') {
        const text = extractText(event)
        // 同一 assistant/message 可能因重连被重复推送，按 seq 去重
        if (text !== '' && !texts.some((entry) => entry.seq === event.seq)) {
          texts.push({ seq: event.seq ?? 0, text })
        }
        return
      }
      if (event.type === 'turn/end') {
        turnEnd = event
        resolveDone()
      }
    },
    onDelta,
  })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; resolveDone() }, timeoutMs)
  timer.unref?.()

  try {
    await done$
  } finally {
    clearTimeout(timer)
    handle.close()
    // 给关闭帧一点时间发出，避免进程挂住
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const elapsedMs = Date.now() - startedAt
  const finalText = texts.length > 0 ? texts[texts.length - 1].text : ''
  const reason = turnEnd?.data?.reason ?? null
  const permission = detectPermissionBlock(events, userSeq ?? 0)

  if (timedOut && turnEnd === null) {
    return {
      status: 'timeout', text: finalText, turn: null, seq: null, reason: null,
      elapsedMs, sessionId, via: 'stream',
      ...(permission.blocked ? { permission } : {}),
    }
  }
  return {
    status: finalText === '' ? 'empty' : 'done',
    text: finalText,
    turn: turnEnd?.data?.turn ?? null,
    seq: turnEnd?.seq ?? null,
    reason,
    elapsedMs,
    sessionId,
    via: 'stream',
    // 输出 token 上限被截断：调用方应直接续发「继续」，不要重发任务
    maxTokens: isMaxTokens(reason),
    ...(permission.blocked ? { permission } : {}),
  }
}


// ---------------------------------------------------------------- 图片 / 附件

/** 支持的图片类型（DSH 侧的 ImageMediaType）。 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 扩展名 → mediaType（DSH 按字节嗅探，这里只是快速判定用）。 */
const EXT_TO_MEDIA_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 按 magic bytes 判定真实图片类型（比扩展名可靠）。 */
export function sniffImageMediaType(buffer) {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') {
    return 'image/gif'
  }
  return null
}

/**
 * 把本地图片文件读成 DSH 可接受的 image content part。
 *
 * DSH 的 session/prompt 原生支持图片：content 数组里放
 * `{ type: 'image', mediaType, data: <base64>, name }` 即可，宿主会把字节
 * 提升为持久附件（不需要预先 upload）。
 *
 * @param {string} filePath - 图片绝对/相对路径
 * @returns {{type: 'image', mediaType: string, data: string, name: string}}
 */
export function imagePartFromFile(filePath) {
  const buffer = readFileSync(filePath)
  const mediaType = sniffImageMediaType(buffer)
  if (mediaType === null) {
    const byExt = EXT_TO_MEDIA_TYPE[extname(filePath).toLowerCase()]
    if (byExt === undefined) {
      throw new Error(
        `无法识别的图片格式：${filePath}（支持 ${IMAGE_MEDIA_TYPES.join(' / ')}）`,
      )
    }
    return { type: 'image', mediaType: byExt, data: buffer.toString('base64'), name: basename(filePath) }
  }
  return { type: 'image', mediaType, data: buffer.toString('base64'), name: basename(filePath) }
}

/**
 * 把路径/描述组装成 session/prompt 的 content 数组。
 * @param {string} text
 * @param {Array<string|object>} [images]
 * @returns {Array<{type: string}>}
 */
export function buildContent(text, images) {
  const parts = []
  const trimmed = String(text ?? '').trim()
  if (trimmed !== '') parts.push({ type: 'text', text: trimmed })
  for (const image of images ?? []) {
    parts.push(typeof image === 'string' ? imagePartFromFile(image) : image)
  }
  if (parts.length === 0) throw new Error('消息内容不能为空（至少要有文本或图片）。')
  return parts
}

/**
 * 查当前会话的默认模型路由（provider / model）。
 *
 * 注意：**不要**指望从这里判断是否支持图片。
 * 实测 `session/modelCatalog` 只回 id/name/reasoning，**不含** inputModalities；
 * 而宿主内部判图用的是 `llm.resolveModelInfo(...).inputModalities`
 * （见 session-controller commands.ts:341）。那个不在 Remote 面上。
 *
 * 所以「模型是否支持图片」只能由会话事实回答：发一次带图消息，
 * 不支持时会收到 session/attachment-invalid（reason=MODEL_DOES_NOT_SUPPORT_IMAGES）。
 * 本函数仅用于报错时说明「当前路由是什么」。
 *
 * @returns {Promise<{provider: string, model: string}|null>}
 */
export async function currentModelRoute(client) {
  try {
    // modelCatalog 不收参数，必须传 argName: null
    const catalog = await client.rpc('session/modelCatalog', {}, { argName: null })
    const fallback = catalog?.default
    if (fallback && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
      return { provider: fallback.provider, model: fallback.model }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 预检图片是否可发：只在**能确定**时才拦截。
 *
 * 实现取向：因为 Remote 面拿不到 inputModalities，这里不做本地拦截，
 * 一律放行让 DSH 判定；仅在发送失败且错误信息指向图片时才补充解释。
 * 返回 supports=null 表示「未知，交给 DSH」。
 * @returns {Promise<{supports: boolean|null, route: {provider: string, model: string}|null}>}
 */
export async function checkImageSupport(client) {
  return { supports: null, route: await currentModelRoute(client) }
}

/** DSH 拒绝图片时抛的 reason（commands.ts:346）。 */
export const MODEL_NO_IMAGE_REASON = 'MODEL_DOES_NOT_SUPPORT_IMAGES'


/**
 * 发一条消息并等这一轮结束。
 *
 * 默认走**推送式**（WebSocket session/follow）：`turn/end` 一到立即返回，
 * 无轮询间隔，且会话再长也不变慢。WebSocket 不可用时自动回退到
 * `session/page` 轮询（结果里的 via 字段会标明实际走的哪条路）。
 *
 * @param {object} client
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.text
 * @param {number} [options.timeoutMs]
 * @param {Array<string|object>} [options.images]
 *   图片：本地路径数组（或已构造好的 image part）。会随消息一起原生发出，
 *   不是「把路径告诉模型」——模型真的看得到图。
 * @param {(info: {text: string, kind: string}) => void} [options.onDelta]
 *   增量文本回调（仅推送式支持）；可用于边生成边显示。
 * @param {boolean} [options.streaming] - 设 false 强制用轮询
 * @param {'queue'|'steer'} [options.mode] - 投递方式（默认 'queue'）：
 *   - `'queue'`：排到**下一轮**（当前轮跑完后再处理）。安全默认值。
 *   - `'steer'`：**插入当前轮**，在下一个 step 边界生效——实测会打断模型
 *     既定的后续步骤，让它先处理这句话（见 skill 里「插入还是排队」一节）。
 *     会话空闲时 `steer` 也能接受，等价于开新一轮。
 * @returns {Promise<{status: 'done'|'empty'|'timeout', text: string, turn: number|null,
 *   seq: number|null, reason: unknown, elapsedMs: number, sessionId: string,
 *   via: 'stream'|'poll', imageCount: number, mode: string, streamError?: string}>}
 *   status='done' 有文本；'empty' 轮次结束但无文本；'timeout' 超时。
 */
export async function sendPrompt(client, {
  sessionId,
  text,
  images,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  onDelta,
  streaming = true,
  mode = 'queue',
}) {
  const content = buildContent(text, images)

  const startedAt = Date.now()
  const requestId = randomUUID()

  try {
    await client.rpc('session/prompt', {
      requestId,
      sessionId,
      mode,
      content,
    })
  } catch (error) {
    // 图片被拒时补一句可执行的提示：换支持图片的模型再发
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes(MODEL_NO_IMAGE_REASON) || raw.includes('does not support image input')) {
      const route = await currentModelRoute(client)
      const where = route === null ? '当前模型' : `${route.provider}/${route.model}`
      throw new Error(
        `${where} 不支持图片输入，DSH 拒绝了这条消息。`
        + '请在 DSH 会话里换一个支持视觉的模型（或改用纯文本 / 只给图片路径）。',
      )
    }
    throw error
  }

  const imageCount = content.filter((part) => part.type === 'image').length

  let streamError
  if (streaming && typeof client.cookie === 'string' && client.cookie !== '') {
    try {
      const streamed = await awaitReplyStreaming(client, { sessionId, requestId, timeoutMs, onDelta })
      return { ...streamed, imageCount, mode }
    } catch (error) {
      // 推送不可用（无 WS / 升级被拒 / 超时）→ 静默回退轮询，绝不因此失败
      streamError = error instanceof Error ? error.message : String(error)
    }
  } else if (streaming) {
    streamError = 'client 未携带 cookie，无法建立 WebSocket'
  }

  const result = await pollForReply(client, { sessionId, requestId, timeoutMs, startedAt })
  const withCount = { ...result, imageCount, mode }
  return streamError === undefined ? withCount : { ...withCount, streamError }
}

/**
 * 发一条消息，**自动决定插入还是排队**。
 *
 * 判据是会话当前是否有一轮在跑（`SessionSummary.running`，实测可靠）：
 * - **在跑** + `preferSteer` → `steer` 插入当前轮（适合「打断/纠正/补充」）
 * - **在跑** + 不 steer → `queue` 排队（适合「另起一件事」）
 * - **空闲** → `queue` 开新一轮（此时两者等价，queue 语义更清楚）
 *
 * @param {object} client
 * @param {object} options - 同 sendPrompt，另加：
 * @param {boolean} [options.preferSteer] - 忙碌时是否插入（默认 false = 排队）
 * @returns {Promise<object>} 同 sendPrompt，另加 `running`（投递前是否在跑）
 */
export async function sendSmart(client, { preferSteer = false, mode, ...promptOptions }) {
  let status = null
  if (mode === undefined) {
    try {
      status = await sessionStatus(client, promptOptions.sessionId)
    } catch {
      status = null // 查不到状态就按默认 queue，不阻断
    }
  }
  const running = status?.running === true
  const chosen = mode ?? (running && preferSteer ? 'steer' : 'queue')
  const result = await sendPrompt(client, { ...promptOptions, mode: chosen })
  return { ...result, running }
}

/** 续写用的提示词。与 DSH UI 上那句提示一致。 */
export const CONTINUE_PROMPT = '继续'

/** 单次 sendPrompt 内自动续写的最大次数（防失控）。 */
export const DEFAULT_MAX_CONTINUES = 3

/**
 * 发消息 + 等回答；**输出被 token 上限截断时自动续发「继续」**并拼接结果。
 *
 * 为什么单独包一层：`sendPrompt` 是「一问一答」语义，而截断续写是
 * 「同一件事还没说完」——DSH UI 自己也是这么做的（提示用户发「继续」）。
 * 自动续写让调用方拿到的是一份完整回答，而不是被腰斩的半截。
 *
 * 注意：**只**在 `reason.kind === 'max-tokens'` 时续写。权限/审批受阻抗的是
 * 另一回事——那是用户要去处理的事，重发任务无法解决，所以这里绝不续写
 * （见 skill 里的规则）。
 *
 * @param {object} client
 * @param {object} options - 同 sendPrompt，另加：
 * @param {number} [options.maxContinues] - 最多续写几次（默认 3；0 = 不自动续写）
 * @param {(info: {round: number, text: string}) => void} [options.onContinue]
 *   每次续写前回调，便于调用方提示进度。
 * @returns {Promise<object>} 同 sendPrompt，另加：
 *   `continued`（续写次数）、`truncated`（是否仍被截断）
 */
export async function askWithAutoContinue(client, options) {
  const { maxContinues = DEFAULT_MAX_CONTINUES, onContinue, ...promptOptions } = options

  let result = await sendPrompt(client, promptOptions)
  if (!result.maxTokens || maxContinues <= 0) return { ...result, continued: 0 }

  const parts = [result.text]
  let continued = 0

  while (result.maxTokens && continued < maxContinues) {
    continued += 1
    onContinue?.({ round: continued, text: result.text })
    result = await sendPrompt(client, {
      ...promptOptions,
      text: CONTINUE_PROMPT,
      // 续写永远是「接着把这段写完」，不是插话；用 queue 语义更准确
      mode: 'queue',
    })
    if (result.text !== '') parts.push(result.text)
  }

  return {
    ...result,
    // 拼接所有片段：模型接着上次的输出继续写
    text: parts.filter((part) => part !== '').join(''),
    continued,
    truncated: result.maxTokens === true,
  }
}

/**
 * 轮询 `session/page` 等待某条 prompt 的回答（推送式的兜底路径）。
 * @internal
 */
async function pollForReply(client, { sessionId, requestId, timeoutMs, startedAt = Date.now() }) {
  const deadline = startedAt + timeoutMs

  for (;;) {
    // 每轮都重新取 cursor：日志在增长，throughSeq 必须跟上
    const cursor = await currentCursor(client, sessionId)
    const page = await client.rpc('session/page', {
      address: { kind: 'session', sessionId },
      throughSeq: cursor,
      maxMessages: 200,
    })
    const events = eventsOf(page)

    // 用 rpcId 精确定位本次 prompt（支持并发/多轮不串）
    const userEvent = events.find((event) =>
      event.type === 'user/message' && event.data?.source?.rpcId === requestId)

    if (userEvent !== undefined) {
      const userSeq = userEvent.seq ?? 0
      const turnEnd = events.find((event) => event.type === 'turn/end' && (event.seq ?? 0) > userSeq)

      if (turnEnd !== undefined) {
        const texts = events
          .filter((event) => event.type === 'assistant/message' && (event.seq ?? 0) > userSeq)
          .map(extractText)
          .filter((value) => value !== '')
        const elapsedMs = Date.now() - startedAt
        // 取最后一段非空 text：AI 可能先思考/调工具再给最终答案
        const finalText = texts.length > 0 ? texts[texts.length - 1] : ''
        const reason = turnEnd.data?.reason ?? null
        const permission = detectPermissionBlock(events, userSeq)
        return {
          status: finalText === '' ? 'empty' : 'done',
          text: finalText,
          turn: turnEnd.data?.turn ?? null,
          seq: turnEnd.seq ?? null,
          reason,
          elapsedMs,
          sessionId,
          via: 'poll',
          maxTokens: isMaxTokens(reason),
          ...(permission.blocked ? { permission } : {}),
        }
      }
    }

    if (Date.now() > deadline) {
      return {
        status: 'timeout',
        text: '',
        turn: null,
        seq: null,
        reason: null,
        elapsedMs: Date.now() - startedAt,
        sessionId,
        via: 'poll',
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * 读会话历史消息（按时间正序）。
 *
 * 只返回**真人输入**与 assistant 回答：DSH 每轮会注入若干 user/message 事件
 * （source.kind = runtime-context / skill-catalog / time-context 等），
 * 那些是系统上下文，不是对话内容，必须滤掉（实测确认）。
 * 另可传 kinds 覆盖默认白名单。
 *
 * @returns {Promise<Array<{role: 'user'|'assistant', text: string, seq: number, time: number|null}>>}
 */
export async function readMessages(client, { sessionId, limit = 50, kinds = ['user'] } = {}) {
  const cursor = await currentCursor(client, sessionId)
  const page = await client.rpc('session/page', {
    address: { kind: 'session', sessionId },
    throughSeq: cursor,
    maxMessages: limit,
  })
  const events = eventsOf(page)
  const allow = new Set(kinds)
  const messages = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      if (!allow.has(kind)) continue // 滤掉运行时上下文/技能目录/时间上下文等注入
      const text = extractUserText(event)
      if (text !== '') {
        messages.push({ role: 'user', text, seq: event.seq ?? 0, time: event.time ?? null })
      }
    } else if (event.type === 'assistant/message') {
      const text = extractText(event)
      if (text !== '') {
        messages.push({ role: 'assistant', text, seq: event.seq ?? 0, time: event.time ?? null })
      }
    }
  }
  return messages
}

/** 用户消息的文本（也可能带块数组）。 */
function extractUserText(event) {
  const content = event?.data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 会话是否还活着（能读到日志即视为可续聊）。 */
export async function sessionExists(client, sessionId) {
  try {
    await currentCursor(client, sessionId)
    return true
  } catch {
    return false
  }
}
