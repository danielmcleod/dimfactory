// Theme source (src/main/theme.ts; theming): ui settings from the user file, ui.setTheme persisting
// before applying, OS appearance changes, and pushes only on real changes.
import { describe, expect, it, vi } from 'vitest'
import { WINDOW_BACKGROUND } from '../../../src/main/constants.ts'
import {
  DEFAULT_UI,
  ThemeController,
  backgroundFor,
  themePatchOps,
  themeStateOf,
  uiSettingsOf,
} from '../../../src/main/theme.ts'
import type { NativeThemeLike } from '../../../src/main/theme.ts'
import type { Theme } from '../../../src/shared/config-schema.ts'
import type { ThemeState } from '../../../src/shared/ipc.ts'

class FakeNative implements NativeThemeLike {
  #source: Theme = 'system'
  osDark = false
  readonly #listeners: (() => void)[] = []
  sets: Theme[] = []
  get themeSource(): Theme {
    return this.#source
  }
  set themeSource(v: Theme) {
    this.#source = v
    this.sets.push(v)
    this.#emit()
  }
  get shouldUseDarkColors(): boolean {
    return this.#source === 'dark' || (this.#source === 'system' && this.osDark)
  }
  on(_event: 'updated', listener: () => void): this {
    this.#listeners.push(listener)
    return this
  }
  setOsDark(dark: boolean): void {
    this.osDark = dark
    this.#emit()
  }
  #emit(): void {
    for (const l of this.#listeners) l()
  }
}

describe('ui settings', () => {
  it('defaults to system / slate / auto', () => {
    expect(uiSettingsOf(undefined)).toEqual(DEFAULT_UI)
    expect(uiSettingsOf({})).toEqual({ theme: 'system', accent: 'slate', closeToTray: 'auto' })
  })

  it('reads the user file over the defaults', () => {
    expect(uiSettingsOf({ ui: { theme: 'dark', closeToTray: false } })).toEqual({
      theme: 'dark',
      accent: 'slate',
      closeToTray: false,
    })
  })

  it('maps the resolved theme to the window background tokens', () => {
    expect(backgroundFor('light')).toBe('#ffffff')
    expect(backgroundFor('dark')).toBe('#0c0e12')
    expect(WINDOW_BACKGROUND).toEqual({ light: '#ffffff', dark: '#0c0e12' })
    expect(themeStateOf('system', 'blue', true)).toEqual({
      theme: 'system',
      resolved: 'dark',
      accent: 'blue',
    })
  })

  it('writes one op per given field into the user file', () => {
    expect(themePatchOps({})).toEqual([])
    expect(themePatchOps({ theme: 'light', accent: 'rose' })).toEqual([
      { op: 'add', path: '/ui/theme', value: 'light' },
      { op: 'add', path: '/ui/accent', value: 'rose' },
    ])
  })
})

describe('ThemeController', () => {
  function make(initial: { theme: Theme; accent: 'slate' | 'blue' } = { theme: 'system', accent: 'slate' }) {
    const native = new FakeNative()
    const changes: ThemeState[] = []
    const persist = vi.fn(() => Promise.resolve())
    const c = new ThemeController({ native, initial, persist, onChange: (s) => changes.push(s) })
    return { native, changes, persist, c }
  }

  it('applies the configured theme source at start without pushing', () => {
    const { native, changes, c } = make({ theme: 'dark', accent: 'blue' })
    expect(native.themeSource).toBe('dark')
    expect(c.state).toEqual({ theme: 'dark', resolved: 'dark', accent: 'blue' })
    expect(changes).toEqual([])
  })

  it('ui.setTheme persists first, then applies and pushes once', async () => {
    const { native, changes, persist, c } = make()
    const s = await c.set({ theme: 'dark' })
    expect(persist).toHaveBeenCalledWith([{ op: 'add', path: '/ui/theme', value: 'dark' }])
    expect(native.themeSource).toBe('dark')
    expect(s).toEqual({ theme: 'dark', resolved: 'dark', accent: 'slate' })
    expect(changes).toEqual([s])
  })

  it('a failed write changes nothing', async () => {
    const { native, changes, c } = make()
    const failing = new ThemeController({
      native,
      initial: { theme: 'system', accent: 'slate' },
      persist: () => Promise.reject(new Error('VALIDATION')),
      onChange: (s) => changes.push(s),
    })
    await expect(failing.set({ theme: 'dark', accent: 'rose' })).rejects.toThrow('VALIDATION')
    expect(failing.state).toEqual({ theme: 'system', resolved: 'light', accent: 'slate' })
    expect(c.state.resolved).toBe('light')
    expect(changes).toEqual([])
  })

  it('an empty request writes nothing', async () => {
    const { persist, c } = make()
    expect(await c.set({})).toEqual(c.state)
    expect(persist).not.toHaveBeenCalled()
  })

  it('follows the OS appearance while on system, and only pushes real changes', () => {
    const { native, changes, c } = make()
    native.setOsDark(true)
    native.setOsDark(true)
    expect(changes).toEqual([{ theme: 'system', resolved: 'dark', accent: 'slate' }])
    c.follow({ theme: 'light', accent: 'slate' })
    native.setOsDark(false)
    expect(changes.map((s) => s.resolved)).toEqual(['dark', 'light'])
  })

  it('follow() applies an outside edit of the user file without writing', () => {
    const { persist, changes, c } = make()
    c.follow({ theme: 'system', accent: 'violet' })
    expect(persist).not.toHaveBeenCalled()
    expect(changes).toEqual([{ theme: 'system', resolved: 'light', accent: 'violet' }])
    c.follow({ theme: 'system', accent: 'violet' })
    expect(changes).toHaveLength(1)
  })
})
