// Review fix (executors config_patch; combined short flags: every layer reads
// a single-dash argument letter by letter): the recovery guard, through the app's vendor rules (adapters/
// vendor-args.ts), refuses Gemini's escalating short flags (-y is --yolo, -w is --worktree) and its managed ones inside
// a combined short flag, op by op (checkRecoveryOps) and over the patched config (patchResolved); a plain flag passes.
import { describe, expect, it } from 'vitest'
import type { JsonPatchOp } from '@shared/failure.ts'
import { MANAGED_FLAGS } from '@core/adapters/gemini/config.ts'
import { vendorArgsCheck } from '@core/adapters/vendor-args.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { DimFactoryError } from '@core/errors.ts'
import { checkRecoveryOps, patchResolved } from '@core/recovery/config-patch.ts'

const managedFlags = { gemini: MANAGED_FLAGS as readonly string[] }
const guard = { managedFlags, vendorArgs: vendorArgsCheck }
const add = (path: string, value: unknown): JsonPatchOp => ({ op: 'add', path, value })

function refusal(fn: () => unknown): DimFactoryError {
  try {
    fn()
  } catch (e) {
    if (e instanceof DimFactoryError) return e
    throw e
  }
  throw new Error('expected a refusal')
}

describe("the recovery guard reads Gemini's combined short flags letter by letter", () => {
  it('-dy, -yd and -dw widen what a pass may do: FORBIDDEN, whichever way the op writes them', () => {
    for (const flag of ['-dy', '-yd', '-dw']) {
      for (const op of [add('/vendors/gemini/extraArgs/-', flag), add('/vendors/gemini/extraArgs', [flag])]) {
        const byOp = refusal(() => checkRecoveryOps([op], { target: 'resolved', ...guard }))
        expect(byOp.code, flag).toBe('FORBIDDEN')
        expect(byOp.message, flag).toMatch(/widens what a pass may do/)
        const byConfig = refusal(() =>
          patchResolved(resolveBuiltinConfig({ profile: 'claude-only' }), [op], guard),
        )
        expect(byConfig.code, flag).toBe('FORBIDDEN')
      }
    }
  })

  it('a managed letter inside a cluster (-dm) is refused; a plain -d passes', () => {
    const dm = refusal(() =>
      checkRecoveryOps([add('/vendors/gemini/extraArgs/-', '-dm')], { target: 'resolved', ...guard }),
    )
    expect(dm.code).toBe('FORBIDDEN')
    const ok = patchResolved(
      resolveBuiltinConfig({ profile: 'claude-only' }),
      [add('/vendors/gemini/extraArgs', ['-d'])],
      guard,
    )
    expect(ok.config.vendors['gemini']?.extraArgs).toEqual(['-d'])
  })

  it('vendors without rules of their own are left to the shared checks', () => {
    expect(vendorArgsCheck('gemini', { extraArgs: ['-d'], flagMap: {} })).toBeUndefined()
    expect(vendorArgsCheck('codex', { extraArgs: ['-dy'], flagMap: {} })).toBeUndefined()
    expect(vendorArgsCheck('claude', { extraArgs: ['--debug'], flagMap: {} })).toBeUndefined()
  })
})
