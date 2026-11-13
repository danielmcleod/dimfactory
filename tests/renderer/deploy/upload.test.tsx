// "Make an upload file" in the Deploy panel (Full mode's Deploy helper; Easy mode's Share it shows the same panel):
// offered only when core says the class is static; the plain steps (itch.io only for a game) and "Putting it online
// makes it public."; Make an upload file calls deploy.uploadFile, then the status says
// what was made and Show the file reveals it (shell.open uploadFile); a refusal lists what the secret scanner found;
// Open Netlify Drop opens only on a click, through shell.open's https allowlist; a folder not built yet holds the
// button back with the reason. The buttons keep their labels; nothing is called before a click. No em dashes.
import '../helpers/rtl.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEPLOY_COMMANDS_CAVEAT,
  DEPLOY_COST_CAVEAT,
  DEPLOY_SECURITY_CAVEAT,
  NETLIFY_DROP_URL,
} from '@shared/deploy.ts'
import type { DeployReport, DeployUploadResult } from '@shared/deploy.ts'
import { DeployPanel } from '@renderer/components/deploy/DeployPanel.tsx'
import {
  UPLOAD_MAKE,
  UPLOAD_NETLIFY,
  UPLOAD_PUBLIC,
  UPLOAD_SHOW,
  uploadMadeLine,
  uploadSteps,
} from '@renderer/components/deploy/text.ts'
import { SHARE_HIDE, SHARE_INTRO, SHARE_PLAY_INTRO, SHARE_SHOW } from '@renderer/pages/easy/text.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const EM_DASH = String.fromCodePoint(0x2014)
const FOLDER = 'C:\\work\\shop'
const ZIP = 'C:\\work\\shop-site.zip'

const report = (over: Partial<DeployReport> = {}): DeployReport => ({
  folder: FOLDER,
  category: 'software',
  cls: {
    id: 'static-site',
    label: 'Static site',
    source: 'folder',
    confidence: 'high',
    reasons: ['index.html with no build step'],
    alternatives: [],
  },
  classes: [
    { id: 'static-site', label: 'Static site' },
    { id: 'spa', label: 'Single-page app' },
  ],
  options: [
    {
      id: 'surge',
      label: 'Surge',
      packId: 'software',
      freeTier: 'A free plan with limits.',
      cost: 'Paid plans add features.',
      coldStarts: 'Static files: none.',
      customDomains: 'Supported.',
      dataResidency: 'No region to choose.',
      configs: [],
      steps: [{ id: 'surge:1', label: 'Publish', command: 'npx surge . shop.surge.sh', shell: 'powershell' }],
      recommended: true,
    },
  ],
  target: 'surge',
  checklist: [],
  env: [],
  caveats: { cost: DEPLOY_COST_CAVEAT, security: DEPLOY_SECURITY_CAVEAT, commands: DEPLOY_COMMANDS_CAVEAT },
  notes: [],
  upload: { dir: '.', ready: true, game: false },
  ...over,
})

let mock: MockDimFactory
let current: DeployReport
let answer: DeployUploadResult

const made: DeployUploadResult = {
  status: 'made',
  path: ZIP,
  name: 'shop-site.zip',
  dir: '.',
  files: 3,
  bytes: 4096,
  skipped: 5,
}

beforeEach(() => {
  current = report()
  answer = made
  mock = setUp({
    handlers: {
      'deploy.inspect': () => current,
      'deploy.uploadFile': () => answer,
      'shell.open': () => undefined,
    },
  })
})
afterEach(() => tearDown(mock))

function mount(): void {
  render(
    <Providers>
      <DeployPanel target={{ folder: FOLDER }} />
    </Providers>,
  )
}

describe('Make an upload file', () => {
  it('shows the plain steps and the public caveat, and calls nothing before a click', async () => {
    mount()
    await settle()
    const box = screen.getByTestId('deploy-upload')
    expect(box.getAttribute('data-ready')).toBe('true')
    expect(screen.getByTestId('deploy-upload-make').textContent).toContain(UPLOAD_MAKE)
    expect(screen.getByTestId('deploy-upload-show').textContent).toContain(UPLOAD_SHOW)
    expect(screen.getByTestId<HTMLButtonElement>('deploy-upload-show').disabled).toBe(true)
    expect(screen.getByTestId('deploy-upload-netlify').textContent).toContain(UPLOAD_NETLIFY)
    const steps = within(screen.getByTestId('deploy-upload-steps'))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(steps).toEqual(uploadSteps(false))
    expect(steps).toEqual([
      'Open Netlify Drop and drag this file (or the folder) onto the page.',
      'Or in Cloudflare Pages: Create, Upload assets, then choose this file.',
    ])
    expect(screen.getByTestId('deploy-upload-public').textContent).toBe(UPLOAD_PUBLIC)
    expect(UPLOAD_PUBLIC).toBe('Putting it online makes it public.')
    expect(mock.callsOf('deploy.uploadFile')).toEqual([])
    expect(mock.callsOf('shell.open')).toEqual([])
    expect(document.body.textContent ?? '').not.toContain(EM_DASH)
  })

  it('makes the file, says what it made, and Show the file reveals it', async () => {
    mount()
    await settle()
    const makeButton = screen.getByTestId('deploy-upload-make')
    const label = makeButton.textContent
    fireEvent.click(makeButton)
    await settle()
    expect(mock.callsOf('deploy.uploadFile')).toEqual([{ folder: FOLDER }])
    expect(screen.getByTestId('deploy-upload-status').textContent).toBe(
      uploadMadeLine({ name: 'shop-site.zip', files: 3, bytes: 4096 }),
    )
    expect(screen.getByTestId('deploy-upload-status').textContent).toBe('Made shop-site.zip: 3 files, 4 KB.')
    // The button keeps its label.
    expect(screen.getByTestId('deploy-upload-make').textContent).toBe(label)
    const show = screen.getByTestId<HTMLButtonElement>('deploy-upload-show')
    expect(show.disabled).toBe(false)
    fireEvent.click(show)
    await settle()
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'uploadFile', path: ZIP }])
  })

  it('a refusal lists what the secret scanner found, and Show the file stays held back', async () => {
    answer = {
      status: 'refused',
      reason: 'The secret scanner found a possible secret in the files that would go in.',
      evidence: ['js/config.js:1 AWS access key ID (AKIA…)'],
    }
    mount()
    await settle()
    fireEvent.click(screen.getByTestId('deploy-upload-make'))
    await settle()
    expect(screen.getByTestId('deploy-upload-status').getAttribute('data-state')).toBe('refused')
    expect(screen.getByTestId('deploy-upload-status').textContent).toContain('No upload file was made.')
    expect(screen.getByTestId('deploy-upload-evidence').textContent).toContain('js/config.js:1')
    expect(screen.getByTestId<HTMLButtonElement>('deploy-upload-show').disabled).toBe(true)
  })

  it('Open Netlify Drop opens that page only on a click', async () => {
    mount()
    await settle()
    expect(mock.callsOf('shell.open')).toEqual([])
    fireEvent.click(screen.getByTestId('deploy-upload-netlify'))
    await settle()
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'url', url: NETLIFY_DROP_URL }])
  })

  it('a game adds the itch.io step', async () => {
    current = report({ category: 'games', upload: { dir: '.', ready: true, game: true } })
    mount()
    await settle()
    const steps = within(screen.getByTestId('deploy-upload-steps'))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(steps[2]).toBe("For itch.io: Upload the zip and tick 'This file will be played in the browser'.")
  })

  it('a folder not built yet holds the button back and says why', async () => {
    current = report({
      upload: {
        dir: 'dist',
        ready: false,
        problem: 'There is no dist/ folder yet. Build the project first: its build writes the site there.',
        game: false,
      },
    })
    mount()
    await settle()
    expect(screen.getByTestId<HTMLButtonElement>('deploy-upload-make').disabled).toBe(true)
    expect(screen.getByTestId('deploy-upload-problem').textContent).toContain('Build the project first')
    expect(screen.getByTestId('deploy-upload-intro').textContent).toContain('dist/')
  })

  it('is not offered when core offers no upload file (a server app)', async () => {
    const { upload: _u, ...rest } = report()
    current = rest
    mount()
    await settle()
    expect(screen.queryByTestId('deploy-upload')).toBeNull()
  })
})

describe("Easy mode's Share it copy", () => {
  it('mentions the upload file, says nothing is uploaded, and keeps who can see it; no em dashes', () => {
    for (const t of [SHARE_INTRO, SHARE_PLAY_INTRO]) {
      expect(t).toContain('upload file')
      expect(t).toContain('Nothing is uploaded for you.')
      expect(t).not.toContain(EM_DASH)
    }
    expect(SHARE_INTRO).toContain('Anyone with the address can see it.')
    expect(SHARE_PLAY_INTRO).toContain('Anyone with the link can play.')
  })

  it('the folded panel shows Make an upload file once opened', async () => {
    render(
      <Providers>
        <DeployPanel
          target={{ runId: 'run-1' }}
          collapsible
          wording={{ title: 'Share it', intro: SHARE_INTRO, show: SHARE_SHOW, hide: SHARE_HIDE }}
        />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('deploy-upload')).toBeNull()
    expect(mock.callsOf('deploy.inspect')).toEqual([])
    fireEvent.click(screen.getByTestId('deploy-toggle'))
    await settle()
    expect(screen.getByTestId('deploy-upload')).toBeTruthy()
    fireEvent.click(screen.getByTestId('deploy-upload-make'))
    await settle()
    expect(mock.callsOf('deploy.uploadFile')).toEqual([{ runId: 'run-1' }])
  })
})
