// lib/keys.ts: modifier combos, scoped single keys, inputs, precedence and display text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ariaKeyShortcuts,
  formatCombo,
  registerShortcut,
  registeredShortcuts,
  resetShortcuts,
  setMacForTests,
} from '@renderer/lib/keys.ts'

function press(target: Element | Window, key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  target.dispatchEvent(e)
  return e
}

let host: HTMLDivElement

beforeEach(() => {
  setMacForTests(false)
  host = document.createElement('div')
  host.innerHTML = `
    <div data-key-scope="ask"><button id="in-scope">x</button><input id="field" /></div>
    <button id="outside">y</button>
    <textarea id="editor"></textarea>`
  document.body.appendChild(host)
})

afterEach(() => {
  resetShortcuts()
  setMacForTests(null)
  host.remove()
})

const el = (id: string): HTMLElement => document.getElementById(id)!

describe('shortcuts', () => {
  it('fires mod combos anywhere, inputs included, and prevents the default', () => {
    const run = vi.fn()
    registerShortcut('mod+enter', run)
    const e = press(el('editor'), 'Enter', { ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    press(el('outside'), 'Enter', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses ⌘ on macOS', () => {
    setMacForTests(true)
    const run = vi.fn()
    registerShortcut('mod+.', run)
    press(el('outside'), '.', { ctrlKey: true })
    press(el('outside'), '.', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('requires a scope for single letters and fires them only inside it', () => {
    expect(() => registerShortcut('a', () => {})).toThrow(/scope/)
    const allow = vi.fn()
    const allowSession = vi.fn()
    registerShortcut('a', allow, { scope: 'ask' })
    registerShortcut('shift+a', allowSession, { scope: 'ask' })
    press(el('outside'), 'a')
    expect(allow).not.toHaveBeenCalled()
    press(el('in-scope'), 'a')
    press(el('in-scope'), 'A', { shiftKey: true })
    expect(allow).toHaveBeenCalledTimes(1)
    expect(allowSession).toHaveBeenCalledTimes(1)
  })

  it('ignores single keys while typing, even inside the scope', () => {
    const deny = vi.fn()
    registerShortcut('d', deny, { scope: 'ask' })
    press(el('field'), 'd')
    expect(deny).not.toHaveBeenCalled()
  })

  it('can keep a mod combo out of inputs', () => {
    const k = vi.fn()
    expect(() => registerShortcut('mod+k', k)).toThrow(/reserved/)
    registerShortcut('mod+k', k, { allowInInputs: false, reserved: true, description: 'Palette' })
    expect(registeredShortcuts()).toEqual([{ combo: 'mod+k', description: 'Palette' }])
    press(el('editor'), 'k', { ctrlKey: true })
    press(el('outside'), 'k', { ctrlKey: true })
    expect(k).toHaveBeenCalledTimes(1)
  })

  it('prefers a scoped registration, then the newest one, and unregisters', () => {
    const global = vi.fn()
    const scoped = vi.fn()
    const newer = vi.fn()
    registerShortcut('mod+shift+d', global)
    registerShortcut('mod+shift+d', scoped, { scope: 'ask' })
    press(el('in-scope'), 'D', { ctrlKey: true, shiftKey: true })
    expect(scoped).toHaveBeenCalledTimes(1)
    press(el('outside'), 'D', { ctrlKey: true, shiftKey: true })
    expect(global).toHaveBeenCalledTimes(1)
    const off = registerShortcut('mod+shift+d', newer)
    press(el('outside'), 'D', { ctrlKey: true, shiftKey: true })
    expect(newer).toHaveBeenCalledTimes(1)
    off()
    press(el('outside'), 'D', { ctrlKey: true, shiftKey: true })
    expect(global).toHaveBeenCalledTimes(2)
  })

  it('matches digits by physical key and shift exactly for letters', () => {
    const one = vi.fn()
    const d = vi.fn()
    registerShortcut('mod+1', one)
    registerShortcut('mod+shift+d', d)
    press(el('outside'), '&', { ctrlKey: true, code: 'Digit1' })
    press(el('outside'), 'd', { ctrlKey: true })
    expect(one).toHaveBeenCalledTimes(1)
    expect(d).not.toHaveBeenCalled()
  })
})

describe('display', () => {
  it('formats combos per platform', () => {
    expect(formatCombo('mod+enter')).toBe('Ctrl+Enter')
    expect(formatCombo('mod+shift+d')).toBe('Ctrl+Shift+D')
    expect(formatCombo('shift+a')).toBe('⇧A')
    expect(ariaKeyShortcuts('mod+enter')).toBe('Control+Enter')
    setMacForTests(true)
    expect(formatCombo('mod+enter')).toBe('⌘↵')
    expect(formatCombo('mod+shift+d')).toBe('⌘⇧D')
    expect(ariaKeyShortcuts('mod+.')).toBe('Meta+Period')
  })
})
