// Isolated-run cards (Cards: "depsConsent / depsFailed: Command + streamed output", "finalize /
// finalizeConflicts / interruptedApply"; deps detection, Finalize, Apply). Core builds each card
// (src/core/supervisor/cards.ts); the renderer shows the install command, where it runs and what it was found from,
// what went wrong with the end of the install's output, an editor for [Edit command] that refuses shell syntax, the
// finalize choices, a pair of [Keep mine] / [Take run's] per conflicting file with the run's change to it, and
// [Finish apply]; it sends core's choice ids (and the paths a conflicts choice applies to).
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CardView as CardData } from '@shared/run.ts'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import {
  CONFLICT_CHOICE,
  DEPS_CHOICE,
  FINALIZE_CHOICE,
  INTERRUPTED_APPLY_CHOICE,
} from '@renderer/components/cards/payload.ts'
import { resetLaterChoicesForTests } from '@renderer/components/cards/resolve.ts'
import { KEEP_MINE_ALL, patchLines, TAKE_RUNS_ALL } from '@renderer/components/cards/ConflictsBody.tsx'
import {
  installSource,
  installWhere,
  installWhy,
  USE_COMMAND_LABEL,
} from '@renderer/components/cards/DepsBody.tsx'
import { interruptedText } from '@renderer/components/cards/InterruptedApplyBody.tsx'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { conflictsOf, depsOf } from '@renderer/components/run/isolation.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import coreCards from '../../../src/core/supervisor/cards.ts?raw'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { conflictsCard, depsConsentCard, depsFailedCard, finalizeCard, interruptedCard } from './fixtures.ts'

const EM_DASH = '\u2014'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  clearToasts()
  resetRecoveryForTests()
  resetLaterChoicesForTests()
  setMacForTests(false)
  mock = installMockDimFactory({
    handlers: {
      'cards.resolve': () => undefined,
      'runs.get': () => snapWith(),
      'diff.file': (req) => ({
        patch: `diff --git a/${req.path} b/${req.path}\n--- a/${req.path}\n+++ b/${req.path}\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n`,
        truncated: false,
      }),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  setMacForTests(null)
  resetBridgeForTests()
})

function mount(card: CardData): HTMLElement {
  renderUi(<CardView runId={RUN} card={card} folder="C:\\work\\repo" />)
  return screen.getByTestId(`card-${card.kind}`)
}

async function choose(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`card-choice-${id}`))
    await settle()
  })
}

/** `key: 'value'` pairs of an `export const <name> = {…}` block in a source file. */
function constBlock(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`const ${name}`)
  expect(start, name).toBeGreaterThan(-1)
  const open = src.indexOf('{', start)
  const close = src.indexOf('}', open)
  const out: Record<string, string> = {}
  for (const m of src.slice(open, close).matchAll(/^\s*'?([\w-]+)'?:\s*'([^']*)',?\s*$/gm)) {
    out[m[1] as string] = m[2] as string
  }
  return out
}

describe('depsConsent', () => {
  it('shows the command, where it runs and what it was found from; Install and Skip install send core’s ids', async () => {
    const card = mount(depsConsentCard())
    expect(
      within(card).getByRole('heading', { name: 'Install dependencies in the isolated copy?' }),
    ).toBeTruthy()
    expect(screen.getByTestId('deps-command').textContent).toBe('pnpm install --frozen-lockfile')
    expect(screen.getByTestId('deps-where').textContent).toBe(
      'In the isolated copy · Found from pnpm-lock.yaml',
    )
    // Core's lead and closing words around the command.
    expect(card.textContent).toContain('starts without your installed dependencies')
    expect(card.textContent).toContain('Install trusts it for this project and runs it.')
    // Nothing failed yet: no "What went wrong", no excerpt.
    expect(screen.queryByTestId('deps-why')).toBeNull()
    expect(screen.queryByTestId('deps-excerpt')).toBeNull()
    expect(card.textContent?.includes(EM_DASH)).toBe(false)
    await choose('install')
    await choose('skip-install')
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'deps-1', choiceId: 'install' },
      { runId: RUN, cardId: 'deps-1', choiceId: 'skip-install' },
    ])
  })

  it('Edit command opens an editor in place: shell syntax is refused before anything is sent; a valid line goes with core’s edit choice', async () => {
    mount(depsConsentCard())
    const edit = screen.getByTestId('card-choice-edit-command')
    expect(edit.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(edit)
    await settle()
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    expect(edit.textContent).toBe('Edit command')
    const line = screen.getByTestId<HTMLInputElement>('deps-edit-line')
    expect(line.value).toBe('pnpm install --frozen-lockfile')
    // The error line is there (empty) before anything is typed: typing never moves what follows.
    expect(screen.getByTestId('deps-edit-error').textContent).toBe('')
    expect(screen.getByTestId('deps-edit-error').className).toContain('min-h-4')

    fireEvent.change(line, { target: { value: 'pnpm install | tee install.log' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('deps-edit-use'))
      await settle()
    })
    expect(screen.getByTestId('deps-edit-error').textContent).toBe(
      '`|` needs a shell, and Dim Factory runs install commands without one: use a package script',
    )
    expect(mock.callsOf('cards.resolve')).toEqual([])

    fireEvent.change(line, { target: { value: 'pnpm install --offline' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('deps-edit-use'))
      await settle()
    })
    expect(screen.getByTestId('deps-edit-use').textContent).toBe(USE_COMMAND_LABEL)
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'deps-1', choiceId: 'edit-command', input: 'pnpm install --offline' },
    ])
  })

  it('names where a configured or edited command came from', () => {
    expect(installSource({ ...depsOf(depsConsentCard({ source: 'config' })) })).toBe(
      "From the project's settings (installCommand)",
    )
    expect(installSource({ ...depsOf(depsConsentCard({ source: 'edited' })) })).toBe('As you edited it')
    expect(installWhere('packages/app')).toBe('In packages/app, in the isolated copy')
    expect(depsOf({ ...depsConsentCard(), payload: null })).toMatchObject({
      command: '',
      argv: [],
      cwdRel: '.',
      source: null,
      exitCode: null,
      timedOut: false,
    })
  })
})

describe('depsFailed', () => {
  it('says what went wrong with the end of the install output (an inner region); Retry, Skip install and Cancel run', async () => {
    const card = mount(depsFailedCard())
    expect(within(card).getByRole('heading', { name: 'Installing dependencies failed' })).toBeTruthy()
    expect(screen.getByTestId('deps-why').textContent).toBe('It exited with code 1.')
    const excerpt = screen.getByTestId('deps-excerpt')
    expect(excerpt.textContent).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
    expect(excerpt.getAttribute('data-scroll-region')).toBe('prepare-output')
    expect(excerpt.className).toContain('max-h-[min(20rem,var(--run-region-max,50vh))]')
    expect(card.textContent).toContain('failed (exit 1)')
    expect(screen.getByTestId('card-choice-retry').className).toContain('bg-primary')
    await choose('retry')
    await choose('skip-install')
    await choose('cancel')
    expect(mock.callsOf('cards.resolve').map((r) => r.choiceId)).toEqual(['retry', 'skip-install', 'cancel'])
  })

  it('core’s reason is said once, under What went wrong; a timeout says so', () => {
    const card = mount(depsFailedCard({ reason: 'pnpm was not found.' }))
    expect(screen.getByTestId('deps-why').textContent).toBe('pnpm was not found.')
    expect(card.textContent?.split('pnpm was not found.').length).toBe(2)
    expect(installWhy({ reason: null, exitCode: null, timedOut: true })).toBe(
      'It ran for 15 minutes without finishing, so Dim Factory stopped it.',
    )
  })
})

describe('finalize', () => {
  it('shows core’s words and its choices, Apply first; each sends core’s id', async () => {
    const card = mount(finalizeCard())
    expect(within(card).getByRole('heading', { name: 'Apply the run to your folder?' })).toBeTruthy()
    expect(card.textContent).toContain('changed 3 files there. They are not in your folder yet.')
    expect(card.textContent).toContain('Discard deletes it in 10 seconds (you can undo that).')
    const labels = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(labels).toEqual(['Apply to folder', 'Keep for later', 'Discard'])
    expect(screen.getByTestId('card-choice-apply').className).toContain('bg-primary')
    expect(screen.getByTestId('card-choice-discard').className).toContain('text-destructive')
    await choose('apply')
    await choose('keep')
    await choose('discard')
    expect(mock.callsOf('cards.resolve').map((r) => r.choiceId)).toEqual(['apply', 'keep', 'discard'])
  })
})

describe('finalizeConflicts', () => {
  const two = [
    { path: 'src/config.ts', reason: 'changed in your folder since the run started' },
    { path: 'README.md' },
  ]

  it('gives each file its own Keep mine / Take run’s, sending that one path; the card’s row is for every file', async () => {
    const card = mount(conflictsCard(two))
    expect(within(card).getByRole('heading', { name: '2 files changed in your folder too' })).toBeTruthy()
    const rows = within(screen.getByTestId('conflict-files')).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['src/config.ts', 'README.md'])
    expect(rows[0]?.textContent).toContain('changed in your folder since the run started')
    // Core's list of files in its body is not repeated; its lead and closing words are.
    expect(card.textContent).toContain('so Apply left them as they are:')
    expect(card.textContent).not.toContain('- src/config.ts')
    expect(card.textContent).toContain("Take run's writes the run's version over it")

    await act(async () => {
      fireEvent.click(screen.getByTestId('conflict-1-theirs'))
      await settle()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('conflict-0-mine'))
      await settle()
    })
    expect(screen.getByTestId('card-choice-keep-mine').textContent).toBe(KEEP_MINE_ALL)
    expect(screen.getByTestId('card-choice-take-theirs').textContent).toBe(TAKE_RUNS_ALL)
    await choose('take-theirs')
    expect(mock.callsOf('cards.resolve')).toEqual([
      { runId: RUN, cardId: 'conf-1', choiceId: 'take-theirs', input: ['README.md'] },
      { runId: RUN, cardId: 'conf-1', choiceId: 'keep-mine', input: ['src/config.ts'] },
      // The card's own row: every listed file (no input).
      { runId: RUN, cardId: 'conf-1', choiceId: 'take-theirs' },
    ])
    // Nothing is chosen by default: no per-file choice is pressed or primary.
    expect(screen.getByTestId('conflict-0-theirs').className).not.toContain('bg-primary')
  })

  it('shows the run’s change to a file on a click, in the page flow', async () => {
    mount(conflictsCard(two))
    const toggle = screen.getByTestId('conflict-0-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.querySelector('[data-stable-label]')).not.toBeNull()
    await act(async () => {
      fireEvent.click(toggle)
      await settle()
    })
    await waitFor(() => expect(screen.getByTestId('conflict-diff')).toBeTruthy())
    expect(mock.callsOf('diff.file')).toEqual([{ runId: RUN, seg: 'combined', path: 'src/config.ts' }])
    const ops = [...screen.getByTestId('conflict-diff').querySelectorAll('[data-op]')].map((l) =>
      l.getAttribute('data-op'),
    )
    expect(ops).toEqual(['hunk', 'same', 'del', 'add'])
    expect(screen.getByTestId('conflict-diff').getAttribute('data-scroll-region')).toBeNull()
    expect(patchLines('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n')).toEqual([
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ])
  })

  it('keeps its layout when core settles a file: the buttons keep their labels', async () => {
    const view = renderUi(<CardView runId={RUN} card={conflictsCard(two)} folder="C:\\work\\repo" />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('conflict-1-mine'))
      await settle()
    })
    // Core keeps the card open with the one file left.
    view.rerender(
      <TooltipProvider>
        <CardView runId={RUN} card={conflictsCard([two[0] as { path: string }])} folder="C:\work\repo" />
        <Toaster />
      </TooltipProvider>,
    )
    await settle()
    expect(screen.getByTestId('card-choice-keep-mine').textContent).toBe(KEEP_MINE_ALL)
    expect(screen.getByTestId('conflict-0-theirs')).toBeTruthy()
  })

  it('with one file, core’s two choices are the file’s own (no second pair)', async () => {
    mount(conflictsCard([{ path: 'src/config.ts' }]))
    expect(screen.queryByTestId('conflict-0-mine')).toBeNull()
    expect(screen.getByTestId('card-choice-keep-mine').textContent).toBe('Keep mine')
    expect(screen.getByTestId('card-choice-take-theirs').textContent).toBe("Take run's")
    await choose('keep-mine')
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'conf-1', choiceId: 'keep-mine' }])
    expect(conflictsOf(conflictsCard([{ path: 'a', reason: 'x' }, { path: 'a' }]))).toEqual([
      { path: 'a', reason: 'x' },
    ])
  })
})

describe('interruptedApply', () => {
  it('says what the journal holds and offers Finish apply', async () => {
    const card = mount(interruptedCard())
    expect(within(card).getByRole('heading', { name: 'Finish applying the run' })).toBeTruthy()
    expect(card.textContent).toContain('Dim Factory closed while it was applying the run to your folder')
    expect(screen.getByTestId('interrupted-facts').textContent).toBe(
      '2 files were applied before Dim Factory closed · 3 still to apply',
    )
    await choose('finish-apply')
    expect(mock.callsOf('cards.resolve')).toEqual([{ runId: RUN, cardId: 'int-1', choiceId: 'finish-apply' }])
    expect(interruptedText({ done: null, remaining: null })).toBe('')
    expect(interruptedText({ done: 1, remaining: null })).toBe('1 file was applied before Dim Factory closed')
  })
})

describe('core’s choice ids', () => {
  it('match supervisor/cards.ts', () => {
    expect(constBlock(coreCards, 'DEPS_CHOICE')).toEqual({ ...DEPS_CHOICE })
    expect(constBlock(coreCards, 'FINALIZE_CHOICE')).toEqual({ ...FINALIZE_CHOICE })
    expect(constBlock(coreCards, 'CONFLICT_CHOICE')).toEqual({ ...CONFLICT_CHOICE })
    expect(constBlock(coreCards, 'INTERRUPTED_APPLY_CHOICE')).toEqual({ ...INTERRUPTED_APPLY_CHOICE })
  })
})
