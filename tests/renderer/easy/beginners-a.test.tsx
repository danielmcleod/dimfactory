// Beginners, part A on the mock bridge: the confirm screen for a website or app (How it is built: React by default with
// Plain HTML as an option; without Node.js, or with one too old, why and how to install it, with Check again), What it
// needs (one plain question, what each answer adds and costs and which free hosts cover it, the other needs decided and
// changeable), What will work, the checks it runs before it is ready, the OneDrive line; and "Get it ready to share" in
// the Deploy panel (asks to trust the build first, then builds and reads the folder again). Buttons keep their labels;
// no em dashes.
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEPLOY_COMMANDS_CAVEAT, DEPLOY_COST_CAVEAT, DEPLOY_SECURITY_CAVEAT } from '@shared/deploy.ts'
import type { DeployBuildResult, DeployReport } from '@shared/deploy.ts'
import type { EasyResolved, EasyState } from '@shared/easy.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { DeployPanel } from '@renderer/components/deploy/DeployPanel.tsx'
import { BUILD_LABEL, buildDoneLine, buildTrustText } from '@renderer/components/deploy/text.ts'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import {
  NEED_CHOICE_TEXT,
  NO_NEEDS_TEXT,
  ONEDRIVE_NOTE,
  STACK_TEXT,
  checksText,
  needQuestion,
  noReactText,
  nodeInstallSteps,
} from '@renderer/pages/easy/text.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const PROJECTS = 'C:\\Users\\me\\Dim Factory Projects'

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
  defaultProjectsReason: 'onedrive',
}

const RESOLVED: EasyResolved = {
  idea: 'An AI caption writer app with a sign-up form for our newsletter',
  kind: 'app',
  kindSource: 'words',
  template: { id: 'react-site', label: 'Website or app (React)' },
  recipe: 'easy-software',
  folder: `${PROJECTS}\\ai-caption-writer`,
  folderName: 'ai-caption-writer',
  projectsDir: PROJECTS,
  research: true,
  estimate: null,
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: true, python: false, nodeVersion: '22.12.0' },
  stack: { chosen: 'react', react: true },
  needs: [
    { need: 'ai', choices: ['proxy', 'keyless', 'none'], recommended: 'proxy' },
    { need: 'forms', choices: ['email', 'list', 'none'], recommended: 'email', signup: true },
  ],
  checks: ['Tests', 'Build', 'Page loads (Dim Factory)'],
}

let mock: MockDimFactory
let resolved: EasyResolved

beforeEach(() => {
  resetBridgeForTests()
  resetDraftForTests()
  resolved = RESOLVED
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.resolve': (req) =>
        req.stack === 'html'
          ? {
              ...resolved,
              template: { id: 'static-site', label: 'Static website' },
              stack: { chosen: 'html', react: true },
              checks: ['Site check', 'Page loads (Dim Factory)'],
            }
          : resolved,
      'easy.create': () => ({ runId: 'r9', displayNo: 9, folder: RESOLVED.folder }),
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
    },
  })
  setEasyStateForTests(STATE)
})
afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

async function showConfirm(): Promise<void> {
  setDraft({ idea: RESOLVED.idea })
  render(
    <Providers>
      <EasyNewPage />
    </Providers>,
  )
  await settle()
}

describe('how it is built', () => {
  it('React by default; Plain HTML asks core again and is what Start sends', async () => {
    await showConfirm()
    const react = screen.getByTestId('easy-stack-react')
    const html = screen.getByTestId('easy-stack-html')
    expect(react.textContent).toBe(STACK_TEXT.react)
    expect(html.textContent).toBe(STACK_TEXT.html)
    expect(react.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('easy-confirm-checks').textContent).toBe(checksText(RESOLVED.checks ?? []))
    expect(screen.getByTestId('easy-confirm-checks').textContent).toBe(
      'Before it says it is ready, it runs its tests, builds it and opens the page to check it loads without errors.',
    )
    fireEvent.click(html)
    await settle()
    expect(mock.callsOf('easy.resolve').at(-1)).toEqual({ idea: RESOLVED.idea, stack: 'html' })
    expect(screen.getByTestId('easy-stack-html').getAttribute('aria-pressed')).toBe('true')
    // The button keeps its label when pressed.
    expect(screen.getByTestId('easy-stack-html').textContent).toBe(STACK_TEXT.html)
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')[0]).toMatchObject({ stack: 'html', needs: {} })
  })

  it('without Node.js: plain HTML, why, how to install Node.js, and Check again reads it afresh', async () => {
    resolved = {
      ...RESOLVED,
      template: { id: 'static-site', label: 'Static website' },
      toolchain: { node: false, python: false, nodeVersion: null },
      stack: { chosen: 'html', react: false },
      checks: ['Page loads (Dim Factory)'],
    }
    await showConfirm()
    expect(screen.queryByTestId('easy-stack-react')).toBeNull()
    expect(screen.getByTestId('easy-stack-why').textContent).toBe(noReactText(null, false))
    expect(screen.getByTestId('easy-stack-why').textContent).toMatch(/^Node\.js is not installed/)
    const steps = within(screen.getByTestId('easy-node-steps'))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(steps).toEqual(nodeInstallSteps('win32'))
    expect(steps.join(' ')).toMatch(/winget install OpenJS\.NodeJS\.LTS/)
    fireEvent.click(screen.getByTestId('easy-node-check-again'))
    await settle()
    expect(mock.callsOf('easy.resolve').at(-1)).toEqual({ idea: RESOLVED.idea, recheck: true })
  })

  it('with a Node.js too old for React: says which and what is needed', async () => {
    resolved = {
      ...RESOLVED,
      template: { id: 'static-site', label: 'Static website' },
      toolchain: { node: false, python: false, nodeVersion: '18.20.4', nodeOld: true },
      stack: { chosen: 'html', react: false },
    }
    await showConfirm()
    expect(screen.getByTestId('easy-stack-why').textContent).toBe(
      "Node.js 18.20.4 is installed, but React's build tools need 20.19 or newer, so it is made with plain HTML: files that open in any browser. To make it with React instead, install Node.js 22 or newer, then press Check again.",
    )
  })
})

describe('what it needs', () => {
  it('one plain question, what each answer adds and costs, the rest decided and changeable, what will work', async () => {
    await showConfirm()
    expect(screen.getByTestId('easy-need-question').textContent).toBe(needQuestion('ai', false))
    expect(screen.getByTestId('easy-need-ai-proxy').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('easy-need-cost').textContent).toBe(NEED_CHOICE_TEXT.ai.proxy?.cost)
    expect(screen.getByTestId('easy-need-cost').textContent).toMatch(/Check the provider's current pricing/)
    expect(screen.getByTestId('easy-need-hosts').textContent).toMatch(/Netlify or Cloudflare Pages/)
    const works = (): (string | null)[] =>
      within(screen.getByTestId('easy-works-lines'))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    expect(works()).toEqual([
      NEED_CHOICE_TEXT.ai.proxy?.works,
      'Sign-ups are emailed to you; nothing is stored in the site.',
    ])
    fireEvent.click(screen.getByTestId('easy-need-ai-none'))
    await settle()
    expect(screen.getByTestId('easy-need-cost').textContent).toBe('Free.')
    expect(works()[0]).toBe(NEED_CHOICE_TEXT.ai.none?.works)
    // The other need is decided for the user, in a dropdown they can change.
    expect(screen.getByTestId('easy-need-select-forms').textContent).toContain(
      NEED_CHOICE_TEXT.forms.email?.label,
    )
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')[0]).toMatchObject({ stack: 'react', needs: { ai: 'none' } })
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })

  it('nothing beyond the page: says it can go on any free host', async () => {
    const { needs: _n, ...rest } = RESOLVED
    resolved = rest
    await showConfirm()
    expect(screen.queryByTestId('easy-confirm-needs')).toBeNull()
    expect(screen.getByTestId('easy-confirm-works').textContent).toContain(NO_NEEDS_TEXT)
  })

  it('says why new projects are not in Documents when OneDrive syncs it', async () => {
    await showConfirm()
    expect(screen.getByTestId('easy-onedrive-note').textContent).toBe(ONEDRIVE_NOTE)
  })
})

describe('Get it ready to share', () => {
  const FOLDER = 'C:\\work\\caption'
  const report = (ready: boolean): DeployReport => ({
    folder: FOLDER,
    category: 'software',
    cls: {
      id: 'spa',
      label: 'Single-page app',
      source: 'folder',
      confidence: 'high',
      reasons: [],
      alternatives: [],
    },
    classes: [{ id: 'spa', label: 'Single-page app' }],
    options: [],
    target: null,
    checklist: [],
    env: [],
    caveats: { cost: DEPLOY_COST_CAVEAT, security: DEPLOY_SECURITY_CAVEAT, commands: DEPLOY_COMMANDS_CAVEAT },
    notes: [],
    upload: {
      dir: 'dist',
      ready,
      game: false,
      build: { command: 'npm run build' },
      ...(ready ? {} : { problem: 'There is no dist/ folder yet.' }),
    },
  })

  it('asks to trust the build first, then builds and reads the folder again', async () => {
    let built = false
    const answers: DeployBuildResult[] = [
      {
        status: 'trust',
        command: 'npm run build',
        body: '{"build":"tsc --noEmit && vite build"}',
        hash: 'a'.repeat(64),
      },
      { status: 'built', dir: 'dist', durationMs: 4200 },
    ]
    const m = setUp({
      handlers: {
        'deploy.inspect': () => report(built),
        'deploy.build': () => {
          const next = answers.shift() as DeployBuildResult
          if (next.status === 'built') built = true
          return next
        },
      },
    })
    try {
      render(
        <Providers>
          <DeployPanel target={{ folder: FOLDER }} />
        </Providers>,
      )
      await settle()
      const run = screen.getByTestId('deploy-build-run')
      expect(run.textContent).toBe(BUILD_LABEL)
      expect(screen.getByTestId('deploy-upload').getAttribute('data-ready')).toBe('false')
      expect(m.callsOf('deploy.build')).toEqual([])
      fireEvent.click(run)
      await settle()
      expect(screen.getByTestId('deploy-build-trust').textContent).toContain(buildTrustText('npm run build'))
      expect(screen.getByTestId('deploy-build-script').textContent).toContain('vite build')
      fireEvent.click(screen.getByTestId('deploy-build-trust-ok'))
      await settle()
      expect(m.callsOf('deploy.build')).toEqual([
        { folder: FOLDER },
        { folder: FOLDER, trustHash: 'a'.repeat(64) },
      ])
      expect(screen.getByTestId('deploy-build-status').textContent).toBe(buildDoneLine('dist', 4200))
      expect(screen.getByTestId('deploy-build-run').textContent).toBe(BUILD_LABEL)
      expect(screen.getByTestId('deploy-upload').getAttribute('data-ready')).toBe('true')
      expect(document.body.textContent ?? '').not.toContain(EM_DASH)
    } finally {
      tearDown(m)
    }
  })
})
