// Pictures with a prompt (StartOptions.images), only on the inputs the pinned protocols define: Claude's first user
// message carries image blocks (base64, before the text: the SDK's MessageParam content), and Codex's turn/start input
// carries `localImage` entries (the 0.160 UserInput) before the text. Without pictures both are as before.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { userMessage } from '@core/adapters/claude/protocol.ts'
import { IMAGE_MAX_BYTES, imageBlocks } from '@core/adapters/claude/run.ts'
import { turnStartParams } from '@core/adapters/codex/params.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Claude: image blocks in the first user message', () => {
  it('reads each picture as base64 by its type; a missing, empty or too large one is left out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dimf-img-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(dir, 'b.JPG'), Buffer.from([4, 5]))
    writeFileSync(join(dir, 'empty.png'), Buffer.alloc(0))
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(IMAGE_MAX_BYTES + 1))
    const blocks = imageBlocks(
      ['a.png', 'b.JPG', 'empty.png', 'big.png', 'missing.png'].map((f) => join(dir, f)),
    )
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BAU=' } },
    ])
    expect(userMessage('look', blocks).message.content.map((c) => c.type)).toEqual(['image', 'image', 'text'])
  })

  it('no pictures: the message is the text alone, as before', () => {
    expect(userMessage('hello')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    })
  })
})

describe('Codex: localImage inputs on turn/start', () => {
  it('the pictures before the text; none: the text alone', () => {
    expect(turnStartParams({ threadId: 't', prompt: 'look', images: ['/h/tmp/p.png'] }).input).toEqual([
      { type: 'localImage', path: '/h/tmp/p.png' },
      { type: 'text', text: 'look', text_elements: [] },
    ])
    expect(turnStartParams({ threadId: 't', prompt: 'look' }).input).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
    ])
  })
})
