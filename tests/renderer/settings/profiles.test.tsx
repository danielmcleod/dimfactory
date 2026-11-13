// Settings → Profiles (a list with a scope chip (user/project); built-ins
// read-only (Duplicate to edit); duplicate / rename / delete (undo); Set as default (user or project); PassRowsEditor;
// built-in profiles and semantic rules). The mock core applies each config.patch to the files it serves, so what the
// section reads after a write is what the write did.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ConfigReadResult, ConfigWriteResult } from '@shared/ipc.ts'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/general/ProjectFolder.tsx'
import { BUILTIN_PROFILES } from '@renderer/pages/settings/profiles/builtins.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const EM_DASH = '\u2014'
const USER_FILE = 'C:\\home\\dimfactory.json'
const PROJECT = 'C:\\work\\app'
const PROJECT_FILE = 'C:\\work\\app\\.dimfactory\\dimfactory.json'

type Obj = Record<string, unknown>
let files: { user: Obj; project: Obj }
let mock: MockDimFactory

const segs = (p: string): string[] =>
  p
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))

/** RFC 6902 add/replace/remove on a plain object (parents created, an absent remove ignored), like core's patch. */
function apply(doc: Obj, ops: readonly JsonPatchOp[]): Obj {
  const out = structuredClone(doc)
  for (const op of ops) {
    const path = segs(op.path)
    const last = path.pop() as string
    let cur: Obj = out
    for (const s of path) {
      if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {}
      cur = cur[s] as Obj
    }
    if (op.op === 'remove') delete cur[last]
    else if (op.op !== 'test') cur[last] = structuredClone(op.value)
  }
  return out
}

const read = (scope: 'user' | 'project'): ConfigReadResult => ({
  path: scope === 'user' ? USER_FILE : PROJECT_FILE,
  exists: true,
  text: '',
  value: files[scope],
  issues: [],
  version: 1,
  backups: [],
})

const written = (scope: 'user' | 'project'): ConfigWriteResult => ({
  path: scope === 'user' ? USER_FILE : PROJECT_FILE,
  changed: true,
  diff: '',
  backupId: `${scope}-backup`,
})

beforeEach(() => {
  files = {
    user: {
      profile: 'mine',
      profiles: {
        mine: { plan: { vendor: 'claude', model: 'opus' }, implement: { vendor: 'claude' } },
        spare: {
          plan: { vendor: 'claude', model: 'opus', mode: 'readonly', enabled: true },
          implement: { vendor: 'claude', model: null, mode: 'autoedit', enabled: true },
          review: { vendor: 'claude', model: 'sonnet', mode: 'readonly', enabled: true },
          critic: { vendor: 'claude', model: 'opus', mode: 'readonly', enabled: true },
          fix: { inherit: 'implement', reuseSession: true, enabled: true },
        },
      },
    },
    project: { profile: 'team', profiles: { team: { implement: { vendor: 'claude' } } } },
  }
  mock = setUp({
    handlers: {
      'config.read': (req) => read(req.scope),
      'config.resolve': () =>
        resolvedView({ profile: (files.user['profile'] as string | undefined) ?? 'balanced' }),
      'config.patch': (req) => {
        files[req.scope] = apply(files[req.scope], req.ops)
        return written(req.scope)
      },
      'config.restoreBackup': (req) => written(req.scope),
      'vendors.models': () => [],
      'folders.recent': () => [],
    },
  })
  act(() => upsertProbes([probeView('claude', 'ready'), probeView('codex', 'ready')]))
})

afterEach(() => tearDown(mock))

async function mount(hash?: string): Promise<HTMLElement> {
  if (hash !== undefined) window.location.hash = hash
  render(
    <Providers>
      <SettingsPage section="profiles" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  return screen.getByTestId('settings-profiles')
}

async function select(name: string): Promise<void> {
  fireEvent.click(screen.getByTestId(`profile-item-${name}`))
  await settle()
}

async function click(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId))
  await settle(LOAD_DELAY_MS)
}

async function pick(testId: string, name: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle(LOAD_DELAY_MS)
}

const patches = () => mock.callsOf('config.patch')
const lastToast = () => useStore.getState().toasts.items.at(-1)
const detail = () => screen.getByTestId('profiles-detail')
const disabled = (testId: string) => screen.getByTestId<HTMLButtonElement>(testId).disabled
/** The reason a disabled action names (its DisabledHint group). */
const reason = (testId: string) =>
  screen
    .getByTestId(testId)
    .closest('[data-disabled-hint]')
    ?.textContent?.replace(screen.getByTestId(testId).textContent ?? '', '')

async function undo(): Promise<void> {
  await act(async () => {
    const action = lastToast()?.action
    if (action !== undefined && 'onClick' in action) await action.onClick()
  })
  await settle(LOAD_DELAY_MS)
}

describe('Settings → Profiles: the list', () => {
  it('is live and lists the built-ins and yours with their scope; your default is marked', async () => {
    expect(findSection('profiles')?.live).toBe(true)
    await mount()
    const list = screen.getByTestId('profiles-list')
    const names = within(list)
      .getAllByRole('radio')
      .map((r) => r.getAttribute('data-testid'))
    expect(names).toEqual([
      'profile-item-balanced',
      'profile-item-claude-only',
      'profile-item-codex-only',
      'profile-item-fast',
      'profile-item-thorough',
      'profile-item-mine',
      'profile-item-spare',
    ])
    expect(screen.getByTestId('profile-scope-balanced').textContent).toBe('Built-in')
    expect(screen.getByTestId('profile-scope-mine').textContent).toBe('Yours')
    expect(screen.getByTestId('profile-default-user-mine').textContent).toBe('Your default')
    // Your default is selected first.
    expect(detail().getAttribute('data-profile')).toBe('mine')
    expect(screen.getByTestId('settings-profiles').textContent).not.toContain(EM_DASH)
    expect(
      screen.getByTestId('settings-profiles').querySelector('[data-setting-field="list"]'),
    ).not.toBeNull()
    expect(
      screen.getByTestId('settings-profiles').querySelector('[data-setting-field="/passes"]'),
    ).not.toBeNull()
    expect(
      screen.getByTestId('settings-profiles').querySelector('[data-setting-field="/profile"]'),
    ).not.toBeNull()
  })

  it('with a project chosen, lists its own profiles and its default', async () => {
    await mount(`#/settings/profiles?folder=${encodeURIComponent(PROJECT)}`)
    expect(mock.callsOf('config.read')).toEqual(
      expect.arrayContaining([{ scope: 'user' }, { scope: 'project', folder: PROJECT }]),
    )
    expect(screen.getByTestId('profile-scope-team').textContent).toBe('Project')
    expect(screen.getByTestId('profile-default-project-team').textContent).toBe('Project default')
    expect(screen.getByTestId('profiles-folder-status').textContent).toBe('app starts its runs from team.')
  })
})

describe('Settings → Profiles: built-in profiles are read-only', () => {
  it('shows the passes as a table, with Rename and Delete unavailable and why', async () => {
    await mount()
    await select('fast')
    expect(detail().getAttribute('data-profile')).toBe('fast')
    const table = screen.getByTestId('profile-passes-table')
    expect(within(table).getByTestId('profile-pass-plan').textContent).toBe(
      'PlanClaudesonnetRead-onlyNoneOff',
    )
    expect(within(table).getByTestId('profile-pass-fix').textContent).toContain('Same as Implement')
    expect(screen.queryByTestId('profile-vendor-plan')).toBeNull()
    expect(disabled('profile-rename')).toBe(true)
    expect(reason('profile-rename')).toContain('duplicate it to make your own')
    expect(disabled('profile-delete')).toBe(true)
    expect(screen.getByTestId('profile-where').textContent).toContain('Built-in: read-only')
  })

  it('Duplicate copies it into your profiles and selects the copy; Undo restores your file', async () => {
    await mount()
    await select('balanced')
    await click('profile-duplicate')
    expect(patches()).toEqual([
      {
        scope: 'user',
        ops: [{ op: 'add', path: '/profiles/balanced-copy', value: BUILTIN_PROFILES.balanced }],
      },
    ])
    expect(lastToast()?.message).toBe('Duplicated balanced as balanced-copy in your profiles.')
    expect(detail().getAttribute('data-profile')).toBe('balanced-copy')
    expect(screen.getByTestId('profile-scope-balanced-copy').textContent).toBe('Yours')
    // The copy can be edited.
    expect(screen.getByTestId('profile-vendor-plan')).toBeTruthy()
    await undo()
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'user-backup' }])
  })

  it('Duplicate into project needs a project, then writes the project file', async () => {
    await mount()
    await select('thorough')
    expect(disabled('profile-duplicate-project')).toBe(true)
    expect(reason('profile-duplicate-project')).toBe('Choose a project first.')
    // Another link opens the section with a project (the palette, or core's settings link).
    act(() => {
      window.location.hash = `#/settings/profiles/thorough?folder=${encodeURIComponent(PROJECT)}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(LOAD_DELAY_MS)
    expect(screen.getByTestId('profiles-folder-path').textContent).toBe(PROJECT)
    expect(detail().getAttribute('data-profile')).toBe('thorough')
    await click('profile-duplicate-project')
    expect(patches().at(-1)).toEqual({
      scope: 'project',
      folder: PROJECT,
      ops: [{ op: 'add', path: '/profiles/thorough-copy', value: BUILTIN_PROFILES.thorough }],
    })
    expect(lastToast()?.message).toBe('Duplicated thorough as thorough-copy in app.')
    expect(screen.getByTestId('profile-scope-thorough-copy').textContent).toBe('Project')
  })
})

describe('Settings → Profiles: rename and delete', () => {
  it('Rename moves the profile and your default follows it', async () => {
    await mount()
    await select('mine')
    await click('profile-rename')
    const input = screen.getByTestId('profile-rename-input')
    fireEvent.change(input, { target: { value: 'Bad Name' } })
    await click('profile-rename-save')
    expect(screen.getByTestId('profile-rename-error').textContent).toMatch(/lowercase letters/)
    fireEvent.change(input, { target: { value: 'balanced' } })
    await click('profile-rename-save')
    expect(screen.getByTestId('profile-rename-error').textContent).toBe(
      'A profile called balanced already exists.',
    )
    expect(patches()).toHaveLength(0)
    fireEvent.change(input, { target: { value: 'daily' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle(LOAD_DELAY_MS)
    expect(patches()).toEqual([
      {
        scope: 'user',
        ops: [
          {
            op: 'add',
            path: '/profiles/daily',
            value: { plan: { vendor: 'claude', model: 'opus' }, implement: { vendor: 'claude' } },
          },
          { op: 'remove', path: '/profiles/mine' },
          { op: 'replace', path: '/profile', value: 'daily' },
        ],
      },
    ])
    expect(lastToast()?.message).toBe('Renamed mine to daily.')
    expect(detail().getAttribute('data-profile')).toBe('daily')
    expect(screen.queryByTestId('profile-item-mine')).toBeNull()
  })

  it('Delete is unavailable for your default; another profile is deleted with Undo', async () => {
    await mount()
    await select('mine')
    expect(disabled('profile-delete')).toBe(true)
    expect(reason('profile-delete')).toBe('It is your default profile: make another one your default first.')
    await select('spare')
    await click('profile-delete')
    expect(patches()).toEqual([{ scope: 'user', ops: [{ op: 'remove', path: '/profiles/spare' }] }])
    expect(lastToast()?.message).toBe('Deleted the profile spare.')
    expect(screen.queryByTestId('profile-item-spare')).toBeNull()
    await undo()
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'user-backup' }])
  })
})

describe('Settings → Profiles: set as default', () => {
  it('makes a profile your default (user file)', async () => {
    await mount()
    await select('mine')
    expect(disabled('profile-default-user')).toBe(true)
    expect(reason('profile-default-user')).toBe('It is your default profile already.')
    await select('fast')
    await click('profile-default-user')
    expect(patches()).toEqual([{ scope: 'user', ops: [{ op: 'replace', path: '/profile', value: 'fast' }] }])
    expect(lastToast()?.message).toBe('fast is now your default profile.')
    expect(screen.getByTestId('profile-default-user-fast')).toBeTruthy()
  })

  it("makes a profile the project's default (project file); your own profiles are refused there", async () => {
    await mount(`#/settings/profiles/spare?folder=${encodeURIComponent(PROJECT)}`)
    expect(detail().getAttribute('data-profile')).toBe('spare')
    expect(disabled('profile-default-project')).toBe(true)
    expect(reason('profile-default-project')).toBe(
      'Teammates do not have your own profiles: duplicate it into the project first.',
    )
    await select('team')
    expect(disabled('profile-default-user')).toBe(true)
    expect(reason('profile-default-user')).toMatch(/other folders do not have it/)
    await select('claude-only')
    await click('profile-default-project')
    expect(patches()).toEqual([
      { scope: 'project', folder: PROJECT, ops: [{ op: 'replace', path: '/profile', value: 'claude-only' }] },
    ])
    expect(lastToast()?.message).toBe('claude-only is now the default profile of app.')
  })
})

describe('Settings → Profiles: PassRowsEditor', () => {
  it('a vendor change writes the vendor and clears the model, in the profile’s own file', async () => {
    await mount('#/settings/profiles/spare')
    expect(detail().getAttribute('data-profile')).toBe('spare')
    await pick('profile-vendor-plan', 'Codex')
    expect(patches()).toEqual([
      {
        scope: 'user',
        ops: [
          { op: 'replace', path: '/profiles/spare/plan/vendor', value: 'codex' },
          { op: 'replace', path: '/profiles/spare/plan/model', value: null },
          { op: 'replace', path: '/profiles/spare/plan/effort', value: null },
        ],
      },
    ])
    expect(lastToast()?.message).toBe('spare: Plan runs on Codex')
  })

  it('model, mode and on/off each write one key', async () => {
    await mount('#/settings/profiles/spare')
    const model = screen.getByTestId('pass-model-profile-review')
    fireEvent.change(model, { target: { value: 'haiku' } })
    fireEvent.keyDown(model, { key: 'Enter' })
    await settle(LOAD_DELAY_MS)
    await pick('profile-mode-implement', 'Read-only')
    fireEvent.click(screen.getByTestId('profile-enabled-critic'))
    await settle(LOAD_DELAY_MS)
    expect(patches().map((p) => p.ops)).toEqual([
      [{ op: 'replace', path: '/profiles/spare/review/model', value: 'haiku' }],
      [{ op: 'replace', path: '/profiles/spare/implement/mode', value: 'readonly' }],
      [{ op: 'replace', path: '/profiles/spare/critic/enabled', value: false }],
    ])
  })

  it('effort: shown beside the model, and a choice writes one key', async () => {
    const spare = (files.user['profiles'] as Record<string, Record<string, Record<string, unknown>>>)['spare']
    if (spare?.['plan'] !== undefined) spare['plan']['effort'] = 'high'
    await mount('#/settings/profiles/spare')
    expect(screen.getByTestId('pass-effort-profile-plan').textContent).toBe('high')
    expect(screen.getByTestId('pass-effort-profile-review').textContent).toBe('Default effort')
    await pick('pass-effort-profile-plan', 'Default effort')
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/plan/effort', value: null },
    ])
    expect(lastToast()?.message).toBe('spare: Plan default effort')
  })

  it('extensions: each pass shows its level; a choice writes one key; Pass through on a read-only pass asks first', async () => {
    await mount('#/settings/profiles/spare')
    expect(screen.getByTestId('pass-extensions-profile-plan').textContent).toBe('None')
    expect(screen.getByTestId('pass-extensions-profile-implement').textContent).toBe('Pass through')
    await pick('pass-extensions-profile-critic', 'Allowed list')
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/critic/extensions', value: 'allowed' },
    ])
    expect(lastToast()?.message).toBe('spare: Critic extensions Allowed list')
    const before = patches().length
    await pick('pass-extensions-profile-review', 'Pass through')
    expect(patches().length).toBe(before)
    fireEvent.click(screen.getByTestId('pass-extensions-confirm-yes-profile-review'))
    await settle(LOAD_DELAY_MS)
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/review/extensions', value: 'passthrough' },
    ])
  })

  it('read-only passes offer no mode; Implement never offers "Approve everything"', async () => {
    await mount('#/settings/profiles/spare')
    expect(screen.getByTestId('profile-mode-plan').textContent).toBe('Read-only')
    expect(screen.getByTestId('profile-mode-plan').tagName).toBe('SPAN')
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('profile-mode-implement'), { key: 'Enter' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Read-only', 'Approve edits'])
  })

  it('Fix: same as Implement and session reuse', async () => {
    await mount('#/settings/profiles/spare')
    expect(screen.getByTestId('profile-vendor-fix').textContent).toBe('Same as Implement')
    fireEvent.click(screen.getByTestId('profile-fix-inherit'))
    await settle(LOAD_DELAY_MS)
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/fix/inherit', value: null },
      { op: 'replace', path: '/profiles/spare/fix/vendor', value: 'claude' },
      { op: 'replace', path: '/profiles/spare/fix/model', value: null },
      { op: 'replace', path: '/profiles/spare/fix/effort', value: null },
      { op: 'replace', path: '/profiles/spare/fix/mode', value: 'autoedit' },
      { op: 'replace', path: '/profiles/spare/fix/extensions', value: 'passthrough' },
    ])
    // Fix now has its own controls.
    expect(screen.getByTestId('profile-vendor-fix').tagName).toBe('BUTTON')
    fireEvent.click(screen.getByTestId('profile-fix-inherit'))
    await settle(LOAD_DELAY_MS)
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/fix/inherit', value: 'implement' },
      { op: 'remove', path: '/profiles/spare/fix/vendor' },
      { op: 'remove', path: '/profiles/spare/fix/model' },
      { op: 'remove', path: '/profiles/spare/fix/effort' },
      { op: 'remove', path: '/profiles/spare/fix/mode' },
      { op: 'remove', path: '/profiles/spare/fix/extensions' },
    ])
    fireEvent.click(screen.getByTestId('profile-fix-reuse'))
    await settle(LOAD_DELAY_MS)
    expect(patches().at(-1)?.ops).toEqual([
      { op: 'replace', path: '/profiles/spare/fix/reuseSession', value: false },
    ])
    expect(lastToast()?.message).toBe('spare: Fix starts a fresh session')
  })

  it("a project's profile is edited in the project file", async () => {
    await mount(`#/settings/profiles/team?folder=${encodeURIComponent(PROJECT)}`)
    fireEvent.click(screen.getByTestId('profile-enabled-review'))
    await settle(LOAD_DELAY_MS)
    expect(patches()).toEqual([
      {
        scope: 'project',
        folder: PROJECT,
        ops: [{ op: 'replace', path: '/profiles/team/review/enabled', value: false }],
      },
    ])
  })

  it('a pass without a vendor says it needs one', async () => {
    files.user = { profiles: { bare: { review: { enabled: true } } } }
    await mount('#/settings/profiles/bare')
    const row = screen.getByTestId('profile-pass-plan')
    expect(within(row).getByRole('alert').textContent).toBe('Plan needs a vendor while it is on.')
  })
})

describe('Settings → Profiles: deep links', () => {
  it('#/settings/profiles/<name> selects it without scrolling the page', async () => {
    const scroll = vi.fn()
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown }
    const before = proto.scrollIntoView
    proto.scrollIntoView = scroll
    try {
      await mount('#/settings/profiles/claude-only')
      expect(detail().getAttribute('data-profile')).toBe('claude-only')
      expect(screen.getByTestId<HTMLInputElement>('profile-item-claude-only').checked).toBe(true)
      expect(scroll).not.toHaveBeenCalled()
    } finally {
      proto.scrollIntoView = before
    }
  })

  it('shows no list and no selection until your file is read: one line, last in the section, then your default', async () => {
    render(
      <Providers>
        <SettingsPage section="profiles" />
      </Providers>,
    )
    const sectionEl = screen.getByTestId('settings-profiles')
    expect(screen.queryByRole('radiogroup', { name: 'Profiles' })).toBeNull()
    expect(screen.queryByTestId('profile-duplicate')).toBeNull()
    expect(detail().textContent).toBe('Reading your profiles…')
    // Last in the section: what replaces it moves nothing above it.
    expect(sectionEl.lastElementChild).toBe(detail())
    await settle(LOAD_DELAY_MS)
    // The first selection is made from what was read: your default, not the first built-in.
    expect(detail().getAttribute('data-profile')).toBe('mine')
    expect(screen.getByTestId<HTMLInputElement>('profile-item-mine').checked).toBe(true)
    expect(screen.getByTestId<HTMLInputElement>('profile-item-balanced').checked).toBe(false)
  })

  it('a link to one of your profiles waits for your file instead of showing another', async () => {
    window.location.hash = '#/settings/profiles/spare'
    render(
      <Providers>
        <SettingsPage section="profiles" />
      </Providers>,
    )
    expect(detail().textContent).toBe('Reading your profiles…')
    await settle(LOAD_DELAY_MS)
    expect(detail().getAttribute('data-profile')).toBe('spare')
  })
})

// ---- the steps -----------------------------------------------------------------------------------------------------

describe('Steps', () => {
  it('a built-in profile reads its steps; Thorough runs Clarify, Research, the acceptance review and 3 rounds', async () => {
    await mount()
    await select('thorough')
    const steps = screen.getByTestId('profile-steps')
    const text = (k: string): string | null => within(steps).getByTestId(`profile-step-${k}`).textContent
    expect(text('clarify')).toBe('On')
    expect(text('clarifyQuestions')).toBe('4 questions')
    expect(text('research')).toBe('On')
    expect(text('acceptance')).toBe('On')
    expect(text('explain')).toBe('Off')
    expect(text('rounds')).toBe('Up to 3 rounds')
    expect(text('deploy')).toBe('Off')
    expect(text('securityRecheck')).toBe('On')
    expect(within(steps).queryAllByRole('switch')).toHaveLength(0)
    expect(steps.textContent).not.toContain(EM_DASH)
  })

  it('writes each step to its config key in the profile, with Undo, and every row stays in place', async () => {
    await mount()
    await select('spare')
    const rows = (): string[] =>
      [...screen.getByTestId('profile-steps').querySelectorAll('li')].map(
        (li) => li.getAttribute('data-testid') ?? '',
      )
    const before = rows()
    expect(before).toEqual([
      'profile-step-row-clarify',
      'profile-step-row-clarifyQuestions',
      'profile-step-row-research',
      'profile-step-row-explain',
      'profile-step-row-acceptance',
      'profile-step-row-rounds',
      'profile-step-row-deploy',
      'profile-step-row-securityRecheck',
    ])
    // The question count is there from the start, waiting for Clarify.
    expect(screen.getByTestId('profile-step-clarifyQuestions').hasAttribute('disabled')).toBe(true)
    const cases: [string, string, unknown][] = [
      ['clarify', '/profiles/spare/plan/clarify', true],
      ['research', '/profiles/spare/plan/research', true],
      ['explain', '/profiles/spare/plan/explain', true],
      ['acceptance', '/profiles/spare/review/acceptance', true],
      ['deploy', '/profiles/spare/implement/deploy', true],
      ['securityRecheck', '/profiles/spare/security/recheck', false],
    ]
    for (const [key, path, value] of cases) {
      await click(`profile-step-${key}`)
      expect(patches().at(-1)).toEqual({ scope: 'user', ops: [{ op: 'replace', path, value }] })
    }
    expect(lastToast()?.message).toContain('spare: Security re-check off')
    await pick('profile-step-clarifyQuestions', '6 questions')
    expect(patches().at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/profiles/spare/plan/clarifyQuestions', value: 6 }],
    })
    await pick('profile-step-rounds', 'Up to 2 rounds')
    expect(patches().at(-1)).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/profiles/spare/fix/rounds', value: 2 }],
    })
    const spare = (files.user['profiles'] as Obj)['spare'] as Obj
    expect(spare['plan']).toMatchObject({ clarify: true, clarifyQuestions: 6, research: true, explain: true })
    expect(spare['review']).toMatchObject({ acceptance: true })
    expect(spare['implement']).toMatchObject({ deploy: true })
    expect(spare['fix']).toMatchObject({ rounds: 2 })
    expect(spare['security']).toMatchObject({ recheck: false })
    // What it reads back is what it wrote; the rows never moved.
    expect(screen.getByTestId('profile-step-clarify').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('profile-step-rounds').textContent).toContain('Up to 2 rounds')
    expect(rows()).toEqual(before)
    await undo()
    expect(mock.callsOf('config.restoreBackup')).toHaveLength(1)
  })
})
