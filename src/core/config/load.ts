// dimfactory.json loader: JSONC parse → zod (strict) →
// semantic rules, with every issue mapped to `file:line:col` (1-based; the end position is exclusive) and a
// "did you mean" suggestion for unknown keys (edit distance ≤ 2). A successful load stores the file's text as
// last-good (Restore last good).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getNodeValue, parseTree, printParseErrorCode, stripComments } from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'
import { z } from 'zod'
import type { DimFactoryConfig, ConfigScope, SemanticOptions } from '../../shared/config-schema.ts'
import {
  DimFactoryConfigZ,
  USER_ONLY_KEYS,
  toJsonPointer,
  validateSemantics,
} from '../../shared/config-schema.ts'
import type { ConfigIssue } from '../../shared/ipc.ts'
import { KNOWN_VENDORS, LOCAL_VENDOR_PREFIX } from '../../shared/vendors.ts'
import { errnoCode } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import { suggestName } from '../prompts/template.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { lastGoodPath } from './paths.ts'
import { parseJsonPointer } from './provenance.ts'
import type { LayerOrigin } from './provenance.ts'

export type Eol = '\n' | '\r\n'

/** jsonc-parser FormattingOptions subset, detected from the file (default 2 spaces). */
export interface Indent {
  insertSpaces: boolean
  tabSize: number
}

export const DEFAULT_INDENT: Indent = { insertSpaces: true, tabSize: 2 }

export interface ParseConfigOptions {
  /** Reported in every ConfigIssue (absolute path for files on disk). */
  file: string
  scope: ConfigScope
  /** Passed to validateSemantics (timeout order across layers; flagMap/extraArgs against adapter flags). */
  inheritedTimeouts?: SemanticOptions['inheritedTimeouts']
  managedFlags?: SemanticOptions['managedFlags']
  forbiddenFlags?: SemanticOptions['forbiddenFlags']
}

export interface LoadResult {
  file: string
  scope: ConfigScope
  exists: boolean
  /** The validated config; present iff the file exists and has no error-severity issue. */
  value?: DimFactoryConfig
  /** The parsed JSON (valid or not) when the text has no syntax error. */
  raw?: unknown
  /** Sorted by position. */
  issues: ConfigIssue[]
  /** The file text exactly as read ('' when missing). */
  text: string
  /** sha256 of the file's bytes (parseConfigText: of `text` as UTF-8); null when the file is missing. */
  sha256: string | null
  eol: Eol
  indent: Indent
  bom: boolean
  /** JSON pointer (into the file) → 1-based line of its key (array items: of the item). */
  lines: Record<string, number>
}

// ---- positions ------------------------------------------------------------------------------------------------------

/** Offsets at which each line starts (`\r\n`, `\n` and a lone `\r` end a line, as in jsonc-parser). */
export function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++
      out.push(i + 1)
    } else if (c === 10 /* \n */) out.push(i + 1)
  }
  return out
}

/** 1-based line and column (UTF-16 code units, as editors count them) of `offset`. */
export function positionAt(starts: readonly number[], offset: number): { line: number; col: number } {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, col: offset - (starts[lo] ?? 0) + 1 }
}

export function detectEol(text: string): Eol {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
}

/** Indentation of the first top-level key, when it starts its own line. */
function detectIndent(text: string, root: Node | undefined, starts: readonly number[]): Indent {
  const first = root?.type === 'object' ? root.children?.[0]?.children?.[0] : undefined
  if (first === undefined) return { ...DEFAULT_INDENT }
  const { line } = positionAt(starts, first.offset)
  const lead = text.slice(starts[line - 1] ?? 0, first.offset)
  if (lead === '' || !/^[ \t]+$/.test(lead)) return { ...DEFAULT_INDENT }
  if (lead.includes('\t')) return { insertSpaces: false, tabSize: 4 }
  return { insertSpaces: true, tabSize: lead.length }
}

// ---- tree navigation -------------------------------------------------------------------------------------------------

type Segment = string | number

/** The property node for `key` in an object node (the last one when a key is duplicated: it is the one that counts). */
function propertyNode(obj: Node, key: string): Node | undefined {
  let hit: Node | undefined
  for (const prop of obj.children ?? []) if (prop.children?.[0]?.value === key) hit = prop
  return hit
}

function childNode(node: Node, seg: Segment): Node | undefined {
  if (node.type === 'object') return propertyNode(node, String(seg))?.children?.[1]
  if (node.type === 'array') {
    const i = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : NaN
    return Number.isInteger(i) ? node.children?.[i] : undefined
  }
  return undefined
}

/** The value node at `segs`, else the nearest existing ancestor (`exact: false`). */
export function nodeAt(root: Node, segs: readonly Segment[]): { node: Node; exact: boolean } {
  let node = root
  for (const seg of segs) {
    const next = childNode(node, seg)
    if (next === undefined) return { node, exact: false }
    node = next
  }
  return { node, exact: true }
}

/** The KEY node of the property at `segs` (falls back like {@link nodeAt}). */
export function keyNodeAt(root: Node, segs: readonly Segment[]): { node: Node; exact: boolean } {
  const parent = nodeAt(root, segs.slice(0, -1))
  const last = segs[segs.length - 1]
  if (!parent.exact || last === undefined) return parent
  const key =
    parent.node.type === 'object' ? propertyNode(parent.node, String(last))?.children?.[0] : undefined
  return key !== undefined ? { node: key, exact: true } : nodeAt(root, segs)
}

/** pointer → line for every property (its key's line) and array item. */
function collectLines(root: Node, starts: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (node: Node, segs: Segment[]): void => {
    if (node.type === 'object') {
      for (const prop of node.children ?? []) {
        const key = prop.children?.[0]
        const value = prop.children?.[1]
        if (key === undefined || typeof key.value !== 'string') continue
        const next = [...segs, key.value]
        out[toJsonPointer(next)] = positionAt(starts, key.offset).line
        if (value !== undefined) walk(value, next)
      }
    } else if (node.type === 'array') {
      ;(node.children ?? []).forEach((item, i) => {
        const next = [...segs, i]
        out[toJsonPointer(next)] = positionAt(starts, item.offset).line
        walk(item, next)
      })
    }
  }
  walk(root, [])
  return out
}

// ---- schema navigation (valid keys for "did you mean") --------------------------------------------------------------

function unwrapSchema(s: z.ZodType): z.ZodType {
  let cur: z.ZodType = s
  for (let i = 0; i < 32; i++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodExactOptional || cur instanceof z.ZodNullable) {
      cur = cur.unwrap() as z.ZodType
    } else if (cur instanceof z.ZodPipe) {
      cur = cur.in as z.ZodType
    } else break
  }
  return cur
}

function childSchema(s: z.ZodType, seg: Segment): z.ZodType | undefined {
  const u = unwrapSchema(s)
  if (u instanceof z.ZodObject) return (u.shape as Record<string, z.ZodType | undefined>)[String(seg)]
  if (u instanceof z.ZodRecord) return u.valueType as z.ZodType
  if (u instanceof z.ZodArray) return u.element as z.ZodType
  if (u instanceof z.ZodUnion) {
    for (const opt of u.options as readonly z.ZodType[]) {
      const c = childSchema(opt, seg)
      if (c !== undefined) return c
    }
  }
  return undefined
}

/** The keys an object at `segs` accepts (empty when the path leaves the schema). */
export function validKeysAt(segs: readonly Segment[], schema: z.ZodType = DimFactoryConfigZ): string[] {
  let cur: z.ZodType | undefined = schema
  for (const seg of segs) {
    if (cur === undefined) return []
    cur = childSchema(cur, seg)
  }
  if (cur === undefined) return []
  const u = unwrapSchema(cur)
  if (u instanceof z.ZodObject) return Object.keys(u.shape)
  if (u instanceof z.ZodUnion) {
    const keys = new Set<string>()
    for (const opt of u.options as readonly z.ZodType[]) {
      const o = unwrapSchema(opt)
      if (o instanceof z.ZodObject) for (const k of Object.keys(o.shape)) keys.add(k)
    }
    return [...keys]
  }
  return []
}

// ---- parse --------------------------------------------------------------------------------------------------------------

const SYNTAX_MESSAGES: Readonly<Record<string, string>> = {
  InvalidSymbol: 'Invalid character',
  InvalidNumberFormat: 'Invalid number',
  PropertyNameExpected: 'Expected a property name in double quotes',
  ValueExpected: 'Expected a value',
  ColonExpected: 'Expected ":"',
  CommaExpected: 'Expected ","',
  CloseBraceExpected: 'Expected "}"',
  CloseBracketExpected: 'Expected "]"',
  EndOfFileExpected: 'Expected the end of the file (only one top-level value is allowed)',
  InvalidCommentToken: 'Invalid comment',
  UnexpectedEndOfComment: 'Unterminated block comment',
  UnexpectedEndOfString: 'Unterminated string',
  UnexpectedEndOfNumber: 'Unterminated number',
  InvalidUnicode: 'Invalid unicode escape',
  InvalidEscapeCharacter: 'Invalid escape character',
  InvalidCharacter: 'Invalid character in string',
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const pathSegments = (path: readonly PropertyKey[]): Segment[] =>
  path.map((s) => (typeof s === 'number' ? s : String(s)))

interface IssueDraft {
  pointer: string
  code: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

/** Parse and validate config text (pure; no IO). */
export function parseConfigText(fullText: string, o: ParseConfigOptions): LoadResult {
  const bom = fullText.charCodeAt(0) === 0xfeff
  // Offsets are relative to the text after the BOM, which is what an editor shows as column 1.
  const text = bom ? fullText.slice(1) : fullText
  const starts = lineStarts(text)
  const issues: ConfigIssue[] = []
  const at = (start: number, end: number, d: IssueDraft): void => {
    const s = positionAt(starts, start)
    const e = positionAt(starts, Math.max(start, end))
    issues.push({
      file: o.file,
      pointer: d.pointer,
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      code: d.code,
      message: d.message,
      severity: d.severity,
      ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
    })
  }
  const atNode = (node: Node, d: IssueDraft): void => at(node.offset, node.offset + node.length, d)

  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })
  const base = {
    file: o.file,
    scope: o.scope,
    exists: true,
    text: fullText,
    sha256: sha256(fullText),
    eol: detectEol(text),
    indent: detectIndent(text, root, starts),
    bom,
  }

  // Nothing but whitespace and comments: an empty config.
  if (root === undefined && stripComments(text).trim() === '') {
    return { ...base, value: {}, raw: {}, issues: [], lines: {} }
  }
  if (errors.length > 0 || root === undefined) {
    for (const e of errors) {
      const name = printParseErrorCode(e.error)
      at(e.offset, e.offset + e.length, {
        pointer: '',
        code: 'syntax',
        message: SYNTAX_MESSAGES[name] ?? name,
        severity: 'error',
      })
    }
    return {
      ...base,
      issues: sortIssues(issues),
      lines: root !== undefined ? collectLines(root, starts) : {},
    }
  }

  const lines = collectLines(root, starts)
  const raw: unknown = getNodeValue(root)
  duplicateKeyWarnings(root, [], atNode)

  const parsed = DimFactoryConfigZ.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const segs = pathSegments(issue.path)
      if (issue.code === 'unrecognized_keys') {
        const valid = validKeysAt(segs)
        for (const key of issue.keys) {
          const keySegs = [...segs, key]
          const hint = suggestName(
            key,
            valid.filter((k) => k !== key),
          )
          // The Plan pass has the most keys (its own, Clarify's, Research's and Explain's): fifteen.
          const allowed = hint === undefined && valid.length > 0 && valid.length <= 15
          atNode(keyNodeAt(root, keySegs).node, {
            pointer: toJsonPointer(keySegs),
            code: 'unrecognized_keys',
            message:
              `Unknown key "${key}"` +
              (hint !== undefined ? ` (did you mean "${hint}"?)` : '') +
              (allowed ? `. Allowed keys: ${valid.join(', ')}` : ''),
            severity: 'error',
            ...(hint !== undefined ? { suggestion: hint } : {}),
          })
        }
        continue
      }
      if (issue.code === 'invalid_key') {
        const inner = issue.issues[0]?.message
        const key = String(segs[segs.length - 1] ?? '')
        // `vendors.Claude`: the ids are a known set, so a near miss (any case) gets a suggestion.
        const hint =
          segs.length === 2 && segs[0] === 'vendors' ? suggestName(key, vendorIdsFor(raw)) : undefined
        atNode(keyNodeAt(root, segs).node, {
          pointer: toJsonPointer(segs),
          code: 'invalid_key',
          message:
            `Invalid key "${key}"` +
            (hint !== undefined ? ` (did you mean "${hint}"?)` : inner !== undefined ? `: ${inner}` : ''),
          severity: 'error',
          ...(hint !== undefined ? { suggestion: hint } : {}),
        })
        continue
      }
      const found = nodeAt(root, segs)
      const last = segs[segs.length - 1]
      let message = issue.message
      if (segs.length === 0 && issue.code === 'invalid_type')
        message = 'dimfactory.json must contain a JSON object'
      else if (!found.exact && issue.code === 'invalid_type' && last !== undefined) {
        message = `Missing required key "${String(last)}"`
      }
      atNode(found.node, { pointer: toJsonPointer(segs), code: issue.code, message, severity: 'error' })
    }
    // Report a user-only key in a project file now too, rather than after the other errors are fixed.
    if (o.scope === 'project' && root.type === 'object') {
      for (const key of USER_ONLY_KEYS) {
        if (propertyNode(root, key) === undefined) continue
        atNode(keyNodeAt(root, [key]).node, userOnlyDraft(key))
      }
    }
    return { ...base, raw, issues: sortIssues(issues), lines }
  }

  const semantic = validateSemantics(parsed.data, {
    scope: o.scope,
    ...(o.inheritedTimeouts !== undefined ? { inheritedTimeouts: o.inheritedTimeouts } : {}),
    ...(o.managedFlags !== undefined ? { managedFlags: o.managedFlags } : {}),
    ...(o.forbiddenFlags !== undefined ? { forbiddenFlags: o.forbiddenFlags } : {}),
  })
  for (const s of semantic) {
    const segs = parseJsonPointer(s.pointer)
    // The key is what is wrong for these; for everything else, the value.
    const keyed = s.code === 'user-only-key' || s.code === 'flag-map-key'
    atNode((keyed ? keyNodeAt(root, segs) : nodeAt(root, segs)).node, {
      pointer: s.pointer,
      code: s.code,
      message: s.message,
      severity: s.severity,
    })
  }
  // `vendors.<id>` names a vendor this build knows or a configured local preset: settings under any other id would
  // never apply (Dim Factory would quietly run the PATH binary), so a typo is an error with a suggestion.
  // (In a project file `vendors` is already a user-only-key error.)
  const vendorIds = vendorIdsFor(parsed.data)
  for (const id of o.scope === 'user' ? Object.keys(parsed.data.vendors ?? {}) : []) {
    if (vendorIds.includes(id)) continue
    const hint = suggestName(id, vendorIds)
    atNode(keyNodeAt(root, ['vendors', id]).node, {
      pointer: toJsonPointer(['vendors', id]),
      code: 'unknown-vendor',
      message:
        `Unknown vendor "${id}"` +
        (hint !== undefined ? ` (did you mean "${hint}"?)` : `. Vendors: ${vendorIds.join(', ')}`),
      severity: 'error',
      ...(hint !== undefined ? { suggestion: hint } : {}),
    })
  }
  const sorted = sortIssues(issues)
  const ok = !sorted.some((i) => i.severity === 'error')
  return { ...base, ...(ok ? { value: parsed.data } : {}), raw, issues: sorted, lines }
}

/** The ids `vendors.<id>` accepts: the vendors this build knows, and `local-<id>` for each local preset in the file. */
export function vendorIdsFor(cfg: unknown): string[] {
  const out: string[] = [...KNOWN_VENDORS]
  const local = isRecord(cfg) ? cfg['local'] : undefined
  const presets = isRecord(local) ? local['presets'] : undefined
  if (Array.isArray(presets)) {
    for (const p of presets as unknown[]) {
      const id = isRecord(p) ? p['id'] : undefined
      if (typeof id === 'string' && id !== '') out.push(`${LOCAL_VENDOR_PREFIX}${id}`)
    }
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function userOnlyDraft(key: string): IssueDraft {
  return {
    pointer: toJsonPointer([key]),
    code: 'user-only-key',
    message: `"${key}" can only be set in your user dimfactory.json, not in a project file`,
    severity: 'error',
  }
}

function duplicateKeyWarnings(node: Node, segs: Segment[], atNode: (n: Node, d: IssueDraft) => void): void {
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const prop of node.children ?? []) {
      const key = prop.children?.[0]
      if (key === undefined || typeof key.value !== 'string') continue
      if (seen.has(key.value)) {
        atNode(key, {
          pointer: toJsonPointer([...segs, key.value]),
          code: 'duplicate-key',
          message: `Duplicate key "${key.value}"; the last one is used`,
          severity: 'warning',
        })
      }
      seen.add(key.value)
      const value = prop.children?.[1]
      if (value !== undefined) duplicateKeyWarnings(value, [...segs, key.value], atNode)
    }
  } else if (node.type === 'array') {
    ;(node.children ?? []).forEach((item, i) => duplicateKeyWarnings(item, [...segs, i], atNode))
  }
}

function sortIssues(issues: ConfigIssue[]): ConfigIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => a.issue.line - b.issue.line || a.issue.col - b.issue.col || a.i - b.i)
    .map((x) => x.issue)
}

// ---- files ----------------------------------------------------------------------------------------------------------------

export interface LoadConfigFileOptions extends Omit<ParseConfigOptions, 'file'> {
  /** For last-good storage: DIM_FACTORY_HOME paths (omit to skip storing). */
  paths?: HomePaths
  /** The project scope's folderKey (project last-good lives under backups/project/<folderKey>/). */
  folderKey?: string
  /**
   * The project scope's root: a subfolder's own project file keeps its last-good under
   * backups/project/<folderKey>/<fileKey>/ (paths.ts projectBackupDir). Omitted: the file is the scope root's.
   */
  scopeRoot?: string | null
}

function missingResult(file: string, scope: ConfigScope): LoadResult {
  return {
    file,
    scope,
    exists: false,
    issues: [],
    text: '',
    sha256: null,
    eol: '\n',
    indent: { ...DEFAULT_INDENT },
    bom: false,
    lines: {},
  }
}

/**
 * Read and validate a dimfactory.json. A missing file is `exists: false` with no issues; an unreadable one is an
 * `unreadable` issue. On success the text is stored as last-good (best effort; written only when it changed).
 */
export async function loadConfigFile(file: string, o: LoadConfigFileOptions): Promise<LoadResult> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return missingResult(file, o.scope)
    return {
      ...missingResult(file, o.scope),
      exists: true,
      issues: [
        {
          file,
          pointer: '',
          line: 1,
          col: 1,
          endLine: 1,
          endCol: 1,
          code: 'unreadable',
          message: `Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        },
      ],
    }
  }
  // The file's own bytes are hashed (the same sha256 backups.ts, trust grants and resolved.json use), so a file that
  // is not valid UTF-8 still matches a projectAuto grant made for it.
  const result = { ...parseConfigText(bytes.toString('utf8'), { ...o, file }), sha256: sha256Bytes(bytes) }
  if (result.value !== undefined && o.paths !== undefined) {
    const target = lastGoodPath(o.paths, o.scope, o.folderKey, {
      ...(o.scopeRoot !== undefined ? { scopeRoot: o.scopeRoot } : {}),
      path: file,
    })
    if (target !== undefined) await storeLastGood(target, bytes)
  }
  return result
}

const sha256Bytes = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** Write `data` to the last-good file unless it already holds exactly those bytes. Never throws. */
export async function storeLastGood(target: string, data: string | Uint8Array): Promise<boolean> {
  try {
    const next = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const current = await readFile(target).catch(() => undefined)
    if (current?.equals(next) === true) return false
    await writeFileAtomic(target, next)
    return true
  } catch {
    return false
  }
}

/** A loaded file as a resolve layer (`undefined` when it is missing or invalid). */
export function toConfigLayer(r: LoadResult): ConfigLayer | undefined {
  if (!r.exists || r.value === undefined) return undefined
  return { value: r.value, file: r.file, lines: r.lines }
}

/** One file layer for {@link resolve}: an already-validated config plus where its keys are. */
export interface ConfigLayer {
  value: DimFactoryConfig
  file?: string
  /** JSON pointer (into the file) → 1-based line of its key. */
  lines?: Readonly<Record<string, number>>
}

/** The provenance origin of a file layer. */
export function layerOrigin(scope: ConfigScope, layer: ConfigLayer): LayerOrigin {
  return {
    source: scope,
    ...(layer.file !== undefined ? { file: layer.file } : {}),
    ...(layer.lines !== undefined ? { lines: layer.lines } : {}),
  }
}
