// Cross-vendor sessions (sessions: "Session id persistence … Codex: from the thread/start response,
// before turn/start"; decideSession "reuses Implement's session iff … same vendor …"; "Fresh, different vendor";
// Codex "Resume: thread/resume … assert the echoed id matches"; "Fix resumes the Codex thread"):
//   - StartOptions: a fresh mutating Codex pass gets no made-up session id (preassignSessionId false); Claude still
//     gets one; a Codex Fix that reuses Implement's thread carries resume {sessionId, priorUsage}
//   - the reducer records an id an adapter reports through onSession (session-assigned) like P4: a forced run.json
//     write, with the folder the pass runs in, and only while that process still reacts
//   - decideSession over vendor pairs: Codex → Codex reuses the thread; any vendor change starts fresh
import { describe, expect, it } from 'vitest'
import type { RunConfig } from '@core/supervisor/types.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import { decideSession, fixSessionInputs, previewFixSession } from '@core/supervisor/sessions.ts'
import type { SessionInputs } from '@core/supervisor/sessions.ts'
import { Flow, IMPL_TOTALS, must } from '../../supervisor/helpers.review.ts'
import type { ReviewOptions } from '../../supervisor/helpers.review.ts'
import { makeConfig } from '../../supervisor/helpers.ts'

const CWD = 'C:\\work\\repo'

/** The review flow with Implement and Fix on Codex (the balanced shape: Fix inherits Implement's vendor). */
class CodexFlow extends Flow {
  constructor(o: ReviewOptions = {}) {
    super(o)
    this.state.config.passes.implement.vendor = 'codex'
    this.state.config.passes.fix.vendor = o.fixVendor ?? 'codex'
  }

  /** Implement spawned on Codex, no session yet (the adapter is waiting on thread/start). */
  toImplementSpawned(): this {
    this.toPlanGate()
    this.approve()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    return this
  }
}

describe('session-assigned (the id Codex reports before its first turn)', () => {
  it('is recorded at once with a forced write and the pass’s folder, before any adapter event', () => {
    const f = new CodexFlow().toImplementSpawned()
    const spawnNo = f.spawnNo('implement')
    expect(f.state.steps.implement.sessionId).toBeUndefined()
    const r = f.send({ t: 'session-assigned', step: 'implement', spawnNo, sessionId: 'thr_1', cwd: CWD })
    expect(r.transition).toBe(true)
    expect(f.state.steps.implement.sessionId).toBe('thr_1')
    expect(f.state.sessions['thr_1']).toEqual({ vendor: 'codex', step: 'implement', cwd: CWD })
    // The adapter's own `session` event for the same thread changes nothing more.
    const again = f.ev('implement', { type: 'session', id: 'thr_1' })
    expect(again.transition).toBe(false)
    expect(f.state.sessions['thr_1']).toEqual({ vendor: 'codex', step: 'implement', cwd: CWD })
  })

  it('a `spawned` folder already known wins; an empty id or an old spawn number is ignored', () => {
    const f = new CodexFlow().toImplementSpawned()
    const spawnNo = f.spawnNo('implement')
    f.send({ t: 'spawned', step: 'implement', spawnNo, pid: 7, cwd: 'D:\\elsewhere' })
    f.send({ t: 'session-assigned', step: 'implement', spawnNo, sessionId: 'thr_2', cwd: CWD })
    expect(f.state.sessions['thr_2']?.cwd).toBe('D:\\elsewhere')
    f.send({ t: 'session-assigned', step: 'implement', spawnNo, sessionId: '', cwd: CWD })
    f.send({ t: 'session-assigned', step: 'implement', spawnNo: spawnNo + 5, sessionId: 'thr_x', cwd: CWD })
    expect(f.state.steps.implement.sessionId).toBe('thr_2')
    expect(f.state.sessions['thr_x']).toBeUndefined()
  })

  it('ignored once the process no longer reacts (it exited)', () => {
    const f = new CodexFlow().toImplementSpawned()
    const spawnNo = f.spawnNo('implement')
    f.ev('implement', { type: 'done', result: 'ok', usage: { input: 1, output: 1 } })
    f.exitWith('implement', IMPL_TOTALS)
    f.send({ t: 'session-assigned', step: 'implement', spawnNo, sessionId: 'late', cwd: CWD })
    expect(f.state.sessions['late']).toBeUndefined()
  })
})

describe('StartOptions for Codex (startOptionsFor)', () => {
  const spawnOf = (f: Flow, step: 'implement' | 'fix') => {
    const sp = f.log.filter((e) => e.t === 'spawn' && e.step === step).at(-1)
    if (sp === undefined || sp.t !== 'spawn') throw new Error(`no ${step} spawn`)
    return sp
  }

  it('a fresh Codex Implement gets no made-up session id; Claude keeps its pre-assigned one', () => {
    const f = new CodexFlow().toImplementSpawned()
    const base = {
      runId: 'r',
      cwd: CWD,
      config: {} as never,
      state: f.state,
      spawn: spawnOf(f, 'implement'),
      prompt: 'p',
    }
    const codex = startOptionsFor({ ...base, config: resolvedFor(), preassignSessionId: false })
    expect(codex.sessionId).toBeUndefined()
    expect(codex.resume).toBeUndefined()
    const claude = startOptionsFor({ ...base, config: resolvedFor() })
    expect(claude.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a Codex Fix reusing Implement’s thread resumes it with Implement’s totals', () => {
    const f = new CodexFlow({ beforeFix: true }).toImplementSpawned()
    const spawnNo = f.spawnNo('implement')
    f.send({ t: 'session-assigned', step: 'implement', spawnNo, sessionId: 'thr_impl', cwd: CWD })
    f.ev('implement', { type: 'done', result: 'implemented', usage: { input: 1200, output: 300 } })
    f.exitWith('implement', IMPL_TOTALS)
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none', [])
    if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined) {
      f.snapshot('post-review', 'tree-changed')
    }
    f.choose('gate:beforeFix', 'continue')
    f.reconcile('pre-fix')
    f.snapshot('fix-start', 'tree-changed')
    f.send({
      t: 'session-check',
      step: 'fix',
      check: {
        sessionId: 'thr_impl',
        ok: true,
        cwd: CWD,
        capabilities: { resume: 'id', resumeModelSwitch: true },
      },
    })
    f.passPreflight('fix')
    const sp = spawnOf(f, 'fix')
    expect(sp.launch.session).toEqual({ reuse: true, sessionId: 'thr_impl' })
    const o = startOptionsFor({
      runId: 'r',
      cwd: CWD,
      config: resolvedFor(),
      state: f.state,
      spawn: sp,
      prompt: 'fix',
      preassignSessionId: false,
    })
    expect(o.resume).toEqual({ sessionId: 'thr_impl', priorUsage: IMPL_TOTALS })
    expect(o.sessionId).toBeUndefined()
    expect(f.step('fix').sessionNote).toBe('reused the Implement session')
  })
})

describe('decideSession across vendors', () => {
  const inputs = (
    implVendor: string,
    fixVendor: string,
    o: Partial<SessionInputs['fix']> = {},
  ): SessionInputs => ({
    fix: { vendor: fixVendor, model: null, reuseSession: true, ...o },
    implement: { vendor: implVendor, model: null, status: 'done', sessionId: 'thr_impl', cwd: CWD },
    capabilities: { resume: 'id', resumeModelSwitch: true },
  })

  it.each([
    ['codex', 'codex', { reuse: true, sessionId: 'thr_impl' }],
    ['codex', 'claude', { reuse: false, reason: 'vendor-differs' }],
    ['claude', 'codex', { reuse: false, reason: 'vendor-differs' }],
    // A local preset is another provider on the Codex adapter: its thread is not Codex's.
    ['codex', 'local-ollama', { reuse: false, reason: 'vendor-differs' }],
    ['local-ollama', 'local-ollama', { reuse: true, sessionId: 'thr_impl' }],
  ] as const)('Implement %s → Fix %s', (impl, fix, want) => {
    expect(decideSession(inputs(impl, fix))).toEqual(want)
  })

  it('"Fresh, different vendor" (reuseSession off, Fix on Claude after a Codex Implement)', () => {
    const i = inputs('codex', 'claude', { reuseSession: false, override: 'fresh-other' })
    expect(decideSession(i)).toEqual({ reuse: false, reason: 'override-other-vendor' })
  })

  it('the composer preview for balanced: Fix inherits Codex and reuses the thread', () => {
    expect(
      previewFixSession(
        {
          implement: { vendor: 'codex', model: null },
          fix: { vendor: 'codex', model: null, reuseSession: true },
        },
        { capabilities: { resume: 'id', resumeModelSwitch: true } },
      ),
    ).toMatchObject({ reuse: true })
  })

  it('fixSessionInputs reads the Codex thread from the run', () => {
    const f = new CodexFlow().toImplementSpawned()
    f.send({
      t: 'session-assigned',
      step: 'implement',
      spawnNo: f.spawnNo('implement'),
      sessionId: 'thr_9',
      cwd: CWD,
    })
    const i = fixSessionInputs(f.state)
    expect(i.implement).toMatchObject({ vendor: 'codex', sessionId: 'thr_9', cwd: CWD })
    expect(i.fix.vendor).toBe('codex')
  })
})

/** A ResolvedConfig-shaped object with what startOptionsFor reads (vendors, timeouts, local presets). */
function resolvedFor(): Parameters<typeof startOptionsFor>[0]['config'] {
  const c: RunConfig = makeConfig()
  return {
    vendors: {},
    timeouts: c.timeouts,
    local: { presets: [] },
    preview: { openIn: 'ask' },
    git: { commit: false, pullRequest: false, remote: 'origin' },
  } as unknown as Parameters<typeof startOptionsFor>[0]['config']
}
