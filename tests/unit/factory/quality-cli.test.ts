// run.quality's answer (preflight/checks/run.ts qualityResult), and `dimf queue`'s lines and usage errors.
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { qualityResult } from '@core/preflight/checks/run.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { FolderQueueView, QueueView } from '@shared/factory.ts'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import { queueLines, viewLines } from '../../../src/cli/commands/queue.ts'

function cfg(o: {
  quality?: Partial<ResolvedConfig['quality']>
  verify?: boolean
  commands?: string[]
  security?: boolean
  acceptance?: boolean
}): ResolvedConfig {
  const c = resolveBuiltinConfig({ profile: 'claude-only' })
  return {
    ...c,
    quality: { enabled: true, verify: [], security: false, acceptance: false, ...o.quality },
    verify: {
      ...c.verify,
      enabled: o.verify ?? true,
      commands: (o.commands ?? ['test']).map((name) => ({ name, run: ['npm', 'run', name] })),
    },
    passes: {
      ...c.passes,
      security: { ...c.passes.security, enabled: o.security ?? false },
      review: { ...c.passes.review, acceptance: o.acceptance ?? false },
    },
  }
}

describe('run.quality', () => {
  it('no gates, or gates off', () => {
    expect(qualityResult(undefined)).toEqual({ status: 'pass', detail: 'No quality gates.' })
    expect(qualityResult(cfg({ quality: { enabled: false, verify: ['x'] } }))).toEqual({
      status: 'pass',
      detail: 'No quality gates.',
    })
  })

  it('what the run must pass, when it can', () => {
    expect(
      qualityResult(
        cfg({
          quality: { verify: ['test'], security: true, acceptance: true },
          security: true,
          acceptance: true,
        }),
      ),
    ).toEqual({ status: 'pass', detail: 'To count as done the run must pass: test, security, acceptance.' })
    expect(qualityResult(cfg({}))).toEqual({
      status: 'pass',
      detail: 'Quality gates are on, but none is required.',
    })
  })

  it('a warning naming every required check this run cannot pass, with the way to Settings', () => {
    const r = qualityResult(cfg({ quality: { verify: ['test', 'lint'], security: true, acceptance: true } }))
    expect(r).toMatchObject({ status: 'warn', title: 'The run cannot pass its quality gates as set up' })
    expect(r.detail).toBe(
      '"lint" is required, but no enabled verify command has that name. The security review is required, but it is off for this run. The acceptance review is required, but it is off for this run. The run completes with failures unless every required check passes.',
    )
    expect(r.recovery).toEqual([
      expect.objectContaining({ kind: 'settings_link', route: 'settings/factory', pointer: '/quality' }),
    ])
    expect(qualityResult(cfg({ quality: { verify: ['test'] }, verify: false })).detail).toContain(
      '"test" is required, but Verify is off.',
    )
    expect(r.detail).not.toContain('\u2014')
  })
})

const folder: FolderQueueView = {
  folder: '/work/shop',
  state: 'paused',
  pause: { reason: 'run-budget', text: 'Run #3 cost $2.00, more than the limit.', at: 1 },
  tasks: [
    {
      id: 't000000000001',
      task: 'one',
      title: 'one',
      source: { kind: 'manual' },
      addedAt: 1,
      status: 'stopped',
      runId: 'r3',
      displayNo: 3,
      costUsd: 2,
      category: 'budget_exceeded',
      reason: 'Run #3 cost $2.00, more than the limit.',
    },
    {
      id: 't000000000002',
      task: 'two',
      title: 'two',
      recipe: 'bug-fix',
      source: { kind: 'manual' },
      addedAt: 1,
      status: 'pending',
    },
  ],
  counts: { pending: 1, running: 0, waiting: 0, done: 0, failed: 0, stopped: 1 },
  consecutiveFailures: 0,
  estimateUsd: 0.004,
}

describe('dimf queue lines', () => {
  it('a queue: its state and pause, then each task', () => {
    expect(queueLines(folder)).toEqual([
      '/work/shop  Paused',
      '  Run #3 cost $2.00, more than the limit.',
      '   1. [Stopped] one · run #3 · $2.00 · Budget reached  (t000000000001)\n      Run #3 cost $2.00, more than the limit.',
      '   2. [Pending] two · recipe bug-fix  (t000000000002)',
      '  Pending tasks: about <$0.01 (estimate).',
    ])
  })

  it('the view: the notice, the queues and today', () => {
    const v: QueueView = {
      folders: [folder],
      limits: { ...FACTORY_DEFAULTS, maxCostPerDayUsd: 10 },
      schedule: { ...FACTORY_DEFAULTS.schedule, days: [...FACTORY_DEFAULTS.schedule.days], open: false },
      today: { date: '2026-10-24', spentUsd: 2, runs: 1, priced: 1, done: 0, failed: 1 },
      running: 0,
      notice: {
        id: 'n',
        kind: 'schedule-due',
        at: 1,
        text: 'The schedule was due.',
        folders: ['/work/shop'],
      },
    }
    const lines = viewLines(v)
    expect(lines[0]).toBe('Notice: The schedule was due.')
    expect(lines.at(-1)).toBe('Today: $2.00 spent over 1 run (budget $10.00).')
    expect(viewLines({ ...v, folders: [] }, '/nowhere')).toContain('No queue for /nowhere.')
    expect(viewLines({ ...v, folders: [], limits: FACTORY_DEFAULTS }).at(-1)).toBe(
      'Today: $2.00 spent over 1 run (no daily budget).',
    )
    for (const l of lines) expect(l).not.toContain('\u2014')
  })
})

describe('dimf queue usage errors (exit 2)', () => {
  const run = async (args: string[]): Promise<{ code: number; text: string }> => {
    const out: string[] = []
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const code = await main(['queue', ...args], io)
    return { code, text: out.join('\n') }
  }

  it.each([
    [['frobnicate'], 'unknown subcommand "frobnicate"'],
    [['add', '/x'], 'add needs <folder> <task>'],
    [['remove', '/x'], 'remove needs <folder> <task-id>'],
    [['retry'], 'retry needs <folder> <task-id>'],
    [['move', '/x', 't1'], 'move needs <folder> <task-id> <position>'],
    [['import-todo'], 'import-todo needs <folder>'],
    [['list', '--nope'], "Unknown option '--nope'"],
  ])('%j', async (args, message) => {
    const r = await run(args)
    expect(r.code).toBe(2)
    expect(r.text).toContain(message)
    expect(r.text).toContain('usage: dimf queue')
  })
})
