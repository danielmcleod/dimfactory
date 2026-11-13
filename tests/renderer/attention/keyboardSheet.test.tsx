// The `?` keyboard sheet (the keys table, accessibility; keyboard.spec.ts): `?` opens the key
// table with this platform's modifiers, the sheet takes focus and gives it back on Escape or `?`, it is not a modal,
// and `?` typed into a field is just a character.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_TABLE, KeyboardSheet } from '@renderer/components/attention/KeyboardSheet.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { KEYS, resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'

beforeEach(() => setMacForTests(false))

afterEach(() => {
  resetShortcuts()
  setMacForTests(null)
})

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

function mount(): void {
  render(
    <TooltipProvider>
      <button type="button">Somewhere</button>
      <input aria-label="Task" />
      <KeyboardSheet />
    </TooltipProvider>,
  )
}

describe('keyboard sheet', () => {
  it('lists every row of the key table', () => {
    expect(KEY_TABLE.flatMap((r) => r.combos)).toEqual([
      KEYS.runOrApprove,
      KEYS.palette,
      KEYS.allowOnce,
      KEYS.allowForRun,
      KEYS.deny,
      KEYS.dashboard,
      KEYS.runs,
      KEYS.settings,
      KEYS.stop,
      KEYS.openDiff,
      KEYS.diffNext,
      KEYS.diffPrev,
      KEYS.diffReviewed,
      KEYS.diffLayout,
      KEYS.keyboardSheet,
    ])
  })

  it('opens on ?, takes focus, shows the keys for this platform, and closes on Escape giving focus back', () => {
    mount()
    const before = screen.getByRole('button', { name: 'Somewhere' })
    before.focus()
    press(before, '?', { shiftKey: true })
    const sheet = screen.getByTestId('keyboard-sheet')
    expect(sheet.getAttribute('aria-modal')).toBe('false')
    expect(within(sheet).getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(document.activeElement).toBe(sheet)
    const text = sheet.textContent ?? ''
    for (const k of ['Ctrl+Enter', 'Ctrl+K', 'A', '⇧A', 'D', 'Ctrl+1', 'Ctrl+.', 'Ctrl+Shift+D', 'J', '?'])
      expect(text).toContain(k)
    expect(text).toContain('Answer the focused ask')
    // The palette is built, so its row no longer says it arrives later.
    expect(text).toContain('Command palette')
    expect(text).not.toContain('in a later version')
    press(sheet, 'Escape')
    expect(screen.queryByTestId('keyboard-sheet')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it('toggles with ? and closes from its button', () => {
    mount()
    press(document.body, '?')
    expect(screen.getByTestId('keyboard-sheet')).toBeTruthy()
    press(screen.getByTestId('keyboard-sheet'), '?')
    expect(screen.queryByTestId('keyboard-sheet')).toBeNull()
    press(document.body, '?')
    fireEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }))
    expect(screen.queryByTestId('keyboard-sheet')).toBeNull()
  })

  it('ignores ? typed into a field', () => {
    mount()
    const input = screen.getByRole('textbox', { name: 'Task' })
    input.focus()
    press(input, '?', { shiftKey: true })
    expect(screen.queryByTestId('keyboard-sheet')).toBeNull()
  })
})
