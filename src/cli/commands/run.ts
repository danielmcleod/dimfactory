// `dimf run <folder> <task|->`: start a run through the same core handlers as the app,
// stream it, answer cards and asks per policy and exit with the run's code (session.ts EXIT). The first run in a
// home picks a profile from the ready vendors (first launch). `--profile` and `--set` (any run-override
// path) form the run layer; config errors block the run with their file:line:col (exit 3).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APPROACH_GROUP, BriefInputZ, DEFAULT_CATEGORY, TEST_FIRST } from '../../shared/brief.ts'
import type { BriefInput } from '../../shared/brief.ts'
import type { RunOverrides } from '../../shared/config-schema.ts'
import { FIX_ROUNDS_MAX } from '../../shared/run.ts'
import { RESEARCH_LENSES_MAX, RESEARCH_LENS_ID } from '../../shared/research.ts'
import { DEPLOY_TARGET_ID } from '../../shared/deploy.ts'
import { RECIPE_ID_PATTERN } from '../../shared/recipes.ts'
import { readBuiltinPacks } from '../../core/packs/load.ts'
import { readGenericLenses } from '../../core/research/lenses.ts'
import { POLICY_OPTIONS, UsageError, parseSets, runPolicy } from '../args.ts'
import type { RunPolicy } from '../args.ts'
import { Interaction } from '../cards.ts'
import { EarlyInterrupts, driveRun, printBlocked, printFooter } from '../drive.ts'
import type { CliIo } from '../io.ts'
import { LineReader } from '../io.ts'
import { RunPrinter } from '../render.ts'
import type { Core } from '../../core/app-core.ts'
import { EXIT, cliName, withWritableCore } from '../session.ts'

export const RUN_USAGE =
  'dimf run <folder> <task|-> [--profile p] [--set k=v]... [--auto] [--run-branch] [--gates approve|ask|stop] ' +
  '[--cards default|stop] [--asks ask|allow|deny] [--plan-file f|-] [--brief file.json] [--test-first] [--security] ' +
  '[--clarify] [--research [lens,...]] [--fix-rounds 1-3] [--deploy] [--deploy-target id] [--acceptance] ' +
  '[--explain] [--recipe id] [--json] ' +
  '[--home dir]'

/** The security advisor (opt-in): --security = `--set passes.security.enabled=true`. */
export function withSecurityFlag(overrides: RunOverrides, on: boolean): RunOverrides {
  if (!on) return overrides
  return {
    ...overrides,
    passes: { ...overrides.passes, security: { ...overrides.passes?.security, enabled: true } },
  }
}

/**
 * Clarify before Plan: --clarify = `--set passes.plan.clarify=true`. In a terminal its questions are asked one by one;
 * without one the run stops at them (exit 5), like any card that waits for you.
 */
export function withClarifyFlag(overrides: RunOverrides, on: boolean): RunOverrides {
  if (!on) return overrides
  return { ...overrides, passes: { ...overrides.passes, plan: { ...overrides.passes?.plan, clarify: true } } }
}

/**
 * Research before Plan: --research = `--set passes.plan.research=true`; `--research comparable,standards` also names the
 * lenses (`passes.plan.researchLenses`; none named: the pack's or the generic defaults). An id that is not a lens id is a
 * usage error; one no pack defines is left to preflight (run.research blocks it). In a terminal the research card asks
 * what to keep; without one the run stops at it (exit 5) unless the run is Auto (which keeps the must-haves and
 * recommendations).
 */
export function withResearchFlag(overrides: RunOverrides, value: string | undefined): RunOverrides {
  if (value === undefined) return overrides
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const bad = ids.find((id) => !RESEARCH_LENS_ID.test(id))
  if (bad !== undefined)
    throw new UsageError(`--research: "${bad}" is not a lens id (letters, digits and dashes)`)
  if (ids.length > RESEARCH_LENSES_MAX) {
    throw new UsageError(`--research takes at most ${RESEARCH_LENSES_MAX} lenses (got ${ids.length})`)
  }
  const plan = {
    ...overrides.passes?.plan,
    research: true,
    ...(ids.length > 0 ? { researchLenses: [...new Set(ids)] } : {}),
  }
  return { ...overrides, passes: { ...overrides.passes, plan } }
}

/**
 * `--research` takes an optional value: `--research` alone, `--research=a,b`, or `--research a,b` when the next argument
 * is plainly a lens list (it has a comma, or it is a built-in lens id), so a folder named like a word is never taken for
 * one. parseArgs has no optional values, so the flag is rewritten before it: `--research` alone becomes `--research=`.
 */
export function normalizeResearchArg(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') {
      out.push(...args.slice(i))
      break
    }
    if (a !== '--research') {
      out.push(a)
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && LENS_LIST.test(next) && (next.includes(',') || builtinLensIds().has(next))) {
      out.push(`--research=${next}`)
      i++
    } else out.push('--research=')
  }
  return out
}

/** A comma-separated lens list as `--research`'s value (never a folder path or a task). */
const LENS_LIST = /^[a-z][a-zA-Z0-9-]{0,39}(,[a-z][a-zA-Z0-9-]{0,39})*$/

/** The generic lenses' ids and the built-in packs' own. */
function builtinLensIds(): Set<string> {
  const ids = new Set(readGenericLenses().lenses.map((l) => l.id))
  for (const v of readBuiltinPacks()) for (const l of v.pack.research?.lenses ?? []) ids.add(l.id)
  return ids
}

/** Fix until green: --fix-rounds N = `--set passes.fix.rounds=N` (1 = a single Fix; at most FIX_ROUNDS_MAX). */
export function withFixRounds(overrides: RunOverrides, value: string | undefined): RunOverrides {
  if (value === undefined) return overrides
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(n) || n < 1 || n > FIX_ROUNDS_MAX) {
    throw new UsageError(`--fix-rounds takes a whole number from 1 to ${FIX_ROUNDS_MAX} (got "${value}")`)
  }
  return { ...overrides, passes: { ...overrides.passes, fix: { ...overrides.passes?.fix, rounds: n } } }
}

/**
 * The Deploy step at the end of the run: --deploy = `--set passes.implement.deploy=true`; --deploy-target names the
 * target (`passes.implement.deployTarget`, a pack target id such as netlify or fly) and implies --deploy. The step
 * writes the missing deploy config; it never deploys (see `dimf deploy` for the copyable commands).
 */
export function withDeployFlag(
  overrides: RunOverrides,
  on: boolean,
  target: string | undefined,
): RunOverrides {
  if (!on && target === undefined) return overrides
  if (target !== undefined && !DEPLOY_TARGET_ID.test(target))
    throw new UsageError(`--deploy-target: "${target}" is not a target id (letters, digits and dashes)`)
  const implement = {
    ...overrides.passes?.implement,
    deploy: true,
    ...(target !== undefined ? { deployTarget: target } : {}),
  }
  return { ...overrides, passes: { ...overrides.passes, implement } }
}

/**
 * The acceptance review: --acceptance = `--set passes.review.acceptance=true` (with --fix-rounds 2 or more its unmet
 * criteria become findings for Fix; otherwise a summary). Explain it to me: --explain = `--set passes.plan.explain=true`
 * (the run's end prints explain.md).
 */
export function withAcceptanceExplainFlags(
  overrides: RunOverrides,
  acceptance: boolean,
  explain: boolean,
): RunOverrides {
  let out = overrides
  if (acceptance)
    out = { ...out, passes: { ...out.passes, review: { ...out.passes?.review, acceptance: true } } }
  if (explain) out = { ...out, passes: { ...out.passes, plan: { ...out.passes?.plan, explain: true } } }
  return out
}

/**
 * The run's Brief: `--brief <file>` (a brief as the composer saves it: `{category, fields}`), and `--test-first`
 * (the approach Test-first, added to that brief or to a Software brief of its own). undefined without either.
 */
export async function briefFromArgs(
  file: string | undefined,
  testFirst: boolean,
  cwd: string,
  start?: BriefInput,
): Promise<BriefInput | undefined> {
  // `start`: a brief the caller starts from (`dimf new`: the template's); a --brief file replaces it.
  let brief: BriefInput | undefined = start
  if (file !== undefined) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(resolve(cwd, file), 'utf8'))
    } catch (err) {
      throw new UsageError(
        `--brief: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const r = BriefInputZ.safeParse(raw)
    if (!r.success) {
      const first = r.error.issues[0]
      throw new UsageError(
        `--brief: ${file} is not a brief (${first?.path.join('.') ?? ''}: ${first?.message ?? ''})`,
      )
    }
    brief = r.data
  }
  if (!testFirst) return brief
  const base: BriefInput = brief ?? { category: DEFAULT_CATEGORY, fields: {} }
  const approach = base.fields[APPROACH_GROUP]
  const choices = [...new Set([...(approach?.choices ?? []), TEST_FIRST])]
  return { ...base, fields: { ...base.fields, [APPROACH_GROUP]: { choices, source: 'user' } } }
}

/**
 * First launch: the first run in a home picks a profile from the vendors that are ready (the launch probe;
 * Codex too when built) and saves it to the user dimfactory.json when that file has none. Says so once, on stderr.
 */
async function firstLaunchNotice(core: Core, io: CliIo): Promise<void> {
  let outcome
  try {
    outcome = await core.firstLaunch()
  } catch (err) {
    io.err(`dim-factory: first-run setup failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (outcome?.status !== 'completed' || !outcome.wroteProfile) return
  const sel = outcome.selection
  const ready = (ok: boolean): string => (ok ? 'is ready' : 'is not ready')
  io.err(
    `First run: Claude ${ready(sel.claudeReady)} and Codex ${ready(sel.codexReady)}, so Dim Factory chose the ` +
      `"${sel.profile}" profile and saved it in ${core.paths.userConfig}. Change "profile" there, or pass --profile.`,
  )
}

async function readTask(task: string, reader: LineReader): Promise<string> {
  return task === '-' ? reader.all() : task
}

/** What another command hands `dimf run` (`dimf new`: the template's Brief, and its own name in messages). */
export interface RunPreset {
  brief?: BriefInput
  /** The command named in usage errors (default `run`). */
  cmd?: string
  usage?: string
}

export async function runCommand(
  args: readonly string[],
  io: CliIo,
  preset: RunPreset = {},
): Promise<number> {
  const cmd = preset.cmd ?? 'run'
  const usageText = preset.usage ?? RUN_USAGE
  let values: {
    profile?: string | undefined
    set?: string[] | undefined
    auto?: boolean | undefined
    isolated?: boolean | undefined
    'run-branch'?: boolean | undefined
    gates?: string | undefined
    cards?: string | undefined
    asks?: string | undefined
    'plan-file'?: string | undefined
    json?: boolean | undefined
    home?: string | undefined
    brief?: string | undefined
    'test-first'?: boolean | undefined
    security?: boolean | undefined
    clarify?: boolean | undefined
    research?: string | undefined
    'fix-rounds'?: string | undefined
    deploy?: boolean | undefined
    'deploy-target'?: string | undefined
    acceptance?: boolean | undefined
    explain?: boolean | undefined
    recipe?: string | undefined
  }
  let positionals: string[]
  let policy: RunPolicy
  let overrides: RunOverrides
  try {
    const parsed = parseArgs({
      args: normalizeResearchArg(args),
      options: {
        ...POLICY_OPTIONS,
        profile: { type: 'string' },
        set: { type: 'string', multiple: true },
        auto: { type: 'boolean', default: false },
        isolated: { type: 'boolean', default: false },
        'run-branch': { type: 'boolean', default: false },
        brief: { type: 'string' },
        'test-first': { type: 'boolean', default: false },
        security: { type: 'boolean', default: false },
        clarify: { type: 'boolean', default: false },
        research: { type: 'string' },
        'fix-rounds': { type: 'string' },
        deploy: { type: 'boolean', default: false },
        'deploy-target': { type: 'string' },
        acceptance: { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        recipe: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    values = parsed.values
    positionals = parsed.positionals
    if (positionals.length !== 2)
      throw new UsageError('expected <folder> and <task> (use - to read the task from stdin)')
    policy = runPolicy(values, io.isTTY)
    overrides = parseSets(values.set ?? [])
    // Isolated run (worktree): --isolated = `--set isolation.mode=worktree`.
    if (values.isolated === true) overrides.isolation = { ...overrides.isolation, mode: 'worktree' }
    // Branch prep: --run-branch = `--set isolation.branch=runBranch`.
    if (values['run-branch'] === true) overrides.isolation = { ...overrides.isolation, branch: 'runBranch' }
    overrides = withSecurityFlag(overrides, values.security === true)
    overrides = withClarifyFlag(overrides, values.clarify === true)
    overrides = withResearchFlag(overrides, values.research)
    overrides = withFixRounds(overrides, values['fix-rounds'])
    overrides = withDeployFlag(overrides, values.deploy === true, values['deploy-target'])
    overrides = withAcceptanceExplainFlags(overrides, values.acceptance === true, values.explain === true)
    if (values.profile !== undefined) overrides.profile = values.profile
    if (values.auto === true) overrides.auto = true
    // A recipe (`dimf recipes` lists them): its switches are a config layer below these flags and `--set`, and its
    // brief defaults apply when no brief flag is given. An unknown id is refused by core with a did-you-mean.
    if (values.recipe !== undefined && !RECIPE_ID_PATTERN.test(values.recipe)) {
      throw new UsageError(
        `--recipe: "${values.recipe}" is not a recipe id (lower case letters, digits and dashes)`,
      )
    }
  } catch (err) {
    io.err(`dimf ${cmd}: ${err instanceof Error ? err.message : String(err)}`)
    io.err(`usage: ${usageText}`)
    return EXIT.usage
  }
  const reader = new LineReader(io.stdin)
  const task = await readTask(positionals[1] ?? '', reader)
  if (task.trim() === '') {
    io.err(`dimf ${cmd}: the task is empty`)
    return EXIT.usage
  }
  if (policy.planFile === '-' && positionals[1] === '-') {
    io.err(`dimf ${cmd}: stdin cannot carry both the task and --plan-file -`)
    return EXIT.usage
  }
  const folder = resolve(io.cwd, positionals[0] ?? '.')
  const json = values.json === true
  let brief: BriefInput | undefined
  try {
    brief = await briefFromArgs(values.brief, values['test-first'] === true, io.cwd, preset.brief)
  } catch (err) {
    io.err(`dimf ${cmd}: ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.usage
  }
  return withWritableCore(
    io,
    values.home,
    async (core) => {
      let runId: string | undefined
      const statePrinter = new RunPrinter(io, {
        json,
        state: () => (runId !== undefined ? core.controller(runId)?.state : undefined),
      })
      const detach = core.bus.attach(statePrinter)
      // Ctrl+C from here on is never lost: driveRun replays what came before it follows the run.
      const early = new EarlyInterrupts(io)
      try {
        // Before runs.start: the first run must use the profile first launch picks and announces.
        await firstLaunchNotice(core, io)
        const r = await core.invoke('runs.start', {
          folder,
          task,
          overrides,
          ...(brief !== undefined ? { brief } : {}),
          ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        })
        if (!r.ok) {
          if (r.error.code === 'PREFLIGHT_BLOCKED') {
            printBlocked(io, r.error, {
              cli: cliName(io),
              folder,
              ...(values.home !== undefined ? { home: values.home } : {}),
            })
            return EXIT.preflightBlocked
          }
          io.err(`dimf ${cmd}: ${r.error.message}`)
          return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
        }
        runId = r.value.runId
        statePrinter.line(`Run #${r.value.displayNo} (${runId}) in ${folder}`)
        const recipe = core.controller(runId)?.state.recipe
        if (recipe !== undefined) statePrinter.line(`Recipe: ${recipe.label}`)
        statePrinter.follow(runId)
        const interaction = new Interaction(io, policy, statePrinter, reader)
        const code = await driveRun(core, runId, policy, io, statePrinter, interaction, early)
        printFooter(core, runId, statePrinter, code)
        return code
      } finally {
        early.take()
        detach()
        reader.pause()
      }
    },
    { configBanner: false },
  )
}
