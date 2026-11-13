// The Plops page (src/renderer/src/pages/plops): the Plop SVG (geometry, accessible name, reduced motion), the lineup
// rules applied to core's usage, and the page's states, its 30/7-day toggle (buttons that keep their size) and the
// drill-down into a vendor's models.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelUsage, UsageData, UsageRange, VendorUsage } from '@shared/usage.ts'
import { Plop } from '@renderer/pages/plops/Plop.tsx'
import { buildPlop, GROWING_MS } from '@renderer/pages/plops/plopModel.ts'
import { buildLineup, costText, plopLabel, resetPlayedForTests } from '@renderer/pages/plops/lineup.ts'
import type { VendorView } from '@renderer/pages/plops/lineup.ts'
import { LEGEND, PLOPS_LOADING, PlopsPage } from '@renderer/pages/plops/PlopsPage.tsx'
import {
  defaultPlopMotion,
  NIBBLE_FIRST_MAX_MS,
  NIBBLE_GAP_MAX_MS,
  PlopMotionContext,
  ROTATE_MAX_MS,
  seededRandom,
  SNACK_MS,
} from '@renderer/pages/plops/plopAnimation.ts'
import type { PlopMotion } from '@renderer/pages/plops/plopAnimation.ts'
import { href, parseHash } from '@renderer/lib/router.ts'
import { setThemeState } from '@renderer/state/actions.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const H = 3_600_000

const figures = { costPartial: false, runs: 1 }
const signals = { steps: 1, failedSteps: 0, reruns: 0, limitHits24h: 0, live: 0, lastUsedAt: NOW - H }

function model(name: string | null, tokens: number, over: Partial<ModelUsage> = {}): ModelUsage {
  return {
    model: name,
    tokens,
    costUsd: tokens / 1_000_000,
    ...figures,
    ...signals,
    previous: { tokens, costUsd: null, costPartial: false, runs: 1 },
    lifetimeTokens: tokens,
    ...over,
  }
}

function vendor(id: string, models: ModelUsage[], over: Partial<VendorUsage> = {}): VendorUsage {
  const tokens = models.reduce((a, m) => a + m.tokens, 0)
  return {
    vendor: id,
    tokens,
    costUsd: tokens / 1_000_000,
    ...figures,
    ...signals,
    apiEquivalent: false,
    previous: { tokens, costUsd: null, costPartial: false, runs: 1 },
    lifetimeTokens: models.reduce((a, m) => a + m.lifetimeTokens, 0),
    models,
    ...over,
  }
}

function usageData(range: UsageRange, vendors: VendorUsage[]): UsageData {
  const tokens = vendors.reduce((a, v) => a + v.tokens, 0)
  return {
    range,
    from: NOW - (range === '7d' ? 7 : 30) * 86_400_000,
    to: NOW,
    totals: { tokens, costUsd: tokens / 1_000_000, costPartial: false, runs: vendors.length },
    previous: { tokens: 0, costUsd: null, costPartial: false, runs: 0 },
    vendors,
  }
}

const MONTH = usageData('30d', [
  vendor('claude', [model('claude-opus-4-1', 2_400_000), model('claude-sonnet-4-5', 1_100_000)]),
  vendor('codex', [model('gpt-5-codex', 1_600_000), model('gpt-5', 420_000)]),
  vendor('gemini', [model(null, 12_000)], { lastUsedAt: NOW - 3 * 86_400_000 }),
])
const WEEK = usageData('7d', [vendor('codex', [model('gpt-5-codex', 300_000)])])

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'usage.get': ({ range }) => (range === '30d' ? MONTH : WEEK) } })
  resetPlayedForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tearDown(mock)
})

function mountPage(motion: PlopMotion = { ...defaultPlopMotion, random: seededRandom(42) }): () => void {
  const { unmount } = render(
    <Providers>
      <PlopMotionContext.Provider value={motion}>
        <PlopsPage />
      </PlopMotionContext.Provider>
    </Providers>,
  )
  return unmount
}

/** The page's motion with a seeded random source and a timer that counts what is pending (on the fake clock). */
function countedMotion(seed: number): PlopMotion & { pending: () => number } {
  const live = new Set<unknown>()
  return {
    ...defaultPlopMotion,
    random: seededRandom(seed),
    timer: {
      set(fn, ms) {
        const h = setTimeout(() => {
          live.delete(h)
          fn()
        }, ms)
        live.add(h)
        return h
      },
      clear(h) {
        live.delete(h)
        clearTimeout(h as ReturnType<typeof setTimeout>)
      },
    },
    pending: () => live.size,
  }
}

const RUNNING = usageData('30d', [
  vendor('claude', [model('opus', 1000, { failedSteps: 1 })], { failedSteps: 1, live: 1 }),
  vendor('codex', [model('gpt-5', 900, { live: 1 })], { live: 1 }),
  vendor('gemini', [model('pro', 800)], { limitHits24h: 1, live: 1 }),
])

const shown = (id: string): string => {
  const el = screen.getByTestId(id)
  return `${el.getAttribute('data-mood')}/${el.getAttribute('data-snack')}/${el.getAttribute('data-emit')}`
}

/** matchMedia that answers `reduce` for prefers-reduced-motion (and false for anything else). */
function reduceMotion(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

// ---- the Plop -------------------------------------------------------------------------------------------------------

describe('Plop', () => {
  it('is an image named for what it stands for, with its labels under it', () => {
    render(<Plop color="#54A0FF" growth={0.5} lines={['Sonnet', '1.10M tokens', '$3.40']} />)
    const img = screen.getByRole('img')
    expect(img.getAttribute('aria-label')).toBe('Sonnet, Plop Plop, idle')
    expect(img.getAttribute('viewBox')).toBe('0 0 200 200')
    expect(screen.getByText('1.10M tokens')).toBeTruthy()
    expect(screen.getByText('$3.40')).toBeTruthy()
  })

  it('animates the idle loop, and draws still without motion', () => {
    const { container, rerender } = render(<Plop color="#54A0FF" growth={0.5} />)
    expect(container.querySelectorAll('animateTransform').length).toBeGreaterThan(0)
    rerender(<Plop color="#54A0FF" growth={0.5} mood="happy" emit="oil" animated={false} />)
    expect(container.querySelectorAll('animate, animateTransform')).toHaveLength(0)
    // Still drawn: the oil puddle and the drip.
    expect(container.querySelectorAll('ellipse[fill="#2B2633"]').length).toBeGreaterThan(0)
  })

  it('waves when happy, closes its eyes with z’s when sleepy, bursts when growing', () => {
    const happy = buildPlop('#54A0FF', 0.5, 'happy', 'none', 'none')
    expect(happy.waveMarks).toHaveLength(2)
    expect(happy.armR.y2).toBeLessThan(happy.armR.oy)
    const sleepy = buildPlop('#54A0FF', 0.5, 'sleepy', 'none', 'none')
    expect(sleepy.zzz).toHaveLength(2)
    expect(sleepy.sleepy).toBe(true)
    const growing = buildPlop('#54A0FF', 0.5, 'growing', 'none', 'none')
    expect(growing.burst).toHaveLength(6)
    expect(growing.sparkles).toHaveLength(5)
  })

  it('changes proportions with growth: feet from 0.375, a fourth tier and a sparkle from 0.875', () => {
    const drop = buildPlop('#FF9F43', 0, 'idle', 'none', 'none')
    const plop = buildPlop('#FF9F43', 0.5, 'idle', 'none', 'none')
    const mega = buildPlop('#FF9F43', 1, 'idle', 'none', 'none')
    expect(drop.feet).toHaveLength(0)
    expect(plop.feet).toHaveLength(2)
    // A highlight per tier plus the tip's.
    expect(plop.highlights).toHaveLength(4)
    expect(mega.highlights).toHaveLength(5)
    expect(mega.sparkles).toHaveLength(2)
    expect(drop.body.startsWith('M100 180 ')).toBe(true)
    expect(mega.shadow.rx).toBeGreaterThan(drop.shadow.rx)
  })

  it('melts into a puddle on the same floor and in the same box, with only a slow shine and ripple', () => {
    const { container, rerender } = render(
      <Plop color="#7FC8D6" growth={0.6} mood="puddle" lines={['Legacy', '0 tokens', '$0.00']} size={148} />,
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('148')
    expect(svg?.getAttribute('height')).toBe('148')
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Legacy, Plop Plop, puddle')
    const puddle = container.querySelector('[data-plop-part="puddle"]')
    expect(puddle).not.toBeNull()
    // The melted body sits on the floor (y = 180), and nothing of the standing Plop is drawn: no arms, no eyes, no z's.
    expect(puddle?.querySelector('path')?.getAttribute('d')?.startsWith('M100 180 ')).toBe(true)
    expect(container.querySelectorAll('line')).toHaveLength(0)
    expect(container.querySelectorAll('text')).toHaveLength(0)
    // The shine pulses and the ripple spreads; the body itself never bobs.
    expect(container.querySelectorAll('animate, animateTransform')).toHaveLength(3)
    expect(container.querySelectorAll('svg > g[transform="translate(100 180)"]')).toHaveLength(0)
    rerender(<Plop color="#7FC8D6" growth={0.6} mood="puddle" size={148} animated={false} />)
    expect(container.querySelectorAll('animate, animateTransform')).toHaveLength(0)
    expect(container.querySelector('[data-plop-part="puddle"]')).not.toBeNull()
  })

  it('a puddle is wider the more it was used, and its shadow follows it', () => {
    const small = buildPlop('#7FC8D6', 0, 'puddle', 'none', 'none')
    const big = buildPlop('#7FC8D6', 1, 'puddle', 'none', 'none')
    expect(small.isPuddle).toBe(true)
    expect(small.shadow.rx).toBe(41)
    expect(big.shadow.rx).toBe(77)
    expect(big.pz[0]?.ring.rx).toBeGreaterThan(small.pz[0]?.ring.rx ?? Infinity)
    // Snacks and emissions are never drawn on a puddle, even if asked for.
    const asked = buildPlop('#7FC8D6', 0.5, 'puddle', 'metal', 'oil')
    const { container } = render(<Plop color="#7FC8D6" growth={0.5} mood="puddle" snack="metal" emit="oil" />)
    expect(asked.pz).toHaveLength(1)
    expect(container.querySelectorAll('ellipse[fill="#2B2633"]')).toHaveLength(0)
    expect(container.querySelectorAll('path[fill="#FFCF4A"]')).toHaveLength(0)
  })

  it('draws each emission and snack the design names', () => {
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'none', 'gas').em.puffs).toHaveLength(10)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'none', 'smoke').em.puffs).toHaveLength(3)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'none', 'steam').em.wisps).toHaveLength(3)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'none', 'oil').em.drips).toHaveLength(1)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'metal', 'none').sn.pile).toHaveLength(3)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'cord', 'none').sn.teeth).toHaveLength(2)
    expect(buildPlop('#A57BFF', 0.6, 'idle', 'water', 'none').sn.drops).toHaveLength(3)
  })
})

// ---- the lineup -----------------------------------------------------------------------------------------------------

describe('lineup', () => {
  it('scales vendors on one log scale, and the models with the vendor totals on another', () => {
    const l = buildLineup(MONTH)
    expect(l.map((v) => [v.vendor, v.name])).toEqual([
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ['gemini', 'Gemini'],
    ])
    expect(l[0]?.growth).toBe(1)
    expect(l[2]?.growth).toBe(0)
    expect(l[0]?.all.name).toBe('All Claude')
    // The models' floor: one scale over every model and vendor total, so "All Claude" is the largest and never
    // smaller than its own models; Gemini's default model the smallest.
    expect(l[0]?.all.growth).toBe(1)
    expect(l[0]?.models[0]?.growth).toBeLessThan(1)
    expect(l[0]?.models[0]?.growth).toBeGreaterThan(l[1]?.models[0]?.growth ?? 1)
    expect(l[2]?.models[0]?.growth).toBe(0)
    for (const v of l) for (const m of v.models) expect(v.all.growth).toBeGreaterThanOrEqual(m.growth)
    expect(l[2]?.models[0]?.name).toBe('Default model')
  })

  it('rests sleepy without usage in 24 hours, happy when usage is up, and grows once a stage is crossed', () => {
    const data = usageData('30d', [
      vendor('claude', [model('opus', 1_000_000)], {
        previous: { tokens: 1000, costUsd: null, costPartial: false, runs: 1 },
      }),
      vendor('gemini', [model('pro', 1000)], { lastUsedAt: NOW - 2 * 86_400_000 }),
    ])
    const [claude, gemini] = buildLineup(data)
    expect(claude).toMatchObject({ resting: 'happy', grew: true, stage: 'Mega' })
    expect(gemini).toMatchObject({ resting: 'sleepy', grew: false, stage: 'Drop' })
  })

  it('a Plop used before but with no tokens in the period is a puddle (beating sleepy), sized by its lifetime tokens on the active scale', () => {
    // The design's lineup: five active vendors and a sixth used only before this period.
    const raw: [string, number, number][] = [
      ['opus', 2_400_000, 2_400_000],
      ['sonnet', 1_100_000, 1_100_000],
      ['haiku', 380_000, 380_000],
      ['embed', 92_000, 92_000],
      ['vision', 12_000, 12_000],
      ['legacy', 0, 640_000],
    ]
    const vendors = raw.map(([id, tokens, lifetime]) =>
      vendor(id, [model(id, tokens, { lifetimeTokens: lifetime })], {
        lifetimeTokens: lifetime,
        ...(id === 'vision' || id === 'legacy' ? { lastUsedAt: NOW - 3 * 86_400_000 } : {}),
        ...(id === 'legacy'
          ? { failedSteps: 2, previous: { tokens: 900, costUsd: 1, costPartial: false, runs: 1 } }
          : {}),
      }),
    )
    const l = buildLineup(usageData('30d', vendors))
    const by = (id: string): VendorView => l.find((v) => v.vendor === id) as VendorView
    expect(by('vision').resting).toBe('sleepy')
    const legacy = by('legacy')
    expect(legacy).toMatchObject({
      resting: 'puddle',
      grew: false,
      emit: 'none',
      tokensText: '0 tokens',
      costText: '$0.00',
    })
    // The scale runs over the active Plops only: 12K is the floor, 2.4M the top.
    const lg = Math.log10
    expect(legacy.growth).toBeCloseTo((lg(640_000) - lg(12_000)) / (lg(2_400_000) - lg(12_000)), 6)
    expect(by('opus').growth).toBe(1)
    expect(by('vision').growth).toBe(0)
    // Without the puddle the others keep their sizes.
    const without = buildLineup(usageData('30d', vendors.slice(0, 5)))
    for (const v of without) expect(by(v.vendor).growth).toBe(v.growth)
    // Clamped to the scale: a puddle bigger than every active Plop is a Mega, one smaller than all of them a Drop.
    const clamp = (lifetime: number): number =>
      buildLineup(
        usageData('30d', [
          vendor('a', [model('a', 1000)]),
          vendor('b', [model('b', 100_000)]),
          vendor('p', [model('p', 0, { lifetimeTokens: lifetime })], { lifetimeTokens: lifetime }),
        ]),
      ).find((v) => v.vendor === 'p')?.growth ?? -1
    expect(clamp(50_000_000)).toBe(1)
    expect(clamp(10)).toBe(0)
    // Its model on the models' floor is a puddle too, and so is its "All" Plop.
    expect(legacy.all.resting).toBe('puddle')
    expect(legacy.models[0]?.resting).toBe('puddle')
    expect(plopLabel(legacy, 'puddle')).toBe(
      `legacy: 0 tokens, $0.00. ${legacy.stage} Plop, puddle (used before, no tokens in this period)`,
    )
  })

  it('a Plop running right now is not a puddle, even before its tokens are in', () => {
    const [codex] = buildLineup(
      usageData('30d', [
        vendor('codex', [model('gpt-5', 0, { lifetimeTokens: 900, live: 1, lastUsedAt: NOW })], {
          live: 1,
          lastUsedAt: NOW,
          lifetimeTokens: 900,
        }),
      ]),
    )
    expect(codex?.resting).not.toBe('puddle')
    expect(codex?.emit).toBe('gas')
  })

  it('words the cost: a price, at least a price, or none', () => {
    expect(costText({ tokens: 1, costUsd: 3.4, costPartial: false, runs: 1 })).toBe('$3.40')
    expect(costText({ tokens: 1, costUsd: 3.4, costPartial: true, runs: 1 })).toBe('At least $3.40')
    expect(costText({ tokens: 1, costUsd: null, costPartial: false, runs: 1 })).toBe('No price')
  })
})

// ---- the route --------------------------------------------------------------------------------------------------------

describe('route', () => {
  it('#/plops is the Plops page', () => {
    expect(parseHash('#/plops')).toEqual({ name: 'plops', query: {} })
    expect(href({ name: 'plops' })).toBe('#/plops')
    expect(parseHash('#/plops/extra').name).toBe('notFound')
  })
})

// ---- the page -------------------------------------------------------------------------------------------------------

describe('PlopsPage', () => {
  it('asks core for the last 30 days and shows one Plop per vendor, the first one drilled into', async () => {
    mountPage()
    expect(screen.getByTestId('plops-loading').textContent).toBe(PLOPS_LOADING)
    await settle()
    expect(mock.callsOf('usage.get')).toEqual([{ range: '30d' }])
    const row = screen.getByTestId('plops-vendors')
    expect(row.getAttribute('data-status')).toBe('ready')
    const buttons = within(row).getAllByRole('button', { pressed: false })
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'plops-range-7d',
      'plops-vendor-codex',
      'plops-vendor-gemini',
    ])
    expect(screen.getByTestId('plops-vendor-claude').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('plops-summary').textContent).toBe(
      '5.53M tokens · $5.53 · 3 runs, last 30 days',
    )
    const claude = within(screen.getByTestId('plops-vendor-claude')).getByRole('img')
    expect(claude.getAttribute('aria-label')).toBe('Claude: 3.50M tokens, $3.50. Mega Plop, idle')
    expect(screen.getByTestId('plops-vendor-gemini').textContent).toContain('1 model')
    // Gemini has not been used for three days.
    expect(screen.getByTestId('plops-vendor-plop-gemini').getAttribute('data-mood')).toBe('sleepy')
    const models = screen.getByTestId('plops-models')
    expect(within(models).getByRole('heading').textContent).toBe('Claude by model')
    expect(screen.getByTestId('plops-model-plop-all').textContent).toContain('All Claude')
  })

  it('switches between 30 and 7 days with buttons that keep their size', async () => {
    mountPage()
    await settle()
    const b30 = screen.getByTestId('plops-range-30d')
    const b7 = screen.getByTestId('plops-range-7d')
    const sizeOf = (el: HTMLElement): string =>
      el.className
        .split(' ')
        .filter((c) => /^(h-|px-|py-|text-\[|font-|rounded)/.test(c))
        .join(' ')
    const before = [sizeOf(b30), sizeOf(b7)]
    expect(b30.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(b7)
    // The old lineup stays while core answers.
    expect(screen.getByTestId('plops-vendors').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('plops-vendor-claude')).toBeTruthy()
    await settle()
    expect(mock.callsOf('usage.get')).toEqual([{ range: '30d' }, { range: '7d' }])
    expect(b7.getAttribute('aria-pressed')).toBe('true')
    expect(b30.getAttribute('aria-pressed')).toBe('false')
    expect([sizeOf(b30), sizeOf(b7)]).toEqual(before)
    expect(screen.queryByTestId('plops-vendor-claude')).toBeNull()
    expect(screen.getByTestId('plops-summary').textContent).toContain('last 7 days')
    // Claude is not in this period: the drill-down falls back to the first vendor.
    expect(screen.getByTestId('plops-models').getAttribute('data-vendor')).toBe('codex')
  })

  it('drills into a vendor: its models on one floor, after the "All" Plop', async () => {
    mountPage()
    await settle()
    fireEvent.click(screen.getByTestId('plops-vendor-codex'))
    expect(screen.getByTestId('plops-vendor-codex').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('plops-vendor-claude').getAttribute('aria-pressed')).toBe('false')
    const models = screen.getByTestId('plops-models')
    expect(within(models).getByRole('heading').textContent).toBe('Codex by model')
    const imgs = within(models).getAllByRole('img')
    expect(imgs.map((i) => i.getAttribute('aria-label')?.split(':')[0])).toEqual([
      'All Codex',
      'gpt-5-codex',
      'gpt-5',
    ])
    expect(imgs[1]?.getAttribute('aria-label')).toContain('1.60M tokens, $1.60')
  })

  it('shows an empty state when there is no usage in the period', async () => {
    mock.on('usage.get', ({ range }) => usageData(range, []))
    mountPage()
    await settle()
    const empty = screen.getByTestId('plops-empty')
    expect(empty.textContent).toContain('No AI usage in the last 30 days')
    expect(within(empty).getByRole('img').getAttribute('aria-label')).toContain('no usage yet')
    expect(screen.queryByTestId('plops-models')).toBeNull()
  })

  it('says when usage is not available', async () => {
    mock.on('usage.get', () => {
      throw mockError('UNSUPPORTED', 'Dashboard data is not available here.')
    })
    mountPage()
    await settle()
    expect(screen.getByTestId('plops-vendors').getAttribute('data-status')).toBe('error')
    expect(screen.getByText('Usage is not available')).toBeTruthy()
  })

  it('eats a snack, then plays growing once for a Plop that crossed a stage, then rests', async () => {
    const grown = usageData('30d', [
      vendor('claude', [model('opus', 1_000_000)], {
        previous: { tokens: 10, costUsd: null, costPartial: false, runs: 1 },
      }),
      vendor('codex', [model('gpt-5', 1000)]),
    ])
    mock.on('usage.get', () => grown)
    mountPage()
    await settle()
    const plop = (): HTMLElement => screen.getByTestId('plops-vendor-plop-claude')
    // First the snack, in its resting mood ...
    expect(plop().getAttribute('data-mood')).toBe('happy')
    const snack = plop().getAttribute('data-snack') as keyof typeof SNACK_MS
    expect(Object.keys(SNACK_MS)).toContain(snack)
    await settle(SNACK_MS[snack] - 1)
    expect(plop().getAttribute('data-snack')).toBe(snack)
    // ... then the growth spurt, the snack put away ...
    await settle(1)
    expect(plop().getAttribute('data-mood')).toBe('growing')
    expect(plop().getAttribute('data-snack')).toBe('none')
    // ... then rest.
    await settle(GROWING_MS)
    expect(plop().getAttribute('data-mood')).toBe('happy')
    expect(plop().getAttribute('data-snack')).toBe('none')
    // Again (the 7-day answer is the same here): it already played.
    fireEvent.click(screen.getByTestId('plops-range-7d'))
    fireEvent.click(screen.getByTestId('plops-range-30d'))
    await settle()
    expect(plop().getAttribute('data-mood')).toBe('happy')
  })

  it('under prefers-reduced-motion nothing animates and nothing plays', async () => {
    reduceMotion()
    const grown = usageData('30d', [
      vendor('claude', [model('opus', 1_000_000)], {
        previous: { tokens: 10, costUsd: null, costPartial: false, runs: 1 },
      }),
      vendor('codex', [model('gpt-5', 1000)]),
    ])
    mock.on('usage.get', () => grown)
    mountPage()
    await settle()
    expect(screen.getByTestId('plops-vendor-plop-claude').getAttribute('data-mood')).toBe('happy')
    expect(document.querySelectorAll('animate, animateTransform')).toHaveLength(0)
  })

  it('emits from the step signals: oil for failures, gas while running, steam at a limit', async () => {
    mock.on('usage.get', () =>
      usageData('30d', [
        vendor('claude', [model('opus', 1000, { failedSteps: 1 })], { failedSteps: 1 }),
        vendor('codex', [model('gpt-5', 900)], { live: 1 }),
        vendor('gemini', [model('pro', 800)], { limitHits24h: 1 }),
      ]),
    )
    mountPage()
    await settle()
    const emit = (id: string): string | null =>
      screen.getByTestId(`plops-vendor-plop-${id}`).getAttribute('data-emit')
    expect(emit('claude')).toBe('oil')
    expect(['gas', 'smoke']).toContain(emit('codex'))
    expect(emit('gemini')).toBe('steam')
    expect(
      within(screen.getByTestId('plops-vendor-claude')).getByRole('img').getAttribute('aria-label'),
    ).toContain('giving off oil (failed steps or re-runs)')
    // The name says what running means, whichever of gas or smoke is drawn.
    expect(
      within(screen.getByTestId('plops-vendor-codex')).getByRole('img').getAttribute('aria-label'),
    ).toContain('giving off gas or smoke (running now)')
  })

  it('rotates snacks and gas or smoke while steps run, out of step, with oil and steam taking priority', async () => {
    mock.on('usage.get', () => RUNNING)
    mountPage()
    await settle()
    const id = 'plops-vendor-plop-codex'
    const seen = [shown(id)]
    const box = (): string => {
      const el = screen.getByTestId(id)
      return `${el.style.width}|${el.querySelector('svg')?.getAttribute('width')}|${el.querySelector('svg')?.getAttribute('height')}`
    }
    const size = box()
    for (let i = 0; i < 12; i++) {
      await settle(ROTATE_MAX_MS)
      seen.push(shown(id))
      // The Plop's box never changes size, whatever it shows.
      expect(box()).toBe(size)
    }
    // Holds are 5 to 9 s, so over 108 s it shows many different items.
    expect(new Set(seen).size).toBeGreaterThanOrEqual(5)
    const parts = seen.map((s) => s.split('/'))
    for (const [mood, snack, emit] of parts) {
      expect(mood).toBe('idle')
      expect(['none', 'metal', 'cord', 'bolt', 'water']).toContain(snack)
      expect(['none', 'gas', 'smoke']).toContain(emit)
      expect(snack !== 'none' || emit !== 'none').toBe(true)
    }
    expect(parts.some((p) => p[1] !== 'none')).toBe(true)
    expect(parts.some((p) => p[2] !== 'none')).toBe(true)
    // Oil (failed steps) and steam (a limit) beat running: those Plops hold still on their emission.
    expect(shown('plops-vendor-plop-claude')).toBe('idle/none/oil')
    expect(shown('plops-vendor-plop-gemini')).toBe('idle/none/steam')
  })

  it('changes running Plops out of step with each other', async () => {
    mock.on('usage.get', () =>
      usageData('30d', [
        vendor('codex', [model('gpt-5', 900, { live: 1 }), model('gpt-5-codex', 800, { live: 1 })], {
          live: 2,
        }),
      ]),
    )
    mountPage()
    await settle()
    const ids = [
      'plops-vendor-plop-codex',
      'plops-model-plop-all',
      'plops-model-plop-0',
      'plops-model-plop-1',
    ]
    // Step through the first 9 s in 100 ms ticks and note when each Plop first changes.
    const start = ids.map(shown)
    const firstChange = ids.map(() => -1)
    for (let t = 100; t <= ROTATE_MAX_MS; t += 100) {
      await settle(100)
      ids.forEach((id, i) => {
        if (firstChange[i] === -1 && shown(id) !== start[i]) firstChange[i] = t
      })
    }
    expect(firstChange.every((t) => t > 0)).toBe(true)
    expect(new Set(firstChange).size).toBeGreaterThan(1)
  })

  it('stops its timers on unmount and while the page is hidden', async () => {
    mock.on('usage.get', () => RUNNING)
    let hidden = false
    const listeners = new Set<() => void>()
    const motion = {
      ...countedMotion(5),
      hidden: () => hidden,
      onVisibilityChange: (cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const unmount = mountPage(motion)
    await settle()
    // Only Codex rotates (Claude, drilled into, shows oil; Gemini steam).
    expect(motion.pending()).toBeGreaterThan(0)
    hidden = true
    act(() => listeners.forEach((cb) => cb()))
    expect(motion.pending()).toBe(0)
    const frozen = shown('plops-vendor-plop-codex')
    await settle(3 * ROTATE_MAX_MS)
    expect(shown('plops-vendor-plop-codex')).toBe(frozen)
    hidden = false
    act(() => listeners.forEach((cb) => cb()))
    expect(motion.pending()).toBeGreaterThan(0)
    await settle(ROTATE_MAX_MS)
    expect(shown('plops-vendor-plop-codex')).not.toBe(frozen)
    unmount()
    expect(motion.pending()).toBe(0)
    expect(listeners.size).toBe(0)
  })

  it('under reduced motion holds one still pose that still shows running', async () => {
    reduceMotion()
    mock.on('usage.get', () => RUNNING)
    const motion = countedMotion(3)
    mountPage(motion)
    await settle()
    const id = 'plops-vendor-plop-codex'
    const pose = shown(id)
    expect(['idle/none/gas', 'idle/none/smoke']).toContain(pose)
    expect(motion.pending()).toBe(0)
    await settle(3 * ROTATE_MAX_MS)
    expect(shown(id)).toBe(pose)
    expect(document.querySelectorAll('animate, animateTransform')).toHaveLength(0)
    // The puff is drawn, just still.
    expect(screen.getByTestId(id).querySelectorAll('g[transform^="translate"] path').length).toBeGreaterThan(
      0,
    )
  })

  it('shows a puddle in the same tile on the same floor: no rotation, no growth, nothing pending for it', async () => {
    // Claude is sleepy here (not used in the last 24 hours), so nothing on the page snacks either.
    const sleepy = { lastUsedAt: NOW - 3 * 86_400_000 }
    const data = usageData('30d', [
      vendor('claude', [model('opus', 1_000_000, sleepy)], sleepy),
      vendor('codex', [model('gpt-5', 0, { lifetimeTokens: 500_000, lastUsedAt: NOW - 40 * 86_400_000 })], {
        lifetimeTokens: 500_000,
        lastUsedAt: NOW - 40 * 86_400_000,
        failedSteps: 1,
        previous: { tokens: 400_000, costUsd: 2, costPartial: false, runs: 3 },
      }),
    ])
    mock.on('usage.get', () => data)
    const motion = countedMotion(9)
    mountPage(motion)
    await settle()
    const puddle = screen.getByTestId('plops-vendor-plop-codex')
    expect(shown('plops-vendor-plop-codex')).toBe('puddle/none/none')
    expect(puddle.querySelector('[data-plop-part="puddle"]')).not.toBeNull()
    expect(within(screen.getByTestId('plops-vendor-codex')).getByRole('img').getAttribute('aria-label')).toBe(
      `Codex: 0 tokens, $0.00. ${puddle.getAttribute('data-stage')} Plop, puddle (used before, no tokens in this period)`,
    )
    // The same box as an active Plop beside it, and the same label lines.
    const box = (id: string): string => {
      const el = screen.getByTestId(id)
      const svg = el.querySelector('svg')
      return `${el.style.width}|${svg?.getAttribute('width')}|${svg?.getAttribute('height')}|${el.querySelectorAll('[data-plop-line]').length}`
    }
    expect(box('plops-vendor-plop-codex')).toBe(box('plops-vendor-plop-claude'))
    // Nothing plays on its own: no snack, no growth, no rotation, at any time.
    expect(motion.pending()).toBe(0)
    await settle(3 * ROTATE_MAX_MS)
    expect(shown('plops-vendor-plop-codex')).toBe('puddle/none/none')
    // Its models' floor: the "All" Plop and its model are puddles too.
    fireEvent.click(screen.getByTestId('plops-vendor-codex'))
    expect(screen.getByTestId('plops-model-plop-all').getAttribute('data-mood')).toBe('puddle')
    expect(screen.getByTestId('plops-model-plop-0').getAttribute('data-mood')).toBe('puddle')
    expect(motion.pending()).toBe(0)
  })

  it('snacks at random while in use: random times and snacks, out of step, at most half at once, sizes fixed', async () => {
    // Claude and Codex were used an hour ago (in use: idle); Gemini three days ago (sleepy: never snacks).
    const motion = countedMotion(31)
    mountPage(motion)
    await settle()
    const inUse = [
      'plops-vendor-plop-claude',
      'plops-vendor-plop-codex',
      'plops-model-plop-all',
      'plops-model-plop-0',
      'plops-model-plop-1',
    ]
    const sleepy = 'plops-vendor-plop-gemini'
    expect(shown(sleepy)).toBe('sleepy/none/none')
    const box = (id: string): string => {
      const el = screen.getByTestId(id)
      const svg = el.querySelector('svg')
      return `${el.style.width}|${svg?.getAttribute('width')}|${svg?.getAttribute('height')}|${el.querySelectorAll('[data-plop-line]').length}`
    }
    const sizes = inUse.map(box)
    const tile = screen.getByTestId('plops-vendor-claude').className
    for (const id of inUse) expect(shown(id)).toBe('idle/none/none')
    // Step 3 minutes in 100 ms ticks, noting each Plop's snacks and when it first eats.
    const eaten = inUse.map(() => [] as string[])
    const firstAt = inUse.map(() => -1)
    let most = 0
    for (let t = 100; t <= 180_000; t += 100) {
      await settle(100)
      let now = 0
      inUse.forEach((id, i) => {
        const [mood, snack, emit] = shown(id).split('/')
        expect(mood).toBe('idle')
        expect(emit).toBe('none')
        if (snack !== 'none') {
          now++
          if (firstAt[i] === -1) firstAt[i] = t
          if (eaten[i]!.at(-1) !== snack || eaten[i]!.length === 0) eaten[i]!.push(snack!)
        }
      })
      most = Math.max(most, now)
      expect(shown(sleepy)).toBe('sleepy/none/none')
    }
    // Every Plop in use ate, its first within the first offset, out of step with the others.
    for (const t of firstAt) {
      expect(t).toBeGreaterThan(0)
      expect(t).toBeLessThanOrEqual(NIBBLE_FIRST_MAX_MS + NIBBLE_GAP_MAX_MS)
    }
    expect(new Set(firstAt).size).toBe(inUse.length)
    // Several snacks each, more than one kind, never the same one twice in a row.
    for (const list of eaten) {
      expect(list.length).toBeGreaterThanOrEqual(4)
      expect(new Set(list).size).toBeGreaterThan(1)
      for (let i = 1; i < list.length; i++) expect(list[i]).not.toBe(list[i - 1])
    }
    // Five Plops snack here: at most two eat at the same moment.
    expect(most).toBeGreaterThanOrEqual(1)
    expect(most).toBeLessThanOrEqual(2)
    // Nothing changed size.
    expect(inUse.map(box)).toEqual(sizes)
    expect(screen.getByTestId('plops-vendor-claude').className).toBe(tile)
  })

  it('never gives a random snack to a Plop with failures (oil) or a limit (steam)', async () => {
    mock.on('usage.get', () =>
      usageData('30d', [
        vendor('claude', [model('opus', 1000, { failedSteps: 1 })], { failedSteps: 1 }),
        vendor('codex', [model('gpt-5', 900)]),
        vendor('gemini', [model('pro', 800, { limitHits24h: 1 })], { limitHits24h: 1 }),
      ]),
    )
    mountPage(countedMotion(17))
    await settle()
    const held = {
      'plops-vendor-plop-claude': 'idle/none/oil',
      'plops-model-plop-all': 'idle/none/oil',
      'plops-model-plop-0': 'idle/none/oil',
      'plops-vendor-plop-gemini': 'idle/none/steam',
    }
    let codexAte = false
    for (let t = 0; t < 120_000; t += 250) {
      await settle(250)
      for (const [id, pose] of Object.entries(held)) expect(shown(id)).toBe(pose)
      if (shown('plops-vendor-plop-codex') !== 'idle/none/none') codexAte = true
    }
    // Codex, in use with nothing to show, snacked meanwhile; with only it in the pool it was never held back.
    expect(codexAte).toBe(true)
  })

  it('puts a snack away and stops its timers while hidden, and on unmount', async () => {
    let hidden = false
    const listeners = new Set<() => void>()
    const motion = {
      ...countedMotion(12),
      hidden: () => hidden,
      onVisibilityChange: (cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const unmount = mountPage(motion)
    await settle()
    const id = 'plops-vendor-plop-codex'
    for (let t = 0; t < 60_000 && shown(id) === 'idle/none/none'; t += 100) await settle(100)
    expect(shown(id)).not.toBe('idle/none/none')
    hidden = true
    act(() => listeners.forEach((cb) => cb()))
    expect(motion.pending()).toBe(0)
    await settle(60_000)
    hidden = false
    act(() => listeners.forEach((cb) => cb()))
    expect(shown(id)).toBe('idle/none/none')
    expect(motion.pending()).toBeGreaterThan(0)
    unmount()
    expect(motion.pending()).toBe(0)
    expect(listeners.size).toBe(0)
  })

  it('under reduced motion nothing snacks at rest', async () => {
    reduceMotion()
    const motion = countedMotion(31)
    mountPage(motion)
    await settle()
    expect(motion.pending()).toBe(0)
    await settle(60_000)
    for (const id of ['plops-vendor-plop-claude', 'plops-vendor-plop-codex', 'plops-model-plop-0'])
      expect(shown(id)).toBe('idle/none/none')
  })

  it('explains the puddle and the models with no Plop in "Reading the Plops"', async () => {
    mountPage()
    await settle()
    const terms = LEGEND.map((l) => l.term)
    expect(terms).toContain('Puddle')
    expect(terms).toContain('No Plop')
    expect(terms).toContain('Snacks')
    expect(LEGEND.find((l) => l.term === 'Snacks')?.desc).toContain('at random')
    for (const l of LEGEND) {
      expect(screen.getByText(l.term)).toBeTruthy()
      expect(l.desc).not.toContain('—')
    }
    expect(LEGEND.find((l) => l.term === 'Puddle')?.desc).toContain('no tokens in this period')
  })

  it('uses the dark shadow under the app’s dark theme', async () => {
    act(() => setThemeState({ theme: 'dark', resolved: 'dark', accent: 'slate' }))
    mountPage()
    await settle()
    const shadow = screen.getByTestId('plops-vendor-plop-claude').querySelector('svg > ellipse')
    expect(shadow?.getAttribute('fill')).toBe('rgba(0, 0, 0, 0.45)')
  })

  it('keeps the loading room while core answers, with no em dash anywhere', async () => {
    const held = deferred<UsageData>()
    mock.on('usage.get', () => held.promise)
    mountPage()
    await settle()
    expect(screen.getByTestId('plops-vendors').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('plops-loading').className).toContain('min-h-')
    held.resolve(MONTH)
    await settle()
    expect(document.body.textContent?.includes('—')).toBe(false)
    for (const img of screen.getAllByRole('img'))
      expect(img.getAttribute('aria-label')?.includes('—')).toBe(false)
  })
})
