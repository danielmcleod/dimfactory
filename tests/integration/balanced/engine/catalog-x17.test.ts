// X17 through a real core (the catalog refresh job on "Codex: read-only, ephemeral, config:{web_search:'live'}
// + outputSchema (X17)"; Settings → Catalog: the Codex choice is live once Codex is ready): a user file naming
// Codex as the refresh vendor.
//   - Codex ready: the consent card names Codex and its CLI default model (priced at the seed's price for it); the job
//     starts Codex read-only, ephemeral, with the schema, web access to the official hosts and the job folder as cwd,
//     and ends diff-ready with the answer validated
//   - Codex logged out: Claude refreshes instead and the card says why; a request naming Codex is refused
//   - no consent: refused, nothing starts
import { afterEach, describe, expect, it } from 'vitest'
import { refreshJsonSchema } from '../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../src/core/catalog/sources.ts'
import { META_STRUCTURED_OUTPUT } from '../../../../src/core/adapters/types.ts'
import type { CodexScript } from './helpers.ts'
import { ScriptedCodex, World, value } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const PRICING = 'https://developers.openai.com/api/docs/pricing'
const PROPOSAL = {
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
      sourceUrl: PRICING,
      sourceQuote: 'gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00',
    },
  ],
  newModels: [],
  unverifiable: [],
}

/** Codex's refresh: a search, the official page opened, the structured answer (turn/start outputSchema). */
const answers: CodexScript = (h, o) => {
  void (async () => {
    h.thread = 'thr_x17'
    await o.onSession?.('thr_x17')
    h.events.emit({ type: 'session', id: 'thr_x17' })
    h.events.emit({
      type: 'tool',
      id: 'w1',
      name: 'webSearch',
      summary: 'openai api pricing',
      phase: 'start',
    })
    h.events.emit({
      type: 'tool',
      id: 'w1',
      name: 'webSearch',
      summary: 'openai api pricing',
      phase: 'end',
      status: 'ok',
    })
    h.events.emit({ type: 'tool', id: 'w2', name: 'webSearch', summary: PRICING, phase: 'start' })
    h.events.emit({ type: 'tool', id: 'w2', name: 'webSearch', summary: PRICING, phase: 'end', status: 'ok' })
    h.signals.emit({ type: 'meta', key: META_STRUCTURED_OUTPUT, value: PROPOSAL })
    h.events.emit({ type: 'done', result: JSON.stringify(PROPOSAL), usage: { input: 20_000, output: 3_000 } })
    h.exit(0)
  })()
}

const USER = { catalog: { refresh: { enabled: true, intervalDays: 14, vendor: 'codex', model: null } } }

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('catalog refresh on Codex (X17, core)', () => {
  it('a ready Codex runs it read-only and ephemeral with the schema and the official hosts', async () => {
    const codex = new ScriptedCodex(answers)
    const t = await w.boot({}, codex, { user: USER })
    const plan = value(await t.core.invoke('catalog.refreshPlan', undefined))
    expect(plan).toMatchObject({
      vendor: 'codex',
      model: null,
      vendorName: 'Codex',
      defaultModel: 'gpt-5.6-sol',
    })
    expect(plan.fallbackNote).toBeUndefined()
    expect(plan.estCostUsd ?? 0).toBeGreaterThan(0)
    expect(plan.apiEquivalent).toBe(true)

    const { jobId } = value(await t.core.invoke('catalog.refresh', { consent: true }))
    await until(() =>
      t.appEvents.some((e) => e.kind === 'catalog' && e.jobId === jobId && e.state === 'diff-ready'),
    )
    expect(codex.starts).toHaveLength(1)
    const o = codex.starts[0]
    const vendors = plan.vendors ?? []
    expect(o).toMatchObject({
      runId: jobId,
      step: 'catalog',
      mode: 'readonly',
      ephemeral: true,
      planNative: false,
      model: null,
      allowRules: [],
      web: { allowedDomains: officialHosts(vendors) },
      outputSchema: refreshJsonSchema(vendors),
    })
    expect(o?.cwd.replace(/\\/g, '/')).toContain(`/catalog/jobs/${jobId}`)
    expect(o?.sessionId).toBeUndefined()
    const ready = t.appEvents.find((e) => e.kind === 'catalog' && e.state === 'diff-ready')
    expect(ready?.kind === 'catalog' ? ready.diff?.rows.some((r) => r.model === 'gpt-5.6-sol') : false).toBe(
      true,
    )
  }, 120_000)

  it('a logged-out Codex: Claude refreshes instead and the card says why; asking for Codex is refused', async () => {
    const codex = new ScriptedCodex(answers, { auth: 'fail' })
    const t = await w.boot({}, codex, { user: USER })
    const plan = value(await t.core.invoke('catalog.refreshPlan', undefined))
    expect(plan).toMatchObject({ vendor: 'claude', model: 'sonnet' })
    expect(plan.fallbackNote).toBe('Codex is not ready: Login needed. Claude refreshes the prices instead.')
    const r = await t.core.invoke('catalog.refresh', { consent: true, vendor: 'codex' })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error).toMatchObject({ code: 'CONFLICT', message: 'Codex is not ready: Login needed.' })
    expect(codex.starts).toEqual([])
  }, 120_000)

  it('without consent nothing starts', async () => {
    const codex = new ScriptedCodex(answers)
    const t = await w.boot({}, codex, { user: USER })
    const r = await t.core.invoke('catalog.refresh', {} as never)
    expect(r.ok).toBe(false)
    expect(codex.starts).toEqual([])
  }, 120_000)
})
