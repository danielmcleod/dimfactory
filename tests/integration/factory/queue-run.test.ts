// The task queue through a real core and the fake Claude (no network): tasks run one after another in a temp git
// sandbox, with the real verify command check.mjs.
//   - three tasks, the second completes with failures (verify-failed): done, failed, done; the queue ends idle with
//     the failure count reset; the day's report lists the three runs, written to <home>/reports/<date>.md
//   - a budget stop: the run past the limit per run is stopped, its task reads stopped (budget_exceeded) and the queue
//     pauses with the reason; the next task stays pending
//   - the stop rule: two failed tasks in a row (the project's quality gates, which the runs cannot pass) pause the
//     queue; the third stays pending
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { grantTrust } from '../../../src/core/config/trust.ts'
import { CHECK } from '../verify/helpers.ts'
import { git } from '../run/scenario.ts'
import { World, only, tasksSpec, value, version, waitForQueue } from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

const trustCheck = async (home: string, folder: string): Promise<void> => {
  await grantTrust(
    folder,
    { kind: 'command', command: { kind: 'verify', argv: ['node', 'check.mjs'], cwdRel: '.' } },
    { home },
  )
}

describe('a three-task queue (core + fake Claude)', () => {
  it('runs the tasks one after another; a failure is counted, the next task still runs; the report lists them', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0'), version('0.1.0'), version('1.0.0')], {
        // Task 2: Fix (reusing Implement's session) leaves the check failing.
        resume: [{ recording: 'C08b-resume-fix', write: version('0.2.0'), text: 'F1 fixed' }],
      }),
      { verify: { enabled: true, commands: [CHECK] }, factory: { stopAfterFailures: 2 } },
    )
    await trustCheck(w.home, w.folder)
    const { core } = await world.boot(w)
    const added = value(
      await core.invoke('queue.add', {
        folder: w.folder,
        tasks: [{ task: 'set the version to 1.0.0' }, { task: 'try 0.1.0' }, { task: 'back to 1.0.0' }],
      }),
    )
    // Adding starts nothing.
    expect(only(added)).toMatchObject({ state: 'idle', counts: { pending: 3, running: 0 } })
    expect(only(added).tasks.map((t) => t.title)).toEqual([
      'set the version to 1.0.0',
      'try 0.1.0',
      'back to 1.0.0',
    ])

    value(await core.invoke('queue.start', {}))
    const end = await waitForQueue(
      core,
      (v) => only(v).state === 'idle' && only(v).counts.pending === 0,
      400_000,
    )
    const q = only(end)
    expect(q.tasks.map((t) => [t.status, t.outcome])).toEqual([
      ['done', 'clean'],
      ['failed', 'verify-failed'],
      ['done', 'clean'],
    ])
    expect(q.tasks[1]?.reason).toBe('Completed with failures: a check still fails.')
    // One after another: each task's run started after the one before had ended.
    const [a, b, c] = q.tasks
    expect((a?.endedAt ?? 0) <= (b?.startedAt ?? 0) && (b?.endedAt ?? 0) <= (c?.startedAt ?? 0)).toBe(true)
    expect(new Set(q.tasks.map((t) => t.runId)).size).toBe(3)
    // The done third task reset the count; the queue is idle (it ran out of tasks), not paused.
    expect(q.consecutiveFailures).toBe(0)
    expect(q.pause).toBeUndefined()

    const report = value(await core.invoke('queue.report', {}))
    expect(report.runs.map((r) => [r.displayNo, r.queued, r.outcome])).toEqual([
      [a?.displayNo, true, 'clean'],
      [b?.displayNo, true, 'verify-failed'],
      [c?.displayNo, true, 'clean'],
    ])
    expect(report.outcomes).toMatchObject({ done: 2, failed: 1, stopped: 0, working: 0 })
    expect(report.runs[1]?.failure).toBe('Completed with failures: a check still fails.')
    expect(existsSync(report.file)).toBe(true)
    const md = readFileSync(report.file, 'utf8')
    expect(md).toContain(`# Dim Factory daily report: ${report.date}`)
    expect(md).toContain('3 runs (3 from a queue). Done 2, failed 1, stopped 0, still working 0.')
    expect(md).toContain(
      `- Run #${b?.displayNo ?? 0} (try 0.1.0): Completed with failures: a check still fails.`,
    )
    expect(md).not.toContain('—')
  }, 600_000)
})

describe('budgets and stop rules (core + fake Claude)', () => {
  it('a run past the limit per run is stopped, the queue pauses with why, and the next task waits', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.0')]), {
      factory: { maxCostPerRunUsd: 0.000001 },
    })
    const { core } = await world.boot(w)
    value(
      await core.invoke('queue.add', {
        folder: w.folder,
        tasks: [{ task: 'first task' }, { task: 'second task' }],
      }),
    )
    value(await core.invoke('queue.start', {}))
    const paused = await waitForQueue(
      core,
      (v) => only(v).state === 'paused' && only(v).tasks[0]?.status === 'stopped',
    )
    const q = only(paused)
    expect(q.pause?.reason).toBe('run-budget')
    expect(q.pause?.text).toMatch(/^Run #\d+ cost \$\d+\.\d\d|^Run #\d+ cost less than \$0\.01/)
    expect(q.pause?.text).toContain(
      'more than the limit of less than $0.01 per run, so Dim Factory stopped it.',
    )
    expect(q.tasks[0]).toMatchObject({ status: 'stopped', category: 'budget_exceeded' })
    expect(q.tasks[1]).toMatchObject({ status: 'pending' })
    const run = core.summary(q.tasks[0]?.runId ?? '')
    expect(run?.status).toBe('cancelled')
    // Nothing else starts while the queue is paused.
    await new Promise((r) => setTimeout(r, 1500))
    expect(only(value(await core.invoke('queue.get'))).tasks[1]?.status).toBe('pending')
    const report = value(await core.invoke('queue.report', {}))
    expect(report.pauses.map((p) => p.text)).toEqual([q.pause?.text])
  }, 300_000)

  it('two failed tasks in a row pause the queue (the stop rule); the third stays pending', async () => {
    // The project requires a check the runs cannot pass (Verify is off): each run completes as gates-failed.
    const w = await world.setup(
      tasksSpec([version('1.0.1'), version('1.0.2'), version('1.0.3')]),
      { factory: { stopAfterFailures: 2 } },
      { project: { quality: { enabled: true, verify: ['check'] } } },
    )
    const { core } = await world.boot(w)
    value(
      await core.invoke('queue.add', {
        folder: w.folder,
        tasks: [{ task: 'one' }, { task: 'two' }, { task: 'three' }],
      }),
    )
    value(await core.invoke('queue.start', {}))
    const paused = await waitForQueue(core, (v) => only(v).state === 'paused', 400_000)
    const q = only(paused)
    expect(q.tasks.map((t) => [t.status, t.outcome])).toEqual([
      ['failed', 'gates-failed'],
      ['failed', 'gates-failed'],
      ['pending', undefined],
    ])
    expect(q.consecutiveFailures).toBe(2)
    expect(q.pause).toMatchObject({ reason: 'failures', taskId: q.tasks[1]?.id })
    expect(q.pause?.text).toBe(
      '2 tasks in a row failed, so the queue paused. Look at the failed runs, then resume the queue (or retry the tasks).',
    )
    expect(q.tasks[0]?.reason).toBe("Completed with failures: the project's quality gates did not pass.")
    const s = core.summary(q.tasks[0]?.runId ?? '')
    expect(s?.gates).toEqual({
      passed: [],
      failed: [{ name: 'check', reason: 'Verify is off for this run, so it did not run.' }],
    })
  }, 600_000)
})

describe('each task on its own branch (the project opted into commits)', () => {
  it('runs each task on a run branch, commits its work there and goes back for the next task', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0'), version('1.0.1')]),
      {},
      { project: { git: { commit: true } } },
    )
    // The run's commits need an identity of the repo's own: a CI runner has no global one (git refuses, the queue
    // pauses on it).
    git(w.folder, 'config', 'user.name', 'Test User')
    git(w.folder, 'config', 'user.email', 'test@example.invalid')
    git(w.folder, 'config', 'commit.gpgsign', 'false')
    const before = git(w.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    const { core } = await world.boot(w)
    value(await core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'one' }, { task: 'two' }] }))
    value(await core.invoke('queue.start', {}))
    const end = await waitForQueue(core, (v) => only(v).state === 'idle' && only(v).counts.pending === 0)
    const [a, b] = only(end).tasks
    expect([a?.status, b?.status]).toEqual(['done', 'done'])
    expect(a?.branch).toMatch(/^dim\//)
    expect(b?.branch).toMatch(/^dim\//)
    expect(a?.branch).not.toBe(b?.branch)
    expect(a?.commit).toMatch(/^[0-9a-f]{40}$/)
    // Back on the branch the queue started from; each branch holds its task's change.
    expect(git(w.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(before)
    expect(git(w.folder, 'show', `${a?.branch ?? ''}:src/version.ts`)).toContain('1.0.0')
    expect(git(w.folder, 'show', `${b?.branch ?? ''}:src/version.ts`)).toContain('1.0.1')
    // The folder's own branch never got a commit.
    expect(git(w.folder, 'log', '--oneline', before).trim().split('\n')).toHaveLength(1)
  }, 400_000)
})
