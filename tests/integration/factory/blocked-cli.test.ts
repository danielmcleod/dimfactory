// A queued run that needs you (a blocking card), and the CLI (no network; the fake Claude):
//   - skip blocked tasks off (the default): the queue waits on the task that needs you; answering it lets the queue go on
//   - skip blocked tasks on: the task is left waiting ("blocked") and the next task starts (its run queues for the
//     folder behind the waiting one); nothing is skipped silently: the blocked task says why
//   - `dimf queue add / list / run / report`: the same queue from the command line, run to the end with exit 0
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import { hermeticEnv } from '../run/scenario.ts'
import { World, only, tasksSpec, value, version, waitForQueue } from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

const GATED = { gates: { afterPlan: true, beforeFix: false } }

describe('a queued run that needs you', () => {
  it('the queue waits for it (skip blocked tasks off); answering it lets the queue go on', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.1')]), GATED)
    const { core } = await world.boot(w)
    value(
      await core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'first' }, { task: 'second' }] }),
    )
    value(await core.invoke('queue.start', {}))
    let v = await waitForQueue(core, (x) => only(x).tasks[0]?.status === 'waiting')
    expect(only(v).tasks[0]?.reason).toMatch(
      /^Run #\d+ waits for you \(a question or a card\)\. Answer it to go on\.$/,
    )
    expect(only(v).state).toBe('running')
    await new Promise((r) => setTimeout(r, 1500))
    expect(only(value(await core.invoke('queue.get'))).tasks[1]?.status).toBe('pending')

    // Approve the plan: the run goes on, and so does the queue.
    const runId = only(v).tasks[0]?.runId ?? ''
    const gate = value(await core.invoke('runs.get', { runId })).cards.find(
      (c) => c.kind === 'gate:afterPlan',
    )
    value(await core.invoke('cards.resolve', { runId, cardId: gate?.id ?? '', choiceId: 'approve' }))
    v = await waitForQueue(core, (x) => only(x).tasks[1]?.status === 'waiting')
    expect(only(v).tasks[0]?.status).toBe('done')
  }, 300_000)

  it('with skip blocked tasks on, the task is left waiting and the next one starts', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.1')]), {
      ...GATED,
      factory: { skipBlocked: true },
    })
    const { core } = await world.boot(w)
    value(
      await core.invoke('queue.add', { folder: w.folder, tasks: [{ task: 'first' }, { task: 'second' }] }),
    )
    value(await core.invoke('queue.start', {}))
    const v = await waitForQueue(
      core,
      (x) => only(x).tasks[0]?.status === 'blocked' && only(x).tasks[1]?.runId !== undefined,
    )
    const [first, second] = only(v).tasks
    expect(first?.reason).toMatch(/waits for you/)
    // The second task's run started; it waits for the folder the first one holds.
    expect(second?.status).toBe('running')
    const s = core.summary(second?.runId ?? '')
    expect(s?.status).toBe('queued')
    expect(s?.blockedBy).toBe(first?.runId)
  }, 300_000)
})

describe('dimf queue', () => {
  it('adds, lists, runs to the end and reports', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.1')]))
    const out: string[] = []
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const run = (args: string[]): Promise<number> => main([...args, '--home', w.home], io)
    expect(await run(['queue', 'add', w.folder, 'first', 'task'])).toBe(0)
    expect(await run(['queue', 'add', w.folder, 'second task'])).toBe(0)
    out.length = 0
    expect(await run(['queue', 'list'])).toBe(0)
    const listed = out.join('\n')
    expect(listed).toContain(`${w.folder}  Not running`)
    expect(listed).toMatch(/ {3}1\. \[Pending\] first task {2}\(t[0-9a-f]{12}\)/)
    expect(listed).toMatch(/ {3}2\. \[Pending\] second task/)
    out.length = 0
    const code = await run(['queue', 'run'])
    const text = out.join('\n')
    expect(code, text).toBe(0)
    expect(text).toMatch(/1\. \[Running\] first task · run #\d+/)
    expect(text).toMatch(
      /1\. \[Done\] first task · run #\d+ · \$\d+\.\d\d|1\. \[Done\] first task · run #\d+ · <\$0\.01/,
    )
    expect(text).toMatch(/2\. \[Done\] second task/)
    out.length = 0
    expect(await run(['queue', 'report'])).toBe(0)
    const report = out.join('\n')
    expect(report).toContain('2 runs (2 from a queue). Done 2, failed 0, stopped 0, still working 0.')
    const file = /Written to (.+)$/m.exec(report)?.[1] ?? ''
    expect(readFileSync(file, 'utf8')).toContain('## Runs')
    expect(report).not.toContain('—')
  }, 300_000)

  it('import-todo adds the open checkbox items once', async () => {
    const w = await world.setup(
      tasksSpec([]),
      {},
      {
        files: {
          'TODO.md':
            '# Todo\n\n- [ ] write the docs\n- [x] done already\n* [ ] add a test\n```\n- [ ] not this\n```\n',
        },
      },
    )
    const out: string[] = []
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    expect(await main(['queue', 'import-todo', w.folder, '--home', w.home], io)).toBe(0)
    expect(out.join('\n')).toContain('Added 2 tasks from TODO.md.')
    out.length = 0
    expect(await main(['queue', 'import-todo', w.folder, '--home', w.home], io)).toBe(0)
    expect(out.join('\n')).toContain('Added 0 tasks from TODO.md; 2 already queued.')
    out.length = 0
    expect(await main(['queue', 'list', '--json', '--home', w.home], io)).toBe(0)
    const v = JSON.parse(out.join('\n')) as { folders: { tasks: { task: string; source: unknown }[] }[] }
    expect(v.folders[0]?.tasks.map((t) => [t.task, t.source])).toEqual([
      ['write the docs', { kind: 'todo', file: 'TODO.md', line: 3 }],
      ['add a test', { kind: 'todo', file: 'TODO.md', line: 5 }],
    ])
  }, 120_000)
})
