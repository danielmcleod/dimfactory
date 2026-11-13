// The Grok fixtures (tests/fixtures/grok/acp/<ID>-<slug>/, GR01–GR05, SYNTHESIZED until recorded live) against the
// adapter contract invariants and the Grok safety rules: the set is what the generator writes (`synthesize.mjs --check`);
// every frame is valid ACP v1.25.0 (Grok's own x.ai/* notifications as JSON-RPC only); one terminal event, no double
// text, every ask answered, zero asks in read-only passes, usage = Grok's `_meta.usage`, session before done; the host
// frames send the posture as session/new `_meta` (always-approve only for a full pass, which only Auto runs), never
// set_mode or authenticate, never choose an option that widens the session; GR03 keeps autoedit unsupported.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { initializeParams } from '@core/adapters/acp-base/protocol.ts'
import type { PermissionOption } from '@core/adapters/acp-base/protocol.ts'
import { GROK_AUTOEDIT_SUPPORTED, grokConfig } from '@core/adapters/grok/config.ts'
import { GROK_FORBIDDEN_OPTION_NAME, grokMetaUsage } from '@core/adapters/grok/wire.ts'
import { LIVE, SCENARIOS, outOfDate } from '../../fixtures/grok/recipes/synthesize.mjs'
import { checkAcpRecording } from '../acp/protocol/acp-schema.ts'

const GROK_FIXTURES = fileURLToPath(new URL('../../fixtures/grok/', import.meta.url))
type Json = Record<string, unknown>
interface Frame {
  dir: string
  line?: string
  code?: number | null
}
interface Fixture {
  name: string
  text: string
  header: Json & { argv: string[]; pass: Json; synthesized?: boolean }
  frames: Frame[]
  expected: Json[]
}

const names = readdirSync(join(GROK_FIXTURES, 'acp'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
const load = (name: string): Fixture => {
  const dir = join(GROK_FIXTURES, 'acp', name)
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json)
  return {
    name,
    text,
    header: header as Fixture['header'],
    frames: frames as unknown as Frame[],
    expected: JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as Json[],
  }
}
const fixtures = names.map(load)
const passes = fixtures.filter((f) => f.header.pass['kind'] === 'pass')

const message = (f: Frame): Json | undefined => {
  if (f.line === undefined) return undefined
  try {
    return JSON.parse(f.line) as Json
  } catch {
    return undefined
  }
}
const messages = (fx: Fixture, dir: 'in' | 'out'): Json[] =>
  fx.frames.flatMap((f) => (f.dir === dir && message(f) !== undefined ? [message(f)!] : []))
const requestParams = (fx: Fixture, method: string): Json | undefined => {
  const m = messages(fx, 'in').find((x) => x['method'] === method && 'id' in x)
  return m === undefined ? undefined : ((m['params'] ?? {}) as Json)
}
const EVENT_TYPES = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
const READ_ONLY_STEPS = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])
const eventsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => EVENT_TYPES.has(String(e['type'])))
const signalsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => !EVENT_TYPES.has(String(e['type'])))
const isTerminal = (e: Json): boolean =>
  e['type'] === 'done' || (e['type'] === 'error' && e['fatal'] === true)
const readOnly = (fx: Fixture): boolean =>
  READ_ONLY_STEPS.has(String(fx.header.pass['step'])) || fx.header.pass['mode'] === 'readonly'

/** The live turn's agent messages: chunks after the prompt, split by tool updates. */
function agentMessages(fx: Fixture): string[] {
  const start = fx.frames.findIndex((f) => f.dir === 'in' && message(f)?.['method'] === 'session/prompt')
  if (start === -1) return []
  const out: string[] = []
  let current = ''
  for (const f of fx.frames.slice(start)) {
    const m = f.dir === 'out' ? message(f) : undefined
    if (m?.['method'] !== 'session/update') continue
    const u = (m['params'] as Json)['update'] as Json
    if (u['sessionUpdate'] === 'agent_message_chunk') current += String((u['content'] as Json)['text'])
    else if (u['sessionUpdate'] === 'tool_call' || u['sessionUpdate'] === 'tool_call_update') {
      if (current !== '') out.push(current)
      current = ''
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** The agent's permission requests with the host's reply to each. */
function permissions(fx: Fixture): { request: Json; replies: Json[] }[] {
  const replies = messages(fx, 'in').filter((m) => typeof m['method'] !== 'string')
  return messages(fx, 'out')
    .filter((m) => m['method'] === 'session/request_permission' && 'id' in m)
    .map((request) => ({ request, replies: replies.filter((r) => r['id'] === request['id']) }))
}
const optionsOf = (request: Json): PermissionOption[] =>
  (request['params'] as Json)['options'] as PermissionOption[]
const chosenOf = (reply: Json): string | null => {
  const outcome = (reply['result'] as Json)['outcome'] as Json
  return outcome['outcome'] === 'selected' ? String(outcome['optionId']) : null
}

/** The recording without Grok's own x.ai/* methods (vendor extensions outside the schema) and the replies to them. */
function withoutVendorExtensions(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const asked = new Set<string>()
  return lines
    .filter((l, i) => {
      if (i === 0) return true
      const f = JSON.parse(l) as Frame
      const m = message(f)
      if (m === undefined) return true
      if (typeof m['method'] === 'string' && m['method'].startsWith('x.ai/')) {
        if ('id' in m) asked.add(`${f.dir}:${JSON.stringify(m['id'])}`)
        return false
      }
      const other = f.dir === 'in' ? 'out' : 'in'
      return !(typeof m['method'] !== 'string' && asked.has(`${other}:${JSON.stringify(m['id'])}`))
    })
    .join('\n')
}

describe('the Grok fixture set', () => {
  it('is exactly what the generator writes (node tests/fixtures/grok/recipes/synthesize.mjs --check)', () => {
    expect(outOfDate()).toEqual([])
    expect(names).toEqual(SCENARIOS.map((s) => `${s.id}-${s.slug}`).sort())
  })

  it('covers GR01–GR05 (P1)', () => {
    for (const id of ['GR01', 'GR02', 'GR03', 'GR04', 'GR05'])
      expect(
        names.some((n) => n.startsWith(`${id}-`)),
        id,
      ).toBe(true)
  })

  it.each(fixtures.map((f) => [f.name, f] as const))('%s: header', (_n, fx) => {
    expect(fx.header).toMatchObject({
      kind: 'header',
      vendor: 'grok',
      route: 'acp',
      scenario: fx.name,
      protocol: 'jsonrpc',
      jsonrpc: '2.0',
      envKeys: ['GROK_DISABLE_AUTOUPDATER', 'GROK_HOME'],
      envDrop: ['^GROK_', '^XAI_'],
    })
    if (LIVE.has(fx.name)) expect(fx.header.synthesized).toBeUndefined()
    else {
      expect(fx.header.synthesized).toBe(true)
      expect(String(fx.header['synthesizedFrom'])).toContain('protocol/v1.25.0')
      expect(String(fx.header['synthesizedFrom'])).toContain('xai-org/grok-build')
      expect(String(fx.header['synthesizedFrom'])).toMatch(/read 2026-10-11/)
    }
    expect(['pass', 'probe', 'study']).toContain(fx.header.pass['kind'])
    expect(fx.frames.at(-1)?.dir).toBe('exit')
    expect(fx.frames.at(-2)?.dir).toBe('eof')
  })

  it.each(fixtures.map((f) => [f.name, f] as const))('%s: valid ACP v1.25.0', (_n, fx) => {
    expect(checkAcpRecording(withoutVendorExtensions(fx.text))).toEqual([])
  })
})

describe('contract invariants, every pass fixture', () => {
  it.each(passes.map((f) => [f.name, f] as const))('%s', (_n, fx) => {
    const events = eventsOf(fx)
    const signals = signalsOf(fx)
    expect(events.filter(isTerminal)).toHaveLength(1)
    expect(isTerminal(events.at(-1)!)).toBe(true)
    // session first, the one session/new named
    const sessionId = (
      messages(fx, 'out').find((m) => typeof (m['result'] as Json | undefined)?.['sessionId'] === 'string')?.[
        'result'
      ] as Json
    )['sessionId']
    expect(events[0]).toEqual({ type: 'session', id: sessionId })
    // no double-printed text (thoughts, x.ai notifications and available commands never print)
    const printed = events.flatMap((e) => (e['type'] === 'text' ? [String(e['delta'])] : [])).join('')
    expect(printed).toBe(agentMessages(fx).join('\n\n'))
    // every ask answered once; zero asks in a read-only pass, every request of one rejected
    const asks = events.filter((e) => e['type'] === 'ask').length
    const auto = signals.filter((s) => s['type'] === 'auto-answered').length
    const perms = permissions(fx)
    for (const p of perms) expect(p.replies).toHaveLength(1)
    expect(asks + auto).toBe(perms.length)
    if (readOnly(fx)) {
      expect(asks).toBe(0)
      for (const p of perms) {
        const option = optionsOf(p.request).find((o) => o.optionId === chosenOf(p.replies[0]!))
        expect(option?.kind).toBe('reject_once')
      }
    }
    // usage: Grok's _meta.usage, exact (no usageApprox), ≥ 0; the result is the final message
    const done = events.find((e) => e['type'] === 'done')!
    const promptId = messages(fx, 'in').find((x) => x['method'] === 'session/prompt')?.['id']
    const answer = messages(fx, 'out').find((m) => m['id'] === promptId && !('method' in m))?.['result']
    const { approx, ...usage } = grokMetaUsage(answer)!
    expect(approx).toBe(false)
    expect(done['usage']).toEqual(usage)
    for (const v of Object.values(done['usage'] as Record<string, number>))
      expect(v).toBeGreaterThanOrEqual(0)
    expect(signals.filter((s) => s['type'] === 'meta' && s['key'] === 'usageApprox')).toEqual([])
    expect(done['result']).toBe(agentMessages(fx).at(-1) ?? '')
  })
})

describe('Grok safety rules in the host frames', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_n, fx) => {
    const ins = messages(fx, 'in')
    for (const m of ins) expect(m['jsonrpc']).toBe('2.0')
    // Only what the ACP base sends: never set_mode (Grok has none), authenticate, set_config_option or x.ai/*.
    for (const m of ins.filter((x) => typeof x['method'] === 'string'))
      expect([
        'initialize',
        'session/new',
        'session/load',
        'session/resume',
        'session/prompt',
        'session/cancel',
      ]).toContain(m['method'])
    expect(requestParams(fx, 'initialize')).toEqual(initializeParams())
    // argv: `grok agent [--model <m>] --no-leader stdio`; the prompt never in argv; no widening flag
    const argv = fx.header.argv
    const model = fx.header.pass['model']
    expect(argv).toEqual([
      'grok',
      'agent',
      ...(typeof model === 'string' ? ['--model', model] : []),
      '--no-leader',
      'stdio',
    ])
    const prompt = fx.header.pass['prompt']
    if (typeof prompt === 'string') for (const a of argv) expect(a).not.toContain(prompt.slice(0, 20))
    for (const flag of grokConfig.forbiddenFlags) expect(argv).not.toContain(flag)
    // The posture: the probe sends none; a full pass (Auto only) always-approve; every other pass asks.
    const meta = requestParams(fx, 'session/new')?.['_meta']
    const pass = fx.header.pass
    if (pass['kind'] === 'probe') expect(meta).toBeUndefined()
    else if (pass['mode'] === 'full' && !readOnly(fx)) {
      expect(meta).toEqual({ yoloMode: true })
      expect(pass['auto']).toBe(true)
    } else expect(meta).toEqual({ yoloMode: false, autoMode: false })
    expect(requestParams(fx, 'session/new')).toMatchObject({ cwd: '<CWD>', mcpServers: [] })
  })

  it('never chooses an option that widens the session, an allow_always or a reject_always', () => {
    let seen = 0
    for (const fx of fixtures) {
      for (const p of permissions(fx)) {
        const chosen = chosenOf(p.replies[0]!)
        if (chosen === null) continue
        seen++
        const option = optionsOf(p.request).find((o) => o.optionId === chosen)
        expect(option, fx.name).toBeDefined()
        expect(GROK_FORBIDDEN_OPTION_NAME.test(option!.name)).toBe(false)
        expect(option!.kind).not.toBe('allow_always')
        expect(option!.kind).not.toBe('reject_always')
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it("Grok's own x.ai notification is in GR02 and never printed", () => {
    const gr02 = fixtures.find((f) => f.name.startsWith('GR02'))!
    expect(messages(gr02, 'out').some((m) => String(m['method']).startsWith('x.ai/'))).toBe(true)
    expect(
      eventsOf(gr02)
        .filter((e) => e['type'] === 'text')
        .map((e) => e['delta'])
        .join(''),
    ).not.toMatch(/Review the version flag/)
  })

  it('a full pass (GR05) runs without a single permission request; a read-only one (GR04) rejects all three', () => {
    const gr05 = fixtures.find((f) => f.name.startsWith('GR05'))!
    expect(permissions(gr05)).toEqual([])
    const gr04 = fixtures.find((f) => f.name.startsWith('GR04'))!
    expect(
      permissions(gr04)
        .map((p) => (p.request['params'] as Json)['toolCall'] as Json)
        .map((t) => t['kind']),
    ).toEqual(['execute', 'edit', 'switch_mode'])
  })
})

describe('GR03 decides Grok autoedit (fixture-gated)', () => {
  const gr03 = fixtures.find((f) => f.name.startsWith('GR03'))!

  it('the edit asks under the ask posture; beyond Allow once Grok offers only grants that widen the session', () => {
    expect(requestParams(gr03, 'session/new')?.['_meta']).toEqual({ yoloMode: false, autoMode: false })
    const edit = permissions(gr03).find(
      (p) => ((p.request['params'] as Json)['toolCall'] as Json)['kind'] === 'edit',
    )!
    const allows = optionsOf(edit.request).filter((o) => o.kind.startsWith('allow'))
    const plainAllows = allows.filter(
      (o) => o.kind === 'allow_once' && !GROK_FORBIDDEN_OPTION_NAME.test(o.name),
    )
    expect(plainAllows.map((o) => o.name)).toEqual(['Allow once'])
    for (const o of allows.filter((x) => x.kind === 'allow_always'))
      expect(GROK_FORBIDDEN_OPTION_NAME.test(o.name), o.name).toBe(true)
    // The study rejected it: nothing was written.
    const option = optionsOf(edit.request).find((o) => o.optionId === chosenOf(edit.replies[0]!))
    expect(option?.kind).toBe('reject_once')
  })

  it('synthesized, so autoedit stays unsupported; the adapter refuses an autoedit pass before spawning', () => {
    expect(gr03.header.synthesized).toBe(true)
    expect(GROK_AUTOEDIT_SUPPORTED).toBe(false)
    expect(grokConfig.modes.autoedit.status).toBe('unsupported')
    expect(gr03.header.pass).toMatchObject({ kind: 'study', mode: 'autoedit' })
    expect(gr03.expected).toEqual([{ type: 'error', fatal: true, category: 'capability_missing' }])
  })
})
