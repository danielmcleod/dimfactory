// Writing dimfactory.json safely. `config.save` (composer "Save to
// project" / "Save as project default") and `config.patch` (Settings, PlanGate checkbox, persisted config_patch)
// share one pipeline:
//
//   edits → apply to the JSONC text (comments, key order, indent and EOL kept) → drop objects left empty →
//   re-parse + full validation (DimFactoryConfigZ + validateSemantics(scope)) → refuse when invalid (no write) →
//   [commit] re-read; if the file changed meanwhile, re-apply the path-based edits onto the new text (refuse when
//   that no longer validates) → back up the previous text → atomic write → {diff, undoToken, issues}.
//
// Edits are computed here and applied with jsonc-parser `applyEdits`. jsonc `modify` is not used: it moves a
// line-trailing comment onto an inserted property, deletes the previous property's trailing comment on removal,
// and reformats the whole document on an array insertion.
import { applyEdits, getNodeValue, parseTree, printParseErrorCode, stripComments } from 'jsonc-parser'
import type { Edit, Node as JsonNode, ParseError } from 'jsonc-parser'
import type { ConfigScope, RunOverrides, SemanticOptions } from '../../shared/config-schema.ts'
import {
  DimFactoryConfigZ,
  RunOverridesZ,
  toJsonPointer,
  validateSemantics,
} from '../../shared/config-schema.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import type { ConfigIssue } from '../../shared/ipc.ts'
import type { PassName } from '../../shared/run.ts'
import { PASS_NAMES } from '../../shared/run.ts'
import { DimFactoryError } from '../errors.ts'
import {
  configLocation,
  readConfigText,
  replaceConfigText,
  unifiedDiff,
  undoConfigWrite,
  withConfigLocks,
  writeOutcome,
} from './backups.ts'
import type {
  ConfigFileWrite,
  ConfigLocation,
  ConfigText,
  ConfigWriteOutcome,
  LocateOptions,
  UndoOptions,
} from './backups.ts'
import { parseJsonPointer, validatePatchOps } from './patch.ts'

export type { ConfigFileWrite, ConfigWriteOutcome } from './backups.ts'

// ---- formatting --------------------------------------------------------------------------------------------------

export interface TextFormat {
  /** One indent level: `'\t'` or N spaces. */
  unit: string
  eol: '\n' | '\r\n'
}

export const DEFAULT_FORMAT: TextFormat = { unit: '  ', eol: '\n' }

/** Indent and EOL of an existing file (default 2-space LF). */
export function detectFormat(text: string): TextFormat {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  const eol = crlf > lf ? '\r\n' : '\n'
  let unit: string | null = null
  let minSpaces = Infinity
  for (const line of text.split(/\r?\n/)) {
    const m = /^([ \t]+)\S/.exec(line)
    if (!m?.[1]) continue
    if (m[1].startsWith('\t')) {
      unit = '\t'
      break
    }
    // Lines starting a key or closing a block carry the structural indent (comment lines may be aligned freely).
    if (/^[ ]+["}\]]/.test(line)) minSpaces = Math.min(minSpaces, m[1].length)
  }
  if (unit === null)
    unit = Number.isFinite(minSpaces) && minSpaces <= 8 ? ' '.repeat(minSpaces) : DEFAULT_FORMAT.unit
  return { unit, eol }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPrimitive = (v: unknown): boolean => v === null || typeof v !== 'object'

/** Single-line JSON with `, ` and `: ` separators. */
function compactJson(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.map(compactJson).join(', ')}]`
  if (isPlainObject(v)) {
    const e = Object.entries(v).filter(([, x]) => x !== undefined)
    return e.length === 0
      ? '{}'
      : `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${compactJson(x)}`).join(', ')} }`
  }
  return JSON.stringify(v)
}

/** Render a value placed at a line indented by `indent`. Short arrays of primitives stay on one line. */
function formatValue(v: unknown, fmt: TextFormat, indent: string, inline: boolean): string {
  const compact = compactJson(v)
  if (inline || isPrimitive(v)) return compact
  if (Array.isArray(v) && v.every(isPrimitive) && compact.length <= 80) return compact
  if ((Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0))
    return compact
  return (JSON.stringify(v, null, fmt.unit) ?? 'null').split('\n').join(fmt.eol + indent)
}

// ---- text helpers --------------------------------------------------------------------------------------------------

const lineStart = (text: string, pos: number): number => {
  let i = pos
  while (i > 0 && text[i - 1] !== '\n' && text[i - 1] !== '\r') i--
  return i
}

const indentAt = (text: string, pos: number): string =>
  /^[ \t]*/.exec(text.slice(lineStart(text, pos)))?.[0] ?? ''

/** Skip spaces/tabs and same-line block comments. */
function skipInline(text: string, pos: number): number {
  let i = pos
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      if (end < 0 || /[\r\n]/.test(text.slice(i, end))) return i
      i = end + 2
      continue
    }
    return i
  }
}

/** Position of the next significant character (whitespace, newlines and comments skipped). */
function nextSignificant(text: string, pos: number): number {
  let i = pos
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? '')) i++
    if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      continue
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    return i
  }
}

/** End of a same-line trailing `// …` or `/* … *\/` comment starting at or after `pos` (else `pos`). */
function trailingCommentEnd(text: string, pos: number): number {
  const i = skipInline(text, pos)
  if (text.startsWith('//', i)) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    return j
  }
  return i > pos && (text[i] === '\n' || text[i] === '\r' || i >= text.length) ? i : pos
}

const eolLength = (text: string, pos: number): number =>
  text.startsWith('\r\n', pos) ? 2 : text[pos] === '\n' || text[pos] === '\r' ? 1 : 0

const spansLines = (text: string, node: JsonNode): boolean =>
  /[\r\n]/.test(text.slice(node.offset, node.offset + node.length))

// ---- tree navigation -----------------------------------------------------------------------------------------------

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

interface Located {
  /** Nodes along the path that exist: [root, child, …]. `found === segments.length` ⇒ the whole path exists. */
  chain: JsonNode[]
  found: number
}

/** The property `key` of `obj`; with duplicate keys, the last one (the one JSON parsing keeps). */
function propertyOf(obj: JsonNode, key: string): JsonNode | undefined {
  return obj.children?.findLast((p) => p.type === 'property' && p.children?.[0]?.value === key)
}

function locate(root: JsonNode, segments: readonly string[]): Located {
  const chain: JsonNode[] = [root]
  let node = root
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string
    let child: JsonNode | undefined
    if (node.type === 'object') child = propertyOf(node, seg)?.children?.[1]
    else if (node.type === 'array' && ARRAY_INDEX.test(seg)) child = node.children?.[Number(seg)]
    if (child === undefined) return { chain, found: i }
    chain.push(child)
    node = child
  }
  return { chain, found: segments.length }
}

// ---- edits -----------------------------------------------------------------------------------------------------------

/** A path-based edit (RFC 6902 semantics, lenient for sparse config files). Re-applicable onto any text. */
export type ConfigEdit =
  | { op: 'add' | 'replace'; path: readonly string[]; value: unknown }
  | { op: 'remove'; path: readonly string[] }
  | { op: 'test'; path: readonly string[]; value: unknown }

/** An edit could not be applied (the document is not shaped as the path needs, or a `test` failed). */
export class ConfigEditError extends Error {
  readonly pointer: string
  readonly kind: 'shape' | 'test'
  constructor(kind: 'shape' | 'test', pointer: string, message: string) {
    super(message)
    this.name = 'ConfigEditError'
    this.kind = kind
    this.pointer = pointer
  }
}

function parseOrThrow(text: string): JsonNode {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (root === undefined || errors.length > 0) {
    throw new ConfigEditError('shape', '', 'The file has syntax errors; fix them before saving')
  }
  if (root.type !== 'object') throw new ConfigEditError('shape', '', 'The file is not a JSON object')
  return root
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

type Render = (indent: string, inline: boolean) => string

/**
 * Insert an entry (a property, or an array item) into `container` before child `index` (default: append). Keeps
 * line-trailing comments with their own entries and the container's single-/multi-line layout.
 */
function insertEntry(
  text: string,
  container: JsonNode,
  render: Render,
  fmt: TextFormat,
  index?: number,
): Edit[] {
  const items = container.children ?? []
  const multiLine = spansLines(text, container)
  const isArray = container.type === 'array'
  const [open, closeCh] = isArray ? ['[', ']'] : ['{', '}']
  const close = container.offset + container.length - 1
  const outer = indentAt(text, container.offset)
  const inner = outer + fmt.unit
  if (items.length === 0) {
    const inside = text.slice(container.offset + 1, close)
    if (inside.trim() === '') {
      const inline = render('', true)
      if (isArray && inline.length <= 80)
        return [{ offset: container.offset, length: container.length, content: `[${inline}]` }]
      const content = `${open}${fmt.eol}${inner}${render(inner, false)}${fmt.eol}${outer}${closeCh}`
      return [{ offset: container.offset, length: container.length, content }]
    }
    // Only comments inside: add the entry before the closing bracket.
    const ls = lineStart(text, close)
    if (text.slice(ls, close).trim() === '') {
      return [{ offset: ls, length: 0, content: `${inner}${render(inner, false)}${fmt.eol}` }]
    }
    return [
      { offset: close, length: 0, content: `${fmt.eol}${inner}${render(inner, false)}${fmt.eol}${outer}` },
    ]
  }
  const next = index !== undefined ? items[index] : undefined
  if (next !== undefined) {
    if (!multiLine) return [{ offset: next.offset, length: 0, content: `${render('', true)}, ` }]
    const indent = indentAt(text, next.offset)
    return [{ offset: next.offset, length: 0, content: `${render(indent, false)},${fmt.eol}${indent}` }]
  }
  const last = items[items.length - 1] as JsonNode
  const lastEnd = last.offset + last.length
  const sig = nextSignificant(text, lastEnd)
  const trailingComma = text[sig] === ','
  if (!multiLine) {
    return trailingComma
      ? [{ offset: sig + 1, length: 0, content: ` ${render('', true)},` }]
      : [{ offset: lastEnd, length: 0, content: `, ${render('', true)}` }]
  }
  const indent = indentAt(text, last.offset)
  // After the last entry's comma and its same-line trailing comment, before the line break.
  const at = trailingCommentEnd(text, trailingComma ? sig + 1 : lastEnd)
  const line = `${fmt.eol}${indent}${render(indent, false)}${trailingComma ? ',' : ''}`
  if (trailingComma) return [{ offset: at, length: 0, content: line }]
  if (at === lastEnd) return [{ offset: lastEnd, length: 0, content: `,${line}` }]
  return [
    { offset: lastEnd, length: 0, content: ',' },
    { offset: at, length: 0, content: line },
  ]
}

const propertyRender =
  (key: string, value: unknown, fmt: TextFormat): Render =>
  (indent, inline) =>
    `${JSON.stringify(key)}: ${formatValue(value, fmt, indent, inline)}`

const itemRender =
  (value: unknown, fmt: TextFormat): Render =>
  (indent, inline) =>
    formatValue(value, fmt, indent, inline)

/**
 * Remove `entry` (a property node, or an array item) from `container` with its comma and its own line-trailing
 * comment; other comments stay where they are.
 */
function removeEntry(text: string, container: JsonNode, entry: JsonNode): Edit[] {
  const props = container.children ?? []
  const prop = entry
  const idx = props.indexOf(prop)
  let start = prop.offset
  let end = prop.offset + prop.length
  const edits: Edit[] = []
  const sig = nextSignificant(text, end)
  const ownComma = text[sig] === ','
  if (ownComma) {
    end = sig + 1
  } else {
    // The last property: drop the comma that separated it from the previous one.
    const prev = idx > 0 ? props[idx - 1] : undefined
    if (prev !== undefined) {
      const comma = nextSignificant(text, prev.offset + prev.length)
      if (text[comma] === ',') edits.push({ offset: comma, length: 1, content: '' })
    }
  }
  // A comment trailing the removed property on its line belongs to it.
  end = trailingCommentEnd(text, end)
  const ls = lineStart(text, start)
  const after = skipBlanks(text, end)
  const eolLen = eolLength(text, after)
  if (text.slice(ls, start).trim() === '' && (eolLen > 0 || after >= text.length)) {
    // The property had its own line(s): remove them whole.
    start = ls
    end = after + eolLen
  } else if (ownComma) {
    end = after
  } else {
    start = skipBlanksBack(text, start)
  }
  edits.push({ offset: start, length: end - start, content: '' })
  return edits
}

function skipBlanks(text: string, pos: number): number {
  let i = pos
  while (text[i] === ' ' || text[i] === '\t') i++
  return i
}

function skipBlanksBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--
  return i
}

function applyOne(text: string, edit: ConfigEdit, fmt: TextFormat): string {
  const root = parseOrThrow(text)
  const segs = edit.path
  const pointer = toJsonPointer(segs)
  const { chain, found } = locate(root, segs)
  const node = chain[chain.length - 1] as JsonNode
  const whole = found === segs.length
  if (segs.length === 0) throw new ConfigEditError('shape', pointer, 'An edit cannot replace the whole file')

  if (edit.op === 'test') {
    if (!whole || !deepEqual(getNodeValue(node), edit.value)) {
      throw new ConfigEditError('test', pointer, `The value at ${pointer} is not the expected one`)
    }
    return text
  }

  if (edit.op === 'remove') {
    if (!whole) return text
    const parent = chain[chain.length - 2] as JsonNode
    if (parent.type === 'array') {
      return pruneEmptyAncestors(applyEdits(text, removeEntry(text, parent, node)), segs.slice(0, -1))
    }
    // A duplicated key goes with every copy: removing only the last (the one that counts) would bring an earlier
    // value back instead of clearing the setting.
    let out = text
    for (;;) {
      const at = locate(parseOrThrow(out), segs)
      if (at.found !== segs.length) break
      const obj = at.chain[at.chain.length - 2] as JsonNode
      const prop = (at.chain[at.chain.length - 1] as JsonNode).parent as JsonNode
      out = applyEdits(out, removeEntry(out, obj, prop))
    }
    return pruneEmptyAncestors(out, segs.slice(0, -1))
  }

  // add / replace
  if (whole) {
    const parent = chain[chain.length - 2] as JsonNode
    if (edit.op === 'add' && parent.type === 'array') {
      const index = parent.children?.indexOf(node) ?? 0
      return applyEdits(text, insertEntry(text, parent, itemRender(edit.value, fmt), fmt, index))
    }
    if (deepEqual(getNodeValue(node), edit.value)) return text
    const indent = indentAt(text, node.parent?.type === 'property' ? node.parent.offset : node.offset)
    const content = formatValue(edit.value, fmt, indent, !spansLines(text, node) && !spansLines(text, parent))
    const replaced = applyEdits(text, [{ offset: node.offset, length: node.length, content }])
    return parent.type === 'object' ? dropEarlierDuplicates(replaced, segs) : replaced
  }

  const container = chain[found] as JsonNode
  const seg = segs[found] as string
  if (container.type === 'array') {
    const len = container.children?.length ?? 0
    if (
      edit.op === 'add' &&
      found === segs.length - 1 &&
      (seg === '-' || (ARRAY_INDEX.test(seg) && Number(seg) === len))
    ) {
      return applyEdits(text, insertEntry(text, container, itemRender(edit.value, fmt), fmt))
    }
    throw new ConfigEditError('shape', pointer, `${pointer}: index ${seg} is outside the list`)
  }
  if (container.type !== 'object') {
    throw new ConfigEditError('shape', pointer, `${toJsonPointer(segs.slice(0, found))} is not an object`)
  }
  // Build the missing tail as nested objects.
  let value = edit.value
  for (let i = segs.length - 1; i > found; i--) {
    const s = segs[i] as string
    if (s === '-' || ARRAY_INDEX.test(s)) {
      throw new ConfigEditError(
        'shape',
        pointer,
        `${pointer}: the list ${toJsonPointer(segs.slice(0, i))} does not exist`,
      )
    }
    value = { [s]: value }
  }
  return applyEdits(text, insertEntry(text, container, propertyRender(seg, value, fmt), fmt))
}

/** After a value was set at `segs`, remove the earlier properties with the same key (the set one is the last). */
function dropEarlierDuplicates(text: string, segs: readonly string[]): string {
  const key = segs[segs.length - 1] as string
  let out = text
  for (;;) {
    const at = locate(parseOrThrow(out), segs.slice(0, -1))
    const obj = at.chain[at.chain.length - 1] as JsonNode
    if (at.found !== segs.length - 1 || obj.type !== 'object') return out
    const same = (obj.children ?? []).filter((p) => p.type === 'property' && p.children?.[0]?.value === key)
    const first = same[0]
    if (same.length < 2 || first === undefined) return out
    out = applyEdits(out, removeEntry(out, obj, first))
  }
}

/** Whether the text inside an object's braces holds a comment (an emptied object that does is the user's note). */
function holdsComment(text: string, node: JsonNode): boolean {
  const inside = text.slice(node.offset + 1, node.offset + node.length - 1)
  return stripComments(inside).trim() !== inside.trim()
}

/**
 * Remove objects on `parentPath` (deepest first, never the root) that the removal left without properties. An object
 * that still holds a comment stays (with the comment), and so do its ancestors.
 */
function pruneEmptyAncestors(text: string, parentPath: readonly string[]): string {
  let out = text
  for (let depth = parentPath.length; depth > 0; depth--) {
    const root = parseOrThrow(out)
    const segs = parentPath.slice(0, depth)
    const { chain, found } = locate(root, segs)
    if (found !== segs.length) return out
    const node = chain[chain.length - 1] as JsonNode
    const parent = chain[chain.length - 2] as JsonNode
    if (node.type !== 'object' || (node.children?.length ?? 0) > 0 || parent.type !== 'object') return out
    if (holdsComment(out, node)) return out
    out = applyEdits(out, removeEntry(out, parent, node.parent as JsonNode))
  }
  return out
}

const BOM = String.fromCharCode(0xfeff)

/** Nothing but whitespace and (well-formed) comments: the loader reads it as `{}`. */
function isEmptyConfigText(body: string): boolean {
  if (stripComments(body).trim() !== '') return false
  const errors: ParseError[] = []
  parseTree(body, errors, { allowTrailingComma: true, disallowComments: false })
  // Only "no value" — not an unterminated comment.
  return errors.every((e) => printParseErrorCode(e.error) === 'ValueExpected')
}

/**
 * Apply edits in order to JSONC text, keeping comments, key order, indentation and line endings (detected from the
 * text; 2-space LF for a new file). An empty/whitespace text starts as `{}`; a text of only comments keeps them and
 * gets `{}` after them. Throws {@link ConfigEditError}.
 */
export function applyConfigEdits(text: string, edits: readonly ConfigEdit[], fmt?: TextFormat): string {
  const bom = text.startsWith(BOM)
  let body = bom ? text.slice(1) : text
  const f = fmt ?? (body.trim() === '' ? DEFAULT_FORMAT : detectFormat(body))
  if (body.trim() === '') body = `{${f.eol}}${f.eol}`
  else if (isEmptyConfigText(body)) {
    // A line comment runs to the end of its line: the object starts on a line of its own.
    const sep = /[\r\n]$/.test(body) ? '' : f.eol
    body = `${body}${sep}{${f.eol}}${f.eol}`
  }
  for (const e of edits) body = applyOne(body, e, f)
  return (bom ? BOM : '') + body
}

// ---- validation ------------------------------------------------------------------------------------------------------

export interface ValidateTextContext {
  scope: ConfigScope
  /** Path shown in issues. */
  file: string
  semantic?: Omit<SemanticOptions, 'scope'>
}

/** Replaceable validator (e.g. the loader's, with "did you mean" suggestions). Errors refuse a write. */
export type ConfigTextValidator = (text: string, ctx: ValidateTextContext) => ConfigIssue[]

function lineIndex(text: string): (offset: number) => { line: number; col: number } {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
    else if (text[i] === '\r' && text[i + 1] !== '\n') starts.push(i + 1)
  }
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: offset - (starts[lo] ?? 0) + 1 }
  }
}

/** Nearest existing node for `segments` (the key node of `keyOf` when given and present). */
function nodeFor(root: JsonNode, segments: readonly string[], keyOf?: string): JsonNode {
  const { chain, found } = locate(root, segments)
  const node = chain[chain.length - 1] as JsonNode
  if (keyOf !== undefined && found === segments.length && node.type === 'object') {
    return propertyOf(node, keyOf)?.children?.[0] ?? node
  }
  return node
}

/** Syntax → schema (DimFactoryConfigZ) → semantic (validateSemantics) issues with file:line:col. */
export function validateConfigText(text: string, ctx: ValidateTextContext): ConfigIssue[] {
  const body = text.startsWith(BOM) ? text.slice(1) : text
  const pos = lineIndex(body)
  const issue = (
    offset: number,
    length: number,
    pointer: string,
    code: string,
    message: string,
    severity: 'error' | 'warning' = 'error',
  ): ConfigIssue => {
    const a = pos(offset)
    const b = pos(offset + length)
    return {
      file: ctx.file,
      pointer,
      line: a.line,
      col: a.col,
      endLine: b.line,
      endCol: b.col,
      code,
      message,
      severity,
    }
  }
  const errors: ParseError[] = []
  const root = parseTree(body, errors, { allowTrailingComma: true, disallowComments: false })
  // Nothing but whitespace and comments is an empty config, as the loader reads it.
  if (root === undefined && isEmptyConfigText(body)) return []
  if (errors.length > 0 || root === undefined) {
    return errors.map((e) =>
      issue(e.offset, e.length, '', 'syntax', `Syntax error: ${printParseErrorCode(e.error)}`),
    )
  }
  const value: unknown = getNodeValue(root)
  const parsed = DimFactoryConfigZ.safeParse(value)
  if (!parsed.success) {
    const out: ConfigIssue[] = []
    for (const zi of parsed.error.issues) {
      const path = zi.path.map((s) => String(s))
      if (zi.code === 'unrecognized_keys') {
        for (const key of zi.keys) {
          const n = nodeFor(root, path, key)
          out.push(
            issue(n.offset, n.length, toJsonPointer([...path, key]), 'unknown-key', `Unknown key "${key}"`),
          )
        }
        continue
      }
      const n = nodeFor(root, path)
      out.push(issue(n.offset, n.length, toJsonPointer(path), zi.code, zi.message))
    }
    return out
  }
  return validateSemantics(parsed.data, { ...ctx.semantic, scope: ctx.scope }).map((si) => {
    const n = nodeFor(root, parseJsonPointer(si.pointer) ?? [])
    return issue(n.offset, n.length, si.pointer, si.code, si.message, si.severity)
  })
}

// ---- requests --------------------------------------------------------------------------------------------------------

export interface WriteOptions extends LocateOptions {
  /** extra semantic inputs: `inheritedTimeouts` (applied to the project file) and `managedFlags`. */
  semantic?: Omit<SemanticOptions, 'scope'>
  /** Replace the built-in validator (default {@link validateConfigText}). */
  validate?: ConfigTextValidator
}

export interface SaveOverridesRequest extends WriteOptions {
  scope: ConfigScope
  folder?: string
  /** `row`: only `overrides.passes[pass]`; `projectDefault`: every run-layer override. */
  mode: 'row' | 'projectDefault'
  pass?: PassName
  overrides: RunOverrides
  /**
   * The value the resolver produces at `pointer` (RFC 6901 into ResolvedConfig / RunOverrides) WITHOUT the target
   * layer's own key there. An override equal to it is redundant and is pruned from the file.
   */
  resolveInherited: (pointer: string) => unknown
}

export interface PatchConfigRequest extends WriteOptions {
  scope: ConfigScope
  folder?: string
  ops: readonly JsonPatchOp[]
  /** Enforce the config_patch allowlist. Default true; Settings and the PlanGate checkbox pass false. */
  allowlist?: boolean
}

/** One file of a {@link ConfigWritePlan}. */
export interface PlannedTarget {
  location: ConfigLocation
  edits: ConfigEdit[]
  base: ConfigText | null
  newText: string
  changed: boolean
  diff: string
  issues: ConfigIssue[]
  ctx: ValidateTextContext
}

/** A validated, not yet written change ("view diff"); {@link commitConfigWrite} writes it. */
export interface ConfigWritePlan {
  primaryScope: ConfigScope
  targets: PlannedTarget[]
  forcedToUser: JsonPatchOp[]
  changed: boolean
  diff: string
  /** Warnings (errors refuse the plan). */
  issues: ConfigIssue[]
  validate: ConfigTextValidator
}

/**
 * Overrides that are written even when they equal the inherited value. The builtin default profile is the one first
 * launch would pick for the vendors ready on this machine, so a saved `profile` is never redundant: pruning it would
 * hand teammates (or this machine, once another vendor is ready) a different profile.
 */
const NEVER_PRUNED: readonly string[] = ['/profile']

/** Leaves of an override object: objects recurse, arrays and primitives (and null) are leaves. */
function leaves(v: unknown, prefix: string[]): [string[], unknown][] {
  if (!isPlainObject(v)) return v === undefined ? [] : [[prefix, v]]
  return Object.entries(v).flatMap(([k, x]) => leaves(x, [...prefix, k]))
}

function refuse(code: 'VALIDATION' | 'CONFLICT', message: string, issues: ConfigIssue[]): never {
  throw new DimFactoryError(code, message, { details: issues })
}

const errorsOf = (issues: ConfigIssue[]): ConfigIssue[] => issues.filter((i) => i.severity === 'error')

const summary = (issues: ConfigIssue[]): string =>
  issues
    .slice(0, 3)
    .map((i) => `${i.file}:${i.line}:${i.col} ${i.message}`)
    .join('; ')

function editIssue(file: string, err: ConfigEditError): ConfigIssue {
  return {
    file,
    pointer: err.pointer,
    line: 0,
    col: 0,
    endLine: 0,
    endCol: 0,
    code: err.kind === 'test' ? 'patch-test' : 'patch-shape',
    message: err.message,
    severity: 'error',
  }
}

/** Apply + validate one target's edits onto `base`. Throws VALIDATION (or `failCode`) with ConfigIssue[]. */
function buildTarget(
  location: ConfigLocation,
  base: ConfigText | null,
  edits: ConfigEdit[],
  ctx: ValidateTextContext,
  validate: ConfigTextValidator,
  failCode: 'VALIDATION' | 'CONFLICT',
): PlannedTarget {
  const baseText = base?.text ?? ''
  if (base !== null && !base.utf8) {
    // Editing the decoded text would replace the undecodable bytes with U+FFFD for good.
    const issue: ConfigIssue = {
      file: location.path,
      pointer: '',
      line: 1,
      col: 1,
      endLine: 1,
      endCol: 1,
      code: 'not-utf8',
      message: 'The file is not UTF-8 text; save it as UTF-8 in an editor before Dim Factory edits it',
      severity: 'error',
    }
    refuse(failCode, `${location.path} is not UTF-8 text; save it as UTF-8 first`, [issue])
  }
  if (baseText.trim() !== '') {
    const syntax = validate(baseText, ctx).filter((i) => i.code === 'syntax')
    if (syntax.length > 0) refuse(failCode, `${location.path} has syntax errors: ${summary(syntax)}`, syntax)
  }
  let newText: string
  try {
    newText = applyConfigEdits(baseText, edits)
  } catch (err) {
    if (!(err instanceof ConfigEditError)) throw err
    const i = editIssue(location.path, err)
    refuse(err.kind === 'test' ? 'CONFLICT' : failCode, err.message, [i])
  }
  // A save that changes nothing (e.g. pruning keys that are absent) leaves the file untouched, even a missing one.
  if (base === null && edits.every((e) => e.op === 'remove' || e.op === 'test')) newText = baseText
  const changed = newText !== baseText
  const issues = changed ? validate(newText, ctx) : []
  const errors = errorsOf(issues)
  if (errors.length > 0) {
    refuse(failCode, `The change would make ${location.path} invalid: ${summary(errors)}`, errors)
  }
  return {
    location,
    edits,
    base,
    newText,
    changed,
    diff: changed ? unifiedDiff(base?.text ?? null, newText, location.path) : '',
    issues: issues.filter((i) => i.severity !== 'error'),
    ctx,
  }
}

function contextFor(loc: ConfigLocation, opts: WriteOptions): ValidateTextContext {
  const { inheritedTimeouts, ...rest } = opts.semantic ?? {}
  const semantic: Omit<SemanticOptions, 'scope'> =
    loc.scope === 'project' && inheritedTimeouts !== undefined ? { ...rest, inheritedTimeouts } : rest
  return { scope: loc.scope, file: loc.path, semantic }
}

function makePlan(
  primaryScope: ConfigScope,
  targets: PlannedTarget[],
  forcedToUser: JsonPatchOp[],
  validate: ConfigTextValidator,
): ConfigWritePlan {
  return {
    primaryScope,
    targets,
    forcedToUser,
    changed: targets.some((t) => t.changed),
    diff: targets.map((t) => t.diff).join(''),
    issues: targets.flatMap((t) => t.issues),
    validate,
  }
}

/** "Save to project" (one composer row) / "Save as project default": minimal-diff edits, validated, not written. */
export async function planOverridesSave(req: SaveOverridesRequest): Promise<ConfigWritePlan> {
  const parsed = RunOverridesZ.safeParse(req.overrides)
  if (!parsed.success) {
    const issues: ConfigIssue[] = parsed.error.issues.map((i) => ({
      file: '',
      pointer: toJsonPointer(i.path.map((s) => (typeof s === 'symbol' ? String(s) : s))),
      line: 0,
      col: 0,
      endLine: 0,
      endCol: 0,
      code: i.code,
      message: i.message,
      severity: 'error',
    }))
    refuse('VALIDATION', 'The run overrides are invalid', issues)
  }
  let pairs: [string[], unknown][]
  if (req.mode === 'row') {
    const pass = req.pass
    if (pass === undefined || !(PASS_NAMES as readonly string[]).includes(pass)) {
      throw new DimFactoryError('VALIDATION', 'Saving a composer row needs its pass')
    }
    pairs = leaves(parsed.data.passes?.[pass], ['passes', pass])
  } else {
    // A run's own Tools (the composer's picker and Use skill) are for one run: never written to a file.
    const { tools: _runOnly, ...saved } = parsed.data
    pairs = leaves(saved, [])
  }
  const edits: ConfigEdit[] = pairs.map(([path, value]) =>
    !NEVER_PRUNED.includes(toJsonPointer(path)) && deepEqual(value, req.resolveInherited(toJsonPointer(path)))
      ? { op: 'remove', path }
      : { op: 'replace', path, value },
  )
  const location = await configLocation(req.scope, req.folder, req)
  const validate = req.validate ?? validateConfigText
  const base = await readConfigText(location.path)
  const target = buildTarget(location, base, edits, contextFor(location, req), validate, 'VALIDATION')
  return makePlan(req.scope, [target], [], validate)
}

/**
 * `config.patch`: RFC 6902 add/replace/remove/test. `add`/`replace` create missing parent objects and `remove` of an
 * absent key is a no-op (config files are sparse). User-only paths go to the user file. Allowlist violations refuse
 * the whole patch (FORBIDDEN); `test` failures refuse it (CONFLICT).
 */
export async function planConfigPatch(req: PatchConfigRequest): Promise<ConfigWritePlan> {
  if (!Array.isArray(req.ops)) throw new DimFactoryError('VALIDATION', 'ops must be a list')
  const v = validatePatchOps(req.ops, {
    scope: req.scope,
    ...(req.allowlist !== undefined ? { allowlist: req.allowlist } : {}),
    ...(req.semantic?.managedFlags !== undefined ? { managedFlags: req.semantic.managedFlags } : {}),
  })
  if (!v.ok) {
    const code = v.rejected.some((r) => r.kind === 'forbidden') ? 'FORBIDDEN' : 'VALIDATION'
    throw new DimFactoryError(code, `Refused: ${v.rejected.map((r) => r.reason).join('; ')}`, {
      details: v.rejected,
    })
  }
  const validate = req.validate ?? validateConfigText
  const targets: PlannedTarget[] = []
  for (const scope of ['user', 'project'] as const) {
    const ops = v.routed[scope]
    if (ops.length === 0) continue
    const edits = ops.map((op): ConfigEdit => {
      const path = parseJsonPointer(op.path) ?? []
      return op.op === 'remove' ? { op: 'remove', path } : { op: op.op, path, value: op.value }
    })
    const location = await configLocation(scope, scope === 'project' ? req.folder : undefined, req)
    const base = await readConfigText(location.path)
    targets.push(buildTarget(location, base, edits, contextFor(location, req), validate, 'VALIDATION'))
  }
  return makePlan(req.scope, targets, v.forcedToUser, validate)
}

/**
 * Write a plan. Each file is re-read under an in-process lock; when it changed since the plan, the edits are
 * re-applied onto the new text and re-validated (CONFLICT, nothing written, when that fails). Then: backup →
 * atomic write → last-good. A failure on the second file rolls the first back.
 */
export async function commitConfigWrite(plan: ConfigWritePlan): Promise<ConfigWriteOutcome> {
  const targets = plan.targets.filter((t) => t.changed)
  return withConfigLocks(
    targets.map((t) => t.location.path),
    async () => {
      const ready: { t: PlannedTarget; cur: ConfigText | null; text: string; reapplied: boolean }[] = []
      for (const t of targets) {
        const cur = await readConfigText(t.location.path)
        if ((cur?.sha256 ?? null) === (t.base?.sha256 ?? null)) {
          ready.push({ t, cur, text: t.newText, reapplied: false })
          continue
        }
        const again = buildTarget(t.location, cur, t.edits, t.ctx, plan.validate, 'CONFLICT')
        if (again.changed) ready.push({ t, cur, text: again.newText, reapplied: true })
      }
      const writes: ConfigFileWrite[] = []
      try {
        for (const r of ready) {
          writes.push(
            await replaceConfigText(r.t.location, r.cur, r.text, {
              storeLastGood: true,
              reapplied: r.reapplied,
            }),
          )
        }
      } catch (err) {
        // Put back what this commit already wrote (best effort), then report the failure.
        for (const [i, w] of writes.entries()) {
          const r = ready[i]
          if (r === undefined || !w.changed) continue
          const now = await readConfigText(r.t.location.path).catch(() => null)
          await replaceConfigText(r.t.location, now, r.cur?.bytes ?? null).catch(() => undefined)
        }
        throw err
      }
      if (writes.length === 0) {
        return {
          path: plan.targets.find((t) => t.location.scope === plan.primaryScope)?.location.path ?? '',
          changed: false,
          diff: '',
          backupId: null,
          undoToken: null,
          issues: plan.issues,
          writes: [],
          forcedToUser: plan.forcedToUser,
        }
      }
      return writeOutcome(writes, {
        issues: plan.issues,
        forcedToUser: plan.forcedToUser,
        primaryScope: plan.primaryScope,
      })
    },
  )
}

/** `config.save`: plan + commit. */
export async function saveOverrides(req: SaveOverridesRequest): Promise<ConfigWriteOutcome> {
  return commitConfigWrite(await planOverridesSave(req))
}

/** `config.patch`: plan + commit. */
export async function patchConfig(req: PatchConfigRequest): Promise<ConfigWriteOutcome> {
  return commitConfigWrite(await planConfigPatch(req))
}

/** Undo toast: restore what a save/patch/restore replaced (see {@link undoConfigWrite}). */
export async function undo(undoToken: string, opts: UndoOptions = {}): Promise<ConfigWriteOutcome> {
  return undoConfigWrite(undoToken, opts)
}
