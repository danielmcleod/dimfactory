// Catalog data commands (src/core/handlers-catalog-data.ts; the IPC catalog commands): catalog.get through the
// live catalog (else the shipped one), catalog.apply / undo / savePrice / setSchedule handed to it after request checks; a
// read-only core is FORBIDDEN, a core without the live catalog UNSUPPORTED. vendors.models merges what a refresh
// applied (catalog models after the CLI's, deprecated ones flagged).
import { describe, expect, it } from 'vitest'
import type { CatalogData } from '../../../../src/core/catalog/store.ts'
import { createHandlers, dispatch } from '../../../../src/core/handlers.ts'
import type { HandlerContext } from '../../../../src/core/handlers.ts'
import type { CatalogDataHost } from '../../../../src/core/handlers-catalog-data.ts'
import { CATALOG_DATA_COMMANDS } from '../../../../src/core/handlers-catalog-data.ts'
import { mergeModelOptions } from '../../../../src/core/recovery/models.ts'
import type { CatalogState, CatalogStatus } from '../../../../src/shared/catalog.ts'
import { CLI_MODELS, HAIKU, NOW, OPUS, SONNET, current } from './fixtures.ts'

const STATE = { job: null, history: [], undoId: null } as unknown as CatalogState

function host(): CatalogDataHost & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    state: () => Promise.resolve(STATE),
    apply: (jobId, rowIds) => (calls.push(['apply', jobId, rowIds]), Promise.resolve(STATE)),
    undo: () => (calls.push(['undo']), Promise.resolve(STATE)),
    savePrice: (edit) => (calls.push(['savePrice', edit]), Promise.resolve(STATE)),
    setSchedule: (u) => (
      calls.push(['setSchedule', u]),
      Promise.resolve({
        enabled: true,
        intervalDays: 14,
        lastRefreshAt: null,
        snoozedUntil: null,
        nextDueAt: null,
      })
    ),
  }
}

function handlers(o: { catalog?: CatalogDataHost; readOnly?: boolean; fromDashboard?: CatalogData } = {}) {
  const ctx = {
    readOnly: o.readOnly === true,
    ...(o.catalog !== undefined ? { catalog: o.catalog } : {}),
    ...(o.fromDashboard !== undefined
      ? {
          dashboard: {
            catalogData: () => o.fromDashboard,
            catalogStatus: () => Promise.resolve({ confidence: 'unverified' } as CatalogStatus),
          },
        }
      : {}),
  } as unknown as HandlerContext
  return createHandlers(ctx)
}

const errorOf = (r: { ok: boolean; error?: { code: string; message: string } }) => (r.ok ? null : r.error)

describe('catalog data handlers', () => {
  it('catalog.get: the live catalog when there is one, else the read-only answer, else UNSUPPORTED', async () => {
    expect(await dispatch(handlers({ catalog: host() }), 'catalog.get', undefined)).toEqual({
      ok: true,
      value: STATE,
    })
    const res = await dispatch(handlers({ fromDashboard: current() }), 'catalog.get', undefined)
    expect(res.ok && res.value).toMatchObject({ job: null, history: [] })
    expect(errorOf(await dispatch(handlers(), 'catalog.get', undefined))?.code).toBe('UNSUPPORTED')
  })

  it('hands well-formed requests to the live catalog', async () => {
    const h = host()
    const t = handlers({ catalog: h })
    const edit = {
      vendor: 'claude',
      model: 'claude-opus-5-5',
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: null,
      cacheWritePerMTok: 10,
      aliases: ['opus'],
    }
    expect((await dispatch(t, 'catalog.apply', { jobId: 'job-1', rowIds: ['a', 'b'] })).ok).toBe(true)
    expect((await dispatch(t, 'catalog.undo', undefined)).ok).toBe(true)
    expect((await dispatch(t, 'catalog.savePrice', { entry: edit })).ok).toBe(true)
    expect((await dispatch(t, 'catalog.setSchedule', { snoozeDays: 7 })).ok).toBe(true)
    expect(h.calls).toEqual([
      ['apply', 'job-1', ['a', 'b']],
      ['undo'],
      ['savePrice', edit],
      ['setSchedule', { snoozeDays: 7 }],
    ])
  })

  it('refuses malformed requests (VALIDATION) before reaching the catalog', async () => {
    const h = host()
    const t = handlers({ catalog: h })
    const bad: [string, unknown][] = [
      ['catalog.apply', { jobId: '', rowIds: [] }],
      ['catalog.apply', { jobId: 'j', rowIds: 'all' }],
      ['catalog.apply', { jobId: 'j', rowIds: [1] }],
      ['catalog.savePrice', { entry: { vendor: 'claude', model: 'm', inputPerMTok: '3', outputPerMTok: 1 } }],
      [
        'catalog.savePrice',
        { entry: { vendor: 'claude', model: 'm', inputPerMTok: 3, outputPerMTok: null } },
      ],
      ['catalog.setSchedule', { intervalDays: 0 }],
      ['catalog.setSchedule', { snoozeDays: 7.5 }],
      ['catalog.setSchedule', { enabled: 'no' }],
    ]
    for (const [cmd, req] of bad) {
      const r = await dispatch(t, cmd as 'catalog.apply', req as never)
      expect(errorOf(r)?.code, `${cmd} ${JSON.stringify(req)}`).toBe('VALIDATION')
    }
    expect(h.calls).toEqual([])
  })

  it('a read-only core is FORBIDDEN to write; without the live catalog the writes are UNSUPPORTED', async () => {
    const entry = {
      vendor: 'claude',
      model: 'm',
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    }
    const reqs = {
      'catalog.apply': { jobId: 'j', rowIds: [] },
      'catalog.undo': undefined,
      'catalog.savePrice': { entry },
      'catalog.setSchedule': {},
    } as const
    for (const cmd of CATALOG_DATA_COMMANDS) {
      const ro = await dispatch(handlers({ catalog: host(), readOnly: true }), cmd, reqs[cmd] as never)
      expect(errorOf(ro)?.code, cmd).toBe('FORBIDDEN')
      const none = await dispatch(handlers(), cmd, reqs[cmd] as never)
      expect(errorOf(none)?.code, cmd).toBe('UNSUPPORTED')
    }
  })
})

describe('vendors.models merges the applied catalog (CLI list first, then catalog models, deprecated flagged)', () => {
  it('a model a refresh added follows the CLI list; a deprecated price flags the CLI model and its own row', () => {
    const data = current([
      { ...OPUS },
      { ...SONNET },
      { ...HAIKU, deprecated: true },
      { ...OPUS, model: 'claude-opus-6', aliases: ['opus-6'], fetchedAt: NOW },
    ])
    data.models.vendors['claude'] = {
      source: 'ai-refresh',
      fetchedAt: NOW,
      models: [
        {
          id: 'claude-opus-7-preview',
          displayName: 'Opus 7 (preview)',
          source: 'ai-refresh',
          fetchedAt: NOW,
        },
      ],
    }
    const out = mergeModelOptions(
      'claude',
      CLI_MODELS.filter((m) => m.id !== 'fable'),
      data,
    )
    expect(out.map((m) => [m.id, m.source, m.hasPricing, m.deprecated === true])).toEqual([
      ['default', 'cli', true, false],
      ['opus', 'cli', true, false],
      ['sonnet', 'cli', true, false],
      ['haiku', 'cli', true, true],
      ['claude-opus-6', 'catalog', true, false],
      ['claude-opus-7-preview', 'catalog', false, false],
    ])
    // Without the CLI listing it, the deprecated price is still offered, flagged, under its own id only.
    const bare = mergeModelOptions('claude', [], data)
    expect(bare.find((m) => m.id === HAIKU.model)).toEqual({
      id: HAIKU.model,
      source: 'catalog',
      hasPricing: true,
      deprecated: true,
    })
  })
})
