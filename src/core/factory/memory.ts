// Project memory: the DIM_FACTORY.md file (BRAND.memoryFileName) at a project's root, its conventions, decisions and
// notes from earlier runs. Every run reads it at its start, capped at `memory.maxBytes`, and each pass gets it as
// `{{memory}}`. After a run, Dim Factory proposes an update (the run's note added under "## Run notes", the oldest
// notes dropped past MEMORY_RUN_NOTES_MAX) as a diff you approve; nothing is written without you, except that an Auto
// run in a project that opted in (`memory.autoApply`, project file only) writes it itself. A write checks that the
// file is still the one the proposal was made from (its sha256), so a change made meanwhile is never overwritten.
//
// Proposals are kept under DIM_FACTORY_HOME/memory/<folder key>/<runId>.json, never in the project.
import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BRAND } from '../../shared/brand.ts'
import { MEMORY_RUN_NOTES_MAX } from '../../shared/factory.ts'
import type { MemoryProposalView } from '../../shared/factory.ts'
import type { RunOutcome } from '../../shared/run.ts'
import { briefKey } from '../brief/store.ts'
import { DimFactoryError } from '../errors.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { localDate } from './schedule.ts'

export const memoryFileOf = (root: string): string => join(root, BRAND.memoryFileName)

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface MemoryRead {
  /** The text a run gets (capped); null when the file does not exist or is empty. */
  text: string | null
  exists: boolean
  bytes: number
  capped: boolean
  /** The whole file's sha256 (null: no file). */
  sha256: string | null
}

/** The longest prefix of `text` that fits `maxBytes` of UTF-8, cut at a line end when one is near. */
function capUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let cut = buf.subarray(0, maxBytes).toString('utf8')
  // A character cut in half decodes as U+FFFD: drop it.
  cut = cut.replace(/\uFFFD+$/, '')
  const nl = cut.lastIndexOf('\n')
  return nl > cut.length * 0.8 ? cut.slice(0, nl) : cut
}

/** Read the memory file for a run: its text capped at `maxBytes` (with a line saying so), or null without one. */
export async function readMemory(file: string, maxBytes: number): Promise<MemoryRead> {
  let full: string
  try {
    full = await readFile(file, 'utf8')
  } catch {
    return { text: null, exists: false, bytes: 0, capped: false, sha256: null }
  }
  const bytes = Buffer.byteLength(full, 'utf8')
  const normalized = full.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const capped = bytes > maxBytes
  const body = capped ? capUtf8(normalized, maxBytes) : normalized
  const text =
    body.trim() === ''
      ? null
      : capped
        ? `${body.replace(/\n+$/, '')}\n\n(The rest of ${BRAND.memoryFileName} was left out: it is longer than ${Math.round(maxBytes / 1024)} KB.)`
        : body.replace(/\n+$/, '')
  return { text, exists: true, bytes, capped, sha256: sha256(full) }
}

// ---- the proposal -------------------------------------------------------------------------------------------------

export const RUN_NOTES_HEADING = '## Run notes'

/**
 * What a project's first memory file starts with, when the app knows it (a project Easy made: what it is, what it was
 * made from, the rules its changes keep): lines for its Conventions and Decisions sections, without the `- `.
 */
export interface MemorySeed {
  conventions: string[]
  decisions: string[]
}

/** A new memory file: what it is for, its sections (with the seed's lines when there is one), and where run notes go. */
export function memorySkeleton(seed?: MemorySeed | null): string {
  const lines = (list: readonly string[] | undefined, fallback: string): string[] =>
    list !== undefined && list.length > 0 ? list.map((l) => `- ${l}`) : [fallback]
  return [
    '# Project memory',
    '',
    `${BRAND.displayName} reads this file at the start of every run and gives it to each pass. Keep it short and edit it like any other file.`,
    '',
    '## Conventions',
    '',
    ...lines(
      seed?.conventions,
      '- (How this project is built: languages, style, commands, what not to touch.)',
    ),
    '',
    '## Decisions',
    '',
    ...lines(seed?.decisions, '- (Choices made and why, so later runs keep to them.)'),
    '',
    RUN_NOTES_HEADING,
    '',
  ].join('\n')
}

/** What a run's note says. */
export interface RunNoteFacts {
  displayNo: number
  title: string
  at: number
  outcome?: RunOutcome
  outcomeText: string
  branch?: string
  /** The verify commands that passed and failed in the run's last round. */
  checks?: { passed: string[]; failed: string[] }
  deployTarget?: string
  recipe?: string
}

/** One line under "## Run notes": `- 2026-10-24 · Run #12 · Add a --version flag · Fixed · branch dim/… · …`. */
export function runNote(f: RunNoteFacts): string {
  const parts = [localDate(f.at), `Run #${f.displayNo}`, f.title.replace(/\s+/g, ' ').trim(), f.outcomeText]
  if (f.recipe !== undefined) parts.push(`recipe ${f.recipe}`)
  if (f.branch !== undefined) parts.push(`branch ${f.branch}`)
  if (f.checks !== undefined && (f.checks.passed.length > 0 || f.checks.failed.length > 0)) {
    const c: string[] = []
    if (f.checks.passed.length > 0) c.push(`${f.checks.passed.join(', ')} passed`)
    if (f.checks.failed.length > 0) c.push(`${f.checks.failed.join(', ')} failed`)
    parts.push(`checks: ${c.join('; ')}`)
  }
  if (f.deployTarget !== undefined) parts.push(`deploy config for ${f.deployTarget}`)
  return `- ${parts.join(' · ')}`
}

/**
 * The memory file with the run's note added: the current text (or the skeleton) with the note last under "## Run
 * notes" (the section is added at the end when missing), keeping the newest MEMORY_RUN_NOTES_MAX notes.
 */
export function withRunNote(current: string | null, note: string, seed?: MemorySeed | null): string {
  const base = (current ?? memorySkeleton(seed)).replace(/\r\n?/g, '\n')
  const lines = base.replace(/\n+$/, '').split('\n')
  let h = lines.findIndex((l) => l.trim() === RUN_NOTES_HEADING)
  if (h < 0) {
    lines.push('', RUN_NOTES_HEADING, '')
    h = lines.length - 2
  }
  // The section runs to the next heading of the same or a higher level.
  let end = lines.length
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  const section = lines.slice(h + 1, end)
  const notes = section.filter((l) => l.startsWith('- '))
  const other = section.filter((l) => !l.startsWith('- ') && l.trim() !== '')
  const kept = [...notes, note].slice(-MEMORY_RUN_NOTES_MAX)
  const body = ['', ...other, ...(other.length > 0 ? [''] : []), ...kept]
  const after = lines.slice(end)
  return `${[...lines.slice(0, h + 1), ...body, ...(after.length > 0 ? ['', ...after] : [])].join('\n')}\n`
}

// ---- a unified diff (small files: a plain LCS over lines) --------------------------------------------------------

type Op = { k: ' ' | '-' | '+'; line: string }

function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ k: ' ', line: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ k: '-', line: a[i++]! })
    else ops.push({ k: '+', line: b[j++]! })
  }
  while (i < n) ops.push({ k: '-', line: a[i++]! })
  while (j < m) ops.push({ k: '+', line: b[j++]! })
  return ops
}

const splitLines = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))

/** A unified diff of `before` (null: no file) → `after`, with three lines of context, and the lines added/removed. */
export function unifiedDiff(
  before: string | null,
  after: string,
  name: string,
): { diff: string; added: number; removed: number } {
  const ops = lineOps(splitLines((before ?? '').replace(/\r\n?/g, '\n')), splitLines(after))
  const added = ops.filter((o) => o.k === '+').length
  const removed = ops.filter((o) => o.k === '-').length
  const out = [`--- ${before === null ? '/dev/null' : `a/${name}`}`, `+++ b/${name}`]
  const CONTEXT = 3
  // Each op's line numbers in the old and the new text (1-based), before it.
  const aNo: number[] = []
  const bNo: number[] = []
  let aLine = 1
  let bLine = 1
  for (const o of ops) {
    aNo.push(aLine)
    bNo.push(bLine)
    if (o.k !== '+') aLine++
    if (o.k !== '-') bLine++
  }
  // Hunks: each change with CONTEXT lines around it, merged when they touch.
  const hunks: [number, number][] = []
  ops.forEach((o, i) => {
    if (o.k === ' ') return
    const s0 = Math.max(0, i - CONTEXT)
    const e0 = Math.min(ops.length, i + 1 + CONTEXT)
    const last = hunks.at(-1)
    if (last !== undefined && s0 <= last[1]) last[1] = Math.max(last[1], e0)
    else hunks.push([s0, e0])
  })
  for (const [s0, e0] of hunks) {
    const hunk = ops.slice(s0, e0)
    const aCount = hunk.filter((o) => o.k !== '+').length
    const bCount = hunk.filter((o) => o.k !== '-').length
    const aStart = (aNo[s0] ?? 1) - (aCount === 0 ? 1 : 0)
    const bStart = (bNo[s0] ?? 1) - (bCount === 0 ? 1 : 0)
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (const o of hunk) out.push(`${o.k}${o.line}`)
  }
  return { diff: `${out.join('\n')}\n`, added, removed }
}

// ---- proposals ------------------------------------------------------------------------------------------------------

export interface MemoryProposalDoc {
  id: string
  folder: string
  file: string
  runId: string
  displayNo: number
  title: string
  createdAt: number
  baseSha256: string | null
  next: string
}

const ProposalZ = z.object({
  id: z.string().max(80),
  folder: z.string().max(4096),
  file: z.string().max(4096),
  runId: z.string().max(64),
  displayNo: z.number().int(),
  title: z.string().max(400),
  createdAt: z.number(),
  baseSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  next: z.string().max(256 * 1024),
})

const proposalsDir = (home: string, folder: string): string => join(home, 'memory', briefKey(folder))
const proposalFile = (home: string, folder: string, id: string): string => {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new DimFactoryError('VALIDATION', 'Not a memory proposal id.')
  return join(proposalsDir(home, folder), `${id}.json`)
}

export async function saveProposal(home: string, p: MemoryProposalDoc): Promise<void> {
  await writeFileAtomic(proposalFile(home, p.folder, p.id), `${JSON.stringify(p, null, 2)}\n`, {
    mode: 0o600,
  })
}

export async function readProposal(
  home: string,
  folder: string,
  id: string,
): Promise<MemoryProposalDoc | null> {
  try {
    const r = ProposalZ.safeParse(JSON.parse(await readFile(proposalFile(home, folder, id), 'utf8')))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export async function listProposals(home: string, folder: string): Promise<MemoryProposalDoc[]> {
  const dir = proposalsDir(home, folder)
  const names = await readdir(dir).catch(() => [] as string[])
  const out: MemoryProposalDoc[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const p = await readProposal(home, folder, n.slice(0, -5)).catch(() => null)
    if (p !== null) out.push(p)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export async function removeProposal(home: string, folder: string, id: string): Promise<void> {
  await rm(proposalFile(home, folder, id), { force: true })
}

/** A proposal as the UI shows it: its diff against the file as it is now (it may have changed since). */
export async function proposalView(p: MemoryProposalDoc): Promise<MemoryProposalView> {
  const now = await readFile(p.file, 'utf8').catch(() => null)
  const d = unifiedDiff(now, p.next, BRAND.memoryFileName)
  return {
    id: p.id,
    runId: p.runId,
    displayNo: p.displayNo,
    title: p.title,
    createdAt: p.createdAt,
    baseSha256: p.baseSha256,
    diff: d.diff,
    added: d.added,
    removed: d.removed,
  }
}

/**
 * Write a proposal to the memory file, only when the file is still the one it was made from (CONFLICT otherwise: a
 * change made meanwhile is never overwritten; the next run proposes again from the new text).
 */
export async function writeProposal(p: MemoryProposalDoc): Promise<void> {
  const now = await readFile(p.file, 'utf8').catch(() => null)
  const sha = now === null ? null : sha256(now)
  if (sha !== p.baseSha256) {
    throw new DimFactoryError(
      'CONFLICT',
      `${BRAND.memoryFileName} changed since this update was proposed, so it was not written. Dismiss it; the next run proposes again from the file as it is.`,
    )
  }
  await writeFileAtomic(p.file, p.next, { mode: 0o644 })
}
