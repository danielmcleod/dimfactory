// Games phase 2 in the renderer, on the mock bridge:
// - Run it for a game: the network line ("No internet", the blocked hosts) with "Allow internet for this preview" (one
//   click: preview.network; the button keeps its label and turns off), Play-test (preview.playtest) and its result
//   (each scenario passed or failed, the built-in checks), and the smoke check's game checks and blocked requests.
// - The Verify card: a play-test's scenarios open on a click, passed or failed, the not-required ones marked.
// - Easy's Done screen for a game: "Play-tested" from the run's own play-test, "Play-test it again", the blocked line
//   with the allow button. No em dashes anywhere.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyProjectView, EasyState } from '@shared/easy.ts'
import type { PlaytestReport } from '@shared/playtest.ts'
import { PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME } from '@shared/playtest.ts'
import type {
  PreviewInfo,
  PreviewPlaytestView,
  PreviewSessionView,
  PreviewSmokeView,
} from '@shared/preview.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { RunItPanel } from '@renderer/components/run/RunItPanel.tsx'
import { VerifyCard } from '@renderer/components/run/VerifyCard.tsx'
import { PLAYTEST_LINE } from '@renderer/components/run/VerifyModel.ts'
import {
  ALLOW_INTERNET_LABEL,
  PHONE_OFF_NOTE,
  PHONE_ON_NOTE,
  PHONE_SIZE_LABEL,
  networkText,
} from '@renderer/components/run/GamePreview.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { resetPreviewsForTests } from '@renderer/state/previews.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { resetDraftForTests } from '@renderer/pages/easy/draft.ts'
import { PLAYTEST_AGAIN, PLAYTESTED_TITLE } from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\snake-game'
const bodyText = (): string => document.body.innerText ?? document.body.textContent ?? ''

const INFO = (over: Partial<PreviewInfo> = {}): PreviewInfo => ({
  folder: FOLDER,
  scopeRoot: FOLDER,
  trustFolder: FOLDER,
  commands: [
    {
      id: 'static:.',
      label: 'Serve index.html',
      kind: 'static',
      source: 'static',
      argv: [],
      cwdRel: '.',
      staticRoot: '.',
      trust: 'none',
    },
  ],
  checks: [],
  runMd: null,
  sessions: [],
  smoke: null,
  openIn: 'app',
  ...over,
})

const SESSION = (over: Partial<PreviewSessionView> = {}): PreviewSessionView => ({
  id: 'pv1',
  folder: FOLDER,
  commandId: 'static:.',
  label: 'Serve index.html',
  kind: 'static',
  status: 'running',
  url: 'http://127.0.0.1:5000/',
  startedAt: 1,
  tail: [],
  lines: 0,
  game: true,
  network: 'loopback',
  blocked: { count: 2, hosts: ['fonts.example.invalid'] },
  ...over,
})

const REPORT = (over: Partial<PlaytestReport> = {}): PlaytestReport => ({
  url: 'http://127.0.0.1:5000/',
  loaded: true,
  hook: true,
  scenarios: [
    { name: 'Space starts the game', must: true, status: 'pass', durationMs: 900, screenshots: [] },
    {
      name: 'Arrow keys steer the snake',
      must: true,
      status: 'fail',
      durationMs: 900,
      screenshots: [],
      failure: { step: 4, what: 'dir.y eq 1', message: 'expected dir.y to be 1, got 0' },
    },
    { name: 'The score starts at zero', must: false, status: 'pass', durationMs: 100, screenshots: [] },
  ],
  checks: [
    { id: 'canvas', status: 'pass', title: 'The canvas shows something' },
    { id: 'frames', status: 'warn', title: 'The game may stutter: frames come late', detail: 'median 25 ms' },
  ],
  measures: {},
  consoleErrors: [],
  failedLoads: [],
  blocked: [],
  durationMs: 4000,
  ...over,
})

describe('Run it for a game', () => {
  let mock: MockDimFactory
  let network: 'loopback' | 'internet' = 'loopback'
  beforeEach(() => {
    resetPreviewsForTests()
    network = 'loopback'
    mock = setUp({
      handlers: {
        'preview.detect': () => INFO({ sessions: [SESSION({ network })] }),
        'preview.network': (req) => {
          network = req.internet ? 'internet' : 'loopback'
          return SESSION({ network })
        },
        'preview.playtest': (): PreviewPlaytestView => ({ sessionId: 'pv1', at: 2, report: REPORT() }),
        'preview.smoke': (): PreviewSmokeView => ({
          sessionId: 'pv1',
          at: 3,
          url: 'http://127.0.0.1:5000/',
          loaded: true,
          consoleErrors: [],
          failedLoads: [],
          thumbnail: null,
          screenshotPath: null,
          findings: [],
          checks: [{ id: 'canvas', status: 'fail', title: 'The canvas is blank: it shows one flat colour' }],
          blocked: [{ url: 'https://fonts.example.invalid/garden.css', host: 'fonts.example.invalid' }],
        }),
        'preview.open': () => undefined,
      },
    })
  })
  afterEach(() => tearDown(mock))

  it('says the game has no internet and which hosts were blocked; one click allows it', async () => {
    render(
      <Providers>
        <RunItPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    const row = screen.getByTestId('run-it-network')
    expect(row.getAttribute('data-network')).toBe('loopback')
    expect(screen.getByTestId('run-it-network-text').textContent).toBe(
      'No internet: this game can reach only this computer, so it must bundle what it needs. Blocked 2 requests to fonts.example.invalid.',
    )
    const allow = screen.getByTestId<HTMLButtonElement>('run-it-allow-internet')
    expect(allow.textContent).toBe(ALLOW_INTERNET_LABEL)
    expect(allow.disabled).toBe(false)
    fireEvent.click(allow)
    await settle()
    expect(mock.callsOf('preview.network')).toEqual([{ sessionId: 'pv1', internet: true }])
    expect(screen.getByTestId('run-it-network-text').textContent).toBe('Internet allowed for this preview.')
    // The button keeps its label and turns off.
    expect(screen.getByTestId('run-it-allow-internet').textContent).toBe(ALLOW_INTERNET_LABEL)
    expect(screen.getByTestId<HTMLButtonElement>('run-it-allow-internet').disabled).toBe(true)
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('Play-test shows each scenario as passed or failed, and the game checks', async () => {
    render(
      <Providers>
        <RunItPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('run-it-playtest'))
    await settle()
    expect(mock.callsOf('preview.playtest')).toEqual([{ sessionId: 'pv1' }])
    const result = screen.getByTestId('run-it-playtest-result')
    expect(within(result).getByTestId('run-it-playtest-result-summary').textContent).toBe(
      '1 of 2 required scenarios did not pass.',
    )
    const rows = within(result).getAllByTestId('run-it-playtest-result-scenario')
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pass', 'fail', 'pass'])
    expect(rows[1]?.textContent).toContain('Step 4 (dir.y eq 1): expected dir.y to be 1, got 0')
    expect(rows[2]?.textContent).toContain('(not required)')
    expect(within(result).getByTestId('run-it-game-check-frames').getAttribute('data-status')).toBe('warn')
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it("the smoke check lists a game's checks and its blocked requests", async () => {
    render(
      <Providers>
        <RunItPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('run-it-smoke'))
    await settle()
    expect(screen.getByTestId('run-it-game-check-canvas').getAttribute('data-status')).toBe('fail')
    expect(screen.getByTestId('run-it-smoke-blocked').textContent).toBe(
      'Blocked (no internet): https://fonts.example.invalid/garden.css',
    )
  })

  it('words the network line', () => {
    expect(networkText({ network: 'loopback' })).toBe(
      'No internet: this game can reach only this computer, so it must bundle what it needs.',
    )
    expect(networkText({ network: 'loopback', blocked: { count: 1, hosts: ['a', 'b', 'c', 'd'] } })).toBe(
      'No internet: this game can reach only this computer, so it must bundle what it needs. Blocked 1 request to a, b, c and more.',
    )
    expect(networkText({ network: 'internet' })).toBe('Internet allowed for this preview.')
  })
})

describe("a game's Done screen and Verify card", () => {
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
    projectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
    defaultProjectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
  }
  const PROJECT: EasyProjectView = {
    folder: FOLDER,
    name: 'snake-game',
    title: 'Snake game',
    kind: 'game',
    idea: 'A snake game',
    lastRunId: 'r1',
    lastDisplayNo: 1,
    lastStatus: 'completed',
    updatedAt: 1,
    runs: 1,
  }
  let mock: MockDimFactory
  beforeEach(() => {
    resetBridgeForTests()
    resetPreviewsForTests()
    streamBuffer.reset()
    resetDraftForTests()
    clearOutputCache()
    mock = setUp({
      handlers: {
        'easy.state': () => STATE,
        'easy.projects': () => [PROJECT],
        'easy.permission': () => ({ folder: FOLDER, at: 1, uses: 0, granted: false, runUses: 0 }),
        'easy.visual': () => ({
          game: true,
          vendor: null,
          reason: 'Nobody can look here.',
          usd: null,
          picture: false,
          findings: [],
        }),
        'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
        'runs.output': () => ({ text: '## How to play\nControls: arrow keys', mtime: 1, version: 1 }),
        'memory.get': () => ({
          folder: FOLDER,
          file: `${FOLDER}\\DIM_FACTORY.md`,
          exists: false,
          bytes: 0,
          capped: false,
          maxBytes: 16_000,
          enabled: true,
          propose: true,
          autoApply: false,
          pending: [],
        }),
        'preview.detect': () => INFO(),
        'preview.start': () => {
          const { blocked: _none, ...rest } = SESSION()
          return rest
        },
        'preview.playtest': (): PreviewPlaytestView => ({
          sessionId: 'pv1',
          at: 2,
          report: REPORT({
            scenarios: [
              { name: 'Space starts the game', must: true, status: 'pass', durationMs: 1, screenshots: [] },
              {
                name: 'Arrow keys steer the snake',
                must: true,
                status: 'pass',
                durationMs: 1,
                screenshots: [],
              },
            ],
            blocked: [{ url: 'https://fonts.example.invalid/garden.css', host: 'fonts.example.invalid' }],
          }),
        }),
        'preview.network': () => SESSION({ network: 'internet' }),
      },
    })
    setEasyStateForTests(STATE)
  })
  afterEach(() => {
    setEasyStateForTests(null)
    tearDown(mock)
  })

  function done(): RunSnapshot {
    const s = makeSnapshot({
      runId: 'r1',
      folder: FOLDER,
      createdAt: Date.now(),
      status: 'completed',
      phase: 'done',
      outcome: 'clean',
    })
    s.steps.explain = { ...s.steps.explain, status: 'done', attempt: 1 }
    s.steps['verify:1'] = {
      ...s.steps['verify:1'],
      status: 'done',
      attempt: 1,
      verify: {
        commands: [
          {
            name: PLAYTEST_COMMAND_NAME,
            argv: [...PLAYTEST_ARGV],
            status: 'fail',
            durationMs: 9000,
            reason: '1 of 2 must scenarios did not pass: Arrow keys steer the snake',
            scenarios: [
              { name: 'Space starts the game', must: true, status: 'pass' },
              {
                name: 'Arrow keys steer the snake',
                must: true,
                status: 'fail',
                message: 'step 4 (dir.y eq 1): expected dir.y to be 1, got 0',
              },
            ],
          },
        ],
      },
    }
    mock.on('runs.get', () => s)
    act(() => {
      applySnapshot(s)
    })
    return s
  }

  it("shows the run's play-test, plays it again on a click, and offers to allow the internet it tried to reach", async () => {
    done()
    render(
      <Providers>
        <EasyRunPage runId="r1" />
      </Providers>,
    )
    await settle()
    const section = screen.getByTestId('easy-done-playtest')
    expect(within(section).getByRole('heading').textContent).toBe(PLAYTESTED_TITLE)
    const rows = within(section).getAllByTestId('easy-playtest-scenario')
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pass', 'fail'])
    expect(rows[0]?.textContent).toContain('Works')
    expect(rows[1]?.textContent).toContain('Not yet')
    expect(rows[1]?.textContent).toContain('expected dir.y to be 1, got 0')
    const again = within(section).getByTestId('easy-playtest-again')
    expect(again.textContent).toBe(PLAYTEST_AGAIN)
    fireEvent.click(again)
    await settle()
    expect(mock.callsOf('preview.playtest')).toEqual([{ sessionId: 'pv1' }])
    expect(
      within(section)
        .getAllByTestId('easy-playtest-scenario')
        .map((r) => r.getAttribute('data-status')),
    ).toEqual(['pass', 'pass'])
    expect(within(section).getByTestId('easy-playtest-note').textContent).toContain(
      'All 2 required scenarios passed.',
    )
    expect(within(section).getByTestId('easy-playtest-note').textContent).toContain(
      'It tried to load something from the internet (fonts.example.invalid).',
    )
    fireEvent.click(within(section).getByTestId('easy-playtest-allow-internet'))
    await settle()
    expect(mock.callsOf('preview.network')).toEqual([{ sessionId: 'pv1', internet: true }])
    expect(within(section).getByTestId('easy-playtest-note').textContent).toContain(
      'Internet allowed for this preview.',
    )
    expect(within(section).getByTestId<HTMLButtonElement>('easy-playtest-allow-internet').disabled).toBe(true)
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('Phone size opens the game at phone size and back, keeping its label', async () => {
    mock.on('preview.phone', (req) => SESSION(req.phone ? { phone: true } : {}))
    done()
    render(
      <Providers>
        <EasyRunPage runId="r1" />
      </Providers>,
    )
    await settle()
    const phone = (): HTMLElement => screen.getByTestId('easy-phone-size')
    expect(phone().textContent).toBe(PHONE_SIZE_LABEL)
    expect(phone().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(phone())
    await settle()
    expect(mock.callsOf('preview.phone')).toEqual([{ sessionId: 'pv1', phone: true }])
    expect(phone().getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('easy-open-note').textContent).toBe(PHONE_ON_NOTE)
    fireEvent.click(phone())
    await settle()
    expect(mock.callsOf('preview.phone')).toEqual([
      { sessionId: 'pv1', phone: true },
      { sessionId: 'pv1', phone: false },
    ])
    expect(phone().textContent).toBe(PHONE_SIZE_LABEL)
    expect(screen.getByTestId('easy-open-note').textContent).toBe(PHONE_OFF_NOTE)
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('the Verify card names the play-test and opens its scenarios on a click', async () => {
    const snap = done()
    const view = snap.steps['verify:1']
    render(
      <Providers>
        <VerifyCard runId="r1" snap={snap} view={view} finishedAtOpen={false} />
      </Providers>,
    )
    await settle()
    expect(bodyText()).toContain(PLAYTEST_LINE)
    expect(screen.queryByLabelText('Play-test scenarios')).toBeNull()
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid$="-scenarios-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle as HTMLButtonElement)
    await settle()
    const rows = [...document.querySelectorAll('[data-testid$="-scenario"]')]
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pass', 'fail'])
    expect(rows[0]?.textContent).toContain('Passed')
    expect(rows[1]?.textContent).toContain('Failed')
    expect(rows[1]?.textContent).toContain('Arrow keys steer the snake')
    // The toggle keeps its width: both of its labels are laid out.
    expect(toggle?.querySelector('[data-label="Show the scenarios"]')).not.toBeNull()
    expect(toggle?.querySelector('[data-label="Hide the scenarios"]')).not.toBeNull()
  })
})
