// catalog.refreshPlan / catalog.refresh / catalog.cancel handlers (the refresh consent card
// never auto-runs, `consent: z.literal(true)`; catalog.spec.ts "refresh without consent rejected"). The core checks the consent
// itself (core.invoke has no IPC schema in front of it): anything but a literal `true` is VALIDATION and starts nothing.
import { describe, expect, it } from 'vitest'
import {
  CONSENT_MESSAGE,
  CATALOG_JOB_COMMANDS,
  catalogJobHandlers,
} from '../../../../src/core/handlers-catalog-job.ts'
import type { CatalogJobHost } from '../../../../src/core/handlers-catalog-job.ts'
import type { HandlerContext, HandlerMap } from '../../../../src/core/handlers.ts'
import { dispatch } from '../../../../src/core/handlers.ts'
import { parseRequest } from '../../../../src/shared/ipc-schemas.ts'
import type { CatalogRefreshPlan } from '../../../../src/shared/catalog.ts'
import type { Req } from '../../../../src/shared/ipc.ts'

const PLAN: CatalogRefreshPlan = {
  vendor: 'claude',
  model: 'sonnet',
  estDurationMs: 240_000,
  estCostUsd: 0.2,
  lastRefreshAt: null,
  due: true,
  copy: 'Read-only, web search, cannot change files.',
}

function host(): CatalogJobHost & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    plan: () => {
      calls.push(['plan'])
      return Promise.resolve(PLAN)
    },
    start: (r) => {
      calls.push(['start', r])
      return Promise.resolve({ jobId: 'job-1' })
    },
    cancel: (id) => {
      calls.push(['cancel', id])
      return Promise.resolve()
    },
  }
}

function table(o: { readOnly?: boolean; host?: CatalogJobHost }): HandlerMap {
  return catalogJobHandlers({
    readOnly: o.readOnly === true,
    ...(o.host !== undefined ? { catalogJobs: o.host } : {}),
  } as unknown as HandlerContext)
}

const refresh = (h: HandlerMap, req: unknown) => dispatch(h, 'catalog.refresh', req as Req<'catalog.refresh'>)

describe('catalog job handlers', () => {
  it('declares exactly the three refresh commands', () => {
    expect(Object.keys(table({ host: host() })).sort()).toEqual([...CATALOG_JOB_COMMANDS].sort())
  })

  it('starts a refresh only with consent literally true', async () => {
    const h = host()
    const t = table({ host: h })
    expect(await refresh(t, { consent: true })).toEqual({ ok: true, value: { jobId: 'job-1' } })
    expect(await refresh(t, { consent: true, vendor: 'claude', model: null })).toEqual({
      ok: true,
      value: { jobId: 'job-1' },
    })
    expect(h.calls).toEqual([
      ['start', {}],
      ['start', { vendor: 'claude', model: null }],
    ])
  })

  it.each([
    ['consent false', { consent: false }],
    ['consent missing', {}],
    ['no request', undefined],
    ['consent "true"', { consent: 'true' }],
    ['consent 1', { consent: 1 }],
    ['consent [true]', { consent: [true] }],
    ['consent {}', { consent: {} }],
    ['null', null],
  ])('refuses %s: VALIDATION, nothing starts', async (_name, req) => {
    const h = host()
    const r = await refresh(table({ host: h }), req)
    expect(r).toEqual({ ok: false, error: { code: 'VALIDATION', message: CONSENT_MESSAGE } })
    expect(h.calls).toEqual([])
  })

  it('checks consent before anything else (a read-only core or a missing host still says VALIDATION)', async () => {
    expect(await refresh(table({ readOnly: true, host: host() }), { consent: false })).toMatchObject({
      error: { code: 'VALIDATION' },
    })
    expect(await refresh(table({}), {})).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('refuses unknown fields and malformed vendor or model, without starting', async () => {
    const h = host()
    const t = table({ host: h })
    expect(await refresh(t, { consent: true, auto: true })).toMatchObject({ error: { code: 'VALIDATION' } })
    expect(await refresh(t, { consent: true, vendor: 'Claude Code' })).toMatchObject({
      error: { code: 'VALIDATION' },
    })
    expect(await refresh(t, { consent: true, model: 'sonnet; rm -rf' })).toMatchObject({
      error: { code: 'VALIDATION' },
    })
    expect(await refresh(t, { consent: true, model: 7 })).toMatchObject({ error: { code: 'VALIDATION' } })
    expect(h.calls).toEqual([])
  })

  it('the IPC schema refuses the same requests at the main-process boundary', () => {
    for (const bad of [{ consent: false }, {}, { consent: 'true' }, { consent: true, auto: true }]) {
      expect(parseRequest('catalog.refresh', bad)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
    expect(parseRequest('catalog.refresh', { consent: true })).toEqual({ ok: true, value: { consent: true } })
  })

  it('a read-only core refuses refresh and cancel; no host is UNSUPPORTED; the plan reads anywhere', async () => {
    const ro = table({ readOnly: true, host: host() })
    expect(await refresh(ro, { consent: true })).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(await dispatch(ro, 'catalog.cancel', { jobId: 'job-1' })).toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
    expect(await dispatch(ro, 'catalog.refreshPlan', undefined)).toEqual({ ok: true, value: PLAN })
    const none = table({})
    expect(await refresh(none, { consent: true })).toMatchObject({ error: { code: 'UNSUPPORTED' } })
    expect(await dispatch(none, 'catalog.refreshPlan', undefined)).toMatchObject({
      error: { code: 'UNSUPPORTED' },
    })
  })

  it('cancel needs a job id and hands it to the host', async () => {
    const h = host()
    const t = table({ host: h })
    expect(await dispatch(t, 'catalog.cancel', { jobId: '' })).toMatchObject({
      error: { code: 'VALIDATION' },
    })
    expect(await dispatch(t, 'catalog.cancel', {} as never)).toMatchObject({ error: { code: 'VALIDATION' } })
    expect(await dispatch(t, 'catalog.cancel', { jobId: 'job-1' })).toEqual({ ok: true, value: undefined })
    expect(h.calls).toEqual([['cancel', 'job-1']])
  })

  it('has no em dash in its copy', () => {
    expect(CONSENT_MESSAGE).not.toContain('\u2014')
  })
})
