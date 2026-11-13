// `dimf new <folder> --template <id>`: start a new project. Creates the folder (or takes an existing empty one) and
// git-inits it through the same core command as the app's New project dialog (project.create), prints the template's
// official create command when it has one (copyable, never run), then runs the pipeline exactly as `dimf run` does
// with the template's task and Brief, unless --no-run. `--list-templates` lists the templates by category. Every
// other flag is `dimf run`'s and is handed to it unchanged (--profile, --auto, --gates, --set, --json, ...).
import { resolve } from 'node:path'
import type { ProjectCreated, TemplatesList } from '../../shared/templates.ts'
import type { CliIo } from '../io.ts'
import { shellArg } from '../hints.ts'
import { EXIT, cliName, withReadOnlyCore, withWritableCore } from '../session.ts'
import { runCommand } from './run.ts'

export const NEW_USAGE =
  'dimf new <folder> --template <id> [--task "<what it should do>"] [--no-run] [--list-templates] ' +
  '[dimf run options: --profile p, --auto, --gates ..., --set k=v, --json, ...] [--home dir]'

/** The flags `dimf new` reads itself; the rest go to `dimf run`. */
interface NewArgs {
  folder?: string
  template?: string
  task?: string
  noRun: boolean
  list: boolean
  home?: string
  /** `dimf run`'s own flags, in order. */
  runArgs: string[]
}

class NewUsageError extends Error {}

/** `--flag value` or `--flag=value`. */
function takeValue(args: readonly string[], i: number, flag: string): { value: string; next: number } {
  const a = args[i] ?? ''
  if (a.startsWith(`${flag}=`)) return { value: a.slice(flag.length + 1), next: i + 1 }
  const v = args[i + 1]
  if (v === undefined) throw new NewUsageError(`${flag} needs a value`)
  return { value: v, next: i + 2 }
}

/** The run flags that take a value (so their value is never read as the folder). */
const RUN_VALUE_FLAGS = new Set([
  '--profile',
  '--set',
  '--gates',
  '--cards',
  '--asks',
  '--plan-file',
  '--brief',
  '--fix-rounds',
  '--deploy-target',
])

export function parseNewArgs(args: readonly string[]): NewArgs {
  const out: NewArgs = { noRun: false, list: false, runArgs: [] }
  let i = 0
  while (i < args.length) {
    const a = args[i] ?? ''
    const flag = a.startsWith('--') ? (a.split('=')[0] ?? a) : a
    if (flag === '--template' || flag === '--task' || flag === '--home') {
      const { value, next } = takeValue(args, i, flag)
      if (flag === '--template') out.template = value
      else if (flag === '--task') out.task = value
      else {
        out.home = value
        out.runArgs.push('--home', value)
      }
      i = next
      continue
    }
    if (a === '--no-run') {
      out.noRun = true
      i++
      continue
    }
    if (a === '--list-templates') {
      out.list = true
      i++
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      out.runArgs.push(a)
      if (RUN_VALUE_FLAGS.has(a) && args[i + 1] !== undefined) {
        out.runArgs.push(args[i + 1] as string)
        i += 2
      } else i++
      continue
    }
    if (out.folder !== undefined) throw new NewUsageError(`one folder only (got "${out.folder}" and "${a}")`)
    out.folder = a
    i++
  }
  return out
}

/** The templates by category, one line each. */
export function templatesText(list: TemplatesList): string[] {
  const lines: string[] = []
  for (const p of list.packs) {
    lines.push(`${p.label}:`)
    for (const v of list.templates.filter((t) => t.template.pack === p.id)) {
      const t = v.template
      lines.push(`  ${t.id.padEnd(16)} ${t.label}: ${t.description}${v.layer === 'user' ? ' (yours)' : ''}`)
    }
  }
  for (const i of list.issues) lines.push(`Skipped ${i.file}: ${i.message}`)
  return lines
}

/**
 * `dimf run`'s arguments for the created project: the folder, the task, the template's recipe (unless the user named
 * one with --recipe), then the user's run flags. This is the one place a template's run is put together, so whatever
 * else the template carries is added here.
 */
export function runArgv(created: ProjectCreated, runArgs: readonly string[]): string[] {
  const ownRecipe = runArgs.some((a) => a === '--recipe' || a.startsWith('--recipe='))
  const recipe = ownRecipe || created.recipe === '' ? [] : ['--recipe', created.recipe]
  return [created.folder, created.task, ...recipe, ...runArgs]
}

export async function newCommand(args: readonly string[], io: CliIo): Promise<number> {
  let a: NewArgs
  try {
    a = parseNewArgs(args)
    if (!a.list) {
      if (a.folder === undefined) throw new NewUsageError('expected <folder>')
      if (a.template === undefined) throw new NewUsageError('expected --template <id> (see --list-templates)')
    }
  } catch (err) {
    io.err(`dimf new: ${err instanceof Error ? err.message : String(err)}`)
    io.err(`usage: ${NEW_USAGE}`)
    return EXIT.usage
  }
  if (a.list) {
    return withReadOnlyCore(io, a.home, async (core) => {
      const r = await core.invoke('templates.list')
      if (!r.ok) {
        io.err(`dimf new: ${r.error.message}`)
        return EXIT.failed
      }
      for (const line of templatesText(r.value)) io.out(line)
      return EXIT.completed
    })
  }
  const folder = resolve(io.cwd, a.folder as string)
  let created: ProjectCreated | undefined
  const code = await withWritableCore(io, a.home, async (core) => {
    const r = await core.invoke('project.create', {
      folder,
      templateId: a.template as string,
      ...(a.task !== undefined && a.task.trim() !== '' ? { goal: a.task } : {}),
    })
    if (!r.ok) {
      io.err(`dimf new: ${r.error.message}`)
      return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
    }
    created = r.value
    return EXIT.completed
  })
  if (code !== EXIT.completed || created === undefined) return code
  // Notices go to stderr, so `--json` output stays one JSON stream.
  io.err(
    `Created ${created.folder} from the "${created.template.label}" template (git initialized, nothing committed).`,
  )
  if (created.create !== undefined) {
    io.err('Prefer the official starter? Run this in the folder before the run starts building (copy it):')
    io.err(`  ${created.create.command}`)
    if (created.create.note !== undefined) io.err(`  ${created.create.note}`)
  }
  if (a.noRun) {
    const home = a.home !== undefined ? ` --home ${shellArg(a.home)}` : ''
    io.err("The template's Brief is saved for this folder: the app restores it when you choose the folder.")
    io.err(
      `Start the run later with: ${cliName(io)} run ${shellArg(created.folder)} ${shellArg(created.task)}${home}`,
    )
    return EXIT.completed
  }
  return runCommand(runArgv(created, a.runArgs), io, { brief: created.brief, cmd: 'new', usage: NEW_USAGE })
}
