// X17: the catalog refresh on Codex (the refresh job: "Codex: read-only, ephemeral,
// config:{web_search:'live'} + outputSchema (X17)").
// The job starts Codex with the same read-only StartOptions as Claude (step `catalog`, ephemeral, the schema, the job
// folder as cwd; the adapter turns them into thread/start `config.web_search` and turn/start `outputSchema`), reads
// the answer from the structured-output signal or the final message, and counts only the pages Codex opened as read.
// CatalogJobs picks Codex only while it is ready: otherwise Claude refreshes, and the card says why.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CodexNormalizer } from '@core/adapters/codex/normalize.ts'
import { META_PAGES_READ, META_STRUCTURED_OUTPUT } from '@core/adapters/types.ts'
import type { Adapter } from '@core/adapters/types.ts'
import { CatalogJobs, REFRESH_VENDORS } from '@core/catalog/refresh-jobs.ts'
import type { CatalogJobEvent, RefreshReadiness, RefreshSettings } from '@core/catalog/refresh-jobs.ts'
import {
  JOB_FILES,
  fetchedHostOf,
  pageHostsOf,
  readJobStatus,
  refreshFlagMap,
  refreshJobDir,
  refreshJsonSchema,
  runRefreshJob,
} from '@core/catalog/refresh.ts'
import { officialHosts } from '@core/catalog/sources.ts'
import { healerFlagMap } from '@core/heal/healer.ts'
import { homePaths } from '@core/home.ts'
import type { CatalogStatus } from '@shared/catalog.ts'
import { ADAPTER_SIGNAL_TYPES } from '@shared/events.ts'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'
import { ScriptedAdapter, hangs, home, seedCatalog } from '../../catalog-refresh/job/helpers.ts'
import { ScriptedCodex } from './helpers.ts'
import type { CodexScript } from './helpers.ts'

const JOB = '20261009T101500Z-cx17'
const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing'
const EM_DASH = '—'

const CODEX_PROPOSAL = {
  generatedAt: '2026-10-09T10:15:00Z',
  entries: [
    {
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      aliases: [],
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 5,
      sourceUrl: OPENAI_PRICING,
      sourceQuote: 'gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00',
    },
  ],
  newModels: [],
  unverifiable: [],
}

const webTool = (id: string, summary: string, phase: 'start' | 'end'): NormalizedEvent =>
  phase === 'start'
    ? { type: 'tool', id, name: 'webSearch', summary, phase }
    : { type: 'tool', id, name: 'webSearch', summary, phase, status: 'ok' }

/** Codex's shape: a thread, a search, an opened page, then the answer (structured signal and/or the message). */
const codexAnswers =
  (o: { structured?: boolean; text?: string } = {}): CodexScript =>
  (h) => {
    queueMicrotask(() => {
      h.events.emit({ type: 'session', id: 'thr_x17' })
      h.events.emit(webTool('w1', 'openai api pricing gpt-5.6', 'start'))
      h.events.emit(webTool('w1', 'openai api pricing gpt-5.6', 'end'))
      h.events.emit(webTool('w2', OPENAI_PRICING, 'start'))
      h.events.emit(webTool('w2', OPENAI_PRICING, 'end'))
      const text = o.text ?? JSON.stringify(CODEX_PROPOSAL)
      if (o.structured !== false)
        h.signals.emit({ type: 'meta', key: META_STRUCTURED_OUTPUT, value: CODEX_PROPOSAL })
      h.events.emit({ type: 'text', delta: text })
      h.events.emit({
        type: 'done',
        result: text,
        usage: { input: 30_000, output: 3_000, cacheRead: 90_000, reasoning: 1_000 },
      })
      h.exit(0)
    })
  }

const req = { jobId: JOB, vendor: 'codex', model: null, today: '2026-10-09' } as const

// Made from the first live X17 (kept as evidence when X17 was re-recorded for the read-only feature switches): its
// opened pages span two hosts, one of them named only in an item's results.
const X17 = fileURLToPath(
  new URL('../../../fixtures/codex-evidence/X17-catalog-refresh-two-hosts/recording.jsonl', import.meta.url),
)
const SIGNAL_TYPES: ReadonlySet<string> = new Set(ADAPTER_SIGNAL_TYPES)
const isSignal = (e: NormalizedEvent | AdapterSignal): e is AdapterSignal => SIGNAL_TYPES.has(e.type)

/** The live X17 recording's server frames through the real Codex normalizer, in order (liveness left out). */
function liveX17(): (NormalizedEvent | AdapterSignal)[] {
  const n = new CodexNormalizer({
    step: 'catalog',
    mode: 'readonly',
    cwd: '<CWD>',
    planNative: false,
    resumed: false,
    askTimeoutMs: 600_000,
    allowRules: [],
    structured: true,
    loopback: false,
    now: () => 0,
  })
  const out: (NormalizedEvent | AdapterSignal)[] = []
  const frames = readFileSync(X17, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l) as { dir: string; line?: string })
  for (const f of frames) {
    if (f.dir !== 'out' || f.line === undefined) continue
    const m = JSON.parse(f.line) as {
      id?: unknown
      method?: string
      params?: unknown
      result?: { thread?: { id?: string } }
    }
    const step =
      typeof m.result?.thread?.id === 'string'
        ? n.session(m.result.thread.id)
        : typeof m.method === 'string' && !('id' in m)
          ? n.notification(m.method, m.params)
          : undefined
    if (step !== undefined) out.push(...step.signals, ...step.events)
  }
  return out.filter((e) => e.type !== 'liveness')
}

describe('runRefreshJob on Codex (X17)', () => {
  it('starts Codex read-only and ephemeral, with the schema, web access and the job folder as cwd', async () => {
    const codex = new ScriptedCodex(codexAnswers())
    const r = await runRefreshJob(
      {
        home: home(),
        adapter: codex,
        catalog: await seedCatalog(),
        vendors: ['codex', 'claude'],
        // A rename of a flag that keeps the job read-only never reaches it; the others do.
        flagMap: { '--sandbox': '--sandbox-mode', '--model': '--llm' },
        now: () => 1_791_500_000_000,
      },
      req,
    )
    if (!r.ok) throw new Error(r.failure.message)
    const o = codex.starts[0]!
    expect(o).toMatchObject({
      runId: JOB,
      step: 'catalog',
      mode: 'readonly',
      planNative: false,
      ephemeral: true,
      model: null,
      allowRules: [],
      trustFolder: false,
      web: { allowedDomains: officialHosts(['codex', 'claude']) },
      outputSchema: refreshJsonSchema(['codex', 'claude']),
      flagMap: { '--model': '--llm' },
    })
    expect(o.cwd).toBe(join(homePaths(home()).catalogJobsDir, JOB))
    expect(o).not.toHaveProperty('extraArgs')
    expect(o).not.toHaveProperty('sessionId')
    expect(o).not.toHaveProperty('resume')
    expect(o).not.toHaveProperty('local')
    // The prompt goes over JSON-RPC, never argv: it is only ever in StartOptions.prompt.
    expect(o.prompt).toContain('Today is 2026-10-09.')
  })

  it('reads the structured answer and counts the page Codex opened (not the search) as read', async () => {
    const codex = new ScriptedCodex(codexAnswers())
    const r = await runRefreshJob(
      { home: home(), adapter: codex, catalog: await seedCatalog(), vendors: ['codex'] },
      { ...req, jobId: `${JOB.slice(0, -4)}cx18` },
    )
    if (!r.ok) throw new Error(r.failure.message)
    expect(r.answerSource).toBe('structured_output')
    expect(r.fetchedHosts).toEqual(['developers.openai.com'])
    expect(r.proposal.entries.map((e) => [e.vendor, e.model, e.inputPerMTok])).toEqual([
      ['codex', 'gpt-5.6-sol', 4],
    ])
    const status = await readJobStatus(home(), `${JOB.slice(0, -4)}cx18`)
    expect(status).toMatchObject({
      state: 'diff-ready',
      vendor: 'codex',
      fetchedHosts: ['developers.openai.com'],
    })
  })

  it('without a structured signal, the final message (one JSON object, outputSchema) is the answer', async () => {
    const id = `${JOB.slice(0, -4)}cx19`
    const codex = new ScriptedCodex(codexAnswers({ structured: false }))
    const r = await runRefreshJob(
      { home: home(), adapter: codex, catalog: await seedCatalog(), vendors: ['codex'] },
      { ...req, jobId: id },
    )
    if (!r.ok) throw new Error(r.failure.message)
    expect(r.answerSource).toBe('message-json')
    const proposal = JSON.parse(
      readFileSync(join(refreshJobDir(home(), id), JOB_FILES.proposal), 'utf8'),
    ) as {
      entries: unknown[]
    }
    expect(proposal.entries).toHaveLength(1)
  })

  it('fetchedHostOf: a Codex web item counts only when its summary is the https page it opened', () => {
    const end = (name: string, summary: string, status: 'ok' | 'failed' = 'ok') =>
      ({ type: 'tool', name, summary, phase: 'end', status }) as Extract<NormalizedEvent, { type: 'tool' }>
    expect(fetchedHostOf(end('webSearch', OPENAI_PRICING), 'codex')).toBe('developers.openai.com')
    expect(fetchedHostOf(end('web_search', OPENAI_PRICING), 'codex')).toBe('developers.openai.com')
    expect(fetchedHostOf(end('webSearch', 'openai pricing'), 'codex')).toBeNull()
    expect(fetchedHostOf(end('webSearch', 'http://developers.openai.com/x'), 'codex')).toBeNull()
    expect(fetchedHostOf(end('webSearch', OPENAI_PRICING, 'failed'), 'codex')).toBeNull()
    expect(fetchedHostOf(end('commandExecution', OPENAI_PRICING), 'codex')).toBeNull()
    // Claude's rule is unchanged: a WebFetch, never a WebSearch.
    expect(fetchedHostOf(end('WebFetch', OPENAI_PRICING))).toBe('developers.openai.com')
    expect(fetchedHostOf(end('WebSearch', OPENAI_PRICING))).toBeNull()
  })

  it('live X17: every page Codex opened counts as read, the ones named only in its results too', async () => {
    // What the real normalizer makes of the live recording (codex-cli 0.160.1): two of its opened-page items name a
    // page only in `results` (action `other`, `findInPage` without a url), on two hosts.
    const id = `${JOB.slice(0, -4)}cx20`
    const live = liveX17()
    const codex = new ScriptedCodex((h) => {
      queueMicrotask(() => {
        for (const e of live) {
          if (isSignal(e)) h.signals.emit(e)
          else h.events.emit(e)
        }
        h.exit(0)
      })
    })
    const r = await runRefreshJob(
      { home: home(), adapter: codex, catalog: await seedCatalog(), vendors: ['codex'] },
      { ...req, jobId: id },
    )
    if (!r.ok) throw new Error(r.failure.message)
    expect(r.answerSource).toBe('structured_output')
    expect(r.fetchedHosts).toEqual(['developers.openai.com', 'openai.com'])
    // Every price the live answer sourced is on a host the job read (none would be confirmed otherwise).
    expect(r.proposal.entries).toHaveLength(4)
    for (const e of r.proposal.entries) expect(r.fetchedHosts).toContain(new URL(e.sourceUrl).hostname)
    expect(await readJobStatus(home(), id)).toMatchObject({
      fetchedHosts: ['developers.openai.com', 'openai.com'],
    })
  })

  it('fetchedHostOf and pageHostsOf: the first page before "(+N more)", then every https page of the signal', () => {
    const end = { type: 'tool', name: 'web_search', phase: 'end', status: 'ok' } as const
    expect(fetchedHostOf({ ...end, summary: `${OPENAI_PRICING} (+3 more)` }, 'codex')).toBe(
      'developers.openai.com',
    )
    const pages = (value: unknown): AdapterSignal => ({ type: 'meta', key: META_PAGES_READ, value })
    expect(
      pageHostsOf(
        pages({ id: 'w', urls: [OPENAI_PRICING, 'https://openai.com/index/x/', 'http://a.example/', 7] }),
      ),
    ).toEqual(['developers.openai.com', 'openai.com'])
    expect(pageHostsOf(pages({ id: 'w' }))).toEqual([])
    expect(
      pageHostsOf({ type: 'meta', key: META_STRUCTURED_OUTPUT, value: { urls: [OPENAI_PRICING] } }),
    ).toEqual([])
    expect(pageHostsOf({ type: 'liveness' })).toEqual([])
  })

  it('refreshFlagMap drops renames of Codex’s read-only flags too', () => {
    expect(
      refreshFlagMap({
        '--sandbox': '--x',
        '-s': '--v',
        '--ephemeral': '--y',
        '--ask-for-approval': '--z',
        '--config': '--w',
      }),
    ).toBeUndefined()
    // Other renames still reach the job (a renamed --model).
    expect(refreshFlagMap({ '--sandbox': '--x', '--model': '--llm' })).toEqual({ '--model': '--llm' })
  })

  it('the healer’s own spawn drops the same Codex renames (heal on Codex stays read-only)', () => {
    expect(healerFlagMap({ '--sandbox': '--x', '-s': '--v', '--ephemeral': '--y', '-m': '--mm' })).toEqual({
      '-m': '--mm',
    })
  })
})

// ---- the vendor choice -----------------------------------------------------------------------------------------------

const STATUS: CatalogStatus = {
  pricingUpdatedAt: 1_791_158_400_000,
  confidence: 'unverified',
  stale: false,
  refreshDue: true,
  jobRunning: false,
  schedule: { enabled: true, intervalDays: 14, lastRefreshAt: null, snoozedUntil: null, nextDueAt: 0 },
}

async function jobsWith(o: {
  vendor: string
  model?: string | null
  ready?: Record<string, RefreshReadiness>
  codex?: Adapter
}): Promise<{ jobs: CatalogJobs; claude: ScriptedAdapter; codex: ScriptedCodex; events: CatalogJobEvent[] }> {
  const claude = new ScriptedAdapter(hangs)
  const codex = new ScriptedCodex(codexAnswers())
  const events: CatalogJobEvent[] = []
  const catalog = await seedCatalog()
  const settings: RefreshSettings = {
    refresh: { enabled: true, intervalDays: 14, vendor: o.vendor, model: o.model ?? null },
    vendors: ['claude', 'codex'],
  }
  let t = 1_791_500_000_000
  const jobs = new CatalogJobs({
    home: home(),
    adapter: (v) => (v === 'claude' ? claude : v === 'codex' ? (o.codex ?? codex) : undefined),
    ready: (v) => o.ready?.[v] ?? { ok: true },
    settings: () => Promise.resolve(settings),
    catalog: () => catalog,
    status: () => Promise.resolve(STATUS),
    price: () => ({ missing: 'x' }),
    emit: (ev) => events.push(ev),
    now: () => (t += 1000),
  })
  return { jobs, claude, codex, events }
}

const NOT_READY: RefreshReadiness = { ok: false, reason: 'Codex is not ready: Login needed.' }

describe('CatalogJobs: who refreshes', () => {
  it('Codex is a refresh vendor now', () => {
    expect(REFRESH_VENDORS).toEqual(['claude', 'codex'])
  })

  it('a ready Codex, configured, runs the refresh with its own model and no note', async () => {
    const { jobs, claude, codex, events } = await jobsWith({ vendor: 'codex', model: 'gpt-5.6-sol' })
    const plan = await jobs.plan()
    expect(plan).toMatchObject({ vendor: 'codex', model: 'gpt-5.6-sol', vendorName: 'Codex' })
    expect(plan.fallbackNote).toBeUndefined()
    const { jobId } = await jobs.start()
    expect(events[0]).toEqual({ kind: 'catalog', state: 'running', jobId, progress: 'Starting Codex' })
    await expect.poll(() => events.some((e) => e.state === 'diff-ready')).toBe(true)
    expect(codex.starts).toHaveLength(1)
    expect(claude.starts).toEqual([])
    expect(events.map((e) => e.progress).filter((p) => p !== undefined)).toEqual([
      'Starting Codex',
      'Searching the web',
      'Reading developers.openai.com',
    ])
  })

  it('a configured Codex that is not ready: Claude runs it with the built-in model, and the card says why', async () => {
    const { jobs } = await jobsWith({ vendor: 'codex', model: 'gpt-5.6-sol', ready: { codex: NOT_READY } })
    const plan = await jobs.plan()
    expect(plan).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
      fallbackNote: 'Codex is not ready: Login needed. Claude refreshes the prices instead.',
    })
    expect(plan.fallbackNote).not.toContain(EM_DASH)
  })

  it('a configured Claude that is not ready falls back to a ready Codex on its CLI default model', async () => {
    const { jobs } = await jobsWith({
      vendor: 'claude',
      model: 'sonnet',
      ready: { claude: { ok: false, reason: 'Claude is not ready: Login needed.' } },
    })
    expect(await jobs.plan()).toMatchObject({
      vendor: 'codex',
      model: null,
      fallbackNote: 'Claude is not ready: Login needed. Codex refreshes the prices instead.',
    })
  })

  it('no refresh vendor ready: the configured one runs and its job says what failed (no note)', async () => {
    const { jobs } = await jobsWith({
      vendor: 'claude',
      model: 'sonnet',
      ready: { claude: { ok: false, reason: 'x' }, codex: NOT_READY },
    })
    const plan = await jobs.plan()
    expect(plan).toMatchObject({ vendor: 'claude', model: 'sonnet' })
    expect(plan.fallbackNote).toBeUndefined()
  })

  it('a request naming a Codex that is not ready is refused with the reason (CONFLICT), nothing starts', async () => {
    const { jobs, claude, codex, events } = await jobsWith({ vendor: 'claude', ready: { codex: NOT_READY } })
    await expect(jobs.start({ vendor: 'codex' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Codex is not ready: Login needed.',
    })
    await expect(jobs.start({ vendor: 'gemini' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(codex.starts).toEqual([])
    expect(claude.starts).toEqual([])
    expect(events).toEqual([])
  })

  it('a request naming a ready Codex runs it even when Claude is configured (its CLI default model)', async () => {
    const { jobs, codex, events } = await jobsWith({ vendor: 'claude', model: 'sonnet' })
    await jobs.start({ vendor: 'codex' })
    await expect.poll(() => events.some((e) => e.state === 'diff-ready')).toBe(true)
    expect(codex.starts[0]).toMatchObject({ step: 'catalog', model: null, ephemeral: true, mode: 'readonly' })
  })
})
