// Games phase 3 in the renderer, on the mock bridge:
// - Run it for a game: Phone size, a toggle (aria-pressed) that sends preview.phone and follows the session's `phone`;
//   its label never changes.
// - Easy's confirm screen for a game whose idea asks for online multiplayer: it says Easy does not make games that need
//   a server, offers pass and play or play by link (one pressed), and starts with the one chosen.
// No em dashes anywhere.
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyResolved, EasyState } from '@shared/easy.ts'
import type { PreviewInfo, PreviewSessionView } from '@shared/preview.ts'
import { RunItPanel } from '@renderer/components/run/RunItPanel.tsx'
import { PHONE_SIZE_LABEL } from '@renderer/components/run/GamePreview.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { resetPreviewsForTests } from '@renderer/state/previews.ts'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { MULTIPLAYER_HINT, ONLINE_TITLE } from '@renderer/pages/easy/text.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\snake-game'
const bodyText = (): string => document.body.innerText ?? document.body.textContent ?? ''

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
  ...over,
})

const INFO = (sessions: PreviewSessionView[]): PreviewInfo => ({
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
  sessions,
  smoke: null,
  openIn: 'app',
})

describe('Run it: Phone size', () => {
  let mock: MockDimFactory
  let phone = false
  beforeEach(() => {
    resetPreviewsForTests()
    phone = false
    mock = setUp({
      handlers: {
        'preview.detect': () => INFO([SESSION(phone ? { phone: true } : {})]),
        'preview.phone': (req) => {
          phone = req.phone
          return SESSION(phone ? { phone: true } : {})
        },
        'preview.open': () => undefined,
      },
    })
  })
  afterEach(() => tearDown(mock))

  it('is a toggle that sends preview.phone and keeps its label', async () => {
    render(
      <Providers>
        <RunItPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    const button = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('run-it-phone')
    expect(button().textContent).toBe(PHONE_SIZE_LABEL)
    expect(button().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button())
    await settle()
    expect(mock.callsOf('preview.phone')).toEqual([{ sessionId: 'pv1', phone: true }])
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(button().textContent).toBe(PHONE_SIZE_LABEL)
    fireEvent.click(button())
    await settle()
    expect(mock.callsOf('preview.phone')).toEqual([
      { sessionId: 'pv1', phone: true },
      { sessionId: 'pv1', phone: false },
    ])
    expect(button().getAttribute('aria-pressed')).toBe('false')
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('is not offered for a preview that is not a game', async () => {
    mock.on('preview.detect', () => {
      const { game: _g, ...rest } = SESSION({ network: 'internet' })
      return INFO([rest])
    })
    render(
      <Providers>
        <RunItPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('run-it-phone')).toBeNull()
  })
})

describe('Easy: an idea that asks for online multiplayer', () => {
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
  const RESOLVED: EasyResolved = {
    idea: 'An online multiplayer checkers game',
    kind: 'game',
    kindSource: 'words',
    template: { id: 'game-board', label: 'Puzzle, word or board game' },
    recipe: 'easy-game',
    online: { instead: 'pass-and-play' },
    folder: 'C:\\Users\\me\\Documents\\Dim Factory Projects\\online-multiplayer-checkers',
    folderName: 'online-multiplayer-checkers',
    projectsDir: 'C:\\Users\\me\\Documents\\Dim Factory Projects',
    research: true,
    estimate: null,
    limits: { maxCostUsd: null, maxMinutes: null },
    vendors: { claude: true, codex: false, ready: true },
    toolchain: { node: true, python: false },
  }
  let mock: MockDimFactory
  beforeEach(() => {
    resetBridgeForTests()
    streamBuffer.reset()
    resetDraftForTests()
    mock = setUp({
      handlers: {
        'easy.state': () => STATE,
        'easy.projects': () => [],
        'easy.resolve': () => RESOLVED,
        'easy.create': () => ({ runId: 'r9', displayNo: 9, folder: RESOLVED.folder }),
      },
    })
    setEasyStateForTests(STATE)
  })
  afterEach(() => {
    setEasyStateForTests(null)
    tearDown(mock)
  })

  it('says Easy does not make it, offers pass and play or play by link, and starts with the one chosen', async () => {
    setDraft({ idea: RESOLVED.idea })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    const section = screen.getByTestId('easy-online')
    expect(section.textContent).toContain(ONLINE_TITLE)
    expect(section.textContent).toContain('Easy does not make games that need a server.')
    const pass = screen.getByTestId('easy-online-pass-and-play')
    const link = screen.getByTestId('easy-online-play-by-link')
    expect(pass.getAttribute('aria-pressed')).toBe('true')
    expect(link.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('easy-online-hint').textContent).toBe(MULTIPLAYER_HINT['pass-and-play'])
    fireEvent.click(link)
    await settle()
    expect(link.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('easy-online-hint').textContent).toBe(MULTIPLAYER_HINT['play-by-link'])
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')).toEqual([
      {
        idea: RESOLVED.idea,
        kind: 'game',
        folder: RESOLVED.folder,
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: false,
        multiplayer: 'play-by-link',
      },
    ])
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('shows nothing about online play for other ideas', async () => {
    const { online: _o, ...plain } = RESOLVED
    mock.on('easy.resolve', () => ({ ...plain, idea: 'A snake game' }))
    setDraft({ idea: 'A snake game' })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('easy-online')).toBeNull()
  })
})
