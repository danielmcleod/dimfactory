// Contrast across every theme × accent (theming: "A contrast test checks every theme × accent pair
// at ≥ 4.5:1"). The colours are computed from styles/tokens.css itself: OKLCH → sRGB (clipped to the
// gamut per channel, as Chromium draws it), translucent tints composited over their surface in sRGB, then WCAG 2
// relative luminance and contrast. Text pairs need 4.5:1 (all of the app's text is normal size); the focus ring and a
// filled control's edge against the page are UI parts and need 3:1 (WCAG 1.4.11). The Diff tab's syntax colours
// (Shiki themes, components/diff/diffTheme.ts) are text too: every token colour of both themes, as the highlighter
// resolves them, on the card, the added and deleted line backgrounds and a changed word's emphasis, from tokens.css.
import { resolveTheme } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  BASE_THEMES,
  DIFF_SURFACES,
  DIFF_THEMES,
  parseHex,
  registerDiffThemes,
} from '@renderer/components/diff/diffTheme.ts'
import { readSource } from '../helpers/readSource.ts'

type Oklch = [number, number, number]
type Rgb = [number, number, number]

const ACCENTS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet'] as const
const THEMES = ['light', 'dark'] as const
const STATUSES = [
  'queued',
  'running',
  'waiting',
  'stalled',
  'paused',
  'done',
  'skipped',
  'failed',
  'cancelled',
]

/** Every rule's custom properties, by each selector of its selector list. */
function blocks(css: string): Map<string, Record<string, Oklch>> {
  const out = new Map<string, Record<string, Oklch>>()
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of noComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const vars: Record<string, Oklch> = {}
    for (const v of m[2]!.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
      vars[v[1]!] = [Number(v[2]), Number(v[3]), Number(v[4])]
    }
    for (const sel of m[1]!.split(',').map((s) => s.trim())) out.set(sel, { ...out.get(sel), ...vars })
  }
  return out
}

/** OKLCH → gamma-encoded sRGB in [0, 1], each linear channel clipped to the gamut. */
function srgb([L, C, h]: Oklch): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clip = (x: number): number => Math.min(1, Math.max(0, x))
  const enc = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return [
    enc(clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    enc(clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    enc(clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ]
}

/** `fg` at `alpha` drawn over `bg` (Tailwind's `bg-x/15`). */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb
}

function luminance(c: Rgb): number {
  const lin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

function contrast(x: Rgb, y: Rgb): number {
  const [a, b] = [luminance(x), luminance(y)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const all = blocks(readSource('src/renderer/src/styles/tokens.css'))

/** The tokens in force on <html> for a theme and an accent (`.dark` and `data-accent` on the same element). */
function tokensFor(theme: (typeof THEMES)[number], accent: (typeof ACCENTS)[number]): Record<string, Oklch> {
  const light = all.get(':root') ?? {}
  return theme === 'light'
    ? { ...light, ...all.get(`[data-accent='${accent}']`) }
    : { ...light, ...all.get('.dark'), ...all.get(`.dark[data-accent='${accent}']`) }
}

interface Pair {
  name: string
  fg: (c: (t: string) => Rgb) => Rgb
  bg: (c: (t: string) => Rgb) => Rgb
  min: number
}

const TEXT = 4.5
const UI = 3

const on = (fg: string, bg: string, min = TEXT): Pair => ({
  name: `${fg} on ${bg}`,
  fg: (c) => c(fg),
  bg: (c) => c(bg),
  min,
})
/** Text in a box tinted with `tint` at `alpha` over `surface` (badges `bg-st-x/15 text-st-x`, notes `bg-x/5`). */
const onTint = (fg: string, tint: string, alpha: number, surface: string): Pair => ({
  name: `${fg} on ${tint}/${Math.round(alpha * 100)} over ${surface}`,
  fg: (c) => c(fg),
  bg: (c) => over(c(tint), alpha, c(surface)),
  min: TEXT,
})

const SURFACES = ['background', 'card', 'popover', 'muted', 'accent', 'secondary']
const COLOURED_TEXT = ['destructive', 'success', 'warning', 'info', 'auto', ...STATUSES.map((s) => `st-${s}`)]

const PAIRS: Pair[] = [
  // Body and muted text on every surface; each surface's own foreground.
  ...SURFACES.flatMap((s) => [on('foreground', s), on('muted-foreground', s)]),
  on('card-foreground', 'card'),
  on('popover-foreground', 'popover'),
  on('accent-foreground', 'accent'),
  on('secondary-foreground', 'secondary'),
  onTint('muted-foreground', 'muted', 0.5, 'background'),
  // The accent: button text on the button (and its hover), links on the surfaces they sit on.
  on('primary-foreground', 'primary'),
  {
    name: 'primary-foreground on primary/90 over background (hover)',
    fg: (c) => c('primary-foreground'),
    bg: (c) => over(c('primary'), 0.9, c('background')),
    min: TEXT,
  },
  ...['background', 'card', 'popover', 'muted', 'accent'].map((s) => on('primary', s)),
  on('destructive-foreground', 'destructive'),
  // Status, AUTO and the other coloured text: on the page and cards, on their own badge tint, and the muted text of
  // a note box tinted with them.
  ...COLOURED_TEXT.flatMap((t) => [
    on(t, 'background'),
    on(t, 'card'),
    on(t, 'muted'),
    onTint(t, t, 0.15, 'card'),
    onTint(t, t, 0.15, 'background'),
    onTint('foreground', t, 0.05, 'card'),
    onTint('muted-foreground', t, 0.05, 'card'),
  ]),
  // Diff lines: coloured text on the page and on its own line background; plain and muted text on both.
  ...['add', 'del'].flatMap((d) => [
    on(`diff-${d}`, 'background'),
    on(`diff-${d}`, 'card'),
    on(`diff-${d}`, `diff-${d}-bg`),
    on('foreground', `diff-${d}-bg`),
    on('muted-foreground', `diff-${d}-bg`),
  ]),
  // UI parts: the focus ring, and a filled control (a checked switch or box, the primary button) against the page.
  on('ring', 'background', UI),
  on('ring', 'card', UI),
  on('ring', 'muted', UI),
  on('primary', 'background', UI),
]

describe('contrast: every theme × accent pair (tokens.css)', () => {
  it('reads a light and a dark block for every accent', () => {
    for (const a of ACCENTS) {
      expect(all.get(`[data-accent='${a}']`)?.['primary'], a).toBeDefined()
      expect(all.get(`.dark[data-accent='${a}']`)?.['primary'], a).toBeDefined()
    }
  })

  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      it(`${theme} × ${accent}: text at 4.5:1 or more, focus ring and filled controls at 3:1 or more`, () => {
        const t = tokensFor(theme, accent)
        const c = (name: string): Rgb => {
          const v = t[name]
          if (v === undefined) throw new Error(`--${name} is not defined for ${theme} × ${accent}`)
          return srgb(v)
        }
        const failures = PAIRS.flatMap((p) => {
          const r = contrast(p.fg(c), p.bg(c))
          return r < p.min ? [`${p.name}: ${r.toFixed(2)} < ${p.min}`] : []
        })
        expect(failures, `${theme} × ${accent}`).toEqual([])
      })
    }
  }

  it('the maths agrees with known values (black on white 21:1, white on white 1:1, #767676 on white 4.54:1)', () => {
    const white = srgb([1, 0, 0])
    const black = srgb([0, 0, 0])
    expect(contrast(black, white)).toBeCloseTo(21, 1)
    expect(contrast(white, white)).toBeCloseTo(1, 5)
    const grey: Rgb = [0x76 / 255, 0x76 / 255, 0x76 / 255]
    expect(contrast(grey, white)).toBeCloseTo(4.54, 2)
  })

  it('would catch a failing token: a light grey on white fails, the same tint composited fails too', () => {
    const white = srgb([1, 0, 0])
    expect(contrast(srgb([0.75, 0, 0]), white)).toBeLessThan(TEXT)
    expect(contrast(srgb([0.48, 0.19, 27]), over(srgb([0.48, 0.19, 27]), 0.9, white))).toBeLessThan(TEXT)
  })
})

// ---- the diff view's syntax colours --------------------------------------------------------------------------------

/** A changed word's background: the line colour at 15% (light) or 20% (dark) over the line (@pierre/diffs' CSS). */
const EMPHASIS = { light: 0.15, dark: 0.2 } as const

/** The surfaces diff text is drawn on, from tokens.css. */
function diffSurfaces(theme: (typeof THEMES)[number], accent: (typeof ACCENTS)[number]): Record<string, Rgb> {
  const t = tokensFor(theme, accent)
  const c = (name: string): Rgb => {
    const v = t[name]
    if (v === undefined) throw new Error(`--${name} is not defined for ${theme}`)
    return srgb(v)
  }
  return {
    card: c('card'),
    'diff-add-bg': c('diff-add-bg'),
    'diff-del-bg': c('diff-del-bg'),
    'diff-add-emphasis': over(c('diff-add'), EMPHASIS[theme], c('diff-add-bg')),
    'diff-del-emphasis': over(c('diff-del'), EMPHASIS[theme], c('diff-del-bg')),
  }
}

interface ResolvedTheme {
  fg?: string
  settings?: { settings?: { foreground?: string } }[]
  semanticTokenColors?: Record<string, unknown>
}

/** Every text colour a resolved Shiki theme draws with. */
function textColours(t: ResolvedTheme): string[] {
  const out = new Set<string>()
  if (typeof t.fg === 'string') out.add(t.fg)
  for (const e of t.settings ?? [])
    if (typeof e.settings?.foreground === 'string') out.add(e.settings.foreground)
  for (const v of Object.values(t.semanticTokenColors ?? {})) {
    if (typeof v === 'string') out.add(v)
    else if (v !== null && typeof v === 'object' && 'foreground' in v && typeof v.foreground === 'string')
      out.add(v.foreground)
  }
  return [...out]
}

function failuresOf(colours: readonly string[], surfaces: Record<string, Rgb>): string[] {
  return colours.flatMap((hex) => {
    const p = parseHex(hex)
    if (p === null) return [`${hex}: not a colour`]
    return Object.entries(surfaces).flatMap(([name, bg]) => {
      const fg = p.alpha < 1 ? over([...p.rgb] as Rgb, p.alpha, bg) : ([...p.rgb] as Rgb)
      const r = contrast(fg, bg)
      return r < TEXT ? [`${hex} on ${name}: ${r.toFixed(2)} < ${TEXT}`] : []
    })
  })
}

describe('contrast: the diff view’s syntax colours (both themes, every accent)', () => {
  it('the surfaces diffTheme.ts adjusts against are tokens.css’s (within one step of 255)', () => {
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        const fromTokens = diffSurfaces(theme, accent)
        for (const [name, hex] of Object.entries(DIFF_SURFACES[theme])) {
          const want = fromTokens[name]
          const got = parseHex(hex)?.rgb
          expect(want, `${theme} ${name}`).toBeDefined()
          for (let i = 0; i < 3; i++)
            expect(
              Math.abs((got?.[i] ?? -1) - (want?.[i] ?? 0)),
              `${theme} × ${accent} ${name}`,
            ).toBeLessThanOrEqual(1.01 / 255)
        }
      }
    }
  })

  it('would catch a failing colour: Pierre’s own light theme falls short on these surfaces', async () => {
    const base = (await resolveTheme(BASE_THEMES.light)) as ResolvedTheme
    expect(failuresOf(textColours(base), diffSurfaces('light', 'slate')).length).toBeGreaterThan(0)
  })

  for (const theme of THEMES) {
    it(`${theme}: every token colour of ${DIFF_THEMES[theme]} reaches 4.5:1 on the card, line and word backgrounds`, async () => {
      registerDiffThemes()
      const resolved = (await resolveTheme(DIFF_THEMES[theme])) as ResolvedTheme & { name?: string }
      expect(resolved.name).toBe(DIFF_THEMES[theme])
      const colours = textColours(resolved)
      expect(colours.length).toBeGreaterThan(10)
      for (const accent of ACCENTS) {
        expect(failuresOf(colours, diffSurfaces(theme, accent)), `${theme} × ${accent}`).toEqual([])
      }
    })
  }
})
