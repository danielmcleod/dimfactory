// Codex web search outside the official hosts: the consent line's tooltip says "It reads pages only on …" only
// where core's refresh plan says the job is confined to those hosts (`hostsConfined`, Claude). For Codex, whose web
// search takes no domain list, it says where it looks and that a price found elsewhere is marked "Unofficial source".
import { describe, expect, it } from 'vitest'
import type { CatalogRefreshPlan } from '@shared/catalog.ts'
import { consentTitle } from '@renderer/pages/settings/catalog/consent.ts'

const HOSTS = ['docs.anthropic.com', 'developers.openai.com']

const plan = (over: Partial<CatalogRefreshPlan>): CatalogRefreshPlan => ({
  vendor: 'claude',
  model: 'sonnet',
  estDurationMs: 240_000,
  estCostUsd: 0.2,
  lastRefreshAt: null,
  due: true,
  hosts: HOSTS,
  ...over,
})

describe('the consent tooltip and the hosts', () => {
  it('Claude (confined): "It reads pages only on …"', () => {
    expect(consentTitle(plan({ vendorName: 'Claude', hostsConfined: true }))).toBe(
      `Claude (sonnet): read-only, web search, cannot change files. It reads pages only on ${HOSTS.join(', ')}.`,
    )
  })

  it('Codex (not confined): where it looks, never "only", and how an off-site price is shown', () => {
    const title = consentTitle(
      plan({ vendor: 'codex', model: null, vendorName: 'Codex', hostsConfined: false }),
    )
    expect(title).toBe(
      `Codex: read-only, web search, cannot change files. It looks for prices on ${HOSTS.join(', ')}. Codex's web search is not limited to these sites, so a price it finds anywhere else is marked "Unofficial source" for you to check.`,
    )
    expect(title).not.toContain('reads pages only')
    expect(title).not.toContain('—')
  })

  it('a plan from an earlier core (no hostsConfined) reads as before', () => {
    expect(consentTitle(plan({ vendorName: 'Claude' }))).toContain('It reads pages only on')
  })
})
