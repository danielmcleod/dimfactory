// What a palette choice or a deep link does once its page shows (navigation and the Ctrl/Cmd+K
// palette; UI standards: nothing scrolls on its own). The target is focused once it is there and
// ready; it is brought under the page's sticky header only when it is out of view, and only within REVEAL_MS of the
// choice; the follow-up gives up on the user's next key, press or wheel, or after FOLLOW_UP_MS. A Settings deep link
// finds its row by the field id (or the nearest pointer above it), else by the index entry's control name or label,
// waits while the control is disabled for its value, and focuses a later-version control's hint.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelFollowUp,
  focusSettingsField,
  FOLLOW_UP_MS,
  followUp,
  locateSettingsField,
  REVEAL_MS,
  revealOnce,
} from '@renderer/components/palette/followUp.ts'
import { SettingsFieldFocus } from '@renderer/components/palette/SettingsFieldFocus.tsx'
import { findSettingsField } from '@renderer/pages/settings/index.ts'
import { LaterSelect, SettingRow } from '@renderer/pages/settings/kit.tsx'

const rect = (top: number, bottom: number): DOMRect =>
  ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top }) as DOMRect

let main: HTMLElement
let scrollTo: ReturnType<typeof vi.fn>

/** A page scroller 600 px tall with a 100 px sticky header (its scroll padding), scrolled 50 px. */
function page(html: string): void {
  document.body.innerHTML = `<main data-testid="main" style="scroll-padding-top: 100px"><div data-testid="settings-content">${html}</div></main>`
  main = document.querySelector('main') as HTMLElement
  main.getBoundingClientRect = () => rect(0, 600)
  main.scrollTop = 50
  scrollTo = vi.fn()
  main.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
}

function at(el: Element | null, top: number, bottom: number): void {
  if (el === null) throw new Error('no element')
  el.getBoundingClientRect = () => rect(top, bottom)
}

/** Let MutationObserver callbacks (microtasks) and due timers run. */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0))
})

afterEach(() => {
  cancelFollowUp()
  document.body.innerHTML = ''
  vi.useRealTimers()
  window.location.hash = ''
})

describe('revealOnce', () => {
  it('leaves the page alone when the target is in the reading area under the header', () => {
    page('<div id="t"></div>')
    const t = document.getElementById('t') as HTMLElement
    at(t, 150, 190)
    revealOnce(t)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('brings a target under the sticky header (with a gap) when it is below the view or hidden by the header', () => {
    page('<div id="t"></div>')
    const t = document.getElementById('t') as HTMLElement
    at(t, 900, 940)
    revealOnce(t)
    // offset = 900 − 0 + 50 (scrolled) − (100 header + 8 gap)
    expect(scrollTo).toHaveBeenCalledWith({ top: 842 })
    at(t, 60, 90)
    revealOnce(t)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2 })
  })
})

describe('followUp', () => {
  it('focuses a target that is there at once, without the browser scrolling for the focus', () => {
    page('<button id="t">Go</button>')
    const t = document.getElementById('t') as HTMLElement
    at(t, 150, 180)
    const focus = vi.spyOn(t, 'focus')
    followUp(() => ({ focus: t }))
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(t)
  })

  it('waits for a target that shows later, and reveals it once', async () => {
    page('')
    followUp(() => {
      const el = document.getElementById('late')
      return el === null ? null : { focus: el }
    })
    await flush(200)
    const late = document.createElement('button')
    late.id = 'late'
    late.getBoundingClientRect = () => rect(1000, 1030)
    document.querySelector('[data-testid="settings-content"]')?.append(late)
    await flush()
    expect(document.activeElement).toBe(late)
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('focuses a target that shows after REVEAL_MS where it is, moving nothing', async () => {
    page('')
    followUp(() => {
      const el = document.getElementById('late')
      return el === null ? null : { focus: el }
    })
    await flush(REVEAL_MS + 50)
    const late = document.createElement('button')
    late.id = 'late'
    late.getBoundingClientRect = () => rect(1000, 1030)
    document.querySelector('[data-testid="settings-content"]')?.append(late)
    await flush()
    expect(document.activeElement).toBe(late)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("gives up on the user's next key, press or wheel", async () => {
    for (const type of ['keydown', 'pointerdown', 'wheel']) {
      page('')
      followUp(() => {
        const el = document.getElementById('late')
        return el === null ? null : { focus: el }
      })
      window.dispatchEvent(new Event(type))
      const late = document.createElement('button')
      late.id = 'late'
      document.querySelector('[data-testid="settings-content"]')?.append(late)
      await flush()
      expect(document.activeElement, type).not.toBe(late)
    }
  })

  it('gives up after FOLLOW_UP_MS, and a new follow-up replaces the one waiting', async () => {
    page('')
    const first = vi.fn(() => null)
    followUp(first)
    await flush(FOLLOW_UP_MS + 1)
    const calls = first.mock.calls.length
    document.querySelector('[data-testid="settings-content"]')?.append(document.createElement('p'))
    await flush()
    expect(first.mock.calls.length).toBe(calls)

    const a = vi.fn(() => null)
    followUp(a)
    const b = vi.fn(() => null)
    followUp(b)
    const aCalls = a.mock.calls.length
    document.querySelector('[data-testid="settings-content"]')?.append(document.createElement('p'))
    await flush()
    expect(a.mock.calls.length).toBe(aCalls)
    expect(b.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('Settings rows', () => {
  it('finds the row marked with the field id and focuses its first enabled control', () => {
    render(
      <main data-testid="main">
        <div data-testid="settings-content">
          <SettingRow label="Play a sound" field="/notifications/sound">
            <button type="button" role="switch" aria-checked="false" aria-label="Play a sound">
              Sound
            </button>
          </SettingRow>
        </div>
      </main>,
    )
    focusSettingsField('notifications', '/notifications/sound')
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Play a sound' }))
  })

  it('waits while the control is disabled for its value, then focuses it', async () => {
    document.body.innerHTML = `<div data-testid="settings-content">
      <div data-setting-field="/selfHeal/enabled"><span>Diagnose</span><button id="sw" disabled>x</button></div>
    </div>`
    focusSettingsField('self-heal', '/selfHeal/enabled')
    const sw = document.getElementById('sw') as HTMLButtonElement
    expect(document.activeElement).not.toBe(sw)
    sw.disabled = false
    await flush()
    expect(document.activeElement).toBe(sw)
  })

  it('lands a deeper pointer on the nearest marked row above it', () => {
    document.body.innerHTML = `<div data-testid="settings-content">
      <section data-setting-field="/passes"><h3>Passes</h3><button id="edit">Edit passes</button></section>
    </div>`
    focusSettingsField('profiles', '/passes/implement/model')
    expect(document.activeElement?.id).toBe('edit')
  })

  it("finds an unmarked row by its control's name, and a later-version control by its focusable hint", () => {
    render(
      <div data-testid="settings-content">
        <SettingRow label="Check prices every">
          <LaterSelect label="Refresh interval" placeholder="14 days" />
        </SettingRow>
      </div>,
    )
    focusSettingsField('catalog', '/catalog/refresh/intervalDays')
    const hint = document.activeElement as HTMLElement
    expect(hint.getAttribute('data-disabled-hint')).toBe('')
    expect(hint.textContent).toContain('Refresh interval')
  })

  it('finds an unmarked row by its label (a fieldset legend picks the chosen radio)', () => {
    document.body.innerHTML = `<div data-testid="settings-content">
      <fieldset><legend>Theme</legend>
        <label><input type="radio" name="t" value="system">System</label>
        <label><input id="dark" type="radio" name="t" value="dark" checked>Dark</label>
      </fieldset>
    </div>`
    focusSettingsField('appearance', '/ui/theme')
    expect(document.activeElement?.id).toBe('dark')
  })

  it('does nothing for a field neither marked nor in the index', async () => {
    document.body.innerHTML = '<div data-testid="settings-content"><button id="b">B</button></div>'
    expect(locateSettingsField('/nothing', findSettingsField('general', '/nothing'))).toBeNull()
    focusSettingsField('general', '/nothing')
    await flush(FOLLOW_UP_MS + 1)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('SettingsFieldFocus', () => {
  it('focuses the field a Settings link names, and leaves vendor card fields to the card', async () => {
    window.location.hash = '#/settings/notifications?field=%2Fnotifications%2Fsound'
    const { unmount } = render(
      <>
        <div data-testid="settings-content">
          <SettingRow label="Play a sound" field="/notifications/sound">
            <button type="button" id="sound">
              Sound
            </button>
          </SettingRow>
          <div data-setting-field="path">
            <input id="path" aria-label="Claude executable path" />
          </div>
        </div>
        <SettingsFieldFocus />
      </>,
    )
    expect(document.activeElement?.id).toBe('sound')
    unmount()
    document.body.innerHTML =
      '<div data-testid="settings-content"><div data-setting-field="path"><input id="path"></div></div>'
    window.location.hash = '#/settings/vendors/claude?field=path'
    render(<SettingsFieldFocus />)
    await flush()
    expect(document.activeElement?.id).not.toBe('path')
  })
})
