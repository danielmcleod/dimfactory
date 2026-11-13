// The rules of Run & Preview's windows (main/preview.ts), Electron-free so they are unit-tested:
// - which URL a preview may show (loopback http only, the session's own),
// - where its page may navigate (only within that origin, main frame and frames alike),
// - which requests its page may make (web schemes only: never file:, never a custom scheme; a game's preview reaches
//   this computer only, unless the user allowed the internet for it),
// - which console messages and failed loads the smoke check records,
// - which permission a preview's page may have (fullscreen alone, in the visible preview window alone),
// - what F11, Escape and Ctrl+Shift+M (Phone size) do in the preview window,
// - where the pair window (two previews next to each other) puts its two pages, and what its title reads,
// - which preview windows may have the DevTools protocol attached, and the few commands sent over it (touch emulation
//   for Phone size, reduced motion and touch taps for a play-test; nothing else).
import type { PreviewNetworkMode } from '@shared/playtest.ts'
import { PHONE_VIEWPORT } from '@shared/playtest.ts'
import { LOOPBACK_HOSTS, previewOrigin, previewUrlOf } from '@shared/preview.ts'

/** The session's URL as Dim Factory opens it: loopback http only; null for anything else. */
export function openableUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null
  return previewUrlOf(url, { httpOnly: true })
}

/** A navigation of a preview page may go only to its own loopback origin (scheme, host and port). */
export function navigationAllowed(target: string, origin: string): boolean {
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return false
  }
  if (u.username !== '' || u.password !== '') return false
  return u.origin === origin || previewOrigin(target) === origin
}

/** Schemes a preview page's requests may use (its own and other sites' resources); file: and the rest are cancelled. */
const REQUEST_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'])

/** Schemes that reach another computer (what loopback-only stops when the host is not this computer). */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * A request of a preview page: `allow`, `deny` (a scheme it may never use) or `blocked` (another computer, while the
 * preview is loopback-only: a game's default, which the user can lift with "Allow internet for this preview").
 */
export function requestDecision(
  url: string,
  mode: PreviewNetworkMode = 'internet',
): 'allow' | 'deny' | 'blocked' {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'deny'
  }
  if (!REQUEST_SCHEMES.has(u.protocol)) return 'deny'
  if (mode === 'loopback' && NETWORK_SCHEMES.has(u.protocol) && !isLoopbackHost(u.hostname)) return 'blocked'
  return 'allow'
}

/** 127.0.0.1 (and the rest of 127/8), localhost and [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return LOOPBACK_HOSTS.includes(h) || /^127(?:\.\d{1,3}){3}$/.test(h) || h === '::1'
}

export function requestAllowed(url: string, mode: PreviewNetworkMode = 'internet'): boolean {
  return requestDecision(url, mode) === 'allow'
}

/** A failed request the smoke check records (an aborted one, e.g. a navigation replaced, is not a failure). */
export function failedLoadOf(d: { url: string; error?: string; statusCode?: number }): string | null {
  if (d.error !== undefined) return d.error === 'net::ERR_ABORTED' ? null : d.error
  if (d.statusCode !== undefined && d.statusCode >= 400) return String(d.statusCode)
  return null
}

/** The title a preview window shows: what it is, then the page's own title. */
export function previewTitle(pageTitle: string, url: string, phone = false): string {
  const t = pageTitle.trim()
  return `Preview${phone ? ' (phone size)' : ''}: ${t !== '' && t !== url ? t : url}`
}

/**
 * The kinds of preview partitions: the visible window, the hidden smoke check, the hidden play-test window, the hidden
 * Save as PDF window.
 */
export type PreviewPartitionKind = 'window' | 'smoke' | 'playtest' | 'pdf'

/**
 * Whether a preview page may have a permission: only `fullscreen` (a game's full screen button), and only in the
 * visible preview window. The hidden smoke check, play-test and Save as PDF windows are denied everything.
 */
export function previewPermissionAllowed(kind: PreviewPartitionKind, permission: string): boolean {
  return kind === 'window' && permission === 'fullscreen'
}

/** The parts of an Electron keyboard input the preview window's full screen keys read. */
export interface PreviewKeyInput {
  type: string
  key: string
  alt?: boolean
  control?: boolean
  meta?: boolean
  shift?: boolean
}

/** F11 (no modifier) toggles full screen; Escape leaves it. Anything else: null (the page gets the key). */
export function fullscreenKeyAction(
  input: PreviewKeyInput,
  isFullScreen: boolean,
): 'toggle' | 'leave' | null {
  if (input.type !== 'keyDown') return null
  const plain = input.alt !== true && input.control !== true && input.meta !== true && input.shift !== true
  if (input.key === 'F11' && plain) return 'toggle'
  if (input.key === 'Escape' && isFullScreen) return 'leave'
  return null
}

/** Ctrl+Shift+M (Cmd+Shift+M on a Mac) in the preview window toggles Phone size, as in a browser's device mode. */
export function phoneKeyAction(input: PreviewKeyInput): 'toggle' | null {
  if (input.type !== 'keyDown' || input.alt === true || input.shift !== true) return null
  const mod = (input.control === true) !== (input.meta === true)
  return mod && input.key.toLowerCase() === 'm' ? 'toggle' : null
}

/** The window size Phone size gives the page (its content area, CSS pixels). */
export const PHONE_SIZE = PHONE_VIEWPORT
/** The preview window's own size (content area) when Phone size is off. */
export const DESKTOP_SIZE = { width: 1100, height: 780 } as const

/**
 * The pair window's own size (content area): room for two pages next to each other on an ordinary screen. It is fixed,
 * and the user sizes the window from there.
 */
export const PAIR_SIZE = { width: 1600, height: DESKTOP_SIZE.height } as const
/** The strip of the pair window left empty between its two pages. */
export const PAIR_GAP = 1
/** The pair window's own colour, seen only in that strip: a line that shows between light pages and dark ones. */
export const PAIR_GAP_COLOR = '#808080'

/** Where a page sits in the pair window's content area. */
export interface PairRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The pair window's two pages for a content area of this size: the left half and the right half, PAIR_GAP apart. When
 * the room beside the gap does not halve evenly the right page takes the odd pixel, so the two never overlap and
 * nothing but the gap is left over. A content area too small for the gap gives empty pages, never a negative size.
 */
export function pairBounds(width: number, height: number): [PairRect, PairRect] {
  const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  const w = whole(width)
  const h = whole(height)
  const left = Math.max(0, Math.floor((w - PAIR_GAP) / 2))
  const x = Math.min(w, left + PAIR_GAP)
  return [
    { x: 0, y: 0, width: left, height: h },
    { x, y: 0, width: w - x, height: h },
  ]
}

/** The pair window's title: what it is, then the left page's label and the right page's. */
export function pairTitle(labels: readonly [string, string]): string {
  return previewTitle(`${labels[0].trim()} | ${labels[1].trim()}`, '')
}

/**
 * Which preview windows may have the DevTools protocol attached: the visible game preview window (Phone size) and the
 * hidden smoke and play-test windows (reduced motion, phone scenarios). Never the Save as PDF window, and never any
 * window that is not a preview's (main checks that the webContents is one it made).
 */
export function debuggerAllowed(kind: PreviewPartitionKind): boolean {
  return kind === 'window' || kind === 'smoke' || kind === 'playtest'
}

/** The only DevTools protocol commands Dim Factory sends to a preview page. */
export const PREVIEW_DEBUGGER_METHODS: ReadonlySet<string> = new Set([
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setEmitTouchEventsForMouse',
  'Emulation.setEmulatedMedia',
  'Input.dispatchTouchEvent',
])

export interface DebuggerCommand {
  method: string
  params: Record<string, unknown>
}

/** Touch emulation on or off (Phone size): the page sees a touch screen, and a mouse click arrives as a tap. */
export function touchEmulationCommands(on: boolean): DebuggerCommand[] {
  return [
    {
      method: 'Emulation.setTouchEmulationEnabled',
      params: on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    },
    {
      method: 'Emulation.setEmitTouchEventsForMouse',
      params: on ? { enabled: true, configuration: 'mobile' } : { enabled: false },
    },
  ]
}

/** prefers-reduced-motion: reduce on, or the page's own setting again. */
export function reducedMotionCommand(on: boolean): DebuggerCommand {
  return {
    method: 'Emulation.setEmulatedMedia',
    params: { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : '' }] },
  }
}

/** A finger down and up at a point of the page (CSS pixels): a real touch tap. */
export function touchTapCommands(x: number, y: number): DebuggerCommand[] {
  const point = { x: Math.round(x), y: Math.round(y), radiusX: 4, radiusY: 4, force: 1, id: 1 }
  return [
    { method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [point] } },
    { method: 'Input.dispatchTouchEvent', params: { type: 'touchEnd', touchPoints: [] } },
  ]
}
