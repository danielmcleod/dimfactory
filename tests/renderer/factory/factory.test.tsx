// The factory's renderer: the Queue page (tasks in order with their status, reason, run, cost and branch; move,
// retry, remove, start and pause call the queue commands with what the row shows; adding a task sends the folder,
// the text and the recipe; the GitHub import runs gh only on its clicks, after the check, and a missing gh shows its
// fixes to copy and keeps Import issues disabled; the daily report on demand), the launch notice banner ([Start
// queue] with the notice's folders and id, [Dismiss]), the Dashboard's Queue card, project memory proposals at a
// run's end ([Approve] and [Dismiss]), the quality gates at a run's end and Settings, Factory (each control writes
// one config.patch with the right op). No em dashes anywhere.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { FactorySettings } from '@shared/config-schema.ts'
import type { DailyReportView, FolderQueueView, MemoryView, QueueTask, QueueView } from '@shared/factory.ts'
import { countTasks } from '@shared/factory.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import { QueueNoticeBanner } from '@renderer/app/QueueNoticeBanner.tsx'
import { QualityGates } from '@renderer/components/run/RunEndPanel.tsx'
import { QueueCard } from '@renderer/pages/dashboard/QueueCard.tsx'
import { MemoryPanel } from '@renderer/pages/queue/MemoryPanel.tsx'
import { QueuePage } from '@renderer/pages/queue/QueuePage.tsx'
import { factorySettingsOf, parseLimit } from '@renderer/pages/settings/FactorySection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { resetQueueForTests, setQueueView } from '@renderer/state/queue.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\work\\shop'
const bodyText = (): string => document.body.textContent ?? ''

const task = (over: Partial<QueueTask> & { id: string; title: string }): QueueTask => ({
  task: over.title,
  source: { kind: 'manual' },
  addedAt: 1,
  status: 'pending',
  ...over,
})

const TASKS: QueueTask[] = [
  task({
    id: 't000000000001',
    title: 'Add a --version flag',
    status: 'done',
    runId: 'r1',
    displayNo: 12,
    outcome: 'clean',
    costUsd: 0.42,
    branch: 'dim/2026-version',
  }),
  task({
    id: 't000000000002',
    title: 'Fix the help text',
    status: 'stopped',
    runId: 'r2',
    displayNo: 13,
    costUsd: 1.5,
    category: 'budget_exceeded',
    reason: 'Run #13 cost $1.50, more than the limit of $1.00 per run, so Dim Factory stopped it.',
  }),
  task({ id: 't000000000003', title: 'Write the README', status: 'pending', recipe: 'write-docs' }),
]

function folderView(over: Partial<FolderQueueView> = {}): FolderQueueView {
  const tasks = over.tasks ?? TASKS
  return {
    folder: FOLDER,
    state: 'paused',
    pause: {
      reason: 'run-budget',
      text: 'Run #13 cost $1.50, more than the limit of $1.00 per run, so Dim Factory stopped it. Raise the limit in Settings, Factory, or retry the task with a smaller scope, then resume the queue.',
      at: 5,
    },
    tasks,
    counts: countTasks(tasks),
    consecutiveFailures: 0,
    ...over,
  }
}

function queueView(over: Partial<QueueView> = {}): QueueView {
  return {
    folders: [folderView()],
    limits: {
      auto: false,
      maxCostPerRunUsd: 1,
      maxCostPerDayUsd: 10,
      maxMinutesPerRun: null,
      maxFixRounds: null,
      stopAfterFailures: 3,
      skipBlocked: false,
      isolate: false,
      maxParallel: 2,
    },
    schedule: {
      ...FACTORY_DEFAULTS.schedule,
      days: [...FACTORY_DEFAULTS.schedule.days],
      open: false,
    },
    today: { date: '2026-10-06', spentUsd: 1.92, runs: 2, priced: 2, done: 1, failed: 1 },
    running: 0,
    ...over,
  }
}

function memoryView(over: Partial<MemoryView> = {}): MemoryView {
  return {
    folder: FOLDER,
    file: 'C:\\work\\shop\\DIM_FACTORY.md',
    exists: true,
    bytes: 2048,
    capped: false,
    maxBytes: 16_000,
    enabled: true,
    propose: true,
    autoApply: false,
    pending: [
      {
        id: 'r1',
        runId: 'r1',
        displayNo: 12,
        title: 'Add a --version flag',
        createdAt: 5,
        baseSha256: null,
        diff: '--- a/DIM_FACTORY.md\n+++ b/DIM_FACTORY.md\n@@ -1,1 +1,2 @@\n ## Run notes\n+- 2026-10-06 · Run #12 · Add a --version flag\n',
        added: 1,
        removed: 0,
      },
    ],
    ...over,
  }
}

let mock: MockDimFactory
let view: QueueView

function withoutNotice(v: QueueView): QueueView {
  const { notice: _gone, ...rest } = v
  return rest
}

beforeEach(() => {
  view = queueView()
  resetQueueForTests()
  mock = setUp({
    handlers: {
      'queue.get': () => view,
      'queue.move': () => view,
      'queue.retry': () => view,
      'queue.remove': () => view,
      'queue.start': () => withoutNotice(view),
      'queue.pause': () => view,
      'queue.add': () => view,
      'queue.dismissNotice': () => withoutNotice(view),
      'memory.get': () => memoryView(),
      'memory.apply': () => memoryView({ pending: [] }),
      'memory.dismiss': () => memoryView({ pending: [] }),
      'recipes.list': () => ({ recipes: [], dirs: { user: 'C:\\home\\recipes', project: null }, issues: [] }),
    },
  })
})

afterEach(() => tearDown(mock))

function mountQueue(): void {
  render(
    <Providers>
      <QueuePage />
    </Providers>,
  )
}

describe('the Queue page', () => {
  it('lists each task in order with its status, reason, run, cost and branch, and the pause reason', async () => {
    mountQueue()
    await settle()
    expect(mock.callsOf('queue.get')).toHaveLength(1)
    const rows = screen.getAllByTestId(/^queue-task-t[0-9]{12}$/)
    expect(rows.map((r) => within(r).getByTestId('queue-task-title').textContent)).toEqual([
      'Add a --version flag',
      'Fix the help text',
      'Write the README',
    ])
    expect(within(rows[0]!).getByTestId('queue-task-status').textContent).toBe('Done')
    expect(within(rows[0]!).getByTestId('queue-task-run').getAttribute('href')).toBe('#/runs/r1')
    expect(within(rows[0]!).getByTestId('queue-task-facts').textContent).toContain('Branch dim/2026-version')
    expect(within(rows[1]!).getByTestId('queue-task-status').textContent).toBe('Stopped')
    expect(within(rows[1]!).getByTestId('queue-task-facts').textContent).toContain('Budget reached')
    expect(within(rows[1]!).getByTestId('queue-task-reason').textContent).toContain('per run')
    expect(within(rows[2]!).getByTestId('queue-task-facts').textContent).toContain('Recipe write-docs')
    expect(screen.getByTestId('queue-pause').textContent).toContain('resume the queue')
    expect(screen.getByTestId('queue-state').textContent).toBe('Paused')
    expect(screen.getByTestId('queue-toggle').textContent).toBe('Resume')
    expect(screen.getByTestId('queue-today').textContent).toContain('$1.92 of $10.00')
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('moves, retries, removes, resumes and pauses with what the row shows', async () => {
    mountQueue()
    await settle()
    const rows = screen.getAllByTestId(/^queue-task-t[0-9]{12}$/)
    // The first row cannot move up; a done task cannot be retried; a pending one can be removed.
    expect(within(rows[0]!).getByTestId<HTMLButtonElement>('queue-task-up').disabled).toBe(true)
    expect(within(rows[0]!).getByTestId<HTMLButtonElement>('queue-task-retry').disabled).toBe(true)
    fireEvent.click(within(rows[2]!).getByTestId('queue-task-up'))
    await settle()
    expect(mock.callsOf('queue.move')).toEqual([{ folder: FOLDER, id: 't000000000003', to: 1 }])
    fireEvent.click(within(rows[1]!).getByTestId('queue-task-retry'))
    await settle()
    expect(mock.callsOf('queue.retry')).toEqual([{ folder: FOLDER, id: 't000000000002' }])
    fireEvent.click(within(rows[2]!).getByTestId('queue-task-remove'))
    await settle()
    expect(mock.callsOf('queue.remove')).toEqual([{ folder: FOLDER, id: 't000000000003' }])
    fireEvent.click(screen.getByTestId('queue-toggle'))
    await settle()
    expect(mock.callsOf('queue.start')).toEqual([{ folders: [FOLDER] }])
    // A running queue's button pauses it (same button, same width: every label reserved).
    act(() => setQueueView(queueView({ folders: [folderView({ state: 'running' })] })))
    expect(screen.getByTestId('queue-toggle').textContent).toBe('Pause')
    fireEvent.click(screen.getByTestId('queue-toggle'))
    await settle()
    expect(mock.callsOf('queue.pause')).toEqual([{ folders: [FOLDER] }])
  })

  it('a running task cannot be removed', async () => {
    view = queueView({
      folders: [
        folderView({
          state: 'running',
          tasks: [task({ id: 't000000000009', title: 'Busy', status: 'running', runId: 'r9', displayNo: 9 })],
        }),
      ],
    })
    mountQueue()
    await settle()
    expect(screen.getByTestId<HTMLButtonElement>('queue-task-remove').disabled).toBe(true)
  })

  it('adds a task with the folder, its text and the recipe', async () => {
    mountQueue()
    await settle()
    expect(screen.getByTestId<HTMLButtonElement>('queue-add-button').disabled).toBe(true)
    fireEvent.change(screen.getByTestId('queue-folder-input'), { target: { value: FOLDER } })
    fireEvent.change(screen.getByTestId('queue-task-input'), { target: { value: '  Add a changelog  ' } })
    fireEvent.click(screen.getByTestId('queue-add-button'))
    await settle()
    expect(mock.callsOf('queue.add')).toEqual([{ folder: FOLDER, tasks: [{ task: 'Add a changelog' }] }])
    expect(screen.getByTestId<HTMLTextAreaElement>('queue-task-input').value).toBe('')
  })

  it('imports a TODO file and says what it added', async () => {
    mock.on('queue.importTodo', () => ({ added: 2, skipped: 1, overLimit: 0, from: 'TODO.md' }))
    mountQueue()
    await settle()
    fireEvent.change(screen.getByTestId('queue-folder-input'), { target: { value: FOLDER } })
    fireEvent.click(screen.getByTestId('queue-import-todo'))
    await settle()
    expect(mock.callsOf('queue.importTodo')).toEqual([{ folder: FOLDER }])
    expect(screen.getByTestId('queue-add-note').textContent).toBe(
      'Added 2 tasks from TODO.md; 1 already in the queue.',
    )
  })

  it('runs gh only on the clicks: a missing gh shows its fixes and Import issues stays disabled', async () => {
    mock.on('queue.githubCheck', () => ({
      gh: {
        installed: false,
        authenticated: false,
        problem: 'The GitHub CLI (gh) is not installed.',
        fixes: [
          {
            id: 'gh:install',
            label: 'Install the GitHub CLI',
            command: 'winget install --id GitHub.cli -e',
            shell: 'powershell' as const,
          },
          {
            id: 'gh:login',
            label: 'Sign in to GitHub in a terminal',
            command: 'gh auth login',
            shell: 'powershell' as const,
          },
        ],
      },
    }))
    mountQueue()
    await settle()
    fireEvent.change(screen.getByTestId('queue-folder-input'), { target: { value: FOLDER } })
    await settle()
    expect(mock.callsOf('queue.githubCheck')).toEqual([])
    expect(screen.getByTestId<HTMLButtonElement>('queue-gh-import').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('queue-gh-check'))
    await settle()
    expect(mock.callsOf('queue.githubCheck')).toEqual([{ folder: FOLDER }])
    expect(screen.getByTestId('queue-gh-status').textContent).toBe('The GitHub CLI (gh) is not installed.')
    expect(screen.getAllByTestId('queue-gh-fixes-command').map((c) => c.textContent)).toEqual([
      'winget install --id GitHub.cli -e',
      'gh auth login',
    ])
    expect(screen.getByTestId<HTMLButtonElement>('queue-gh-import').disabled).toBe(true)
    expect(mock.callsOf('queue.importGithub')).toEqual([])
  })

  it('imports the issues on the click once gh is ready', async () => {
    mock.on('queue.githubCheck', () => ({
      gh: { installed: true, version: '2.99.0', authenticated: true, fixes: [] },
    }))
    mock.on('queue.importGithub', () => ({
      added: 3,
      skipped: 0,
      overLimit: 0,
      from: 'the open GitHub issues of shop',
    }))
    mountQueue()
    await settle()
    fireEvent.change(screen.getByTestId('queue-folder-input'), { target: { value: FOLDER } })
    fireEvent.click(screen.getByTestId('queue-gh-check'))
    await settle()
    expect(screen.getByTestId('queue-gh-status').textContent).toBe(
      'The GitHub CLI 2.99.0 is installed and signed in.',
    )
    expect(mock.callsOf('queue.importGithub')).toEqual([])
    fireEvent.click(screen.getByTestId('queue-gh-import'))
    await settle()
    expect(mock.callsOf('queue.importGithub')).toEqual([{ folder: FOLDER }])
    expect(screen.getByTestId('queue-add-note').textContent).toBe(
      'Added 3 tasks from the open GitHub issues of shop.',
    )
  })

  it("shows the day's report on demand, with the file it was written to", async () => {
    const report: DailyReportView = {
      date: '2026-10-06',
      runs: [
        {
          runId: 'r1',
          displayNo: 12,
          folder: FOLDER,
          title: 'Add a --version flag',
          status: 'completed',
          outcome: 'clean',
          costUsd: 0.42,
          createdAt: 1,
          queued: true,
        },
      ],
      spentUsd: 0.42,
      unpriced: 0,
      outcomes: { done: 1, failed: 0, stopped: 0, working: 0 },
      pauses: [{ at: 2, folder: FOLDER, text: 'You paused the queue.' }],
      fallbacks: [],
      file: 'C:\\home\\reports\\2026-10-06.md',
      markdown: '# report\n',
    }
    mock.on('queue.report', () => report)
    mountQueue()
    await settle()
    expect(mock.callsOf('queue.report')).toEqual([])
    fireEvent.click(screen.getByTestId('queue-report-load'))
    await settle()
    expect(mock.callsOf('queue.report')).toEqual([{}])
    expect(screen.getByTestId('queue-report-runs').textContent).toContain('Run #12')
    expect(screen.getByTestId('queue-report-pauses').textContent).toContain('You paused the queue.')
    expect(screen.getByTestId('queue-report-file').textContent).toBe('C:\\home\\reports\\2026-10-06.md')
  })

  it("approves the folder's pending memory update", async () => {
    mountQueue()
    await settle()
    const panel = screen.getByTestId('queue-memory')
    expect(within(panel).getByTestId('queue-memory-file').textContent).toContain('goes to every pass')
    expect(within(panel).getByTestId('memory-diff').textContent).toContain('+- 2026-10-06 · Run #12')
    fireEvent.click(within(panel).getByTestId('memory-approve'))
    await settle()
    expect(mock.callsOf('memory.apply')).toEqual([{ folder: FOLDER, id: 'r1' }])
    expect(within(panel).queryByTestId('memory-proposal-r1')).toBeNull()
  })
})

describe('the launch notice', () => {
  it('starts the queues it names with its id, or is dismissed', async () => {
    view = queueView({
      notice: {
        id: 'n1',
        kind: 'schedule-due',
        at: 1,
        text: 'The schedule was due at 22:00 while Dim Factory was closed. Start the queue now? Nothing runs until you do.',
        folders: [FOLDER],
      },
    })
    render(
      <Providers>
        <QueueNoticeBanner />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('queue-notice-text').textContent).toContain('Nothing runs until you do.')
    expect(mock.callsOf('queue.start')).toEqual([])
    fireEvent.click(screen.getByTestId('queue-notice-start'))
    await settle()
    expect(mock.callsOf('queue.start')).toEqual([{ folders: [FOLDER], noticeId: 'n1' }])
    expect(screen.queryByTestId('queue-notice')).toBeNull()
    expect(window.location.hash).toBe('#/queue')
  })

  it('Dismiss answers queue.dismissNotice and starts nothing', async () => {
    view = queueView({
      notice: { id: 'n2', kind: 'schedule-due', at: 1, text: 'Due.', folders: [FOLDER] },
    })
    render(
      <Providers>
        <QueueNoticeBanner />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('queue-notice-dismiss'))
    await settle()
    expect(mock.callsOf('queue.dismissNotice')).toEqual([{ id: 'n2' }])
    expect(mock.callsOf('queue.start')).toEqual([])
    expect(screen.queryByTestId('queue-notice')).toBeNull()
  })
})

describe("the Dashboard's Queue card", () => {
  it('is there from the start, then says how the queues are and what today cost', () => {
    render(
      <Providers>
        <QueueCard />
      </Providers>,
    )
    expect(screen.getByTestId('queue-card-state').textContent).toBe('')
    act(() => setQueueView(queueView()))
    expect(screen.getByTestId('queue-card-state').textContent).toContain(
      'A queue is paused: Run #13 cost $1.50',
    )
    expect(screen.getByTestId('queue-card-counts').textContent).toBe(
      '1 pending, 0 running, 0 need you, 1 done, 1 failed or stopped.',
    )
    expect(screen.getByTestId('queue-card-spend').textContent).toBe('Today $1.92 of $10.00.')
    expect(screen.getByTestId('queue-card-open').getAttribute('href')).toBe('#/queue')
  })
})

describe("a run's end", () => {
  it("shows the run's memory update only, approves or dismisses it", async () => {
    render(
      <Providers>
        <MemoryPanel folder={FOLDER} runId="r1" testId="run-end-memory" />
        <MemoryPanel folder={FOLDER} runId="r7" testId="other-memory" />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('other-memory')).toBeNull()
    const panel = screen.getByTestId('run-end-memory')
    expect(within(panel).getByTestId('memory-diff').textContent).toContain('Run #12')
    fireEvent.click(within(panel).getByTestId('memory-dismiss'))
    await settle()
    expect(mock.callsOf('memory.dismiss')).toEqual([{ folder: FOLDER, id: 'r1' }])
    expect(screen.queryByTestId('run-end-memory')).toBeNull()
    expect(mock.callsOf('memory.apply')).toEqual([])
  })

  it('names each quality gate that did not pass, with its reason', () => {
    render(
      <QualityGates
        gates={{
          passed: ['lint'],
          failed: [
            { name: 'test', reason: 'It failed.' },
            { name: 'security', reason: 'The security review is off for this run.' },
          ],
        }}
      />,
    )
    expect(screen.getByTestId('run-end-gates-failed').textContent).toBe(
      'test: It failed.security: The security review is off for this run.',
    )
    expect(screen.getByTestId('run-end-gates').textContent).toContain('passed: lint')
    expect(bodyText()).not.toContain(EM_DASH)
  })
})

describe('Settings, Factory', () => {
  const resolved = (factory: Partial<FactorySettings> = {}): ResolvedWithProvenance =>
    ({
      config: {
        profile: 'balanced',
        factory: { ...FACTORY_DEFAULTS, ...factory },
        fallback: { enabled: false, vendors: [] },
        memory: { enabled: true, propose: true, autoApply: false, maxBytes: 16_000 },
        quality: { enabled: false, verify: [], security: false, acceptance: false },
        routing: { research: { model: 'haiku' } },
        verify: { enabled: true, commands: [{ name: 'test', run: 'pnpm test' }] },
      },
      provenance: {},
      issues: [],
      layers: {
        user: { scope: 'user', path: 'C:\\home\\dimfactory.json', exists: true, sha256: null, valid: true },
      },
      scopeRoot: null,
      folderKey: null,
    }) as unknown as ResolvedWithProvenance

  beforeEach(() => {
    mock.on('config.resolve', () => resolved({ maxCostPerRunUsd: 2 }))
    mock.on('config.patch', () => ({ changed: true, backupId: null }) as never)
  })

  const mountFactory = async (): Promise<void> => {
    render(
      <Providers>
        <SettingsPage section="factory" />
      </Providers>,
    )
    await settle(SECTION_LOAD_DELAY_MS)
    await settle()
  }

  it('reads the values core resolved and writes one patch per change', async () => {
    await mountFactory()
    expect(screen.getByTestId<HTMLInputElement>('setting-/factory/maxCostPerRunUsd').value).toBe('2')
    expect(screen.getByTestId<HTMLInputElement>('setting-routing-research').value).toBe('haiku')
    fireEvent.click(screen.getByTestId('setting-/factory/auto'))
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/factory/auto', value: true }] },
    ])
    const day = screen.getByTestId('setting-/factory/maxCostPerDayUsd')
    fireEvent.change(day, { target: { value: '5' } })
    fireEvent.keyDown(day, { key: 'Enter' })
    await settle()
    expect(mock.callsOf('config.patch')[1]).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/factory/maxCostPerDayUsd', value: 5 }],
    })
    // An empty box clears a limit.
    const run = screen.getByTestId('setting-/factory/maxCostPerRunUsd')
    fireEvent.change(run, { target: { value: '' } })
    fireEvent.keyDown(run, { key: 'Enter' })
    await settle()
    expect(mock.callsOf('config.patch')[2]).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/factory/maxCostPerRunUsd', value: null }],
    })
    // Routing goes to the profile in use; an empty box removes the route.
    const research = screen.getByTestId('setting-routing-research')
    fireEvent.change(research, { target: { value: '' } })
    fireEvent.keyDown(research, { key: 'Enter' })
    await settle()
    expect(mock.callsOf('config.patch')[3]).toEqual({
      scope: 'user',
      ops: [{ op: 'remove', path: '/profiles/balanced/routing/research/model' }],
    })
    expect(bodyText()).toContain('not available yet')
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('refuses a limit that is not a number, and resume automatically is off by default', async () => {
    await mountFactory()
    const box = screen.getByTestId('setting-/factory/maxMinutesPerRun')
    fireEvent.change(box, { target: { value: 'soon' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([])
    expect(screen.getByTestId('factory-error').textContent).toContain('Most time per run')
    expect(
      screen.getByTestId('setting-/factory/schedule/resumeAutomatically').getAttribute('aria-checked'),
    ).toBe('false')
    // Quality gates are a project's: without one they are disabled.
    expect(screen.getByTestId<HTMLButtonElement>('setting-/quality/enabled').disabled).toBe(true)
  })

  it('pure helpers', () => {
    expect(parseLimit('')).toBeNull()
    expect(parseLimit('$2.5')).toBe(2.5)
    expect(parseLimit('0')).toBeUndefined()
    expect(parseLimit('2.5', { int: true, min: 1 })).toBeUndefined()
    const s = factorySettingsOf(resolved().config, { '/factory/isolate': true })
    expect(s?.factory.isolate).toBe(true)
    expect(s?.verifyNames).toEqual(['test'])
  })
})
