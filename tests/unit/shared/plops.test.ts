// The Plop rules (src/shared/plops.ts): HSL color derivation from one base hex, the fixed Claude and Codex families
// and the hashed hue for other vendors, the log scale from usage to growth with its five stages, and the mood and
// emission rules.
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_FAMILY,
  CODEX_FAMILY,
  RESERVED_HUE_BANDS,
  SLEEPY_AFTER_MS,
  crossedStage,
  hashHue,
  hexToRgb,
  hslCss,
  hslHex,
  isPuddle,
  logScale,
  modelColor,
  plopEmit,
  plopPalette,
  restingMood,
  rgbToHsl,
  stageIndex,
  stageOf,
  vendorColor,
} from '@shared/plops.ts'

/** [h, s%, l%] of an `hsl(h, s%, l%)` string. */
function parts(css: string): [number, number, number] {
  const m = /^hsl\(([\d.]+), ([\d.]+)%, ([\d.]+)%\)$/.exec(css)
  if (m === null) throw new Error(`not an hsl() color: ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe('color derivation', () => {
  it('reads #RGB and #RRGGBB hex; anything else is the default orange', () => {
    expect(hexToRgb('#FF9F43')).toEqual([255, 159, 67])
    expect(hexToRgb('fff')).toEqual([255, 255, 255])
    expect(hexToRgb('#nothex')).toEqual([255, 159, 67])
  })

  it('converts RGB to HSL and back to hex', () => {
    expect(rgbToHsl([255, 0, 0])).toEqual([0, 1, 0.5])
    const [h, s, l] = rgbToHsl([84, 160, 255])
    expect(hslHex(h, s, l)).toBe('#54a0ff')
    expect(hslHex(120, 1, 0.5)).toBe('#00ff00')
    expect(hslHex(0, 0, 1)).toBe('#ffffff')
  })

  it('wraps the hue and clamps saturation and lightness in hsl()', () => {
    expect(hslCss(-10, 1.5, -0.2)).toBe('hsl(350, 100%, 0%)')
    expect(hslCss(370, 0.5, 0.25)).toBe('hsl(10, 50%, 25%)')
  })

  it('derives crown, deep, stroke and blush from the base in HSL', () => {
    const [H, S, L] = rgbToHsl(hexToRgb('#54A0FF'))
    const p = plopPalette('#54A0FF')
    const mid = parts(p.mid)
    expect(mid[0]).toBeCloseTo(H, 1)
    expect(mid[2]).toBeCloseTo(L * 100, 1)
    // crown: lightness toward 97% by 52%, hue −4.
    const crown = parts(p.crown)
    expect(crown[2]).toBeCloseTo((L + (0.97 - L) * 0.52) * 100, 1)
    expect(crown[0]).toBeCloseTo(H - 4, 1)
    // deep: lightness × 0.8, hue +6; stroke: lightness × 0.42, hue +8.
    expect(parts(p.deep)[2]).toBeCloseTo(L * 80, 1)
    expect(parts(p.deep)[0]).toBeCloseTo(H + 6, 1)
    expect(parts(p.stroke)[2]).toBeCloseTo(L * 42, 1)
    expect(parts(p.stroke)[1]).toBeCloseTo(Math.min(1, S * 0.85 + 0.1) * 100, 1)
    // The outline is a deeper shade of the body, never black.
    expect(parts(p.stroke)[2]).toBeGreaterThan(0)
    expect(p.blush).toBe('hsl(345, 95%, 72%)')
  })

  it('gives pink and red bases a deeper red blush', () => {
    expect(plopPalette('#FF7EB6').blush).toBe('hsl(352, 95%, 60%)')
    expect(plopPalette('#FF9F43').blush).toBe('hsl(345, 95%, 72%)')
  })
})

describe('vendor and model colors', () => {
  it('Claude and Codex keep their fixed families', () => {
    expect(vendorColor('claude')).toBe(CLAUDE_FAMILY.base)
    expect(vendorColor('codex')).toBe(CODEX_FAMILY.base)
    expect(modelColor('claude', 'claude-opus-4-1', 3)).toBe('#E0662F')
    expect(modelColor('claude', 'claude-sonnet-4-5', 0)).toBe('#F2995E')
    expect(modelColor('claude', 'claude-haiku-4-5', 0)).toBe('#F7BC86')
    expect(modelColor('codex', 'gpt-5-codex', 0)).toBe(CODEX_FAMILY.models[0])
    expect(modelColor('codex', 'gpt-5', 1)).toBe(CODEX_FAMILY.models[1])
  })

  it('a Claude model outside the named ones stays in the warm band; a third Codex model in the cool one', () => {
    const [h] = rgbToHsl(hexToRgb(modelColor('claude', null, 1)))
    expect(h).toBeGreaterThanOrEqual(10)
    expect(h).toBeLessThanOrEqual(45)
    const [hc] = rgbToHsl(hexToRgb(modelColor('codex', 'o4-mini', 2)))
    expect(hc).toBeGreaterThan(205)
    expect(hc).toBeLessThan(240)
  })

  it('other vendors get a stable hashed hue outside the Claude and Codex bands', () => {
    const names = ['gemini', 'grok', 'muse', 'local-llama', 'mistral', 'a', 'b', 'zeta', 'qwen', 'deepseek']
    for (const n of names) {
      const hue = hashHue(n)
      expect(hue).toBe(hashHue(n))
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
      for (const [lo, hi] of RESERVED_HUE_BANDS) expect(hue >= lo && hue <= hi, `${n}: ${hue}`).toBe(false)
      expect(vendorColor(n)).toBe(hslHex(hue, 0.68, 0.64))
    }
    expect(hashHue('gemini')).not.toBe(hashHue('grok'))
    // FNV-1a: the empty name is the offset basis mod 360.
    expect(hashHue('')).toBe(2166136261 % 360)
  })

  it('models of a generated vendor step their hue and lightness by rank', () => {
    const a = modelColor('gemini', 'pro', 0)
    const b = modelColor('gemini', 'flash', 1)
    expect(a).toBe(hslHex(hashHue('gemini'), 0.68, 0.58))
    expect(b).toBe(hslHex((hashHue('gemini') + 16) % 360, 0.68, 0.66))
  })
})

describe('growth scale and stages', () => {
  it('maps usage on a log scale across the lineup', () => {
    const g = logScale([100, 10_000, 1_000])
    expect(g(100)).toBe(0)
    expect(g(10_000)).toBe(1)
    expect(g(1_000)).toBeCloseTo(0.5, 10)
    // Outside the lineup (a previous period): clamped.
    expect(g(0)).toBe(0)
    expect(g(1e9)).toBe(1)
  })

  it('one value, or all equal, sits in the middle', () => {
    expect(logScale([5000])(5000)).toBe(0.5)
    expect(logScale([7, 7])(7)).toBe(0.5)
    expect(logScale([])(10)).toBe(0.5)
  })

  it('a 200× spread still shows all five stages', () => {
    const values = [0, 1, 2, 3, 4].map((k) => 1000 * Math.pow(200, k / 4))
    const g = logScale(values)
    expect(values.map((v) => stageOf(g(v)))).toEqual(['Drop', 'Sprout', 'Plop', 'Chonk', 'Mega'])
  })

  it('stage = round(growth × 4)', () => {
    expect([0, 0.12, 0.13, 0.5, 0.62, 0.63, 0.874, 1].map(stageIndex)).toEqual([0, 0, 1, 2, 2, 3, 3, 4])
    expect(stageIndex(-1)).toBe(0)
    expect(stageIndex(2)).toBe(4)
  })
})

describe('moods', () => {
  const NOW = 1_000_000_000
  it('sleepy without usage in the last 24 hours, whatever the totals', () => {
    expect(restingMood({ tokens: 10, previousTokens: 0, lastUsedAt: null, now: NOW })).toBe('sleepy')
    expect(
      restingMood({ tokens: 10, previousTokens: 0, lastUsedAt: NOW - SLEEPY_AFTER_MS - 1, now: NOW }),
    ).toBe('sleepy')
  })

  it('happy when usage is up against the previous period, else idle', () => {
    expect(restingMood({ tokens: 11, previousTokens: 10, lastUsedAt: NOW - 1000, now: NOW })).toBe('happy')
    expect(restingMood({ tokens: 10, previousTokens: 10, lastUsedAt: NOW - 1000, now: NOW })).toBe('idle')
    expect(restingMood({ tokens: 5, previousTokens: 10, lastUsedAt: NOW - SLEEPY_AFTER_MS, now: NOW })).toBe(
      'idle',
    )
  })

  it('a puddle when used before but with no tokens in the period, beating sleepy', () => {
    const before = { previousTokens: 0, lastUsedAt: null, now: NOW, lifetimeTokens: 640_000 }
    expect(restingMood({ tokens: 0, ...before })).toBe('puddle')
    // A puddle even though the previous period had usage and the last use is old (sleepy otherwise).
    expect(
      restingMood({ ...before, tokens: 0, previousTokens: 500, lastUsedAt: NOW - 3 * SLEEPY_AFTER_MS }),
    ).toBe('puddle')
    expect(isPuddle({ tokens: 0, lifetimeTokens: 1 })).toBe(true)
    // Any tokens in the period: not a puddle (sleepy here, no use in 24 hours).
    expect(restingMood({ ...before, tokens: 1 })).toBe('sleepy')
    // Never used: not a puddle.
    expect(restingMood({ ...before, tokens: 0, lifetimeTokens: 0 })).toBe('sleepy')
    expect(restingMood({ tokens: 0, previousTokens: 0, lastUsedAt: null, now: NOW })).toBe('sleepy')
    // Running right now (its tokens not reported yet): not a puddle.
    expect(restingMood({ ...before, tokens: 0, live: 1, lastUsedAt: NOW })).toBe('idle')
  })

  it('growing when it crossed into a bigger stage since the previous period', () => {
    expect(crossedStage(0.5, 0.2)).toBe(true)
    expect(crossedStage(0.5, 0.4)).toBe(false)
    expect(crossedStage(0.2, 0.9)).toBe(false)
  })
})

describe('emissions', () => {
  const none = { limitHits24h: 0, failedSteps: 0, reruns: 0, live: 0 }
  it('steam for a limit hit, oil for failures or re-runs, gas while running, the most pressing first', () => {
    expect(plopEmit(none)).toBe('none')
    expect(plopEmit({ ...none, live: 2 })).toBe('gas')
    expect(plopEmit({ ...none, reruns: 1, live: 2 })).toBe('oil')
    expect(plopEmit({ ...none, failedSteps: 1 })).toBe('oil')
    expect(plopEmit({ ...none, limitHits24h: 1, failedSteps: 1, live: 1 })).toBe('steam')
  })
})
