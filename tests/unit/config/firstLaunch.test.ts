import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { Support } from '@shared/vendors.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import type { BuiltinProfileName } from '@core/config/builtins.ts'
import {
  DEFAULT_APP_STATE,
  criticSwapSuggestion,
  isVendorReady,
  readinessOf,
  runFirstLaunch,
  selectFirstLaunchProfile,
} from '@core/config/firstLaunch.ts'
import type { FirstLaunchReadiness, VendorReadiness } from '@core/config/firstLaunch.ts'
import { homePaths } from '@core/home.ts'
import type { HomePaths } from '@core/home.ts'

const paths = (): HomePaths => {
  const h = process.env['DIM_FACTORY_HOME']
  if (h === undefined) throw new Error('DIM_FACTORY_HOME is not set')
  return homePaths(h)
}

const READY: VendorReadiness = { probeOk: true, autoedit: 'supported' }
const DOWN: VendorReadiness = { probeOk: false, autoedit: 'supported' }
/** Installed and logged in, but no Windows sandbox: autoedit unsupported (this dev machine's Codex). */
const NO_SANDBOX: VendorReadiness = { probeOk: true, autoedit: 'unsupported' }

describe('first-launch matrix (4 rows; Codex ready requires autoedit support)', () => {
  it.each([
    ['ready', 'ready', READY, READY, 'balanced', true],
    ['ready', 'not ready', READY, DOWN, 'claude-only', true],
    ['not ready', 'ready', DOWN, READY, 'codex-only', true],
    ['not ready', 'not ready', DOWN, DOWN, 'balanced', false],
  ] as const)('Claude %s, Codex %s', (_c, _x, claude, codex, profile, runnable) => {
    expect(selectFirstLaunchProfile({ claude, codex })).toEqual({
      profile,
      claudeReady: claude.probeOk,
      codexReady: codex.probeOk,
      runnable,
    })
  })

  it('Codex without autoedit support (no Windows sandbox) is not ready → claude-only', () => {
    expect(selectFirstLaunchProfile({ claude: READY, codex: NO_SANDBOX })).toMatchObject({
      profile: 'claude-only',
      codexReady: false,
    })
    expect(selectFirstLaunchProfile({ claude: READY, codex: { probeOk: true } }).profile).toBe('claude-only')
    expect(
      selectFirstLaunchProfile({ claude: DOWN, codex: { probeOk: true, autoedit: 'degraded' } }).profile,
    ).toBe('codex-only')
  })

  it('a vendor that was never probed is not ready', () => {
    expect(selectFirstLaunchProfile({})).toMatchObject({ profile: 'balanced', runnable: false })
    expect(isVendorReady(undefined)).toBe(false)
    expect(isVendorReady({ probeOk: true })).toBe(true)
    expect(isVendorReady({ probeOk: true }, { requireAutoedit: true })).toBe(false)
  })

  it('readinessOf asks the adapter for implement/autoedit support', () => {
    const asked: unknown[] = []
    const adapter = {
      support: (need: unknown): Support => {
        asked.push(need)
        return { status: 'unsupported', copy: 'needs the Windows sandbox' }
      },
    }
    expect(readinessOf(adapter, { ok: true })).toEqual({ probeOk: true, autoedit: 'unsupported' })
    expect(asked[0]).toMatchObject({ pass: 'implement', mode: 'autoedit' })
    expect(readinessOf(adapter, { ok: true }, false).probeOk).toBe(false)
    expect(readinessOf(undefined, null)).toEqual({ probeOk: false })
  })
})

describe('runFirstLaunch', () => {
  const run = async (readiness: FirstLaunchReadiness, now = 1_000) => {
    const writes: BuiltinProfileName[] = []
    const p = paths()
    const out = await runFirstLaunch({
      paths: p,
      readiness,
      writeProfile: async (profile) => {
        writes.push(profile)
        await writeFile(p.userConfig, `{\n  "profile": "${profile}"\n}\n`)
      },
      now: () => now,
    })
    return { out, writes }
  }
  const state = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(paths().state, 'utf8')) as Record<string, unknown>

  it('no user file: writes the selected profile and records firstLaunchCompletedAt', async () => {
    const { out, writes } = await run({ claude: READY, codex: NO_SANDBOX })
    expect(writes).toEqual(['claude-only'])
    expect(out).toMatchObject({ status: 'completed', at: 1_000, wroteProfile: true })
    expect(await state()).toEqual({ ...DEFAULT_APP_STATE, firstLaunchCompletedAt: 1_000 })
  })

  it('a user file without a profile gets one through the injected writer', async () => {
    await writeFile(paths().userConfig, '{ "ui": { "theme": "dark" } }')
    const { writes } = await run({ claude: READY, codex: READY })
    expect(writes).toEqual(['balanced'])
  })

  it('never overwrites a profile already in the user file (even an unknown one)', async () => {
    await writeFile(paths().userConfig, '{\n  // mine\n  "profile": "thorough"\n}\n')
    const { out, writes } = await run({ claude: READY, codex: DOWN })
    expect(writes).toEqual([])
    expect(out).toMatchObject({ status: 'completed', wroteProfile: false, userProfile: 'thorough' })
    expect(await readFile(paths().userConfig, 'utf8')).toBe('{\n  // mine\n  "profile": "thorough"\n}\n')

    await writeFile(paths().state, JSON.stringify({ schemaVersion: 1 }))
    await writeFile(paths().userConfig, '{ "profile": "my-own", "aut": true }')
    const again = await run({ claude: READY, codex: READY })
    expect(again.writes).toEqual([])
    expect(again.out).toMatchObject({ status: 'completed', userProfile: 'my-own' })
  })

  it('runs once: a recorded firstLaunchCompletedAt is never overwritten', async () => {
    await run({ claude: READY, codex: READY }, 1_000)
    await writeFile(paths().userConfig, '{}')
    const second = await run({ claude: DOWN, codex: READY }, 2_000)
    expect(second.out).toEqual({ status: 'already-done', at: 1_000 })
    expect(second.writes).toEqual([])
    expect((await state())['firstLaunchCompletedAt']).toBe(1_000)
  })

  it('preserves other state.json fields', async () => {
    await writeFile(
      paths().state,
      JSON.stringify({
        schemaVersion: 1,
        setupDismissed: true,
        futureField: 'x',
        firstLaunchCompletedAt: null,
      }),
    )
    await run({ claude: READY, codex: READY }, 5)
    expect(await state()).toMatchObject({ setupDismissed: true, futureField: 'x', firstLaunchCompletedAt: 5 })
  })

  it('defers when no vendor is ready (balanced, Run disabled) and when the user file is broken', async () => {
    const none = await run({ claude: DOWN, codex: DOWN })
    expect(none.out).toMatchObject({
      status: 'deferred',
      reason: 'no-vendor-ready',
      selection: { profile: 'balanced', runnable: false },
    })
    expect(none.writes).toEqual([])
    await expect(readFile(paths().state, 'utf8')).rejects.toThrow()

    await writeFile(paths().userConfig, '{ "ui": ')
    const broken = await run({ claude: READY, codex: READY })
    expect(broken.out).toMatchObject({ status: 'deferred', reason: 'user-config-invalid' })
    expect(broken.writes).toEqual([])

    // Once a vendor is ready and the file is fixed, it completes.
    await writeFile(paths().userConfig, '{}')
    expect((await run({ claude: READY, codex: DOWN })).writes).toEqual(['claude-only'])
  })

  it('a state.json from a newer Dim Factory is left alone', async () => {
    await writeFile(paths().state, JSON.stringify({ schemaVersion: 2 }))
    const r = await run({ claude: READY, codex: READY })
    expect(r.out).toMatchObject({ status: 'deferred', reason: 'state-read-only' })
    expect(r.writes).toEqual([])
    expect(await state()).toEqual({ schemaVersion: 2 })
  })
})

describe('criticSwapSuggestion', () => {
  const cfg = (profile: string, edit?: (c: ResolvedConfig) => void): ResolvedConfig => {
    const c = resolveBuiltinConfig({ profile })
    edit?.(c)
    return c
  }
  const ready = (...ids: string[]) => ids.map((id) => ({ id, supportsReadonly: true }))

  it('Critic on Implement’s vendor + another ready read-only vendor → suggest it', () => {
    expect(criticSwapSuggestion(cfg('claude-only'), ready('claude', 'codex'))).toEqual({ to: 'codex' })
    expect(criticSwapSuggestion(cfg('codex-only'), ready('codex', 'claude', 'gemini'))).toEqual({
      to: 'claude',
    })
  })

  it('no suggestion when vendors already differ, no other vendor is ready, or it cannot run read-only', () => {
    expect(criticSwapSuggestion(cfg('balanced'), ready('claude', 'codex'))).toBeNull()
    expect(criticSwapSuggestion(cfg('claude-only'), ready('claude'))).toBeNull()
    expect(criticSwapSuggestion(cfg('claude-only'), [{ id: 'codex', supportsReadonly: false }])).toBeNull()
  })

  it('no suggestion when Critic or Implement is off', () => {
    expect(
      criticSwapSuggestion(
        cfg('claude-only', (c) => (c.passes.critic.enabled = false)),
        ready('codex'),
      ),
    ).toBeNull()
    expect(
      criticSwapSuggestion(
        cfg('claude-only', (c) => (c.passes.implement.enabled = false)),
        ready('codex'),
      ),
    ).toBeNull()
  })

  it('compares registry ids when given a resolver (a local preset runs on Codex)', () => {
    const c = cfg('codex-only', (x) => (x.passes.critic.vendor = 'local-qwen'))
    const resolveId = (v: string): string => (v.startsWith('local-') ? 'codex' : v)
    expect(criticSwapSuggestion(c, ready('codex', 'claude'), { resolveId })).toEqual({ to: 'claude' })
    expect(criticSwapSuggestion(c, ready('codex', 'claude'))).toBeNull()
  })
})
