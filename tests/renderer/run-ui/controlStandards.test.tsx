// The UI standards in the Run view, its cards and the attention panel: no em dash in
// what they show (an unknown value gets a word), and no button changes size when its text or state changes. A busy
// button keeps its label and its slots (the spinner takes the icon slot or covers the key chip; a card's choices say
// "Sending your choice…" beside them), and a label that must change reserves its widest form (StableLabel).
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '@shared/findings.ts'
import type { AskView, CardView as CardData, FreshReason } from '@shared/run.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import { SENDING_CHOICE } from '@renderer/components/cards/ChoiceButton.tsx'
import { CardView } from '@renderer/components/cards/CardView.tsx'
import { AttentionPanel } from '@renderer/components/run/AttentionPanel.tsx'
import { PausedNotice } from '@renderer/components/run/PausedNotice.tsx'
import { PhaseTimeline, TimelineRuler } from '@renderer/components/run/PhaseTimeline.tsx'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { SESSION_NOTE_TEXT, freshLineText } from '@renderer/components/run/SessionLine.tsx'
import { FRESH_REASON_TEXT } from '@renderer/components/run/text.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { ConfigTab } from '@renderer/pages/run/ConfigTab.tsx'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { deferred, installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'

const EM_DASH = '\u2014'

let mock: MockDimFactory
let release: () => void

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  setMacForTests(false)
  // Every command answers only when the test releases it, so the busy state can be looked at.
  const hold = (): Promise<undefined> => {
    const d = deferred<undefined>()
    const prev = release
    release = () => {
      prev()
      d.resolve(undefined)
    }
    return d.promise
  }
  release = () => undefined
  mock = installMockDimFactory({
    handlers: {
      'cards.resolve': hold,
      'asks.answer': hold,
      'runs.resume': hold,
      'runs.stop': hold,
      'runs.get': () => snapWith(),
      'runs.events': eventsHandler(() => []),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
    },
  })
})

afterEach(async () => {
  await act(async () => {
    release()
    await settle()
  })
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
})

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

/** What decides a button's width: its text and its glyph slots (icons, spinners). */
function shape(el: HTMLElement): { text: string | null; glyphs: number } {
  return { text: el.textContent, glyphs: el.querySelectorAll('svg').length }
}

/** The labels a StableLabel inside `el` reserves. */
function reserved(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-label]')].map((n) => n.getAttribute('data-label') ?? '')
}

function finding(n: number, severity: 'must' | 'should'): Finding {
  return { id: `f${n}`, n, severity, source: 'review', title: `Finding ${n}`, body: '', flags: [], round: 1 }
}

const PLAN = '# Plan\n1. Add a --version flag\n'
const planGate: CardData = {
  id: 'gate:afterPlan-1',
  kind: 'gate:afterPlan',
  title: 'Review the plan',
  body: PLAN,
  payload: { plan: PLAN },
  blocking: true,
  choices: [
    { id: 'approve', label: 'Approve', primary: true, input: 'plan' },
    { id: 'cancel', label: 'Cancel run', danger: true },
  ],
}

const twelve = Array.from({ length: 12 }, (_, i) => finding(i + 1, i < 4 ? 'must' : 'should'))
const beforeFix: CardData = {
  id: 'gate:beforeFix-2',
  kind: 'gate:beforeFix',
  title: '12 findings before Fix',
  body: '',
  payload: { step: 'fix', findings: twelve, selected: twelve.map((f) => f.id), notes: [] },
  blocking: true,
  choices: [
    { id: 'continue', label: 'Continue with 12 findings', primary: true, input: 'findings' },
    { id: 'skip-fix', label: 'Skip Fix' },
  ],
}

describe('card choices', () => {
  it('keep their labels while one is sent; the row says so beside them', async () => {
    renderUi(<CardView runId={RUN} card={planGate} folder="C:\\repo" />)
    const approve = screen.getByTestId('card-choice-approve')
    const cancel = screen.getByTestId('card-choice-cancel')
    const before = [shape(approve), shape(cancel)]
    expect(screen.getByTestId('card-choice-status').textContent).toBe('')

    await click(approve)
    expect(approve.getAttribute('aria-busy')).toBe('true')
    expect(cancel.hasAttribute('aria-busy')).toBe(false)
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect((cancel as HTMLButtonElement).disabled).toBe(true)
    expect([shape(approve), shape(cancel)]).toEqual(before)
    expect(screen.getByTestId('card-choice-status').textContent).toBe(SENDING_CHOICE)

    await act(async () => {
      release()
      await settle()
    })
    expect(screen.getByTestId('card-choice-status').textContent).toBe('')
    expect([shape(approve), shape(cancel)]).toEqual(before)
  })

  it('reserves "Approve edited plan" before the plan is edited, and both Edit and Preview', () => {
    renderUi(<CardView runId={RUN} card={planGate} folder="C:\\repo" />)
    const approve = screen.getByTestId('card-choice-approve')
    expect(reserved(approve)).toEqual(expect.arrayContaining(['Approve', 'Approve edited plan']))
    const edit = screen.getByTestId('plan-edit')
    expect(reserved(edit)).toEqual(['Edit', 'Preview'])
    const glyphs = shape(edit).glyphs

    fireEvent.click(edit)
    expect(edit.textContent).toBe('Preview')
    expect(shape(edit).glyphs).toBe(glyphs)
    fireEvent.change(screen.getByTestId('plan-editor'), { target: { value: `${PLAN}2. Test it\n` } })
    expect(approve.textContent).toContain('Approve edited plan')
    expect(reserved(approve)).toEqual(expect.arrayContaining(['Approve', 'Approve edited plan']))
  })

  it('keeps the edit counts out of the changes link, which reserves View and Hide', () => {
    renderUi(<CardView runId={RUN} card={planGate} folder="C:\\repo" />)
    fireEvent.click(screen.getByTestId('plan-edit'))
    const editor = screen.getByTestId('plan-editor')
    fireEvent.change(editor, { target: { value: `${PLAN}2. Test it\n` } })
    const link = screen.getByTestId('plan-view-changes')
    expect(link.textContent).toBe('View changes')
    expect(reserved(link)).toEqual(['View changes', 'Hide changes'])
    expect(screen.getByTestId('plan-edit-counts').textContent).toBe('Edited · +1 −0')
    // Another keystroke changes the counts, never the link.
    fireEvent.change(editor, { target: { value: `${PLAN}2. Test it\n3. Ship it\n` } })
    expect(link.textContent).toBe('View changes')
    expect(screen.getByTestId('plan-edit-counts').textContent).toBe('Edited · +2 −0')
    fireEvent.click(link)
    expect(link.textContent).toBe('Hide changes')
  })

  it('reserves the widest count on Continue, in tabular figures', () => {
    renderUi(<CardView runId={RUN} card={beforeFix} folder="C:\\repo" />)
    const go = screen.getByTestId('card-choice-continue')
    expect(go.textContent).toContain('Continue with 12 findings')
    expect(reserved(go)).toContain('Continue with 00 findings')
    expect(go.className).toContain('tabular-nums')
    fireEvent.click(screen.getByTestId('finding-f1').querySelector('button') as HTMLElement)
    expect(go.textContent).toContain('Continue with 11 findings')
    expect(reserved(go)).toContain('Continue with 00 findings')
  })

  it('marks the selected findings filter without a bolder label', () => {
    renderUi(<CardView runId={RUN} card={beforeFix} folder="C:\\repo" />)
    const must = screen.getByTestId('findings-filter-must')
    const before = must.className.split(' ').filter((c) => c.startsWith('font-'))
    fireEvent.click(must)
    expect(must.getAttribute('aria-pressed')).toBe('true')
    expect(must.className.split(' ').filter((c) => c.startsWith('font-'))).toEqual(before)
  })

  it('stall: Keep waiting and Stop run keep their labels while one is sent', async () => {
    renderUi(
      <CardView
        runId={RUN}
        folder="C:\\repo"
        card={{
          id: 'stall-3',
          kind: 'stall',
          title: 'No output for 5m',
          body: '',
          payload: { step: 'implement', idleMs: 300_000 },
          blocking: false,
          choices: [
            { id: 'keep-waiting', label: 'Keep waiting', primary: true },
            { id: 'stop', label: 'Stop run', danger: true },
          ],
        }}
      />,
    )
    const keep = screen.getByTestId('stall-keep-waiting')
    const before = shape(keep)
    await click(keep)
    expect(keep.getAttribute('aria-busy')).toBe('true')
    expect(shape(keep)).toEqual(before)
    expect(screen.getByTestId('card-choice-status').textContent).toBe(SENDING_CHOICE)
  })
})

describe('asks and paused steps', () => {
  const ask: AskView = {
    runId: RUN,
    step: 'implement',
    attempt: 1,
    requestId: 'req-1',
    vendor: 'claude',
    kind: 'shell',
    detail: 'npm test',
    expiresAt: Date.now() + 120_000,
    allowSession: true,
    queue: { index: 1, total: 1 },
  }

  it('an answer in flight keeps every answer button the same: the spinner covers the key chip', async () => {
    renderUi(<AttentionPanel snap={snapWith({ extra: { asks: [ask] } })} />)
    const ids = ['ask-allow', 'ask-allow-session', 'ask-deny']
    const before = ids.map((id) => shape(screen.getByTestId(id)))
    await click(screen.getByTestId('ask-allow'))
    const allow = screen.getByTestId('ask-allow')
    expect(allow.getAttribute('aria-busy')).toBe('true')
    expect(allow.querySelector('[data-spinner]')).not.toBeNull()
    expect(within(allow).getByText('Allow once')).toBeTruthy()
    // The spinner sits over the chip (one more glyph, no more width); the others are unchanged.
    expect(allow.textContent).toBe(before[0]?.text)
    expect(ids.slice(1).map((id) => shape(screen.getByTestId(id)))).toEqual(before.slice(1))
  })

  it('the deny countdown uses tabular figures so Undo never moves; Undo spins in its icon slot', async () => {
    const now = Date.now()
    renderUi(
      <AttentionPanel snap={snapWith({ extra: { asks: [{ ...ask, pendingDenyUntil: now + 3000 }] } })} />,
    )
    const row = screen.getByTestId('ask-pending-deny')
    expect(row.querySelector('.tabular-nums')?.textContent).toMatch(/^Denied · sent in [0-3] s$/)
    mock.on('asks.undo', () => new Promise(() => undefined))
    const undo = screen.getByTestId('ask-undo')
    const before = shape(undo)
    await click(undo)
    expect(undo.getAttribute('aria-busy')).toBe('true')
    expect(undo.querySelector('[data-spinner]')).not.toBeNull()
    expect(shape(undo)).toEqual(before)
  })

  it('a paused step’s Resume spins in its icon slot and keeps its label', async () => {
    renderUi(
      <PausedNotice
        runId={RUN}
        view={{ key: 'implement', status: 'paused', attempt: 1, activeMs: 1000, pause: 'interrupted' }}
      />,
    )
    const resume = screen.getByTestId('resume')
    const stop = screen.getByTestId('paused-stop')
    const before = [shape(resume), shape(stop)]
    await click(resume)
    expect(resume.getAttribute('aria-busy')).toBe('true')
    expect(resume.querySelector('[data-spinner]')).not.toBeNull()
    expect([shape(resume), shape(stop)]).toEqual(before)
  })
})

describe('Run view header, tabs, timeline and Config', () => {
  it('Stop keeps its label while stopping; the spinner takes the icon slot', () => {
    const snap = snapWith({ summary: { status: 'running', phase: 'implementing' } })
    const idle = renderUi(<RunHeader snap={snap} onStop={() => undefined} stopping={false} />)
    const before = shape(screen.getByTestId('stop-run'))
    idle.unmount()
    renderUi(<RunHeader snap={snap} onStop={() => undefined} stopping />)
    const stop = screen.getByTestId('stop-run')
    expect(stop.getAttribute('aria-busy')).toBe('true')
    expect(stop.querySelector('[data-spinner]')).not.toBeNull()
    expect(shape(stop)).toEqual(before)
  })

  it.each([
    ['running, nothing reported yet', 'running', 0, 'No cost yet'],
    ['ended, nothing reported', 'cancelled', 0, 'No cost reported'],
    ['usage reported, no price for it', 'running', 1200, 'No price'],
  ] as const)('a run cost without a figure is a word, muted: %s', (_, status, tokens, word) => {
    const snap = snapWith({ summary: { status, progress: { tokens, costUsd: null, filesChanged: 0 } } })
    renderUi(<RunHeader snap={snap} onStop={() => undefined} stopping={false} />)
    const header = screen.getByTestId('run-header')
    expect(header.textContent).not.toContain(EM_DASH)
    const cost = screen.getByTestId('run-cost')
    expect(cost.textContent).toBe(word)
    expect(cost.className).toContain('text-muted-foreground')
  })

  it('the Diff tab reserves a three-digit file count in a pill inside the tab, padded like every tab', async () => {
    mock.on('runs.get', () =>
      snapWith({
        summary: { status: 'running', progress: { ...snapWith().summary.progress, filesChanged: 7 } },
      }),
    )
    const stopBridge = startBridge()
    try {
      renderUi(<RunPage runId={RUN} tab="flow" />)
      await act(async () => {
        await settle(10)
      })
    } finally {
      stopBridge()
    }
    const tab = await screen.findByTestId('run-tab-diff')
    expect(tab.textContent).toBe('Diff(7)')
    // The count is centred in a pill that keeps three digits' room: no gap left after it, inside or outside the tab.
    const count = within(tab).getByTestId('diff-count')
    expect(reserved(count)).toEqual(['000'])
    expect(count.className).toContain('rounded-full')
    expect(count.querySelector('[data-stable-label]')?.className).toContain('justify-items-center')
    const padding = (el: HTMLElement): string[] => el.className.split(' ').filter((c) => /^p[xlr]-/.test(c))
    expect(padding(tab)).toEqual(padding(screen.getByTestId('run-tab-log')))
  })

  it('timeline nodes keep one width and two lines, Review and Critic side by side; the row wraps, never scrolls', () => {
    const snap = snapWith({
      summary: { status: 'running' },
      steps: {
        plan: { status: 'done', attempt: 1, activeMs: 65_000 },
        implement: { status: 'running', attempt: 1, activeMs: 1000, eta: { p50: 360_000, p80: 480_000 } },
      },
    })
    renderUi(<PhaseTimeline snap={snap} />)
    const nodes = screen.getAllByTestId(/^timeline-node-/)
    const widths = nodes.map((n) => n.className.split(' ').filter((c) => /^(min-|max-)?w-/.test(c)))
    expect(widths.length).toBeGreaterThan(1)
    // 104 px: a run's row (Review and Critic side by side) fits one line in a 1280 px window at 125%.
    for (const w of widths) expect(w).toEqual(['w-26'])
    // Two lines in every node: the step; its status, with its time after it once it has one (cut to fit, whole in
    // the tooltip and for screen readers).
    for (const n of nodes) expect(n.children).toHaveLength(2)
    expect(screen.getByTestId('timeline-time-implement').textContent).toMatch(/^, \d+:\d\d \/ ~6 min$/)
    expect(screen.getByTestId('timeline-node-implement').children[1]?.textContent).toMatch(
      /^: Running \u00b7 , \d+:\d\d \/ ~6 min$/,
    )
    expect(screen.getByTestId('timeline-time-review').textContent).toBe('')
    expect(screen.getByTestId('timeline-node-review').children[1]?.textContent).toBe(': Queued')
    const timeline = screen.getByTestId('phase-timeline')
    expect(timeline.className).not.toContain('overflow-x')
    const row = timeline.querySelector('ol')
    expect(row?.className).toContain('flex-wrap')
    // Nodes keep to the top of the row: none is stretched to the height of the Review \u2016 Critic column.
    expect(row?.className).toContain('items-start')
    expect(row?.className).not.toContain('items-stretch')
    // Review and Critic share their column side by side: the row is one node tall, nothing empty under the others.
    const pair = screen.getByTestId('timeline-node-review').parentElement as HTMLElement
    expect(pair.tagName).toBe('LI')
    expect(pair.contains(screen.getByTestId('timeline-node-critic'))).toBe(true)
    expect(pair.className.split(' ')).not.toContain('flex-col')
  })

  it('the timeline ruler is the full row, unseen: nothing in it can be found, focused or named', () => {
    const snap = snapWith({
      summary: { status: 'running' },
      steps: { implement: { status: 'running', attempt: 1, activeMs: 1000 } },
    })
    const { container } = renderUi(<TimelineRuler snap={snap} />)
    const ruler = container.querySelector('[data-timeline-ruler]') as HTMLElement
    expect(ruler.getAttribute('aria-hidden')).toBe('true')
    expect(ruler.className.split(' ')).toEqual(expect.arrayContaining(['invisible', 'pointer-events-none']))
    expect(ruler.querySelectorAll('[data-testid], button, [role], [title], [tabindex]')).toHaveLength(0)
    // No text cut with an ellipsis that nothing explains: lines are clipped instead, at the same height.
    expect(ruler.querySelectorAll('.truncate')).toHaveLength(0)
    // The same row as the timeline: as many columns, nodes of the same box.
    renderUi(<PhaseTimeline snap={snap} />)
    const shown = screen.getByTestId('phase-timeline').querySelector('ol') as HTMLElement
    const twin = ruler.querySelector('ol') as HTMLElement
    expect(twin.className).toBe(shown.className)
    expect(twin.children).toHaveLength(shown.children.length)
    const box = (el: Element | null | undefined): string[] =>
      (el?.className.toString() ?? '').split(' ').filter((c) => /^(w-|h-|px-|py-|gap-|border$|flex)/.test(c))
    expect(box(twin.querySelector('li > span'))).toEqual(box(screen.getByTestId('timeline-node-preflight')))
  })

  it('Config says "Not recorded" for what core did not record, never a dash', () => {
    const snap = snapWith({
      steps: {
        plan: { status: 'done', attempt: 1, mode: 'readonly' },
        implement: { status: 'running', attempt: 1, vendor: 'claude' },
      },
    })
    renderUi(<ConfigTab snap={snap} />)
    const tab = screen.getByTestId('config-tab')
    expect(tab.textContent).not.toContain(EM_DASH)
    const plan = screen.getByTestId('config-row-plan')
    // Plan: no vendor, model, plan mode or route recorded.
    expect(within(plan).getAllByText('Not recorded')).toHaveLength(4)
    const implement = screen.getByTestId('config-row-implement')
    expect(within(implement).getByText('Claude')).toBeTruthy()
    expect(within(implement).getAllByText('Not recorded')).toHaveLength(3)
  })
})

describe('session line words', () => {
  it('has no em dash for any reason, and reads as core’s note does in the dev CLI: "Fresh session: <reason>"', () => {
    for (const reason of FRESH_REASONS as readonly FreshReason[]) {
      const line = freshLineText(reason)
      expect(line).not.toContain(EM_DASH)
      expect(line).toBe(`Fresh session: ${FRESH_REASON_TEXT[reason]}`)
      // The note core writes and the CLI prints, word for word, apart from the capital.
      expect(line.toLowerCase()).toBe(
        `${SESSION_NOTE_TEXT.freshPrefix}${FRESH_REASON_TEXT[reason]}`.toLowerCase(),
      )
    }
  })
})
