// Pure diff parsing and the prompt-patch post-processor (and persisted patches parsed back into rows for history
// runs' Diff tab). No git calls here: shadow.ts
// runs diff-tree and hands the output over, so every rule below is unit-testable.
//
// Prompt patch = `diff-tree -r -p -M --no-color --no-ext-diff --ignore-cr-at-eol` (never --binary), then:
//   1. a "Files changed (N):" header, one line per file;
//   2. lockfiles, minified files, `.map`, linguist-generated files and binaries collapsed to one stat line each;
//   3. EOL-only changes listed separately (their empty sections dropped);
//   4. a size cap of min(150 KB, 0.25 × contextWindow × 3.5), replacing the largest sections with stubs.
import type { FileChange } from '../../shared/ipc.ts'

export const PROMPT_PATCH_MAX_BYTES = 150 * 1024
/** Unknown contextWindow for claude/codex/gemini (the assumed context). */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Unknown contextWindow for local presets. */
export const LOCAL_CONTEXT_WINDOW = 32_000
const BYTES_PER_TOKEN = 3.5
const PATCH_SHARE_OF_CONTEXT = 0.25

/** `min(150 KB, 0.25 × contextWindow × 3.5)`; a missing/invalid window counts as 200,000 tokens. */
export function promptPatchCap(contextWindow?: number | null): number {
  const window =
    contextWindow !== undefined &&
    contextWindow !== null &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW
  return Math.min(PROMPT_PATCH_MAX_BYTES, Math.floor(PATCH_SHARE_OF_CONTEXT * window * BYTES_PER_TOKEN))
}

// ---- collapse rules -----------------------------------------------------------------------

/** Lockfiles collapsed to a stat line (basename match). */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'Package.resolved',
  'deno.lock',
]

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export function isLockfile(p: string): boolean {
  const name = baseName(p)
  return LOCKFILE_NAMES.includes(name) || /^bun\.lock/.test(name)
}

/** `*.min.*` and source maps (`*.map`). */
export function isMinifiedOrMap(p: string): boolean {
  const name = baseName(p)
  return /\.min\.[^./]+$/i.test(name) || /\.map$/i.test(name)
}

export type CollapseReason = 'lockfile' | 'minified' | 'generated' | 'binary'

export function collapseReason(change: FileChange, generated: boolean): CollapseReason | null {
  if (change.binary) return 'binary'
  if (isLockfile(change.path) || (change.oldPath !== undefined && isLockfile(change.oldPath)))
    return 'lockfile'
  if (isMinifiedOrMap(change.path)) return 'minified'
  if (generated) return 'generated'
  return null
}

// ---- git path quoting (quote_c_style with core.quotepath=false) ---------------------------

const C_ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
}

/** Quote a path the way git prints it in patch headers (only `"`, `\` and control characters force quotes). */
export function quoteGitPath(p: string): string {
  const bytes = Buffer.from(p, 'utf8')
  let needs = false
  for (const b of bytes) {
    if (b < 0x20 || b === 0x22 || b === 0x5c || b === 0x7f) {
      needs = true
      break
    }
  }
  if (!needs) return p
  const out: number[] = []
  const pushAscii = (s: string): void => {
    for (const ch of s) out.push(ch.charCodeAt(0))
  }
  for (const b of bytes) {
    const esc = C_ESCAPES[b]
    if (esc !== undefined) pushAscii(esc)
    else if (b < 0x20 || b === 0x7f) pushAscii(`\\${b.toString(8).padStart(3, '0')}`)
    else out.push(b)
  }
  return `"${Buffer.from(out).toString('utf8')}"`
}

/** Inverse of quoteGitPath for one token (unquoted input is returned as is). */
export function unquoteGitPath(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? ''
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      continue
    }
    const next = body[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(named[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// ---- diff-tree -z parsers ------------------------------------------------------------------

export type ChangeStatus = FileChange['status']

export interface RawRecord {
  status: ChangeStatus
  /** Similarity for renames (R086 → 86). */
  score?: number
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  path: string
  oldPath?: string
}

const STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'T'])

/** `diff-tree -r -z -M --raw`: `:om nm os ns S[score] NUL path [NUL path2] NUL`. Copies (C) are reported as A. */
export function parseRawZ(out: string): RawRecord[] {
  const tokens = out.split('\0')
  const records: RawRecord[] = []
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i] ?? ''
    if (!meta.startsWith(':')) continue
    const [oldMode = '', newMode = '', oldSha = '', newSha = '', st = ''] = meta.slice(1).split(' ')
    const letter = st.charAt(0)
    const score = st.length > 1 ? Number(st.slice(1)) : undefined
    if (letter === 'R' || letter === 'C') {
      const src = tokens[++i] ?? ''
      const dst = tokens[++i] ?? ''
      const rec: RawRecord =
        letter === 'R'
          ? { status: 'R', oldMode, newMode, oldSha, newSha, path: dst, oldPath: src }
          : { status: 'A', oldMode: '000000', newMode, oldSha: '0'.repeat(oldSha.length), newSha, path: dst }
      if (score !== undefined && Number.isFinite(score)) rec.score = score
      records.push(rec)
      continue
    }
    const p = tokens[++i] ?? ''
    const status = (STATUSES.has(letter) ? letter : 'M') as ChangeStatus
    records.push({ status, oldMode, newMode, oldSha, newSha, path: p })
  }
  return records
}

export interface NumstatRecord {
  /** null when git reports the file as binary (`-`). */
  added: number | null
  deleted: number | null
  path: string
  oldPath?: string
}

/** `diff-tree -r -z -M --numstat`: `a TAB d TAB path NUL`, or `a TAB d TAB NUL src NUL dst NUL` for renames. */
export function parseNumstatZ(out: string): NumstatRecord[] {
  const tokens = out.split('\0')
  const records: NumstatRecord[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    if (tok === '') continue
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tok)
    if (m === null) continue
    const added = m[1] === '-' ? null : Number(m[1])
    const deleted = m[2] === '-' ? null : Number(m[2])
    const rest = m[3] ?? ''
    if (rest === '') {
      const src = tokens[++i] ?? ''
      const dst = tokens[++i] ?? ''
      records.push({ added, deleted, path: dst, oldPath: src })
    } else {
      records.push({ added, deleted, path: rest })
    }
  }
  return records
}

export interface LineStats {
  added: number | null
  deleted: number | null
}

export interface DiffSummary {
  changes: FileChange[]
  /** Per path: line counts with `--ignore-cr-at-eol` (what the prompt patch shows). */
  promptStats: Map<string, LineStats>
}

const GITLINK = '160000'

/**
 * Merge `--raw`, `--numstat` and `--numstat --ignore-cr-at-eol` (all `-z -M`) into FileChange rows. A text change
 * whose lines all vanish under --ignore-cr-at-eol (absent from that numstat, or 0/0) is `eolOnly`.
 */
export function mergeDiff(rawOut: string, numstatOut: string, numstatIgnoringCrOut: string): DiffSummary {
  const nums = new Map(parseNumstatZ(numstatOut).map((n) => [n.path, n]))
  const numsCr = new Map(parseNumstatZ(numstatIgnoringCrOut).map((n) => [n.path, n]))
  const changes: FileChange[] = []
  const promptStats = new Map<string, LineStats>()
  for (const r of parseRawZ(rawOut)) {
    const n = nums.get(r.path)
    const gitlink = r.oldMode === GITLINK || r.newMode === GITLINK
    const binary = !gitlink && n !== undefined && n.added === null && n.deleted === null
    const added = n?.added ?? (binary ? null : 0)
    const deleted = n?.deleted ?? (binary ? null : 0)
    const cr = numsCr.get(r.path)
    const crAdded = binary ? null : (cr?.added ?? 0)
    const crDeleted = binary ? null : (cr?.deleted ?? 0)
    const textChanged = (added ?? 0) + (deleted ?? 0) > 0
    const eolOnly =
      !binary &&
      !gitlink &&
      (r.status === 'M' || r.status === 'R') &&
      textChanged &&
      (crAdded ?? 0) + (crDeleted ?? 0) === 0
    const change: FileChange = {
      status: r.status,
      path: r.path,
      oldMode: r.oldMode,
      newMode: r.newMode,
      oldSha: r.oldSha,
      newSha: r.newSha,
      added,
      deleted,
      binary,
      gitlink,
      eolOnly,
    }
    if (r.oldPath !== undefined) change.oldPath = r.oldPath
    changes.push(change)
    promptStats.set(r.path, { added: crAdded, deleted: crDeleted })
  }
  return { changes, promptStats }
}

// ---- patch sections ------------------------------------------------------------------------

export interface PatchSection {
  /** The `diff --git …` line. */
  header: string
  /** The whole section including the header line, ending with a newline. */
  text: string
  /** The section carries at least one `@@` hunk. */
  hasHunks: boolean
}

/** Split `diff-tree -p` output into per-file sections (a section starts at a column-0 `diff --git ` line). */
export function splitPatchSections(raw: string): PatchSection[] {
  if (raw === '') return []
  const sections: PatchSection[] = []
  const starts: number[] = []
  if (raw.startsWith('diff --git ')) starts.push(0)
  for (let i = raw.indexOf('\ndiff --git '); i !== -1; i = raw.indexOf('\ndiff --git ', i + 1))
    starts.push(i + 1)
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] ?? 0
    const to = starts[k + 1] ?? raw.length
    let text = raw.slice(from, to)
    if (!text.endsWith('\n')) text += '\n'
    const nl = text.indexOf('\n')
    const header = text.slice(0, nl).replace(/\r$/, '')
    sections.push({ header, text, hasHunks: /\n@@ /.test(text) })
  }
  return sections
}

/** The header git prints for a change: `diff --git a/<old> b/<new>` (each side quoted if needed). */
export function expectedDiffHeader(change: Pick<FileChange, 'path' | 'oldPath'>): string {
  const oldP = change.oldPath ?? change.path
  return `diff --git ${quoteGitPath(`a/${oldP}`)} ${quoteGitPath(`b/${change.path}`)}`
}

/** Best-effort path of a section git printed that matched no change (unquoted, symmetric `a/X b/X` split). */
function sectionPath(header: string): string {
  const rest = header.slice('diff --git '.length)
  const q = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (q !== null) return unquoteGitPath(`"${q[2] ?? ''}"`).replace(/^b\//, '')
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2
    const a = rest.slice(0, half)
    const b = rest.slice(half + 1)
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) return b.slice(2)
  }
  const idx = rest.lastIndexOf(' b/')
  return idx === -1 ? rest : rest.slice(idx + 3)
}

// ---- prompt patch --------------------------------------------------------------------------

export interface PromptPatchFile {
  change: FileChange
  /** Line counts as the prompt shows them (`--ignore-cr-at-eol`); null for binaries. */
  added: number | null
  deleted: number | null
  /** `linguist-generated` is set for this path (check-attr in the shadow env). */
  generated: boolean
}

export interface PromptPatch {
  text: string
  bytes: number
  capBytes: number
  /** Files in the "Files changed" header. */
  files: number
  /** Paths collapsed to a stat line (lockfiles, minified, generated, binary). */
  collapsed: string[]
  /** Paths whose section was replaced by a stub to fit the cap. */
  omitted: string[]
  /** Paths whose only change is line endings. */
  eolOnly: string[]
  /** Even stubs did not fit: the text was cut at the cap. */
  truncated: boolean
}

const statText = (added: number | null, deleted: number | null): string =>
  added === null || deleted === null ? '(binary)' : `+${added} -${deleted}`

const displayPath = (c: FileChange): string =>
  c.oldPath !== undefined && c.oldPath !== c.path ? `${c.oldPath} -> ${c.path}` : c.path

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

interface Piece {
  path: string
  text: string
  stub: string | null
}

/** Cut `text` to at most `max` UTF-8 bytes, at a line boundary when one is near. */
function cutBytes(text: string, max: number): string {
  if (max <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  let cut = buf.subarray(0, max).toString('utf8')
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  const nl = cut.lastIndexOf('\n')
  return nl > cut.length / 2 ? cut.slice(0, nl + 1) : cut
}

/**
 * Post-process a `diff-tree -p --ignore-cr-at-eol` patch for a prompt. `files` comes from mergeDiff (+ check-attr)
 * in diff-tree order; sections are matched to files by their exact `diff --git` header.
 */
export function buildPromptPatch(
  raw: string,
  files: readonly PromptPatchFile[],
  opts: { capBytes: number },
): PromptPatch {
  const capBytes = Math.max(0, Math.floor(opts.capBytes))
  const byHeader = new Map<string, PromptPatchFile>()
  for (const f of files) byHeader.set(expectedDiffHeader(f.change), f)

  const collapsed: string[] = []
  const eolOnly: string[] = []
  const lines: string[] = []
  const reasons = new Map<string, CollapseReason>()
  for (const f of files) {
    const c = f.change
    const reason = collapseReason(c, f.generated)
    let line = `${c.status} ${displayPath(c)}`
    if (c.gitlink) line += ' (submodule)'
    else if (c.eolOnly) line += ' (line endings only)'
    else line += ` ${statText(f.added, f.deleted)}`
    if (reason !== null) {
      reasons.set(c.path, reason)
      collapsed.push(c.path)
      line += ` [collapsed: ${reason}]`
    }
    if (c.eolOnly) eolOnly.push(c.path)
    lines.push(line)
  }

  let header = `Files changed (${files.length}):\n${lines.join('\n')}\n`
  if (eolOnly.length > 0) header += `\nLine endings only (${eolOnly.length}): ${eolOnly.join(', ')}\n`

  const pieces: Piece[] = []
  const seen = new Set<string>()
  const pushCollapsed = (f: PromptPatchFile, reason: CollapseReason): void => {
    pieces.push({
      path: f.change.path,
      text: `[collapsed: ${displayPath(f.change)} ${statText(f.added, f.deleted)} (${reason})]\n`,
      stub: null,
    })
  }
  for (const s of splitPatchSections(raw)) {
    const f = byHeader.get(s.header)
    if (f === undefined) {
      const p = sectionPath(s.header)
      pieces.push({ path: p, text: s.text, stub: `[diff omitted: ${p} — read the file if needed]\n` })
      continue
    }
    const c = f.change
    seen.add(c.path)
    const reason = reasons.get(c.path)
    if (reason !== undefined) {
      pushCollapsed(f, reason)
      continue
    }
    // An EOL-only modification has nothing left to show once CRs are ignored (git ≥ 2.2x drops the section;
    // 2.17 prints a bare header). Renames keep their header so the move stays visible.
    if (c.eolOnly && c.status === 'M') continue
    if (c.eolOnly && !s.hasHunks) {
      pieces.push({ path: c.path, text: s.text, stub: null })
      continue
    }
    pieces.push({
      path: c.path,
      text: s.text,
      stub: `[diff omitted: ${displayPath(c)} ${statText(f.added, f.deleted)} — read the file if needed]\n`,
    })
  }
  // Collapsed files git printed no section for (e.g. an EOL-only lockfile) still get their stat line.
  for (const f of files) {
    const reason = reasons.get(f.change.path)
    if (reason !== undefined && !seen.has(f.change.path) && !f.change.eolOnly) pushCollapsed(f, reason)
  }

  const omitted: string[] = []
  const join = (): string =>
    pieces.length === 0 ? header : `${header}\n${pieces.map((p) => p.text).join('')}`
  let total =
    utf8Bytes(header) + (pieces.length === 0 ? 0 : 1) + pieces.reduce((n, p) => n + utf8Bytes(p.text), 0)
  while (total > capBytes) {
    let best: Piece | undefined
    let bestBytes = 0
    for (const p of pieces) {
      if (p.stub === null) continue
      const b = utf8Bytes(p.text)
      if (b > utf8Bytes(p.stub) && b > bestBytes) {
        best = p
        bestBytes = b
      }
    }
    if (best === undefined || best.stub === null) break
    total -= bestBytes - utf8Bytes(best.stub)
    best.text = best.stub
    best.stub = null
    omitted.push(best.path)
  }

  let text = join()
  let truncated = false
  if (utf8Bytes(text) > capBytes) {
    const marker = '\n[diff truncated: too large for the prompt — read the files if needed]\n'
    text = cutBytes(text, capBytes - utf8Bytes(marker)) + marker
    if (utf8Bytes(text) > capBytes) text = cutBytes(text, capBytes)
    truncated = true
  }
  return {
    text,
    bytes: utf8Bytes(text),
    capBytes,
    files: files.length,
    collapsed,
    omitted,
    eolOnly,
    truncated,
  }
}

// ---- persisted patches (history runs render the persisted .patch files) ----------------------------------------

const ZERO_MODE = '000000'
const GITLINK_MODE = '160000'

/** A `---` / `+++` / `rename from` path: unquoted, without git's `a/` or `b/` and the tab git adds after a space. */
function patchPath(token: string, prefix: 'a/' | 'b/' | ''): string | null {
  let t = token.replace(/\t$/, '')
  if (t === '/dev/null') return null
  t = unquoteGitPath(t)
  return prefix !== '' && t.startsWith(prefix) ? t.slice(prefix.length) : t
}

interface HunkLines {
  /** Removed lines, each with a `\n` appended when git said "\ No newline at end of file" for it. */
  minus: string[]
  plus: string[]
  added: number
  deleted: number
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

/** The hunks of one section (`lines` from its first `@@`), counted by the header's line numbers. */
function hunkLines(lines: readonly string[], from: number): HunkLines[] {
  const out: HunkLines[] = []
  let i = from
  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i] ?? '')
    if (m === null) {
      i++
      continue
    }
    let oldLeft = m[1] === undefined ? 1 : Number(m[1])
    let newLeft = m[2] === undefined ? 1 : Number(m[2])
    const h: HunkLines = { minus: [], plus: [], added: 0, deleted: 0 }
    let last: string[] | undefined
    i++
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] ?? '').startsWith('\\'))) {
      const l = lines[i] ?? ''
      const c = l.charAt(0)
      if (c === '\\') {
        if (last !== undefined && last.length > 0) last[last.length - 1] += '\n'
      } else if (c === '-') {
        h.minus.push(l.slice(1))
        h.deleted++
        oldLeft--
        last = h.minus
      } else if (c === '+') {
        h.plus.push(l.slice(1))
        h.added++
        newLeft--
        last = h.plus
      } else {
        oldLeft--
        newLeft--
        last = undefined
      }
      i++
    }
    out.push(h)
  }
  return out
}

/** Every removed line equals its added line once a trailing CR is ignored (git `--ignore-cr-at-eol`). */
function crOnly(h: Pick<HunkLines, 'minus' | 'plus'>): boolean {
  if (h.minus.length === 0 || h.minus.length !== h.plus.length) return false
  const strip = (s: string): string => s.replace(/\r(\n?)$/, '$1')
  return h.minus.every((m, k) => strip(m) === strip(h.plus[k] ?? ''))
}

/**
 * One FileChange per section of a `diff-tree -p -M` patch (the run's persisted `diffs/<a>..<b>.patch`): status,
 * paths, modes, the abbreviated blob ids of the `index` line, line counts from the hunks, binary, gitlink and
 * EOL-only (every removed line comes back with only a CR added or removed). The rows the shadow would give, read
 * from text: a type change (a file that became a link, or the reverse), which git prints as a delete section and then
 * an add section for the same path, is one `T` row as diff-tree --raw gives it.
 */
export function parsePatchFiles(raw: string): FileChange[] {
  return joinTypeChanges(parseSections(raw))
}

/** The type of a mode (`10` file, `12` link, `16` gitlink). */
const modeType = (mode: string): string => mode.slice(0, 2)

/** A delete section directly followed by an add section of the same path whose type differs: git's type change. */
function isTypeChangePair(a: FileChange | undefined, b: FileChange | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.status === 'D' &&
    b.status === 'A' &&
    a.path === b.path &&
    a.oldMode !== '' &&
    b.newMode !== '' &&
    modeType(a.oldMode) !== modeType(b.newMode)
  )
}

/** One `T` row per type change: the old side from its delete, the new side from its add, the counts summed. */
function joinTypeChanges(rows: readonly FileChange[]): FileChange[] {
  const out: FileChange[] = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i] as FileChange
    const b = rows[i + 1]
    if (b === undefined || !isTypeChangePair(a, b)) {
      out.push(a)
      continue
    }
    const sum = (x: number | null, y: number | null): number | null =>
      x === null || y === null ? null : x + y
    out.push({
      status: 'T',
      path: a.path,
      oldMode: a.oldMode,
      newMode: b.newMode,
      oldSha: a.oldSha,
      newSha: b.newSha,
      added: sum(a.added, b.added),
      deleted: sum(a.deleted, b.deleted),
      binary: a.binary || b.binary,
      gitlink: a.gitlink || b.gitlink,
      eolOnly: false,
    })
    i++
  }
  return out
}

function parseSections(raw: string): FileChange[] {
  const out: FileChange[] = []
  for (const s of splitPatchSections(raw)) {
    const lines = s.text.replace(/\n$/, '').split('\n')
    let oldMode = ''
    let newMode = ''
    let status: ChangeStatus = 'M'
    let renameFrom: string | null = null
    let renameTo: string | null = null
    let minusPath: string | null = null
    let plusPath: string | null = null
    let oldSha = ''
    let newSha = ''
    let similarity: number | undefined
    let binary = false
    let firstHunk = -1
    for (let i = 1; i < lines.length; i++) {
      const l = (lines[i] ?? '').replace(/\r$/, '')
      if (l.startsWith('@@ ')) {
        firstHunk = i
        break
      }
      let m: RegExpExecArray | null
      if ((m = /^old mode (\d+)$/.exec(l)) !== null) oldMode = m[1] ?? ''
      else if ((m = /^new mode (\d+)$/.exec(l)) !== null) newMode = m[1] ?? ''
      else if ((m = /^new file mode (\d+)$/.exec(l)) !== null) {
        status = 'A'
        oldMode = ZERO_MODE
        newMode = m[1] ?? ''
      } else if ((m = /^deleted file mode (\d+)$/.exec(l)) !== null) {
        status = 'D'
        oldMode = m[1] ?? ''
        newMode = ZERO_MODE
      } else if ((m = /^similarity index (\d+)%$/.exec(l)) !== null) similarity = Number(m[1])
      else if (l.startsWith('rename from ')) renameFrom = patchPath(l.slice('rename from '.length), '')
      else if (l.startsWith('rename to ')) renameTo = patchPath(l.slice('rename to '.length), '')
      else if ((m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(l)) !== null) {
        oldSha = m[1] ?? ''
        newSha = m[2] ?? ''
        if (m[3] !== undefined) {
          if (oldMode === '') oldMode = m[3]
          if (newMode === '') newMode = m[3]
        }
      } else if (l.startsWith('--- ')) minusPath = patchPath(l.slice(4), 'a/')
      else if (l.startsWith('+++ ')) plusPath = patchPath(l.slice(4), 'b/')
      else if (l.startsWith('Binary files ') || l === 'GIT binary patch') binary = true
    }
    if (renameFrom !== null || renameTo !== null) status = 'R'
    const path = renameTo ?? plusPath ?? minusPath ?? sectionPath(s.header)
    const oldPath = status === 'R' ? (renameFrom ?? minusPath ?? undefined) : undefined
    // git prints a type change (a file became a link) as a delete section and an add section, even without -B
    // (joinTypeChanges makes them one row); a single section that still carries both modes is one too.
    if (status === 'M' && oldMode !== '' && newMode !== '' && modeType(oldMode) !== modeType(newMode)) {
      status = 'T'
    }
    const zero = (sha: string): string => '0'.repeat(Math.max(7, sha.length))
    if (status === 'A' && oldSha === '') oldSha = zero(newSha)
    if (status === 'D' && newSha === '') newSha = zero(oldSha)
    const gitlink = oldMode === GITLINK_MODE || newMode === GITLINK_MODE
    const hunks = firstHunk === -1 ? [] : hunkLines(lines, firstHunk)
    const added = binary ? null : hunks.reduce((n, h) => n + h.added, 0)
    const deleted = binary ? null : hunks.reduce((n, h) => n + h.deleted, 0)
    const eolOnly =
      !binary && !gitlink && (status === 'M' || status === 'R') && hunks.length > 0 && hunks.every(crOnly)
    const change: FileChange = {
      status,
      path,
      oldMode,
      newMode,
      oldSha,
      newSha,
      added,
      deleted,
      binary,
      gitlink,
      eolOnly,
    }
    if (oldPath !== undefined) change.oldPath = oldPath
    if (status === 'R' && similarity !== undefined) change.similarity = similarity
    out.push(change)
  }
  return out
}

/**
 * A section of a persisted patch as `--ignore-cr-at-eol` would show it: hunks whose only change is a CR at line ends
 * are left out (an EOL-only file keeps just its header). An approximation of git's own option for patches whose
 * snapshots are gone: a hunk mixing real and CR-only changes is kept whole.
 */
export function withoutCrOnlyHunks(section: string): string {
  const lines = section.replace(/\n$/, '').split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@ '))
  if (first === -1) return section
  const kept: string[] = lines.slice(0, first)
  let i = first
  while (i < lines.length) {
    let end = i + 1
    while (end < lines.length && !(lines[end] ?? '').startsWith('@@ ')) end++
    const [h] = hunkLines(lines.slice(i, end), 0)
    if (h === undefined || !crOnly(h)) kept.push(...lines.slice(i, end))
    i = end
  }
  const hasHunk = kept.some((l) => l.startsWith('@@ '))
  const text = hasHunk ? kept : kept.filter((l) => !/^(---|\+\+\+) /.test(l))
  return `${text.join('\n')}\n`
}

/**
 * The section of `raw` for `change`: by its exact `diff --git` header, else by the path the section names. A type
 * change's two sections (its delete, then its add, under one header) come back together, as diff.file reads them from
 * the shadow.
 */
export function patchSectionFor(
  raw: string,
  change: Pick<FileChange, 'path' | 'oldPath'>,
): PatchSection | undefined {
  const sections = splitPatchSections(raw)
  const header = expectedDiffHeader(change)
  let at = sections.findIndex((s) => s.header === header)
  if (at === -1) at = sections.findIndex((s) => parseSections(s.text)[0]?.path === change.path)
  const first = sections[at]
  if (first === undefined) return undefined
  const next = sections[at + 1]
  if (
    next !== undefined &&
    next.header === first.header &&
    isTypeChangePair(parseSections(first.text)[0], parseSections(next.text)[0])
  ) {
    return { header: first.header, text: first.text + next.text, hasHunks: first.hasHunks || next.hasHunks }
  }
  return first
}
