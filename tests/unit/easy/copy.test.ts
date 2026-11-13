// Easy mode's words: all of them live in one module (pages/easy/text.ts), with no em dash anywhere, and the Easy screens
// write no words of their own (no JSX text, no literal aria-label, title, placeholder or alt). Every exported string,
// list, table and wording function of the module is checked, the functions with sample arguments.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as TEXT from '@renderer/pages/easy/text.ts'

const EM_DASH = String.fromCharCode(0x2014)
const EASY_DIR = fileURLToPath(new URL('../../../src/renderer/src/pages/easy/', import.meta.url))
const SWITCH = fileURLToPath(
  new URL('../../../src/renderer/src/components/shell/ExperienceSwitch.tsx', import.meta.url),
)

/** Every string a value holds: itself, a list's or a table's entries, a function's output for sample arguments. */
function strings(name: string, v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(`${name}[${i}]`, x))
  if (typeof v === 'function') {
    const samples: unknown[][] = [
      [],
      [0],
      [1],
      [2],
      [1.5],
      [12, 5],
      ['index.html'],
      ['vite-react', 'node'],
      ['vite-react', 'python'],
      ['Light 3D game (three.js)', 'node', 'game-3d-lite'],
      [['three.js']],
      [['three.js', 'cannon-es']],
      ['chosen'],
      ['words'],
      ['default'],
      [true],
      [false],
      [true, false],
      [false, true],
      [false, false],
      [true, true],
      [
        { p50: 600_000, p80: 1_500_000 },
        { p50: 1, p80: 3 },
      ],
      [{ p50: 600_000, p80: 600_000 }, null],
      [1.4, 5],
      [null, null],
      [1.4, null],
      [null, 5],
      [125_000, 480_000],
      ['completed', 'clean'],
      ['completed', 'findings-open'],
      ['failed', undefined],
      // What a website or app needs, how it is built and how to install Node.js.
      ...(['ai', 'payments', 'login', 'forms', 'data', 'blog'] as const).flatMap((n) => [
        [n, true],
        [n, false],
        ...[
          'proxy',
          'keyless',
          'none',
          'links',
          'contact',
          'hosted',
          'email',
          'list',
          'device',
          'online',
          'files',
          'cms',
        ].flatMap((c) => [
          [n, c, true],
          [n, c, false],
        ]),
      ]),
      [['Tests', 'Build', 'Page loads (Dim Factory)']],
      [['Site check', 'Page loads (Dim Factory)']],
      ['18.20.4', true],
      [null, false],
      ['win32'],
      ['darwin'],
      ['linux'],
    ]
    const out: string[] = []
    for (const args of samples) {
      try {
        const r: unknown = (v as (...a: unknown[]) => unknown)(...args)
        if (typeof r === 'string') out.push(r)
        // A list of lines (steps) counts line by line.
        else if (Array.isArray(r)) out.push(...r.filter((x): x is string => typeof x === 'string'))
      } catch {
        // a sample that does not fit the function
      }
    }
    expect(out.length, `${name} answered no sample`).toBeGreaterThan(0)
    return out
  }
  if (v !== null && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => strings(`${name}.${k}`, x))
  return []
}

describe("Easy mode's words", () => {
  it('have no em dash in any string, list, table or wording function', () => {
    const offenders: string[] = []
    for (const [name, v] of Object.entries(TEXT)) {
      for (const s of strings(name, v)) if (s.includes(EM_DASH)) offenders.push(`${name}: ${s}`)
    }
    expect(offenders).toEqual([])
  })

  it('are plain: every gallery example is a full sentence of its own kind', () => {
    expect(TEXT.EXAMPLES.map((e) => e.kind)).toEqual([
      'app',
      'website',
      'document',
      'data',
      'research',
      'checklist',
      'game',
      'game',
    ])
    for (const e of TEXT.EXAMPLES) expect(e.text.endsWith('.'), e.title).toBe(true)
  })

  it('live in the text module: the Easy screens write no words of their own', () => {
    const files = [
      ...readdirSync(EASY_DIR)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => join(EASY_DIR, f)),
      SWITCH,
    ]
    expect(files.length).toBeGreaterThanOrEqual(7)
    const offenders: string[] = []
    const WORDY_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt'])
    for (const file of files) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const visit = (n: ts.Node): void => {
        if (ts.isJsxText(n) && /[A-Za-z]/.test(n.text))
          offenders.push(`${file}: JSX text ${JSON.stringify(n.text.trim())}`)
        if (
          ts.isJsxAttribute(n) &&
          WORDY_ATTRS.has(n.name.getText(sf)) &&
          n.initializer !== undefined &&
          ts.isStringLiteral(n.initializer)
        )
          offenders.push(`${file}: ${n.name.getText(sf)}=${n.initializer.getText(sf)}`)
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(offenders).toEqual([])
  })
})
