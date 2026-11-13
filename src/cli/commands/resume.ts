// `dimf resume <runId>`: continue a run left paused (resume), failed (retry every failed pass), waiting on a
// card or queued by an earlier process, then follow it like `run`. `--allow-timed-out` is the AttentionPanel's
// "Allow & resume" (P19): the question that timed out becomes an allow-rule of the run before the pass resumes.
import { parseArgs } from 'node:util'
import { AGENT_STEPS } from '../../shared/run.ts'
import { stepLabel } from '../../core/supervisor/cards.ts'
import { POLICY_OPTIONS, UsageError, runPolicy } from '../args.ts'
import type { RunPolicy } from '../args.ts'
import { Interaction } from '../cards.ts'
import { EarlyInterrupts, driveRun, printFooter } from '../drive.ts'
import type { CliIo } from '../io.ts'
import { LineReader } from '../io.ts'
import { RunPrinter } from '../render.ts'
import { EXIT, withWritableCore } from '../session.ts'

export const RESUME_USAGE =
  'dimf resume <runId> [--allow-timed-out] [--gates approve|ask|stop] [--cards default|stop] ' +
  '[--asks ask|allow|deny] [--plan-file f|-] [--json] [--home dir]'

const RESUME_OPTIONS = { ...POLICY_OPTIONS, 'allow-timed-out': { type: 'boolean', default: false } } as const

export async function resumeCommand(args: readonly string[], io: CliIo): Promise<number> {
  let values: {
    gates?: string | undefined
    cards?: string | undefined
    asks?: string | undefined
    'plan-file'?: string | undefined
    json?: boolean | undefined
    home?: string | undefined
    'allow-timed-out'?: boolean | undefined
  }
  let runId: string
  let policy: RunPolicy
  try {
    const parsed = parseArgs({
      args: [...args],
      options: RESUME_OPTIONS,
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <runId>')
    runId = parsed.positionals[0] ?? ''
    policy = runPolicy(values, io.isTTY)
  } catch (err) {
    io.err(`dimf resume: ${err instanceof Error ? err.message : String(err)}`)
    io.err(`usage: ${RESUME_USAGE}`)
    return EXIT.usage
  }
  const json = values.json === true
  const reader = new LineReader(io.stdin)
  return withWritableCore(io, values.home, async (core) => {
    const printer = new RunPrinter(io, { json, state: () => core.controller(runId)?.state })
    printer.follow(runId)
    const detach = core.bus.attach(printer)
    // Ctrl+C from here on is never lost: driveRun replays what came before it follows the run.
    const early = new EarlyInterrupts(io)
    try {
      const allowLate = values['allow-timed-out'] === true
      const r = await core.invoke('runs.resume', allowLate ? { runId, allowTimedOutAsk: true } : { runId })
      if (!r.ok) {
        const c = core.controller(runId)
        // Every failed pass: Review and Critic can fail together (R8), and retrying only one leaves the run failed.
        const failed = c !== undefined ? AGENT_STEPS.filter((p) => c.state.steps[p].status === 'failed') : []
        if (
          r.error.code === 'CONFLICT' &&
          c !== undefined &&
          failed.length > 0 &&
          c.state.stop === undefined
        ) {
          printer.line(`Retrying ${failed.map(stepLabel).join(', ')}…`)
          for (const pass of failed) {
            const rr = await core.invoke('runs.retryPass', { runId, pass })
            if (!rr.ok) {
              io.err(`dimf resume: ${rr.error.message}`)
              return EXIT.failed
            }
          }
        } else if (r.error.code === 'CONFLICT' && c !== undefined) {
          printer.line(`Run #${c.state.displayNo} is ${c.state.status}; there is nothing to resume.`)
          printFooter(core, runId, printer)
          return c.state.status === 'completed'
            ? EXIT.completed
            : c.state.status === 'cancelled'
              ? EXIT.cancelled
              : EXIT.failed
        } else {
          io.err(`dimf resume: ${r.error.message}`)
          return r.error.code === 'NOT_FOUND' ? EXIT.usage : EXIT.failed
        }
      }
      const c = core.controller(runId)
      if (c === undefined) return EXIT.failed
      printer.line(`Run #${c.state.displayNo} (${runId}) resumed`)
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
