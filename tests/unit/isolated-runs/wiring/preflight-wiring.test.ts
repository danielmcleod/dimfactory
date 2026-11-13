// Integration fixes (composer "In place | Isolated run (warns about uncommitted changes)", isolated runs do
// not mirror uncommitted changes; run.isolation.worktree and run.deps; "Auto never implies trust").
//   - run.isolation.worktree's pass states how many uncommitted changes an isolated run leaves out, in the words the
//     composer reads ("3 uncommitted changes not included").
//   - run.deps in Auto says what the engine does with no `deps` grant: the depsConsent card's default, Skip install.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { trustGrantsFor } from '@core/config/trust.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'
import { uncommittedNote } from '@core/preflight/checks/run.ts'
import { readDepsFacts } from '@core/prepare/facts.ts'
import { depsConsentCard, DEPS_CHOICE } from '@core/supervisor/cards.ts'
import { healthyChecks, healthyDeps, probeResult } from '../../preflight/helpers.ts'

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-wiring-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  for (const d of [folder, home]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const one = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)

function config(over: Record<string, unknown> = {}, auto = false): ResolvedConfig {
  return resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { isolation: { mode: 'worktree' }, auto, ...over },
  })
}

async function preflight(cfg: ResolvedConfig, over: Partial<PreflightDeps> = {}): Promise<PreflightReport> {
  const engine = createPreflightEngine(
    healthyDeps({
      home,
      platform: process.platform,
      trustGrants: (f) => trustGrantsFor(f, { home, folderScope: { scopeRoot: f } }),
      ...over,
    }),
  )
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  return engine.run('live', { folder, config: cfg })
}

/** The composer's reader (src/renderer/src/components/run/isolation.ts uncommittedCount), as a pattern. */
const COMPOSER_COUNT = /(\d[\d,]*)\s+uncommitted\s+change/i

describe('run.isolation.worktree states the uncommitted changes an isolated run leaves out', () => {
  for (const [n, words] of [
    [3, '3 uncommitted changes not included'],
    [1, '1 uncommitted change not included'],
    [0, '0 uncommitted changes'],
  ] as const) {
    it(`${n}: "${words}", which the composer reads back as ${n}`, async () => {
      const r = await preflight(config(), {
        worktreeEligibility: () => Promise.resolve({ ok: true, reasons: [], uncommitted: n }),
      })
      const c = one(r, 'run.isolation.worktree')
      expect(c).toMatchObject({ status: 'pass', blocking: false })
      expect(c?.detail).toContain(words)
      expect(c?.detail).toContain(uncommittedNote(n))
      expect(Number(COMPOSER_COUNT.exec(`${c?.title ?? ''} ${c?.detail ?? ''}`)?.[1])).toBe(n)
    })
  }

  it('without a count (an older core or a read that failed) it says nothing about one', async () => {
    const r = await preflight(config(), {
      worktreeEligibility: () => Promise.resolve({ ok: true, reasons: [] }),
    })
    expect(COMPOSER_COUNT.test(one(r, 'run.isolation.worktree')?.detail ?? '')).toBe(false)
  })
})

describe('run.deps in Auto matches the engine: no grant means Skip install', () => {
  it("says the install is skipped (depsConsent's default) rather than that the run waits", async () => {
    writeFileSync(join(folder, 'install.mjs'), "console.log('ok')\n")
    const cfg = config(
      { isolation: { mode: 'worktree', worktree: { installCommand: ['node', 'install.mjs'] } } },
      true,
    )
    const r = await preflight(cfg, {
      depsFacts: (f, c) =>
        readDepsFacts(f, c, {
          scopeRoot: f,
          grants: () => trustGrantsFor(f, { home, folderScope: { scopeRoot: f } }),
        }),
    })
    const deps = one(r, 'run.deps')
    expect(deps).toMatchObject({ status: 'warn', blocking: false })
    expect(deps?.detail).toContain('skips `node install.mjs`')
    expect(deps?.detail).not.toContain('waits for your answer')
    // The engine's card: Auto takes its default, Skip install.
    const card = depsConsentCard('c1', {
      deps: { manager: 'custom', argv: ['node', 'install.mjs'], cwdRel: '.', source: 'config' },
      trust: 'untrusted',
    })
    expect(card.defaultChoice).toBe(DEPS_CHOICE.skipInstall)
  })
})

describe('folder.lock: an isolated run does not queue behind the run holding the folder', () => {
  const holder = (): Promise<{ runId: string; displayNo: number; status: 'running'; since: number }> =>
    Promise.resolve({ runId: 'r3', displayNo: 3, status: 'running', since: Date.now() })

  it('isolated: "Runs alongside run #3" (the composer shows Run, not Queue)', async () => {
    const r = await preflight(config(), { lockQuery: holder })
    const c = one(r, 'folder.lock')
    expect(c?.status).toBe('pass')
    expect(c?.title).toMatch(/^Runs alongside run #3 \(running/)
    expect(c?.title).not.toMatch(/queues behind/i)
    expect(c?.detail).toContain('applying its changes to the folder waits until the folder is free')
  })

  it('in place: still "Queues behind run #3"', async () => {
    const r = await preflight(config({ isolation: { mode: 'inPlace' } }), { lockQuery: holder })
    expect(one(r, 'folder.lock')?.title).toMatch(/^Queues behind run #3/)
  })
})
