// A batch of rematches through a real core (the fake Claude for the passes): the plan picks a finished run another
// builder made, the batch goes into the folder's queue as a rematch item, the queue starts it as a rematch and follows
// the challenger's build to its end, the item knows its match, and the scoreboard reads the match once it has ended
// and been judged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunOverrides } from '../../../src/shared/config-schema.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

const VERSION = 'export const version = "1.0.0"\n'
const SECOND = `${VERSION}export const built = "second"\n`

const overrides: RunOverrides = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  isolation: { worktree: { install: 'never' } },
  verify: { enabled: false },
}

const ended = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled'

describe('Batch rematch (core + fake Claude)', () => {
  it('plans, queues, and the queue starts the rematch; the scoreboard reads it once it is judged', async () => {
    const sc = await makeScenario({
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: VERSION } },
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: SECOND } },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox({ git: false })
    dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)

    const first = value(await core.invoke('runs.start', { folder, task: 'add a --version flag', overrides }))
    const original = await core.controller(first.runId)?.waitFor(ended, 120_000)
    expect(original?.status, JSON.stringify(original?.notes)).toBe('completed')

    // ---- the plan: this run, against another model of a vendor that has run here ----
    const challenger = { vendor: 'claude', model: 'opus' }
    const plan = value(await core.invoke('matches.batchPlan', { challenger }))
    expect(plan.items.map((i) => [i.runId, i.displayNo, i.category])).toEqual([
      [first.runId, first.displayNo, 'software'],
    ])
    expect(plan.newVendorLeftOut).toBe(0)
    // A vendor that never ran in the project gets nothing to replay from a card: a rematch there asks first.
    const other = value(await core.invoke('matches.batchPlan', { challenger: { vendor: 'codex' } }))
    expect(other.items).toEqual([])
    expect(other.newVendorLeftOut).toBe(1)
    expect(value(await core.invoke('matches.offers'))).toEqual([])

    // ---- into the queue, as a rematch item ----
    expect(value(await core.invoke('matches.batchAdd', { challenger, runIds: [first.runId] }))).toEqual({
      added: 1,
      skipped: 0,
    })
    let queue = value(await core.invoke('queue.get'))
    const queued = queue.folders.find((f) => f.tasks.length > 0)?.tasks[0]
    expect(queued).toMatchObject({
      status: 'pending',
      rematch: { runId: first.runId, displayNo: first.displayNo, challenger, blind: true },
    })
    // Nothing started yet: the queue starts it.
    expect(value(await core.invoke('matches.list'))).toEqual([])

    // ---- the queue starts it as a rematch and follows the challenger's build ----
    value(await core.invoke('queue.start', { folders: [folder] }))
    let task = queued
    for (let i = 0; i < 600 && task?.status !== 'done' && task?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 200))
      queue = value(await core.invoke('queue.get'))
      task = queue.folders.find((f) => f.tasks.length > 0)?.tasks[0]
    }
    expect(task?.status, task?.reason).toBe('done')
    const matchId = task?.rematch?.matchId ?? ''
    expect(matchId).not.toBe('')
    const view = value(await core.invoke('matches.get', { matchId }))
    expect(view).toMatchObject({ kind: 'rematch', ready: true, ended: true })
    expect(view.sides[1]).toMatchObject({ runId: task?.runId, contestant: challenger })
    // Queued rematches hide the names until a pick.
    expect(view.blind?.revealedAt).toBeUndefined()
    // The folder was not touched by it, and nothing of it was committed or applied.
    expect(readFileSync(join(folder, 'src', 'version.ts'), 'utf8')).toBe(VERSION)
    expect(core.summary(task?.runId ?? '')?.worktree).toEqual({ state: 'kept', notApplied: true })
    // The same run is not offered against the same builder again.
    expect(value(await core.invoke('matches.batchPlan', { challenger })).items).toEqual([])

    // ---- the scoreboard: listed at once, counted once it is judged ----
    let board = value(await core.invoke('matches.scoreboard'))
    expect(board.matches.map((m) => [m.matchId, m.kind, m.ended, m.pick])).toEqual([
      [matchId, 'rematch', true, undefined],
    ])
    value(await core.invoke('matches.pick', { matchId, side: 'b' }))
    board = value(await core.invoke('matches.scoreboard'))
    expect(board.matches[0]?.pick).toBe('b')
    expect(
      board.rows.map((r) => [r.category, r.builder.vendor, r.matches, r.judged, r.picked, r.enough]),
    ).toEqual(expect.arrayContaining([['software', 'claude', 1, 1, 1, false]]))
    expect(board.rows).toHaveLength(2)
    expect(board.suggestions).toEqual([])
  }, 300_000)
})
