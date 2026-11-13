// `dimf match start <folder> <task|-> --a vendor[:model[:effort]] --b vendor[:model[:effort]]` (a Head to head: one
// task, two builders, each side an isolated run in its own copy of the folder as it is now), `dimf match show <id>` and
// `dimf match list`.
//
// `start` follows both sides until each has built (it then waits for you to apply or discard it), has ended, or needs
// you. It answers nothing itself: two runs asking in one terminal would talk over each other. A side that needs you
// is finished with `dimf resume <runId>`, which is also where a side is applied to the folder or discarded.
// Clarify and Research are off for a match started here: side B starts only when side A's questions are answered, and
// this command answers none (the app asks once and shares the answers with both sides).
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { RunOverrides } from '../../shared/config-schema.ts'
import { MATCH_SIDE_LABEL } from '../../shared/match.ts'
import type { MatchContestant, MatchSideView, MatchView } from '../../shared/match.ts'
import { RECIPE_ID_PATTERN } from '../../shared/recipes.ts'
import type { RunState } from '../../core/supervisor/types.ts'
import { UsageError, parseSets } from '../args.ts'
import { printBlocked } from '../drive.ts'
import type { CliIo } from '../io.ts'
import { LineReader } from '../io.ts'
import { vendorName } from '../render.ts'
import { EXIT, cliName, usage, when, withReadOnlyCore, withWritableCore } from '../session.ts'

export const MATCH_USAGE =
  'dimf match start <folder> <task|-> --a vendor[:model[:effort]] --b vendor[:model[:effort]] [--set k=v]... ' +
  '[--recipe id] [--json] [--home dir]  |  dimf match show <matchId> [--json] [--home dir]  |  ' +
  'dimf match list [--json] [--home dir]'

/** `claude`, `claude:opus`, `codex::high`, `claude:default:low`: a vendor, then its model and effort when given. */
export function parseContestant(flag: string, text: string | undefined): MatchContestant {
  if (text === undefined || text.trim() === '') throw new UsageError(`${flag} names who builds that side`)
  const [vendor = '', model = '', effort = '', ...rest] = text.split(':').map((s) => s.trim())
  if (rest.length > 0 || vendor === '') {
    throw new UsageError(`${flag} expects vendor[:model[:effort]] (got "${text}")`)
  }
  return {
    vendor,
    ...(model !== '' ? { model: model === 'default' ? null : model } : {}),
    ...(effort !== '' ? { effort } : {}),
  }
}

/** `Claude`, `Claude (opus)`, `Codex (default model, high)`. */
export function contestantText(c: MatchContestant): string {
  const parts = [
    ...(typeof c.model === 'string' ? [c.model] : c.effort !== undefined ? ['default model'] : []),
    ...(c.effort !== undefined ? [c.effort] : []),
  ]
  return parts.length > 0 ? `${vendorName(c.vendor)} (${parts.join(', ')})` : vendorName(c.vendor)
}

function costText(usd: number | null | undefined): string {
  return typeof usd === 'number' ? `$${usd.toFixed(2)}` : 'no price'
}

/** How a side stands, in a few words. */
export function sideStanding(s: MatchSideView): string {
  if (s.runId === undefined) return s.notStarted ?? 'not started'
  if (s.status === undefined) return 'its run is not here any more'
  if (s.copyState === 'applied') return 'applied to the folder'
  if (s.copyState === 'discarded' || s.copyState === 'discarding') return 'discarded'
  if (s.notApplied === true) return 'built, not applied'
  if (s.outcome !== undefined) return `${s.status} (${s.outcome})`
  return s.status
}

export function sideLine(s: MatchSideView): string {
  const facts =
    s.status === undefined
      ? ''
      : `  ${s.filesChanged ?? 0} file${s.filesChanged === 1 ? '' : 's'} changed · ${costText(s.costUsd)}`
  const run = s.runId !== undefined ? `run #${String(s.displayNo ?? '').padEnd(4)} ${s.runId}  ` : ''
  return `  ${MATCH_SIDE_LABEL[s.side]}  ${contestantText(s.contestant).padEnd(28)} ${run}${sideStanding(s)}${facts}`
}

export function matchLines(v: MatchView): string[] {
  const state = v.ended ? 'ended' : v.ready ? 'both sides built' : 'going'
  return [
    `Match ${v.matchId}  ${when(v.createdAt)}  ${state}  ${v.folder}`,
    `  ${v.task.split('\n')[0]?.slice(0, 100) ?? ''}`,
    sideLine(v.sides[0]),
    sideLine(v.sides[1]),
  ]
}

/** A side is done for this command: it built, it ended, or it waits for a person. */
const settled = (s: RunState): boolean => s.status !== 'queued' && s.status !== 'running'

const HOME_JSON = { home: { type: 'string' }, json: { type: 'boolean', default: false } } as const

async function startCommand(args: readonly string[], io: CliIo): Promise<number> {
  let folder: string
  let taskArg: string
  let sides: [MatchContestant, MatchContestant]
  let overrides: RunOverrides
  let v: {
    a?: string | undefined
    b?: string | undefined
    set?: string[] | undefined
    recipe?: string | undefined
    json?: boolean | undefined
    home?: string | undefined
  }
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        ...HOME_JSON,
        a: { type: 'string' },
        b: { type: 'string' },
        set: { type: 'string', multiple: true },
        recipe: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length !== 2) {
      throw new UsageError('expected <folder> and <task> (use - to read the task from stdin)')
    }
    folder = resolve(io.cwd, parsed.positionals[0] ?? '.')
    taskArg = parsed.positionals[1] ?? ''
    sides = [parseContestant('--a', v.a), parseContestant('--b', v.b)]
    const sets = parseSets(v.set ?? [])
    overrides = {
      ...sets,
      passes: { ...sets.passes, plan: { ...sets.passes?.plan, clarify: false, research: false } },
    }
    if (v.recipe !== undefined && !RECIPE_ID_PATTERN.test(v.recipe)) {
      throw new UsageError(
        `--recipe: "${v.recipe}" is not a recipe id (lower case letters, digits and dashes)`,
      )
    }
  } catch (err) {
    return usage(io, 'match', MATCH_USAGE, err)
  }
  const reader = new LineReader(io.stdin)
  const task = taskArg === '-' ? await reader.all() : taskArg
  reader.pause()
  if (task.trim() === '') {
    io.err('dimf match: the task is empty')
    return EXIT.usage
  }
  const json = v.json === true
  const say = (line: string): void => (json ? io.err(line) : io.out(line))
  return withWritableCore(io, v.home, async (core) => {
    const r = await core.invoke('matches.start', {
      folder,
      task,
      sides,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(v.recipe !== undefined ? { recipe: v.recipe } : {}),
    })
    if (!r.ok) {
      if (r.error.code === 'PREFLIGHT_BLOCKED') {
        io.err(`dimf match: ${r.error.message}`)
        printBlocked(io, r.error, { cli: cliName(io), ...(v.home !== undefined ? { home: v.home } : {}) })
        return EXIT.preflightBlocked
      }
      io.err(`dimf match: ${r.error.message}`)
      return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
    }
    const started = r.value
    say(`Match ${started.matchId} in ${folder}`)
    let interrupted = false
    const offInterrupt = io.onInterrupt(() => {
      if (interrupted) return
      interrupted = true
      say('Stopping both sides…')
      for (const s of started.sides) {
        if (s.runId !== undefined) void core.invoke('runs.stop', { runId: s.runId })
      }
    })
    const offs: (() => void)[] = []
    try {
      await Promise.all(
        started.sides.map(async (side, i) => {
          const c = side.runId !== undefined ? core.controller(side.runId) : undefined
          if (c === undefined) return
          const who = `${MATCH_SIDE_LABEL[side.side]} (${contestantText(sides[i] as MatchContestant)}, run #${side.displayNo ?? ''})`
          let last = ''
          const report = (s: RunState): void => {
            const now = `${s.phase} · ${s.status}`
            if (now === last) return
            last = now
            say(`${who}: ${now}`)
          }
          report(c.state)
          offs.push(c.subscribe(report))
          await c.waitFor(settled)
        }),
      )
    } finally {
      offInterrupt()
      for (const off of offs) off()
    }
    const view = await core.invoke('matches.get', { matchId: started.matchId })
    if (!view.ok) {
      io.err(`dimf match: ${view.error.message}`)
      return EXIT.failed
    }
    if (json) io.out(JSON.stringify(view.value, null, 2))
    else {
      for (const line of matchLines(view.value)) io.out(line)
      const waiting = view.value.sides.filter(
        (s) => s.runId !== undefined && (s.status === 'waiting' || s.status === 'paused'),
      )
      if (waiting.length > 0) {
        io.out('')
        io.out('To look at a side, answer what it asks, apply it to the folder or discard it:')
        for (const s of waiting) io.out(`  ${cliName(io)} resume ${s.runId ?? ''}`)
      }
    }
    const statuses = view.value.sides.map((s) => s.status)
    if (interrupted || statuses.includes('cancelled')) return EXIT.cancelled
    if (statuses.includes('failed')) return EXIT.failed
    return statuses.every((s) => s === 'completed') ? EXIT.completed : EXIT.paused
  })
}

async function showCommand(args: readonly string[], io: CliIo): Promise<number> {
  let id: string
  let v: { json?: boolean | undefined; home?: string | undefined }
  try {
    const parsed = parseArgs({ args: [...args], options: HOME_JSON, allowPositionals: true, strict: true })
    v = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <matchId>')
    id = parsed.positionals[0] ?? ''
  } catch (err) {
    return usage(io, 'match', MATCH_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, async (core) => {
    const r = await core.invoke('matches.get', { matchId: id })
    if (!r.ok) {
      io.err(`dimf match: ${r.error.message}`)
      return r.error.code === 'NOT_FOUND' || r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
    }
    if (v.json === true) io.out(JSON.stringify(r.value, null, 2))
    else for (const line of matchLines(r.value)) io.out(line)
    return EXIT.completed
  })
}

async function listCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: { json?: boolean | undefined; home?: string | undefined }
  try {
    v = parseArgs({ args: [...args], options: HOME_JSON, allowPositionals: false, strict: true }).values
  } catch (err) {
    return usage(io, 'match', MATCH_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, async (core) => {
    const r = await core.invoke('matches.list')
    if (!r.ok) {
      io.err(`dimf match: ${r.error.message}`)
      return EXIT.failed
    }
    if (v.json === true) io.out(JSON.stringify(r.value, null, 2))
    else if (r.value.length === 0) io.out('No matches.')
    else for (const m of r.value) for (const line of matchLines(m)) io.out(line)
    return EXIT.completed
  })
}

export async function matchCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'start':
      return startCommand(rest, io)
    case 'show':
      return showCommand(rest, io)
    case 'list':
      return listCommand(rest, io)
    case undefined:
    default:
      return usage(io, 'match', MATCH_USAGE, new UsageError('expected start, show or list'))
  }
}
