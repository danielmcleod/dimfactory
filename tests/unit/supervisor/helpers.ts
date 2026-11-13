// Shared drivers for the supervisor reducer tests. Everything goes through `reduce`; the harness only plays the
// controller's part (answering requests, firing timers) with explicit times.
import { expect } from 'vitest'
import { DEFAULT_TIMEOUTS } from '@shared/config-schema.ts'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'
import type { Failure } from '@shared/failure.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { PassName, RunEventBody, StepKey } from '@shared/run.ts'
import { DEFAULT_CONTEXT, initRunState, reduce } from '@core/supervisor/machine.ts'
import type {
  Effect,
  EffectOf,
  EngineEventBody,
  PendingRequest,
  ReconcileBoundary,
  ReducerContext,
  Reduction,
  RunConfig,
  RunState,
  SnapshotLabel,
  UserCommand,
} from '@core/supervisor/types.ts'

export const T0 = 1_000_000

export function makeConfig(over: Partial<RunConfig> = {}): RunConfig {
  return {
    auto: false,
    gates: { afterPlan: true, beforeFix: false },
    denyPauses: false,
    timeouts: { ...DEFAULT_TIMEOUTS },
    selfHeal: true,
    isolation: 'inPlace',
    branch: 'none',
    verify: { enabled: false, runAfter: ['implement', 'fix'], baseline: false },
    passes: {
      plan: { enabled: true, vendor: 'claude', model: 'opus', mode: 'readonly' },
      implement: { enabled: true, vendor: 'claude', model: null, mode: 'autoedit' },
      review: { enabled: false, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
      critic: { enabled: false, vendor: 'claude', model: 'opus', mode: 'readonly' },
      security: { enabled: false, vendor: 'claude', model: 'opus', mode: 'readonly' },
      fix: { enabled: false, vendor: 'claude', model: null, mode: 'autoedit' },
    },
    planMode: 'native',
    ...over,
  }
}

export function makeRun(config: RunConfig = makeConfig()): RunState {
  return initRunState({
    runId: '20261005T120000Z-abcd',
    displayNo: 7,
    folder: 'C:\\tmp\\ts-small',
    folderKey: '0123456789abcdef',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: T0,
    config,
  })
}

export function okReport(): PreflightReport {
  return { mode: 'authoritative', ok: true, blocking: [], warnings: [], info: [] }
}

export function blockedReport(...checks: Partial<CheckResult>[]): PreflightReport {
  const blocking = checks.map((c, i): CheckResult => ({
    id: c.id ?? `folder.check${i}`,
    scope: c.scope ?? 'folder',
    status: 'fail',
    blocking: true,
    category: c.category ?? 'folder_guard',
    title: c.title ?? `Blocker ${i}`,
    detail: c.detail ?? 'detail',
    recovery: c.recovery ?? [],
    at: T0,
    ttlMs: 0,
  }))
  return { mode: 'authoritative', ok: false, blocking, warnings: [], info: [] }
}

export function failure(category: Failure['category'], message = category): Failure {
  return { category, message, raw: '', classifiedBy: 'structured' }
}

export const PLAN_TEXT = '## Goal\nAdd a flag.\n\n## Steps\n1. Edit `src/cli.ts` (edit)'

/** A minimal controller stand-in around the pure reducer. */
export class Harness {
  state: RunState
  now = T0
  last: Reduction | undefined
  /** Every effect so far, in order. */
  log: Effect[] = []
  ctx: ReducerContext

  constructor(config: RunConfig = makeConfig(), ctx: ReducerContext = DEFAULT_CONTEXT) {
    this.state = makeRun(config)
    this.ctx = ctx
  }

  send(body: EngineEventBody, at = this.now): Reduction {
    this.now = at
    const r = reduce(this.state, { ...body, at }, this.ctx)
    this.state = r.state
    this.last = r
    this.log.push(...r.effects)
    return r
  }

  tick(ms: number): this {
    this.now += ms
    return this
  }

  get effects(): Effect[] {
    return this.last?.effects ?? []
  }

  fx<T extends Effect['t']>(t: T): EffectOf<T>[] {
    return this.effects.filter((e): e is EffectOf<T> => e.t === t)
  }

  bodies<T extends RunEventBody['t']>(t: T): Extract<RunEventBody, { t: T }>[] {
    return this.effects
      .filter((e): e is EffectOf<'emit'> => e.t === 'emit')
      .map((e) => e.body)
      .filter((b): b is Extract<RunEventBody, { t: T }> => b.t === t)
  }

  step(k: StepKey): RunState['steps'][StepKey] {
    return this.state.steps[k]
  }

  findReq(pred: (r: PendingRequest) => boolean): string | undefined {
    return Object.entries(this.state.requests).find(([, r]) => pred(r))?.[0]
  }

  req(pred: (r: PendingRequest) => boolean, what = 'request'): string {
    const id = this.findReq(pred)
    expect(id, `outstanding ${what}`).toBeDefined()
    return id as string
  }

  snapReq(label: SnapshotLabel): string {
    return this.req((r) => r.kind === 'snapshot' && r.label === label, `snapshot ${label}`)
  }

  // ---- controller answers ------------------------------------------------------------------------------------

  create(): Reduction {
    return this.send({ t: 'created' })
  }

  lock(): Reduction {
    return this.send({ t: 'lock-acquired' })
  }

  preflight(report: PreflightReport = okReport()): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'authoritative',
      'authoritative preflight',
    )
    return this.send({ t: 'preflight-result', req, report })
  }

  passPreflight(
    step: PassName,
    report: PreflightReport = { ...okReport(), mode: 'passBoundary' },
  ): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({ t: 'preflight-result', req, report })
  }

  snapshot(label: SnapshotLabel, tree = `tree-${label}`): Reduction {
    return this.send({ t: 'snapshot-done', req: this.snapReq(label), commit: `c-${label}`, tree })
  }

  snapshotFail(label: SnapshotLabel, f: Failure = failure('snapshot_failed')): Reduction {
    return this.send({ t: 'snapshot-failed', req: this.snapReq(label), failure: f })
  }

  reconcile(boundary: ReconcileBoundary = 'pre-implement', notes?: string[]): Reduction {
    const req = this.req((r) => r.kind === 'reconcile' && r.boundary === boundary, `reconcile ${boundary}`)
    return this.send({
      t: 'reconcile-result',
      req,
      result: notes ? { verdict: 'info', notes } : { verdict: 'clean' },
    })
  }

  spawnNo(step: PassName): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  ev(step: PassName, ev: NormalizedEvent, spawnNo = this.spawnNo(step)): Reduction {
    return this.send({ t: 'adapter', step, spawnNo, ev })
  }

  signal(step: PassName, signal: AdapterSignal, spawnNo = this.spawnNo(step)): Reduction {
    return this.send({ t: 'signal', step, spawnNo, signal })
  }

  exit(
    step: PassName,
    o: { code?: number | null; failure?: Failure; ranMs?: number; spawnNo?: number } = {},
  ): Reduction {
    const body: Extract<EngineEventBody, { t: 'exit' }> = {
      t: 'exit',
      step,
      spawnNo: o.spawnNo ?? this.spawnNo(step),
      code: o.code === undefined ? 0 : o.code,
      signal: null,
      ranMs: o.ranMs ?? 10_000,
    }
    if (o.failure) body.failure = o.failure
    return this.send(body)
  }

  user(cmd: UserCommand): Reduction {
    return this.send({ t: 'user', cmd })
  }

  timerDue(prefix: string): number | undefined {
    const id = Object.keys(this.state.timers).find((k) => k.startsWith(prefix))
    return id === undefined ? undefined : this.state.timers[id]
  }

  /** Fire the armed timer whose id starts with `prefix`, at its due time (or `at`). */
  fire(prefix: string, at?: number): Reduction {
    const id = Object.keys(this.state.timers).find((k) => k.startsWith(prefix))
    expect(id, `armed timer ${prefix}`).toBeDefined()
    const due = this.state.timers[id as string] as number
    return this.send({ t: 'timer', id: id as string, due }, at ?? Math.max(this.now, due))
  }

  // ---- scenario drivers ----------------------------------------------------------------------------------------

  /** R1 → R2 → preflight ok → run-start → Plan spawned. */
  toPlanRunning(): this {
    this.create()
    this.lock()
    this.preflight()
    this.snapshot('run-start', 'tree-base')
    this.passPreflight('plan')
    return this
  }

  /** Plan done with a plan; the gate is open (default config). */
  toPlanGate(text = PLAN_TEXT): this {
    this.toPlanRunning()
    this.ev('plan', { type: 'session', id: 'plan-session' })
    this.ev('plan', { type: 'done', result: text })
    this.exit('plan')
    return this
  }

  approve(input?: string): Reduction {
    const card = this.state.cards.find((c) => c.view.kind === 'gate:afterPlan')
    expect(card, 'open plan gate').toBeDefined()
    const cmd: UserCommand = { kind: 'card', cardId: card?.view.id ?? '', choiceId: 'approve' }
    if (input !== undefined) cmd.input = input
    return this.user(cmd)
  }

  /** … → gate approved → R5 reconcile → S0 → passBoundary → Implement spawned and its session known. */
  toImplementRunning(o: { session?: boolean } = {}): this {
    this.toPlanGate()
    this.approve()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    if (o.session !== false) this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  ask(step: PassName, requestId = 'q1', o: { expiresIn?: number; allowSession?: boolean } = {}): Reduction {
    return this.ev(step, {
      type: 'ask',
      requestId,
      kind: 'shell',
      detail: `npm test #${requestId}`,
      expiresAt: this.now + (o.expiresIn ?? 600_000),
      allowSession: o.allowSession ?? true,
    })
  }
}

export function effectTypes(effects: readonly Effect[]): string[] {
  return effects.map((e) => (e.t === 'emit' ? `emit:${e.body.t}` : e.t))
}
