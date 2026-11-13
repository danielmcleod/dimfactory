// Drivers for the verify rounds (the verify step, R6/R7/R11): the basic Flow plus the
// controller's answers to the trust check, the grant and the round. Everything still goes through `reduce`.
import type {
  FindingInput,
  Reduction,
  RunConfig,
  VerifyCheckCommand,
  VerifyResultInput,
  VerifyRound,
} from '@core/supervisor/types.ts'
import { Flow, reviewConfig } from '../supervisor/helpers.review.ts'
import type { ReviewOptions } from '../supervisor/helpers.review.ts'

export interface VerifyOptions extends ReviewOptions {
  /** verify.runAfter (default both). */
  runAfter?: ('implement' | 'fix')[]
  /** verify.enabled (default true). */
  enabled?: boolean
}

export function verifyFlowConfig(o: VerifyOptions = {}): RunConfig {
  const c = reviewConfig(o)
  c.verify = {
    enabled: o.enabled ?? true,
    runAfter: o.runAfter ?? ['implement', 'fix'],
    baseline: false,
  }
  return c
}

export const trusted = (
  name = 'test',
  argv = ['npm', 'run', name],
  body: string | null = 'vitest run',
): VerifyCheckCommand => ({
  name,
  argv,
  cwdRel: '.',
  body,
  trust: 'trusted',
})

export const untrusted = (
  name = 'test',
  argv = ['npm', 'run', name],
  body: string | null = 'vitest run',
): VerifyCheckCommand => ({ name, argv, cwdRel: '.', body, trust: 'untrusted' })

export const changed = (
  name = 'test',
  grantedBody = 'vitest run',
  body = 'vitest run --coverage',
): VerifyCheckCommand => ({
  name,
  argv: ['npm', 'run', name],
  cwdRel: '.',
  body,
  trust: 'changed',
  grantedBody,
})

export const result = (
  name: string,
  status: VerifyResultInput['status'],
  o: Partial<VerifyResultInput> = {},
): VerifyResultInput => ({
  name,
  argv: ['npm', 'run', name],
  status,
  exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : status === 'env' ? 127 : null,
  durationMs: status === 'pass' || status === 'fail' || status === 'env' ? 1500 : 0,
  excerpt:
    status === 'fail' ? 'FAIL src/a.test.ts\n  expected 1 to be 2' : status === 'env' ? 'npm: not found' : '',
  logPath:
    status === 'pass' || status === 'fail' || status === 'env'
      ? `C:\\home\\runs\\x\\verify\\verify-1\\1-${name}.log`
      : '',
  ...o,
})

/** The [must] a failing command becomes (verifyFindings' shape). */
export const verifyMust = (name: string, id = `v-${name}`): FindingInput => ({
  id,
  severity: 'must',
  title: `\`npm run ${name}\` failed (exit 1, 2s)`,
  body: '```\nFAIL src/a.test.ts\n```',
})

/** The [should] Auto adds for a command it skipped as untrusted. */
export const verifyShould = (name: string, id = `vs-${name}`): FindingInput => ({
  id,
  severity: 'should',
  title: `Skipped untrusted command \`npm run ${name}\``,
  body: '',
  flags: [],
})

export class VFlow extends Flow {
  constructor(o: VerifyOptions = {}) {
    super(o)
    this.state = { ...this.state, config: verifyFlowConfig(o) }
  }

  /** As the Plan → Implement driver, but Auto has no plan gate to approve. */
  override toImplementRunning(o: { session?: boolean } = {}): this {
    this.toPlanGate()
    if (this.state.cards.some((c) => c.view.kind === 'gate:afterPlan')) this.approve()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    if (o.session !== false) this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  checkReq(step: VerifyRound = 'verify:1'): string {
    return this.req((r) => r.kind === 'verify-check' && r.step === step, `verify-check ${step}`)
  }

  roundReq(step: VerifyRound = 'verify:1'): string {
    return this.req((r) => r.kind === 'verify' && r.step === step, `verify ${step}`)
  }

  grantReq(name: string): string {
    return this.req((r) => r.kind === 'trust-grant' && r.name === name, `trust-grant ${name}`)
  }

  /** The controller's trust check answer. */
  check(commands: VerifyCheckCommand[], step: VerifyRound = 'verify:1'): Reduction {
    return this.send({ t: 'verify-check-result', req: this.checkReq(step), commands })
  }

  /** The round's results (and their findings). */
  round(
    results: VerifyResultInput[],
    findings: FindingInput[] = [],
    step: VerifyRound = 'verify:1',
    aborted?: boolean,
  ): Reduction {
    return this.send({
      t: 'verify-result',
      req: this.roundReq(step),
      results,
      findings,
      ...(aborted === true ? { aborted: true } : {}),
    })
  }

  grant(name: string, ok = true, error?: string): Reduction {
    return this.send({
      t: 'trust-grant-result',
      req: this.grantReq(name),
      ok,
      ...(error !== undefined ? { error } : {}),
    })
  }

  /** S1 → verify:1 with one trusted command and the given result → R7's post-verify-1 snapshot (equal to S1). */
  toVerified(res: VerifyResultInput = result('test', 'pass'), findings: FindingInput[] = []): this {
    this.toS1()
    this.check([trusted(res.name)])
    this.round([res], findings)
    this.snapshot('post-verify-1', 'tree-changed')
    return this
  }

  /** … → reconcile(pre-review) → the reviewers spawned → both report → the post-review snapshot. */
  toJoinAfterVerify(
    review: Parameters<Flow['report']>[1] = 'none',
    critic: Parameters<Flow['report']>[1] = 'none',
    reviewFindings: FindingInput[] = [],
  ): this {
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    if (this.state.config.passes.review.enabled) this.report('review', review, reviewFindings)
    if (this.state.config.passes.critic.enabled) this.report('critic', critic)
    if (this.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined) {
      this.snapshot('post-review', 'tree-changed')
    }
    return this
  }

  /** Fix spawned → done → exited → end-of-pass → S2 (verify:2 starts when runAfter ∋ fix). */
  fixToS2(tree = 'tree-fixed'): this {
    this.toFixSpawned()
    this.ev('fix', { type: 'done', result: 'F1 fixed' })
    this.exit('fix')
    this.reconcile('end-of-pass')
    this.snapshot('S2', tree)
    return this
  }
}
