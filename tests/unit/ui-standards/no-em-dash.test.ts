// UI copy standard (user-mandated):
// no em dash (U+2014) in any text that can reach a user. Every .ts/.tsx file under src/ is parsed with the TypeScript
// compiler: core, shared, main, preload, the dev CLI and the renderer. That covers the failure-category titles and
// recovery labels in src/core/heal, the preflight check titles and details, session notes, tray and notification
// copy, and every component. Each string literal, no-substitution template, template head, middle and tail and JSX
// text is checked as cooked text, so an escaped \u2014 counts too. Every one of them is also checked for the dash in
// the other forms it can take on its way to the screen:
// - the HTML entity (&mdash;, &#8212;, &#x2014;);
// - the CSS escape (\2014, up to \002014), as in a Tailwind class like before:content-['\2014'] or an inline style;
// - a dash built at run time: String.fromCharCode / String.fromCodePoint with 0x2014 (8212).
//
// Not read, because none of it is UI:
// - comments;
// - regular-expression literals, which are patterns rather than text (src/core/findings/parse.ts accepts an em dash
//   in vendor output);
// - the prompt templates sent to vendor CLIs (src/core/prompts/defaults/*.md) and the renderer README.
// The other non-TS sources under src/ that could reach the UI (html, css, json) are read as plain text, for the dash,
// its entity and its CSS escape (a stylesheet's `content: "\2014"`).
//
// The few literals that never reach a user are allowlisted below by file, exact text and count, each with its reason.
// An allowlist entry that no longer matches exactly fails as well, so the list cannot go stale.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { RUN_OUTPUT_FILES } from '../../../src/shared/run.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SRC = join(REPO, 'src')

const EM_DASH = '\u2014'
const EM_DASH_CODE = 0x2014
const EM_DASH_ENTITY = /&(?:mdash|#0*8212|#x0*2014);/i
/** A CSS escape of U+2014: a backslash (not itself escaped) and at most six hex digits that make 2014. */
const EM_DASH_CSS_ESCAPE = /(?<!\\)\\0{0,2}2014(?![0-9a-f])/i
/** The calls that turn a code point into text. */
const CHAR_CODE_CALLS: ReadonlySet<string> = new Set(['fromCharCode', 'fromCodePoint'])

/** Whether a piece of text carries the dash in any written form: the character, its entity or its CSS escape. */
function hasDash(text: string): RegExpExecArray | true | null {
  if (text.includes(EM_DASH)) return true
  return EM_DASH_ENTITY.exec(text) ?? EM_DASH_CSS_ESCAPE.exec(text)
}
/** Non-TS files under src/ read as plain text. Markdown is the prompt templates and the README: not UI. */
const PLAIN_TEXT = /\.(?:html|css|json)$/i
const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/i

const LITERAL_KINDS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.StringLiteral, 'string'],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template'],
  [ts.SyntaxKind.TemplateHead, 'template head'],
  [ts.SyntaxKind.TemplateMiddle, 'template middle'],
  [ts.SyntaxKind.TemplateTail, 'template tail'],
  [ts.SyntaxKind.JsxText, 'JSX text'],
])

interface Offender {
  /** Repo-relative, forward slashes. */
  file: string
  line: number
  kind: string
  /** The literal's cooked text (JSX text as written). */
  text: string
}

interface Allowed {
  file: string
  /** The literal's exact cooked text. */
  text: string
  /** How many literals in the file carry it. */
  count: number
  /** Why it never reaches a user. */
  why: string
}

const ALLOWED: readonly Allowed[] = [
  {
    file: 'src/core/git/patch.ts',
    text: ' — read the file if needed]\n',
    count: 2,
    why:
      "The tail of the '[diff omitted: <path> — read the file if needed]' stub in the diff that goes into the " +
      'Review and Critic prompts. It is prompt text sent to the vendor CLI, and the app never displays prompts ' +
      '(runs.output serves plan, review, critic, findings, resolved, verify and heal only).',
  },
  {
    file: 'src/core/git/patch.ts',
    text: '\n[diff truncated: too large for the prompt — read the files if needed]\n',
    count: 1,
    why: 'The marker at the end of a prompt diff cut to the size cap: prompt text for the vendor CLI, like the stub above.',
  },
]

const rel = (abs: string): string => relative(REPO, abs).split('\\').join('/')

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

/** `String.fromCharCode(0x2014)`, `String.fromCodePoint(8212, …)`: a call that makes the dash at run time. */
function isCharCodeDash(node: ts.Node, sf: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || !CHAR_CODE_CALLS.has(callee.name.text)) return false
  return node.arguments.some(
    (a) => ts.isNumericLiteral(a) && Number(a.getText(sf).replaceAll('_', '')) === EM_DASH_CODE,
  )
}

/** Every literal of a TS/TSX source that carries an em dash in any written form, and every call that makes one. */
function scanSource(file: string, source: string): Offender[] {
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const out: Offender[] = []
  const lineAt = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
  const visit = (node: ts.Node): void => {
    const what = LITERAL_KINDS.get(node.kind)
    if (what !== undefined) {
      const text = (node as ts.LiteralLikeNode).text
      // The cooked text (a \u escape of U+2014 is the dash) and the text as written (JSX keeps entities).
      const raw = node.getText(sf)
      const found = hasDash(text) ?? hasDash(raw)
      if (found !== null) {
        // The line of the dash itself (a JSX text or template can span lines); an escape reports the literal's start.
        const at = raw.indexOf(EM_DASH)
        const written = found === true ? null : (EM_DASH_ENTITY.exec(raw) ?? EM_DASH_CSS_ESCAPE.exec(raw))
        const offset = at >= 0 ? at : (written?.index ?? 0)
        out.push({ file, line: lineAt(node.getStart(sf) + offset), kind: what, text })
      }
    }
    if (isCharCodeDash(node, sf))
      out.push({ file, line: lineAt(node.getStart(sf)), kind: 'char code', text: node.getText(sf) })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** A plain-text source: one offender per line that carries an em dash, its entity or its CSS escape. */
function scanPlain(file: string, source: string): Offender[] {
  const out: Offender[] = []
  source.split('\n').forEach((text, i) => {
    if (hasDash(text) !== null) out.push({ file, line: i + 1, kind: 'text', text })
  })
  return out
}

/** Drop the allowlisted literals; also report allowlist entries whose count no longer matches. */
function applyAllowlist(
  found: readonly Offender[],
  allowed: readonly Allowed[],
): { offenders: Offender[]; stale: string[] } {
  const isAllowed = (o: Offender): Allowed | undefined =>
    allowed.find((a) => a.file === o.file && a.text === o.text && o.kind !== 'text')
  const stale = allowed
    .map((a) => ({ a, n: found.filter((o) => isAllowed(o) === a).length }))
    .filter(({ a, n }) => n !== a.count)
    .map(({ a, n }) => `${a.file} ${JSON.stringify(a.text)}: allowlisted ${a.count}, found ${n}`)
  return { offenders: found.filter((o) => isAllowed(o) === undefined), stale }
}

function scanTree(): { files: string[]; found: Offender[] } {
  const files = listFiles(SRC).filter((f) => TS_SOURCE.test(f) || PLAIN_TEXT.test(f))
  const found: Offender[] = []
  for (const abs of files) {
    const file = rel(abs)
    const source = readFileSync(abs, 'utf8')
    found.push(...(TS_SOURCE.test(abs) ? scanSource(file, source) : scanPlain(file, source)))
  }
  return { files: files.map(rel), found }
}

const where = (o: Offender): string => `${o.file}:${o.line} (${o.kind}) ${JSON.stringify(o.text.trim())}`

// ---- the scanner itself (mutation checks) -------------------------------------------------------------------------

/** Plant an em dash at the start of the first matching literal of a real source file. */
function plant(file: string): { source: string; line: number } {
  const source = readFileSync(join(REPO, file), 'utf8')
  const tsx = file.endsWith('.tsx')
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let offset = -1
  const visit = (node: ts.Node): void => {
    if (offset >= 0) return
    if (tsx && node.kind === ts.SyntaxKind.JsxText && /[A-Za-z]/.test(node.getText(sf))) {
      offset = node.getStart(sf) + node.getText(sf).search(/[A-Za-z]/)
      return
    }
    const quoted =
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead
    const parent = node.kind === ts.SyntaxKind.TemplateHead ? node.parent.parent : node.parent
    if (
      !tsx &&
      quoted &&
      ts.isPropertyAssignment(parent) &&
      ts.isIdentifier(parent.name) &&
      ['title', 'label', 'detail'].includes(parent.name.text)
    ) {
      offset = node.getStart(sf) + 1
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (offset < 0) throw new Error(`${file}: nothing to plant into`)
  return {
    source: `${source.slice(0, offset)}${EM_DASH} ${source.slice(offset)}`,
    line: sf.getLineAndCharacterOfPosition(offset).line + 1,
  }
}

describe('the em-dash scanner', () => {
  it('flags every kind of UI literal, and leaves comments, regexes and other dashes alone', () => {
    const source = [
      "const a = 'one — two'",
      'const b = `three — four`',
      'const c = `head — ${a} middle — ${b} tail —`',
      "const d = '\\u2014'",
      'const e = <p title="attr — x">text — here</p>',
      'const f = <p>&mdash; and &#8212;</p>',
      '// a comment — not UI',
      '/* another — comment */',
      'const g = /[:—-]/',
      "const h = '9–14 min · $0.40–0.85 · a - b'",
      "const i = <p title='&#x2014;'>clean</p>",
    ].join('\n')
    expect(scanSource('src/x.tsx', source).map((o) => [o.line, o.kind])).toEqual([
      [1, 'string'],
      [2, 'template'],
      [3, 'template head'],
      [3, 'template middle'],
      [3, 'template tail'],
      [4, 'string'],
      [5, 'string'],
      [5, 'JSX text'],
      [6, 'JSX text'],
      [11, 'string'],
    ])
  })

  it('flags the CSS escape, an entity outside JSX and a dash made from its code point', () => {
    const source = [
      // JSX strings take no escapes: the class carries one backslash, as Tailwind needs it.
      'const a = <span className="before:content-[\'\\2014\']" />',
      String.raw`const b = { content: '"\\002014"' }`,
      "const c = '&mdash;'",
      'const d = String.fromCharCode(0x2014)',
      'const e = String.fromCodePoint(8212)',
      'const f = `${String.fromCharCode(0x20_14)} x`',
      // Not the dash: another code point, a longer escape, an escaped backslash, an en dash.
      String.raw`const g = '\\20141 \\\\2014 \\2013'`,
      'const h = String.fromCharCode(0x2013)',
      'const i = String.fromCharCode(2014)',
    ].join('\n')
    expect(scanSource('src/x.tsx', source).map((o) => [o.line, o.kind])).toEqual([
      [1, 'string'],
      [2, 'string'],
      [3, 'string'],
      [4, 'char code'],
      [5, 'char code'],
      [6, 'char code'],
    ])
  })

  it('reports the line of the dash inside a multi-line JSX text', () => {
    const source = ['const x = (', '  <p>', '    first line', '    second — line', '  </p>', ')'].join('\n')
    expect(scanSource('src/x.tsx', source).map((o) => o.line)).toEqual([4])
  })

  it.each([
    'src/core/heal/categories.ts',
    'src/core/preflight/checks/vendor.ts',
    'src/main/tray-model.ts',
    'src/renderer/src/pages/dashboard/QuickComposer.tsx',
  ])('fails on an em dash planted in %s', (file) => {
    const planted = plant(file)
    const { offenders } = applyAllowlist(scanSource(file, planted.source), ALLOWED)
    expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([`${file}:${planted.line}`])
  })

  it('scans the plain-text sources line by line', () => {
    expect(
      scanPlain('src/x.html', '<title>ok</title>\n<p>a — b</p>\n<p>&mdash;</p>').map((o) => o.line),
    ).toEqual([2, 3])
    const css = String.raw`.a::before { content: "\2014"; }
.b::after { content: "\002014 "; }
.c::after { content: "\2013"; }
.d { width: 2014px; }`
    expect(scanPlain('src/x.css', css).map((o) => o.line)).toEqual([1, 2])
  })

  it('allows an allowlisted text only in its own file, and reports a count that drifted', () => {
    const entry = ALLOWED[0]
    if (entry === undefined) throw new Error('the allowlist is empty')
    const hit = { line: 1, kind: 'template tail', text: entry.text }
    const elsewhere = { ...hit, file: 'src/core/supervisor/cards.ts' }
    const own = { ...hit, file: entry.file }
    const { offenders, stale } = applyAllowlist([own, elsewhere], [entry])
    expect(offenders).toEqual([elsewhere])
    expect(stale).toEqual(
      entry.count === 1
        ? []
        : [`${entry.file} ${JSON.stringify(entry.text)}: allowlisted ${entry.count}, found 1`],
    )
  })
})

// ---- the tree -----------------------------------------------------------------------------------------------------

describe('no em dash reaches the UI', () => {
  const { files, found } = scanTree()
  const { offenders, stale } = applyAllowlist(found, ALLOWED)

  it('reads every layer of src/', () => {
    expect(files.length).toBeGreaterThan(250)
    for (const f of [
      'src/core/heal/categories.ts',
      'src/core/preflight/checks/vendor.ts',
      'src/core/recovery/vendor-failure.ts',
      'src/shared/failure.ts',
      'src/main/tray-model.ts',
      'src/main/notifications-model.ts',
      'src/preload/bridge.ts',
      'src/cli/render.ts',
      'src/renderer/index.html',
      'src/renderer/src/lib/format.ts',
      'src/renderer/src/pages/dashboard/QuickComposer.tsx',
    ])
      expect(files).toContain(f)
  })

  it('has no em dash in any string, template or JSX text under src/', () => {
    expect(offenders.map(where)).toEqual([])
  })

  it('keeps the allowlist exact', () => {
    expect(stale).toEqual([])
  })

  it('still has no way to show a prompt in the app (the reason the patch.ts markers are allowed)', () => {
    expect(RUN_OUTPUT_FILES.filter((f) => /prompt/i.test(f))).toEqual([])
  })
})
