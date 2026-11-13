// Settings → Appearance (theme, 6 accents, font size; theming): the
// six accents switch data-accent on <html> through ui.setTheme, each swatch previews the accent in the theme now
// showing, the stream font size (12/13/14) applies at once and is written with config.patch (put back when core
// refuses), the size follows the user's dimfactory.json at start and after each config change (lib/streamFont.ts), and
// the preview shows the choices together. Nothing is read when the section opens.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENTS } from '@shared/config-schema.ts'
import type { ConfigReadResult, ThemeState } from '@shared/ipc.ts'
import { installStreamFontSize, syncStreamFontSize } from '@renderer/lib/streamFont.ts'
import {
  currentStreamFontSize,
  DEFAULT_STREAM_FONT_SIZE,
  resetStreamFontSizeForTests,
  STREAM_FONT_SIZES,
  streamFontSizeOf,
} from '@renderer/lib/theme.ts'
import { FONT_SIZE_OPTIONS, STREAM_FONT_POINTER } from '@renderer/pages/settings/AppearanceSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { bumpConfigEpoch, setThemeState } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

let mock: MockDimFactory
let theme: ThemeState

const html = (): HTMLElement => document.documentElement
const streamVar = (): string => html().style.getPropertyValue('--stream-font-size')

function userFile(value: unknown): ConfigReadResult {
  return {
    path: 'C:\\home\\dimfactory.json',
    exists: true,
    text: JSON.stringify(value),
    value,
    issues: [],
    version: 1,
    backups: [],
  }
}

beforeEach(() => {
  theme = { theme: 'system', resolved: 'light', accent: 'slate' }
  mock = setUp({
    handlers: {
      'ui.setTheme': (req) => {
        const next = req.theme ?? theme.theme
        theme = {
          theme: next,
          resolved: next === 'dark' ? 'dark' : next === 'light' ? 'light' : theme.resolved,
          accent: req.accent ?? theme.accent,
        }
        return theme
      },
      'config.patch': () => ({ path: 'C:\\home\\dimfactory.json', changed: true, diff: '', backupId: 'b-1' }),
    },
  })
  setThemeState(theme)
  resetStreamFontSizeForTests()
})

afterEach(() => {
  tearDown(mock)
  html().classList.remove('dark')
  delete html().dataset['accent']
  html().style.colorScheme = ''
  resetStreamFontSizeForTests()
})

function mount(): HTMLElement {
  render(
    <Providers>
      <SettingsPage section="appearance" />
    </Providers>,
  )
  return screen.getByTestId('settings-content')
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('Settings → Appearance: accents', () => {
  it('offers all six accents, and each one applies data-accent to the window at once', async () => {
    mount()
    expect(mock.calls.filter((c) => c.cmd !== 'subscribe')).toEqual([])
    expect(ACCENTS).toHaveLength(6)
    // Slate is the one in force: it is chosen last, after each of the others.
    const order = [...ACCENTS.filter((a) => a !== 'slate'), 'slate' as const]
    for (const accent of order) {
      const tile = screen.getByTestId(`accent-${accent}`)
      await click(within(tile).getByRole('radio'))
      expect(html().dataset['accent']).toBe(accent)
      expect(within(tile).getByRole<HTMLInputElement>('radio').checked).toBe(true)
    }
    expect(mock.callsOf('ui.setTheme')).toEqual(order.map((accent) => ({ accent })))
  })

  it('draws each swatch in the theme now showing: a dark window previews the dark accents', async () => {
    mount()
    for (const a of ACCENTS) {
      const sw = screen.getByTestId(`accent-swatch-${a}`)
      expect(sw.dataset['accent']).toBe(a)
      expect(sw.classList.contains('dark')).toBe(false)
    }
    await click(screen.getByLabelText('Dark'))
    expect(html().classList.contains('dark')).toBe(true)
    for (const a of ACCENTS)
      expect(screen.getByTestId(`accent-swatch-${a}`).classList.contains('dark')).toBe(true)
  })

  it('a refused accent keeps the one in force and says why', async () => {
    mock.on('ui.setTheme', () => {
      throw mockError('INTERNAL', 'The theme could not be saved.')
    })
    mount()
    await click(within(screen.getByTestId('accent-violet')).getByRole('radio'))
    expect(html().dataset['accent']).toBeUndefined()
    expect(within(screen.getByTestId('accent-slate')).getByRole<HTMLInputElement>('radio').checked).toBe(true)
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe('The theme could not be saved.')
  })
})

describe('Settings → Appearance: stream font size', () => {
  it('offers exactly the sizes of the config schema (12, 13, 14), the applied one checked', () => {
    expect(FONT_SIZE_OPTIONS.map((o) => o.value)).toEqual([12, 13, 14])
    expect([...STREAM_FONT_SIZES]).toEqual([12, 13, 14])
    mount()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '13 px' }).checked).toBe(true)
  })

  it('applies a size at once and writes /ui/streamFontSize to the user file', async () => {
    mount()
    await click(screen.getByRole('radio', { name: '14 px' }))
    expect(streamVar()).toBe('14px')
    expect(currentStreamFontSize()).toBe(14)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '14 px' }).checked).toBe(true)
    expect(mock.callsOf('config.patch')).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: STREAM_FONT_POINTER, value: 14 }] },
    ])
    // The preview's stream text uses the same variable.
    expect(
      within(screen.getByTestId('appearance-preview')).getByText(/Reading src/).parentElement?.className,
    ).toContain('stream-text')
  })

  it('puts the old size back when core refuses the write, and says why', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'dimfactory.json:1:2 is not valid JSON')
    })
    mount()
    await click(screen.getByRole('radio', { name: '12 px' }))
    expect(currentStreamFontSize()).toBe(13)
    expect(streamVar()).toBe('13px')
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '13 px' }).checked).toBe(true)
    expect(useStore.getState().toasts.items.at(-1)?.message).toBe(
      'The stream font size was not saved: dimfactory.json:1:2 is not valid JSON',
    )
  })

  it('reads ui.streamFontSize from a parsed user file, the default otherwise', () => {
    expect(streamFontSizeOf({ ui: { streamFontSize: 12 } })).toBe(12)
    expect(streamFontSizeOf({ ui: { streamFontSize: 14 } })).toBe(14)
    expect(streamFontSizeOf({ ui: { streamFontSize: 15 } })).toBe(DEFAULT_STREAM_FONT_SIZE)
    expect(streamFontSizeOf({ ui: {} })).toBe(DEFAULT_STREAM_FONT_SIZE)
    expect(streamFontSizeOf(null)).toBe(DEFAULT_STREAM_FONT_SIZE)
    expect(streamFontSizeOf('x')).toBe(DEFAULT_STREAM_FONT_SIZE)
  })

  it('follows the user file at start and after every config change', async () => {
    let size = 12
    mock.on('config.read', (req) => {
      expect(req).toEqual({ scope: 'user' })
      return userFile({ ui: { streamFontSize: size } })
    })
    const stop = installStreamFontSize()
    await settle()
    expect(streamVar()).toBe('12px')
    expect(currentStreamFontSize()).toBe(12)
    size = 14
    act(() => bumpConfigEpoch())
    await settle()
    expect(streamVar()).toBe('14px')
    stop()
    size = 13
    act(() => bumpConfigEpoch())
    await settle()
    expect(streamVar()).toBe('14px')
    expect(mock.callsOf('config.read')).toHaveLength(2)
  })

  it('leaves the size alone when the user file cannot be read', async () => {
    mock.on('config.read', () => {
      throw mockError('STORAGE', 'locked')
    })
    await act(async () => {
      await syncStreamFontSize()
    })
    expect(currentStreamFontSize()).toBe(DEFAULT_STREAM_FONT_SIZE)
    expect(streamVar()).toBe('')
  })
})

describe('Settings → Appearance: preview', () => {
  it('shows buttons, a link, status badges and stream and diff lines, hidden from screen readers', () => {
    mount()
    const preview = screen.getByTestId('appearance-preview')
    const pic = preview.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(pic).not.toBeNull()
    for (const text of ['Approve', 'Cancel', 'View changes', 'Running', 'Done', 'Failed', 'AUTO']) {
      expect(within(pic).getByText(text)).toBeTruthy()
    }
    expect(pic.querySelector('.text-diff-add')).not.toBeNull()
    expect(pic.querySelector('.text-diff-del')).not.toBeNull()
    expect(pic.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0)
  })
})
