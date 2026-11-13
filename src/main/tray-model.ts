// Tray presentation model (the attention count, the tray menu): which icon, tooltip, title
// and menu a TrayState maps to. Pure, so it is unit-tested without Electron; tray.ts only applies the result.
import { RUN_ID_PATTERN } from '../shared/ids.ts'
import type { Platform } from '../shared/ipc.ts'

export interface TrayState {
  activeRuns: number
  needsYou: number
  runs: { runId: string; title: string; needsYou: boolean }[]
  /**
   * Notifications are wired; `pausedUntil` is set while they are paused (main clears it when the pause ends).
   * Absent: the pause item stays disabled (a shell without notifications).
   */
  notifications?: { pausedUntil: number | null }
}

export type TrayAction =
  | { kind: 'open' }
  | { kind: 'new-run' }
  | { kind: 'open-run'; runId: string }
  | { kind: 'pause-notifications' }
  | { kind: 'resume-notifications' }
  | { kind: 'quit' }

export type TrayMenuItem =
  | { type: 'separator' }
  | { type: 'item'; label: string; enabled: boolean; action?: TrayAction; toolTip?: string }

export interface TrayModel {
  /** File name inside the tray icon directory. */
  icon: string
  /** macOS only: true for template images (black + alpha, recoloured by the menu bar). */
  template: boolean
  tooltip: string
  /** macOS menu-bar text beside the icon (the active-run count); empty elsewhere and at zero. */
  title: string
  menu: TrayMenuItem[]
}

/** Runs listed in the menu; the rest collapse into one "N more runs" item. */
export const TRAY_MAX_RUNS = 5
const TITLE_MAX = 48
export const LATER_VERSION = 'Available in a later version'

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/**
 * Windows/Linux: colour PNG `tray-{0..9|9p}{,-attn}.png` (active runs, 9p above 9; `-attn` when something needs you).
 * macOS: one template glyph (`trayTemplate` / `trayAttnTemplate`) plus the count as the tray title.
 */
export function trayIcon(s: TrayState, platform: Platform): { icon: string; template: boolean } {
  const attn = count(s.needsYou) > 0
  if (platform === 'darwin') {
    return { icon: attn ? 'trayAttnTemplate.png' : 'trayTemplate.png', template: true }
  }
  const n = count(s.activeRuns)
  return { icon: `tray-${n > 9 ? '9p' : String(n)}${attn ? '-attn' : ''}.png`, template: false }
}

/** "2 runs active · 1 needs you" / "1 run active" / "No active runs". */
export function trayTooltip(s: TrayState): string {
  const n = count(s.activeRuns)
  const needs = count(s.needsYou)
  const head = n === 0 ? 'No active runs' : n === 1 ? '1 run active' : `${n} runs active`
  if (needs === 0) return head
  return `${head} · ${needs} ${needs === 1 ? 'needs' : 'need'} you`
}

/** One line, at most TITLE_MAX characters; `&` escaped where Electron reads it as a mnemonic marker. */
function runLabel(title: string, needsYou: boolean, platform: Platform): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat === '' ? 'Untitled run' : flat)
  let text = chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : chars.join('')
  if (platform !== 'darwin') text = text.replace(/&/g, '&&')
  return (needsYou ? '● ' : '') + text
}

/** `14:05`: local 24-hour time of day. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Pause notifications for 1 hour, or (while paused) "Notifications paused until 14:05" and Resume. */
function pauseItems(s: TrayState): TrayMenuItem[] {
  if (s.notifications === undefined) {
    return [{ type: 'item', label: 'Pause notifications for 1 hour', enabled: false, toolTip: LATER_VERSION }]
  }
  const until = s.notifications.pausedUntil
  if (until === null) {
    return [
      {
        type: 'item',
        label: 'Pause notifications for 1 hour',
        enabled: true,
        action: { kind: 'pause-notifications' },
      },
    ]
  }
  return [
    { type: 'item', label: `Notifications paused until ${clockTime(until)}`, enabled: false },
    { type: 'item', label: 'Resume notifications', enabled: true, action: { kind: 'resume-notifications' } },
  ]
}

/**
 * Open Dim Factory · Active runs (runs that need you first, at most five) · New run · Pause notifications (or
 * "paused until" + Resume) · Quit.
 */
export function trayMenu(s: TrayState, platform: Platform): TrayMenuItem[] {
  const runs = [...s.runs].sort((a, b) => Number(b.needsYou) - Number(a.needsYou))
  const shown = runs.slice(0, TRAY_MAX_RUNS)
  const hidden = runs.length - shown.length
  const items: TrayMenuItem[] = [
    { type: 'item', label: 'Open Dim Factory', enabled: true, action: { kind: 'open' } },
    { type: 'separator' },
    { type: 'item', label: shown.length === 0 ? 'No active runs' : 'Active runs', enabled: false },
  ]
  for (const r of shown) {
    items.push({
      type: 'item',
      label: runLabel(r.title, r.needsYou, platform),
      enabled: true,
      action: { kind: 'open-run', runId: r.runId },
    })
  }
  if (hidden > 0) {
    items.push({
      type: 'item',
      label: hidden === 1 ? '1 more run' : `${hidden} more runs`,
      enabled: true,
      action: { kind: 'open' },
    })
  }
  items.push(
    { type: 'separator' },
    { type: 'item', label: 'New run', enabled: true, action: { kind: 'new-run' } },
    ...pauseItems(s),
    { type: 'separator' },
    { type: 'item', label: 'Quit', enabled: true, action: { kind: 'quit' } },
  )
  return items
}

export function trayModel(s: TrayState, platform: Platform): TrayModel {
  const n = count(s.activeRuns)
  return {
    ...trayIcon(s, platform),
    tooltip: trayTooltip(s),
    title: platform === 'darwin' && n > 0 ? String(n) : '',
    menu: trayMenu(s, platform),
  }
}

export const EMPTY_TRAY_STATE: TrayState = { activeRuns: 0, needsYou: 0, runs: [] }

/**
 * The renderer route a tray action opens: the Dashboard (where the composer is) for New run, the Run view for a run.
 * Null for actions that only reveal the window, and for a run id that is not one (it never reaches the page).
 */
export function trayRoute(a: TrayAction): string | null {
  switch (a.kind) {
    case 'new-run':
      return '#/'
    case 'open-run':
      return RUN_ID_PATTERN.test(a.runId) ? `#/runs/${a.runId}` : null
    case 'open':
    case 'pause-notifications':
    case 'resume-notifications':
    case 'quit':
      return null
  }
}

/** A route main may set on the page itself: `#/` or `#/runs/<run id>` (what trayRoute builds). */
export function isMainRoute(hash: string): boolean {
  if (hash === '#/') return true
  const m = /^#\/runs\/([^/?#]+)$/.exec(hash)
  return m !== null && RUN_ID_PATTERN.test(m[1] ?? '')
}
