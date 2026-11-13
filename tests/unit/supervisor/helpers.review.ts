// Drivers for the review sequence (R6–R11): Review ∥ Critic, findings, the before-Fix gate and Fix. Built on the
// Plan → Implement Harness; everything still goes through `reduce`.
import { expect } from 'vitest'
import type { Usage } from '@shared/events.ts'
import type { PassName } from '@shared/run.ts'
import type {
  CardState,
  FindingInput,
  SourceParseStatus,
  Reduction,
  ReviewerPass,
  RunConfig,
} from '@core/supervisor/types.ts'
import { Harness, makeConfig } from './helpers.ts'

export interface ReviewOptions {
  review?: boolean
  critic?: boolean
  fix?: boolean
  beforeFix?: boolean
  auto?: boolean
  reuseSession?: boolean
  fixVendor?: string
  verify?: boolean
}

/** Plan → gate → Implement → Review ∥ Critic → gate:beforeFix → Fix, all Claude (the claude-only profile shape). */
export function reviewConfig(o: ReviewOptions = {}): RunConfig {
  const auto = o.auto ?? false
  const c = makeConfig({
    auto,
    gates: { afterPlan: !auto, beforeFix: auto ? false : (o.beforeFix ?? true) },
  })
  c.passes.review.enabled = o.review ?? true
  c.passes.critic.enabled = o.critic ?? true
  c.passes.fix.enabled = o.fix ?? true
  if (o.reuseSession !== undefined) c.passes.fix.reuseSession = o.reuseSession
  if (o.fixVendor !== undefined) c.passes.fix.vendor = o.fixVendor
  if (o.verify === true) c.verify = { enabled: true, runAfter: ['implement', 'fix'], baseline: false }
  return c
}

export const must = (id: string, title = `must ${id}`): FindingInput => ({
  id,
  severity: 'must',
  title,
  body: `body of ${id}`,
})
export const should = (id: string, title = `should ${id}`): FindingInput => ({
  id,
  severity: 'should',
  title,
  body: `body of ${id}`,
  flags: [],
})

export const IMPL_TOTALS: Usage = { input: 1200, output: 300, cacheRead: 5000, costUsd: 0.12 }

export class Flow extends Harness {
  constructor(o: ReviewOptions = {}) {
    super(reviewConfig(o))
  }

  get reviewers(): ReviewerPass[] {
    return (['review', 'critic'] as const).filter((k) => this.state.config.passes[k].enabled)
  }

  /** Exit with the handle's cumulative totals (feeds `sessions[id].lastTotals`). */
  exitWith(step: PassName, cumulative: Usage, code = 0): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.spawnNo(step),
      code,
      signal: null,
      ranMs: 5_000,
      cumulative,
    })
  }

  /** Implement done and exited (with cumulative totals); end-of-pass reconcile answered; S1 not yet. */
  toImplementDone(): this {
    this.toImplementRunning()
    this.ev('implement', {
      type: 'done',
      result: 'implemented',
      usage: { input: 1200, output: 300, costUsd: 0.12 },
    })
    this.exitWith('implement', IMPL_TOTALS)
    this.reconcile('end-of-pass')
    return this
  }

  /** … → S1 lands with `tree` (S0 is `tree-base`). */
  toS1(tree = 'tree-changed'): this {
    this.toImplementDone()
    this.snapshot('S1', tree)
    return this
  }

  /** … → reconcile(pre-review) → every enabled reviewer's pass-boundary preflight → Review ∥ Critic spawned. */
  toReviewRunning(): this {
    this.toS1()
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    return this
  }

  /** A reviewer's `done` (and its exit): review.md written, the findings parse outstanding. */
  reviewerDone(step: ReviewerPass, text = 'NO FINDINGS'): this {
    this.ev(step, { type: 'session', id: `${step}-session` })
    this.ev(step, { type: 'done', result: text, usage: { input: 10, output: 5, costUsd: 0.01 } })
    this.exit(step)
    return this
  }

  findingsReq(step: ReviewerPass): string {
    return this.req((r) => r.kind === 'findings' && r.step === step, `findings ${step}`)
  }

  /** Answer the reviewer's parse request. */
  parsed(step: ReviewerPass, status: SourceParseStatus, findings: FindingInput[] = []): Reduction {
    return this.send({ t: 'findings-result', req: this.findingsReq(step), status, findings })
  }

  /** `done` + exit + parse result. */
  report(step: ReviewerPass, status: SourceParseStatus, findings: FindingInput[] = []): Reduction {
    this.reviewerDone(step, status === 'none' ? 'NO FINDINGS' : status === 'empty' ? '' : 'findings')
    return this.parsed(step, status, findings)
  }

  /** Both enabled reviewers report; then the post-review snapshot lands (equal to S1 unless `postTree`). */
  toJoin(
    review: [SourceParseStatus, FindingInput[]] = ['none', []],
    critic: [SourceParseStatus, FindingInput[]] = ['none', []],
    postTree = 'tree-changed',
  ): this {
    this.toReviewRunning()
    if (this.state.config.passes.review.enabled) this.report('review', ...review)
    if (this.state.config.passes.critic.enabled) this.report('critic', ...critic)
    if (this.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined) {
      this.snapshot('post-review', postTree)
    }
    return this
  }

  card(kind: CardState['view']['kind']): CardState {
    const c = this.state.cards.find((x) => x.view.kind === kind)
    expect(c, `open ${kind} card`).toBeDefined()
    return c as CardState
  }

  choose(kind: CardState['view']['kind'], choiceId: string, input?: string | string[]): Reduction {
    const c = this.card(kind)
    return this.user(
      input === undefined
        ? { kind: 'card', cardId: c.view.id, choiceId }
        : { kind: 'card', cardId: c.view.id, choiceId, input },
    )
  }

  /** R10 pipeline: reconcile(pre-fix) → F0 → the pass-boundary preflight → Fix spawned. */
  toFixSpawned(tree = 'tree-changed'): this {
    this.reconcile('pre-fix')
    this.snapshot('fix-start', tree)
    this.passPreflight('fix')
    return this
  }
}
