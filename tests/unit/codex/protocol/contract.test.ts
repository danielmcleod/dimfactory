// The adapter contract invariants and the Codex safety rules, checked on every Codex fixture (recording + expected
// events): one terminal event, no double text, every ask answered or withdrawn, zero asks in read-only passes, usage
// ≥ 0 with Σ per-pass = the final cumulative total, session before done; the host frames keep the mode table, never
// send a rule-persisting decision, never put a prompt in argv; the synthesized set is what the generator writes.
import { describe, expect, it } from 'vitest'
import { compareRecorded, matchHostNames } from '../../../fake-cli/fake-cli.mjs'
import { CLIENT_NAME } from '../../../../src/core/adapters/codex/capabilities.ts'
import { elicitationReply, isMcpApproval } from '../../../../src/core/adapters/codex/asks.ts'
import type { AskDecision } from '../../../../src/shared/events.ts'
import {
  breakdownFromExecUsage,
  usageFromTokenBreakdown,
} from '../../../../src/core/adapters/codex/protocol.ts'
import type { TokenUsageBreakdown } from '../../../../src/core/adapters/codex/protocol.ts'
import { strictOutputSchema } from '../../../../src/core/adapters/codex/params.ts'
import { refreshJsonSchema } from '../../../../src/core/catalog/refresh.ts'
import { outOfDate } from '../../../fixtures/codex/recipes/synthesize.mjs'
import type { Fixture, Json, Usage } from './fixtures.ts'
import {
  EVENT_TYPES,
  READ_ONLY_STEPS,
  allFixtures,
  loadFixture,
  message,
  messages,
  requestParams,
} from './fixtures.ts'

const fixtures = allFixtures()
const passes = fixtures.filter((f) => f.header.pass?.kind === 'pass')
/**
 * The fixtures made from live recordings by scripts/synthesize-fixtures.mjs (README "Synthesized from live
 * recordings"); every other one is written by recipes/synthesize.mjs.
 */
const FROM_LIVE = new Set([
  'E01-review-readonly',
  'E02-implement-edit-command',
  'E04-resume-fix',
  'X01a-handshake-model-list',
  'X01b-handshake-readiness',
  'X02-review-agent-deltas',
  'X03a-command-approval-allow',
  'X03b-command-approval-deny',
  'X04-filechange-approval',
  'X06a-ask-timeout-cancel',
  'X06b-resume-after-timeout',
  'X07-fix-resume-new-process',
  'X08-turn-interrupt',
  'X09h-error-model-unsupported',
  'X10-token-usage-deltas',
  'X12a-plan-native-item',
  'X17-catalog-refresh',
  // A pass with no model, the default asked for on turn/start (Review, then a native Plan).
  'X18a-default-model-turn-override',
  'X18b-default-model-plan-override',
  // An MCP tool approval sent as an elicitation, relayed and allowed.
  'X20-mcp-tool-approval',
  // A manual compaction (thread/compact/start) and an automatic one (a low auto-compact limit).
  'X21-compact-manual',
  'X22-autocompact-limit',
  // X22's automatic compaction, then the post-compaction reminder as a turn/steer.
  'X24-compaction-steer',
])
const APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const

const eventsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => EVENT_TYPES.has(String(e['type'])))
const signalsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => !EVENT_TYPES.has(String(e['type'])))
const isTerminal = (e: Json): boolean =>
  e['type'] === 'done' || (e['type'] === 'error' && e['fatal'] === true)
const readOnly = (fx: Fixture): boolean =>
  READ_ONLY_STEPS.has(String(fx.header.pass?.step)) || fx.header.pass?.mode === 'readonly'

function minus(a: Usage, b: Usage | undefined): Usage {
  if (b === undefined) return a
  const out = { input: 0, output: 0 } as Usage
  for (const f of FIELDS) out[f] = (a[f] ?? 0) - (b[f] ?? 0)
  return out
}
function plus(a: Usage, b: Usage): Usage {
  const out = { input: 0, output: 0 } as Usage
  for (const f of FIELDS) out[f] = (a[f] ?? 0) + (b[f] ?? 0)
  return out
}

/** The last cumulative total the CLI reported (app-server thread/tokenUsage/updated, exec turn.completed.usage). */
function lastTotal(fx: Fixture): Usage | undefined {
  let total: Usage | undefined
  for (const m of messages(fx, 'out')) {
    if (m['method'] === 'thread/tokenUsage/updated') {
      const t = ((m['params'] as Json)['tokenUsage'] as Json)['total'] as TokenUsageBreakdown
      total = usageFromTokenBreakdown(t)
    }
    if (m['type'] === 'turn.completed')
      total = usageFromTokenBreakdown(breakdownFromExecUsage(m['usage'] as Json))
  }
  return total
}

/** What the agent said, message by message (app-server: deltas by item; exec: agent_message items). */
function agentTexts(fx: Fixture): string[] {
  const byItem = new Map<string, string>()
  const completed = new Map<string, string>()
  for (const m of messages(fx, 'out')) {
    const p = (m['params'] ?? {}) as Json
    if (m['method'] === 'item/agentMessage/delta') {
      const id = String(p['itemId'])
      byItem.set(id, (byItem.get(id) ?? '') + String(p['delta']))
    }
    const item = (
      m['method'] === 'item/completed' ? p['item'] : m['type'] === 'item.completed' ? m['item'] : undefined
    ) as Json | undefined
    if (item !== undefined && (item['type'] === 'agentMessage' || item['type'] === 'agent_message')) {
      if (!byItem.has(String(item['id']))) byItem.set(String(item['id']), '')
      completed.set(String(item['id']), String(item['text']))
    }
  }
  return [...byItem.entries()]
    .map(([id, text]) => (text !== '' ? text : (completed.get(id) ?? '')))
    .filter((t) => t !== '')
}

describe('the fixture set', () => {
  it('is exactly what the generator writes (re-run tests/fixtures/codex/recipes/synthesize.mjs)', () => {
    expect(outOfDate()).toEqual([])
  })

  it.each(fixtures.map((f) => [`${f.route}/${f.name}`, f] as const))('%s: header', (_n, fx) => {
    expect(fx.header).toMatchObject({ kind: 'header', vendor: 'codex', route: fx.route, scenario: fx.name })
    expect(fx.header.pass?.kind).toMatch(/^(pass|probe|listModels|vendorSetup)$/)
    if (fx.route === 'app-server') expect(fx.header['protocol']).toBe('jsonrpc')
    if (FROM_LIVE.has(fx.name)) {
      // Made from a live codex-cli 0.160.1 recording on Windows: the protocol as recorded, every value synthetic.
      expect(fx.header.synthesized).toBe(true)
      expect(String(fx.header['synthesizedFrom'])).toContain('scripts/synthesize-fixtures.mjs')
      expect(fx.header['cliVersion']).toBe('0.160.1')
      expect(fx.header['os']).toBe('win32')
    } else {
      expect(fx.header.synthesized).toBe(true)
      expect(String(fx.header['synthesizedFrom'])).toContain('protocol/v0.160.0')
    }
    expect(fx.frames.at(-1)?.dir).toBe('exit')
  })
})

describe('contract invariants, every pass fixture', () => {
  it.each(passes.map((f) => [`${f.route}/${f.name}`, f] as const))('%s', (_n, fx) => {
    const events = eventsOf(fx)
    const signals = signalsOf(fx)

    // exactly one terminal event, and it is the last event
    expect(events.filter(isTerminal)).toHaveLength(1)
    expect(isTerminal(events.at(-1)!)).toBe(true)

    // session before done (and it is the thread the CLI answered with)
    const done = events.findIndex((e) => e['type'] === 'done')
    if (done !== -1) {
      const session = events.findIndex((e) => e['type'] === 'session')
      expect(session).toBeGreaterThanOrEqual(0)
      expect(session).toBeLessThan(done)
      const thread =
        fx.route === 'app-server'
          ? (
              messages(fx, 'out').find((m) => (m['result'] as Json | undefined)?.['thread'] !== undefined)?.[
                'result'
              ] as Json
            )['thread']
          : undefined
      const id =
        thread !== undefined
          ? (thread as Json)['id']
          : messages(fx, 'out').find((m) => m['type'] === 'thread.started')?.['thread_id']
      expect(events[session]!['id']).toBe(id)
      expect(events.filter((e) => e['type'] === 'session')).toHaveLength(1)
    }

    // no double-printed text: the text events are the agent's messages once, '\n\n' between two
    const printed = events.flatMap((e) => (e['type'] === 'text' ? [String(e['delta'])] : [])).join('')
    expect(printed).toBe(agentTexts(fx).join('\n\n'))

    // every ask answered or withdrawn: each approval request is an ask or an automatic answer, and has one reply
    const asks = events.filter((e) => e['type'] === 'ask').length
    const auto = signals.filter((s) => s['type'] === 'auto-answered' && s['why'] !== 'unsupported').length
    const approvals = messages(fx, 'out').filter((m) => APPROVAL_METHOD(m))
    expect(asks + auto).toBe(approvals.length)
    const replies = messages(fx, 'in').filter((m) => typeof m['method'] !== 'string')
    for (const req of messages(fx, 'out').filter((m) => typeof m['method'] === 'string' && 'id' in m))
      expect(
        replies.filter((r) => r['id'] === req['id']),
        String(req['method']),
      ).toHaveLength(1)
    const withdrawn = signals.filter((s) => s['type'] === 'ask-withdrawn').length
    const resolvedFirst = messages(fx, 'out')
      .filter((m) => m['method'] === 'serverRequest/resolved')
      .filter((m) => {
        const id = (m['params'] as Json)['requestId']
        const at = fx.frames.findIndex((f) =>
          message(f) === undefined ? false : JSON.stringify(message(f)) === JSON.stringify(m),
        )
        const replyAt = fx.frames.findIndex(
          (f) => f.dir === 'in' && message(f)?.['id'] === id && typeof message(f)?.['method'] !== 'string',
        )
        return replyAt > at
      }).length
    expect(withdrawn).toBe(resolvedFirst)

    // zero asks in read-only passes
    if (readOnly(fx)) {
      expect(asks).toBe(0)
      expect(approvals).toEqual([])
    }

    // per-pass usage ≥ 0, and it is this pass's delta of the cumulative totals
    const doneEvent = events[done]
    if (doneEvent !== undefined && doneEvent['usage'] !== undefined) {
      const usage = doneEvent['usage'] as Usage
      for (const f of FIELDS) expect(usage[f] ?? 0).toBeGreaterThanOrEqual(0)
      expect(usage).toEqual(minus(lastTotal(fx)!, fx.header.pass?.resume?.priorUsage))
    }
  })

  it('Σ per-pass usage = the final cumulative total across resumes (X04 + X07, X06a + X06b, E02 + E04)', () => {
    const doneUsage = (route: 'app-server' | 'exec', name: string): Usage =>
      eventsOf(loadFixture(route, name)).find((e) => e['type'] === 'done')!['usage'] as Usage
    const x07 = loadFixture('app-server', 'X07-fix-resume-new-process')
    expect(
      plus(doneUsage('app-server', 'X04-filechange-approval'), doneUsage('app-server', x07.name)),
    ).toEqual(lastTotal(x07))
    // A failed attempt still bills: X06a reports its usage in the `usage` meta signal, never with done.
    const x06a = loadFixture('app-server', 'X06a-ask-timeout-cancel')
    const billed = signalsOf(x06a).find((s) => s['type'] === 'meta' && s['key'] === 'usage')![
      'value'
    ] as Usage
    const x06b = loadFixture('app-server', 'X06b-resume-after-timeout')
    expect(plus(billed, doneUsage('app-server', x06b.name))).toEqual(lastTotal(x06b))
    const e04 = loadFixture('exec', 'E04-resume-fix')
    expect(plus(doneUsage('exec', 'E02-implement-edit-command'), doneUsage('exec', e04.name))).toEqual(
      lastTotal(e04),
    )
    // and each resume names the prior pass's totals as its base
    expect(x07.header.pass?.resume?.priorUsage).toEqual(
      lastTotal(loadFixture('app-server', 'X04-filechange-approval')),
    )
    expect(x06b.header.pass?.resume?.priorUsage).toEqual(lastTotal(x06a))
    expect(e04.header.pass?.resume?.priorUsage).toEqual(
      lastTotal(loadFixture('exec', 'E02-implement-edit-command')),
    )
  })
})

/** An approval request: the three approval methods, and an MCP tool approval Codex sends as an elicitation (X20). */
function APPROVAL_METHOD(m: Json): boolean {
  if (typeof m['method'] !== 'string' || !('id' in m)) return false
  if (m['method'] === 'mcpServer/elicitation/request')
    return isMcpApproval((m['params'] as Json | undefined) ?? {})
  return APPROVALS.has(m['method'])
}

describe('safety rules in the host frames', () => {
  const appPasses = passes.filter((f) => f.route === 'app-server')

  it.each(appPasses.map((f) => [f.name, f] as const))(
    '%s: the mode table on thread/start|resume',
    (_n, fx) => {
      const start = requestParams(fx, 'thread/start')
      const resume = requestParams(fx, 'thread/resume')
      const p = (start ?? resume)!
      expect(p['approvalsReviewer']).toBe('user')
      if (readOnly(fx)) {
        expect(p).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
        if (start !== undefined) expect(start['ephemeral']).toBe(true)
      } else if (fx.header.pass?.mode === 'autoedit') {
        expect(p).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
      }
      // Implement and Fix threads are never ephemeral: Fix resumes them.
      if (start !== undefined && !readOnly(fx)) expect(start['ephemeral']).toBe(false)
      if (resume !== undefined) {
        expect(resume['excludeTurns']).toBe(true)
        expect(resume['threadId']).toBe(fx.header.pass?.resume?.sessionId)
        expect('ephemeral' in resume).toBe(false)
      }
      // full mode only from Auto: no fixture pass runs it
      expect(p['sandbox']).not.toBe('danger-full-access')
      // the handshake declares experimentalApi only for a native Plan
      const init = requestParams(fx, 'initialize')!
      expect((init['capabilities'] as Json)['experimentalApi']).toBe(fx.header.pass?.planNative === true)
      // A live recording carries the host's name when it was recorded (a former name is masked by the replay,
      // RECORDED_HOST_NAMES); one recorded after the rename carries today's.
      const name = String((init['clientInfo'] as Json)['name'])
      if (!FROM_LIVE.has(fx.name)) expect(name).toBe(CLIENT_NAME)
      else expect(name === CLIENT_NAME || matchHostNames(name, CLIENT_NAME, new Map()), name).toBe(true)
    },
  )

  it('never sends a decision that persists rules; elicitations are cancelled unless an edit pass relays an MCP approval', () => {
    for (const fx of fixtures) {
      for (const line of fx.frames.filter((f) => f.dir === 'in').map((f) => f.line ?? '')) {
        expect(line).not.toMatch(/acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment/)
      }
      const outs = messages(fx, 'out')
      const answers = fx.header.pass?.answers ?? []
      const asked = outs.filter((m) => APPROVAL_METHOD(m))
      for (const req of outs.filter((m) => m['method'] === 'mcpServer/elicitation/request')) {
        const reply = messages(fx, 'in').find((m) => m['id'] === req['id'] && typeof m['method'] !== 'string')
        const relayed = !readOnly(fx) && isMcpApproval((req['params'] as Json | undefined) ?? {})
        // A relayed MCP approval gets the user's answer (the pass's answers, in ask order); anything else is cancelled.
        const decision = answers[Math.min(asked.indexOf(req), answers.length - 1)]?.decision
        expect(reply?.['result']).toEqual(
          relayed && decision !== undefined
            ? elicitationReply(decision as AskDecision)
            : { action: 'cancel', content: null, _meta: null },
        )
      }
    }
  })

  it('native Plan asks for collaborationMode plan; the fallback retries without it', () => {
    for (const name of ['X12a-plan-native-item', 'X12b-plan-proposed-block']) {
      const fx = loadFixture('app-server', name)
      const turn = requestParams(fx, 'turn/start')!
      // The settings name the model thread/start answered with (live X12a: the pass's gpt-6-luna).
      const started = messages(fx, 'out').find(
        (m) => (m['result'] as Json | undefined)?.['thread'] !== undefined,
      )
      const model = (started?.['result'] as Json)['model']
      expect(typeof model).toBe('string')
      expect(turn['collaborationMode']).toMatchObject({ mode: 'plan', settings: { model } })
    }
    const x12c = loadFixture('app-server', 'X12c-plan-collaboration-rejected')
    const starts = messages(x12c, 'in').filter((m) => m['method'] === 'turn/start')
    expect(starts.map((m) => 'collaborationMode' in (m['params'] as Json))).toEqual([true, false])
  })

  it('X17: the catalog refresh is read-only, ephemeral, live web search, outputSchema', () => {
    const fx = loadFixture('app-server', 'X17-catalog-refresh')
    expect(requestParams(fx, 'thread/start')).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      config: { web_search: 'live' },
    })
    expect(requestParams(fx, 'turn/start')!['outputSchema']).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    // Live X17: the strict form of the refresh output schema, which Codex accepted (the non-strict one was refused).
    // Recorded under the former host name, which the replay masks (RECORDED_HOST_NAMES) as it does here.
    expect(
      compareRecorded(
        requestParams(fx, 'turn/start')!['outputSchema'],
        strictOutputSchema(refreshJsonSchema(['codex'])),
      ),
    ).toEqual([])
  })

  it('X13: the local preset is a Responses provider on loopback, never --oss', () => {
    const fx = loadFixture('app-server', 'X13-local-provider')
    const p = requestParams(fx, 'thread/start')!
    expect(p['modelProvider']).toBe('dim_factory_local')
    const table = Object.values(p['config'] as Json)[0] as Json
    expect(table['wire_api']).toBe('responses')
    expect(new URL(String(table['base_url'])).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
    expect(p['model']).toBe('qwen3-coder:30b')
    for (const text of [
      ...fx.header.argv,
      ...fx.frames.filter((f) => f.dir === 'in').map((f) => f.line ?? ''),
    ])
      expect(text).not.toMatch(/--oss|--local-provider/)
  })

  it('prompts go over JSON-RPC or stdin, never argv; one private app-server per pass', () => {
    for (const fx of fixtures) {
      const argv = fx.header.argv
      const prompt = fx.header.pass?.prompt
      if (prompt !== undefined && prompt !== '<REDACTED>')
        for (const a of argv) expect(a).not.toContain(prompt)
      if (fx.route === 'app-server') {
        expect(argv.slice(-3)).toEqual(['app-server', '--listen', 'stdio://'])
        // Before the subcommand only `-c mcp_servers.*` overrides standing in for the user's config.toml (X20), and
        // X22's (and X24's) low auto-compact limit (a user setting the recording stands in for; the adapter never sends it).
        const before = argv.slice(1, -3)
        const userSetting = (a: string): boolean =>
          a.startsWith('mcp_servers.') ||
          ((fx.name === 'X22-autocompact-limit' || fx.name === 'X24-compaction-steer') &&
            a === 'model_auto_compact_token_limit=20000')
        before.forEach((a, i) => expect(i % 2 === 0 ? a === '-c' : userSetting(a), a).toBe(true))
      }
    }
  })

  it.each(passes.filter((f) => f.route === 'exec').map((f) => [f.name, f] as const))(
    '%s: the exec fallback argv',
    (_n, fx) => {
      const argv = fx.header.argv.slice(1)
      expect(argv.slice(0, 2)).toEqual(['exec', '--json'])
      expect(argv.at(-1)).toBe('-')
      for (const never of ['--full-auto', '--approve-for-me', '--oss', '--local-provider', '--yolo'])
        expect(argv).not.toContain(never)
      expect(argv).toContain('approvals_reviewer="user"')
      expect(argv[argv.indexOf('--sandbox') + 1]).toBe(readOnly(fx) ? 'read-only' : 'workspace-write')
      // never --ephemeral on Implement or Fix (it could not be resumed)
      expect(argv.includes('--ephemeral')).toBe(readOnly(fx) && fx.header.pass?.resume === undefined)
      const resume = argv.indexOf('resume')
      if (fx.header.pass?.resume !== undefined) {
        // every flag before `resume <UUID>`, then the prompt from stdin
        expect(argv.slice(resume)).toEqual(['resume', fx.header.pass.resume.sessionId, '-'])
      } else expect(resume).toBe(-1)
      // the prompt is the stdin, then EOF
      const inputs = fx.frames.filter((f) => f.dir === 'in')
      expect(inputs.map((f) => f.line)).toEqual([fx.header.pass?.prompt])
      expect(fx.frames[fx.frames.indexOf(inputs.at(-1)!) + 1]?.dir).toBe('eof')
    },
  )
})
