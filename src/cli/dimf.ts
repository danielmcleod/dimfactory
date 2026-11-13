#!/usr/bin/env node
// Dim Factory dev/CI CLI (not packaged). Runs directly: `node src/cli/dimf.ts …`.
// The same createCore + handlers as the app; see session.ts for exit codes.
import { configCommand, CONFIG_USAGE } from './commands/config.ts'
import { deployCommand, DEPLOY_USAGE } from './commands/deploy.ts'
import { doctorCommand, DOCTOR_USAGE } from './commands/doctor.ts'
import { gcCommand, GC_USAGE } from './commands/gc.ts'
import { matchCommand, MATCH_USAGE } from './commands/match.ts'
import { newCommand, NEW_USAGE } from './commands/new.ts'
import { preflightCommand, PREFLIGHT_USAGE } from './commands/preflight.ts'
import { previewCommand, PREVIEW_USAGE } from './commands/preview.ts'
import { queueCommand, QUEUE_USAGE } from './commands/queue.ts'
import { recipesCommand, RECIPES_USAGE } from './commands/recipes.ts'
import { rerunCommand, RERUN_USAGE } from './commands/rerun.ts'
import { resumeCommand, RESUME_USAGE } from './commands/resume.ts'
import { runsCommand, RUNS_USAGE } from './commands/runs.ts'
import { showCommand, SHOW_USAGE } from './commands/show.ts'
import { normalizeCommand, NORMALIZE_USAGE } from './commands/normalize.ts'
import { probeCommand, PROBE_USAGE } from './commands/probe.ts'
import { runCommand, RUN_USAGE } from './commands/run.ts'
import type { CliIo } from './io.ts'
import { toIo } from './io.ts'
import { BRAND } from '../shared/brand.ts'

/** Commands not built yet: `dimf <cmd>` says when it arrives (none left since `gc` was built). */
const LATER: Readonly<Record<string, string>> = {}

const later = Object.entries(LATER)
const USAGE = [
  `usage: ${BRAND.cliName} <command> [options]   (also: ${BRAND.cliAliases.join(', ')})`,
  '',
  `  ${RUN_USAGE}`,
  `  ${NEW_USAGE}`,
  `  ${RESUME_USAGE}`,
  `  ${RERUN_USAGE}`,
  `  ${MATCH_USAGE}`,
  `  ${SHOW_USAGE}`,
  `  ${RUNS_USAGE}`,
  `  ${PREFLIGHT_USAGE}`,
  `  ${PREVIEW_USAGE}`,
  `  ${DEPLOY_USAGE}`,
  `  ${RECIPES_USAGE}`,
  `  ${QUEUE_USAGE}`,
  `  ${CONFIG_USAGE}`,
  `  ${DOCTOR_USAGE}`,
  `  ${PROBE_USAGE}`,
  `  ${NORMALIZE_USAGE}`,
  `  ${GC_USAGE}`,
  '',
  ...(later.length > 0 ? [`Not available yet: ${later.map(([c, m]) => `${c} (${m})`).join(', ')}`, ''] : []),
  'Exit codes: 0 completed · 1 failed · 2 usage · 3 preflight blocked · 4 cancelled · 5 paused/waiting · 6 home locked · 130 interrupted',
].join('\n')

/**
 * `out` (the original signature) receives stdout lines; pass a partial CliIo instead to inject stdin, a TTY flag, the
 * environment, the working folder and a Ctrl+C source (integration tests drive the CLI in-process this way).
 */
export async function main(
  argv: readonly string[],
  out?: ((s: string) => void) | Partial<CliIo>,
): Promise<number> {
  const io = toIo(out)
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'run':
      return runCommand(rest, io)
    case 'new':
      return newCommand(rest, io)
    case 'rerun':
      return rerunCommand(rest, io)
    case 'resume':
      return resumeCommand(rest, io)
    case 'match':
      return matchCommand(rest, io)
    case 'show':
      return showCommand(rest, io)
    case 'runs':
      return runsCommand(rest, io)
    case 'preflight':
      return preflightCommand(rest, io)
    case 'preview':
      return previewCommand(rest, io)
    case 'deploy':
      return deployCommand(rest, io)
    case 'recipes':
      return recipesCommand(rest, io)
    case 'queue':
      return queueCommand(rest, io)
    case 'config':
      return configCommand(rest, io)
    case 'doctor':
      return doctorCommand(rest, io)
    case 'probe':
      return probeCommand(rest, io.out)
    case 'normalize':
      return normalizeCommand(rest, io.out)
    case 'gc':
      return gcCommand(rest, io)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE)
      return 0
    default:
      if (LATER[cmd] !== undefined) {
        io.out(`${BRAND.cliName} ${cmd}: not available until ${LATER[cmd]}`)
        return 2
      }
      io.out(`Unknown command "${cmd}".\n\n${USAGE}`)
      return 2
  }
}

const isEntry = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && /dimf\.ts$/.test(entry.replace(/\\/g, '/'))
}

if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
      // Stdin may still be open (TTY); nothing else should keep the process alive.
      process.stdin.unref?.()
    },
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
      process.exitCode = 1
    },
  )
}
