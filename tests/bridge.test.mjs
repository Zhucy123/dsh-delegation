import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  extractText,
  isMaxTokens,
  detectPermissionBlock,
  sniffImageMediaType,
  imagePartFromFile,
  buildContent,
  TURN_REASON,
  MODEL_NO_IMAGE_REASON,
  CONTINUE_PROMPT,
  DEFAULT_MAX_CONTINUES,
} from '../dsh_bridge.mjs'

// ---------------------------------------------------------------- helpers

function assistantEvent(seq, blocks) {
  return { seq, type: 'assistant/message', data: { message: { role: 'assistant', content: blocks } } }
}

function toolResult(seq, content, extra = {}) {
  return {
    seq,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', content, isError: false }, ...extra },
  }
}

// ---------------------------------------------------------------- extractText

test('extractText keeps only text blocks', () => {
  const event = assistantEvent(1, [
    { type: 'reasoning', text: 'thinking hard' },
    { type: 'text', text: 'the answer' },
    { type: 'tool_use', name: 'pwsh', input: {} },
  ])
  assert.equal(extractText(event), 'the answer')
})

test('extractText joins multiple text blocks in order', () => {
  const event = assistantEvent(1, [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ])
  assert.equal(extractText(event), 'first\nsecond')
})

test('extractText returns empty string for reasoning-only or malformed events', () => {
  assert.equal(extractText(assistantEvent(1, [{ type: 'reasoning', text: 'x' }])), '')
  assert.equal(extractText({}), '')
  assert.equal(extractText(null), '')
  assert.equal(extractText({ data: { message: { content: 'not an array' } } }), '')
})

// ---------------------------------------------------------------- isMaxTokens

test('isMaxTokens recognises the sticky max-tokens reason', () => {
  assert.equal(isMaxTokens({ kind: TURN_REASON.MAX_TOKENS }), true)
  assert.equal(isMaxTokens({ kind: 'max-tokens' }), true)
  assert.equal(isMaxTokens({ kind: TURN_REASON.COMPLETED }), false)
  assert.equal(isMaxTokens(null), false)
  assert.equal(isMaxTokens(undefined), false)
})

test('CONTINUE_PROMPT and the continue budget are exported', () => {
  assert.equal(typeof CONTINUE_PROMPT, 'string')
  assert.ok(CONTINUE_PROMPT.length > 0)
  assert.equal(DEFAULT_MAX_CONTINUES, 3)
})

// ---------------------------------------------------------------- detectPermissionBlock

test('detectPermissionBlock flags a rejected approval decision', () => {
  const events = [
    { seq: 1, type: 'approval/asked', data: { toolName: 'pwsh' } },
    { seq: 2, type: 'approval/decided', data: { outcome: 'rejected' } },
  ]
  const result = detectPermissionBlock(events, 0)
  assert.equal(result.blocked, true)
  assert.equal(result.toolName, 'pwsh')
  assert.ok(result.count >= 1)
})

test('detectPermissionBlock flags structured sandbox error codes', () => {
  const events = [toolResult(2, [{ type: 'text', text: 'blocked' }], {
    error: { code: 'FS_SANDBOX_DENIED', message: 'no' },
  })]
  const result = detectPermissionBlock(events, 1)
  assert.equal(result.blocked, true)
})

test('detectPermissionBlock reads the real tool/result shape (data.message.content)', () => {
  const events = [toolResult(2, [
    { type: 'text', text: '[sandbox: file access denied under read-only mode]' },
  ])]
  const result = detectPermissionBlock(events, 1)
  assert.equal(result.blocked, true)
  assert.match(result.evidence, /file access denied/)
})

test('detectPermissionBlock resolves the tool name from a prior tool/call', () => {
  const events = [
    { seq: 1, type: 'tool/call', data: { callId: 'call-1', name: 'apply_patch' } },
    { ...toolResult(2, [{ type: 'text', text: 'the user rejected tool apply_patch' }]),
      data: { message: { role: 'tool', content: [{ type: 'text', text: 'the user rejected tool apply_patch' }], toolCallId: 'call-1' } } },
  ]
  const result = detectPermissionBlock(events, 0)
  assert.equal(result.blocked, true)
  assert.equal(result.toolName, 'apply_patch')
})

test('detectPermissionBlock ignores events at or before afterSeq', () => {
  const events = [
    { seq: 1, type: 'approval/asked', data: { toolName: 'pwsh' } },
    { seq: 2, type: 'approval/decided', data: { outcome: 'rejected' } },
  ]
  assert.equal(detectPermissionBlock(events, 2).blocked, false)
})

test('detectPermissionBlock stays quiet on an ordinary successful turn', () => {
  const events = [
    { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    toolResult(2, [{ type: 'text', text: 'file contents here' }]),
    assistantEvent(3, [{ type: 'text', text: 'done' }]),
  ]
  assert.equal(detectPermissionBlock(events, 0).blocked, false)
})

test('detectPermissionBlock tolerates null and empty input', () => {
  assert.equal(detectPermissionBlock(null).blocked, false)
  assert.equal(detectPermissionBlock([]).blocked, false)
  assert.equal(detectPermissionBlock(undefined, 0).blocked, false)
})

test('detectPermissionBlock ignores approval decisions that were accepted', () => {
  const events = [
    { seq: 1, type: 'approval/asked', data: { toolName: 'pwsh' } },
    { seq: 2, type: 'approval/decided', data: { outcome: 'accepted' } },
  ]
  // approval/asked alone increments the counter, so use afterSeq to isolate the decision
  const result = detectPermissionBlock(events, 1)
  assert.equal(result.count, 0)
})

// ---------------------------------------------------------------- images

test('sniffImageMediaType detects PNG, JPEG, WebP and GIF by magic bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
  const gif = Buffer.from('GIF89a', 'latin1')

  assert.equal(sniffImageMediaType(png), 'image/png')
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
  assert.equal(sniffImageMediaType(webp), 'image/webp')
  assert.equal(sniffImageMediaType(gif), 'image/gif')
})

test('sniffImageMediaType returns null for non-images', () => {
  assert.equal(sniffImageMediaType(Buffer.from('hello world')), null)
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), null)
  assert.equal(sniffImageMediaType(Buffer.from('%PDF-1.7')), null)
})

test('imagePartFromFile trusts magic bytes over a misleading extension', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegation-'))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const disguised = join(directory, 'pretends-to-be.jpg')
  writeFileSync(disguised, png)

  const part = imagePartFromFile(disguised)
  assert.equal(part.type, 'image')
  assert.equal(part.mediaType, 'image/png')
  assert.equal(part.name, 'pretends-to-be.jpg')
  assert.equal(Buffer.from(part.data, 'base64').length, png.length)
})

test('imagePartFromFile rejects an unrecognisable file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegation-'))
  const bogus = join(directory, 'notes.txt')
  writeFileSync(bogus, 'definitely not an image')
  assert.throws(() => imagePartFromFile(bogus), /无法识别的图片格式/)
})

// ---------------------------------------------------------------- buildContent

test('buildContent puts text first and accepts plain paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegation-'))
  const png = join(directory, 'a.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  const content = buildContent('look at this', [png])
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], { type: 'text', text: 'look at this' })
  assert.equal(content[1].type, 'image')
})

test('buildContent allows an image-only message', () => {
  const part = { type: 'image', mediaType: 'image/png', data: 'AA==', name: 'x.png' }
  const content = buildContent(undefined, [part])
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'image')
})

test('buildContent rejects a completely empty message', () => {
  assert.throws(() => buildContent('   ', []), /不能为空/)
  assert.throws(() => buildContent(undefined, []), /不能为空/)
})

// ---------------------------------------------------------------- constants

test('MODEL_NO_IMAGE_REASON matches the DSH rejection reason', () => {
  assert.equal(MODEL_NO_IMAGE_REASON, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
})
