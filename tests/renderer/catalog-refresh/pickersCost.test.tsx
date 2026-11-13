// Model pickers and cost labels (pass rows "Model: CLI list + catalog + free text, with a 'no
// pricing' chip"; cost labels: "est. from pricing fetched <date> (verified/unverified)", amber when pricing is
// older than 2× the refresh interval; "Estimates use new prices at once"). Core's vendors.models joins the CLI's
// models with the catalog's and says which have a price, and core's catalog status says whether prices are stale: the
// renderer orders, words and asks again, it decides nothing.
import '../helpers/rtl.ts'
import { act, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelOption } from '@shared/vendors.ts'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { costTitle } from '@renderer/lib/format.ts'
import { modelOptionText, NO_PRICING, pickerOptions } from '@renderer/lib/modelOptions.ts'
import {
  costPricingFacts,
  pricingBasisText,
  pricingFactsOf,
  pricingTitle,
  runPricingFacts,
  STALE_PRICING_NOTE,
} from '@renderer/lib/pricing.ts'
import { ModelField } from '@renderer/pages/dashboard/composer/ModelField.tsx'
import { useVendorModels } from '@renderer/pages/dashboard/composer/useVendorModels.ts'
import {
  bumpCatalogEpoch,
  noteCatalogStatus,
  onCatalogEvent,
  resetCatalogForTests,
} from '@renderer/state/catalog.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, mountComposer, report, runEstimate } from '../composer/fixtures.tsx'
import { AT, status } from './fixtures.ts'

let mock: MockDimFactory

const OPTIONS: ModelOption[] = [
  { id: 'catalog-b', source: 'catalog', hasPricing: true },
  { id: 'opus', label: 'Opus 5.5', source: 'cli', isDefault: true, hasPricing: true },
  { id: 'catalog-a', source: 'catalog', hasPricing: false, deprecated: true },
  { id: 'sonnet', source: 'cli', hasPricing: false },
  { id: 'opus', source: 'catalog', hasPricing: true },
]

beforeEach(() => {
  resetCatalogForTests()
  mock = setUp({
    handlers: {
      'vendors.models': () => OPTIONS,
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
})

afterEach(() => {
  tearDown(mock)
  resetCatalogForTests()
})

describe('model pickers', () => {
  it('list the CLI’s models first, then the catalog’s, each id once, keeping a typed value no option has', () => {
    expect(pickerOptions(OPTIONS).map((o) => o.id)).toEqual(['opus', 'sonnet', 'catalog-b', 'catalog-a'])
    expect(pickerOptions(OPTIONS, 'my-model').map((o) => o.id)).toEqual([
      'my-model',
      'opus',
      'sonnet',
      'catalog-b',
      'catalog-a',
    ])
    expect(pickerOptions(OPTIONS, 'sonnet')).toHaveLength(4)
    expect(
      pickerOptions([{ id: 'x', aliases: ['alias'], source: 'cli', hasPricing: true }], 'alias'),
    ).toHaveLength(1)
  })

  it('say "no pricing" beside a model core cannot price, and "deprecated" where core says so', () => {
    expect(modelOptionText({ id: 'opus', label: 'Opus 5.5', hasPricing: true })).toBe('Opus 5.5 (opus)')
    expect(modelOptionText({ id: 'sonnet', hasPricing: false })).toBe(`sonnet · ${NO_PRICING}`)
    expect(modelOptionText({ id: 'old', hasPricing: false, deprecated: true })).toBe(
      'old · no pricing · deprecated',
    )
    expect(modelOptionText({ id: 'typed' })).toBe('typed')
  })

  it('the pass row’s model box suggests them in that order, and shows the "no pricing" chip for its model', () => {
    render(
      <Providers>
        <ModelField
          pass="plan"
          label="Plan model"
          value="sonnet"
          options={OPTIONS}
          noPricing
          onCommit={() => {}}
        />
      </Providers>,
    )
    const list = document.querySelector('datalist') as HTMLDataListElement
    expect([...list.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([
      ['opus', 'Opus 5.5 · default'],
      ['sonnet', 'no pricing'],
      ['catalog-b', ''],
      ['catalog-a', 'no pricing'],
    ])
    expect(screen.getByTestId('pass-no-pricing-plan').textContent).toBe('no pricing')
  })

  it('ask core again for every vendor already listed when the catalog changes (an apply, an undo, an edit)', async () => {
    function Harness(): React.JSX.Element {
      const m = useVendorModels([])
      useEffect(() => m.want('claude'), [m])
      return <p>{m.options('claude')?.length ?? 0}</p>
    }
    render(<Harness />)
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }])
    act(() => bumpCatalogEpoch())
    await settle()
    expect(mock.callsOf('vendors.models')).toEqual([{ vendor: 'claude' }, { vendor: 'claude' }])
    // An applied update reported by core does the same.
    act(() => onCatalogEvent({ kind: 'catalog', state: 'applied', jobId: 'j1' }))
    await settle()
    expect(mock.callsOf('vendors.models')).toHaveLength(3)
  })
})

describe('estimates use new prices at once', () => {
  it('the composer asks for its estimate again as soon as the catalog changes', async () => {
    await mountComposer()
    await settle(300)
    const asked = mock.callsOf('estimates.get').length
    expect(asked).toBeGreaterThan(0)
    act(() => onCatalogEvent({ kind: 'catalog', state: 'applied', jobId: 'j1' }))
    await settle(300)
    expect(mock.callsOf('estimates.get').length).toBe(asked + 1)
    act(() => bumpCatalogEpoch())
    await settle(300)
    expect(mock.callsOf('estimates.get').length).toBe(asked + 2)
  })
})

describe('cost labels', () => {
  it('word core’s facts: "est. from pricing fetched <date> (verified/unverified)", and the stale note', () => {
    const day = new Date(AT).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
    const facts = pricingFactsOf(status({ confidence: 'verified' }))
    expect(pricingBasisText(facts)).toBe(`est. from pricing fetched ${day} (verified)`)
    expect(pricingBasisText(pricingFactsOf(status({ confidence: 'unverified' })))).toBe(
      `est. from pricing fetched ${day} (unverified)`,
    )
    expect(pricingBasisText(pricingFactsOf(status({ pricingUpdatedAt: null, confidence: 'none' })))).toBe(
      'est. from pricing (unverified)',
    )
    expect(pricingBasisText(null)).toBe('est. from pricing')
    expect(pricingTitle(pricingFactsOf(status({ stale: true })))).toBe(
      `est. from pricing fetched ${day} (unverified). ${STALE_PRICING_NOTE}`,
    )
    expect(costTitle({ usd: 0.5, basis: 'catalog' }, pricingTitle(facts))).toBe(
      `est. from pricing fetched ${day} (verified)`,
    )
    // A vendor-reported figure keeps its own words.
    expect(costTitle({ usd: 0.5, basis: 'vendor' }, pricingTitle(facts))).toBe('reported by vendor')
    expect(costTitle({ usd: 0.5, basis: 'catalog' })).toBe('est. from pricing')
  })

  it('the composer’s estimate is amber while core says prices are stale, and names the pricing', async () => {
    noteCatalogStatus(status({ stale: true }))
    await mountComposer()
    await settle(300)
    const line = screen.getByTestId('estimate-line')
    expect(line.getAttribute('data-stale-prices')).toBe('true')
    expect(line.className).toContain('text-warning')
    act(() => line.focus())
    expect(screen.getByTestId('estimate-pricing').textContent).toBe(
      `Cost ${pricingTitle(pricingFactsOf(status({ stale: true })))}`,
    )
    act(() => noteCatalogStatus(status({ stale: false })))
    expect(line.getAttribute('data-stale-prices')).toBeNull()
    expect(line.className).not.toContain('text-warning')
  })

  it('a live run’s cost is amber with stale prices; a finished run’s was priced on its own day and is not', () => {
    noteCatalogStatus(status({ stale: true }))
    const steps = [
      { key: 'plan' as const, status: 'done' as const, activeMs: 1000, costBasis: 'catalog' as const },
    ]
    const live = makeSnapshot({
      runId: 'r1',
      status: 'running',
      progress: { tokens: 10, costUsd: 0.4, filesChanged: 0 },
      steps,
    })
    const { unmount } = render(
      <Providers>
        <RunHeader snap={live} onStop={() => {}} stopping={false} />
      </Providers>,
    )
    expect(screen.getByTestId('run-cost').getAttribute('data-stale-prices')).toBe('true')
    expect(screen.getByTestId('run-cost').className).toContain('text-warning')
    unmount()
    const done = makeSnapshot({
      runId: 'r2',
      status: 'completed',
      progress: { tokens: 10, costUsd: 0.4, filesChanged: 0 },
      steps,
    })
    render(
      <Providers>
        <RunHeader snap={done} onStop={() => {}} stopping={false} />
      </Providers>,
    )
    expect(screen.getByTestId('run-cost').getAttribute('data-stale-prices')).toBeNull()
    expect(screen.getByTestId('run-cost').className).not.toContain('text-warning')
  })
})

describe('a run is labelled with its own prices', () => {
  const FROZEN = { fetchedAt: AT, confidence: 'unverified' as const, stale: true }

  it('reads the facts core froze with a catalog figure; a run total takes the oldest, one word, stale if any', () => {
    expect(costPricingFacts({ basis: 'catalog', pricing: FROZEN })).toEqual(FROZEN)
    expect(costPricingFacts({ basis: 'vendor', pricing: FROZEN })).toBeNull()
    expect(costPricingFacts({ basis: 'catalog' })).toBeNull()
    expect(
      runPricingFacts([
        { usd: 0.1, basis: 'catalog', apiEquivalent: false, pricing: FROZEN },
        {
          usd: 0.2,
          basis: 'catalog',
          apiEquivalent: false,
          pricing: { fetchedAt: AT + 5_000, confidence: 'verified', stale: false },
        },
        { usd: 0.3, basis: 'vendor', apiEquivalent: false },
        undefined,
      ]),
    ).toEqual({ fetchedAt: AT, confidence: 'mixed', stale: true })
    expect(runPricingFacts([undefined, { usd: 1, basis: 'vendor', apiEquivalent: false }])).toBeNull()
  })

  it('a run priced at its own stale prices stays amber after it ends; fresh own prices are not amber though today’s are stale', () => {
    const withPlanCost = (status: 'running' | 'completed', stale: boolean) => {
      const snap = makeSnapshot({
        runId: `r-${status}-${stale}`,
        status,
        progress: { tokens: 10, costUsd: 0.4, filesChanged: 0 },
        steps: [{ key: 'plan', status: 'done', activeMs: 1000, costBasis: 'catalog' }],
      })
      snap.steps.plan = {
        ...snap.steps.plan,
        status: 'done',
        cost: { usd: 0.4, basis: 'catalog', apiEquivalent: false, pricing: { ...FROZEN, stale } },
      }
      return snap
    }
    noteCatalogStatus(status({ stale: false }))
    const { unmount } = render(
      <Providers>
        <RunHeader snap={withPlanCost('completed', true)} onStop={() => {}} stopping={false} />
      </Providers>,
    )
    expect(screen.getByTestId('run-cost').getAttribute('data-stale-prices')).toBe('true')
    unmount()
    act(() => noteCatalogStatus(status({ stale: true })))
    render(
      <Providers>
        <RunHeader snap={withPlanCost('running', false)} onStop={() => {}} stopping={false} />
      </Providers>,
    )
    expect(screen.getByTestId('run-cost').getAttribute('data-stale-prices')).toBeNull()
  })
})
