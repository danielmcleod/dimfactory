// The factory's schedule through a real core on a fake clock (a controllable clock set to a chosen local time), with
// the fake Claude for the runs:
//   - at launch, a window that is open and was not handled raises a notice and starts nothing; [Start queue] (the
//     notice's id) starts the queue and dismisses the notice
//   - with "resume automatically", the next window's launch notice says so and the queue goes on by itself
//   - while the app runs, the window opening starts the queue (by the schedule), and its end pauses it
//   - sleep: a window that opens while the machine sleeps waits for the wake
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Clock } from '../../../src/core/supervisor/effects.ts'
import { controllableClock } from '../../../src/core/supervisor/effects.ts'
import { World, only, tasksSpec, value, version, waitForQueue } from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

/** A clock whose now is `at` (local time) when it is made, then runs at the wall clock's pace; it can be moved on. */
function clockAt(at: Date): Clock & { advance: (ms: number) => number } {
  const shift = at.getTime() - Date.now()
  return controllableClock({
    now: () => Date.now() + shift,
    setTimer: (fn, due) => setTimeout(fn, Math.max(0, Math.min(2_147_483_647, due - (Date.now() + shift)))),
    clearTimer: (h) => clearTimeout(h),
    scale: 1,
  })
}

/** Tomorrow (local) at hh:mm. */
function tomorrowAt(hh: number, mm: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hh, mm, 0, 0)
  return d
}

const SCHEDULE = { enabled: true, start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] }

function setUser(home: string, patch: Record<string, unknown>): void {
  const file = join(home, 'dimfactory.json')
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...cfg, ...patch }, null, 2))
}

describe('the schedule at launch (fake clock)', () => {
  it('a due window raises a notice and starts nothing; Start queue starts it; resume automatically goes on', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.1')]))
    const at = tomorrowAt(23, 30)
    // A queue with a task, made before the schedule existed.
    const first = await world.boot(w, { clock: clockAt(at) })
    value(await first.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'overnight task' }] }))
    await world.stop(first.core)

    // Relaunch inside the window (22:00 to 06:00): the notice, nothing started.
    setUser(w.home, { factory: { schedule: { ...SCHEDULE, resumeAutomatically: false } } })
    const second = await world.boot(w, { clock: clockAt(at) })
    const v = value(await second.core.invoke('queue.get'))
    expect(v.notice).toMatchObject({ kind: 'schedule-due', folders: [w.folder] })
    expect(v.notice?.text).toBe(
      'The schedule was due at 22:00 while Dim Factory was closed. Start the queue now? Nothing runs until you do.',
    )
    expect(v.schedule).toMatchObject({ enabled: true, open: true, resumeAutomatically: false })
    expect(only(v)).toMatchObject({ state: 'idle', counts: { pending: 1, running: 0 } })
    await new Promise((r) => setTimeout(r, 1500))
    expect(value(await second.core.invoke('runs.list', {})).items).toHaveLength(0)
    expect(only(value(await second.core.invoke('queue.get'))).tasks[0]?.status).toBe('pending')

    // [Start queue]: the notice goes, the task runs.
    const started = value(
      await second.core.invoke('queue.start', {
        folders: v.notice?.folders ?? [],
        noticeId: v.notice?.id ?? '',
      }),
    )
    expect(started.notice).toBeUndefined()
    const done = await waitForQueue(second.core, (x) => only(x).tasks[0]?.status === 'done')
    expect(only(done).state).toBe('idle')
    // The same window does not ask again at the next launch.
    value(await second.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'the next night' }] }))
    await world.stop(second.core)
    const third = await world.boot(w, { clock: clockAt(at) })
    expect(value(await third.core.invoke('queue.get')).notice).toBeUndefined()
    await world.stop(third.core)

    // The next night, with "resume automatically": the queue goes on by itself, and the notice says so.
    setUser(w.home, { factory: { schedule: { ...SCHEDULE, resumeAutomatically: true } } })
    const next = new Date(at.getTime() + 24 * 3_600_000)
    const fourth = await world.boot(w, { clock: clockAt(next) })
    const auto = value(await fourth.core.invoke('queue.get'))
    expect(auto.notice).toMatchObject({ kind: 'resumed' })
    expect(auto.notice?.text).toContain('went on by itself ("resume automatically" is on)')
    expect(auto.notice?.text).toContain('Runs that were interrupted still wait for you.')
    const ran = await waitForQueue(fourth.core, (x) => only(x).tasks[1]?.status === 'done')
    expect(only(ran).tasks.map((t) => t.status)).toEqual(['done', 'done'])
  }, 400_000)

  it('a queue that was running when Dim Factory closed comes back paused, and its run never resumes by itself', async () => {
    const w = await world.setup({
      plan: [{ recording: 'C06-plan-native-host', delayMs: 60_000 }],
      implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
    })
    const first = await world.boot(w)
    value(await first.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'long task' }] }))
    value(await first.core.invoke('queue.start', {}))
    const running = await waitForQueue(first.core, (v) => only(v).tasks[0]?.status === 'running')
    const runId = only(running).tasks[0]?.runId ?? ''
    await world.stop(first.core)

    const second = await world.boot(w)
    const v = value(await second.core.invoke('queue.get'))
    expect(only(v).state).toBe('paused')
    expect(only(v).pause).toMatchObject({
      reason: 'relaunch',
      text: 'Dim Factory was closed while this queue ran. Resume it to go on with the next task.',
    })
    // The interrupted run waits for you (paused), and its task says so.
    const s = second.core.summary(runId)
    expect(s?.status).toBe('paused')
    expect(only(v).tasks[0]).toMatchObject({ status: 'waiting' })
    expect(only(v).tasks[0]?.reason).toMatch(/^Run #\d+ is paused\. Resume or stop it to go on\.$/)
    await new Promise((r) => setTimeout(r, 1500))
    expect(second.core.summary(runId)?.status).toBe('paused')
  }, 300_000)
})

describe('the schedule while the app runs (fake clock)', () => {
  it('the window opening starts the queue; its end pauses it while the running task goes on', async () => {
    const w = await world.setup(
      {
        plan: [{ recording: 'C06-plan-native-host', delayMs: 4000 }, { recording: 'C06-plan-native-host' }],
        implement: [
          { recording: 'C08a-session-id-implement', write: version('1.0.0') },
          { recording: 'C08a-session-id-implement', write: version('1.0.1') },
        ],
      },
      { factory: { schedule: { ...SCHEDULE, end: '23:00' } } },
    )
    const clock = clockAt(tomorrowAt(21, 58))
    const t = await world.boot(w, { clock })
    value(
      await t.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'at ten' }, { task: 'later' }] }),
    )
    let v = value(await t.core.invoke('queue.get'))
    expect(v.schedule).toMatchObject({ open: false })
    expect(v.schedule.nextStart).toBe(tomorrowAt(22, 0).getTime())
    expect(v.notice).toBeUndefined()
    expect(only(v).state).toBe('idle')

    // 22:00: the window opens and the queue starts, by the schedule.
    clock.advance(3 * 60_000)
    v = await waitForQueue(t.core, (x) => only(x).tasks[0]?.status === 'running')
    expect(only(v)).toMatchObject({ state: 'running', scheduled: true })
    expect(v.schedule).toMatchObject({ open: true, closesAt: tomorrowAt(23, 0).getTime() })
    // 23:00 while the first task runs: the queue pauses; the running task goes on to its end.
    clock.advance(60 * 60_000)
    v = await waitForQueue(t.core, (x) => only(x).tasks[0]?.status === 'done' && only(x).state === 'paused')
    expect(only(v).pause).toMatchObject({ reason: 'window-ended' })
    expect(only(v).pause?.text).toBe(
      'The schedule window closed. Tasks already running go on; the queue goes on in the next window, or resume it now.',
    )
    await new Promise((r) => setTimeout(r, 1000))
    expect(only(value(await t.core.invoke('queue.get'))).tasks[1]?.status).toBe('pending')
  }, 300_000)

  it('the end of the window pauses a scheduled queue; tasks already running go on', async () => {
    const w = await world.setup(
      {
        plan: [{ recording: 'C06-plan-native-host', delayMs: 4000 }, { recording: 'C06-plan-native-host' }],
        implement: [
          { recording: 'C08a-session-id-implement', write: version('1.0.0') },
          { recording: 'C08a-session-id-implement', write: version('1.0.1') },
        ],
      },
      { factory: { schedule: { ...SCHEDULE, end: '23:00' } } },
    )
    const clock = clockAt(tomorrowAt(22, 59))
    const t = await world.boot(w, { clock })
    value(await t.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'one' }, { task: 'two' }] }))
    value(await t.core.invoke('queue.start', {}))
    await waitForQueue(t.core, (x) => only(x).tasks[0]?.status === 'running')
    // 23:00 passes while the first task runs: a queue you started yourself is not paused by the window's end.
    clock.advance(2 * 60_000)
    const v = await waitForQueue(t.core, (x) => only(x).tasks[1]?.status === 'done', 200_000)
    expect(only(v).tasks.map((x) => x.status)).toEqual(['done', 'done'])
  }, 300_000)

  it('a window that opens while the machine sleeps waits for the wake', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0')]), { factory: { schedule: SCHEDULE } })
    const clock = clockAt(tomorrowAt(21, 59))
    const t = await world.boot(w, { clock })
    value(await t.core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'after the wake' }] }))
    await t.core.power('suspend')
    clock.advance(2 * 60_000)
    await t.core.factory?.settled()
    let v = value(await t.core.invoke('queue.get'))
    expect(v.schedule).toMatchObject({ open: true, waiting: 'sleep' })
    expect(only(v).tasks[0]?.status).toBe('pending')
    await t.core.power('resume')
    v = await waitForQueue(t.core, (x) => only(x).tasks[0]?.status === 'done')
    expect(only(v).scheduled).toBeUndefined()
  }, 300_000)
})
