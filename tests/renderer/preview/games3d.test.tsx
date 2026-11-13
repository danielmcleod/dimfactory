// The optional light 3D game on Easy's confirm screen, on the mock bridge: with Node.js the 3D template says it uses
// three.js, installed into the project (needs Node); without Node.js it says the game starts in 2D and why. The line
// holds its place either way (reserved height), and there are no em dashes.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EasyResolved, EasyState } from '@shared/easy.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const PROJECTS = 'C:\\Users\\me\\Documents\\Dim Factory Projects'
const IDEA = 'A 3D marble game where you tilt the board'

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
  projectsDir: PROJECTS,
  defaultProjectsDir: PROJECTS,
}

const WITH_NODE: EasyResolved = {
  idea: IDEA,
  kind: 'game',
  kindSource: 'words',
  template: { id: 'game-3d-lite', label: 'Light 3D game (three.js)' },
  installs: ['three.js'],
  recipe: 'easy-game',
  folder: `${PROJECTS}\\3d-marble-game`,
  folderName: '3d-marble-game',
  projectsDir: PROJECTS,
  research: true,
  estimate: null,
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: true, python: false },
}

const { installs: _installs, ...NO_INSTALLS } = WITH_NODE
const WITHOUT_NODE: EasyResolved = {
  ...NO_INSTALLS,
  template: { id: 'game-canvas', label: 'Arcade game (canvas)' },
  fallback: { wanted: { id: 'game-3d-lite', label: 'Light 3D game (three.js)' }, needs: 'node' },
  toolchain: { node: false, python: false },
}

describe("Easy's confirm screen for a 3D game", () => {
  let mock: MockDimFactory
  beforeEach(() => {
    resetBridgeForTests()
    streamBuffer.reset()
    resetDraftForTests()
    mock = setUp({
      handlers: {
        'easy.state': () => STATE,
        'easy.projects': () => [],
        'easy.resolve': () => WITH_NODE,
      },
    })
    setEasyStateForTests(STATE)
  })
  afterEach(() => {
    setEasyStateForTests(null)
    tearDown(mock)
  })

  const show = async (): Promise<HTMLElement> => {
    setDraft({ idea: IDEA })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    return screen.getByTestId('easy-confirm-fallback')
  }

  it('with Node.js: starts from the 3D template and says three.js is installed into the project', async () => {
    const line = await show()
    expect(screen.getByTestId('easy-confirm-kind').textContent).toContain(
      'Starts from: Light 3D game (three.js).',
    )
    expect(line.textContent).toBe('Uses three.js, installed into the project (needs Node).')
    expect(line.className).toContain('min-h-5')
    expect(document.body.textContent).not.toContain(EM_DASH)
  })

  it('without Node.js: starts in 2D and says why', async () => {
    mock.on('easy.resolve', () => WITHOUT_NODE)
    const line = await show()
    expect(screen.getByTestId('easy-confirm-kind').textContent).toContain(
      'Starts from: Arcade game (canvas).',
    )
    expect(line.textContent).toBe(
      'A 3D game uses three.js, which is installed into the project with Node.js. Node.js is not installed, so it starts as a 2D game that needs nothing installed.',
    )
    expect(line.textContent).not.toContain('Uses three.js')
    expect(document.body.textContent).not.toContain(EM_DASH)
  })
})
