// `dimf rerun <runId> [--from-fix [--findings F1,F2]]` (Re-run, Re-run from Fix): start a new run with the
// run's settings (its resolved.json through ResolvedConfigZ), or
// from Fix with the chosen findings (default: every must and the shoulds its gate selected), then follow it like
// `run`. A source still holding its folder is stopped (Close run when failed) as the new run queues.
import { parseArgs } from 'node:util'
import type { RerunFromFix } from '../../shared/run.ts'
import { FRESH_REASON_TEXT } from '../../core/supervisor/sessions.ts'
import { POLICY_OPTIONS, UsageError, runPolicy } from '../args.ts'
import type { RunPolicy } from '../args.ts'
import { Interaction } from '../cards.ts'
import { EarlyInterrupts, driveRun, printBlocked, printFooter } from '../drive.ts'
import type { CliIo } from '../io.ts'
import { LineReader } from '../io.ts'
import { RunPrinter } from '../render.ts'
import { EXIT, cliName, withWritableCore } from '../session.ts'

export const RERUN_USAGE =
  'dimf rerun <runId> [--from-fix] [--findings F1,F2] [--gates approve|ask|stop] [--cards default|stop] ' +
  '[--asks ask|allow|deny] [--plan-file f|-] [--json] [--home dir]'

const RERUN_OPTIONS = {
  ...POLICY_OPTIONS,
  'from-fix': { type: 'boolean', default: false },
  findings: { type: 'string' },
} as const

/** What Re-run from Fix would do, as the run's snapshot says it (the app's tooltip words). */
export function rerunFromFixLine(r: RerunFromFix): string {
  if (!r.available) return `not available: ${r.unavailable ?? 'not possible for this run'}`
  const how = r.fresh
    ? `Fix would start a fresh session${r.reason !== undefined ? ` (${FRESH_REASON_TEXT[r.reason]})` : ''}`
    : 'Fix would continue the Implement session'
  const n = r.findingIds?.length ?? 0
  return `${how}; by default it gets ${n} finding${n === 1 ? '' : 's'} (${(r.findingIds ?? []).join(', ')})`
}

export async function rerunCommand(args: readonly string[], io: CliIo): Promise<number> {
  let values: {
    gates?: string | undefined
    cards?: string | undefined
    asks?: string | undefined
    'plan-file'?: string | undefined
    json?: boolean | undefined
    home?: string | undefined
    'from-fix'?: boolean | undefined
    findings?: string | undefined
  }
  let sourceId: string
  let policy: RunPolicy
  let findingIds: string[] | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: RERUN_OPTIONS,
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <runId>')
    sourceId = parsed.positionals[0] ?? ''
    policy = runPolicy(values, io.isTTY)
    if (values.findings !== undefined) {
      if (values['from-fix'] !== true) throw new UsageError('--findings goes with --from-fix')
      findingIds = values.findings
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (findingIds.length === 0) throw new UsageError('--findings needs at least one finding id')
    }
  } catch (err) {
    io.err(`dimf rerun: ${err instanceof Error ? err.message : String(err)}`)
    io.err(`usage: ${RERUN_USAGE}`)
    return EXIT.usage
  }
  const fromFix = values['from-fix'] === true
  const json = values.json === true
  const reader = new LineReader(io.stdin)
  return withWritableCore(io, values.home, async (core) => {
    let runId: string | undefined
    const printer = new RunPrinter(io, {
      json,
      state: () => (runId !== undefined ? core.controller(runId)?.state : undefined),
    })
    const detach = core.bus.attach(printer)
    // Ctrl+C from here on is never lost: driveRun replays what came before it follows the run.
    const early = new EarlyInterrupts(io)
    try {
      const r = await core.invoke('runs.rerun', {
        runId: sourceId,
        from: fromFix ? 'fix' : 'start',
        ...(findingIds !== undefined ? { findingIds } : {}),
      })
      if (!r.ok) {
        if (r.error.code === 'PREFLIGHT_BLOCKED') {
          printBlocked(io, r.error, {
            cli: cliName(io),
            ...(values.home !== undefined ? { home: values.home } : {}),
          })
          return EXIT.preflightBlocked
        }
        io.err(`dimf rerun: ${r.error.message}`)
        return r.error.code === 'VALIDATION' || r.error.code === 'NOT_FOUND' ? EXIT.usage : EXIT.failed
      }
      runId = r.value.runId
      const c = core.controller(runId)
      const source = c?.state.rerunOf
      printer.line(
        `Run #${r.value.displayNo} (${runId}) ${fromFix ? 're-runs from Fix' : 're-runs'} run #${source?.displayNo ?? '?'}` +
          (c !== undefined ? ` in ${c.state.folder}` : ''),
      )
      const chosen = c?.state.findings?.selected ?? []
      if (fromFix && source !== undefined) {
        printer.line(
          `Plan, Implement, Review and Critic are carried from run #${source.displayNo}; Fix gets ${chosen.join(', ')}.`,
        )
      }
      printer.follow(runId)
      const interaction = new Interaction(io, policy, printer, reader)
      const code = await driveRun(core, runId, policy, io, printer, interaction, early)
      printFooter(core, runId, printer, code)
      return code
    } finally {
      early.take()
      detach()
      reader.pause()
    }
  })
}
