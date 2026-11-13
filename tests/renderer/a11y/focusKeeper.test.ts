// The a11y audit, the keyboard focus through a busy moment (src/renderer/src/lib/focusKeeper.ts): a control the app
// disables while it works (a Button's `loading`, a Settings field while its write is saved) lost the keyboard focus to
// the page, and Tab started again from the top. It now gets the focus back once it is enabled again, without
// scrolling, but only for the keyboard (after a click the focus stays where the browser put it: giving it back would
// open the control's tooltip under the pointer, as retention.spec.ts's Pin showed), only while the focus is still on the
// page, nothing else was focused or clicked, the control is still there and within KEEP_MS. a11y.spec.ts checks a
// Settings select in the running app (Chromium drops the focus itself; here the drop is done by hand, as happy-dom
// keeps it).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEEP_MS, installFocusKeeper } from '@renderer/lib/focusKeeper.ts'

/** focus() as the prototype holds it (read as a property: compared, never called). */
const focusNow = (): unknown => Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')?.value
const ORIGINAL_FOCUS = focusNow()
let remove: () => void = () => undefined
let clock = 0
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function button(label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  document.body.append(b)
  return b
}

/** A key press (Tab, Enter): the keyboard is in use. */
function key(name = 'Tab'): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
}

/** A click: the pointer is in use. */
function pointer(): void {
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

/**
 * What Chromium does to a focused control that turns disabled: the focus falls to the page (happy-dom keeps the focus
 * on a disabled control and will not blur one, so the drop comes first here).
 */
async function disable(b: HTMLElement): Promise<void> {
  if (document.activeElement === b) b.blur()
  b.setAttribute('disabled', '')
  await flush()
}

async function enable(b: HTMLElement): Promise<void> {
  b.removeAttribute('disabled')
  await flush()
}

beforeEach(() => {
  document.body.innerHTML = ''
  clock = 1_000
  remove = installFocusKeeper({ now: () => clock })
})

afterEach(() => {
  remove()
  document.body.innerHTML = ''
})

describe('installFocusKeeper', () => {
  it('gives the focus back to a control the keyboard was on that turned disabled, once it is enabled', async () => {
    const save = button('Save')
    key()
    save.focus()
    key('Enter')
    await disable(save)
    expect(document.activeElement).toBe(document.body)
    await enable(save)
    expect(document.activeElement).toBe(save)
  })

  it('also when the focus was being given to it while it was disabled (a Select closing onto its trigger)', async () => {
    const trigger = button('Closing the window')
    const option = button('Keep running in the tray')
    key()
    option.focus()
    key('Enter')
    trigger.setAttribute('disabled', '')
    await flush()
    // Radix gives the trigger the focus back as the list closes; a disabled trigger does not take it.
    trigger.focus()
    if (document.activeElement === trigger) trigger.blur()
    option.remove()
    expect(document.activeElement).toBe(document.body)
    await enable(trigger)
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves the focus where a click put it (the control then shows no tooltip nobody asked for)', async () => {
    const pin = button('Pin')
    pointer()
    pin.focus()
    await disable(pin)
    await enable(pin)
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves the focus alone when the user went elsewhere meanwhile', async () => {
    const save = button('Save')
    const other = button('Other')
    key()
    save.focus()
    await disable(save)
    other.focus()
    await enable(save)
    expect(document.activeElement).toBe(other)

    // A click anywhere is the user's move, even where nothing takes the focus.
    key()
    save.focus()
    await disable(save)
    pointer()
    await enable(save)
    expect(document.activeElement).toBe(document.body)
  })

  it('never jumps back later, or to a control that is gone, or to one that never had the focus', async () => {
    key()
    const save = button('Save')
    save.focus()
    await disable(save)
    clock += KEEP_MS + 1
    await enable(save)
    expect(document.activeElement).toBe(document.body)

    const gone = button('Gone')
    gone.focus()
    await disable(gone)
    gone.remove()
    await enable(gone)
    expect(document.activeElement).toBe(document.body)

    const never = button('Never focused')
    await disable(never)
    await enable(never)
    expect(document.activeElement).toBe(document.body)
  })

  it('puts focus() back as it was once removed', () => {
    expect(focusNow()).not.toBe(ORIGINAL_FOCUS)
    remove()
    remove = () => undefined
    expect(focusNow()).toBe(ORIGINAL_FOCUS)
  })
})
