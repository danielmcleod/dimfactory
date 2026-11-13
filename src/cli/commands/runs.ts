// `dimf runs [--folder f] [--status s,..] [--json]` (read-only, from runs/index.jsonl).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { RunSummary } from '../../shared/run.ts'
import { parseStatuses } from '../../core/handlers.ts'
import type { CliIo } from '../io.ts'
import { countsText } from '../render.ts'
import { EXIT, usage, when, withReadOnlyCore } from '../session.ts'

export const RUNS_USAGE = 'dimf runs [--folder f] [--status s,..] [--limit n] [--json] [--home dir]'

const HOME_OPT = { home: { type: 'string' }, json: { type: 'boolean', default: false } } as const

function runRow(s: RunSummary): string {
  const found = s.findings.must + s.findings.should > 0 ? ` · ${countsText(s.findings)}` : ''
  const outcome = s.outcome !== undefined ? ` (${s.outcome}${found})` : ''
  // A re-run names its source (`dimf rerun`).
  const rerun =
    s.rerunOf !== undefined
      ? `  [re-run${s.rerunOf.from === 'fix' ? ' from Fix' : ''} of #${s.rerunOf.displayNo}]`
      : ''
  return `#${String(s.displayNo).padEnd(4)} ${`${s.status}${outcome}`.padEnd(24)} ${when(s.createdAt)}  ${s.runId}  ${s.title.slice(0, 50)}${rerun}  ${s.folder}`
}

export async function runsCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: {
    folder?: string | undefined
    status?: string | undefined
    limit?: string | undefined
    json?: boolean | undefined
    home?: string | undefined
  }
  try {
    v = parseArgs({
      args: [...args],
      options: {
        ...HOME_OPT,
        folder: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    }).values
  } catch (err) {
    return usage(io, 'runs', RUNS_USAGE, err)
  }
  let statuses
  try {
    statuses = v.status !== undefined ? parseStatuses(v.status) : undefined
  } catch (err) {
    return usage(io, 'runs', RUNS_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, async (core) => {
    const r = await core.invoke('runs.list', {
      ...(v.folder !== undefined ? { folder: resolve(io.cwd, v.folder) } : {}),
      ...(statuses !== undefined ? { status: statuses } : {}),
      limit: v.limit !== undefined ? Math.max(1, Number.parseInt(v.limit, 10) || 100) : 100,
    })
    if (!r.ok) {
      io.err(`dimf runs: ${r.error.message}`)
      return EXIT.failed
    }
    if (v.json === true) io.out(JSON.stringify(r.value.items, null, 2))
    else if (r.value.items.length === 0) io.out('No runs.')
    else for (const s of r.value.items) io.out(runRow(s))
    return EXIT.completed
  })
}

// ---- preflight ------------------------------------------------------------------------------------------------------
