// The ⌘/Ctrl+K command palette (cmdk, the app's only modal, with the groups Actions, Needs
// you, Runs, Folders and the Settings index; keys; accessibility; UI standards): it opens on mod+K
// only, takes the focus into its search box, is a labelled dialog whose results are a listbox in their own capped
// scroll region, keeps its keys from the app behind it, moves with arrows / Home / End, chooses with Enter or a click,
// and closes on Escape or mod+K giving the focus back. Each group lists what the store holds and does what it says:
// actions (New run asks the composer, navigation, Stop / Open diff in a run, theme with Undo, re-probe, diagnostics),
// Needs you opens the run at the ask or card, Runs and Folders fuzzy-search, and a Settings row deep-links to its
// field, which takes the focus once the section can give it.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from '@shared/estimates.ts'
import type { AppState, ThemeState } from '@shared/ipc.ts'
import type { RunSummary } from '@shared/run.ts'
import { CommandPalette } from '@renderer/components/palette/CommandPalette.tsx'
import {
  resetComposerIntentForTests,
  useComposerIntent,
} from '@renderer/components/palette/composerIntent.ts'
import type { ComposerIntent } from '@renderer/components/palette/composerIntent.ts'
import { cancelFollowUp } from '@renderer/components/palette/followUp.ts'
import { SettingsFieldFocus } from '@renderer/components/palette/SettingsFieldFocus.tsx'
import { registerShortcut, setMacForTests } from '@renderer/lib/keys.ts'
import { useRoute } from '@renderer/lib/router.ts'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/NotificationsSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { setAttention, setThemeState, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

let mock: MockDimFactory
let intents: ComposerIntent[]
/** happy-dom fires hashchange on a real timer, fake timers or not: taken before any test fakes them. */
const realSetTimeout = globalThis.setTimeout

const appState = (): AppState => ({
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: null,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
})

const notifications = {
  desktop: true,
  sound: false,
  onlyWhenUnfocused: true,
  events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
}

beforeEach(() => {
  intents = []
  resetComposerIntentForTests()
  mock = setUp({
    handlers: {
      'config.resolve': () => {
        const base = resolvedView()
        return { ...base, config: { ...base.config, notifications } }
      },
      'state.get': () => appState(),
      'runs.stop': () => undefined,
    },
  })
  setThemeState({ theme: 'system', resolved: 'light', accent: 'slate' })
})

afterEach(() => {
  cancelFollowUp()
  resetComposerIntentForTests()
  tearDown(mock)
})

// ---- a small app around the palette ---------------------------------------------------------------------------------

/** Shows the target a Needs-you item opens once `show-target` fires (a run's snapshot arriving late). */
let targetShownAtOnce = true

function FakeRunView({ runId }: { runId: string }): React.JSX.Element {
  const [shown, setShown] = useState(targetShownAtOnce)
  useEffect(() => {
    const show = (): void => setShown(true)
    window.addEventListener('show-target', show)
    return () => window.removeEventListener('show-target', show)
  }, [])
  return (
    <div data-testid="run-view" data-run-id={runId}>
      <h1>Run {runId}</h1>
      {shown && runId === 'r1' && (
        <section data-testid="ask-panel" data-request-id="req-1" tabIndex={-1}>
          Claude needs approval
        </section>
      )}
      {shown && runId === 'r2' && (
        <section data-card-id="card-1" tabIndex={-1}>
          Plan ready for review
        </section>
      )}
    </div>
  )
}

/** The composer's side of New run / Folders: records each ask and takes the focus. */
function FakeComposer(): React.JSX.Element {
  useComposerIntent((i) => {
    intents.push(i)
    document.querySelector<HTMLElement>('[data-testid="fake-task"]')?.focus()
  })
  return <textarea data-testid="fake-task" aria-label="Task" />
}

function Page(): React.JSX.Element {
  const route = useRoute()
  switch (route.name) {
    case 'settings':
      return route.section !== undefined ? <SettingsPage section={route.section} /> : <SettingsPage />
    case 'run':
      return <FakeRunView key={route.runId} runId={route.runId} />
    case 'dashboard':
      return <FakeComposer />
    case 'runs':
    case 'match':
    case 'rematch':
    case 'plops':
    case 'preview':
    case 'deploy':
    case 'queue':
    case 'easy':
    case 'easyRun':
    case 'easyTwo':
    case 'notFound':
      return <p data-testid={`page-${route.name}`}>{route.name}</p>
  }
}

function mount(): void {
  render(
    <Providers>
      <button type="button" data-testid="before">
        Before
      </button>
      <main data-testid="main">
        <Page />
      </main>
      <CommandPalette />
      <SettingsFieldFocus />
    </Providers>,
  )
}

// ---- helpers --------------------------------------------------------------------------------------------------------

function pressOn(target: Element, key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(target, { key, ...init })
}

const focused = (): Element => document.activeElement ?? document.body

/** Let a navigation land: happy-dom's hashchange (a real timer), then what the new page does. */
async function landed(): Promise<void> {
  await act(async () => {
    await new Promise((r) => realSetTimeout(r, 0))
  })
  await settle()
}

async function openPalette(): Promise<HTMLElement> {
  pressOn(focused(), 'k', { ctrlKey: true })
  await settle()
  return screen.getByTestId('palette')
}

function input(): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>('palette-input')
}

async function search(text: string): Promise<void> {
  fireEvent.change(input(), { target: { value: text } })
  await settle()
}

/** The labels shown in one group, in order. */
function groupLabels(group: string): string[] {
  const g = screen.queryByTestId(`palette-group-${group}`)
  if (g === null) return []
  return within(g)
    .queryAllByRole('option')
    .map((o) => o.querySelector('span[title]')?.textContent ?? '')
}

function selected(): string {
  const o = screen.getByTestId('palette').querySelector('[role="option"][aria-selected="true"]')
  return o?.querySelector('span[title]')?.textContent ?? ''
}

/** Click an item, let the palette close and the choice run, and let any navigation land. */
async function choose(id: string): Promise<void> {
  fireEvent.click(screen.getByTestId(`palette-item-${id}`))
  await settle()
  await landed()
}

/** Enter on the selected item, then the same as choose(). */
async function enter(): Promise<void> {
  pressOn(input(), 'Enter')
  await settle()
  await landed()
}

function summary(over: Partial<RunSummary> & { runId: string }): RunSummary {
  return makeSummary(over)
}

// ---- opening and closing --------------------------------------------------------------------------------------------

describe('opening and closing', () => {
  it('opens on Ctrl+K (never on K alone) as a labelled dialog with the focus in its search box', async () => {
    mount()
    const before = screen.getByTestId('before')
    before.focus()
    pressOn(before, 'k')
    await settle()
    expect(screen.queryByTestId('palette')).toBeNull()

    const dialog = await openPalette()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBe(dialog)
    // A visible title and the key that opens it.
    expect(within(dialog).getByRole('heading', { name: 'Command palette' }).textContent).toBe(
      'Command palette',
    )
    expect(dialog.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    expect(dialog.textContent).toContain('Ctrl+K')
    // cmdk's roles: a combobox that controls the listbox of results.
    const box = input()
    expect(document.activeElement).toBe(box)
    expect(box.getAttribute('role')).toBe('combobox')
    const list = screen.getByRole('listbox')
    expect(box.getAttribute('aria-controls')).toBe(list.id)
    expect(list.getAttribute('aria-label')).toBe('Search actions, runs, folders and settings')
  })

  it('opens on ⌘K on macOS, not on Ctrl+K there', async () => {
    setMacForTests(true)
    mount()
    pressOn(document.body, 'k', { ctrlKey: true })
    await settle()
    expect(screen.queryByTestId('palette')).toBeNull()
    pressOn(document.body, 'k', { metaKey: true })
    await settle()
    expect(screen.getByTestId('palette')).toBeTruthy()
  })

  it('closes on Escape and gives the focus back to where it was', async () => {
    mount()
    const before = screen.getByTestId('before')
    before.focus()
    await openPalette()
    pressOn(input(), 'Escape')
    await settle()
    expect(screen.queryByTestId('palette')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it('closes on Ctrl+K again, and keeps its keys from the shortcuts behind it', async () => {
    mount()
    const behind = vi.fn()
    registerShortcut('mod+.', behind, { description: 'Stop the run' })
    registerShortcut('mod+1', behind, { description: 'Dashboard' })
    const before = screen.getByTestId('before')
    before.focus()
    await openPalette()
    pressOn(input(), '.', { ctrlKey: true })
    pressOn(input(), '1', { ctrlKey: true, code: 'Digit1' })
    await landed()
    expect(behind).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
    pressOn(input(), 'k', { ctrlKey: true })
    await settle()
    expect(screen.queryByTestId('palette')).toBeNull()
    expect(document.activeElement).toBe(before)
    // Closed, the app's shortcuts work again.
    pressOn(before, '.', { ctrlKey: true })
    expect(behind).toHaveBeenCalledTimes(1)
  })

  it('has one fixed height, with its results as its own capped scroll region and no em dash', async () => {
    mount()
    const dialog = await openPalette()
    expect(dialog.className).toMatch(/(^|\s)h-\[min\(28rem,76vh\)\]/)
    expect(dialog.className).toContain('fixed')
    const list = screen.getByRole('listbox')
    expect(list.getAttribute('data-scroll-region')).toBe('palette')
    const cls = list.className.split(/\s+/)
    expect(cls).toEqual(expect.arrayContaining(['overflow-y-auto', 'scroll-region', 'max-h-full', 'min-h-0']))
    // The only scroll region in the dialog.
    expect(dialog.querySelectorAll('[data-scroll-region]')).toHaveLength(1)
    const texts = [
      dialog.textContent ?? '',
      ...[...dialog.querySelectorAll('*')].flatMap((el) =>
        ['title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a) ?? ''),
      ),
    ]
    for (const t of texts) expect(t.includes('\u2014')).toBe(false)
  })
})

// ---- keyboard -------------------------------------------------------------------------------------------------------

describe('keyboard', () => {
  it('moves with the arrows, Home and End, and chooses with Enter', async () => {
    mount()
    await openPalette()
    expect(selected()).toBe('New run')
    pressOn(input(), 'ArrowDown')
    await settle()
    expect(selected()).toBe('Open Dashboard')
    pressOn(input(), 'ArrowDown')
    await settle()
    expect(selected()).toBe('Open Runs')
    pressOn(input(), 'ArrowUp')
    await settle()
    expect(selected()).toBe('Open Dashboard')
    pressOn(input(), 'End')
    await settle()
    expect(selected()).toBe('Restore the last good copy')
    pressOn(input(), 'Home')
    await settle()
    expect(selected()).toBe('New run')
    pressOn(input(), 'ArrowDown')
    pressOn(input(), 'ArrowDown')
    await settle()
    await enter()
    expect(screen.queryByTestId('palette')).toBeNull()
    expect(window.location.hash).toBe('#/runs')
  })
})

// ---- Actions --------------------------------------------------------------------------------------------------------

describe('actions', () => {
  it('lists the actions with their keys; Stop and Open diff only in a run', async () => {
    mount()
    await openPalette()
    expect(groupLabels('actions')).toEqual([
      'New run',
      'Open Dashboard',
      'Open Runs',
      'Open Plops',
      'Open Queue',
      'Run it',
      'Deploy',
      'New project',
      'Open Settings',
      'Toggle theme',
      'Switch to Easy mode',
      'Re-probe vendors',
      'Copy diagnostics',
    ])
    expect(screen.getByTestId('palette-item-action:dashboard').getAttribute('aria-keyshortcuts')).toBe(
      'Control+1',
    )
    expect(screen.getByTestId('palette-item-action:settings').textContent).toContain('Ctrl+3')
  })

  it('New run opens the Dashboard and puts the focus in the composer', async () => {
    window.location.hash = '#/runs'
    mount()
    await openPalette()
    await choose('action:new-run')
    expect(window.location.hash).toBe('#/')
    await settle()
    expect(intents).toEqual([{}])
    expect(document.activeElement).toBe(screen.getByTestId('fake-task'))
  })

  it('opens Dashboard, Runs and Settings', async () => {
    mount()
    await openPalette()
    await choose('action:settings')
    expect(window.location.hash).toBe('#/settings')
    await openPalette()
    await choose('action:runs')
    expect(window.location.hash).toBe('#/runs')
    await openPalette()
    await choose('action:dashboard')
    expect(window.location.hash).toBe('#/')
  })

  it('in a run that is still going: Stop the open run and Open diff', async () => {
    upsertSummaries([summary({ runId: 'r1', displayNo: 7, title: 'Add a flag', status: 'running' })])
    window.location.hash = '#/runs/r1'
    mount()
    await openPalette()
    expect(groupLabels('actions')).toEqual(expect.arrayContaining(['Stop the open run', 'Open diff']))
    expect(screen.getByTestId('palette-item-action:stop').textContent).toContain('#7 Add a flag')
    await choose('action:stop')
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: 'r1' }])
    await openPalette()
    await choose('action:diff')
    expect(window.location.hash).toBe('#/runs/r1/diff')
  })

  it('shows Stop disabled with the reason once the open run has ended', async () => {
    upsertSummaries([summary({ runId: 'r1', status: 'completed', phase: 'done' })])
    window.location.hash = '#/runs/r1'
    mount()
    await openPalette()
    const stop = screen.getByTestId('palette-item-action:stop')
    expect(stop.getAttribute('aria-disabled')).toBe('true')
    expect(stop.textContent).toContain('This run has ended')
    fireEvent.click(stop)
    await settle()
    expect(screen.getByTestId('palette')).toBeTruthy()
    expect(mock.callsOf('runs.stop')).toEqual([])
  })

  it('Toggle theme switches light and dark, and Undo puts the System setting back', async () => {
    mock.on('ui.setTheme', (req): ThemeState => {
      const theme = req.theme ?? 'system'
      return { theme, resolved: theme === 'dark' ? 'dark' : 'light', accent: 'slate' }
    })
    mount()
    await openPalette()
    expect(screen.getByTestId('palette-item-action:theme').textContent).toContain('Switch to dark')
    await choose('action:theme')
    expect(mock.callsOf('ui.setTheme')).toEqual([{ theme: 'dark' }])
    expect(useStore.getState().app.theme).toEqual({ theme: 'dark', resolved: 'dark', accent: 'slate' })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const toast = screen.getByText('Theme: Dark').closest('li') as HTMLElement
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await settle()
    expect(mock.callsOf('ui.setTheme')).toEqual([{ theme: 'dark' }, { theme: 'system' }])
    expect(useStore.getState().app.theme?.theme).toBe('system')
  })

  it("Re-probe vendors probes every built vendor with force and says how each is now, in core's words", async () => {
    upsertProbes([probeView('claude', 'login-needed'), probeView('codex', 'not-built', { built: false })])
    mock.on('vendors.probe', (req) => [
      probeView(req.vendor ?? 'claude', 'ready', { displayName: 'Claude', healthDetail: 'Ready · 2.1.288' }),
    ])
    mount()
    await openPalette()
    await choose('action:reprobe')
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(useStore.getState().probes.byVendor['claude']?.health).toBe('ready')
    expect(screen.getByText('Claude: Ready · 2.1.288')).toBeTruthy()
  })

  it('Copy diagnostics copies through core and says so, or shows why not', async () => {
    mount()
    await openPalette()
    await choose('action:diagnostics')
    expect(mock.callsOf('diagnostics.copy')).toEqual([{}])
    expect(screen.getByText('diagnostics.copy is not mocked')).toBeTruthy()
    mock.on('diagnostics.copy', () => undefined)
    await openPalette()
    await choose('action:diagnostics')
    expect(screen.getByText('Diagnostics copied')).toBeTruthy()
  })
})

// ---- Needs you ------------------------------------------------------------------------------------------------------

const askItem: AttentionItem = {
  id: 'ask:r1:req-1',
  runId: 'r1',
  displayNo: 3,
  title: 'Add a --version flag',
  folder: 'C:\\work\\api',
  since: 0,
  kind: 'ask',
  ask: {
    runId: 'r1',
    step: 'implement',
    attempt: 1,
    requestId: 'req-1',
    vendor: 'claude',
    kind: 'shell',
    detail: 'npm test',
    expiresAt: 600_000,
    allowSession: true,
    queue: { index: 1, total: 1 },
  },
}

const gateItem: AttentionItem = {
  id: 'card:r2:card-1',
  runId: 'r2',
  displayNo: 4,
  title: 'Refactor the logger',
  folder: 'C:\\work\\web',
  since: 0,
  kind: 'card',
  cardId: 'card-1',
  cardKind: 'gate:afterPlan',
  cardTitle: 'Plan ready for review',
  blocking: true,
}

describe('Needs you', () => {
  it("lists core's attention items in its words, and none when nothing needs you", async () => {
    mount()
    await openPalette()
    expect(screen.queryByTestId('palette-group-needs-you')).toBeNull()
    pressOn(input(), 'Escape')
    await settle()
    setAttention(2, [askItem, gateItem])
    await openPalette()
    expect(groupLabels('needs-you')).toEqual(['#3 Add a --version flag', '#4 Refactor the logger'])
    expect(screen.getByTestId('palette-item-needs:ask:r1:req-1').textContent).toContain(
      'Claude wants to run: npm test',
    )
    expect(screen.getByTestId('palette-item-needs:card:r2:card-1').textContent).toContain(
      'Plan ready for review',
    )
  })

  it('an ask opens its run with the focus on the ask', async () => {
    setAttention(1, [askItem])
    mount()
    await openPalette()
    await choose('needs:ask:r1:req-1')
    expect(window.location.hash).toBe('#/runs/r1')
    await settle()
    expect(document.activeElement?.getAttribute('data-request-id')).toBe('req-1')
  })

  it('a gate opens its run and waits for the card to show, then focuses it', async () => {
    targetShownAtOnce = false
    try {
      setAttention(1, [gateItem])
      mount()
      await openPalette()
      await choose('needs:card:r2:card-1')
      expect(window.location.hash).toBe('#/runs/r2')
      await settle()
      expect(document.activeElement?.getAttribute('data-card-id')).toBeNull()
      act(() => {
        window.dispatchEvent(new Event('show-target'))
      })
      await settle()
      expect(document.activeElement?.getAttribute('data-card-id')).toBe('card-1')
    } finally {
      targetShownAtOnce = true
    }
  })
})

// ---- Runs and Folders -----------------------------------------------------------------------------------------------

describe('Runs', () => {
  beforeEach(() => {
    upsertSummaries([
      summary({
        runId: 'a',
        displayNo: 1,
        title: 'Add a --version flag',
        folder: 'C:\\work\\api',
        status: 'completed',
        createdAt: 1,
      }),
      summary({
        runId: 'b',
        displayNo: 2,
        title: 'Fix the flaky test',
        folder: 'C:\\work\\web',
        status: 'running',
        createdAt: 2,
      }),
      summary({
        runId: 'c',
        displayNo: 3,
        title: 'Refactor logging',
        folder: 'C:\\work\\api',
        status: 'failed',
        createdAt: 3,
      }),
    ])
  })

  it('lists the active runs first, then the most recent, with status and folder', async () => {
    mount()
    await openPalette()
    expect(groupLabels('runs')).toEqual([
      '#2 Fix the flaky test',
      '#3 Refactor logging',
      '#1 Add a --version flag',
    ])
    expect(screen.getByTestId('palette-item-run:b').textContent).toContain('Running · web')
  })

  it('finds a run by a fuzzy title, its folder or its number, and opens it', async () => {
    mount()
    await openPalette()
    await search('flky tst')
    expect(groupLabels('runs')).toEqual(['#2 Fix the flaky test'])
    await search('web')
    expect(groupLabels('runs')).toContain('#2 Fix the flaky test')
    expect(groupLabels('runs')).not.toContain('#1 Add a --version flag')
    await search('#3')
    expect(groupLabels('runs')[0]).toBe('#3 Refactor logging')
    await search('qqqqzz')
    expect(screen.getByText('Nothing matches.')).toBeTruthy()
    await search('refactor log')
    await enter()
    expect(window.location.hash).toBe('#/runs/c')
  })
})

describe('Folders', () => {
  it('lists recent folders and chooses one in the composer', async () => {
    mock.on('folders.recent', () => [
      { folder: 'C:\\work\\api', scopeRoot: 'C:\\work\\api', lastRunAt: 3, isGit: true, exists: true },
      { folder: 'C:\\old\\gone', scopeRoot: null, lastRunAt: 2, isGit: false, exists: false },
    ])
    window.location.hash = '#/settings'
    mount()
    await openPalette()
    expect(groupLabels('folders')).toEqual(['api', 'gone'])
    expect(screen.getByTestId('palette-item-folder:C:\\old\\gone').textContent).toContain('no longer exists')
    await choose('folder:C:\\work\\api')
    expect(window.location.hash).toBe('#/')
    await settle()
    expect(intents).toEqual([{ folder: 'C:\\work\\api' }])
    expect(document.activeElement).toBe(screen.getByTestId('fake-task'))
  })
})

// ---- Settings index -------------------------------------------------------------------------------------------------

describe('Settings index', () => {
  it('lists every section and every row by label with its place, and finds rows by search', async () => {
    upsertProbes([probeView('claude', 'ready', { displayName: 'Claude' })])
    mount()
    await openPalette()
    const labels = groupLabels('settings')
    for (const s of [
      'General',
      'Vendors',
      'Profiles',
      'Prompts',
      'Self-heal',
      'Catalog',
      'Isolation & Verify',
    ])
      expect(labels).toContain(s)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Claude executable path',
        'Claude default model',
        'Play a sound',
        'Diagnose unknown failures automatically',
        'Restore the last good copy',
      ]),
    )
    expect(
      screen.getByTestId('palette-item-field:notifications::/notifications/sound').textContent,
    ).toContain('Notifications · Desktop notifications')
    await search('sound')
    expect(groupLabels('settings')[0]).toBe('Play a sound')
  })

  it('a row deep-links to its field and focuses it once the section can give it the focus', async () => {
    mount()
    await openPalette()
    await search('play a sound')
    await enter()
    expect(window.location.hash).toBe('#/settings/notifications?field=%2Fnotifications%2Fsound')
    // The switches wait for their values (read after LOAD_DELAY_MS): the focus waits with them.
    expect(screen.getByTestId('settings-content').dataset['section']).toBe('notifications')
    await settle(LOAD_DELAY_MS)
    await settle()
    const sound = screen.getByRole('switch', { name: 'Play a sound' })
    expect(sound.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(sound)
  })

  it('choosing the row of the link already open focuses it again', async () => {
    window.location.hash = '#/settings/notifications?field=%2Fnotifications%2Fsound'
    mount()
    await settle(LOAD_DELAY_MS)
    await settle()
    const sound = screen.getByRole('switch', { name: 'Play a sound' })
    expect(document.activeElement).toBe(sound)
    screen.getByTestId('before').focus()
    await openPalette()
    await choose('field:notifications::/notifications/sound')
    await settle()
    expect(document.activeElement).toBe(sound)
  })

  it('a section opens at its top with nothing focused for it', async () => {
    mount()
    await openPalette()
    await choose('section:appearance')
    expect(window.location.hash).toBe('#/settings/appearance')
    expect(screen.getByTestId('settings-content').dataset['section']).toBe('appearance')
  })
})
