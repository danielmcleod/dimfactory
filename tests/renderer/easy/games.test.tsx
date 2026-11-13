// "A game" in Easy mode on the mock bridge: the gallery's two game cards (a snake game and a memory game with your
// photos), each with its picture; the photo line once a photo is added; and a game's Done screen: "Your game is
// ready", Play it (the preview window) and Open in browser beside Show the files, the controls on one fixed line read
// from How to play, How to play as the summary's title, and Share it saying anyone with the link can play (with a
// warning when the game shows the user's own photos).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyAttachment, EasyProjectView, EasyState } from '@shared/easy.ts'
import type { PreviewInfo } from '@shared/preview.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { EasyHomePage } from '@renderer/pages/easy/EasyHome.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { resetDraftForTests } from '@renderer/pages/easy/draft.ts'
import {
  CONTROLS_UNKNOWN,
  EXAMPLES,
  HOW_TO_PLAY,
  OPENED_IN_BROWSER,
  PHOTO_PRIVACY_LINE,
  PLAYING,
  SHARE_PHOTOS,
  SHARE_PLAY_INTRO,
  readyTitle,
} from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const FOLDER = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\snake-game-play'

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
  name: 'snake-game-play',
  title: 'Snake game I can play on my phone or laptop',
  kind: 'game',
  idea: EXAMPLES.find((e) => e.kind === 'game')?.text ?? '',
  lastRunId: 'r1',
  lastDisplayNo: 1,
  lastStatus: 'completed',
  updatedAt: 1,
  runs: 1,
}

const PHOTO: EasyAttachment = {
  path: 'C:\\Users\\me\\Pictures\\gran.jpg',
  name: 'gran.jpg',
  bytes: 200_000,
  folder: false,
  dest: 'assets',
}

const SUMMARY = [
  '## What was built',
  'A snake game for your phone and laptop.',
  '',
  '## How to play',
  'Controls: arrow keys or swipe to steer, P or Esc to pause',
  'Eat the apples to grow. Do not hit the walls.',
  '',
  '## How to run it',
  '1. Press Play it.',
].join('\n')

const INFO = (): PreviewInfo => ({
  folder: FOLDER,
  scopeRoot: FOLDER,
  trustFolder: FOLDER,
  runId: 'r1',
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
})

let mock: MockDimFactory
let summary = SUMMARY

beforeEach(() => {
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  clearOutputCache()
  summary = SUMMARY
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [PROJECT],
      'easy.permission': () => ({ folder: FOLDER, at: 1, uses: 0, granted: false, runUses: 0 }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'runs.output': () => ({ text: summary, mtime: 1, version: 1 }),
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
      'preview.detect': INFO,
      'preview.start': (req) => ({
        id: 'pv1',
        folder: FOLDER,
        runId: 'r1',
        commandId: req.commandId,
        label: 'Serve index.html',
        kind: 'static',
        status: 'running',
        url: 'http://127.0.0.1:5000/',
        startedAt: 1,
        tail: [],
        lines: 0,
      }),
      'preview.open': () => undefined,
      'dialog.pickFiles': () => [PHOTO.path],
      'easy.attachCheck': () => [PHOTO],
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

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
  mock.on('runs.get', () => s)
  act(() => {
    applySnapshot(s)
  })
  render(
    <Providers>
      <EasyRunPage runId="r1" />
    </Providers>,
  )
}

describe('the gallery', () => {
  it('has a snake game and a memory game with your photos, each with its own picture', async () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    await settle()
    const snake = screen.getByTestId('easy-example-game')
    const photos = screen.getByTestId('easy-example-game-photos')
    expect(within(snake).getByTestId('easy-thumb-game')).toBeTruthy()
    expect(within(photos).getByTestId('easy-thumb-game-photos')).toBeTruthy()
    // Every card keeps the one fixed height.
    for (const e of EXAMPLES)
      expect(screen.getByTestId(`easy-example-${e.id ?? e.kind}`).className).toContain('h-36')
    fireEvent.click(photos)
    expect(screen.getByTestId<HTMLTextAreaElement>('easy-idea').value).toBe(
      EXAMPLES.find((e) => e.id === 'game-photos')?.text,
    )
  })

  it('says where photos go once one is added', async () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('easy-photo-privacy')).toBeNull()
    fireEvent.click(screen.getByTestId('easy-attach-add'))
    await settle()
    expect(screen.getByTestId('easy-photo-privacy').textContent).toBe(PHOTO_PRIVACY_LINE)
    // Only photos: the photo line says it all.
    expect(screen.queryByTestId('easy-privacy')).toBeNull()
  })
})

describe("a game's Done screen", () => {
  it('Play it, Open in browser, the controls on one fixed line, and How to play', async () => {
    showDone()
    await settle()
    expect(screen.getByTestId('easy-done-title').textContent).toBe(readyTitle('game'))
    expect(screen.queryByTestId('easy-open-it')).toBeNull()
    expect(screen.getByTestId('easy-play-it').textContent).toBe('Play it')
    expect(screen.getByTestId('easy-open-browser').textContent).toBe('Open in browser')
    expect(screen.getByTestId('easy-show-files')).toBeTruthy()
    const controls = screen.getByTestId('easy-controls')
    expect(controls.textContent).toBe('Controls: arrow keys or swipe to steer, P or Esc to pause')
    expect(controls.className).toContain('h-5')
    expect(controls.className).toContain('truncate')
    const explain = screen.getByTestId('easy-done-explain')
    expect(within(explain).getByRole('heading', { level: 2 }).textContent).toBe(HOW_TO_PLAY)
    expect(within(explain).getByTestId('easy-explain-text').textContent).toContain('Eat the apples')

    fireEvent.click(screen.getByTestId('easy-play-it'))
    await settle()
    expect(mock.callsOf('preview.open')).toEqual([{ sessionId: 'pv1', target: 'app' }])
    expect(screen.getByTestId('easy-open-note').textContent).toBe(PLAYING)
    fireEvent.click(screen.getByTestId('easy-open-browser'))
    await settle()
    expect(mock.callsOf('preview.open')).toEqual([
      { sessionId: 'pv1', target: 'app' },
      { sessionId: 'pv1', target: 'browser' },
    ])
    expect(screen.getByTestId('easy-open-note').textContent).toBe(OPENED_IN_BROWSER)
  })

  it('keeps the controls line when the summary names no controls', async () => {
    summary = '## What was built\nA game.'
    showDone()
    await settle()
    expect(screen.getByTestId('easy-controls').textContent).toBe(`Controls: ${CONTROLS_UNKNOWN}`)
  })

  it('Share it says anyone with the link can play, and warns when it shows your photos', async () => {
    showDone()
    await settle()
    const share = screen.getByTestId('easy-done-share')
    expect(share.textContent).toContain(SHARE_PLAY_INTRO)
    expect(within(share).queryByTestId('easy-share-photos')).toBeNull()
  })

  it('warns that sharing a game with your photos shares them', async () => {
    mock.on('easy.projects', () => [{ ...PROJECT, photos: true }])
    showDone()
    await settle()
    expect(screen.getByTestId('easy-share-photos').textContent).toBe(SHARE_PHOTOS)
  })
})
