// The Diff tab's syntax colours (theming rule: every text colour at 4.5:1 or more on what it is drawn
// on). Shiki's Pierre themes are drawn on the app's own surfaces: the card for context lines, --diff-add-bg and
// --diff-del-bg for changed lines, and on a changed word the line colour at 15% (light) or 20% (dark) over that.
// Several Pierre token colours fall short there (the light theme's comments, strings and keywords), so each theme is
// registered again under Dim Factory's name with every token colour darkened (light) or lightened (dark) in OKLab, its
// hue kept, until it reaches MIN_CONTRAST on all of those surfaces. The surfaces are the tokens.css values in sRGB;
// tests/renderer/settings/contrast.test.ts checks them against tokens.css and every resulting colour.
import { registerCustomTheme, resolveTheme } from '@pierre/diffs'

export type Rgb = readonly [number, number, number]
export type DiffThemeName = 'light' | 'dark'

/** WCAG 2 normal text, with a little room for the hex rounding of the result. */
export const MIN_CONTRAST = 4.5
const TARGET = 4.6

/** The surfaces diff text is drawn on, per app theme (tokens.css; the contrast test keeps them equal). */
export const DIFF_SURFACES: Readonly<Record<DiffThemeName, Readonly<Record<string, string>>>> = {
  light: {
    card: '#ffffff',
    'diff-add-bg': '#e0fae4',
    'diff-del-bg': '#ffeceb',
    'diff-add-emphasis': '#bfe5c9',
    'diff-del-emphasis': '#f5cdcc',
  },
  dark: {
    card: '#13151a',
    'diff-add-bg': '#0c2815',
    'diff-del-bg': '#361715',
    'diff-add-emphasis': '#1d4a2c',
    'diff-del-emphasis': '#5d2a27',
  },
}

/** The Shiki themes the diff view starts from, and the names Dim Factory's versions are registered under. */
export const BASE_THEMES: Readonly<Record<DiffThemeName, string>> = {
  light: 'pierre-light',
  dark: 'pierre-dark',
}
export const DIFF_THEMES = { light: 'dim-factory-light', dark: 'dim-factory-dark' } as const

// ---- colour maths ------------------------------------------------------------------------------------------------

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` → sRGB in [0, 1] and alpha; null for anything else. */
export function parseHex(hex: string): { rgb: Rgb; alpha: number } | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (m === null) return null
  let h = m[1] ?? ''
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  const byte = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255
  return { rgb: [byte(0), byte(2), byte(4)], alpha: h.length === 8 ? byte(6) : 1 }
}

export function toHex(c: Rgb): string {
  return `#${c
    .map((x) =>
      Math.round(Math.min(1, Math.max(0, x)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

const toLinear = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
const toGamma = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)

export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2])
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** `fg` at `alpha` drawn over `bg`. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)) as unknown as Rgb
}

type Lab = [number, number, number]

function toOklab(c: Rgb): Lab {
  const [r, g, b] = c.map(toLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clip = (x: number): number => Math.min(1, Math.max(0, x))
  return [
    toGamma(clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    toGamma(clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    toGamma(clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ]
}

/** The lowest contrast of `c` on any of the surfaces. */
export function worstContrast(c: Rgb, surfaces: readonly Rgb[]): number {
  return Math.min(...surfaces.map((s) => contrast(c, s)))
}

/**
 * `hex` as a colour that reaches MIN_CONTRAST on every surface: unchanged when it already does; else its OKLab
 * lightness moved away from the surfaces (darker on light ones, lighter on dark ones), hue and chroma kept as far as
 * the gamut allows. Alpha is dropped (a token colour is drawn opaque here). A value that is not a hex colour is kept.
 */
export function readableOn(hex: string, surfaces: readonly Rgb[], dark: boolean): string {
  const parsed = parseHex(hex)
  if (parsed === null) return hex
  const first = surfaces[0]
  const base = parsed.alpha < 1 && first !== undefined ? over(parsed.rgb, parsed.alpha, first) : parsed.rgb
  if (worstContrast(base, surfaces) >= TARGET) return parsed.alpha < 1 ? toHex(base) : hex
  const lab = toOklab(base)
  for (let step = 1; step <= 100; step++) {
    const L = Math.min(1, Math.max(0, lab[0] + (dark ? 0.01 : -0.01) * step))
    const c = fromOklab([L, lab[1], lab[2]])
    // Quantised as it will be written, so the check is on the colour drawn.
    const q = parseHex(toHex(c))?.rgb ?? c
    if (worstContrast(q, surfaces) >= TARGET) return toHex(q)
  }
  return dark ? '#ffffff' : '#000000'
}

// ---- the themes ----------------------------------------------------------------------------------------------------

export function surfacesOf(theme: DiffThemeName): Rgb[] {
  return Object.values(DIFF_SURFACES[theme]).map((h) => parseHex(h)?.rgb ?? [0, 0, 0])
}

interface ThemeSetting {
  settings?: { foreground?: string } & Record<string, unknown>
}

/** A resolved Shiki theme's token colours made readable on the diff surfaces, under `name`. */
export function readableTheme<T extends object>(theme: T, name: string, which: DiffThemeName): T {
  const surfaces = surfacesOf(which)
  const dark = which === 'dark'
  const fix = (v: unknown): unknown => (typeof v === 'string' ? readableOn(v, surfaces, dark) : v)
  const copy = structuredClone(theme) as T & {
    name?: string
    fg?: string
    settings?: ThemeSetting[]
    tokenColors?: ThemeSetting[]
    colors?: Record<string, string>
    semanticTokenColors?: Record<string, unknown>
  }
  copy.name = name
  if (typeof copy.fg === 'string') copy.fg = readableOn(copy.fg, surfaces, dark)
  if (copy.colors?.['editor.foreground'] !== undefined) {
    copy.colors['editor.foreground'] = readableOn(copy.colors['editor.foreground'], surfaces, dark)
  }
  for (const list of [copy.settings, copy.tokenColors]) {
    for (const entry of list ?? []) {
      // The theme's default entry carries the editor background too; only foregrounds are text.
      if (typeof entry.settings?.foreground === 'string') {
        entry.settings.foreground = readableOn(entry.settings.foreground, surfaces, dark)
      }
    }
  }
  if (copy.semanticTokenColors !== undefined) {
    for (const [k, v] of Object.entries(copy.semanticTokenColors)) {
      copy.semanticTokenColors[k] =
        v !== null && typeof v === 'object' && 'foreground' in v
          ? { ...v, foreground: fix(v.foreground) }
          : fix(v)
    }
  }
  return copy
}

let registered = false

/** Register Dim Factory's two diff themes (once per window); the highlighter resolves them by name on first use. */
export function registerDiffThemes(): void {
  if (registered) return
  registered = true
  for (const which of ['light', 'dark'] as const) {
    registerCustomTheme(DIFF_THEMES[which], async () =>
      readableTheme(await resolveTheme(BASE_THEMES[which]), DIFF_THEMES[which], which),
    )
  }
}
