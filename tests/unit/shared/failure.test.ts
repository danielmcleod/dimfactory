import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CLASSIFIED_BY,
  FAILURE_CATEGORIES,
  GRANT_KINDS,
  JSON_PATCH_OPS,
  RECOVERY_ACTION_KINDS,
  RETRY_STRATEGIES,
  isFailureCategory,
} from '@shared/failure.ts'
import type {
  ClassifiedBy,
  FailureCategory,
  GrantKind,
  JsonPatchOp,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryActionOf,
  RetryStrategy,
} from '@shared/failure.ts'

// Verbatim from the Failures contract.
const PLAN_CATEGORIES = `
cli_missing cli_version flag_drift auth_required auth_expired rate_limited quota_exceeded billing model_unavailable network
sandbox_unavailable trust_required capability_missing resume_failed stream_malformed config_invalid git_missing git_state
folder_guard snapshot_failed worktree_failed deps_missing local_server verify_failed verify_untrusted timeout_stall
timeout_hard ask_timeout permission_denied turn_limit context_exceeded runaway_loop content_policy vendor_internal process_crash
disk_full user_cancelled unknown`
  .trim()
  .split(/\s+/)

describe('FAILURE_CATEGORIES', () => {
  it('has exactly the 38 unique snake_case categories (the plan list and runaway_loop), in order', () => {
    expect(FAILURE_CATEGORIES).toHaveLength(38)
    expect(new Set(FAILURE_CATEGORIES).size).toBe(38)
    expect([...FAILURE_CATEGORIES]).toEqual(PLAN_CATEGORIES)
    for (const c of FAILURE_CATEGORIES) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/)
  })

  it('isFailureCategory guards unknown input', () => {
    expect(isFailureCategory('rate_limited')).toBe(true)
    expect(isFailureCategory('rate-limited')).toBe(false)
    expect(isFailureCategory(42)).toBe(false)
    expect(isFailureCategory(undefined)).toBe(false)
  })

  it('derives FailureCategory from the array', () => {
    expectTypeOf<FailureCategory>().toEqualTypeOf<(typeof FAILURE_CATEGORIES)[number]>()
    expectTypeOf<'unknown'>().toExtend<FailureCategory>()
  })
})

describe('recovery contracts', () => {
  it('lists every RecoveryAction kind exactly once', () => {
    expectTypeOf<(typeof RECOVERY_ACTION_KINDS)[number]>().toEqualTypeOf<RecoveryActionKind>()
    expectTypeOf<RecoveryActionKind>().toEqualTypeOf<
      | 'retry'
      | 'resume'
      | 'config_patch'
      | 'settings_link'
      | 'shell_copy'
      | 'vendor_setup'
      | 'switch_vendor'
      | 'grant'
      | 'wait_until'
      | 'skip_pass'
      | 'close_run'
      | 'open_docs'
      | 'heal'
    >()
    expect(new Set(RECOVERY_ACTION_KINDS).size).toBe(RECOVERY_ACTION_KINDS.length)
    expect(RECOVERY_ACTION_KINDS).toHaveLength(13)
  })

  it('matches the plan unions for strategies, grants, classifiers and patch ops', () => {
    expectTypeOf<RetryStrategy>().toEqualTypeOf<
      'auto' | 'resume' | 'fresh' | 'revert-then-fresh' | 'keep-changes'
    >()
    expectTypeOf<GrantKind>().toEqualTypeOf<
      'vendorFolder' | 'largeFolder' | 'projectAuto' | 'recipeAuto' | 'command'
    >()
    expectTypeOf<ClassifiedBy>().toEqualTypeOf<
      'app' | 'errno' | 'structured' | 'exit' | 'regex' | 'heuristic'
    >()
    expectTypeOf<(typeof JSON_PATCH_OPS)[number]>().toEqualTypeOf<JsonPatchOp['op']>()
    expect(RETRY_STRATEGIES).toHaveLength(5)
    expect(GRANT_KINDS).toHaveLength(5)
    expect(CLASSIFIED_BY).toHaveLength(6)
    expect(JSON_PATCH_OPS).toEqual(['add', 'replace', 'remove', 'test'])
  })

  it('narrows actions by kind and requires id + label on each', () => {
    const actions: RecoveryAction[] = [
      { id: 'a1', label: 'Retry', kind: 'retry', strategy: 'revert-then-fresh' },
      { id: 'a2', label: 'Close run', kind: 'close_run' },
      {
        id: 'a3',
        label: 'Set up sandbox',
        kind: 'vendor_setup',
        vendor: 'codex',
        call: 'windowsSandbox/setupStart',
        params: { mode: 'unelevated' },
      },
      { id: 'a4', label: 'Trust', kind: 'grant', grant: 'vendorFolder', vendor: 'gemini', detail: 'C:\\x' },
      {
        id: 'a5',
        label: 'Use --mode',
        kind: 'config_patch',
        target: 'resolved',
        ops: [{ op: 'add', path: '/vendors/claude/flagMap/--permission-mode', value: '--mode' }],
        preview: '+ "--permission-mode": "--mode"',
        persist: { scope: 'user' },
      },
    ]
    const kinds = actions.map((a) => a.kind)
    expect(kinds).toEqual(['retry', 'close_run', 'vendor_setup', 'grant', 'config_patch'])
    expectTypeOf<RecoveryActionOf<'wait_until'>>().toHaveProperty('until').toBeNumber()
    expectTypeOf<RecoveryActionOf<'close_run'>>().toHaveProperty('id').toBeString()
    expectTypeOf<RecoveryActionOf<'shell_copy'>['shell']>().toEqualTypeOf<'powershell' | 'sh'>()
  })
})
