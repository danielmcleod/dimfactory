// Beginners, part B on the mock bridge: the summary's "Things to fill in" in its own section (splitFillIns); a run that
// did not finish says why in one plain line (signed out, a usage limit with when it resets), with the sign-in command
// and the recovery core armed from its snag, and Carry on; Make a change says about what it costs before the click and,
// for a report from data, takes a new data file; the project history with "Go back to before this"; the confirm screen
// for a report from data with no file, and the setup steps when nobody can do the work; the folder screen with unsaved
// changes; the overnight list's warnings and estimates; a preflight card in plain words; and the upload file leaving a
// report's data files out unless they are included. Buttons keep their labels; no em dashes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeployUploadResult } from '@shared/deploy.ts'
import type {
  EasyAttachment,
  EasyChangeEstimate,
  EasyFolderView,
  EasyProjectView,
  EasyQueueView,
  EasyResolved,
  EasyState,
} from '@shared/easy.ts'
import type { CardView, RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot, upsertSummaries } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { UploadFile } from '@renderer/components/deploy/UploadFile.tsx'
import { DATA_INCLUDED, INCLUDE_DATA, dataLeftOutText } from '@renderer/components/deploy/text.ts'
import { PlainCard } from '@renderer/pages/easy/EasyCards.tsx'
import { EasyExistingPage } from '@renderer/pages/easy/EasyExisting.tsx'
import { EasyHistory } from '@renderer/pages/easy/EasyHistory.tsx'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { EasyOvernightPage } from '@renderer/pages/easy/EasyOvernight.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { splitFillIns } from '@renderer/pages/easy/model.ts'
import {
  FAILED_TEXT,
  FILL_IN_TITLE,
  HISTORY_BACK,
  NO_DATA_FILE,
  PREFLIGHT_PLAIN,
  SETUP_CHECK,
  SETUP_STILL,
  SHARE_DATA,
  SHOW_PROBLEM,
  TWO_CHANGE_ON_LINE,
  TWO_OFF_LINE,
  changeEstimateText,
  clockText,
  failureText,
  overnightEstimateText,
  overnightTotalText,
  overnightWarningText,
  preflightText,
  setupCommands,
  uncommittedText,
  PLAN_MUTATED_KEEP,
  PLAN_MUTATED_REVERT,
  WAITING_FOR_YOU_TIME,
  planMutatedBodyText,
} from '@renderer/pages/easy/text.ts'
import { env, makeSnapshot, makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { failure, loginAction, retryAction } from '../self-heal/fixtures.ts'
import { eventsHandler } from '../run/helpers.tsx'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const ROOT = 'C:\\Users\\me\\Dim Factory Projects'
const FOLDER = `${ROOT}\\sales-report`

const STATE: EasyState = {
  experience: 'easy',
  askWelcome: false,
  settings: {
    projectsDir: null,
    maxCostUsd: null,
    changeMaxCostUsd: null,
    maxMinutes: null,
    skipPlanCheck: false,
  },
  projectsDir: ROOT,
  defaultProjectsDir: ROOT,
}

const DATA_PROJECT: EasyProjectView = {
  folder: FOLDER,
  name: 'sales-report',
  title: 'Sales report from my spreadsheet',
  kind: 'data',
  idea: 'A report of my sales by month',
  lastRunId: 'r1',
  lastDisplayNo: 1,
  lastStatus: 'completed',
  updatedAt: 1,
  runs: 1,
}

const CSV: EasyAttachment = {
  path: 'C:\\Users\\me\\Documents\\sales-2026.csv',
  name: 'sales-2026.csv',
  bytes: 12_000,
  folder: false,
  dest: 'data',
}

const SUMMARY = [
  '## What was built',
  'A one-page report of your sales by month.',
  '',
  '## Things to fill in',
  '- **Your company name** at the top of the page',
  '- The month the year starts in',
  '',
  '## How to use it',
  'Press Open it.',
].join('\n')

const SUMMARY_NOTHING = [
  '## What was built',
  'A one-page report of your sales by month.',
  '',
  '## Things to fill in',
  '- Nothing to fill in.',
].join('\n')

let mock: MockDimFactory
let summary = SUMMARY
let log: RunEnvelope[] = []

beforeEach(() => {
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  clearOutputCache()
  summary = SUMMARY
  log = []
  window.location.hash = '#/easy'
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [],
      'easy.permission': () => ({ folder: FOLDER, at: 1, uses: 0, granted: false, runUses: 0 }),
      'easy.change': () => ({ runId: 'r10', displayNo: 10, folder: FOLDER }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'runs.output': () => ({ text: summary, mtime: 1, version: 1 }),
      'runs.events': eventsHandler(() => log),
      'memory.get': () => ({
        folder: FOLDER,
        file: `${FOLDER}\\DIMFACTORY.md`,
        exists: false,
        bytes: 0,
        capped: false,
        maxBytes: 16_000,
        enabled: true,
        propose: true,
        autoApply: false,
        pending: [],
      }),
      'dialog.pickFiles': () => [CSV.path],
      'easy.attachCheck': () => [CSV],
      'diff.revert': () => ({ undoToken: 'u1', restored: ['index.html'], deleted: [], skipped: [] }),
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

function showRun(s: RunSnapshot): void {
  mock.on('runs.get', () => s)
  act(() => {
    applySnapshot(s)
  })
  render(
    <Providers>
      <EasyRunPage runId={s.summary.runId} />
    </Providers>,
  )
}

/** A finished run in FOLDER whose Explain wrote the summary. */
function showDone(edit?: (s: RunSnapshot) => void): void {
  const s = makeSnapshot({
    runId: 'r1',
    folder: FOLDER,
    createdAt: Date.now(),
    status: 'completed',
    phase: 'done',
    outcome: 'clean',
  })
  s.steps.explain = { ...s.steps.explain, status: 'done', attempt: 1 }
  edit?.(s)
  showRun(s)
}

describe('splitFillIns', () => {
  it('takes the Things to fill in items out of the summary, bold markers stripped', () => {
    const { rest, fillIns } = splitFillIns(SUMMARY)
    expect(fillIns).toEqual(['Your company name at the top of the page', 'The month the year starts in'])
    expect(rest).not.toContain('Things to fill in')
    expect(rest).toContain('## What was built')
    expect(rest).toContain('## How to use it')
    expect(rest).toContain('Press Open it.')
  })

  it('"Nothing to fill in." gives no items; no section gives null and the summary as it was', () => {
    expect(splitFillIns(SUMMARY_NOTHING)).toEqual({
      rest: '## What was built\nA one-page report of your sales by month.',
      fillIns: [],
    })
    const plain = '## What was built\nA page.'
    expect(splitFillIns(plain)).toEqual({ rest: plain, fillIns: null })
  })
})

describe("the Done screen's Things to fill in and Share it", () => {
  it('lists the things to fill in in their own section; How to use no longer has that heading', async () => {
    showDone()
    await settle()
    const section = screen.getByTestId('easy-done-fill-ins')
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe(FILL_IN_TITLE)
    const items = within(screen.getByTestId('easy-fill-ins'))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(items).toEqual(['Your company name at the top of the page', 'The month the year starts in'])
    const how = screen.getByTestId('easy-explain-text').textContent ?? ''
    expect(how).toContain('A one-page report of your sales by month.')
    expect(how).not.toContain(FILL_IN_TITLE)
    expect(how).not.toContain('Your company name')
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })

  it('"Nothing to fill in." leaves the section out', async () => {
    summary = SUMMARY_NOTHING
    showDone()
    await settle()
    expect(screen.getByTestId('easy-explain-text').textContent).toContain('A one-page report')
    expect(screen.queryByTestId('easy-done-fill-ins')).toBeNull()
  })

  it("a report from data's Share it says who can see its figures", async () => {
    mock.on('easy.projects', () => [DATA_PROJECT])
    showDone()
    await settle()
    expect(screen.getByTestId('easy-share-data').textContent).toBe(SHARE_DATA)
  })

  it('a project that is not a report from data has no data line', async () => {
    showDone()
    await settle()
    expect(screen.getByTestId('easy-done-share')).toBeTruthy()
    expect(screen.queryByTestId('easy-share-data')).toBeNull()
  })
})

describe('a run that did not finish', () => {
  function showFailed(category: string, resetsAt?: number): void {
    const f = failure({ category: category as never, ...(resetsAt !== undefined ? { resetsAt } : {}) })
    const s = makeSnapshot({
      runId: 'r1',
      folder: FOLDER,
      createdAt: Date.now(),
      status: 'failed',
      phase: 'done',
      failure: { step: 'implement', category: category as never },
    })
    s.steps.implement = {
      ...s.steps.implement,
      status: 'failed',
      attempt: 1,
      vendor: 'claude',
      failure: f,
      reason: category,
    }
    showRun(s)
  }

  it('signed out: the plain line, the sign-in command and one recovery button from the snag', async () => {
    log = [
      env('r1', 1, {
        t: 'snag',
        step: 'implement',
        failure: failure({ category: 'auth_required' }),
        actions: [loginAction, retryAction],
      }),
    ]
    showFailed('auth_required')
    await settle()
    const failed = screen.getByTestId('easy-failed')
    expect(failed.getAttribute('data-category')).toBe('auth_required')
    const line = screen.getByTestId('easy-failure-line').textContent
    expect(line).toBe(failureText('auth_required', 'claude'))
    expect(line).toContain('You are signed out of Claude.')
    expect(screen.getByTestId('easy-sign-in').textContent).toContain('claude auth login')
    const recovery = within(screen.getByTestId('easy-failed-actions'))
      .getAllByRole('button')
      .filter((b) => (b.getAttribute('data-testid') ?? '').startsWith('recovery-'))
    expect(recovery).toHaveLength(1)
    expect(recovery[0]?.getAttribute('data-testid')).toBe(`recovery-${retryAction.id}`)
    expect(recovery[0]?.getAttribute('data-kind')).toBe('retry')
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })

  it('a usage limit says when it resets', async () => {
    const at = Date.now() + 60 * 60_000
    showFailed('rate_limited', at)
    await settle()
    expect(screen.getByTestId('easy-failed').getAttribute('data-category')).toBe('rate_limited')
    const line = screen.getByTestId('easy-failure-line').textContent
    expect(line).toBe(failureText('rate_limited', 'claude', at))
    expect(line).toContain(clockText(at))
    expect(screen.queryByTestId('easy-sign-in')).toBeNull()
  })

  it('a run that stopped at Plan built nothing: no Open it or Save as PDF, only Show the files and Show details', async () => {
    const s = makeSnapshot({
      runId: 'r1',
      folder: FOLDER,
      createdAt: Date.now(),
      status: 'failed',
      phase: 'done',
      failure: { step: 'plan', category: 'unknown' },
    })
    s.steps.plan = { ...s.steps.plan, status: 'failed', attempt: 1, vendor: 'claude', reason: 'unknown' }
    expect(s.steps.implement.attempt).toBe(0)
    expect(s.summary.progress.filesChanged).toBe(0)
    showRun(s)
    await settle()
    expect(screen.getByTestId('easy-failed')).toBeTruthy()
    for (const id of [
      'easy-open-it',
      'easy-save-pdf',
      'easy-play-it',
      'easy-open-browser',
      'easy-phone-size',
    ])
      expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.getByTestId('easy-show-files')).toBeTruthy()
    expect(screen.getByTestId('easy-show-details')).toBeTruthy()
  })

  it('a run that failed after Implement keeps Open it', async () => {
    showFailed('unknown')
    await settle()
    expect(screen.getByTestId('easy-open-it')).toBeTruthy()
  })

  it('an unknown failure: the general line; Carry on continues the run in the same folder', async () => {
    showFailed('unknown')
    await settle()
    expect(screen.getByTestId('easy-failure-line').textContent).toBe(FAILED_TEXT)
    fireEvent.click(screen.getByTestId('easy-carry-on'))
    await settle()
    expect(mock.callsOf('easy.change')).toEqual([
      { folder: FOLDER, continueRunId: 'r1', limits: { maxCostUsd: null, maxMinutes: null } },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r10')
  })

  it('the change can be made twice: the choice says what that means, and Make the change opens both versions', async () => {
    mock.on('easy.changeEstimate', () => ({ estimate: null, small: true, security: 'scan' }))
    mock.on('easy.change', (req: { two?: boolean }) => ({
      runId: 'r10',
      displayNo: 10,
      folder: FOLDER,
      ...(req.two === true ? { matchId: 'm7' } : {}),
    }))
    showDone()
    await settle()
    // There from the first frame, whatever the folder is: nothing arrives late.
    const choice = screen.getByTestId('easy-change-two-choice')
    const [one, two] = within(choice).getAllByRole('radio')
    expect(one?.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('easy-change-two-line').textContent).toBe(TWO_OFF_LINE)
    fireEvent.click(two as HTMLElement)
    expect(two?.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('easy-change-two-line').textContent).toBe(TWO_CHANGE_ON_LINE)
    expect(TWO_CHANGE_ON_LINE).toContain('twice as much')
    expect(TWO_CHANGE_ON_LINE).not.toContain(String.fromCodePoint(0x2014))
    fireEvent.change(screen.getByTestId('easy-change-text'), { target: { value: 'Bigger buttons' } })
    fireEvent.click(screen.getByTestId('easy-make-change'))
    await settle()
    expect(mock.callsOf('easy.change')).toEqual([
      {
        folder: FOLDER,
        change: 'Bigger buttons',
        limits: { maxCostUsd: null, maxMinutes: null },
        two: true,
      },
    ])
    expect(window.location.hash).toBe('#/easy/two/m7')
  })

  it('"It is not working" with two chosen tries the fix twice as well', async () => {
    mock.on('easy.changeEstimate', () => ({ estimate: null, small: false, security: 'scan' }))
    mock.on('easy.change', () => ({ runId: 'r10', displayNo: 10, folder: FOLDER, matchId: 'm8' }))
    showDone()
    await settle()
    fireEvent.click(
      within(screen.getByTestId('easy-change-two-choice')).getAllByRole('radio')[1] as HTMLElement,
    )
    fireEvent.change(screen.getByTestId('easy-change-text'), { target: { value: 'The total is wrong' } })
    fireEvent.click(screen.getByTestId('easy-not-working'))
    await settle()
    expect(mock.callsOf('easy.change')[0]).toMatchObject({ notWorking: true, two: true })
    expect(window.location.hash).toBe('#/easy/two/m8')
  })
})

describe('Make a change', () => {
  it('says about what the change costs a moment after typing stops', async () => {
    const answer: EasyChangeEstimate = {
      estimate: { durationMs: { p50: 120_000, p80: 300_000 }, costUsd: { p50: 0.2, p80: 0.4 } },
      small: true,
      security: 'scan',
    }
    mock.on('easy.changeEstimate', () => answer)
    showDone()
    await settle()
    const line = screen.getByTestId('easy-change-estimate')
    expect(line.textContent).toBe('')
    expect(screen.queryByTestId('easy-change-add-files')).toBeNull()
    fireEvent.change(screen.getByTestId('easy-change-text'), { target: { value: 'Make the title bigger' } })
    await settle(500)
    expect(mock.callsOf('easy.changeEstimate')).toEqual([])
    await settle(200)
    expect(mock.callsOf('easy.changeEstimate')).toEqual([{ folder: FOLDER, change: 'Make the title bigger' }])
    const text = changeEstimateText(
      answer.estimate?.durationMs ?? null,
      answer.estimate?.costUsd ?? null,
      true,
      false,
    )
    expect(screen.getByTestId('easy-change-estimate').textContent).toBe(text)
    expect(text).toContain('A small change, so it uses a lighter model.')
  })

  it('a change that touches keys gets the full security check', async () => {
    mock.on('easy.changeEstimate', () => ({ estimate: null, small: false, security: 'full' }))
    showDone()
    await settle()
    fireEvent.change(screen.getByTestId('easy-change-text'), {
      target: { value: 'Add a login with a password' },
    })
    await settle(700)
    const text = changeEstimateText(null, null, false, true)
    expect(screen.getByTestId('easy-change-estimate').textContent).toBe(text)
    expect(text).toContain('full security check')
  })

  it('a report from data takes a new data file, sent with the change', async () => {
    mock.on('easy.projects', () => [DATA_PROJECT])
    mock.on('easy.changeEstimate', () => ({ estimate: null, small: true, security: 'scan' }))
    showDone()
    await settle()
    expect(screen.queryAllByTestId('easy-change-file')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('easy-change-add-files'))
    await settle()
    expect(mock.callsOf('dialog.pickFiles')).toEqual([{}])
    expect(mock.callsOf('easy.attachCheck')).toEqual([{ paths: [CSV.path] }])
    const rows = screen.getAllByTestId('easy-change-file')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain(CSV.name)
    fireEvent.change(screen.getByTestId('easy-change-text'), { target: { value: 'Use my new numbers' } })
    fireEvent.click(screen.getByTestId('easy-make-change'))
    await settle()
    expect(mock.callsOf('easy.change')).toEqual([
      {
        folder: FOLDER,
        change: 'Use my new numbers',
        limits: { maxCostUsd: null, maxMinutes: null },
        attachments: [CSV.path],
      },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r10')
  })
})

describe('the project history', () => {
  const KEY = 'feedfacefeedface'

  it('is on the Done screen with the run itself', async () => {
    showDone()
    await settle()
    const history = screen.getByTestId('easy-done-history')
    expect(
      within(history)
        .getAllByTestId('easy-history-row')
        .map((r) => r.getAttribute('data-run-id')),
    ).toEqual(['r1'])
  })

  it('lists every run in the folder, newest first; Go back to before this reverts that run', async () => {
    act(() => {
      upsertSummaries([
        makeSummary({
          runId: 'a1',
          displayNo: 1,
          folderKey: KEY,
          status: 'completed',
          createdAt: 1_000,
          progress: { tokens: 0, costUsd: null, filesChanged: 3 },
        }),
        makeSummary({
          runId: 'a3',
          displayNo: 3,
          folderKey: KEY,
          status: 'completed',
          createdAt: 3_000,
          progress: { tokens: 0, costUsd: null, filesChanged: 0 },
        }),
        makeSummary({
          runId: 'a2',
          displayNo: 2,
          folderKey: KEY,
          status: 'completed',
          createdAt: 2_000,
          isolation: 'worktree',
          progress: { tokens: 0, costUsd: null, filesChanged: 2 },
        }),
        makeSummary({ runId: 'other', folderKey: '0000000000000000', status: 'completed', createdAt: 4_000 }),
      ])
    })
    render(
      <Providers>
        <EasyHistory folderKey={KEY} />
      </Providers>,
    )
    await settle()
    const rows = within(screen.getByTestId('easy-done-history')).getAllByTestId('easy-history-row')
    expect(rows.map((r) => r.getAttribute('data-run-id'))).toEqual(['a3', 'a2', 'a1'])
    const back = (row: HTMLElement): HTMLElement => within(row).getByTestId('easy-history-back')
    const [a3, a2, a1] = rows as [HTMLElement, HTMLElement, HTMLElement]
    expect(back(a3).hasAttribute('disabled')).toBe(true)
    expect(back(a2).hasAttribute('disabled')).toBe(true)
    expect(back(a1).hasAttribute('disabled')).toBe(false)
    expect(back(a1).textContent).toBe(HISTORY_BACK)
    fireEvent.click(back(a1))
    await settle()
    expect(mock.callsOf('diff.revert')).toEqual([{ runId: 'a1', paths: 'all' }])
  })
})

describe('the confirm screen', () => {
  const DATA: EasyResolved = {
    idea: 'A report of my sales by month',
    kind: 'data',
    kindSource: 'words',
    template: { id: 'data-report-web', label: 'Report from data' },
    recipe: 'easy-data',
    folder: FOLDER,
    folderName: 'sales-report',
    projectsDir: ROOT,
    research: false,
    estimate: null,
    limits: { maxCostUsd: null, maxMinutes: null },
    vendors: { claude: true, codex: false, ready: true },
    toolchain: { node: true, python: false, nodeVersion: '22.12.0' },
  }

  async function showConfirm(attachments?: EasyAttachment[]): Promise<void> {
    setDraft({ idea: DATA.idea, ...(attachments !== undefined ? { attachments } : {}) })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
  }

  it('a report from data with no file says it uses example numbers, with Add files', async () => {
    mock.on('easy.resolve', () => DATA)
    await showConfirm()
    expect(screen.getByTestId('easy-no-data-line').textContent).toBe(NO_DATA_FILE)
    expect(screen.getByTestId('easy-confirm-add-files')).toBeTruthy()
  })

  it('with a data file, no such line', async () => {
    mock.on('easy.resolve', () => DATA)
    await showConfirm([CSV])
    expect(screen.queryByTestId('easy-no-data-line')).toBeNull()
    expect(screen.queryByTestId('easy-confirm-add-files')).toBeNull()
    expect(screen.getByTestId('easy-confirm-files').textContent).toContain(CSV.name)
  })

  it('nobody can do the work: the setup steps; Check again looks afresh and says it is still not ready', async () => {
    mock.on('easy.resolve', () => ({ ...DATA, vendors: { claude: false, codex: false, ready: false } }))
    mock.on('vendors.probe', () => [])
    await showConfirm([CSV])
    const setup = screen.getByTestId('easy-setup')
    for (const c of setupCommands('win32', 'claude'))
      expect(within(setup).getByTestId('easy-setup-claude').textContent).toContain(c)
    for (const c of setupCommands('win32', 'codex'))
      expect(within(setup).getByTestId('easy-setup-codex').textContent).toContain(c)
    expect(screen.getByTestId('easy-setup-status').textContent).toBe('')
    const resolves = mock.callsOf('easy.resolve').length
    fireEvent.click(screen.getByTestId('easy-setup-check'))
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ force: true }])
    expect(mock.callsOf('easy.resolve')).toHaveLength(resolves + 1)
    expect(mock.callsOf('easy.resolve').at(-1)).toMatchObject({ idea: DATA.idea })
    expect(screen.getByTestId('easy-setup-status').textContent).toBe(SETUP_STILL)
    expect(screen.getByTestId('easy-setup-check').textContent).toBe(SETUP_CHECK)
  })
})

describe('a folder with unsaved changes', () => {
  const SITE = 'C:\\Users\\me\\code\\shop-site'
  const VIEW: EasyFolderView = {
    folder: SITE,
    name: 'shop-site',
    mode: 'isolated',
    uncommitted: 3,
    made: false,
    vendors: { claude: true, codex: false, ready: true },
  }

  it('says how many, and Start waits for how to go on; then easy.work with it', async () => {
    mock.on('easy.inspectFolder', () => VIEW)
    mock.on('easy.work', () => ({ runId: 'r9', displayNo: 9, folder: SITE }))
    render(
      <Providers>
        <EasyExistingPage folder={SITE} />
      </Providers>,
    )
    await settle()
    const unsaved = screen.getByTestId('easy-existing-unsaved')
    expect(unsaved.textContent).toContain(uncommittedText(3))
    fireEvent.change(screen.getByTestId('easy-existing-change'), { target: { value: 'Add a contact page' } })
    expect(screen.getByTestId('easy-existing-start').hasAttribute('disabled')).toBe(true)
    const saveFirst = screen.getByTestId('easy-existing-how-saveFirst')
    const label = saveFirst.textContent
    fireEvent.click(saveFirst)
    expect(screen.getByTestId('easy-existing-how-saveFirst').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('easy-existing-how-saveFirst').textContent).toBe(label)
    expect(screen.getByTestId('easy-existing-start').hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByTestId('easy-existing-how-inPlace'))
    fireEvent.click(screen.getByTestId('easy-existing-start'))
    await settle()
    expect(mock.callsOf('easy.work')).toEqual([
      {
        folder: SITE,
        change: 'Add a contact page',
        how: 'inPlace',
        limits: { maxCostUsd: null, maxMinutes: null },
      },
    ])
    expect(window.location.hash).toBe('#/easy/runs/r9')
  })
})

describe('the overnight list', () => {
  it('shows each warning, each estimate and the total for what still waits', async () => {
    const a = { durationMs: { p50: 600_000, p80: 900_000 }, costUsd: { p50: 0.8, p80: 1.2 } }
    const b = { durationMs: { p50: 1_200_000, p80: 1_800_000 }, costUsd: { p50: 1.5, p80: 2 } }
    const view: EasyQueueView = {
      state: 'idle',
      schedule: { enabled: false, start: '22:00' },
      items: [
        {
          folder: `${ROOT}\\sales`,
          title: 'Sales report',
          kind: 'data',
          status: 'pending',
          estimate: a,
          warnings: [{ kind: 'exampleData' }],
        },
        {
          folder: `${ROOT}\\snake`,
          title: 'Snake game',
          kind: 'game',
          status: 'pending',
          estimate: b,
          warnings: [{ kind: 'noResearch' }],
        },
        {
          folder: `${ROOT}\\bakery`,
          title: 'Something for my bakery',
          kind: 'website',
          status: 'pending',
          warnings: [{ kind: 'vague', candidates: ['website', 'app'] }],
        },
        {
          folder: `${ROOT}\\done`,
          title: 'Already made',
          kind: 'website',
          status: 'done',
          runId: 'r5',
          estimate: b,
        },
      ],
    }
    mock.on('easy.queue', () => view)
    render(
      <Providers>
        <EasyOvernightPage />
      </Providers>,
    )
    await settle()
    const items = screen.getAllByTestId('easy-overnight-item')
    expect(items).toHaveLength(4)
    const [sales, snake, bakery] = items as [HTMLElement, HTMLElement, HTMLElement]
    const warning = (el: HTMLElement): HTMLElement => within(el).getByTestId('easy-overnight-warning')
    expect(warning(sales).getAttribute('data-warning')).toBe('exampleData')
    expect(warning(sales).textContent).toBe(overnightWarningText('exampleData'))
    expect(warning(snake).getAttribute('data-warning')).toBe('noResearch')
    expect(warning(snake).textContent).toBe(overnightWarningText('noResearch'))
    expect(warning(bakery).getAttribute('data-warning')).toBe('vague')
    expect(warning(bakery).textContent).toBe(overnightWarningText('vague', ['website', 'app']))
    expect(sales.textContent).toContain(overnightEstimateText(a.durationMs, a.costUsd))
    expect(snake.textContent).toContain(overnightEstimateText(b.durationMs, b.costUsd))
    expect(bakery.textContent).not.toContain('Up to about')
    // The two pending ideas with an estimate (the made one is left out), plus one with none.
    expect(screen.getByTestId('easy-overnight-total').textContent).toBe(
      overnightTotalText(1.2 + 2, 15 + 30, 1),
    )
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })
})

describe('a preflight card in Easy', () => {
  const card = (category: string): CardView => ({
    id: 'preflight-1',
    kind: 'preflight',
    title: 'Claude needs you to log in',
    body: '- Claude needs you to log in',
    blocking: true,
    choices: [{ id: 'recheck', label: 'Recheck', primary: true }],
    payload: { blocking: [{ id: 'vendor.claude.auth', category }], warnings: [] },
  })

  it('says what is wrong in plain words, with Recheck as the next step', async () => {
    render(
      <Providers>
        <PlainCard runId="r1" card={card('auth_required')} />
      </Providers>,
    )
    await settle()
    const body = screen.getByTestId('easy-card-body').textContent ?? ''
    expect(body).toBe(preflightText('auth_required', 'claude'))
    expect(body).toContain('signed out of Claude')
    expect(body.endsWith('press Recheck.')).toBe(true)
    expect(screen.getByTestId('easy-card-what').textContent).toBe(SHOW_PROBLEM)
  })

  it('an unknown kind of problem gets the general line', async () => {
    render(
      <Providers>
        <PlainCard runId="r1" card={card('something_new')} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('easy-card-body').textContent).toBe(PREFLIGHT_PLAIN)
  })
})

describe("the upload file and a report's data files", () => {
  const MADE: DeployUploadResult = {
    status: 'made',
    path: `${FOLDER}.zip`,
    name: 'sales-report.zip',
    dir: '.',
    files: 4,
    bytes: 20_000,
    skipped: 0,
  }

  it('leaves the data files out and says so; Include them makes it again with them', async () => {
    const answers: DeployUploadResult[] = [
      { ...MADE, dataLeftOut: ['data/people.csv'] },
      { ...MADE, dataIncluded: true },
    ]
    mock.on('deploy.uploadFile', () => answers.shift() as DeployUploadResult)
    render(
      <Providers>
        <UploadFile
          target={{ folder: FOLDER }}
          upload={{ dir: '.', ready: true, game: false }}
          cls={undefined}
        />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('deploy-upload-make'))
    await settle()
    const data = screen.getByTestId('deploy-upload-data')
    expect(data.textContent).toContain(dataLeftOutText(1))
    expect(data.textContent).toContain('data/people.csv')
    expect(screen.queryByTestId('deploy-upload-data-included')).toBeNull()
    const include = screen.getByTestId('deploy-upload-include-data')
    expect(include.textContent).toBe(INCLUDE_DATA)
    fireEvent.click(include)
    await settle()
    expect(mock.callsOf('deploy.uploadFile')).toEqual([
      { folder: FOLDER },
      { folder: FOLDER, includeData: true },
    ])
    expect(screen.getByTestId('deploy-upload-data-included').textContent).toBe(DATA_INCLUDED)
    expect(screen.queryByTestId('deploy-upload-data')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })
})

describe('a card waiting in Easy', () => {
  function showWaiting(card: CardView): RunSnapshot {
    const s = makeSnapshot({
      runId: 'r1',
      folder: FOLDER,
      createdAt: Date.now(),
      status: 'running',
      phase: 'needs-attention',
    })
    s.cards = [card]
    showRun(s)
    return s
  }
  const PLAN_MUTATED: CardView = {
    id: 'planMutated-3',
    kind: 'planMutated',
    title: 'Plan changed files',
    body: "The Plan step should only read, but 2 files changed while it ran: a.md, b.md. Revert Plan's changes (you can undo that), or keep them.",
    payload: { step: 'plan', paths: ['a.md', 'b.md'] },
    blocking: true,
    choices: [
      { id: 'revert-plan', label: "Revert Plan's changes", primary: true },
      { id: 'keep', label: 'Keep' },
    ],
  }

  it('the plan-mutated card speaks Easy: plain body, plain choices, the files behind a toggle', async () => {
    showWaiting(PLAN_MUTATED)
    await settle()
    const card = screen.getByTestId('easy-card-planMutated')
    expect(within(card).getByTestId('easy-card-body').textContent).toBe(planMutatedBodyText(2))
    expect(card.textContent).not.toMatch(/Plan step|Revert Plan's changes/)
    expect(within(card).getByTestId('card-choice-revert-plan').textContent).toContain(PLAN_MUTATED_REVERT)
    expect(within(card).getByTestId('card-choice-keep').textContent).toContain(PLAN_MUTATED_KEEP)
    fireEvent.click(within(card).getByTestId('easy-card-what'))
    expect(within(card).getByTestId('easy-card-detail').textContent).toContain('a.md')
    expect(within(card).getByTestId('easy-card-detail').textContent).not.toContain('Plan step')
    expect(card.textContent ?? '').not.toContain(EM_DASH)
  })

  it('the time line says it is waiting for you, and the new card comes into view with focus once', async () => {
    const s = showWaiting(PLAN_MUTATED)
    await settle()
    expect(screen.getByTestId('easy-time').textContent).toBe(WAITING_FOR_YOU_TIME)
    const card = screen.getByTestId('easy-card-planMutated')
    expect(document.activeElement).toBe(card)
    // Once only: focus moved elsewhere stays there on the next render.
    screen.getByTestId('easy-show-details').focus()
    act(() => {
      applySnapshot({ ...s, cards: [{ ...PLAN_MUTATED }] })
    })
    await settle()
    expect(document.activeElement).toBe(screen.getByTestId('easy-show-details'))
  })
})
