// The Run it panel (Run & Preview) in its states: collapsed in "After the run" (nothing detected until opened),
// detecting, nothing found (with and without RUN.md), commands with their trust (Trust → preview.trust, Start held
// back until trusted), a starting and a running preview (its status, the newest output in a fixed box, Open preview /
// Open in browser as Settings → Preview says, the smoke check), Stop, an ended preview, the non-blocking tool check,
// and a smoke result as a run's findings or as a note. Start/Stop and Trust/Trusted keep one width; no em dashes.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckResult } from '@shared/preflight.ts'
import type { PreviewCommand, PreviewInfo, PreviewSessionView, PreviewSmokeView } from '@shared/preview.ts'
import {
  COMPOSE_DOWN_LABEL,
  LOG_LINES,
  NOTHING_TEXT,
  NO_RUN_MD_TEXT,
  RunItPanel,
  START_LABEL,
  STOP_LABEL,
  sessionText,
  smokeSummary,
} from '@renderer/components/run/RunItPanel.tsx'
import { PreviewSection } from '@renderer/pages/settings/PreviewSection.tsx'
import { PREVIEW_OPEN_TARGETS } from '@shared/preview.ts'
import { OPEN_IN_OPTIONS } from '@renderer/pages/settings/PreviewSection.tsx'
import { resetPreviewsForTests, upsertPreviewSessions } from '@renderer/state/previews.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve } from '../composer/fixtures.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\work\\app'

const dev: PreviewCommand = {
  id: 'pkg:dev',
  label: 'npm run dev',
  kind: 'server',
  source: 'package.json',
  argv: ['npm', 'run', 'dev'],
  cwdRel: '.',
  trust: 'untrusted',
  hash: 'a'.repeat(64),
}
const site: PreviewCommand = {
  id: 'static:docs',
  label: 'Serve docs/index.html',
  kind: 'static',
  source: 'static',
  argv: [],
  cwdRel: '.',
  staticRoot: 'docs',
  trust: 'none',
}

const info = (over: Partial<PreviewInfo> = {}): PreviewInfo => ({
  folder: FOLDER,
  scopeRoot: FOLDER,
  trustFolder: FOLDER,
  commands: [dev, site],
  checks: [],
  runMd: null,
  sessions: [],
  smoke: null,
  openIn: 'ask',
  ...over,
})

const session = (over: Partial<PreviewSessionView> = {}): PreviewSessionView => ({
  id: 'pv_1',
  folder: FOLDER,
  commandId: 'pkg:dev',
  label: 'npm run dev',
  kind: 'server',
  status: 'running',
  url: 'http://localhost:5173/',
  startedAt: 1,
  tail: ['> vite', '  Local:   http://localhost:5173/'],
  lines: 2,
  logPath: 'C:\\home\\preview\\logs\\pv_1.log',
  ...over,
})

const smoke = (over: Partial<PreviewSmokeView> = {}): PreviewSmokeView => ({
  sessionId: 'pv_1',
  at: 5,
  url: 'http://localhost:5173/',
  loaded: true,
  consoleErrors: [{ message: 'Uncaught Error: boom', source: 'http://localhost:5173/main.js', line: 3 }],
  failedLoads: [],
  thumbnail: 'data:image/jpeg;base64,AAAA',
  screenshotPath: null,
  findings: [],
  ...over,
})

let mock: MockDimFactory
let detected: PreviewInfo

function mount(collapsible = false, target: { folder?: string; runId?: string } = { folder: FOLDER }): void {
  render(
    <Providers>
      <RunItPanel target={target} collapsible={collapsible} />
    </Providers>,
  )
}

beforeEach(() => {
  resetPreviewsForTests()
  detected = info()
  mock = setUp({
    handlers: {
      'preview.detect': () => detected,
      'preview.trust': () => {
        detected = info({ commands: [{ ...dev, trust: 'trusted' }, site] })
      },
      'preview.start': (req) =>
        session({ commandId: req.commandId, status: 'starting', url: null, tail: [], lines: 0 }),
      'preview.stop': () => undefined,
      'preview.open': () => undefined,
      'preview.smoke': () => smoke(),
    },
  })
})
afterEach(() => tearDown(mock))

const bodyText = (): string => document.body.innerText ?? document.body.textContent ?? ''

describe('collapsed in After the run', () => {
  it('detects nothing until opened, then shows the commands', async () => {
    mount(true, { runId: 'run-1' })
    await settle()
    expect(mock.callsOf('preview.detect')).toEqual([])
    const toggle = screen.getByTestId('run-it-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    await settle()
    expect(mock.callsOf('preview.detect')).toEqual([{ runId: 'run-1' }])
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('run-it-command-pkg:dev')).toBeTruthy()
    expect(toggle.querySelector('[data-label="Run it"]')).not.toBeNull()
    expect(toggle.querySelector('[data-label="Hide"]')).not.toBeNull()
  })
})

describe('nothing to run', () => {
  it('says so, and that there is no RUN.md either', async () => {
    detected = info({ commands: [] })
    mount()
    await settle()
    expect(screen.getByTestId('run-it-nothing').textContent).toBe(NOTHING_TEXT)
    expect(screen.getByTestId('run-it-no-run-md').textContent).toBe(NO_RUN_MD_TEXT)
  })

  it('shows RUN.md as text, never as HTML', async () => {
    detected = info({
      commands: [],
      runMd: { text: '# How to run\n\n- `npm start`\n<img src=x onerror=alert(1)>\n', truncated: true },
    })
    mount()
    await settle()
    const md = screen.getByTestId('run-it-run-md')
    expect(md.textContent).toContain('How to run')
    expect(md.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(md.querySelector('img')).toBeNull()
    expect(md.textContent).toContain('Only the start of RUN.md is shown.')
  })
})

describe('commands and trust', () => {
  it('holds Start back until the command is trusted, then trusts it with the hash it showed', async () => {
    mount()
    await settle()
    const row = screen.getByTestId('run-it-command-pkg:dev')
    expect(row.getAttribute('data-trust')).toBe('untrusted')
    const start = screen.getByTestId<HTMLButtonElement>('run-it-start-pkg:dev')
    expect(start.disabled).toBe(true)
    expect(row.querySelector('[data-disabled-hint]')?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(bodyText()).not.toContain(EM_DASH)
    fireEvent.click(screen.getByTestId('run-it-trust-button-pkg:dev'))
    await settle()
    expect(mock.callsOf('preview.trust')).toEqual([
      { folder: FOLDER, commandId: 'pkg:dev', hash: 'a'.repeat(64), trusted: true },
    ])
    expect(screen.getByTestId('run-it-command-pkg:dev').getAttribute('data-trust')).toBe('trusted')
    expect(screen.getByTestId<HTMLButtonElement>('run-it-start-pkg:dev').disabled).toBe(false)
    expect(screen.getByTestId<HTMLButtonElement>('run-it-trust-button-pkg:dev').disabled).toBe(true)
    expect(screen.getByTestId('run-it-trust-button-pkg:dev').textContent).toContain('Trusted')
  })

  it('needs no trust for the static server, and shows a missing tool as a warning that blocks nothing', async () => {
    const check: CheckResult = {
      id: 'preview.tool.pkg:dev',
      scope: 'folder',
      status: 'warn',
      blocking: false,
      title: 'npm is not installed',
      detail: 'npm run dev needs npm.',
      recovery: [],
      at: 0,
      ttlMs: 0,
    }
    detected = info({ checks: [check], commands: [{ ...dev, trust: 'trusted' }, site] })
    mount()
    await settle()
    expect(screen.queryByTestId('run-it-trust-button-static:docs')).toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>('run-it-start-static:docs').disabled).toBe(false)
    expect(screen.getByTestId('run-it-check').textContent).toContain('npm is not installed')
    expect(screen.getByTestId<HTMLButtonElement>('run-it-start-pkg:dev').disabled).toBe(false)
  })
})

describe('a preview', () => {
  beforeEach(() => {
    detected = info({ commands: [{ ...dev, trust: 'trusted' }, site] })
  })

  it('starts, then runs with its URL, its newest output and the open buttons; Start turns Stop at one width', async () => {
    mount()
    await settle()
    const button = screen.getByTestId('run-it-start-pkg:dev')
    const reserved = [...button.querySelectorAll('[data-label]')].map((e) => e.getAttribute('data-label'))
    expect(reserved).toEqual(expect.arrayContaining([START_LABEL, STOP_LABEL]))
    fireEvent.click(button)
    await settle()
    expect(mock.callsOf('preview.start')).toEqual([{ folder: FOLDER, commandId: 'pkg:dev' }])
    expect(screen.getByTestId('run-it-session').getAttribute('data-status')).toBe('starting')
    expect(screen.getByTestId('run-it-status').textContent).toBe('Starting npm run dev…')
    // Before the output names a page, the open buttons wait with a reason.
    expect(screen.getByTestId<HTMLButtonElement>('run-it-open-app').disabled).toBe(true)
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    act(() => upsertPreviewSessions([session({ tail: lines, lines: 30 })]))
    expect(screen.getByTestId('run-it-status').textContent).toBe(
      'Running npm run dev at http://localhost:5173/',
    )
    expect(screen.getByTestId('run-it-start-pkg:dev').textContent).toContain(STOP_LABEL)
    const log = screen.getByTestId('run-it-log')
    expect(log.children).toHaveLength(LOG_LINES)
    expect(log.textContent).toContain('line 30')
    expect(log.textContent).not.toContain('line 18')
    expect(log.className).toContain('overflow-hidden')
    expect(log.hasAttribute('data-scroll-region')).toBe(false)
    fireEvent.click(screen.getByTestId('run-it-open-app'))
    await settle()
    fireEvent.click(screen.getByTestId('run-it-open-browser'))
    await settle()
    expect(mock.callsOf('preview.open')).toEqual([
      { sessionId: 'pv_1', target: 'app' },
      { sessionId: 'pv_1', target: 'browser' },
    ])
    fireEvent.click(screen.getByTestId('run-it-start-pkg:dev'))
    await settle()
    expect(mock.callsOf('preview.stop')).toEqual([{ sessionId: 'pv_1' }])
    act(() => upsertPreviewSessions([session({ status: 'stopped', endedAt: 9, reason: 'Stopped' })]))
    expect(screen.getByTestId('run-it-status').textContent).toBe('npm run dev stopped.')
    expect(screen.getByTestId('run-it-start-pkg:dev').textContent).toContain(START_LABEL)
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('offers only the open button Settings → Preview chose', async () => {
    detected = info({ openIn: 'app', commands: [{ ...dev, trust: 'trusted' }], sessions: [session()] })
    mount()
    await settle()
    expect(screen.getByTestId('run-it-open-app')).toBeTruthy()
    expect(screen.queryByTestId('run-it-open-browser')).toBeNull()
  })

  it('never goes back from ended to running when an older view arrives', () => {
    upsertPreviewSessions([session({ status: 'failed', endedAt: 3, reason: 'It ended with code 1' })])
    upsertPreviewSessions([session()])
    expect(sessionText(session({ status: 'failed', reason: 'It ended with code 1' }))).toBe(
      'npm run dev ended: It ended with code 1.',
    )
  })
})

describe('the smoke check', () => {
  beforeEach(() => {
    detected = info({ commands: [{ ...dev, trust: 'trusted' }], sessions: [session()] })
  })

  it('on demand: console errors and the screenshot, as a note only', async () => {
    mount()
    await settle()
    fireEvent.click(screen.getByTestId('run-it-smoke'))
    await settle()
    expect(mock.callsOf('preview.smoke')).toEqual([{ sessionId: 'pv_1' }])
    const r = screen.getByTestId('run-it-smoke-result')
    expect(r.getAttribute('data-errors')).toBe('1')
    expect(within(r).getByTestId('run-it-smoke-summary').textContent).toBe(
      'The page loaded with 1 console error.',
    )
    expect(within(r).getByTestId('run-it-smoke-error').textContent).toContain('Uncaught Error: boom')
    expect(within(r).getByTestId('run-it-smoke-thumbnail').getAttribute('src')).toBe(
      'data:image/jpeg;base64,AAAA',
    )
    expect(within(r).getByTestId('run-it-smoke-note')).toBeTruthy()
  })

  it('on a run: kept with the run as [should] findings, shown when the panel opens again', async () => {
    const finding = {
      id: 'abcdef123456',
      n: 1,
      severity: 'should' as const,
      source: 'preview' as const,
      title: 'The preview page logged a console error: Uncaught Error: boom',
      body: '',
      flags: [],
      round: 1,
    }
    detected = info({ runId: 'run-1', smoke: smoke({ runId: 'run-1', findings: [finding] }) })
    mount(false, { runId: 'run-1' })
    await settle()
    const findings = screen.getByTestId('run-it-smoke-findings')
    expect(findings.textContent).toContain('[should] F1 The preview page logged a console error')
    expect(screen.queryByTestId('run-it-smoke-note')).toBeNull()
  })

  it('summarizes every result in words', () => {
    expect(smokeSummary(smoke({ consoleErrors: [] }))).toBe(
      'The page loaded with no console errors and no failed loads.',
    )
    expect(
      smokeSummary(
        smoke({
          failedLoads: [
            { url: 'x', error: '404' },
            { url: 'y', error: '500' },
          ],
        }),
      ),
    ).toBe('The page loaded with 1 console error and 2 failed loads.')
    expect(smokeSummary(smoke({ loaded: false, error: 'The page did not load: refused' }))).toBe(
      'The page did not load: refused',
    )
  })
})

describe('Stop containers too (docker compose)', () => {
  const compose: PreviewCommand = {
    id: 'docker:compose',
    label: 'docker compose up',
    kind: 'server',
    source: 'docker',
    argv: ['docker', 'compose', 'up'],
    cwdRel: '.',
    trust: 'trusted',
    hash: 'b'.repeat(64),
  }
  const composeSession = (over: Partial<PreviewSessionView> = {}): PreviewSessionView =>
    session({ commandId: 'docker:compose', label: 'docker compose up', compose: true, ...over })

  it('is not offered for a preview that is not compose', async () => {
    detected = info({ commands: [{ ...dev, trust: 'trusted' }], sessions: [session()] })
    mount()
    await settle()
    expect(screen.queryByTestId('run-it-compose-down')).toBeNull()
  })

  it('runs only on the click (preview.stop with containers), with one label and its outcome beside it', async () => {
    detected = info({ commands: [compose], sessions: [composeSession()] })
    mount()
    await settle()
    const button = screen.getByTestId('run-it-compose-down')
    expect(button.textContent).toContain(COMPOSE_DOWN_LABEL)
    expect(screen.getByTestId('run-it-compose-status').textContent).toBe(
      'Stop ends only the compose command. This also runs docker compose down.',
    )
    // Nothing on its own: no stop of any kind until the click.
    expect(mock.callsOf('preview.stop')).toEqual([])
    fireEvent.click(button)
    await settle()
    expect(mock.callsOf('preview.stop')).toEqual([{ sessionId: 'pv_1', containers: true }])
    act(() =>
      upsertPreviewSessions([
        composeSession({
          status: 'stopped',
          endedAt: 9,
          reason: 'Stopped',
          composeDown: { status: 'running' },
        }),
      ]),
    )
    expect(screen.getByTestId('run-it-compose-status').textContent).toBe(
      'Stopping the containers (docker compose down)…',
    )
    expect(screen.getByTestId('run-it-compose-down').textContent).toContain(COMPOSE_DOWN_LABEL)
    act(() =>
      upsertPreviewSessions([
        composeSession({
          status: 'stopped',
          endedAt: 9,
          reason: 'Stopped',
          composeDown: { status: 'done', reason: 'Containers stopped' },
        }),
      ]),
    )
    expect(screen.getByTestId('run-it-compose-status').textContent).toBe('Containers stopped.')
    act(() =>
      upsertPreviewSessions([
        composeSession({
          status: 'stopped',
          endedAt: 9,
          composeDown: { status: 'failed', reason: 'docker compose down ended with code 2' },
        }),
      ]),
    )
    expect(screen.getByTestId('run-it-compose-status').textContent).toBe(
      'The containers were not stopped: docker compose down ended with code 2.',
    )
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('stays offered after the compose command stopped (its containers may keep running)', async () => {
    detected = info({
      commands: [compose],
      sessions: [composeSession({ status: 'stopped', endedAt: 9, reason: 'Stopped' })],
    })
    mount()
    await settle()
    expect(screen.getByTestId('run-it-compose-status').textContent).toBe(
      'The containers may still be running. This runs docker compose down.',
    )
  })
})

describe('Settings → Preview', () => {
  it('offers ask, in Dim Factory and in the browser, and writes the user file', async () => {
    expect(OPEN_IN_OPTIONS.map((o) => o.value)).toEqual([...PREVIEW_OPEN_TARGETS])
    mock.on('config.resolve', fakeResolve())
    mock.on('config.patch', () => ({ ok: true }) as never)
    render(
      <Providers>
        <PreviewSection />
      </Providers>,
    )
    await settle(200)
    const ask = screen.getByTestId('preview-open-ask').querySelector('input') as HTMLInputElement
    expect(ask.checked).toBe(true)
    fireEvent.click(screen.getByTestId('preview-open-browser').querySelector('input') as HTMLInputElement)
    await settle()
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/preview/openIn', value: 'browser' }] },
    ])
    expect(screen.getByTestId('preview-open-description').textContent).toContain('default browser')
    expect(bodyText()).not.toContain(EM_DASH)
  })
})
