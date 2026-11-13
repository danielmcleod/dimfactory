// The self-heal and catalog-refresh choices stay honest with a third vendor (self-heal
// "Execution": the selfHeal vendor, falling back to the first ready of claude/codex, with a Claude row and a Codex row
// only; the refresh job: Claude and Codex, official sources google → ai.google.dev, cloud.google.com):
//   - a built and ready Gemini never runs the healer, even as `selfHeal.vendor`: Claude (or Codex) does, with its own
//     default model; with only Gemini ready the heal fails with the install docs
//   - Gemini cannot refresh prices: a request naming it is refused, a configured Gemini falls back to Claude with a
//     note, and Gemini's prices are still refreshed (by Claude) from Google's official pages
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'
import { HEAL_VENDORS } from '@shared/vendors.ts'
import { AdapterRegistry } from '@core/adapters/registry.ts'
import { BufferedEmitter } from '@core/adapters/errors.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions } from '@core/adapters/types.ts'
import { CatalogJobs, REFRESH_VENDORS } from '@core/catalog/refresh-jobs.ts'
import type { RefreshSettings } from '@core/catalog/refresh-jobs.ts'
import { officialHosts } from '@core/catalog/sources.ts'
import type { HealerDeps, HealRequest } from '@core/heal/healer.ts'
import { runHealer } from '@core/heal/healer.ts'
import { ScriptedGemini, geminiProbe } from './helpers.ts'
import {
  ScriptedAdapter as RefreshAdapter,
  hangs,
  home,
  seedCatalog,
} from '../../catalog-refresh/job/helpers.ts'

const ANSWER = [
  '```json',
  JSON.stringify({
    diagnosis: 'The CLI is logged out.',
    confidence: 'high',
    category: 'auth_required',
    actions: [],
  }),
  '```',
].join('\n')

class Handle implements RunHandle {
  readonly id = 'h'
  readonly route = 'stdio' as const
  readonly pid = 1
  readonly events = new BufferedEmitter<NormalizedEvent>()
  readonly signals = new BufferedEmitter<AdapterSignal>()
  readonly exited: Promise<ExitInfo>
  readonly vendor: string
  #exit: (e: ExitInfo) => void = () => undefined
  constructor(vendor: string) {
    this.vendor = vendor
    this.exited = new Promise((r) => {
      this.#exit = r
    })
  }
  onEvent(cb: (e: NormalizedEvent) => void): () => void {
    return this.events.subscribe(cb)
  }
  onSignal(cb: (s: AdapterSignal) => void): () => void {
    return this.signals.subscribe(cb)
  }
  sessionId(): undefined {
    return undefined
  }
  cumulativeUsage(): undefined {
    return undefined
  }
  pendingAsks(): string[] {
    return []
  }
  exit(): void {
    this.#exit({ code: 0, signal: null, sawTerminal: true, ranMs: 5 })
  }
}

/** A Claude that answers the heal prompt with one diagnosis. */
function answeringClaude(ok = true): Adapter & { starts: StartOptions[] } {
  const starts: StartOptions[] = []
  return {
    id: 'claude',
    displayName: 'Claude',
    transport: 'claude-stdio',
    managedFlags: [],
    testedUpTo: '2.1.289',
    versionFloor: '2.1.281',
    versionRecommended: '2.1.287',
    starts,
    probe: () =>
      Promise.resolve({ vendor: 'claude', at: 0, ok, checks: [], capabilities: {} as never, models: [] }),
    readiness: () => Promise.resolve([]),
    support: () => ({ status: 'supported', copy: '' }),
    canResume: () => Promise.resolve({ ok: false }),
    start(o: StartOptions): RunHandle {
      starts.push(o)
      const h = new Handle('claude')
      queueMicrotask(() => {
        h.events.emit({ type: 'session', id: 's' })
        h.events.emit({ type: 'done', result: ANSWER })
        h.exit()
      })
      return h
    },
    answer: () => {},
    stop: () => Promise.resolve(),
    listModels: () => Promise.resolve([]),
  }
}

const request: HealRequest = {
  runId: 'r-1',
  step: 'review',
  failure: { category: 'unknown', message: 'gemini exited with code 1', raw: '', classifiedBy: 'heuristic' },
  trigger: 'auto',
  vendor: 'gemini',
  vendorVersion: '0.62.0',
  passArgv: ['--acp'],
  tail: [],
}

function healDeps(registry: AdapterRegistry, vendor: string, model: string | null): HealerDeps {
  return {
    home: mkdtempSync(join(tmpdir(), 'heal-home-')),
    registry,
    selfHeal: { enabled: true, vendor, model, autoApplyConfigPatches: false },
    env: () =>
      Promise.resolve({
        os: 'win32',
        osRelease: '10.0.26200',
        arch: 'x64',
        shell: 'PowerShell',
        node: '24.19.0',
        git: '2.55.0',
      }),
    cache: null,
    redact: { mode: 'heal', home: '/home/tester' },
    platform: 'win32',
  }
}

describe('self-heal never runs on Gemini (it has rows for Claude and Codex only)', () => {
  it('HEAL_VENDORS is Claude and Codex', () => {
    expect(HEAL_VENDORS).toEqual(['claude', 'codex'])
  })

  it('selfHeal.vendor = gemini (built and ready): Claude diagnoses, with its own default model', async () => {
    const claude = answeringClaude()
    const gemini = new ScriptedGemini(() => {
      throw new Error('Gemini must not run the healer')
    })
    const registry = new AdapterRegistry()
    registry.register(claude)
    registry.register(gemini)
    const out = await runHealer(healDeps(registry, 'gemini', 'gemini-3-pro-preview'), request)
    expect(out.status).toBe('ok')
    expect(gemini.starts).toEqual([])
    expect(gemini.probes).toBe(0)
    expect(claude.starts).toHaveLength(1)
    expect(claude.starts[0]?.model).toBeNull()
  })

  it('only Gemini ready: the heal fails ("No AI vendor is ready") instead of running on Gemini', async () => {
    const gemini = new ScriptedGemini(() => {
      throw new Error('Gemini must not run the healer')
    })
    const registry = new AdapterRegistry()
    registry.register(answeringClaude(false))
    registry.register(gemini)
    const out = await runHealer(healDeps(registry, 'gemini', null), request)
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/^No AI vendor is ready to diagnose this\./)
    expect(gemini.starts).toEqual([])
  })
})

describe('Gemini cannot refresh prices; its prices are refreshed by Claude', () => {
  const NOW = 1_791_500_000_000
  async function jobs(settings: Partial<RefreshSettings>) {
    const claude = new RefreshAdapter(hangs)
    const gemini = new ScriptedGemini(() => {
      throw new Error('Gemini must not run a refresh')
    })
    const catalog = await seedCatalog()
    let t = NOW
    const j = new CatalogJobs({
      home: home(),
      adapter: (v) => (v === 'claude' ? claude : v === 'gemini' ? gemini : undefined),
      settings: () =>
        Promise.resolve({
          refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' },
          vendors: ['claude'],
          ...settings,
        }),
      catalog: () => catalog,
      status: () =>
        Promise.resolve({
          pricingUpdatedAt: 1,
          confidence: 'unverified',
          stale: false,
          refreshDue: true,
          jobRunning: false,
          schedule: {
            enabled: true,
            intervalDays: 14,
            lastRefreshAt: null,
            snoozedUntil: null,
            nextDueAt: NOW,
          },
        }),
      price: () => ({ missing: 'x' }),
      emit: () => {},
      buildDiff: (i) => ({
        jobId: i.jobId,
        generatedAt: i.at,
        vendor: i.vendor,
        model: i.model,
        rows: [],
        rejected: i.rejected,
        unverifiable: i.proposal.unverifiable,
      }),
      now: () => (t += 1000),
    })
    return { j, claude, gemini }
  }

  it('REFRESH_VENDORS stays Claude and Codex', () => {
    expect(REFRESH_VENDORS).toEqual(['claude', 'codex'])
  })

  it('a request naming Gemini is refused before any job', async () => {
    const w = await jobs({})
    await expect(w.j.start({ vendor: 'gemini' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: 'Gemini cannot refresh prices. Claude or Codex does.',
    })
    expect(w.gemini.starts).toEqual([])
  })

  it('a configured Gemini falls back to Claude with the reason; Google’s official pages are in scope', async () => {
    const w = await jobs({
      refresh: { enabled: true, intervalDays: 14, vendor: 'gemini', model: 'gemini-3-pro-preview' },
      vendors: ['claude', 'gemini'],
    })
    const plan = await w.j.plan()
    expect(plan).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
      fallbackNote: 'Gemini cannot refresh prices. Claude refreshes the prices instead.',
      vendors: ['claude', 'gemini'],
    })
    expect(plan.hosts).toEqual(officialHosts(['claude', 'gemini']))
    expect(plan.hosts).toEqual(expect.arrayContaining(['ai.google.dev', 'cloud.google.com']))
    expect(plan.fallbackNote).not.toContain('—')
    expect(w.gemini.starts).toEqual([])
    // The Gemini stand-in's probe shape is never asked for here (no Gemini process for a refresh).
    expect(geminiProbe().vendor).toBe('gemini')
  })
})
