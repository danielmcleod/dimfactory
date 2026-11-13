// Theme application (main owns nativeTheme; preload passes initialTheme, applied before
// createRoot so the first paint matches the window's backgroundColor). Pure DOM: the store keeps the ThemeState.
// The stream font size (`ui.streamFontSize`: 12, 13 or 14) is the `--stream-font-size` variable on <html>; the
// size applied now is kept here too, so Settings → Appearance shows it at once (lib/streamFont.ts reads the config).
import { useSyncExternalStore } from 'react'
import type { Accent, Theme } from '@shared/config-schema.ts'
import type { ResolvedTheme, ThemeState } from '@shared/ipc.ts'

// Mirrors ACCENTS/THEMES in config-schema.ts; importing the values would pull zod into the renderer bundle.
const ACCENT_VALUES: readonly Accent[] = ['slate', 'blue', 'green', 'amber', 'rose', 'violet']
const THEME_VALUES: readonly Theme[] = ['light', 'dark', 'system']

export const DEFAULT_ACCENT: Accent = 'slate'

/** The stream sizes config-schema.ts allows (`ui.streamFontSize`); a test keeps them equal. */
export const STREAM_FONT_SIZES = [12, 13, 14] as const
export type StreamFontSize = (typeof STREAM_FONT_SIZES)[number]
export const DEFAULT_STREAM_FONT_SIZE: StreamFontSize = 13

function isThemeState(v: unknown): v is ThemeState {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    (t['resolved'] === 'light' || t['resolved'] === 'dark') &&
    THEME_VALUES.includes(t['theme'] as Theme) &&
    ACCENT_VALUES.includes(t['accent'] as Accent)
  )
}

function systemResolved(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** main's ThemeState from the preload, or the OS preference when the preload has none (scaffold, tests). */
export function readInitialTheme(): ThemeState {
  const api = (window as unknown as { dimFactory?: { initialTheme?: unknown } }).dimFactory
  const t = api?.initialTheme
  if (isThemeState(t)) return { theme: t.theme, resolved: t.resolved, accent: t.accent }
  return { theme: 'system', resolved: systemResolved(), accent: DEFAULT_ACCENT }
}

/** `.dark` + `data-accent` + color-scheme on <html>; tokens.css does the rest. */
export function applyTheme(t: ThemeState, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', t.resolved === 'dark')
  root.dataset['accent'] = t.accent
  root.style.colorScheme = t.resolved
}

// ---- stream font size ------------------------------------------------------------------------------------------

export function isStreamFontSize(v: unknown): v is StreamFontSize {
  return (STREAM_FONT_SIZES as readonly unknown[]).includes(v)
}

/** `ui.streamFontSize` of a parsed user dimfactory.json (config.read's `value`), else the default. */
export function streamFontSizeOf(userConfig: unknown): StreamFontSize {
  if (typeof userConfig !== 'object' || userConfig === null) return DEFAULT_STREAM_FONT_SIZE
  const ui = (userConfig as Record<string, unknown>)['ui']
  if (typeof ui !== 'object' || ui === null) return DEFAULT_STREAM_FONT_SIZE
  const px = (ui as Record<string, unknown>)['streamFontSize']
  return isStreamFontSize(px) ? px : DEFAULT_STREAM_FONT_SIZE
}

let streamFontSize: StreamFontSize = DEFAULT_STREAM_FONT_SIZE
const streamFontListeners = new Set<() => void>()

/** Stream pane font size in px (config ui.streamFontSize: 12, 13 or 14). */
export function setStreamFontSize(px: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--stream-font-size', `${px}px`)
  if (!isStreamFontSize(px) || px === streamFontSize) return
  streamFontSize = px
  for (const l of [...streamFontListeners]) l()
}

/** The stream font size applied now. */
export function currentStreamFontSize(): StreamFontSize {
  return streamFontSize
}

function subscribeStreamFont(cb: () => void): () => void {
  streamFontListeners.add(cb)
  return () => streamFontListeners.delete(cb)
}

/** The stream font size applied now, re-rendering when it changes. */
export function useStreamFontSize(): StreamFontSize {
  return useSyncExternalStore(subscribeStreamFont, currentStreamFontSize)
}

/** Tests: back to the default size, with nothing applied to <html>. */
export function resetStreamFontSizeForTests(root: HTMLElement = document.documentElement): void {
  root.style.removeProperty('--stream-font-size')
  streamFontSize = DEFAULT_STREAM_FONT_SIZE
  for (const l of [...streamFontListeners]) l()
}
