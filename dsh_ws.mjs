/**
 * dsh_ws.mjs —— 极简 WebSocket 客户端（仅用 Node 内置模块）。
 *
 * 为什么自己写：
 *  - Node 内置的全局 WebSocket **不支持自定义请求头**，而 DSH 的
 *    /api/remote.mux 必须带 Cookie 认证，所以内置的用不了；
 *  - `ws` 包不在目标项目依赖里（只是碰巧存在于别的项目的 pnpm store），
 *    依赖绝对路径不可靠；
 *  - 本项目整体设计是零依赖，这里保持一致。
 *
 * 实现范围（够用即止）：RFC 6455 客户端握手 + 文本帧收发 + ping/pong +
 * 分片重组 + 关闭。不做 permessage-deflate 扩展协商。
 *
 * 关键细节：客户端发出的帧**必须**掩码（mask），服务端发回的帧必须**不**掩码。
 * DSH 的服务端会定期发 WebSocket Ping（心跳），若不回 Pong，错过 2 次即断连。
 */

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

/** 单帧上限（防御异常/恶意长度）。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** 把一帧编码成客户端帧（带掩码）。 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length

  let header
  let maskOffset
  if (length < 126) {
    header = Buffer.allocUnsafe(6)
    header[1] = 0x80 | length
    maskOffset = 2
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(8)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
    maskOffset = 4
  } else {
    header = Buffer.allocUnsafe(14)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
    maskOffset = 10
  }
  header[0] = 0x80 | opcode // FIN=1 + opcode

  const mask = randomBytes(4)
  mask.copy(header, maskOffset)

  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = data[index] ^ mask[index & 3]
  }
  return Buffer.concat([header, masked])
}

/**
 * 增量解析服务端帧。服务端帧不带掩码，但这里也兼容带掩码的情况（防御）。
 */
class FrameParser {
  constructor(onFrame, onProtocolError) {
    this.buffer = Buffer.alloc(0)
    this.onFrame = onFrame
    this.onProtocolError = onProtocolError
    this.fragments = []
    this.fragmentOpcode = null
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const parsed = this.#parseOne()
      if (parsed === null) return
      if (parsed === false) return // 协议错误，已上报
      this.#dispatch(parsed)
    }
  }

  /** @returns {{fin: boolean, opcode: number, payload: Buffer} | null | false} */
  #parseOne() {
    const buffer = this.buffer
    if (buffer.length < 2) return null

    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.onProtocolError(new Error(`WebSocket 帧过大：${big} 字节`))
        return false
      }
      length = Number(big)
      offset += 8
    }
    if (length > MAX_FRAME_BYTES) {
      this.onProtocolError(new Error(`WebSocket 帧过大：${length} 字节`))
      return false
    }

    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }

    if (buffer.length < offset + length) return null

    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (maskKey !== null) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskKey[index & 3]
      }
    }
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  #dispatch(frame) {
    if (frame.opcode === OPCODE.PING) {
      this.onFrame({ type: 'ping', payload: frame.payload })
      return
    }
    if (frame.opcode === OPCODE.PONG) return
    if (frame.opcode === OPCODE.CLOSE) {
      this.onFrame({ type: 'close', code: frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005, reason: frame.payload.subarray(2).toString('utf8') })
      return
    }
    if (frame.opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.onProtocolError(new Error('WebSocket 收到意外的续帧'))
        return
      }
      this.fragments.push(frame.payload)
      if (frame.fin) {
        const payload = Buffer.concat(this.fragments)
        const opcode = this.fragmentOpcode
        this.fragments = []
        this.fragmentOpcode = null
        this.onFrame({ type: opcode === OPCODE.TEXT ? 'text' : 'binary', payload })
      }
      return
    }
    // TEXT / BINARY
    if (!frame.fin) {
      this.fragmentOpcode = frame.opcode
      this.fragments = [frame.payload]
      return
    }
    this.onFrame({ type: frame.opcode === OPCODE.TEXT ? 'text' : 'binary', payload: frame.payload })
  }
}

/**
 * 建立一个 WebSocket 连接。
 * @param {string} rawUrl - ws:// 或 wss:// 地址
 * @param {{headers?: Record<string,string>, timeoutMs?: number}} [options]
 * @returns {Promise<{send: (text:string)=>void, close: (code?:number, reason?:string)=>void,
 *   onMessage: (cb:(text:string)=>void)=>void, onClose: (cb:(info:{code:number,reason:string})=>void)=>void,
 *   onError: (cb:(error:Error)=>void)=>void, closed: boolean}>}
 */
export function connectWebSocket(rawUrl, { headers = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const url = new URL(rawUrl)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      fail(new Error(`不支持的 WebSocket 协议：${url.protocol}`))
      return
    }

    const key = randomBytes(16).toString('base64')
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port !== '' ? Number(url.port) : (url.protocol === 'wss:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      // wss 需 TLS；此处仅支持 ws（本机 loopback 场景）
      ...(url.protocol === 'wss:' ? { rejectUnauthorized: true } : {}),
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('WebSocket 握手超时'))
    })

    // 服务端拒绝升级（如 401/403）时会走到这里
    req.on('response', (res) => {
      res.resume()
      fail(new Error(`WebSocket 升级被拒绝：HTTP ${res.statusCode}`))
    })

    req.on('error', (error) => fail(error))

    req.on('upgrade', (res, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64')
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        fail(new Error('WebSocket 握手校验失败：Sec-WebSocket-Accept 不匹配'))
        return
      }

      socket.setTimeout(0) // 长连接：由 DSH 的 Ping 维持，不设空闲超时

      const messageHandlers = []
      const closeHandlers = []
      const errorHandlers = []
      const state = { closed: false }

      const emitError = (error) => {
        for (const handler of errorHandlers) handler(error)
      }
      const emitClose = (info) => {
        if (state.closed) return
        state.closed = true
        for (const handler of closeHandlers) handler(info)
      }

      const parser = new FrameParser(
        (frame) => {
          if (frame.type === 'text') {
            const text = frame.payload.toString('utf8')
            for (const handler of messageHandlers) handler(text)
          } else if (frame.type === 'ping') {
            // 必须回 Pong，否则 DSH 心跳超时会断开
            try { socket.write(encodeFrame(OPCODE.PONG, frame.payload)) } catch { /* 已断 */ }
          } else if (frame.type === 'close') {
            try { socket.write(encodeFrame(OPCODE.CLOSE, frame.payload.subarray(0, 2))) } catch { /* 忽略 */ }
            socket.end()
            emitClose({ code: frame.code, reason: frame.reason })
          }
        },
        (error) => {
          emitError(error)
          socket.destroy()
        },
      )

      socket.on('data', (chunk) => {
        try { parser.push(chunk) } catch (error) { emitError(error); socket.destroy() }
      })
      socket.on('error', (error) => { emitError(error); emitClose({ code: 1006, reason: error.message }) })
      socket.on('close', () => emitClose({ code: 1006, reason: 'socket closed' }))

      if (head && head.length > 0) parser.push(head)

      settled = true
      resolve({
        send(text) {
          if (state.closed) throw new Error('WebSocket 已关闭')
          socket.write(encodeFrame(OPCODE.TEXT, text))
        },
        close(code = 1000, reason = '') {
          if (state.closed) return
          const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
          payload.writeUInt16BE(code, 0)
          payload.write(reason, 2, 'utf8')
          try { socket.write(encodeFrame(OPCODE.CLOSE, payload)) } catch { /* 忽略 */ }
          socket.end()
          // 服务端未回应时兜底销毁
          setTimeout(() => socket.destroy(), 1000).unref?.()
        },
        onMessage(handler) { messageHandlers.push(handler) },
        onClose(handler) { closeHandlers.push(handler) },
        onError(handler) { errorHandlers.push(handler) },
        get closed() { return state.closed },
      })
    })

    req.end()
  })
}
