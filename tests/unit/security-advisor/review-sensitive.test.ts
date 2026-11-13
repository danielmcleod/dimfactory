// The security advisor set to review only sensitive changes (`passes.security.review: 'sensitive'`, what Easy's changes
// use): the secret scan always runs; the reviewer runs when the scan read code handling keys, sign-in, payments or
// people's data in the diff, or found a secret, or could not read the changes; otherwise it is skipped with its reason
// and the run completes on Review and Critic alone. The default (`always`) keeps every reviewer.
import { describe, expect, it } from 'vitest'
import type { FindingInput, Reduction, RunConfig } from '@core/supervisor/types.ts'
import { SKIP_REASON } from '@core/supervisor/machine.ts'
import { makeRun } from '../supervisor/helpers.ts'
import { result, VFlow } from '../verify/machine-helpers.ts'
import type { VerifyOptions } from '../verify/machine-helpers.ts'

class SensitiveFlow extends VFlow {
  constructor(o: VerifyOptions & { securityReview?: 'sensitive' } = {}) {
    super(o)
    const config: RunConfig = structuredClone(this.state.config)
    config.passes.security = {
      enabled: true,
      vendor: 'claude',
      model: 'opus',
      mode: 'readonly',
      ...(o.securityReview !== undefined ? { review: o.securityReview } : {}),
    }
    this.state = makeRun(config)
  }

  override get reviewers(): ('review' | 'critic' | 'security')[] {
    return (['review', 'critic', 'security'] as const).filter(
      (k) => this.state.config.passes[k].enabled && this.state.steps[k].status !== 'skipped',
    )
  }

  scanCheck(): Reduction {
    const req = this.req((r) => r.kind === 'scan-check', 'scan-check')
    return this.send({ t: 'scan-check-result', req, audits: [], notes: [] })
  }

  scanResult(
    o: { sensitive?: boolean; findings?: readonly FindingInput[]; failed?: boolean } = {},
  ): Reduction {
    const req = this.req((r) => r.kind === 'scan', 'scan')
    return this.send({
      t: 'scan-result',
      req,
      secrets: [],
      audits: [],
      advisories: [],
      existing: 0,
      notes: [],
      findings: [...(o.findings ?? [])],
      ...(o.sensitive !== undefined ? { sensitive: o.sensitive } : {}),
      ...(o.failed === true
        ? {
            failure: {
              category: 'unknown' as const,
              message: 'git broke',
              raw: '',
              classifiedBy: 'app' as const,
            },
          }
        : {}),
    })
  }

  toReview(scan: Parameters<SensitiveFlow['scanResult']>[0] = {}): this {
    this.toVerified(result('test', 'pass'))
    this.scanCheck()
    this.scanResult(scan)
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    return this
  }
}

const secret: FindingInput = {
  id: 'scan-secret',
  severity: 'must',
  level: 'critical',
  title: '`src/a.ts:1`: key committed in the code',
  body: 'Remove it',
  source: 'scan',
}

describe('a security reviewer kept for sensitive changes', () => {
  it('is skipped with its reason when the scan found nothing sensitive; the run completes clean', () => {
    const f = new SensitiveFlow({ securityReview: 'sensitive', runAfter: ['implement'] }).toReview({
      sensitive: false,
    })
    expect(f.step('scan').status).toBe('done')
    expect(f.step('security').status).toBe('skipped')
    expect(f.step('security').reason).toBe(SKIP_REASON.notSensitive)
    f.report('review', 'none')
    f.report('critic', 'none')
    if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined)
      f.snapshot('post-review', 'tree-changed')
    expect(f.state.outcome).toBe('clean')
  })

  it.each([
    ['the diff touches keys or data', { sensitive: true }],
    ['the scan found a secret', { findings: [secret] }],
    ['the scan could not read the changes', { failed: true }],
  ] as const)('runs when %s', (_why, scan) => {
    const f = new SensitiveFlow({ securityReview: 'sensitive', runAfter: ['implement'] }).toReview(scan)
    expect(f.step('security').status).not.toBe('skipped')
    expect(f.fx('spawn').map((e) => e.step)).toContain('security')
  })

  it('always runs by default', () => {
    const f = new SensitiveFlow({ runAfter: ['implement'] }).toReview({ sensitive: false })
    expect(f.fx('spawn').map((e) => e.step)).toContain('security')
  })
})
