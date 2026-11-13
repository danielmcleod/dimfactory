import { describe, expect, it } from 'vitest'
import {
  CATEGORY_INFO,
  CRASH_MIN_RUN_MS,
  RATE_LIMIT_AUTO_MAX_MS,
  categoryInfo,
  categoryTitle,
  fillTemplate,
  retryPolicy,
} from '@core/heal/categories.ts'
import { FAILURE_CATEGORIES, RECOVERY_ACTION_KINDS } from '@shared/failure.ts'
import type { FailureCategory, RecoveryActionKind } from '@shared/failure.ts'

// The failure table's "Recovery (primary first)" column, as action kinds.
const C1_RECOVERY: Record<FailureCategory, RecoveryActionKind[]> = {
  cli_missing: ['shell_copy', 'settings_link', 'switch_vendor', 'open_docs'],
  cli_version: ['shell_copy', 'switch_vendor'],
  flag_drift: ['heal', 'shell_copy', 'shell_copy'],
  auth_required: ['shell_copy', 'shell_copy', 'switch_vendor'],
  auth_expired: ['shell_copy', 'switch_vendor'],
  rate_limited: ['wait_until', 'switch_vendor'],
  quota_exceeded: ['wait_until', 'switch_vendor', 'open_docs'],
  billing: ['open_docs', 'switch_vendor'],
  model_unavailable: ['config_patch', 'settings_link', 'switch_vendor'],
  network: ['retry', 'open_docs'],
  sandbox_unavailable: ['vendor_setup', 'shell_copy', 'switch_vendor'],
  trust_required: ['grant'],
  capability_missing: ['switch_vendor', 'config_patch', 'shell_copy'],
  resume_failed: ['retry'],
  stream_malformed: ['retry', 'heal'],
  config_invalid: ['settings_link', 'settings_link'],
  git_missing: ['shell_copy'],
  git_state: ['shell_copy', 'shell_copy', 'settings_link'],
  folder_guard: ['grant', 'settings_link'],
  snapshot_failed: ['retry', 'grant', 'settings_link'],
  worktree_failed: ['retry', 'settings_link', 'shell_copy', 'shell_copy', 'shell_copy'],
  deps_missing: ['shell_copy', 'settings_link', 'config_patch'],
  local_server: ['shell_copy', 'settings_link', 'switch_vendor'],
  verify_failed: [],
  verify_untrusted: ['grant'],
  timeout_stall: [],
  timeout_hard: ['resume', 'retry'],
  ask_timeout: ['resume'],
  permission_denied: ['resume'],
  turn_limit: ['resume', 'config_patch'],
  context_exceeded: ['retry', 'config_patch', 'switch_vendor'],
  runaway_loop: ['retry'],
  content_policy: ['switch_vendor'],
  vendor_internal: ['retry', 'switch_vendor'],
  process_crash: ['retry', 'heal'],
  disk_full: ['settings_link', 'retry'],
  user_cancelled: [],
  unknown: ['heal', 'retry', 'open_docs'],
}

// The failure table's "Auto-retry" column.
const C1_AUTO: Record<FailureCategory, boolean | 'conditional'> = Object.fromEntries(
  FAILURE_CATEGORIES.map((c) => [c, false]),
) as Record<FailureCategory, boolean | 'conditional'>
Object.assign(C1_AUTO, {
  network: true,
  vendor_internal: true,
  resume_failed: true,
  stream_malformed: true,
  snapshot_failed: true,
  rate_limited: 'conditional',
  process_crash: 'conditional',
  git_state: 'conditional',
})

describe('CATEGORY_INFO (the failure table as data)', () => {
  it('covers every category exactly once', () => {
    expect(Object.keys(CATEGORY_INFO).sort()).toEqual([...FAILURE_CATEGORIES].sort())
    for (const c of FAILURE_CATEGORIES) expect(categoryInfo(c).category).toBe(c)
  })

  it.each([...FAILURE_CATEGORIES])('%s: recovery order and auto-retry follow the failure table', (c) => {
    const info = CATEGORY_INFO[c]
    expect(info.title.trim()).not.toBe('')
    expect(info.recovery.map((r) => r.kind)).toEqual(C1_RECOVERY[c])
    for (const r of info.recovery) {
      expect(RECOVERY_ACTION_KINDS).toContain(r.kind)
      expect(r.label.trim()).not.toBe('')
    }
    expect(info.retry.auto).toBe(C1_AUTO[c])
  })

  it('only user_cancelled, verify_failed and timeout_stall skip the snag card', () => {
    const noSnag = FAILURE_CATEGORIES.filter((c) => !CATEGORY_INFO[c].snag)
    expect(noSnag.sort()).toEqual(['timeout_stall', 'user_cancelled', 'verify_failed'])
  })

  it('self-heal: automatic only for unknown, never for content_policy', () => {
    expect(FAILURE_CATEGORIES.filter((c) => CATEGORY_INFO[c].heal === 'auto')).toEqual(['unknown'])
    expect(CATEGORY_INFO.content_policy.heal).toBe('never')
    expect(CATEGORY_INFO.auth_required.heal).toBe('offer')
  })

  it('marks vendor-scoped categories', () => {
    for (const c of [
      'auth_required',
      'cli_missing',
      'rate_limited',
      'flag_drift',
      'vendor_internal',
    ] as const)
      expect(CATEGORY_INFO[c].vendorScoped).toBe(true)
    for (const c of ['git_state', 'disk_full', 'user_cancelled', 'network'] as const)
      expect(CATEGORY_INFO[c].vendorScoped).toBe(false)
  })

  it('conditional templates are tagged', () => {
    const unsetKey = CATEGORY_INFO.auth_required.recovery[1]!
    expect(unsetKey).toMatchObject({ kind: 'shell_copy', command: 'unsetApiKey', when: 'claude-env-key' })
    expect(CATEGORY_INFO.timeout_hard.recovery[0]).toMatchObject({ kind: 'resume', when: 'session-exists' })
    expect(CATEGORY_INFO.resume_failed.recovery[0]).toMatchObject({ kind: 'retry', strategy: 'fresh' })
  })
})

describe('templates', () => {
  it('fills placeholders', () => {
    expect(
      fillTemplate('Retry at {{resetsAt}} for {{vendor}}', { vendor: 'Claude', resetsAt: '15:00' }),
    ).toBe('Retry at 15:00 for Claude')
    expect(fillTemplate('{{missing}}x', {})).toBe('x')
    expect(categoryTitle('auth_required', { vendor: 'Codex' })).toBe('Codex needs you to log in')
    expect(categoryTitle('cli_missing')).toBe('The vendor CLI not found')
    expect(categoryTitle('disk_full')).toBe('Disk full')
  })
})

describe('retryPolicy', () => {
  const now = 1_700_000_000_000
  const f = (o: { retryAfterMs?: number; resetsAt?: number; message?: string; raw?: string } = {}) => ({
    message: o.message ?? '',
    raw: o.raw ?? '',
    ...(o.retryAfterMs !== undefined ? { retryAfterMs: o.retryAfterMs } : {}),
    ...(o.resetsAt !== undefined ? { resetsAt: o.resetsAt } : {}),
  })

  it.each([
    ['retry-after 60 s', f({ retryAfterMs: 60_000 }), { auto: true, delayMs: 60_000 }],
    [
      'retry-after exactly 120 s',
      f({ retryAfterMs: RATE_LIMIT_AUTO_MAX_MS }),
      { auto: true, delayMs: 120_000 },
    ],
    ['retry-after 120.001 s', f({ retryAfterMs: RATE_LIMIT_AUTO_MAX_MS + 1 }), { auto: false, delayMs: 0 }],
    ['resetsAt in 30 s', f({ resetsAt: now + 30_000 }), { auto: true, delayMs: 30_000 }],
    ['resetsAt in 5 h', f({ resetsAt: now + 5 * 3600_000 }), { auto: false, delayMs: 0 }],
    ['resetsAt already passed', f({ resetsAt: now - 1000 }), { auto: true, delayMs: 0 }],
    ['no retry-after', f(), { auto: false, delayMs: 0 }],
  ])('rate_limited: %s', (_name, failure, expected) => {
    expect(retryPolicy('rate_limited', failure, { now })).toMatchObject(expected)
  })

  it('process_crash retries only when the process ran > 3 s', () => {
    expect(retryPolicy('process_crash', f(), { ranMs: CRASH_MIN_RUN_MS + 1 }).auto).toBe(true)
    expect(retryPolicy('process_crash', f(), { ranMs: CRASH_MIN_RUN_MS }).auto).toBe(false)
    expect(retryPolicy('process_crash', f()).auto).toBe(false)
  })

  it('resume_failed retries fresh without spending the budget', () => {
    expect(retryPolicy('resume_failed')).toEqual({
      auto: true,
      delayMs: 0,
      strategy: 'fresh',
      consumesBudget: false,
    })
  })

  it.each([
    ['network', { auto: true, delayMs: 5_000 }],
    ['vendor_internal', { auto: true, delayMs: 15_000 }],
    ['stream_malformed', { auto: true, delayMs: 0 }],
    ['snapshot_failed', { auto: true, delayMs: 2_000 }],
  ] as const)('%s retries automatically', (c, expected) => {
    expect(retryPolicy(c)).toEqual({ ...expected, consumesBudget: true })
  })

  it('git_state re-checks only a lock', () => {
    const lock = f({ raw: "fatal: Unable to create 'C:/r/.git/index.lock': File exists." })
    expect(retryPolicy('git_state', lock)).toMatchObject({ auto: true, delayMs: 2_000 })
    expect(retryPolicy('git_state', f({ message: 'detected dubious ownership' })).auto).toBe(false)
  })

  it.each(FAILURE_CATEGORIES.filter((c) => C1_AUTO[c] === false).map((c) => [c] as const))(
    '%s never auto-retries',
    (c) => {
      expect(retryPolicy(c, f({ retryAfterMs: 1 }), { ranMs: 60_000, now })).toEqual({
        auto: false,
        delayMs: 0,
        consumesBudget: true,
      })
    },
  )
})
