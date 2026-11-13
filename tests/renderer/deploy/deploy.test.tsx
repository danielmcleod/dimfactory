// The Deploy helper's renderer: the Deploy panel (collapsed in "After the run" until opened; the class with the class
// picker, the options with the cost caveat, the checklist where nothing manual reads "Checked" and a tick reads
// "Ticked by you", the steps as commands to copy with their caveat, the run's Deploy step line), the Commit and PR
// panel (hidden when the project did not turn them on; Commit with its message, a refusal with commands to copy; the
// confirmation card names the repository and branch, and git.prCreate is called only from its confirm button, with
// exactly what the card named), and the Settings values. No em dashes anywhere.
import '../helpers/rtl.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEPLOY_COMMANDS_CAVEAT, DEPLOY_COST_CAVEAT, DEPLOY_SECURITY_CAVEAT } from '@shared/deploy.ts'
import type { CommitPreview, DeployReport, DeployRunView, PrPreview } from '@shared/deploy.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import { DeployPanel } from '@renderer/components/deploy/DeployPanel.tsx'
import {
  CANCEL_LABEL,
  COMMIT_LABEL,
  CommitPanel,
  PR_CONFIRM_LABEL,
  PR_LABEL,
} from '@renderer/components/deploy/CommitPanel.tsx'
import { classLine, deployStepLine, prConfirmText } from '@renderer/components/deploy/text.ts'
import { deploySettingsOf } from '@renderer/pages/settings/DeploySection.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\work\\shop'
const bodyText = (): string => document.body.textContent ?? ''

const report = (over: Partial<DeployReport> = {}): DeployReport => ({
  folder: FOLDER,
  category: 'software',
  cls: {
    id: 'server-app',
    label: 'Server app',
    source: 'folder',
    confidence: 'high',
    reasons: ['package.json depends on express'],
    alternatives: ['container'],
  },
  classes: [
    { id: 'server-app', label: 'Server app' },
    { id: 'container', label: 'Container' },
  ],
  options: [
    {
      id: 'render',
      label: 'Render',
      packId: 'software',
      freeTier: 'A free instance type that sleeps when idle.',
      cost: 'Paid instances from a few dollars a month.',
      coldStarts: 'Yes on the free tier.',
      customDomains: 'Yes.',
      dataResidency: 'Choose a region.',
      configs: [],
      steps: [{ id: 'render:1', label: 'Create a web service from the repository', shell: 'powershell' }],
      recommended: true,
    },
    {
      id: 'fly',
      label: 'Fly.io',
      packId: 'software',
      freeTier: 'Varies; check the current offer.',
      cost: 'Pay for what runs.',
      coldStarts: 'Optional (machines can stop when idle).',
      customDomains: 'Yes.',
      dataResidency: 'Choose regions.',
      configs: [{ kind: 'fly', path: 'fly.toml', purpose: 'Fly.io app settings', present: false }],
      needs: 'flyctl',
      steps: [
        { id: 'fly:launch', label: 'Create the app', command: 'fly launch --no-deploy', shell: 'powershell' },
        { id: 'fly:deploy', label: 'Deploy', command: 'fly deploy', shell: 'powershell' },
      ],
      recommended: false,
    },
  ],
  target: 'render',
  checklist: [
    {
      id: 'secrets',
      label: 'No secrets committed',
      state: 'ok',
      auto: true,
      detail: 'No secret found in 3 files.',
    },
    {
      id: 'env-vars',
      label: 'Environment variables listed',
      state: 'warn',
      auto: true,
      detail: 'The code reads 1 variable that .env.example does not list.',
      evidence: ['DATABASE_URL'],
    },
    {
      id: 'https',
      label: 'HTTPS only',
      state: 'not-checked',
      auto: false,
      detail: 'Dim Factory cannot check this.',
    },
  ],
  env: [{ name: 'DATABASE_URL', files: ['server.js'], inExample: false }],
  caveats: { cost: DEPLOY_COST_CAVEAT, security: DEPLOY_SECURITY_CAVEAT, commands: DEPLOY_COMMANDS_CAVEAT },
  notes: [],
  ...over,
})

let mock: MockDimFactory
let current: DeployReport

describe('the Deploy panel', () => {
  beforeEach(() => {
    current = report()
    mock = setUp({
      handlers: {
        'deploy.inspect': (req) =>
          req.cls === 'container'
            ? report({ cls: { ...current.cls, id: 'container', label: 'Container', source: 'user' } })
            : current,
        'deploy.tick': (req) => ({ ticks: req.ticked ? { [req.item]: 42 } : {} }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  it('reads nothing until opened in After the run', async () => {
    render(
      <Providers>
        <DeployPanel target={{ runId: 'run-1' }} collapsible />
      </Providers>,
    )
    await settle()
    expect(mock.callsOf('deploy.inspect')).toEqual([])
    const toggle = screen.getByTestId('deploy-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    await settle()
    expect(mock.callsOf('deploy.inspect')).toEqual([{ runId: 'run-1' }])
    expect(screen.getByTestId('deploy-class-line').getAttribute('data-class')).toBe('server-app')
  })

  it('shows the class, the options with the cost caveat, the checklist and the steps with their caveat', async () => {
    render(
      <Providers>
        <DeployPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('deploy-class-line').textContent).toContain(classLine(current.cls))
    expect(screen.getByTestId('deploy-option-render')).toBeTruthy()
    expect(screen.getByTestId('deploy-option-fly')).toBeTruthy()
    expect(screen.getByTestId('deploy-cost-caveat').textContent).toContain(DEPLOY_COST_CAVEAT)
    expect(screen.getByTestId('deploy-security-caveat').textContent).toContain(DEPLOY_SECURITY_CAVEAT)
    expect(screen.getByTestId('deploy-commands-caveat').textContent).toContain(DEPLOY_COMMANDS_CAVEAT)
    // A manual item reads "Not checked", never "Checked"; an automatic warn reads "Check this".
    expect(screen.getByTestId('deploy-check-https-state').textContent).toBe('Not checked')
    expect(screen.getByTestId('deploy-check-secrets-state').textContent).toBe('Checked')
    expect(screen.getByTestId('deploy-check-env-vars-state').textContent).toBe('Check this')
    expect(screen.queryByTestId('deploy-tick-secrets')).toBeNull()
    // Nothing claims free or secure on its own.
    expect(bodyText()).not.toMatch(/\bis free\b|\bis secure\b/i)
    expect(bodyText()).not.toContain(EM_DASH)

    // Choosing Fly.io shows its commands to copy.
    fireEvent.click(screen.getByTestId('deploy-option-fly'))
    await settle()
    const steps = screen.getAllByTestId('deploy-step-command').map((e) => e.textContent)
    expect(steps).toEqual(['fly launch --no-deploy', 'fly deploy'])
    expect(screen.getByTestId('deploy-step-copy-fly:deploy')).toBeTruthy()
  })

  it('a tick is kept for the folder and reads "Ticked by you"', async () => {
    render(
      <Providers>
        <DeployPanel target={{ folder: FOLDER }} />
      </Providers>,
    )
    await settle()
    fireEvent.click(screen.getByTestId('deploy-tick-https'))
    await settle()
    expect(mock.callsOf('deploy.tick')).toEqual([{ folder: FOLDER, item: 'https', ticked: true }])
    expect(screen.getByTestId('deploy-check-https').getAttribute('data-ticked')).toBe('true')
    expect(screen.getByTestId('deploy-check-https-state').textContent).toBe('Ticked by you')
  })

  it("shows the run's Deploy step line", async () => {
    const step: DeployRunView = {
      phase: 'done',
      target: { id: 'fly', label: 'Fly.io' },
      files: [{ kind: 'fly', path: 'fly.toml', purpose: 'Fly.io app settings' }],
      present: [],
      env: [],
      written: ['fly.toml'],
    }
    render(
      <Providers>
        <DeployPanel target={{ runId: 'run-1' }} step={step} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('deploy-step-line').textContent).toContain(
      'The Deploy step wrote fly.toml for Fly.io. Review them in the Diff tab before you deploy.',
    )
  })
})

describe('deployStepLine', () => {
  it('says what the step is doing or did', () => {
    const base: DeployRunView = { phase: 'planning', files: [], present: [], env: [] }
    expect(deployStepLine(undefined)).toBeNull()
    expect(deployStepLine(base)).toBe('The Deploy step is reading the folder to pick a target.')
    expect(
      deployStepLine({
        ...base,
        phase: 'generating',
        target: { id: 'netlify', label: 'Netlify' },
        files: [{ kind: 'netlify', path: 'netlify.toml', purpose: 'x' }],
      }),
    ).toBe('The Deploy step is writing netlify.toml for Netlify.')
    expect(deployStepLine({ ...base, phase: 'done', note: 'Nothing to write.' })).toBe('Nothing to write.')
  })
})

const commitPreview = (over: Partial<CommitPreview> = {}): CommitPreview => ({
  runId: 'run-1',
  enabled: true,
  where: 'run-branch',
  branch: 'dim/run-7',
  paths: ['fly.toml', 'server.js'],
  message: 'Add a health check (run #7)\n\nDim Factory run #7.',
  ...over,
})

const prPreview = (over: Partial<PrPreview> = {}): PrPreview => ({
  runId: 'run-1',
  enabled: true,
  remote: 'origin',
  remoteUrl: 'https://github.com/acme/shop.git',
  repo: 'acme/shop',
  branch: 'dim/run-7',
  base: 'main',
  title: 'Add a health check (run #7)',
  body: 'body',
  commands: [
    {
      id: 'pr:push',
      label: 'Push dim/run-7 to origin',
      command: 'git push -u origin dim/run-7',
      shell: 'powershell',
    },
    {
      id: 'pr:create',
      label: 'Open the pull request',
      command: 'gh pr create --base main --head dim/run-7',
      shell: 'powershell',
    },
  ],
  gh: { installed: true, authenticated: true, version: '2.99.0', fixes: [] },
  ...over,
})

describe('the Commit and PR panel', () => {
  let commit: CommitPreview
  let pr: PrPreview
  beforeEach(() => {
    commit = commitPreview()
    pr = prPreview({ blocked: "Commit the run's changes first (Commit to run branch)." })
    mock = setUp({
      handlers: {
        'git.commitPreview': () => commit,
        'git.prPreview': () => pr,
        'git.commit': () => {
          commit = commitPreview({
            committed: { sha: 'abcdef1234567', branch: 'dim/run-7', at: 1 },
            blocked: 'done',
          })
          pr = prPreview()
          return { sha: 'abcdef1234567', branch: 'dim/run-7', paths: ['fly.toml', 'server.js'], notes: [] }
        },
        'git.prCreate': () => ({ url: 'https://github.com/acme/shop/pull/7', pushed: true, notes: [] }),
      },
    })
  })
  afterEach(() => tearDown(mock))

  const mount = (): void => {
    render(
      <Providers>
        <CommitPanel runId="run-1" />
      </Providers>,
    )
  }

  it('is not there when the project turned neither on', async () => {
    commit = commitPreview({ enabled: false, blocked: 'off' })
    pr = prPreview({ enabled: false, blocked: 'off' })
    mount()
    await settle()
    expect(screen.queryByTestId('commit-panel')).toBeNull()
  })

  it('commits with the message, then the PR asks for confirmation naming the repository and branch', async () => {
    mount()
    await settle()
    expect(screen.getByTestId('commit-intro').textContent).toContain('dim/run-7')
    expect(screen.getByTestId('commit-intro').textContent).toContain(
      'Your other staged changes stay as they are.',
    )
    expect(screen.getByTestId('commit-button').textContent).toContain(COMMIT_LABEL)
    // Before the commit, the PR button is held back; the commands can still be copied.
    expect(screen.getByTestId<HTMLButtonElement>('pr-button').disabled).toBe(true)
    expect(screen.getByTestId('pr-commands')).toBeTruthy()

    fireEvent.click(screen.getByTestId('commit-button'))
    await settle()
    expect(mock.callsOf('git.commit')).toEqual([{ runId: 'run-1' }])

    const prButton = screen.getByTestId<HTMLButtonElement>('pr-button')
    expect(prButton.textContent).toContain(PR_LABEL)
    expect(prButton.disabled).toBe(false)
    fireEvent.click(prButton)
    await settle()
    // Clicking Create PR only opens the card: nothing is pushed yet.
    expect(mock.callsOf('git.prCreate')).toEqual([])
    const card = screen.getByTestId('pr-confirm')
    expect(card.getAttribute('role')).toBe('alertdialog')
    expect(screen.getByTestId('pr-confirm-repo').textContent).toBe('acme/shop')
    expect(screen.getByTestId('pr-confirm-branch').textContent).toBe('dim/run-7')
    expect(screen.getByTestId('pr-confirm-text').textContent).toBe(prConfirmText(pr))
    expect(screen.getByTestId('pr-cancel').textContent).toContain(CANCEL_LABEL)

    fireEvent.click(screen.getByTestId('pr-confirm-button'))
    await settle()
    expect(mock.callsOf('git.prCreate')).toEqual([
      { runId: 'run-1', confirm: { remote: 'origin', repo: 'acme/shop', branch: 'dim/run-7' } },
    ])
    expect(screen.getByTestId('pr-open-link')).toBeTruthy()
    expect(bodyText()).not.toContain(EM_DASH)
  })

  it('Cancel closes the card without pushing', async () => {
    pr = prPreview()
    commit = commitPreview({
      committed: { sha: 'abcdef1234567', branch: 'dim/run-7', at: 1 },
      blocked: 'done',
    })
    mount()
    await settle()
    fireEvent.click(screen.getByTestId('pr-button'))
    await settle()
    expect(screen.getByTestId('pr-confirm-button').textContent).toContain(PR_CONFIRM_LABEL)
    fireEvent.click(screen.getByTestId('pr-cancel'))
    await settle()
    expect(screen.queryByTestId('pr-confirm')).toBeNull()
    expect(mock.callsOf('git.prCreate')).toEqual([])
  })

  it('a missing gh is a note with fixes to copy, never a blocker for copying', async () => {
    pr = prPreview({
      gh: {
        installed: false,
        authenticated: false,
        problem: 'The GitHub CLI (gh) is not installed.',
        fixes: [
          {
            id: 'gh:install',
            label: 'Install',
            command: 'winget install --id GitHub.cli -e',
            shell: 'powershell',
          },
        ],
      },
      blocked: 'The GitHub CLI (gh) is not installed.',
    })
    mount()
    await settle()
    expect(screen.getByTestId('pr-gh').textContent).toContain('not installed')
    expect(screen.getByTestId('pr-gh-fixes').textContent).toContain('winget install --id GitHub.cli -e')
    expect(screen.getByTestId('pr-commands').textContent).toContain('git push -u origin dim/run-7')
  })

  it('a refused commit shows why and the commands to copy', async () => {
    mock.on('git.commit', () => {
      throw mockError('CONFLICT', 'Your staged content differs.', {
        commands: ['git restore --staged -- server.js'],
      })
    })
    mount()
    await settle()
    fireEvent.click(screen.getByTestId('commit-button'))
    await settle()
    expect(screen.getByTestId('commit-refused').textContent).toContain('Your staged content differs.')
    expect(screen.getByTestId('commit-commands').textContent).toContain('git restore --staged -- server.js')
  })
})

describe('Settings, Deploy values', () => {
  it('are core resolved values with pending writes shown, and off by default', () => {
    const view = { config: { passes: { implement: {} }, git: {} } } as unknown as ResolvedWithProvenance
    expect(deploySettingsOf(view, {})).toEqual({
      deploy: false,
      deployTarget: null,
      commit: false,
      pullRequest: false,
      remote: 'origin',
    })
    expect(
      deploySettingsOf(view, { '/git/commit': true, '/passes/implement/deployTarget': 'fly' }),
    ).toMatchObject({
      commit: true,
      deployTarget: 'fly',
    })
    expect(deploySettingsOf(null, {})).toBeNull()
  })
})
