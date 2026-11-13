// When a run sends the post-compaction reminder: the setting (`contextHealth.compactionReminder`) and Auto. The
// default is Auto runs only.
import { describe, expect, it } from 'vitest'
import type { CompactionReminder, ResolvedConfig } from '@shared/config-schema.ts'
import { CONTEXT_HEALTH_DEFAULTS } from '@shared/config-schema.ts'
import { contextHealthRunConfig } from '@core/context/policy.ts'

const cfg = (auto: boolean, reminder?: CompactionReminder): ResolvedConfig =>
  ({
    auto,
    contextHealth: {
      ...CONTEXT_HEALTH_DEFAULTS,
      ...(reminder !== undefined ? { compactionReminder: reminder } : {}),
    },
  }) as unknown as ResolvedConfig

describe('the post-compaction reminder setting', () => {
  it('defaults to Auto runs only', () => {
    expect(CONTEXT_HEALTH_DEFAULTS.compactionReminder).toBe('auto')
    expect(contextHealthRunConfig(cfg(true)).reminder).toBe(true)
    expect(contextHealthRunConfig(cfg(false)).reminder).toBe(false)
  })

  it.each([
    ['off', true, false],
    ['off', false, false],
    ['always', false, true],
    ['always', true, true],
    ['auto', false, false],
    ['auto', true, true],
  ] as const)('%s in a run with auto=%s sends it: %s', (setting, auto, want) => {
    expect(contextHealthRunConfig(cfg(auto, setting)).reminder).toBe(want)
  })
})
