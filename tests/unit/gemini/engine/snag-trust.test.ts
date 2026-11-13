// trust_required on Gemini (the failure table's trust_required: "G exit 55, `not running in a trusted
// directory`, `Cannot enable privileged approval modes`; missing projectAuto grant | no | grant → retry"; Gemini exit
// codes; classifier precedence):
//   - Gemini's exit 55 and its trusted-directory messages classify as trust_required (exit code, stderr, ACP errors)
//   - the snag's list is the table's order: [Trust this folder for Gemini] (enabled), then Retry, Continue without, Close
//   - a vendor that never asks for folder trust, or a step without a vendor, gets no folder grant
import { describe, expect, it } from 'vitest'
import type { Failure, RecoveryAction } from '@shared/failure.ts'
import type { StepKey } from '@shared/run.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { classify } from '@core/heal/classify.ts'
import { retryPolicy } from '@core/heal/categories.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import type { SnagActionInput } from '@core/recovery/snag-actions.ts'

const AT = 1_800_000_000_000
const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

const trustFailure = (o: Partial<Failure> = {}): Failure => ({
  category: 'trust_required',
  message: 'Gemini is not running in a trusted directory.',
  raw: '',
  classifiedBy: 'exit',
  ...o,
})

function actions(o: Partial<SnagActionInput> = {}): RecoveryAction[] {
  return snagActions({
    step: 'implement',
    failure: trustFailure(),
    hasSession: false,
    hints: [],
    at: AT,
    vendor: 'gemini',
    vendorName: 'Gemini',
    platform: 'win32',
    config: resolveBuiltinConfig({ profile: 'claude-only' }),
    folder: FOLDER,
    clockText: () => '14:05',
    ...o,
  })
}

describe('Gemini trust_required classification (G rows)', () => {
  it('exit 55 with nothing else to go on is trust_required, classified by the exit-code table', () => {
    const r = classify({ vendor: 'gemini', step: 'implement', failed: true, exitCode: 55, now: AT })
    expect(r?.category).toBe('trust_required')
    expect(r?.classifiedBy).toBe('exit')
  })

  it.each([
    'Gemini CLI is not running in a trusted directory. To proceed, trust this folder.',
    'Cannot enable privileged approval modes in an untrusted folder.',
  ])('the trusted-directory message %j is trust_required', (line) => {
    const r = classify({ vendor: 'gemini', step: 'implement', failed: true, stderrTail: line, now: AT })
    expect(r?.category).toBe('trust_required')
  })

  it('an ACP JSON-RPC error saying the folder is untrusted is trust_required', () => {
    const r = classify({
      vendor: 'gemini',
      step: 'implement',
      failed: true,
      structured: [
        { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Not running in a trusted directory' } },
      ],
      now: AT,
    })
    expect(r?.category).toBe('trust_required')
  })

  it('never retries on its own: the user grants, then Retry runs (no budget spent)', () => {
    expect(retryPolicy('trust_required', trustFailure(), { now: AT })).toMatchObject({ auto: false })
  })
})

describe('the trust_required snag ("grant → retry")', () => {
  it('Gemini: the folder grant first and enabled, then Retry, Continue without, Close run', () => {
    const a = actions()
    expect(a[0]).toEqual({
      id: 'implement:grant-vendorFolder',
      label: 'Trust this folder for Gemini',
      kind: 'grant',
      grant: 'vendorFolder',
      vendor: 'gemini',
      detail: `Gemini works in ${FOLDER} from now on.`,
    })
    expect(a[0]).not.toHaveProperty('disabledReason')
    expect(a[1]).toMatchObject({ id: 'implement:retry', kind: 'retry', strategy: 'auto' })
    expect(a.at(-1)).toMatchObject({ kind: 'close_run' })
    for (const x of a) expect(JSON.stringify(x)).not.toContain('\u2014')
  })

  it.each(['plan', 'review', 'critic', 'fix'] as StepKey[])('%s on Gemini offers the grant too', (step) => {
    const a = actions({ step })
    expect(a[0]).toMatchObject({ id: `${step}:grant-vendorFolder`, grant: 'vendorFolder', vendor: 'gemini' })
    expect(a.find((x) => x.kind === 'retry')).toBeDefined()
  })

  it('no folder grant for a vendor that never asks for folder trust, a local preset, or a step without a vendor', () => {
    for (const o of [
      { vendor: 'claude', vendorName: 'Claude' },
      { vendor: 'codex', vendorName: 'Codex' },
      { vendor: 'local-ollama', vendorName: 'Local' },
    ]) {
      expect(
        actions(o).some((x) => x.kind === 'grant'),
        o.vendor,
      ).toBe(false)
    }
    const { vendor: _v, vendorName: _n, ...noVendor } = { vendor: '', vendorName: '' }
    const pre = snagActions({
      step: 'preflight',
      failure: trustFailure({ classifiedBy: 'app' }),
      hasSession: false,
      hints: [],
      at: AT,
      platform: 'win32',
      ...noVendor,
    })
    expect(pre.some((x) => x.kind === 'grant')).toBe(false)
  })
})
