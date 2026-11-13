// The Codex normalizer (event mapping, approvals, plan text; usage: cumulative
// thread totals → this pass's delta against priorUsage; Contract invariants).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webPagesOf } from '@core/adapters/codex/map-item.ts'
import {
  CodexNormalizer,
  META_PLAN_FALLBACK,
  META_PLAN_SOURCE,
  codexUsage,
} from '@core/adapters/codex/normalize.ts'
import type { NormalizeStep, NormalizerOptions } from '@core/adapters/codex/normalize.ts'
import { FINAL_MESSAGE_PLAN_WARNING } from '@core/adapters/codex/plan.ts'
import { addUsage } from '@core/adapters/usage.ts'
import {
  META_LATE_ALLOW_RULE,
  META_PAGES_READ,
  META_STRUCTURED_OUTPUT,
  META_USAGE,
  META_USAGE_APPROX,
} from '@core/adapters/types.ts'
import type { AdapterSignal, NormalizedEvent, Usage } from '@shared/events.ts'
import { synth } from '../../../synth.ts'

type Entry = NormalizedEvent | AdapterSignal

function make(o: Partial<NormalizerOptions> = {}): CodexNormalizer {
  return new CodexNormalizer({
    step: 'implement',
    mode: 'autoedit',
    cwd: '/w',
    planNative: false,
    resumed: false,
    askTimeoutMs: 600_000,
    allowRules: [],
    structured: false,
    loopback: false,
    now: () => 1000,
    ...o,
  })
}

const take = (out: Entry[], s: NormalizeStep): void => {
  out.push(...s.signals.filter((x) => x.type !== 'shell-command'), ...s.events)
}

const notify = (n: CodexNormalizer, out: Entry[], method: string, params: unknown): void =>
  take(out, n.notification(method, params))

const visible = (list: readonly Entry[]): Entry[] => list.filter((e) => e.type !== 'liveness')

const breakdown = (input: number, cached: number, output: number, reasoning = 0) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
})

const tokenUsage = (input: number, cached: number, output: number, reasoning = 0) => ({
  threadId: 't',
  turnId: 'u',
  tokenUsage: {
    total: breakdown(input, cached, output, reasoning),
    last: breakdown(0, 0, 0),
    modelContextWindow: null,
  },
})

const completed = (status: 'completed' | 'failed' | 'interrupted', error: unknown = null) => ({
  threadId: 't',
  turn: {
    id: 'u',
    items: [],
    itemsView: 'summary',
    status,
    error,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  },
})

const agentMessage = (id: string, text: string) => ({
  item: {
    type: 'agentMessage',
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  },
  threadId: 't',
  turnId: 'u',
})

describe('event mapping', () => {
  it('deltas → text, items → tool start/end, plan updates → todo, completed → done with this pass usage', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'turn/started', { threadId: 't', turn: { id: 'u' } })
    notify(n, out, 'item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'm1', delta: 'Hel' })
    notify(n, out, 'item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'm1', delta: 'lo' })
    notify(n, out, 'item/completed', agentMessage('m1', 'Hello'))
    notify(n, out, 'item/started', {
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: 'rg foo',
        cwd: '/w',
        status: 'inProgress',
        commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: 'src' }],
      },
    })
    notify(n, out, 'item/completed', {
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: 'rg foo',
        status: 'completed',
        exitCode: 0,
        commandActions: [],
      },
    })
    notify(n, out, 'item/started', {
      item: {
        type: 'fileChange',
        id: 'f1',
        status: 'inProgress',
        changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '' }],
      },
    })
    notify(n, out, 'item/completed', {
      item: {
        type: 'fileChange',
        id: 'f1',
        status: 'completed',
        changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '' }],
      },
    })
    notify(n, out, 'turn/plan/updated', {
      threadId: 't',
      turnId: 'u',
      explanation: null,
      plan: [
        { step: 'read', status: 'completed' },
        { step: 'write the test', status: 'inProgress' },
      ],
    })
    notify(n, out, 'thread/tokenUsage/updated', tokenUsage(1200, 200, 300, 50))
    notify(n, out, 'item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'm2', delta: 'Done.' })
    notify(n, out, 'item/completed', agentMessage('m2', 'Done.'))
    notify(n, out, 'turn/completed', completed('completed'))

    expect(visible(out)).toEqual([
      { type: 'session', id: 't' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      {
        type: 'tool',
        id: 'c1',
        name: 'shell',
        summary: 'Search "foo" in src',
        phase: 'start',
        fp: 'a160575f9308',
      },
      { type: 'tool', id: 'c1', name: 'shell', summary: '$ rg foo', phase: 'end', status: 'ok' },
      { type: 'tool', id: 'f1', name: 'edit', summary: 'A a.ts', phase: 'start', fp: '4ac117384fe2' },
      { type: 'tool', id: 'f1', name: 'edit', summary: 'A a.ts', phase: 'end', status: 'ok' },
      { type: 'tool', id: 'todo-u', name: 'todo', summary: '1/2 done · next: write the test' },
      { type: 'text', delta: '\n\n' },
      { type: 'text', delta: 'Done.' },
      {
        type: 'done',
        result: 'Done.',
        usage: { input: 1000, output: 300, cacheRead: 200, cacheWrite: 0, reasoning: 50 },
      },
    ])
    expect(n.terminal).toBe(true)
    // Exactly one terminal: later frames add nothing.
    expect(n.notification('turn/completed', completed('completed')).events).toEqual([])
    expect(n.end({ code: 0, signal: null, ranMs: 1, stderrTail: [] }).events).toEqual([])
  })

  it('a Windows command reads as its script, not the PowerShell wrapper (live X02)', () => {
    const n = make()
    const out: Entry[] = []
    const script = 'git status --short; git diff -- src/index.ts; Get-Content src/index.ts'
    const item = (status: string) => ({
      type: 'commandExecution',
      id: 'exec-1',
      pluginId: null,
      scriptPath: null,
      command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${script}'`,
      cwd: '/w',
      processId: '65974',
      source: 'unifiedExecStartup',
      status,
      commandActions: [{ type: 'unknown', command: script }],
      aggregatedOutput: null,
      exitCode: status === 'completed' ? 0 : null,
      durationMs: null,
    })
    notify(n, out, 'item/started', { item: item('inProgress') })
    notify(n, out, 'item/completed', { item: item('completed') })
    expect(visible(out)).toEqual([
      {
        type: 'tool',
        id: 'exec-1',
        name: 'shell',
        summary: `$ ${script}`,
        phase: 'start',
        fp: '93c1d2af0203',
      },
      { type: 'tool', id: 'exec-1', name: 'shell', summary: `$ ${script}`, phase: 'end', status: 'ok' },
    ])
  })

  it('a file change names its files relative to the pass folder; one outside it stays absolute (live X03a)', () => {
    const n = make({ cwd: 'C:\\Temp\\sbx\\X03a' })
    const out: Entry[] = []
    const item = {
      type: 'fileChange',
      id: 'exec-2',
      changes: [
        { path: 'c:\\temp\\sbx\\X03a\\src\\cli.ts', kind: { type: 'update', move_path: null }, diff: '' },
        { path: 'C:\\Temp\\sbx\\outside.txt', kind: { type: 'add' }, diff: '' },
      ],
      status: 'completed',
    }
    notify(n, out, 'item/completed', { item })
    expect(visible(out)).toEqual([
      {
        type: 'tool',
        id: 'exec-2',
        name: 'edit',
        summary: 'M src/cli.ts, A C:\\Temp\\sbx\\outside.txt',
        phase: 'start',
        fp: '805bba732a9d',
      },
      {
        type: 'tool',
        id: 'exec-2',
        name: 'edit',
        summary: 'M src/cli.ts, A C:\\Temp\\sbx\\outside.txt',
        phase: 'end',
        status: 'ok',
      },
    ])
    const posix = make({ cwd: '/home/u/sbx' })
    const moved = {
      ...item,
      changes: [{ path: '/home/u/sbx/a.ts', kind: { type: 'update', move_path: '/home/u/sbx/b.ts' } }],
    }
    const ev = posix.notification('item/completed', { item: moved }).events
    expect(ev[0]).toMatchObject({ summary: 'R a.ts -> b.ts' })
    // Case matters off Windows: another folder that only differs in case is not the pass folder.
    const other = {
      ...item,
      changes: [{ path: '/home/U/sbx/a.ts', kind: { type: 'update', move_path: null } }],
    }
    expect(
      make({ cwd: '/home/u/sbx' }).notification('item/completed', { item: other }).events[0],
    ).toMatchObject({
      summary: 'M /home/U/sbx/a.ts',
    })
  })

  it('a message only reported completed (no deltas) prints once', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', agentMessage('m1', 'whole'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'whole' }])
  })

  it('error{willRetry:true} is liveness; willRetry:false asks the handle to wait for turn/completed', () => {
    const n = make()
    const retry = n.notification('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true })
    expect(retry.events).toEqual([])
    expect(retry.signals).toEqual([{ type: 'liveness' }])
    expect(retry.fatalPending).toBeUndefined()
    const final = n.notification('error', {
      error: { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' },
      willRetry: false,
    })
    expect(final.fatalPending).toBe(true)
    expect(final.events).toEqual([])
    // No turn/completed follows: the handle ends it with the evidence.
    const end = n.failNow({ stderrTail: [] })
    expect(end.events).toMatchObject([{ type: 'error', fatal: true, category: 'quota_exceeded' }])
  })

  it('turn/completed(failed) is classified by codexErrorInfo (generated shapes)', () => {
    const cases: [unknown, string][] = [
      ['contextWindowExceeded', 'context_exceeded'],
      ['usageLimitExceeded', 'quota_exceeded'],
      ['unauthorized', 'auth_expired'],
      [{ httpConnectionFailed: { httpStatusCode: 502 } }, 'network'],
      ['sandboxError', 'sandbox_unavailable'],
      ['cyberPolicy', 'content_policy'],
      ['tooManyDenials', 'permission_denied'],
    ]
    for (const [info, category] of cases) {
      const n = make()
      const out: Entry[] = []
      take(out, n.session('t'))
      notify(
        n,
        out,
        'turn/completed',
        completed('failed', {
          message: 'boom',
          codexErrorInfo: info,
          additionalDetails: null,
          misalignment: null,
        }),
      )
      expect(out.find((e) => e.type === 'error')).toMatchObject({ fatal: true, category })
    }
  })

  it('a failed turn still bills: its usage goes in the usage meta, never with done', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'thread/tokenUsage/updated', tokenUsage(100, 0, 10))
    notify(
      n,
      out,
      'turn/completed',
      completed('failed', { message: 'x', codexErrorInfo: 'other', additionalDetails: null }),
    )
    expect(out.find((e) => e.type === 'meta' && e.key === META_USAGE)).toMatchObject({
      value: { input: 100, output: 10 },
    })
  })

  it('an interrupted turn after a Dim Factory stop is user_cancelled; open tools end declined', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/started', {
      item: { type: 'commandExecution', id: 'c1', command: 'sleep 9', status: 'inProgress' },
    })
    n.markKilled('stop')
    notify(n, out, 'turn/completed', completed('interrupted'))
    expect(visible(out).slice(-2)).toMatchObject([
      { type: 'tool', id: 'c1', phase: 'end', status: 'declined' },
      { type: 'error', category: 'user_cancelled', fatal: true },
    ])
  })

  it('a process that ends without turn/completed gets one terminal error', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    take(out, n.end({ code: 1, signal: null, ranMs: 5000, stderrTail: ['Error: Not logged in'] }))
    expect(out.filter((e) => e.type === 'error')).toMatchObject([{ fatal: true, category: 'auth_required' }])
  })
})

describe('usage (cumulative → per-pass delta)', () => {
  it('codexUsage: cached input comes off input; exec snake_case reads the same', () => {
    expect(codexUsage(breakdown(1000, 400, 50, 10))).toEqual({
      input: 600,
      output: 50,
      cacheRead: 400,
      cacheWrite: 0,
      reasoning: 10,
    })
    expect(
      codexUsage({
        input_tokens: 1000,
        cached_input_tokens: 400,
        output_tokens: 50,
        reasoning_output_tokens: 10,
      }),
    ).toEqual({ input: 600, output: 50, cacheRead: 400, cacheWrite: 0, reasoning: 10 })
    expect(codexUsage({})).toBeUndefined()
  })

  it('Implement then a resumed Fix: deltas are ≥ 0 and sum to the final cumulative total', () => {
    const impl = make()
    const out: Entry[] = []
    take(out, impl.session('t'))
    notify(impl, out, 'thread/tokenUsage/updated', tokenUsage(1000, 100, 200, 20))
    notify(impl, out, 'thread/tokenUsage/updated', tokenUsage(2500, 900, 400, 40))
    notify(impl, out, 'turn/completed', completed('completed'))
    const fix = make({ step: 'fix', resumed: true, priorUsage: impl.cumulativeUsage() })
    take(out, fix.session('t'))
    notify(fix, out, 'thread/tokenUsage/updated', tokenUsage(4000, 2000, 500, 60))
    notify(fix, out, 'turn/completed', completed('completed'))
    const dones = out.flatMap((e) => (e.type === 'done' && e.usage !== undefined ? [e.usage] : []))
    expect(dones).toHaveLength(2)
    for (const u of dones) for (const v of Object.values(u)) expect(v).toBeGreaterThanOrEqual(0)
    expect(dones[1]).toEqual({ input: 400, output: 100, cacheRead: 1100, cacheWrite: 0, reasoning: 20 })
    const sum: Usage = addUsage(dones[0]!, dones[1]!)
    expect(sum).toEqual(fix.cumulativeUsage())
    expect(out.some((e) => e.type === 'meta' && e.key === META_USAGE_APPROX)).toBe(false)
  })

  it('a resume without a known base takes the restored totals before the turn as the base', () => {
    const n = make({ step: 'fix', resumed: true })
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'thread/tokenUsage/updated', tokenUsage(2500, 900, 400))
    n.turnStarted('u2')
    notify(n, out, 'thread/tokenUsage/updated', tokenUsage(3000, 1000, 450))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'done')).toMatchObject({
      usage: { input: 400, output: 50, cacheRead: 100 },
    })
  })

  it('no usage reported at all: done without usage, flagged approximate', () => {
    const n = make()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'done')).toEqual({ type: 'done', result: '' })
    expect(out.find((e) => e.type === 'meta' && e.key === META_USAGE_APPROX)).toBeDefined()
  })
})

describe('approvals', () => {
  const cmd = (extra: Record<string, unknown> = {}) => ({
    kind: 'command',
    threadId: 't',
    turnId: 'u',
    itemId: 'c1',
    startedAtMs: 1,
    environmentId: null,
    command: 'npm install',
    cwd: '/w',
    reason: 'needs network',
    ...extra,
  })

  it('a command ask: allow → accept, allow-session → acceptForSession + allow-rule, deny → decline', async () => {
    for (const [decision, wire] of [
      ['allow', 'accept'],
      ['allow-session', 'acceptForSession'],
      ['deny', 'decline'],
    ] as const) {
      const n = make()
      const r = n.request('item/commandExecution/requestApproval', cmd(), 7)
      expect(r.step.events).toEqual([
        {
          type: 'ask',
          requestId: '7',
          kind: 'shell',
          detail: 'npm install',
          reason: 'needs network',
          expiresAt: 601_000,
          allowSession: true,
        },
      ])
      expect(n.pendingAsks()).toEqual(['7'])
      const s = n.answer('7', decision)
      expect(await r.reply).toEqual({ decision: wire })
      expect(n.pendingAsks()).toEqual([])
      if (decision === 'allow-session') {
        expect(s.signals).toMatchObject([
          {
            type: 'allow-rule',
            rule: { vendor: 'codex', kind: 'shell', match: { argv: ['npm', 'install'] } },
          },
        ])
      } else expect(s.signals).toEqual([])
    }
  })

  it('a timeout answers cancel (the turn is interrupted) and offers the late-allow rule', async () => {
    const n = make()
    const r = n.request('item/commandExecution/requestApproval', cmd(), 1)
    const s = n.answer('1', 'cancel', 'ask-timeout')
    expect(await r.reply).toEqual({ decision: 'cancel' })
    expect(n.killedBy).toBe('ask')
    expect(s.signals).toMatchObject([{ type: 'meta', key: META_LATE_ALLOW_RULE, value: { requestId: '1' } }])
  })

  it('network context → a network ask; availableDecisions without acceptForSession hide Allow for this run', () => {
    const n = make()
    const r = n.request(
      'item/commandExecution/requestApproval',
      cmd({
        networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
        availableDecisions: ['accept', 'decline', 'cancel'],
      }),
      2,
    )
    expect(r.step.events[0]).toMatchObject({ kind: 'network', allowSession: false })
    expect((r.step.events[0] as { detail: string }).detail).toContain('registry.npmjs.org')
  })

  it('a file change ask names the files of its item; a permissions ask denies with {permissions:{}}', async () => {
    const n = make()
    n.notification('item/started', {
      item: {
        type: 'fileChange',
        id: 'f9',
        status: 'inProgress',
        changes: [{ path: 'src/x.ts', kind: { type: 'update', move_path: null }, diff: '' }],
      },
    })
    const f = n.request(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'f9', startedAtMs: 1 },
      3,
    )
    expect(f.step.events[0]).toMatchObject({ kind: 'edit', detail: 'Edit src/x.ts' })
    const p = n.request(
      'item/permissions/requestApproval',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'p',
        environmentId: null,
        startedAtMs: 1,
        cwd: '/w',
        reason: null,
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      4,
    )
    expect(p.step.events[0]).toMatchObject({ kind: 'network', detail: 'Network access' })
    n.answer('4', 'deny')
    expect(await p.reply).toEqual({ permissions: {} })
    // A permissions ask that times out cannot cancel the turn by itself: the handle interrupts it.
    const p2 = n.request(
      'item/permissions/requestApproval',
      { permissions: { network: { enabled: true } } },
      5,
    )
    expect(n.answer('5', 'cancel').interrupt).toBe(true)
    expect(await p2.reply).toEqual({ permissions: {} })
  })

  it('read-only passes raise zero asks: an approval request is declined automatically', async () => {
    for (const step of ['plan', 'review', 'critic', 'heal', 'catalog'] as const) {
      const n = make({ step, mode: 'readonly' })
      const r = n.request('item/commandExecution/requestApproval', cmd(), 1)
      expect(r.step.events).toEqual([])
      expect(r.step.signals).toMatchObject([{ type: 'auto-answered', decision: 'deny', why: 'readonly' }])
      expect(await r.reply).toEqual({ decision: 'decline' })
    }
  })

  it('an allow-cache hit is accepted without an ask', async () => {
    const n = make({
      allowRules: [
        {
          vendor: 'codex',
          kind: 'shell',
          tool: 'shell',
          match: { argv: ['npm', 'install'] },
          source: 'exact',
        },
      ],
    })
    const r = n.request('item/commandExecution/requestApproval', cmd(), 1)
    expect(r.step.events).toEqual([])
    expect(r.step.signals).toMatchObject([{ type: 'auto-answered', decision: 'allow', why: 'allow-cache' }])
    expect(await r.reply).toEqual({ decision: 'accept' })
  })

  it('Allow for this run on a command never answers the same command in another folder', async () => {
    const n = make({ cwd: 'C:/work' })
    const first = n.request('item/commandExecution/requestApproval', cmd({ cwd: 'C:/work' }), 1)
    const added = n.answer('1', 'allow-session')
    expect(await first.reply).toEqual({ decision: 'acceptForSession' })
    expect(added.signals).toMatchObject([
      { type: 'allow-rule', rule: { match: { argv: ['npm', 'install'] } } },
    ])
    // The same command again in the pass folder (spelled differently): the run's rule answers it.
    const again = n.request('item/commandExecution/requestApproval', cmd({ cwd: 'C:\\work\\' }), 2)
    expect(again.step.signals).toMatchObject([
      { type: 'auto-answered', decision: 'allow', why: 'allow-cache' },
    ])
    // The same command elsewhere: asked, with its folder shown; allowing it adds no run rule.
    const other = n.request('item/commandExecution/requestApproval', cmd({ cwd: 'C:/Users/someone' }), 3)
    expect(other.step.signals).toEqual([])
    expect(other.step.events).toMatchObject([
      { type: 'ask', kind: 'shell', detail: 'npm install\nin C:/Users/someone' },
    ])
    expect(n.answer('3', 'allow-session').signals).toEqual([])
    expect(await other.reply).toEqual({ decision: 'acceptForSession' })
    // A rule from an earlier process does not answer it either.
    const later = make({
      cwd: 'C:/work',
      allowRules: [
        {
          vendor: 'codex',
          kind: 'shell',
          tool: 'shell',
          match: { argv: ['npm', 'install'] },
          source: 'exact',
        },
      ],
    })
    const r = later.request('item/commandExecution/requestApproval', cmd({ cwd: 'D:/elsewhere' }), 1)
    expect(r.step.events).toMatchObject([{ type: 'ask' }])
  })

  it('extra permissions a command asks for are shown and never cached', async () => {
    const n = make()
    const r = n.request(
      'item/commandExecution/requestApproval',
      cmd({
        additionalPermissions: {
          network: null,
          fileSystem: { read: null, write: ['/etc'], entries: [] },
        },
      }),
      1,
    )
    expect(r.step.events).toMatchObject([{ type: 'ask', kind: 'shell' }])
    expect((r.step.events[0] as { detail: string }).detail).toBe(
      'npm install\nIt also asks for: Write access: /etc',
    )
    expect(n.answer('1', 'allow-session').signals).toEqual([])
    expect(await r.reply).toEqual({ decision: 'acceptForSession' })
  })

  it('a permissions ask puts fileSystem.entries in words (write on the disk root is an edit ask)', async () => {
    const n = make()
    const root = {
      network: null,
      fileSystem: {
        read: null,
        write: null,
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'write' },
          { path: { type: 'glob_pattern', pattern: '**/*.env' }, access: 'deny' },
          { path: { type: 'path', path: '/w/docs' }, access: 'read' },
          { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' },
        ],
      },
    }
    const p = n.request('item/permissions/requestApproval', { cwd: '/w', reason: null, permissions: root }, 1)
    expect(p.step.events).toMatchObject([
      {
        type: 'ask',
        kind: 'edit',
        detail:
          'Write access: the whole disk (every folder), the temp folder\nRead access: /w/docs\nNo access: files matching **/*.env',
        allowSession: true,
      },
    ])
    n.answer('1', 'allow')
    expect(await p.reply).toEqual({ permissions: { fileSystem: root.fileSystem }, scope: 'turn' })
  })

  it('a permission Dim Factory cannot put in words is shown as Codex sent it', () => {
    const n = make()
    const odd = {
      network: { enabled: true, proxy: 'socks5://x' },
      fileSystem: { entries: [{ path: { type: 'device', id: 7 }, access: 'write' }] },
    }
    const p = n.request('item/permissions/requestApproval', { permissions: odd }, 1)
    const detail = (p.step.events[0] as { detail: string }).detail
    expect(detail.split('\n')[0]).toBe('Network access')
    expect(detail).toContain('As Codex sent it: ')
    expect(detail).toContain('"device"')
    expect(detail).toContain('socks5://x')
  })

  it('serverRequest/resolved withdraws a pending ask; a turn end withdraws what is left', async () => {
    const n = make({ requestPrefix: 'h1:' })
    const a = n.request('item/commandExecution/requestApproval', cmd(), 1)
    const b = n.request('item/commandExecution/requestApproval', cmd(), 2)
    expect(n.pendingAsks()).toEqual(['h1:1', 'h1:2'])
    const w = n.notification('serverRequest/resolved', { threadId: 't', requestId: 1 })
    expect(w.signals).toContainEqual({ type: 'ask-withdrawn', requestId: 'h1:1' })
    expect(await a.reply).toEqual({ decision: 'cancel' })
    n.session('t')
    const end = n.notification('turn/completed', completed('completed'))
    expect(end.signals).toContainEqual({ type: 'ask-withdrawn', requestId: 'h1:2' })
    expect(await b.reply).toEqual({ decision: 'cancel' })
  })

  it('MCP elicitations are auto-cancelled; requests Dim Factory cannot show are refused', async () => {
    const n = make()
    const e = n.request('mcpServer/elicitation/request', { serverName: 'docs' }, 1)
    expect(await e.reply).toEqual({ action: 'cancel', content: null, _meta: null })
    expect(e.step.signals).toMatchObject([
      { type: 'auto-answered', decision: 'cancel', tool: 'mcp:docs', why: 'unsupported' },
    ])
    const u = n.request('item/tool/requestUserInput', {}, 2)
    await expect(u.reply).rejects.toMatchObject({ code: -32000 })
  })
})

describe('plan text (plan item → <proposed_plan> → final message with a warning)', () => {
  const planPass = (o: Partial<NormalizerOptions> = {}) =>
    make({ step: 'plan', mode: 'readonly', planNative: true, ...o })

  it('a plan item wins', () => {
    const n = planPass()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', { item: { type: 'plan', id: 'p', text: '# Plan\n1. a' } })
    notify(n, out, 'item/completed', agentMessage('m', 'Here is the plan.'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'plan-captured')).toEqual({
      type: 'plan-captured',
      markdown: '# Plan\n1. a',
      source: 'proposed_plan',
    })
    expect(out.find((e) => e.type === 'done')).toMatchObject({ result: '# Plan\n1. a' })
  })

  it('then the <proposed_plan> block of the final message', () => {
    const n = planPass()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', agentMessage('m', 'Intro\n<proposed_plan>\n1. b\n</proposed_plan>\nBye'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'plan-captured')).toMatchObject({
      markdown: '1. b',
      source: 'proposed_plan',
    })
  })

  it('else the final message, with a warning', () => {
    const n = planPass()
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', agentMessage('m', '1. just text'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'plan-captured')).toMatchObject({
      markdown: '1. just text',
      source: 'final-message',
    })
    expect(out.find((e) => e.type === 'meta' && e.key === META_PLAN_SOURCE)).toMatchObject({
      value: { source: 'final-message', warning: FINAL_MESSAGE_PLAN_WARNING },
    })
  })

  it('an emulated plan (collaborationMode refused) reports the fallback and keeps the message as the result', () => {
    const n = planPass()
    const out: Entry[] = []
    take(out, n.session('t'))
    take(out, n.planFellBack('Invalid params: collaborationMode'))
    notify(n, out, 'item/completed', agentMessage('m', 'plain plan'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.find((e) => e.type === 'meta' && e.key === META_PLAN_FALLBACK)).toBeDefined()
    expect(out.find((e) => e.type === 'plan-captured')).toBeUndefined()
    expect(out.find((e) => e.type === 'done')).toMatchObject({ result: 'plain plan' })
  })
})

describe('X17 catalog: the structured answer', () => {
  it('a JSON final message is reported as the structured-output meta just before done', () => {
    const n = make({ step: 'catalog', mode: 'readonly', structured: true })
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', agentMessage('m', '{"entries":[]}'))
    notify(n, out, 'turn/completed', completed('completed'))
    const meta = out.findIndex((e) => e.type === 'meta' && e.key === META_STRUCTURED_OUTPUT)
    const done = out.findIndex((e) => e.type === 'done')
    expect(meta).toBeGreaterThan(-1)
    expect(meta).toBeLessThan(done)
    expect(out[meta]).toMatchObject({ value: { entries: [] } })
  })

  it('a message that is not JSON: no meta (the job falls back to the message)', () => {
    const n = make({ step: 'catalog', mode: 'readonly', structured: true })
    const out: Entry[] = []
    take(out, n.session('t'))
    notify(n, out, 'item/completed', agentMessage('m', 'sorry'))
    notify(n, out, 'turn/completed', completed('completed'))
    expect(out.some((e) => e.type === 'meta' && e.key === META_STRUCTURED_OUTPUT)).toBe(false)
  })

  it('a web search item reads as the page it opened (the refresh counts page reads by host)', () => {
    const n = make({ step: 'catalog', mode: 'readonly' })
    const out: Entry[] = []
    notify(n, out, 'item/completed', {
      item: {
        type: 'webSearch',
        id: 'w',
        query: '',
        action: { type: 'openPage', url: 'https://developers.openai.com/api/docs/pricing' },
      },
    })
    notify(n, out, 'item/completed', {
      item: {
        type: 'webSearch',
        id: 'w2',
        query: 'gpt pricing',
        action: { type: 'search', query: 'gpt pricing', queries: null },
      },
    })
    expect(out.filter((e) => e.type === 'tool' && e.phase === 'end')).toMatchObject([
      { name: 'web_search', summary: 'https://developers.openai.com/api/docs/pricing', status: 'ok' },
      { name: 'web_search', summary: 'gpt pricing', status: 'ok' },
    ])
    // The opened page also goes out as pagesRead (the refresh counts every page an item read); a search sends none.
    expect(out.filter((e) => e.type === 'meta' && e.key === META_PAGES_READ)).toEqual([
      {
        type: 'meta',
        key: META_PAGES_READ,
        value: { id: 'w', urls: ['https://developers.openai.com/api/docs/pricing'] },
      },
    ])
  })

  it('live X17: an opened page is named only in results (action other / findInPage without a url)', () => {
    // codex-cli 0.160.1 on the live catalog refresh: every webSearch item/completed of the first live X17, as recorded
    // (kept as evidence when X17 was re-recorded; the re-record shows the same shapes on fewer pages).
    const frames = readFileSync(
      fileURLToPath(
        new URL(
          '../../../fixtures/codex-evidence/X17-catalog-refresh-two-hosts/recording.jsonl',
          import.meta.url,
        ),
      ),
      'utf8',
    )
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as { dir: string; line?: string })
      .filter((f) => f.dir === 'out' && f.line !== undefined)
      .map((f) => JSON.parse(f.line!) as { method?: string; params?: { item?: { type?: string } } })
      .filter((m) => m.method === 'item/completed' && m.params?.item?.type === 'webSearch')
    expect(frames).toHaveLength(6)
    const n = make({ step: 'catalog', mode: 'readonly', structured: true })
    const out: Entry[] = []
    for (const m of frames) notify(n, out, m.method!, m.params)
    const PRICING = 'https://developers.openai.com/api/docs/pricing?content_language=English'
    expect(
      out.filter((e) => e.type === 'tool' && e.phase === 'end').map((e) => e.type === 'tool' && e.summary),
    ).toEqual([
      synth('site:developers.openai.com/api/docs/pricing OpenAI API pricing models input cached input'),
      `${PRICING} (+3 more)`,
      `${PRICING} (+1 more)`,
      'site:developers.openai.com/api/docs/pricing "gpt-5.6-terra"',
      synth('site:developers.openai.com/api/docs/models/gpt-5.5 "Cached input"'),
      'https://developers.openai.com/api/docs/models/gpt-5.6-terra (+6 more)',
    ])
    // Every page an item read, for the refresh's fetchedHosts; the three plain searches read none.
    const pages = out.flatMap((e) => (e.type === 'meta' && e.key === META_PAGES_READ ? [e.value] : []))
    expect(pages).toEqual([
      {
        id: 'exec-fa4ee412-5ef9-49b9-8a21-cb85771ae3cf',
        urls: [
          PRICING,
          'https://openai.com/index/gpt-5-6/',
          'https://developers.openai.com/api/docs/models',
          'https://developers.openai.com/api/docs/deprecations',
        ],
      },
      {
        id: 'exec-fa4e9a3a-59e2-42d5-86e7-e4b44525b1cf',
        urls: [PRICING, 'https://developers.openai.com/api/docs/models'],
      },
      {
        id: 'exec-fa4ea8a8-24a3-4e1e-8a86-e9314b112322',
        urls: [
          'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
          'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
          'https://developers.openai.com/api/docs/models/gpt-5.5',
          'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
          'https://developers.openai.com/api/docs/models/gpt-6-luna',
          'https://developers.openai.com/api/docs/models/gpt-6-astra',
          'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
        ],
      },
    ])
  })

  it('webPagesOf: pages of an opened-page action only, distinct, the action url first', () => {
    const item = (action: unknown, results: unknown = null) => ({
      type: 'webSearch',
      id: 'w',
      query: '',
      action,
      results,
    })
    const hit = (url: unknown) => ({ type: 'text_result', url })
    expect(
      webPagesOf(item({ type: 'search', query: 'x', queries: null }, [hit('https://a.example/1')])),
    ).toEqual([])
    expect(webPagesOf(item(null, [hit('https://a.example/1')]))).toEqual([])
    expect(
      webPagesOf(item({ type: 'other' }, [hit('https://a.example/1'), hit('https://a.example/1'), hit(' ')])),
    ).toEqual(['https://a.example/1'])
    expect(
      webPagesOf(
        item({ type: 'findInPage', url: 'https://b.example/p', pattern: 'x' }, [
          hit('https://a.example/1'),
          'junk',
          hit(7),
        ]),
      ),
    ).toEqual(['https://b.example/p', 'https://a.example/1'])
    expect(webPagesOf(item({ type: 'openPage', url: null }, 'not a list'))).toEqual([])
  })
})

describe('exec JSONL (the no-relay fallback)', () => {
  it('a command run through a shell reads as its script (live E02: exec items carry no commandActions)', () => {
    const summary = (command: string): unknown => {
      const n = make()
      const item = {
        id: 'item_1',
        type: 'command_execution',
        command,
        aggregated_output: '',
        status: 'in_progress',
      }
      return n.execLine({ type: 'item.started', item }).events[0]
    }
    const ps = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"'
    expect(summary(`${ps} -Command 'Get-Content package.json; git diff HEAD''^ HEAD'`)).toMatchObject({
      summary: "$ Get-Content package.json; git diff HEAD'^ HEAD",
    })
    expect(summary(`${ps} -Command "Get-Content src\\\\cli.ts"`)).toMatchObject({
      summary: '$ Get-Content src\\\\cli.ts',
    })
    expect(summary(`/bin/bash -lc 'echo '\\''hi'\\'' && ls'`)).toMatchObject({ summary: "$ echo 'hi' && ls" })
    expect(summary('npm test')).toMatchObject({ summary: '$ npm test' })
    expect(summary('shellcheck -c x')).toMatchObject({ summary: '$ shellcheck -c x' })
  })

  it('thread.started → session; items through the shared mapper; done waits for the exit and the -o file', () => {
    const n = make()
    const out: Entry[] = []
    const line = (f: unknown) => take(out, n.execLine(f))
    line({ type: 'thread.started', thread_id: '01900000-0000-7000-8000-000000000001' })
    line({ type: 'turn.started' })
    line({
      type: 'item.started',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    })
    line({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'a',
        exit_code: 0,
        status: 'completed',
      },
    })
    line({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'file_change',
        changes: [{ path: 'b.ts', kind: 'update' }],
        status: 'completed',
      },
    })
    line({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'All done' } })
    line({ type: 'item.completed', item: { id: 'item_3', type: 'error', message: 'model rerouted: a -> b' } })
    line({
      type: 'turn.completed',
      usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 5 },
    })
    expect(out.some((e) => e.type === 'done')).toBe(false)
    take(
      out,
      n.execExit({ outText: 'All done (from -o)\n', code: 0, signal: null, ranMs: 9, stderrTail: [] }),
    )
    expect(visible(out)).toEqual([
      { type: 'session', id: '01900000-0000-7000-8000-000000000001' },
      { type: 'tool', id: 'item_0', name: 'shell', summary: '$ ls', phase: 'start', fp: '007e7e833d26' },
      { type: 'tool', id: 'item_0', name: 'shell', summary: '$ ls', phase: 'end', status: 'ok' },
      { type: 'tool', id: 'item_1', name: 'edit', summary: 'M b.ts', phase: 'start', fp: '9e071a7b38e8' },
      { type: 'tool', id: 'item_1', name: 'edit', summary: 'M b.ts', phase: 'end', status: 'ok' },
      { type: 'text', delta: 'All done' },
      {
        type: 'done',
        result: 'All done (from -o)',
        usage: { input: 800, output: 80, cacheRead: 100, cacheWrite: 0, reasoning: 5 },
      },
    ])
  })

  it('turn.failed is terminal and classified; an interrupted exec (no turn.* line, exit 1) after a stop is cancelled', () => {
    const a = make()
    const out: Entry[] = []
    take(out, a.execLine({ type: 'thread.started', thread_id: 't' }))
    take(
      out,
      a.execLine({
        type: 'turn.failed',
        error: { message: "You've hit your usage limit. Try again later." },
      }),
    )
    expect(out.find((e) => e.type === 'error')).toMatchObject({ category: 'quota_exceeded', fatal: true })

    const b = make()
    const out2: Entry[] = []
    take(out2, b.execLine({ type: 'thread.started', thread_id: 't' }))
    b.markKilled('stop')
    take(out2, b.execExit({ code: 1, signal: null, ranMs: 9, stderrTail: [] }))
    expect(out2.find((e) => e.type === 'error')).toMatchObject({ category: 'user_cancelled' })
  })
})

describe('MCP tool approvals (an elicitation, live X20)', () => {
  // codex-cli 0.160.1's shape (the live X20 has the values redacted): form mode, codex_approval_kind, no fields.
  const approval = {
    threadId: 't',
    turnId: 'u',
    serverName: 'tickets',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_description: 'Create a ticket.',
      tool_params: { title: 'Bug' },
      tool_params_display: [{ name: 'title', value: 'Bug', display_name: 'Title' }],
    },
    message: 'Allow the tickets MCP server to run tool "create_ticket"?',
    requestedSchema: { type: 'object', properties: {} },
  }

  it('an edit pass relays it as an `other` ask; allow accepts, deny declines, the ask timer cancels and interrupts', async () => {
    const n = make()
    const out = n.request('mcpServer/elicitation/request', approval, 7)
    expect(out.step.events).toEqual([
      {
        type: 'ask',
        requestId: '7',
        kind: 'other',
        detail: 'Allow the tickets MCP server to run tool "create_ticket"?\nTitle: Bug',
        reason: 'MCP tools run outside the Codex sandbox and may have side effects.',
        expiresAt: 1000 + 600_000,
        allowSession: false,
      },
    ])
    expect(n.pendingAsks()).toEqual(['7'])
    n.answer('7', 'allow')
    await expect(out.reply).resolves.toEqual({ action: 'accept', content: {}, _meta: null })

    const denied = make()
    const d = denied.request('mcpServer/elicitation/request', approval, 8)
    denied.answer('8', 'deny')
    await expect(d.reply).resolves.toEqual({ action: 'decline', content: null, _meta: null })

    const timed = make()
    const t = timed.request('mcpServer/elicitation/request', approval, 9)
    expect(timed.answer('9', 'cancel').interrupt).toBe(true)
    await expect(t.reply).resolves.toEqual({ action: 'cancel', content: null, _meta: null })
  })

  it('a read-only pass keeps cancelling it; a form that wants input is cancelled everywhere', async () => {
    const ro = make({ step: 'review', mode: 'readonly' })
    const out = ro.request('mcpServer/elicitation/request', approval, 1)
    expect(out.step.events).toEqual([])
    expect(out.step.signals).toEqual([
      { type: 'auto-answered', requestId: '1', decision: 'cancel', tool: 'mcp:tickets', why: 'readonly' },
    ])
    await expect(out.reply).resolves.toEqual({ action: 'cancel', content: null, _meta: null })

    const form = {
      ...approval,
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    }
    const edit = make().request('mcpServer/elicitation/request', form, 2)
    expect(edit.step.events).toEqual([])
    expect(edit.step.signals).toMatchObject([{ decision: 'cancel', why: 'unsupported' }])
    const plain = { ...approval, _meta: null }
    expect(make().request('mcpServer/elicitation/request', plain, 3).step.signals).toMatchObject([
      { decision: 'cancel', why: 'unsupported' },
    ])
  })
})
