// Every published fixture is synthesized and carries no data of a real account (scripts/check-fixtures.mjs), and the
// synthesizer that makes the Claude and Codex fixtures from live recordings (scripts/synthesize-fixtures.mjs) keeps
// what the replays rely on: the protocol, the host's frames, deltas that add up to the final text, and code tokens.
// The live recordings themselves stay in tests/fixtures-private, which is never published: when it is present, the
// committed fixtures must be exactly what the synthesizer makes of it, and none may repeat a run of its model text.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFixtureFiles, realTextShingles } from '../../scripts/check-fixtures.mjs'
import {
  BASE_TIME,
  FAKE_MARK,
  fakeIdsInText,
  fakeProse,
  fakeUuid,
  rewriteJsonText,
  run,
  synthesizeRecording,
} from '../../scripts/synthesize-fixtures.mjs'
import { workingTreeFiles } from '../../scripts/tree-files.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PRIVATE = fileURLToPath(new URL('../fixtures-private/', import.meta.url))

const file = (path: string, text: string): { path: string; text: string } => ({ path, text })
const header = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'header',
    schemaVersion: 1,
    vendor: 'claude',
    route: 'stdio',
    synthesized: true,
    ...extra,
  })
const frame = (dir: string, line: unknown): string =>
  JSON.stringify({ t: 0, dir, line: typeof line === 'string' ? line : JSON.stringify(line) })

describe('the published fixtures', () => {
  it('are all synthesized and hold no account data or live text', () => {
    const r = checkFixtureFiles(workingTreeFiles(ROOT), { realShingles: realTextShingles() })
    expect(r.findings).toEqual([])
    expect(r.scanned).toBeGreaterThan(500)
  })

  it.runIf(existsSync(PRIVATE))('are exactly what the synthesizer makes of the live recordings', () => {
    expect(run(['--check'])).toBe(0)
  })
})

describe('the fixture check', () => {
  it('finds a recording that is not synthesized', () => {
    const r = checkFixtureFiles([
      file('tests/fixtures/claude/stdio/X/recording.jsonl', `${header({ synthesized: undefined })}\n`),
      file('tests/fixtures/claude/stdio/Y/recording.jsonl', `${header()}\n`),
      file('tests/fixtures/fake/z.recording.jsonl', '{"kind":"header"}\n'),
    ])
    expect(r.findings).toEqual([
      { path: 'tests/fixtures/claude/stdio/X/recording.jsonl', line: 1, kind: 'not synthesized' },
      { path: 'tests/fixtures/fake/z.recording.jsonl', line: 1, kind: 'not synthesized' },
    ])
  })

  it('finds emails, account ids, signatures, vendor ids, paid plans and base64 runs', () => {
    const lines = [
      header(),
      frame('out', { type: 'x', text: 'mail someone@corp.example.net or me@gmail.com' }),
      frame('out', { account: { organization: '2f0c8b7e-1111-4e8d-9a15-3c6f4e8d9a15' } }),
      frame('out', { content: [{ type: 'thinking', signature: 'EqQBCkgIBxABGAIqQ' }] }),
      frame('out', { message: { id: 'msg_01AbCdEfGhIjKlMnOpQrStUv' } }),
      frame('out', { item: { id: 'rs_3c9e17d2b4a6058f19e2d7c4b6a8e0f2d4c6' } }),
      frame('out', { account: { subscriptionType: 'Claude Max' } }),
      frame('out', { blob: 'A'.repeat(200) }),
      frame('out', { org: 'org-AbCdEfGhIjKlMnOpQrStUvWx' }),
    ]
    const r = checkFixtureFiles([file('tests/fixtures/claude/stdio/X/recording.jsonl', lines.join('\n'))])
    expect(r.findings.map((f) => [f.line, f.kind])).toEqual([
      [2, 'email'],
      [3, 'account id'],
      [4, 'signature'],
      [5, 'vendor id'],
      [6, 'vendor id'],
      [7, 'plan'],
      [8, 'base64'],
      [9, 'account id'],
    ])
  })

  it('allows the placeholders and fakes a synthesized fixture uses', () => {
    const lines = [
      header(),
      frame('out', {
        account: {
          email: 'user@example.invalid',
          organization: '<REDACTED>',
          subscriptionType: 'Example Plan',
        },
      }),
      frame('out', {
        content: [{ type: 'thinking', signature: '<REDACTED>' }],
        id: `msg_${FAKE_MARK}AbCdEfGhIjKlMnOpQr`,
      }),
      frame('out', { session_id: fakeUuid('3b1f0c2e-7d4a-4c1e-9f2b-5a6d7e8f9a0b') }),
    ]
    expect(
      checkFixtureFiles([file('tests/fixtures/claude/stdio/X/recording.jsonl', lines.join('\n'))]).findings,
    ).toEqual([])
  })

  it('finds a run of live model text, but not the code tokens the synthesizer keeps', () => {
    const live = 'The greeting is printed by the main function before the program exits cleanly today.'
    const shingles = new Set(['greeting is printed by the main function before'])
    const leak = file(
      'tests/fixtures/codex/x/recording.jsonl',
      `${header()}\n${frame('out', { text: live })}`,
    )
    const synthetic = file(
      'tests/fixtures/codex/y/recording.jsonl',
      `${header()}\n${frame('out', { text: fakeProse(live) })}`,
    )
    expect(checkFixtureFiles([leak], { realShingles: shingles }).findings).toEqual([
      { path: leak.path, line: 2, kind: 'live text' },
    ])
    expect(checkFixtureFiles([synthetic], { realShingles: shingles }).findings).toEqual([])
  })

  it('in a tree to publish, the live recording folder is a finding by itself', () => {
    const files = [file('tests/fixtures-private/claude/stdio/X/recording.jsonl', `${header()}\n`)]
    expect(checkFixtureFiles(files).findings).toEqual([])
    expect(checkFixtureFiles(files, { publish: true }).findings).toEqual([
      {
        path: 'tests/fixtures-private/claude/stdio/X/recording.jsonl',
        line: 0,
        kind: 'live recording folder',
      },
    ])
  })
})

describe('the synthesizer', () => {
  it('keeps length, whitespace and code tokens, and fakes the prose words', () => {
    const text =
      '**Exports in `src/index.ts`:**\n- `Options` (interface) has 3 fields. [must] --version NONE.'
    const out = fakeProse(text)
    expect(out).toHaveLength(text.length)
    expect(out.split(/\S+/)).toEqual(text.split(/\S+/))
    for (const kept of ['`src/index.ts`:**', '`Options`', '3', '[must]', '--version', 'NONE.'])
      expect(out).toContain(kept)
    for (const gone of ['Exports', 'interface', 'fields']) expect(out).not.toContain(gone)
    expect(fakeProse(text)).toBe(out)
  })

  it('keeps the keys and protocol values of JSON the model wrote', () => {
    const json =
      '```json\n{"entries": [{"vendor": "claude", "model": "claude-x-1", "sourceQuote": "Claude X costs $3"}]}\n```'
    const out = fakeProse(`Here it is:\n${json}`)
    const body = JSON.parse(out.split('```json\n')[1]!.split('\n```')[0]!) as {
      entries: Record<string, string>[]
    }
    expect(body.entries[0]).toMatchObject({ vendor: 'claude', model: 'claude-x-1' })
    expect(body.entries[0]!['sourceQuote']).toMatch(/^\w{6} \w \w{5} \$3$/)
    expect(body.entries[0]!['sourceQuote']).not.toContain('costs')
    expect(rewriteJsonText('{"a": "one two", "b": 2}', () => 'xxx yyy')).toBe('{"a": "xxx yyy", "b": 2}')
  })

  it('maps every id to a fake of the same shape, the same one everywhere, and leaves fakes alone', () => {
    const id = '3b1f0c2e-7d4a-4c1e-9f2b-5a6d7e8f9a0b'
    const fake = fakeUuid(id)
    expect(fake).toMatch(/^fa4e[0-9a-f]{4}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(fakeUuid(fake)).toBe(fake)
    const text = `{"session_id":"${id}","id":"toolu_01Qx7Lm2Np4Rs6Tv8Wy0Za3B","path":"x\\\\${id}.jsonl"}`
    const out = fakeIdsInText(text)
    expect(out).not.toContain(id)
    expect(out.split(fake)).toHaveLength(3)
    expect(out).toMatch(/"toolu_fa4e[A-Za-z0-9]{20}"/)
    expect(fakeIdsInText(out)).toBe(out)
  })

  it('turns a live recording into a synthetic one: header, ids, times, account, text; host frames as sent', () => {
    const sid = '3b1f0c2e-7d4a-4c1e-9f2b-5a6d7e8f9a0b'
    const hostPrompt = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Say hello world' }] },
    }
    const live = [
      JSON.stringify({
        kind: 'header',
        schemaVersion: 1,
        vendor: 'claude',
        route: 'stdio',
        cliVersion: '2.1.289',
        recordedAt: '2026-10-12T18:48:13.692Z',
        hostVersion: '0.9.0',
      }),
      frame('in', hostPrompt),
      frame('out', {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'init-1',
          response: {
            account: {
              email: 'user@example.invalid',
              organization: '<REDACTED>',
              subscriptionType: 'Claude Max',
            },
          },
        },
      }),
      frame('out', {
        type: 'stream_event',
        session_id: sid,
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'msg_01Hb5Kd7Mf9Ph1Rj3Tl5Vn7X' } },
      }),
      frame('out', {
        type: 'stream_event',
        session_id: sid,
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello the' } },
      }),
      frame('out', {
        type: 'stream_event',
        session_id: sid,
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 're, world' } },
      }),
      frame('out', {
        type: 'assistant',
        session_id: sid,
        timestamp: '2026-10-12T18:48:15.720Z',
        message: {
          model: 'claude-sonnet-5-5',
          id: 'msg_01Hb5Kd7Mf9Ph1Rj3Tl5Vn7X',
          content: [{ type: 'text', text: 'Hello there, world' }],
        },
      }),
      frame('out', {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sid,
        result: 'Hello there, world',
      }),
    ].join('\n')
    const out = synthesizeRecording(live)
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const json = (i: number): Record<string, unknown> =>
      JSON.parse(String(lines[i]!['line'])) as Record<string, unknown>
    expect(lines[0]).toMatchObject({ synthesized: true, recordedAt: BASE_TIME, hostVersion: '1.0.0' })
    expect(String(lines[0]!['synthesizedFrom'])).toContain('scripts/synthesize-fixtures.mjs')
    expect(json(1)).toEqual(hostPrompt)
    expect(json(2)).toMatchObject({
      response: { response: { account: { subscriptionType: 'Example Plan' } } },
    })
    const deltas = [4, 5].map(
      (i) => ((json(i)['event'] as Record<string, unknown>)['delta'] as { text: string }).text,
    )
    const final = (json(6)['message'] as { content: { text: string }[] }).content[0]!.text
    expect(deltas.join('')).toBe(final)
    expect(json(7)['result']).toBe(final)
    expect(final).toHaveLength('Hello there, world'.length)
    expect(final).not.toMatch(/Hello|there|world/)
    expect(out).not.toContain(sid)
    expect(out).not.toContain('msg_01Hb5Kd7Mf9Ph1Rj3Tl5Vn7X')
    // Times keep their offsets from recordedAt (to the second) and their milliseconds.
    expect(json(6)['timestamp']).toBe('2030-01-01T00:00:01.720Z')
    expect(synthesizeRecording(live)).toBe(out)
  })
})
