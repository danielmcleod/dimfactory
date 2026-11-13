// Refresh job lifecycle (consent card ~time and ≈cost, the job; the consent card):
// catalog.refreshPlan's numbers (priors, then the median of past refreshes), the vendor choice (Claude; Codex
// once it is built and ready, tests/unit/balanced/engine), one job at a time, the `catalog` AppEvents, Cancel, a job a
// closed Dim Factory left running, and the job folders kept.
import { existsSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CatalogDiff, CatalogStatus } from '../../../../src/shared/catalog.ts'
import { catalogCostUsd } from '../../../../src/core/catalog/cost.ts'
import {
  CatalogJobs,
  REFRESH_COPY,
  REFRESH_JOBS_KEPT,
  REFRESH_PRIOR_MS,
  REFRESH_PRIOR_USAGE,
  newJobId,
} from '../../../../src/core/catalog/refresh-jobs.ts'
import type {
  CatalogJobEvent,
  CatalogJobsDeps,
  RefreshSettings,
} from '../../../../src/core/catalog/refresh-jobs.ts'
import { readJobStatus, refreshJobDir, writeJobStatus } from '../../../../src/core/catalog/refresh.ts'
import type { RefreshJobStatus } from '../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../src/core/catalog/sources.ts'
import { DimFactoryError } from '../../../../src/core/errors.ts'
import { PROPOSAL, ScriptedAdapter, answersStructured, hangs, home, seedCatalog } from './helpers.ts'
import type { Script } from './helpers.ts'

const SONNET = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 4 }
const NOW = 1_791_500_000_000

const STATUS: CatalogStatus = {
  pricingUpdatedAt: 1_791_158_400_000,
  confidence: 'unverified',
  stale: false,
  refreshDue: true,
  jobRunning: false,
  schedule: {
    enabled: true,
    intervalDays: 14,
    lastRefreshAt: 1_790_000_000_000,
    snoozedUntil: null,
    nextDueAt: NOW,
  },
}

interface World {
  jobs: CatalogJobs
  adapter: ScriptedAdapter
  events: CatalogJobEvent[]
  diffs: unknown[]
}

async function world(
  script: Script,
  o: { settings?: Partial<RefreshSettings>; deps?: Partial<CatalogJobsDeps> } = {},
): Promise<World> {
  const adapter = new ScriptedAdapter(script)
  const events: CatalogJobEvent[] = []
  const diffs: unknown[] = []
  const catalog = await seedCatalog()
  let t = NOW
  const jobs = new CatalogJobs({
    home: home(),
    adapter: (v) => (v === 'claude' ? adapter : undefined),
    settings: () =>
      Promise.resolve({
        refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' },
        vendors: ['claude'],
        ...o.settings,
      }),
    catalog: () => catalog,
    status: () => Promise.resolve(STATUS),
    price: (_v, model) =>
      model === 'sonnet'
        ? { rates: SONNET, reasoningIncludedInOutput: true }
        : { missing: `claude/${model}` },
    emit: (ev) => events.push(ev),
    buildDiff: (i) => {
      diffs.push(i)
      const diff: CatalogDiff = {
        jobId: i.jobId,
        generatedAt: i.at,
        vendor: i.vendor,
        model: i.model,
        rows: [],
        rejected: i.rejected,
        unverifiable: i.proposal.unverifiable,
      }
      return diff
    },
    now: () => (t += 1000),
    ...o.deps,
  })
  return { jobs, adapter, events, diffs }
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const finished = async (id: string, s: Partial<RefreshJobStatus>): Promise<void> => {
  mkdirSync(refreshJobDir(home(), id), { recursive: true })
  await writeJobStatus(home(), {
    schemaVersion: 1,
    id,
    state: 'diff-ready',
    vendor: 'claude',
    model: 'sonnet',
    startedAt: 1,
    ...s,
  })
}

describe('catalog.refreshPlan', () => {
  it('before any refresh: the priors, priced at the refresh model, and what the job may do', async () => {
    const { jobs, adapter } = await world(hangs)
    const plan = await jobs.plan()
    expect(plan).toEqual({
      vendor: 'claude',
      model: 'sonnet',
      estDurationMs: REFRESH_PRIOR_MS,
      estCostUsd: catalogCostUsd(REFRESH_PRIOR_USAGE, SONNET, true),
      lastRefreshAt: STATUS.schedule.lastRefreshAt,
      due: true,
      vendorName: 'Claude',
      copy: REFRESH_COPY,
      vendors: ['claude'],
      hosts: officialHosts(['claude']),
      // Claude's refresh reads pages only on those hosts.
      hostsConfined: true,
      estSamples: 0,
      apiEquivalent: false,
    })
    expect(plan.estDurationMs).toBe(240_000)
    expect(plan.estCostUsd).toBeCloseTo(0.224, 10)
    expect(REFRESH_COPY).toBe('Read-only, web search, cannot change files.')
    // The plan never starts anything.
    expect(adapter.starts).toEqual([])
  })

  it('after three finished refreshes: their median time and cost', async () => {
    await finished('20261001T000000Z-0001', { ranMs: 100_000, costUsd: 0.1 })
    await finished('20261002T000000Z-0002', { ranMs: 300_000, costUsd: 0.3, state: 'applied' })
    await finished('20261003T000000Z-0003', { ranMs: 200_000, costUsd: 0.2 })
    // Not counted: failed, another vendor, no duration.
    await finished('20261004T000000Z-0004', { ranMs: 900_000, costUsd: 9, state: 'failed' })
    await finished('20261005T000000Z-0005', { ranMs: 900_000, costUsd: 9, vendor: 'codex' })
    await finished('20261006T000000Z-0006', { costUsd: 9 })
    const { jobs } = await world(hangs)
    expect(await jobs.plan()).toMatchObject({ estDurationMs: 200_000, estCostUsd: 0.2, estSamples: 3 })
  })

  it('two refreshes are not enough history; no price for the model leaves the cost unknown', async () => {
    await finished('20261001T000000Z-0001', { ranMs: 100_000, costUsd: 0.1 })
    await finished('20261002T000000Z-0002', { ranMs: 300_000, costUsd: 0.3 })
    const { jobs } = await world(hangs, {
      settings: { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'opus-x' } },
    })
    expect(await jobs.plan()).toMatchObject({
      model: 'opus-x',
      estDurationMs: REFRESH_PRIOR_MS,
      estCostUsd: null,
      estSamples: 0,
    })
  })

  it('with the CLI default as the model, the plan names the default it prices', async () => {
    const settings = { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: null } }
    const { jobs } = await world(hangs, {
      settings,
      deps: {
        defaultModel: (v) => (v === 'claude' ? 'claude-opus-5-5' : null),
        price: (_v, model) =>
          model === null ? { rates: SONNET, reasoningIncludedInOutput: true } : { missing: 'x' },
      },
    })
    const plan = await jobs.plan()
    expect(plan).toMatchObject({ model: null, defaultModel: 'claude-opus-5-5' })
    expect(plan.estCostUsd).not.toBeNull()
    // A named model needs no default; a core that does not know the default leaves it out.
    expect((await (await world(hangs)).jobs.plan()).defaultModel).toBeUndefined()
    const unknown = await world(hangs, { settings, deps: { defaultModel: () => null } })
    expect('defaultModel' in (await unknown.jobs.plan())).toBe(false)
  })

  it('Codex as the configured vendor: Claude runs it, and the card says why', async () => {
    // Codex can refresh (X17) once built and ready; this world has no Codex adapter, so Claude still runs it.
    const { jobs } = await world(hangs, {
      settings: {
        refresh: { enabled: true, intervalDays: 14, vendor: 'codex', model: 'gpt-5.6-sol' },
        vendors: ['claude', 'codex'],
      },
    })
    const plan = await jobs.plan()
    expect(plan).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
      fallbackNote: 'Codex is not available in this build. Claude refreshes the prices instead.',
      vendors: ['claude', 'codex'],
      hosts: officialHosts(['claude', 'codex']),
    })
    expect(plan.fallbackNote).not.toContain('\u2014')
  })
})

describe('starting, finishing and cancelling a refresh', () => {
  it('runs one job: running with progress, then diff-ready with the diff', async () => {
    const w = await world(answersStructured())
    const { jobId } = await w.jobs.start()
    expect(jobId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{4}$/)
    expect(w.events[0]).toEqual({ kind: 'catalog', state: 'running', jobId, progress: 'Starting Claude' })
    await until(() => w.events.some((e) => e.state === 'diff-ready'))
    expect(w.events.map((e) => [e.state, e.progress])).toEqual([
      ['running', 'Starting Claude'],
      ['running', 'Searching the web'],
      ['running', 'Reading platform.claude.com'],
      ['running', 'Writing the price list'],
      ['diff-ready', undefined],
    ])
    expect(w.events.at(-1)?.diff).toMatchObject({ jobId, vendor: 'claude', model: 'sonnet' })
    expect(w.diffs).toEqual([
      expect.objectContaining({ jobId, proposal: PROPOSAL, rejected: [], vendors: ['claude'] }),
    ])
    expect(w.jobs.running()).toBe(false)
    expect(w.jobs.current()).toMatchObject({ id: jobId, state: 'diff-ready', diff: { jobId } })
    expect(w.jobs.current()).not.toHaveProperty('progress')
    expect(w.adapter.starts[0]).toMatchObject({ step: 'catalog', model: 'sonnet', runId: jobId })
  })

  it('a second start while one runs is CONFLICT and spawns nothing', async () => {
    const w = await world(hangs)
    const { jobId } = await w.jobs.start()
    const second = w.jobs.start()
    await expect(second).rejects.toMatchObject({ code: 'CONFLICT', details: { jobId } })
    expect((await w.jobs.plan()).runningJobId).toBe(jobId)
    await until(() => w.adapter.starts.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(w.adapter.starts).toHaveLength(1)
    await w.jobs.cancel(jobId)
  })

  it('Cancel stops the process and the job reads cancelled; a later cancel is a no-op; an unknown id NOT_FOUND', async () => {
    const w = await world(hangs)
    const { jobId } = await w.jobs.start()
    await until(() => w.adapter.starts.length === 1)
    await w.jobs.cancel(jobId)
    expect(w.adapter.handles[0]?.stopped).toEqual(['user'])
    expect(w.events.at(-1)).toEqual({ kind: 'catalog', state: 'cancelled', jobId })
    expect(w.jobs.current()).toMatchObject({
      id: jobId,
      state: 'cancelled',
      error: 'You cancelled the price refresh.',
    })
    expect(await readJobStatus(home(), jobId)).toMatchObject({ state: 'cancelled' })
    await expect(w.jobs.cancel(jobId)).resolves.toBeUndefined()
    await expect(w.jobs.cancel('20200101T000000Z-dead')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A new job can start once it ended.
    w.adapter.script = answersStructured()
    await w.jobs.start()
  })

  it('a failure is the failed event with its reason', async () => {
    const w = await world((h) => {
      queueMicrotask(() => {
        h.events.emit({
          type: 'error',
          message: 'Claude Code is not logged in.',
          raw: '',
          fatal: true,
          category: 'auth_required',
        })
        h.exit(1)
      })
    })
    const { jobId } = await w.jobs.start()
    await until(() => w.events.some((e) => e.state === 'failed'))
    expect(w.events.at(-1)).toEqual({
      kind: 'catalog',
      state: 'failed',
      jobId,
      error: 'Claude Code is not logged in.',
    })
    expect(await readJobStatus(home(), jobId)).toMatchObject({ state: 'failed', category: 'auth_required' })
  })

  it('refuses a vendor that cannot refresh, and a missing catalog, before any job', async () => {
    const w = await world(hangs)
    // Codex is a refresh vendor (X17), but this world has no Codex adapter.
    await expect(w.jobs.start({ vendor: 'codex' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: 'Codex is not available in this build.',
    })
    const noCatalog = await world(hangs, { deps: { catalog: () => undefined } })
    await expect(noCatalog.jobs.start()).rejects.toBeInstanceOf(DimFactoryError)
    const noAdapter = await world(hangs, { deps: { adapter: () => undefined } })
    await expect(noAdapter.jobs.start()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(w.adapter.starts).toEqual([])
    expect(w.events).toEqual([])
  })

  it('a request may name the model (null: the CLI default)', async () => {
    const w = await world(answersStructured())
    await w.jobs.start({ model: null })
    await until(() => w.adapter.starts.length === 1)
    expect(w.adapter.starts[0]?.model).toBeNull()
  })

  it('shutdown stops a running job', async () => {
    const w = await world(hangs)
    const { jobId } = await w.jobs.start()
    await until(() => w.adapter.starts.length === 1)
    await w.jobs.dispose()
    expect(w.adapter.handles[0]?.stopped).toEqual(['shutdown'])
    expect(await readJobStatus(home(), jobId)).toMatchObject({
      state: 'cancelled',
      error: 'Dim Factory closed during the price refresh.',
    })
  })
})

describe('job folders', () => {
  it('a job a closed Dim Factory left running is marked failed at boot and shown as the newest', async () => {
    await finished('20261001T000000Z-0001', { ranMs: 1000 })
    await finished('20261002T000000Z-0002', { state: 'running' })
    const { jobs } = await world(hangs)
    await jobs.init()
    expect(await readJobStatus(home(), '20261002T000000Z-0002')).toMatchObject({
      state: 'failed',
      error: 'Dim Factory closed while this price refresh was running.',
    })
    expect(jobs.current()).toMatchObject({ id: '20261002T000000Z-0002', state: 'failed' })
  })

  it(`keeps the newest ${REFRESH_JOBS_KEPT} job folders`, async () => {
    for (let i = 0; i < REFRESH_JOBS_KEPT + 3; i++) {
      await finished(`20260901T0000${String(i).padStart(2, '0')}Z-0000`, { ranMs: 1000 })
    }
    const w = await world(answersStructured())
    const { jobId } = await w.jobs.start()
    await until(() => w.events.some((e) => e.state === 'diff-ready'))
    // The prune removes the oldest folders newest first, so the oldest one goes last.
    await until(() => !existsSync(refreshJobDir(home(), '20260901T000000Z-0000')))
    expect(existsSync(refreshJobDir(home(), '20260901T000003Z-0000'))).toBe(false)
    expect(existsSync(refreshJobDir(home(), '20260901T000004Z-0000'))).toBe(true)
    expect(existsSync(refreshJobDir(home(), jobId))).toBe(true)
  })

  it('job ids sort by start time', () => {
    expect(newJobId(Date.UTC(2026, 9, 9, 9, 14, 2))).toMatch(/^20261009T091402Z-[0-9a-f]{4}$/)
  })
})
