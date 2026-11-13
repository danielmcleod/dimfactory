// Review (AttentionPanel, keys, accessibility; asks.spec.ts, keyboard.spec.ts):
//   - a held key's auto-repeat fires no shortcut (lib/keys.ts), so holding A or ⇧A cannot answer the asks that
//     come to the front one after another;
//   - an ask that moved up from the queue takes answers (keys and clicks) only after ASK_ARM_MS, so a second press
//     or click meant for the ask before it cannot answer one the user has not seen. A fresh ask is answerable at
//     once, as before;
//   - every new ask is a new node in the assertive region, even when its text equals the previous ask's (C04a asks
//     the same `npm --version` twice), so screen readers announce it again.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskView, RunSnapshot } from '@shared/run.ts'
import { ASK_ARM_MS } from '@renderer/components/attention/AskCard.tsx'
import { AttentionPanel } from '@renderer/components/run/AttentionPanel.tsx'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetCoreClock } from '@renderer/lib/coreClock.ts'
import { registerShortcut, resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  resetCoreClock()
  mock = installMockDimFactory({
    handlers: {
      'asks.answer': () => undefined,
      'asks.undo': () => undefined,
      'runs.get': () => snapWith(),
    },
  })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetCoreClock()
  resetBridgeForTests()
})

const EXPIRES = Date.now() + 599_500

function ask(requestId: string, index = 1, total = 1): AskView {
  return {
    runId: RUN,
    step: 'implement',
    attempt: 1,
    requestId,
    vendor: 'claude',
    kind: 'shell',
    detail: 'Bash: npm --version',
    expiresAt: EXPIRES,
    allowSession: true,
    queue: { index, total },
  }
}

const snapOf = (asks: AskView[]): RunSnapshot => snapWith({ extra: { asks } })

function Ui({ asks }: { asks: AskView[] }): React.JSX.Element {
  return (
    <TooltipProvider>
      <AttentionPanel snap={snapOf(asks)} />
      <Toaster />
    </TooltipProvider>
  )
}

function show(asks: AskView[]): { rerender: (asks: AskView[]) => void } {
  const r = render(<Ui asks={asks} />)
  return { rerender: (next) => r.rerender(<Ui asks={next} />) }
}

/** A keydown on the focused element (`repeat` as a held key's auto-repeat reports it). */
async function press(k: string, o: { shift?: boolean; repeat?: boolean } = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', {
    key: k,
    shiftKey: o.shift === true,
    repeat: o.repeat === true,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    ;(document.activeElement ?? document.body).dispatchEvent(e)
    await settle()
  })
  return e
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

/** Real time: the arming delay is a plain timer. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
    await settle()
  })
}

const answered = (): [string, string][] => mock.callsOf('asks.answer').map((r) => [r.requestId, r.decision])

describe('keys: auto-repeat (lib/keys.ts)', () => {
  it('a held key fires a shortcut once; a registration may opt in to repeats', async () => {
    const region = document.createElement('div')
    region.dataset['keyScope'] = 'ask'
    region.tabIndex = -1
    document.body.append(region)
    try {
      region.focus()
      const once = vi.fn()
      const off = registerShortcut('a', once, { scope: 'ask' })
      await press('a')
      const held = await press('a', { repeat: true })
      await press('a', { repeat: true })
      expect(once).toHaveBeenCalledTimes(1)
      // The repeat is still the shortcut's key: its default action does not happen either.
      expect(held.defaultPrevented).toBe(true)
      off()
      const stepping = vi.fn()
      registerShortcut('j', stepping, { scope: 'ask', repeat: true })
      await press('j')
      await press('j', { repeat: true })
      expect(stepping).toHaveBeenCalledTimes(2)
    } finally {
      region.remove()
    }
  })

  it('modifier combos ignore auto-repeat too', async () => {
    const approve = vi.fn()
    registerShortcut('mod+enter', approve)
    await act(async () => {
      for (const repeat of [false, true, true]) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            metaKey: false,
            repeat,
            bubbles: true,
            cancelable: true,
          }),
        )
      }
      await settle()
    })
    // ⌘ on macOS, Ctrl elsewhere: the test platform is not macOS.
    expect(approve).toHaveBeenCalledTimes(1)
  })
})

describe('an ask that comes to the front', () => {
  it('holding A answers the shown ask once and never the next one in the queue', async () => {
    const view = show([ask('req-1', 1, 2), ask('req-2', 2, 2)])
    expect(document.activeElement).toBe(screen.getByTestId('ask-panel'))
    await press('a')
    await press('a', { repeat: true })
    expect(answered()).toEqual([['req-1', 'allow']])
    // Core took req-1; the snapshot moves req-2 up and its card takes the focus.
    view.rerender([ask('req-2', 1, 1)])
    const next = screen.getByTestId('ask-panel')
    expect(next.dataset['requestId']).toBe('req-2')
    expect(document.activeElement).toBe(next)
    for (let i = 0; i < 5; i++) await press('a', { repeat: true })
    await press('A', { shift: true, repeat: true })
    expect(answered()).toEqual([['req-1', 'allow']])
  })

  it('a second press right after the queue moves up does not answer the next ask; after ASK_ARM_MS it does', async () => {
    const view = show([ask('req-1', 1, 2), ask('req-2', 2, 2)])
    await press('a')
    view.rerender([ask('req-2', 1, 1)])
    const next = screen.getByTestId('ask-panel')
    expect(next.dataset['armed']).toBe('false')
    await press('a')
    await press('A', { shift: true })
    await press('d')
    expect(answered()).toEqual([['req-1', 'allow']])
    await wait(ASK_ARM_MS + 100)
    expect(screen.getByTestId('ask-panel').dataset['armed']).toBe('true')
    await press('a')
    expect(answered()).toEqual([
      ['req-1', 'allow'],
      ['req-2', 'allow'],
    ])
  })

  it('a double click on Allow does not land on the ask that moved up', async () => {
    const view = show([ask('req-1', 1, 2), ask('req-2', 2, 2)])
    await click(screen.getByTestId('ask-allow'))
    view.rerender([ask('req-2', 1, 1)])
    const allow = screen.getByTestId('ask-allow')
    expect(allow).toHaveProperty('disabled', true)
    await click(allow)
    expect(answered()).toEqual([['req-1', 'allow']])
    await wait(ASK_ARM_MS + 100)
    expect(screen.getByTestId('ask-allow')).toHaveProperty('disabled', false)
    await click(screen.getByTestId('ask-allow'))
    expect(answered()).toEqual([
      ['req-1', 'allow'],
      ['req-2', 'allow'],
    ])
  })

  it('a fresh ask (not waiting in the queue before) is answerable at once', async () => {
    const view = show([ask('req-1')])
    expect(screen.getByTestId('ask-panel').dataset['armed']).toBe('true')
    await press('a')
    view.rerender([])
    view.rerender([ask('req-2')])
    const next = screen.getByTestId('ask-panel')
    expect(next.dataset['armed']).toBe('true')
    expect(document.activeElement).toBe(next)
    await press('a')
    // Straight from one ask to a new one (the vendor asked again before the snapshot showed the queue empty).
    view.rerender([ask('req-3')])
    await press('d')
    expect(answered()).toEqual([
      ['req-1', 'allow'],
      ['req-2', 'allow'],
      ['req-3', 'deny'],
    ])
  })
})

describe('the assertive announcement', () => {
  it('a second identical ask is announced again, as a new node; a re-sent snapshot is not', async () => {
    const view = show([ask('req-1')])
    const live = screen.getByTestId('ask-announcer')
    const added: string[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) if (n instanceof HTMLElement) added.push(n.dataset['requestId'] ?? '?')
    })
    observer.observe(live, { childList: true, subtree: true, characterData: true })
    try {
      const first = live.querySelector('[data-request-id]')
      expect(first?.getAttribute('data-request-id')).toBe('req-1')
      const text = live.textContent
      expect(text).toBe(
        'Implement: Claude wants to run a command. Claude asks to run: Bash: npm --version. 9 minutes left.',
      )

      // C04a: allowed once, the vendor asks for the same command again.
      view.rerender([ask('req-2')])
      await act(() => settle())
      const second = live.querySelector('[data-request-id]')
      expect(second?.getAttribute('data-request-id')).toBe('req-2')
      expect(second).not.toBe(first)
      expect(live.textContent).toBe(text)
      expect(live.querySelectorAll('[data-request-id]')).toHaveLength(1)

      // The same asks in a newer snapshot: nothing new to say.
      view.rerender([ask('req-2')])
      await act(() => settle())
      expect(live.querySelector('[data-request-id]')).toBe(second)
      for (const r of observer.takeRecords())
        for (const n of r.addedNodes) if (n instanceof HTMLElement) added.push(n.dataset['requestId'] ?? '?')
      expect(added).toEqual(['req-2'])
    } finally {
      observer.disconnect()
    }
  })
})
