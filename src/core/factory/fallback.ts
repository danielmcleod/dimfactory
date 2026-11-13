// Fallback on a rate limit (opt-in: `fallback.enabled`, user or project; off by default). When a pass fails with
// rate_limited or quota_exceeded, the run's config moves that pass to another vendor that is ready for it, the way
// "Use another vendor" (switch_vendor) does, and the pass is retried there. Once per step and run: a second limit stays
// a snag for you. It never happens past the budget (the run's own limit and today's), and every switch is logged,
// noted on the run and listed in the day's report. The vendors tried are `fallback.vendors` in order, else the usual
// order (Claude, then Codex, then the others); an Experimental vendor never.
import type { DailyReportFallback } from '../../shared/factory.ts'
import type { Mode, PassName, RunEnvelope } from '../../shared/run.ts'
import { configPassOf, isAgentStep } from '../../shared/run.ts'
import type { EventBus } from '../bus/bus.ts'
import type { Logger } from '../log.ts'
import { switchVendorOps } from '../recovery/dispatcher.ts'
import { switchTargetFor } from '../recovery/switch-vendor.ts'
import type { VendorReadiness } from '../recovery/switch-vendor.ts'
import { stepLabel } from '../supervisor/cards.ts'
import type { RunController } from '../supervisor/controller.ts'

const LIMIT_CATEGORIES = new Set(['rate_limited', 'quota_exceeded'])

export interface FallbackDeps {
  bus: EventBus
  log: Logger
  /** The run's live controller (a snag only comes from a loaded run). */
  controller(runId: string): RunController | undefined
  vendors: VendorReadiness
  vendorName(vendor: string): string
  /** The run may still spend (its own limit and today's). */
  withinBudget(runId: string): boolean
  /** Record a switch for the day's report. */
  record(f: DailyReportFallback): Promise<void>
  now(): number
}

/** The vendor a pass falls back to: the first ready of `preferred` (else the usual order), never `current`. */
export function fallbackTarget(o: {
  current: string
  pass: PassName
  mode: Mode
  preferred: readonly string[]
  vendors: VendorReadiness
}): { id: string; displayName: string } | undefined {
  if (o.preferred.length === 0) {
    const t = switchTargetFor(o.current, o.pass, o.mode, o.vendors)
    return t !== null && t.disabledReason === undefined ? { id: t.to, displayName: t.displayName } : undefined
  }
  const list = o.vendors.vendors()
  for (const id of o.preferred) {
    if (id === o.current) continue
    const v = list.find((x) => x.id === id)
    if (v === undefined || !v.built || v.experimental === true) continue
    if (o.vendors.readyFor(id, o.pass, o.mode).ok) return { id, displayName: v.displayName }
  }
  return undefined
}

export class FallbackService {
  readonly #d: FallbackDeps
  readonly #tried = new Set<string>()
  #chain: Promise<void> = Promise.resolve()
  #detach: (() => void) | undefined

  constructor(d: FallbackDeps) {
    this.#d = d
    this.#detach = d.bus.attach({
      name: 'fallback',
      run: (env) => {
        if (env.body.t !== 'snag' || !LIMIT_CATEGORIES.has(env.body.failure.category)) return
        this.#chain = this.#chain
          .then(() => this.#onLimit(env))
          .catch((err: unknown) => this.#d.log.warn('fallback failed', { err }))
      },
    })
  }

  close(): void {
    this.#detach?.()
  }

  settled(): Promise<void> {
    return this.#chain
  }

  async #onLimit(env: RunEnvelope): Promise<void> {
    if (env.body.t !== 'snag') return
    const { runId } = env
    const step = env.body.step
    if (!isAgentStep(step)) return
    const c = this.#d.controller(runId)
    if (c === undefined || c.closed) return
    const cfg = c.deps.config
    const fb = (cfg as Partial<typeof cfg>).fallback
    if (fb === undefined || !fb.enabled) return
    const key = `${runId}:${step}`
    if (this.#tried.has(key)) return
    this.#tried.add(key)
    const st = c.state
    const pass = configPassOf(step, st.config.passes)
    const current = st.steps[step].vendor ?? cfg.passes[pass].vendor
    const why = env.body.failure.category === 'quota_exceeded' ? 'used up its quota' : 'hit a rate limit'
    if (!this.#d.withinBudget(runId)) {
      this.#d.log.info('fallback not taken: the run is past its budget', { runId, step })
      return
    }
    const target = fallbackTarget({
      current,
      pass,
      mode: cfg.passes[pass].mode,
      preferred: fb.vendors,
      vendors: this.#d.vendors,
    })
    if (target === undefined) {
      this.#d.log.info('fallback not taken: no other vendor is ready', { runId, step })
      return
    }
    const from = this.#d.vendorName(current)
    const label = `Fallback: ${from} ${why}, so ${stepLabel(step)} moved to ${target.displayName}`
    const r = await c.applyConfigPatch({ ops: switchVendorOps([pass], target.id, null), label, step })
    if (!r.ok) {
      this.#d.log.warn('fallback could not switch the vendor', { runId, step, err: r.error.message })
      return
    }
    this.#d.log.info('fallback: switched vendor on a limit', { runId, step, from: current, to: target.id })
    await this.#d.record({
      at: this.#d.now(),
      runId,
      displayNo: st.displayNo,
      step: stepLabel(step),
      from,
      to: target.displayName,
      why: `${from} ${why}`,
    })
  }
}
