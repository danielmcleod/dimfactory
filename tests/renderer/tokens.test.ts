// styles/tokens.css: --background equals the BrowserWindow backgroundColor (light #ffffff, dark #0c0e12), every
// accent has a light and a dark block, and the core text/surface pairs reach 4.5:1 (the full theme × accent
// contrast test is settings/contrast.test.ts).
import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/readSource.ts'

const tokens = readSource('src/renderer/src/styles/tokens.css')

type Oklch = [number, number, number]

function blocks(css: string): Map<string, Record<string, Oklch>> {
  const out = new Map<string, Record<string, Oklch>>()
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of noComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const vars: Record<string, Oklch> = {}
    for (const v of m[2]!.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
      vars[v[1]!] = [Number(v[2]), Number(v[3]), Number(v[4])]
    }
    out.set(m[1]!.trim(), { ...out.get(m[1]!.trim()), ...vars })
  }
  return out
}

function toLinear([L, C, h]: Oklch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number): number => Math.min(1, Math.max(0, x))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function hex(c: Oklch): string {
  const gamma = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return `#${toLinear(c)
    .map((x) =>
      Math.round(gamma(x) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function contrast(x: Oklch, y: Oklch): number {
  const lum = (c: Oklch): number => {
    const [r, g, b] = toLinear(c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [lum(x), lum(y)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const all = blocks(tokens)
const light = all.get(':root')!
const dark = { ...light, ...all.get('.dark') }

describe('tokens.css', () => {
  it('matches the window background colours exactly', () => {
    expect(hex(light['background']!)).toBe('#ffffff')
    expect(hex(dark['background']!)).toBe('#0c0e12')
  })

  it('defines every core, status, auto and diff token in both themes', () => {
    const names = [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'muted',
      'muted-foreground',
      'border',
      'input',
      'ring',
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'accent',
      'accent-foreground',
      'destructive',
      'destructive-foreground',
      'success',
      'warning',
      'info',
      ...['queued', 'running', 'waiting', 'stalled', 'paused', 'done', 'skipped', 'failed', 'cancelled'].map(
        (s) => `st-${s}`,
      ),
      'auto',
      'diff-add',
      'diff-del',
      'diff-add-bg',
      'diff-del-bg',
    ]
    for (const n of names) {
      expect(light[n], `:root --${n}`).toBeDefined()
      expect(all.get('.dark')?.[n], `.dark --${n}`).toBeDefined()
    }
  })

  it('has a light and a dark block for each accent', () => {
    for (const a of ['slate', 'blue', 'green', 'amber', 'rose', 'violet']) {
      for (const sel of [`[data-accent='${a}']`, `.dark[data-accent='${a}']`]) {
        const b = all.get(sel)
        expect(b?.['primary'], sel).toBeDefined()
        expect(b?.['ring'], sel).toBeDefined()
        const base = sel.startsWith('.dark') ? dark : light
        expect(
          contrast(b!['primary-foreground']!, b!['primary']!),
          `${sel} button text`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrast(b!['primary']!, base['background']!), `${sel} link text`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps text on its surfaces at 4.5:1 or more', () => {
    const pairs: [string, string][] = [
      ['foreground', 'background'],
      ['card-foreground', 'card'],
      ['popover-foreground', 'popover'],
      ['muted-foreground', 'background'],
      ['muted-foreground', 'muted'],
      ['secondary-foreground', 'secondary'],
      ['accent-foreground', 'accent'],
      ['destructive-foreground', 'destructive'],
      ['destructive', 'background'],
      ['auto', 'background'],
      ['diff-add', 'background'],
      ['diff-del', 'background'],
      ['foreground', 'diff-add-bg'],
      ['foreground', 'diff-del-bg'],
      ...['queued', 'running', 'waiting', 'stalled', 'paused', 'done', 'skipped', 'failed', 'cancelled'].map(
        (s): [string, string] => [`st-${s}`, 'card'],
      ),
    ]
    for (const [name, t] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const [fg, bg] of pairs) {
        expect(contrast(t[fg]!, t[bg]!), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
