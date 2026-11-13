// One folder's queue as a pure reducer (factory/model.ts): the reducer rows, and which task starts next.
import { describe, expect, it } from 'vitest'
import { emptyQueue, nextTask, reduceQueue, taskOfRun } from '@core/factory/model.ts'
import type { FolderQueueDoc, QueueEvent } from '@core/factory/model.ts'
import { QUEUE_TASKS_MAX } from '@shared/factory.ts'

const F = '/work/repo'
const id = (n: number): string => `t${String(n).padStart(12, '0')}`

function withTasks(n: number): FolderQueueDoc {
  return reduceQueue(emptyQueue(F), {
    t: 'add',
    at: 1,
    tasks: Array.from({ length: n }, (_, i) => ({
      id: id(i + 1),
      task: `task ${i + 1}`,
      source: { kind: 'manual' as const },
    })),
  }).doc
}

function apply(doc: FolderQueueDoc, ...evs: QueueEvent[]): FolderQueueDoc {
  return evs.reduce((d, e) => reduceQueue(d, e).doc, doc)
}

const started = (doc: FolderQueueDoc, n: number, runId = `r${n}`): FolderQueueDoc =>
  apply(doc, { t: 'task-started', id: id(n), runId, displayNo: n, at: 10 + n })

const update = (
  runId: string,
  status: Extract<QueueEvent, { t: 'run-update' }>['status'],
  o: Partial<Extract<QueueEvent, { t: 'run-update' }>> = {},
): QueueEvent => ({
  t: 'run-update',
  runId,
  status,
  costUsd: 0.1,
  at: 100,
  skipBlocked: false,
  stopAfterFailures: 3,
  ...o,
})

describe('edits', () => {
  it('add appends pending tasks with their titles; a recipe is kept; the queue stays idle', () => {
    const d = reduceQueue(emptyQueue(F), {
      t: 'add',
      at: 5,
      tasks: [
        {
          id: id(1),
          task: '\n  Fix the login bug\nwith details',
          recipe: 'bug-fix',
          source: { kind: 'manual' },
        },
      ],
    }).doc
    expect(d.state).toBe('idle')
    expect(d.tasks).toEqual([
      {
        id: id(1),
        task: '\n  Fix the login bug\nwith details',
        title: 'Fix the login bug',
        recipe: 'bug-fix',
        source: { kind: 'manual' },
        addedAt: 5,
        status: 'pending',
      },
    ])
  })

  it(`add stops at ${QUEUE_TASKS_MAX} tasks`, () => {
    const d = withTasks(QUEUE_TASKS_MAX - 1)
    const r = reduceQueue(d, {
      t: 'add',
      at: 1,
      tasks: [1, 2, 3].map((i) => ({ id: id(900 + i), task: 'x', source: { kind: 'manual' as const } })),
    })
    expect(r.doc.tasks).toHaveLength(QUEUE_TASKS_MAX)
  })

  it('move clamps the position; remove leaves a working task alone', () => {
    const d = withTasks(3)
    expect(apply(d, { t: 'move', id: id(3), to: 0 }).tasks.map((t) => t.id)).toEqual([id(3), id(1), id(2)])
    expect(apply(d, { t: 'move', id: id(1), to: 99 }).tasks.map((t) => t.id)).toEqual([id(2), id(3), id(1)])
    expect(reduceQueue(d, { t: 'move', id: 'nope', to: 0 }).doc).toBe(d)
    expect(apply(d, { t: 'remove', id: id(2) }).tasks.map((t) => t.id)).toEqual([id(1), id(3)])
    const running = started(d, 1)
    expect(reduceQueue(running, { t: 'remove', id: id(1) }).doc).toBe(running)
  })

  it('retry puts a failed, stopped or blocked task back to pending, without its last run', () => {
    let d = started(apply(withTasks(1), { t: 'start', at: 1 }), 1)
    d = apply(d, update('r1', 'completed', { outcome: 'verify-failed' }))
    expect(d.tasks[0]).toMatchObject({ status: 'failed', runId: 'r1' })
    const r = apply(d, { t: 'retry', id: id(1) }).tasks[0]
    expect(r).toEqual({
      id: id(1),
      task: 'task 1',
      title: 'task 1',
      source: { kind: 'manual' },
      addedAt: 1,
      status: 'pending',
    })
    // A done task is not retried.
    const done = apply(
      started(apply(withTasks(1), { t: 'start', at: 1 }), 1),
      update('r1', 'completed', { outcome: 'clean' }),
    )
    expect(reduceQueue(done, { t: 'retry', id: id(1) }).doc).toBe(done)
  })

  it('clear-finished drops the done tasks only', () => {
    let d = started(apply(withTasks(3), { t: 'start', at: 1 }), 1)
    d = apply(d, update('r1', 'completed', { outcome: 'clean' }))
    d = apply(started(d, 2), update('r2', 'completed', { outcome: 'failed' }))
    expect(apply(d, { t: 'clear-finished' }).tasks.map((t) => [t.id, t.status])).toEqual([
      [id(2), 'failed'],
      [id(3), 'pending'],
    ])
  })
})

describe('state', () => {
  it('start and resume run the queue, clear its pause and the failure count; scheduled is recorded', () => {
    let d = { ...withTasks(1), consecutiveFailures: 2 }
    d = apply(d, { t: 'pause', pause: { reason: 'user', text: 'x', at: 1 } })
    expect(d.state).toBe('paused')
    const r = apply(d, { t: 'start', at: 2, scheduled: true })
    expect(r).toMatchObject({ state: 'running', consecutiveFailures: 0, scheduled: true })
    expect(r.pause).toBeUndefined()
    expect(apply(d, { t: 'resume', at: 2 }).scheduled).toBeUndefined()
  })

  it('starting a queue with nothing to do leaves it idle', () => {
    const r = reduceQueue(emptyQueue(F), { t: 'start', at: 1 })
    expect(r.doc.state).toBe('idle')
    expect(r.finished).toBe(true)
  })

  it('an idle queue only takes your own pause', () => {
    const d = withTasks(1)
    expect(reduceQueue(d, { t: 'pause', pause: { reason: 'day-budget', text: 'x', at: 1 } }).doc).toBe(d)
    const r = reduceQueue(d, { t: 'pause', pause: { reason: 'user', text: 'x', at: 1 } })
    expect(r.paused).toEqual({ reason: 'user', text: 'x', at: 1 })
  })
})

describe('starting tasks', () => {
  it('nextTask: only while running; one at a time in place; several with isolated copies', () => {
    const d = withTasks(3)
    expect(nextTask(d, { isolate: false })).toBeUndefined()
    const run = apply(d, { t: 'start', at: 1 })
    expect(nextTask(run, { isolate: false })?.id).toBe(id(1))
    const one = started(run, 1)
    expect(nextTask(one, { isolate: false })).toBeUndefined()
    expect(nextTask(one, { isolate: true })?.id).toBe(id(2))
  })

  it('task-started records the run; taskOfRun finds it', () => {
    const d = started(apply(withTasks(1), { t: 'start', at: 1 }), 1, 'run-a')
    expect(d.tasks[0]).toMatchObject({ status: 'running', runId: 'run-a', displayNo: 1, startedAt: 11 })
    expect(taskOfRun(d, 'run-a')?.id).toBe(id(1))
    expect(taskOfRun(d, 'other')).toBeUndefined()
  })

  it('a task that cannot start fails and pauses the queue (preflight), counting a failure', () => {
    const d = apply(withTasks(2), { t: 'start', at: 1 })
    const r = reduceQueue(d, { t: 'task-not-started', id: id(1), reason: 'Codex is not signed in.', at: 3 })
    expect(r.doc.tasks[0]).toMatchObject({ status: 'failed', reason: 'Codex is not signed in.', endedAt: 3 })
    expect(r.doc.consecutiveFailures).toBe(1)
    expect(r.paused).toEqual({
      reason: 'preflight',
      text: '"task 1" could not start: Codex is not signed in. Fix it, then resume the queue (or retry the task).',
      at: 3,
      taskId: id(1),
    })
    expect(r.ended).toEqual({ id: id(1), result: 'failed' })
  })
})

describe('run updates', () => {
  const running = (): FolderQueueDoc => started(apply(withTasks(3), { t: 'start', at: 1 }), 1)

  it('a run that needs you holds its task (waiting); the queue waits', () => {
    const d = apply(running(), update('r1', 'waiting', { reason: 'Run #1 waits for you.' }))
    expect(d.tasks[0]).toMatchObject({ status: 'waiting', reason: 'Run #1 waits for you.', costUsd: 0.1 })
    expect(nextTask(d, { isolate: false })).toBeUndefined()
    // It works again: running, reason gone.
    const again = apply(d, update('r1', 'running'))
    expect(again.tasks[0]?.status).toBe('running')
    expect(again.tasks[0]?.reason).toBeUndefined()
  })

  it('with skip blocked, the task is blocked and does not hold its place', () => {
    for (const status of ['waiting', 'paused', 'failed'] as const) {
      const d = apply(running(), update('r1', status, { skipBlocked: true, category: 'rate_limited' }))
      expect(d.tasks[0]).toMatchObject({ status: 'blocked', category: 'rate_limited' })
      expect(d.tasks[0]?.reason).toBe('Run #1 needs you.')
      expect(nextTask(d, { isolate: false })?.id).toBe(id(2))
      // Working again later: it stays out of the queue's way.
      expect(apply(d, update('r1', 'running')).tasks[0]?.status).toBe('blocked')
    }
  })

  it('completed: done resets the count; a failure counts and says why', () => {
    const done = reduceQueue(running(), update('r1', 'completed', { outcome: 'fixed' }))
    expect(done.doc.tasks[0]).toMatchObject({ status: 'done', outcome: 'fixed', endedAt: 100 })
    expect(done.ended).toEqual({ id: id(1), result: 'done' })
    const failed = reduceQueue(running(), update('r1', 'completed', { outcome: 'gates-failed' }))
    expect(failed.doc.tasks[0]).toMatchObject({
      status: 'failed',
      reason: "Completed with failures: the project's quality gates did not pass.",
    })
    expect(failed.doc.consecutiveFailures).toBe(1)
    expect(failed.paused).toBeUndefined()
  })

  it('failures in a row pause the queue with the stop rule text', () => {
    let d = running()
    d = apply(d, update('r1', 'completed', { outcome: 'verify-failed', stopAfterFailures: 2 }))
    d = started(d, 2)
    const r = reduceQueue(d, update('r2', 'completed', { outcome: 'no-changes', stopAfterFailures: 2 }))
    expect(r.doc.state).toBe('paused')
    expect(r.paused).toEqual({
      reason: 'failures',
      text: '2 tasks in a row failed, so the queue paused. Look at the failed runs, then resume the queue (or retry the tasks).',
      at: 100,
      taskId: id(2),
    })
    expect(r.doc.tasks[1]?.reason).toBe('The run made no changes.')
  })

  it('stopped by a limit: the task says the limit, and the queue pauses with it', () => {
    const pause = { reason: 'run-budget' as const, text: 'Run #1 cost too much.', at: 50 }
    const r = reduceQueue(
      running(),
      update('r1', 'cancelled', { stoppedBy: { pause, category: 'budget_exceeded' } }),
    )
    expect(r.doc.tasks[0]).toMatchObject({
      status: 'stopped',
      reason: 'Run #1 cost too much.',
      category: 'budget_exceeded',
    })
    expect(r.paused).toEqual({ ...pause, taskId: id(1) })
    expect(r.ended).toEqual({ id: id(1), result: 'stopped' })
  })

  it('stopped by you: the queue pauses (stopped-run)', () => {
    const r = reduceQueue(running(), update('r1', 'cancelled'))
    expect(r.doc.tasks[0]).toMatchObject({
      status: 'stopped',
      category: 'user_cancelled',
      reason: 'You stopped run #1.',
    })
    expect(r.paused?.reason).toBe('stopped-run')
    expect(r.paused?.text).toBe(
      'You stopped run #1, so the queue paused. Resume it to go on with the next task.',
    )
  })

  it('the last task ending leaves the queue idle (finished)', () => {
    let d = started(apply(withTasks(1), { t: 'start', at: 1 }), 1)
    const r = reduceQueue(d, update('r1', 'completed', { outcome: 'clean' }))
    expect(r.finished).toBe(true)
    expect(r.doc.state).toBe('idle')
    d = r.doc
    // A run the queue does not know, or an ended task, changes nothing.
    expect(reduceQueue(d, update('r1', 'completed', { outcome: 'clean' })).doc).toBe(d)
    expect(reduceQueue(d, update('zz', 'running')).doc).toBe(d)
  })

  it('committed records the branch and commit', () => {
    const d = apply(running(), { t: 'committed', id: id(1), branch: 'dim/x', commit: 'abc' })
    expect(d.tasks[0]).toMatchObject({ branch: 'dim/x', commit: 'abc' })
  })

  it('never mutates the doc it was given', () => {
    const d = running()
    const copy = structuredClone(d)
    reduceQueue(d, update('r1', 'completed', { outcome: 'clean' }))
    expect(d).toEqual(copy)
  })
})
