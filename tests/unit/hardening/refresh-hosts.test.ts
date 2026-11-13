// Codex web search outside the official hosts:
// Codex's refresh cannot be confined to the official hosts (its
// web search takes no domain list), so the refresh plan says so (`hostsConfined: false`) and the consent card stops
// promising "It reads pages only on …" for it (tests/renderer/hardening/consentHosts.test.ts). Claude's refresh
// stays confined.
import { describe, expect, it } from 'vitest'
import type { CatalogStatus } from '../../../src/shared/catalog.ts'
import { CatalogJobs, HOST_CONFINED_REFRESH_VENDORS } from '../../../src/core/catalog/refresh-jobs.ts'
import { officialHosts } from '../../../src/core/catalog/sources.ts'
import { ScriptedAdapter, hangs, home, seedCatalog } from '../catalog-refresh/job/helpers.ts'

const STATUS: CatalogStatus = {
  pricingUpdatedAt: 1_791_158_400_000,
  confidence: 'unverified',
  stale: false,
  refreshDue: true,
  jobRunning: false,
  schedule: { enabled: true, intervalDays: 14, lastRefreshAt: null, snoozedUntil: null, nextDueAt: 0 },
}

async function jobsFor(vendor: 'claude' | 'codex'): Promise<CatalogJobs> {
  const adapter = new ScriptedAdapter(hangs)
  const catalog = await seedCatalog()
  return new CatalogJobs({
    home: home(),
    adapter: () => adapter,
    ready: () => ({ ok: true }),
    settings: () =>
      Promise.resolve({
        refresh: { enabled: true, intervalDays: 14, vendor, model: null },
        vendors: ['claude', 'codex'],
      }),
    catalog: () => catalog,
    status: () => Promise.resolve(STATUS),
    price: () => ({ missing: 'x' }),
    emit: () => undefined,
    buildDiff: () => {
      throw new Error('no diff here')
    },
    now: () => 1_791_500_000_000,
  })
}

describe('the refresh plan says whether the job is confined to the official hosts', () => {
  it('Claude: confined to the hosts it lists', async () => {
    expect(HOST_CONFINED_REFRESH_VENDORS).toEqual(['claude'])
    const plan = await (await jobsFor('claude')).plan()
    expect(plan).toMatchObject({
      vendor: 'claude',
      hosts: officialHosts(['claude', 'codex']),
      hostsConfined: true,
    })
  })

  it('Codex: not confined (its web search takes no domain list)', async () => {
    const plan = await (await jobsFor('codex')).plan()
    expect(plan).toMatchObject({
      vendor: 'codex',
      hosts: officialHosts(['claude', 'codex']),
      hostsConfined: false,
    })
  })
})
