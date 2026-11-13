// Easy mode's second phase on the mock bridge: Add files on the home (core checks each one; a refused one says why and is
// never sent; the privacy line once a file will go), the confirm screen's files row and the permission's plain note,
// Start sending the files and the permission; the run's line of what the project permission approved and the
// project's short title; the Done screen's Save as PDF for a document (the rendered document, then the PDF beside it),
// "Remember this for next time" (memory.apply of the run's proposal), Share it folded with "Putting it online makes it
// public", and the count; the plain trust card; the permissions list with Take it back.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  EasyAttachment,
  EasyPermissionState,
  EasyProjectView,
  EasyResolved,
  EasyState,
} from '@shared/easy.ts'
import type { MemoryView } from '@shared/factory.ts'
import type { PreviewInfo } from '@shared/preview.ts'
import type { CardView, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { applySnapshot } from '@renderer/state/actions.ts'
import { setEasyStateForTests } from '@renderer/state/experience.ts'
import { EasyHomePage } from '@renderer/pages/easy/EasyHome.tsx'
import { EasyNewPage } from '@renderer/pages/easy/EasyNew.tsx'
import { EasyRunPage } from '@renderer/pages/easy/EasyRun.tsx'
import { PermissionsList } from '@renderer/pages/easy/PermissionsList.tsx'
import { draftNow, resetDraftForTests, setDraft } from '@renderer/pages/easy/draft.ts'
import { openTargetOf, plainAsk, projectTitle } from '@renderer/pages/easy/model.ts'
import {
  CONSENT_NOTE,
  PRIVACY_LINE,
  REMEMBERED,
  REVOKE_PERMISSION,
  SHARE_PUBLIC,
  permissionUsesText,
  savedPdfText,
  trustBodyText,
} from '@renderer/pages/easy/text.ts'
import { makeSnapshot } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const FOLDER = 'C:\\Users\\me\\Documents\\Dim Factory Projects\\help-guide-customers'

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
  idea: 'A help guide for the customers of my knitting shop',
  kind: 'document',
  kindSource: 'words',
  template: { id: 'docs-simple', label: 'Simple guide or docs' },
  recipe: 'easy-documents',
  folder: FOLDER,
  folderName: 'help-guide-customers',
  projectsDir: STATE.projectsDir,
  research: false,
  estimate: null,
  limits: { maxCostUsd: null, maxMinutes: null },
  vendors: { claude: true, codex: false, ready: true },
  toolchain: { node: false, python: false },
}

const PROJECT: EasyProjectView = {
  folder: FOLDER,
  name: 'help-guide-customers',
  title: 'Help guide for the customers of my knitting shop',
  kind: 'document',
  idea: RESOLVED.idea,
  lastRunId: 'r1',
  lastDisplayNo: 1,
  lastStatus: 'completed',
  updatedAt: 1,
  runs: 1,
}

const CSV: EasyAttachment = {
  path: 'C:\\Users\\me\\Downloads\\sales.csv',
  name: 'sales.csv',
  bytes: 2048,
  folder: false,
  dest: 'data',
}
const ENV: EasyAttachment = {
  path: 'C:\\Users\\me\\Downloads\\.env',
  name: '.env',
  bytes: 10,
  folder: false,
  dest: 'assets',
  error:
    'This is a hidden file or is in a hidden folder, which can hold passwords and keys, so it is not added.',
}

const PERMISSION: EasyPermissionState = { folder: FOLDER, at: 1, uses: 5, granted: true, runUses: 3 }

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  streamBuffer.reset()
  resetDraftForTests()
  mock = setUp({
    handlers: {
      'easy.state': () => STATE,
      'easy.projects': () => [PROJECT],
      'easy.resolve': () => RESOLVED,
      'easy.create': () => ({ runId: 'r9', displayNo: 9, folder: FOLDER }),
      'easy.permission': () => PERMISSION,
      'easy.permissions': () => [{ folder: FOLDER, at: Date.now() - 60_000, uses: 5 }],
      'easy.revokePermission': () => [],
      'runs.limits': () => ({ limits: { maxCostUsd: null, maxMinutes: null } }),
      'cards.resolve': () => undefined,
      'dialog.pickFiles': () => [CSV.path, ENV.path],
      'easy.attachCheck': (req) => [CSV, ENV].filter((a) => req.paths.includes(a.path)),
    },
  })
  setEasyStateForTests(STATE)
})

afterEach(() => {
  setEasyStateForTests(null)
  tearDown(mock)
})

function snap(over: Parameters<typeof makeSnapshot>[0], edit?: (s: RunSnapshot) => void): RunSnapshot {
  const s = makeSnapshot({ folder: FOLDER, createdAt: Date.now(), ...over })
  edit?.(s)
  return s
}

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

describe('Add files', () => {
  it('core checks each file; a refused one says why; the privacy line once one will go; Remove takes it out', async () => {
    render(
      <Providers>
        <EasyHomePage />
      </Providers>,
    )
    expect(screen.queryByTestId('easy-privacy')).toBeNull()
    fireEvent.click(screen.getByTestId('easy-attach-add'))
    await settle()
    expect(mock.callsOf('easy.attachCheck')).toEqual([{ paths: [CSV.path, ENV.path] }])
    const rows = screen.getAllByTestId('easy-attach-row')
    expect(rows.map((r) => r.getAttribute('data-error'))).toEqual([null, 'true'])
    expect(rows[0]?.textContent).toContain('Copied into data/')
    expect(rows[1]?.textContent).toContain(ENV.error)
    expect(screen.getByTestId('easy-privacy').textContent).toBe(PRIVACY_LINE)
    // A new idea keeps the files.
    fireEvent.change(screen.getByTestId('easy-idea'), { target: { value: 'A report from my sales' } })
    expect(draftNow().attachments).toHaveLength(2)
    fireEvent.click(within(rows[0] as HTMLElement).getByTestId('easy-attach-remove'))
    await settle()
    expect(screen.getAllByTestId('easy-attach-row')).toHaveLength(1)
    expect(screen.queryByTestId('easy-privacy')).toBeNull()
  })
})

describe('the confirm screen', () => {
  it('lists the files it starts with and the privacy line; Start sends them and the permission', async () => {
    setDraft({ idea: RESOLVED.idea, attachments: [CSV, ENV] })
    render(
      <Providers>
        <EasyNewPage />
      </Providers>,
    )
    await settle()
    const files = screen.getByTestId('easy-confirm-files')
    expect(files.textContent).toContain('sales.csv')
    expect(files.textContent).not.toContain('.env')
    expect(screen.getByTestId('easy-confirm-privacy').textContent).toBe(PRIVACY_LINE)
    expect(screen.getByTestId('easy-confirm-consent').textContent).toContain(CONSENT_NOTE)
    expect(screen.getByTestId('easy-confirm-consent').textContent).not.toContain('still asks you each time')
    fireEvent.click(screen.getByTestId('easy-consent'))
    fireEvent.click(screen.getByTestId('easy-start'))
    await settle()
    expect(mock.callsOf('easy.create')).toEqual([
      {
        idea: RESOLVED.idea,
        kind: 'document',
        folder: FOLDER,
        limits: { maxCostUsd: null, maxMinutes: null },
        consent: true,
        attachments: [CSV.path],
      },
    ])
  })
})

describe('the run', () => {
  it('shows the short title and what the project permission approved', async () => {
    showRun(snap({ runId: 'r1', status: 'running', phase: 'implementing' }))
    await settle()
    expect(screen.getByTestId('easy-run-project').textContent).toBe(PROJECT.title)
    expect(screen.getByTestId('easy-permission-uses').textContent).toBe(permissionUsesText(3))
  })

  it('keeps the permission line, empty, without a permission', async () => {
    mock.on('easy.permission', () => ({ ...PERMISSION, granted: false, runUses: 0 }))
    showRun(snap({ runId: 'r1', status: 'running', phase: 'implementing' }))
    await settle()
    expect(screen.getByTestId('easy-permission-uses').textContent).toBe('')
  })

  it('words the trust card plainly, with what runs one click away', async () => {
    const card: CardView = {
      id: 'c1',
      kind: 'trust',
      title: 'Trust npm test?',
      body: 'The script body: node --test',
      blocking: true,
      choices: [
        { id: 'trust', label: 'Trust for this project' },
        { id: 'skip', label: 'Skip' },
      ],
      payload: {
        command: 'npm test',
        argv: ['npm', 'test'],
        cwdRel: '.',
        body: 'node --test',
        trust: 'untrusted',
      },
      createdAt: Date.now(),
    } as CardView
    showRun(snap({ runId: 'r1', status: 'waiting', phase: 'verifying' }, (s) => (s.cards = [card])))
    await settle()
    const c = screen.getByTestId('easy-card-trust')
    expect(within(c).getByTestId('easy-card-body').textContent).toBe(trustBodyText(['npm test']))
    expect(within(c).queryByTestId('easy-card-detail')).toBeNull()
    fireEvent.click(within(c).getByTestId('easy-card-what'))
    expect(within(c).getByTestId('easy-card-detail').textContent).toContain('node --test')
  })
})

describe('done', () => {
  const MEMORY: MemoryView = {
    folder: FOLDER,
    file: `${FOLDER}\\DIMFACTORY.md`,
    exists: false,
    bytes: 0,
    capped: false,
    maxBytes: 16_000,
    enabled: true,
    propose: true,
    autoApply: false,
    pending: [
      {
        id: 'r1',
        runId: 'r1',
        displayNo: 1,
        title: 't',
        createdAt: 1,
        baseSha256: null,
        diff: [],
        next: 'note',
      } as unknown as MemoryView['pending'][number],
    ],
  }
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
      {
        id: 'doc:docs',
        label: 'Read docs/ (3 pages)',
        kind: 'document',
        source: 'document',
        argv: [],
        cwdRel: '.',
        docPath: 'docs',
        trust: 'none',
      },
    ],
    checks: [],
    runMd: null,
    sessions: [],
    smoke: null,
    openIn: 'app',
  })

  it('a document: Open it shows the rendered document; Save as PDF saves it beside it', async () => {
    mock.on('memory.get', () => MEMORY)
    mock.on('preview.detect', INFO)
    mock.on('preview.start', (req) => ({
      id: 'pv1',
      folder: FOLDER,
      runId: 'r1',
      commandId: req.commandId,
      label: 'Read docs/',
      kind: 'document',
      status: 'running',
      url: 'http://127.0.0.1:5000/',
      startedAt: 1,
      tail: [],
      lines: 0,
    }))
    mock.on('preview.open', () => undefined)
    mock.on('preview.savePdf', () => ({ path: `${FOLDER}\\docs.pdf` }))
    showRun(snap({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }))
    await settle()
    expect(screen.getByTestId('easy-done-project').textContent).toBe(PROJECT.title)
    expect(screen.getByTestId('easy-permission-uses').textContent).toBe(permissionUsesText(3))
    fireEvent.click(screen.getByTestId('easy-open-it'))
    await settle()
    expect(mock.callsOf('preview.start')).toEqual([{ runId: 'r1', commandId: 'doc:docs' }])
    expect(mock.callsOf('preview.open')).toEqual([{ sessionId: 'pv1', target: 'app' }])
    fireEvent.click(screen.getByTestId('easy-save-pdf'))
    await settle()
    expect(mock.callsOf('preview.savePdf')).toEqual([{ sessionId: 'pv1' }])
    expect(screen.getByTestId('easy-open-note').textContent).toBe(savedPdfText('docs.pdf'))
  })

  it('Remember this for next time writes the run’s memory update; Share it says it makes it public', async () => {
    mock.on('memory.get', () => MEMORY)
    mock.on('memory.apply', () => ({ ...MEMORY, exists: true, pending: [] }))
    showRun(snap({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }))
    await settle()
    const remember = screen.getByTestId('easy-remember')
    expect(remember.hasAttribute('disabled')).toBe(false)
    fireEvent.click(remember)
    await settle()
    expect(mock.callsOf('memory.apply')).toEqual([{ folder: FOLDER, id: 'r1' }])
    expect(screen.getByTestId('easy-remembered').textContent).toBe(REMEMBERED)
    const share = screen.getByTestId('easy-done-share')
    expect(share.textContent).toContain(SHARE_PUBLIC)
    // Folded: nothing is read until it is opened.
    expect(within(share).queryByTestId('deploy-body')).toBeNull()
  })

  it('Remember waits while there is no update to remember', async () => {
    mock.on('memory.get', () => ({ ...MEMORY, pending: [] }))
    showRun(snap({ runId: 'r1', status: 'completed', phase: 'done', outcome: 'clean' }))
    await settle()
    expect(screen.getByTestId('easy-remember').hasAttribute('disabled')).toBe(true)
  })
})

describe('the permissions list', () => {
  it('lists each project with its uses; Take it back revokes it', async () => {
    render(
      <Providers>
        <PermissionsList />
      </Providers>,
    )
    await settle()
    const row = screen.getByTestId('easy-permissions-row')
    expect(row.textContent).toContain('help-guide-customers')
    expect(row.textContent).toContain(permissionUsesText(5))
    const revoke = within(row).getByTestId('easy-permissions-revoke')
    expect(revoke.textContent).toBe(REVOKE_PERMISSION)
    fireEvent.click(revoke)
    await settle()
    expect(mock.callsOf('easy.revokePermission')).toEqual([{ folder: FOLDER }])
  })
})

describe('model', () => {
  it('an edit ask is placed by its path, after the tool the vendor names first', () => {
    const out = plainAsk(
      { kind: 'edit', detail: 'Write: C:\\Users\\me\\notes.txt\nThis command requires approval' },
      FOLDER,
    )
    expect(out).toMatchObject({ tier: 'outside', recommended: 'deny' })
    expect(out.text).toContain('C:\\Users\\me\\notes.txt')
    expect(out.text).not.toContain('Write:')
    const inside = plainAsk({ kind: 'edit', detail: `Edit: ${FOLDER}\\docs\\a.md` }, FOLDER)
    expect(inside).toMatchObject({ tier: 'inside', recommended: 'allow' })
    expect(inside.text).toContain('docs/a.md')
  })

  it('Open it: the document for a document kind, else the page; a trusted server; else the document', () => {
    const base = {
      folder: FOLDER,
      scopeRoot: FOLDER,
      trustFolder: FOLDER,
      checks: [],
      runMd: null,
      sessions: [],
      smoke: null,
      openIn: 'app' as const,
    }
    const doc = {
      id: 'doc:memo.md',
      label: 'Read memo.md',
      kind: 'document' as const,
      source: 'document' as const,
      argv: [],
      cwdRel: '.',
      docPath: 'memo.md',
      trust: 'none' as const,
    }
    const stat = {
      id: 'static:.',
      label: 'Serve index.html',
      kind: 'static' as const,
      source: 'static' as const,
      argv: [],
      cwdRel: '.',
      trust: 'none' as const,
    }
    const server = {
      id: 'pkg:dev',
      label: 'npm run dev',
      kind: 'server' as const,
      source: 'package.json' as const,
      argv: ['npm', 'run', 'dev'],
      cwdRel: '.',
      trust: 'trusted' as const,
    }
    expect(openTargetOf({ ...base, commands: [stat, doc] }, true)).toEqual({
      kind: 'document',
      commandId: doc.id,
    })
    expect(openTargetOf({ ...base, commands: [stat, doc] }, false)).toEqual({
      kind: 'static',
      commandId: stat.id,
    })
    expect(openTargetOf({ ...base, commands: [server] })).toEqual({ kind: 'server', commandId: server.id })
    expect(openTargetOf({ ...base, commands: [{ ...server, trust: 'untrusted' }] })).toEqual({
      kind: 'command',
    })
    expect(openTargetOf({ ...base, commands: [doc] })).toEqual({ kind: 'document', commandId: doc.id })
    expect(projectTitle('C:\\p\\bakery-landing-page', undefined)).toBe('bakery landing page')
    expect(projectTitle('C:\\p\\bakery-landing-page', 'Landing page for my bakery')).toBe(
      'Landing page for my bakery',
    )
  })
})
