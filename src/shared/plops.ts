// The Plops' rules, pure and shared: the color a Plop derives from one base hex (HSL), the fixed Claude and Codex
// color families with a hashed hue for every other vendor, the log scale from usage to growth, the five growth
// stages, and which mood and emission a Plop shows for its usage (src/renderer/src/pages/plops draws them).

// ---- color ---------------------------------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number]
/** Hue in degrees [0, 360), saturation and lightness in [0, 1]. */
export type Hsl = readonly [number, number, number]

const FALLBACK_HEX = 0xff9f43

const r2 = (n: number): number => Math.round(n * 100) / 100
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** `#RGB` or `#RRGGBB` (the `#` optional); anything unreadable is the default orange. */
export function hexToRgb(hex: string): Rgb {
  let h = hex.replace('#', '')
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  let n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : NaN
  if (Number.isNaN(n)) n = FALLBACK_HEX
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHsl(c: Rgb): Hsl {
  const R = c[0] / 255
  const G = c[1] / 255
  const B = c[2] / 255
  const mx = Math.max(R, G, B)
  const mn = Math.min(R, G, B)
  const l = (mx + mn) / 2
  let h = 0
  let s = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === R) h = (G - B) / d + (G < B ? 6 : 0)
    else if (mx === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
  }
  return [h, s, l]
}

/** A CSS `hsl()` color: the hue wrapped into [0, 360), saturation and lightness clamped to [0, 1]. */
export function hslCss(h: number, s: number, l: number): string {
  return `hsl(${r2(((h % 360) + 360) % 360)}, ${r2(clamp01(s) * 100)}%, ${r2(clamp01(l) * 100)}%)`
}

/** HSL to `#rrggbb`. */
export function hslHex(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hx = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hx(f(0))}${hx(f(8))}${hx(f(4))}`
}

/** Every color of a Plop, derived from one base hex. */
export interface PlopPalette {
  crown: string
  mid: string
  deep: string
  stroke: string
  arm: string
  foot: string
  blush: string
  mouth: string
  tongue: string
  ink: string
}

/**
 * crown = lightness toward 97% by 52%; base (mid) = the input; deep = lightness × 0.8, hue +6; stroke = lightness ×
 * 0.42, hue +8; blush = a fixed pink, a deeper red for pink and red bases.
 */
export function plopPalette(hex: string): PlopPalette {
  const [H, S, L] = rgbToHsl(hexToRgb(hex))
  const redish = H > 300 || H < 20
  return {
    crown: hslCss(H - 4, S * 0.95, lerp(L, 0.97, 0.52)),
    mid: hslCss(H, S, L),
    deep: hslCss(H + 6, Math.min(1, S * 1.05), L * 0.8),
    stroke: hslCss(H + 8, Math.min(1, S * 0.85 + 0.1), L * 0.42),
    arm: hslCss(H, S, lerp(L, 1, 0.12)),
    foot: hslCss(H + 4, S, L * 0.88),
    blush: hslCss(redish ? 352 : 345, 0.95, redish ? 0.6 : 0.72),
    mouth: hslCss(H + 8, Math.min(1, S * 0.7), Math.min(0.22, L * 0.3)),
    tongue: 'hsl(352, 95%, 74%)',
    ink: '#1B1720',
  }
}

// ---- vendor and model colors ---------------------------------------------------------------------------------------

/** Claude: a warm clay-to-apricot band; its models step lighter as they get smaller. */
export const CLAUDE_FAMILY = {
  base: '#E8834E',
  models: [
    { match: /opus/i, hex: '#E0662F' },
    { match: /sonnet/i, hex: '#F2995E' },
    { match: /haiku/i, hex: '#F7BC86' },
  ],
} as const

/** Codex: a cool indigo-to-sky band, opposite Claude on the wheel; its models take the steps in order. */
export const CODEX_FAMILY = { base: '#4F86F7', models: ['#5A66F2', '#3CB4E8'] } as const

/** The hue bands kept for Claude and Codex: a hashed hue that lands in one moves 60° on. */
export const RESERVED_HUE_BANDS: readonly (readonly [number, number])[] = [
  [10, 45],
  [205, 240],
]

/** A stable hue from a name (FNV-1a), kept out of the Claude and Codex bands. */
export function hashHue(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  let hue = h % 360
  for (const [lo, hi] of RESERVED_HUE_BANDS) if (hue >= lo && hue <= hi) hue += 60
  return hue % 360
}

/** A vendor Plop's base color (vendor ids as core names them: claude, codex, gemini, …). */
export function vendorColor(vendor: string): string {
  if (vendor === 'claude') return CLAUDE_FAMILY.base
  if (vendor === 'codex') return CODEX_FAMILY.base
  return hslHex(hashHue(vendor), 0.68, 0.64)
}

/** A model Plop's color: its family's fixed tone when it has one, else a step from the vendor's hue (`index`: rank). */
export function modelColor(vendor: string, model: string | null, index: number): string {
  if (vendor === 'claude') {
    const hit = CLAUDE_FAMILY.models.find((m) => model !== null && m.match.test(model))
    if (hit !== undefined) return hit.hex
    const [h, s] = rgbToHsl(hexToRgb(CLAUDE_FAMILY.base))
    return hslHex(h, s, Math.min(0.82, 0.6 + index * 0.06))
  }
  if (vendor === 'codex') {
    const fixed = CODEX_FAMILY.models[index]
    if (fixed !== undefined) return fixed
    const [h, s] = rgbToHsl(hexToRgb(CODEX_FAMILY.base))
    return hslHex(h + index * 6, s, Math.min(0.82, 0.58 + index * 0.05))
  }
  return hslHex((hashHue(vendor) + index * 16) % 360, 0.68, Math.min(0.82, 0.58 + index * 0.08))
}

// ---- growth ---------------------------------------------------------------------------------------------------------

export const PLOP_STAGES = ['Drop', 'Sprout', 'Plop', 'Chonk', 'Mega'] as const
export type PlopStage = (typeof PLOP_STAGES)[number]

/**
 * The lineup's log scale: growth = (log u − log min) ÷ (log max − log min) over `values` (each at least 1, so zero
 * usage is the floor), clamped to [0, 1] for a value outside them. One value, or all equal: 0.5.
 */
export function logScale(values: readonly number[]): (v: number) => number {
  const logs = values.map((v) => Math.log10(Math.max(1, v)))
  const lo = logs.length > 0 ? Math.min(...logs) : 0
  const hi = logs.length > 0 ? Math.max(...logs) : 0
  return (v) => (hi > lo ? clamp01((Math.log10(Math.max(1, v)) - lo) / (hi - lo)) : 0.5)
}

/** Stage band: round(growth × 4). */
export function stageIndex(growth: number): number {
  return Math.min(4, Math.round(clamp01(growth) * 4))
}

export function stageOf(growth: number): PlopStage {
  return PLOP_STAGES[stageIndex(growth)] ?? 'Drop'
}

// ---- mood and emission ----------------------------------------------------------------------------------------------

export const PLOP_MOODS = ['idle', 'happy', 'sleepy', 'growing', 'puddle'] as const
export type PlopMood = (typeof PLOP_MOODS)[number]
export const PLOP_EMITS = ['none', 'smoke', 'gas', 'oil', 'steam'] as const
export type PlopEmit = (typeof PLOP_EMITS)[number]
export const PLOP_SNACKS = ['none', 'metal', 'cord', 'bolt', 'water'] as const
export type PlopSnack = (typeof PLOP_SNACKS)[number]

export const SLEEPY_AFTER_MS = 86_400_000

export interface MoodInput {
  tokens: number
  previousTokens: number
  lastUsedAt: number | null
  now: number
  /** Tokens over every run up to now (absent: none known). */
  lifetimeTokens?: number
  /** Steps running right now. */
  live?: number
}

/** Used before, but no tokens in the period and nothing running now: the Plop has melted into a puddle. */
export function isPuddle(i: Pick<MoodInput, 'tokens' | 'lifetimeTokens' | 'live'>): boolean {
  return i.tokens === 0 && (i.lifetimeTokens ?? 0) > 0 && (i.live ?? 0) === 0
}

/**
 * The mood a Plop rests in: a puddle when it was used before but has no tokens in the period (this beats sleepy);
 * sleepy without usage in the last 24 hours; else happy when usage is up against the previous period; else idle.
 */
export function restingMood(i: MoodInput): Exclude<PlopMood, 'growing'> {
  if (isPuddle(i)) return 'puddle'
  if (i.lastUsedAt === null || i.lastUsedAt < i.now - SLEEPY_AFTER_MS) return 'sleepy'
  if (i.tokens > i.previousTokens) return 'happy'
  return 'idle'
}

/** Whether the Plop crossed into a bigger stage since the previous period (its growth then, on the same scale). */
export function crossedStage(growth: number, previousGrowth: number): boolean {
  return stageIndex(growth) > stageIndex(previousGrowth)
}

export interface EmitInput {
  limitHits24h: number
  failedSteps: number
  reruns: number
  live: number
}

/**
 * What a Plop gives off, the most pressing first: steam when a rate, quota or billing limit stopped a step in the
 * last 24 hours; oil when steps failed or runs were re-run in the period; gas while steps run right now; else none.
 * `gas` here means "running now": the renderer draws it as gas or smoke and rotates snacks with it.
 */
export function plopEmit(i: EmitInput): PlopEmit {
  if (i.limitHits24h > 0) return 'steam'
  if (i.failedSteps > 0 || i.reruns > 0) return 'oil'
  if (i.live > 0) return 'gas'
  return 'none'
}
