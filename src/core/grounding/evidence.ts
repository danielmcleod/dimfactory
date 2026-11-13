// What a pass's tool calls leave as evidence for the grounding checks (StepState.grounding, kept in run.json): how many
// shell commands ran and how many of them were tests or builds (counts only, never the commands), the files whose
// edits failed again and again, the files the session read, and the files a vendor edited without reading them first.
// Pure: the reducer feeds it every tool event.
import type { NormalizedEventOf } from '../../shared/events.ts'

/** Paths kept at most (reads, edits without a read, failed edits). */
export const EVIDENCE_PATHS_MAX = 400

export interface GroundingTrack {
  /** Shell commands started. */
  shells: number
  /** ...of which ran tests (a test runner), and built or type-checked the code. */
  tests: number
  builds: number
  /** Failed edits per file. */
  failedEdits: Record<string, number>
  /** Files the session read (capped). */
  reads: string[]
  /** Files changed with an edit to an existing file that the session never read (Codex and ACP edits). */
  unreadEdits: string[]
}

export function newGroundingTrack(): GroundingTrack {
  return { shells: 0, tests: 0, builds: 0, failedEdits: {}, reads: [], unreadEdits: [] }
}

/** A test runner's command line (npm test, vitest, pytest, go test, cargo test…). */
export const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test(?::[\w-]+)?|npx\s+(?:vitest|jest|mocha|playwright)|vitest|jest|mocha|ava|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|rspec|phpunit|tox|nox|ctest|deno\s+test|bun\s+test|playwright\s+test|node\s+--test)(?=$|[\s;&|)])/i

/** A build or type check (tsc, npm run build, cargo build/check, go build/vet, make…). */
export const BUILD_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:build|typecheck|type-check|tsc|lint|compile)(?::[\w-]+)?|npx\s+tsc|tsc|vite\s+build|next\s+build|webpack|esbuild|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|make|cmake\s+--build|dotnet\s+build|mvn\s+(?:\S+\s+)*(?:package|compile|install)|gradlew?\s+(?:\S+\s+)*(?:build|assemble)|mypy|pyright|ruff\s+check|eslint|python3?\s+-m\s+(?:build|compileall|mypy))(?=$|[\s;&|)])/i

export type CommandKind = 'test' | 'build' | 'other'

export function commandKind(command: string): CommandKind {
  if (TEST_COMMAND.test(command)) return 'test'
  if (BUILD_COMMAND.test(command)) return 'build'
  return 'other'
}

const SHELL_TOOL = /^(?:shell|bash|powershell|execute)$/i
const EDIT_TOOL = /^(?:edit|write|multiedit|notebookedit|apply_patch|filechange)$/i
const READ_TOOL = /^read$/i

/** `/` separators, no leading `./`. */
export function normPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^["'`]|["'`]$/g, '')
}

/**
 * The files of an edit's summary: Claude's tools name one path; Codex's `edit` lists `M a.ts, A b.ts, R a -> b`
 * (kind letter first). `modified`: only the files that existed before (M, R's source).
 */
export function editPaths(summary: string): { all: string[]; modified: string[] } {
  const parts = summary.split(/,\s+/)
  const lettered = parts.every((p) => /^[MADR] \S/.test(p))
  if (!lettered) {
    const one = normPath(summary)
    return one !== '' && !/\s/.test(one) ? { all: [one], modified: [one] } : { all: [], modified: [] }
  }
  const all: string[] = []
  const modified: string[] = []
  for (const p of parts) {
    const letter = p[0]
    const rest = p.slice(2)
    const [from = '', to] = rest.split(' -> ')
    all.push(normPath(to ?? from))
    if (letter === 'M' || letter === 'R') modified.push(normPath(from))
  }
  return { all, modified }
}

function pushCapped(list: string[], v: string): void {
  if (v === '' || list.includes(v) || list.length >= EVIDENCE_PATHS_MAX) return
  list.push(v)
}

const READ_COMMAND = /^(?:cat|type|Get-Content|gc|head|tail|sed\s+-n\s+\S+|less|more)\s+(.+)$/i

/**
 * What a tool's read reads (Claude `Read`, ACP read; Codex reads through its shell as "Read <path>" or `$ cat x`,
 * often several in one line: `$ Get-Content a; Get-Content b`). Empty: the call read no file we can name.
 */
function readPathsOf(name: string, summary: string): string[] {
  if (READ_TOOL.test(name)) return summary.trim() !== '' ? [normPath(summary)] : []
  if (!/^shell$/i.test(name)) return []
  const line = summary.trim().replace(/^\$\s*/, '')
  if (line.startsWith('Read ')) return [normPath(line.slice(5))]
  const out: string[] = []
  // Each command of the line; what a pipe feeds into is not a read.
  for (const part of line.split(/;|&&|\|\|/)) {
    const m = READ_COMMAND.exec((part.split('|')[0] ?? '').trim())
    if (m === null) continue
    for (const arg of (m[1] ?? '').split(/\s+/)) {
      if (arg !== '' && !arg.startsWith('-')) out.push(normPath(arg))
    }
  }
  return out
}

/** One tool event (start or end) into the track. */
export function noteTool(t: GroundingTrack, ev: NormalizedEventOf<'tool'>): void {
  const name = ev.name
  if (ev.phase === 'end') {
    if (EDIT_TOOL.test(name) && ev.status === 'failed') {
      for (const p of editPaths(ev.summary).all) {
        if (t.failedEdits[p] === undefined && Object.keys(t.failedEdits).length >= EVIDENCE_PATHS_MAX)
          continue
        t.failedEdits[p] = (t.failedEdits[p] ?? 0) + 1
      }
    }
    return
  }
  // A start; a subagent's progress repeats its start row: only a call with a fingerprint counts.
  if (ev.phase !== 'start' || ev.fp === undefined) return
  const reads = readPathsOf(name, ev.summary)
  for (const read of reads) pushCapped(t.reads, read)
  if (SHELL_TOOL.test(name)) {
    if (reads.length > 0) return
    t.shells += 1
    const kind = commandKind(ev.summary)
    if (kind === 'test') t.tests += 1
    else if (kind === 'build') t.builds += 1
    return
  }
  // Codex and ACP edits: an existing file changed with no read of it first (Claude's Edit refuses that on its own).
  if (name === 'edit') {
    for (const p of editPaths(ev.summary).modified) {
      if (!t.reads.includes(p)) pushCapped(t.unreadEdits, p)
    }
  }
}
