// `dimf gc [--dry-run] [--json] [--home dir]` (storage {keepRuns, keepDays, rawLogDays}): one retention pass now,
// then git gc on the shadows (only those no run used in the last 5
// minutes). `--dry-run` prints the plan and changes nothing; it needs no home lock, so it works while the app runs.
import { parseArgs } from 'node:util'
import type { ShadowGcResult } from '../../core/git/shadow.ts'
import type { RetentionReport, RetentionRunRow } from '../../core/store/retention.ts'
import type { CliIo } from '../io.ts'
import { EXIT, usage, when, withReadOnlyCore, withWritableCore } from '../session.ts'

export const GC_USAGE = 'dimf gc [--dry-run] [--json] [--home dir]'

const OPTIONS = {
  home: { type: 'string' },
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
} as const

/** `1.2 MB`, `340 KB`, `12 B`. */
export function bytesText(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function runLine(r: RetentionRunRow, extra?: string): string {
  const title = r.title.length > 50 ? `${r.title.slice(0, 49)}…` : r.title
  return `  #${String(r.displayNo).padEnd(5)} ${when(r.createdAt)}  ${title}${extra !== undefined ? `  (${extra})` : ''}`
}

function gcLine(g: ShadowGcResult, dryRun: boolean): string {
  const size = g.bytesBefore !== undefined ? bytesText(g.bytesBefore) : undefined
  switch (g.action) {
    case 'gc':
      return dryRun
        ? `  ${g.folderKey}  would collect (${plural(g.refs ?? 0, 'run')}${size !== undefined ? `, ${size} now` : ''})`
        : `  ${g.folderKey}  collected: ${size ?? '?'} before, ${bytesText(g.bytesAfter ?? 0)} after`
    case 'deleted':
      return dryRun
        ? `  ${g.folderKey}  would be deleted: no run keeps snapshots there${size !== undefined ? ` (${size})` : ''}`
        : `  ${g.folderKey}  deleted: no run kept snapshots there${size !== undefined ? ` (${size} freed)` : ''}`
    case 'skipped':
      return `  ${g.folderKey}  left alone: ${g.reason ?? 'skipped'}`
    case 'none':
      return `  ${g.folderKey}  no snapshots`
  }
}

/** The report as text lines (no em dashes: the CLI follows the app's copy rules). */
export function reportLines(r: RetentionReport): string[] {
  const d = r.dryRun
  const p = r.policy
  const lines = [
    `${d ? 'Plan (nothing is changed: --dry-run)' : 'Retention'}: keep the newest ${p.keepRuns} runs and every run from the last ${plural(p.keepDays, 'day')}; raw logs for ${plural(p.rawLogDays, 'day')}.`,
  ]
  if (r.pendingRemoved > 0)
    lines.push(`Deleted ${plural(r.pendingRemoved, 'removed run')} whose undo time had passed.`)
  if (r.removed.length === 0) lines.push(d ? 'No run would be deleted.' : 'No run was deleted.')
  else {
    lines.push(`${d ? 'Would delete' : 'Deleted'} ${plural(r.removed.length, 'run')}:`)
    for (const x of r.removed) lines.push(runLine(x))
  }
  if (r.kept.length > 0) {
    lines.push(`Kept although older than both rules (${r.kept.length}):`)
    for (const x of r.kept) lines.push(runLine(x, x.reason))
  }
  if (r.failed.length > 0) {
    lines.push(`Could not delete (${r.failed.length}; tried again next time):`)
    for (const x of r.failed) lines.push(runLine(x, x.reason))
  }
  if (r.copies.length > 0) {
    lines.push(
      `${d ? 'Would remove' : 'Removed'} ${plural(r.copies.length, 'finalized isolated copy', 'finalized isolated copies')}:`,
    )
    for (const x of r.copies) lines.push(runLine(x))
  }
  lines.push(
    r.rawLogs.files === 0
      ? `Raw logs: none older than ${plural(p.rawLogDays, 'day')}.`
      : `Raw logs: ${d ? 'would delete' : 'deleted'} ${plural(r.rawLogs.files, 'file')} (${bytesText(r.rawLogs.bytes)}).`,
  )
  if (r.gc.length === 0) lines.push('Snapshots: nothing to collect.')
  else {
    lines.push('Snapshots:')
    for (const g of r.gc) lines.push(gcLine(g, d))
  }
  return lines
}

export async function gcCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: { home?: string | undefined; json?: boolean | undefined; 'dry-run'?: boolean | undefined }
  try {
    v = parseArgs({ args: [...args], options: OPTIONS, allowPositionals: false, strict: true }).values
  } catch (err) {
    return usage(io, 'gc', GC_USAGE, err)
  }
  const dryRun = v['dry-run'] === true
  const run = async (core: Parameters<Parameters<typeof withReadOnlyCore>[2]>[0]): Promise<number> => {
    let report: RetentionReport
    try {
      report = await core.history.retention({ dryRun, force: true })
      await core.history.settled()
    } catch (err) {
      io.err(`dimf gc: ${err instanceof Error ? err.message : String(err)}`)
      return EXIT.failed
    }
    if (v.json === true) io.out(JSON.stringify(report, null, 2))
    else for (const line of reportLines(report)) io.out(line)
    return report.failed.length > 0 ? EXIT.failed : EXIT.completed
  }
  // A dry run reads only (no home lock: it works while the app runs); a real pass takes the lock.
  return dryRun ? withReadOnlyCore(io, v.home, run) : withWritableCore(io, v.home, run)
}
