// Taskbar and Dock attention (the attention count): Windows overlay badge with the number
// of things that need the user and a taskbar flash on a new ask while the window is unfocused (stopped on focus);
// macOS Dock badge; Linux launcher badge. The tray count and `-attn` icon stay in tray-model.ts. Electron-free: the
// window and app calls are injected (index.ts passes BrowserWindow.setOverlayIcon / flashFrame, app.setBadgeCount).
import type { AttentionItem } from '@shared/estimates.ts'
import type { Platform } from '@shared/ipc.ts'

/** The overlay PNG (16 px, `@2x` beside it) under the tray icon directory: `overlay-{1..9,9p}.png`. */
export function overlayIcon(needsYou: number): string | null {
  const n = Number.isFinite(needsYou) && needsYou > 0 ? Math.floor(needsYou) : 0
  if (n === 0) return null
  return `overlay-${n > 9 ? '9p' : String(n)}.png`
}

/** The overlay's accessible description: "1 needs you" / "3 need you". */
export function overlayDescription(needsYou: number): string {
  const n = Number.isFinite(needsYou) && needsYou > 0 ? Math.floor(needsYou) : 0
  if (n === 0) return ''
  return `${n} ${n === 1 ? 'needs' : 'need'} you`
}

/** Dock (macOS) and launcher (Linux) badge count; Windows has no badge count (it uses the overlay). */
export function badgeCount(needsYou: number, platform: Platform): number | null {
  if (platform === 'win32') return null
  return Number.isFinite(needsYou) && needsYou > 0 ? Math.floor(needsYou) : 0
}

/** Ask ids in `items` not in `seen`. */
export function newAskIds(items: readonly AttentionItem[], seen: ReadonlySet<string>): string[] {
  return items.flatMap((i) => (i.kind === 'ask' && !seen.has(i.id) ? [i.id] : []))
}

export interface SurfaceOps {
  /** Windows: BrowserWindow.setOverlayIcon(image or null, description). */
  setOverlay(icon: string | null, description: string): void
  /** Windows: BrowserWindow.flashFrame. */
  flash(on: boolean): void
  /** macOS / Linux: app.setBadgeCount. */
  setBadge(count: number): void
}

export interface SurfacesState {
  needsYou: number
  overlay: string | null
  overlayDescription: string
  badge: number | null
  flashing: boolean
}

export interface AttentionSurfacesOptions {
  platform: Platform
  ops: SurfaceOps
  /** The window has the user's focus (E2E may simulate unfocused). */
  focused: () => boolean
  log?: { warn(msg: string, data?: Record<string, unknown>): void }
}

export class AttentionSurfaces {
  readonly #o: AttentionSurfacesOptions
  #seen = new Set<string>()
  #state: SurfacesState = { needsYou: 0, overlay: null, overlayDescription: '', badge: null, flashing: false }

  constructor(o: AttentionSurfacesOptions) {
    this.#o = o
  }

  get current(): SurfacesState {
    return { ...this.#state }
  }

  /** Every `attention` event (and once at boot). Native calls happen only for what changed. */
  update(needsYou: number, items: readonly AttentionItem[]): void {
    const { platform } = this.#o
    const fresh = newAskIds(items, this.#seen)
    this.#seen = new Set(items.flatMap((i) => (i.kind === 'ask' ? [i.id] : [])))
    const next: SurfacesState = { ...this.#state, needsYou }
    if (platform === 'win32') {
      next.overlay = overlayIcon(needsYou)
      next.overlayDescription = overlayDescription(needsYou)
      if (next.overlay !== this.#state.overlay) {
        this.#call(() => this.#o.ops.setOverlay(next.overlay, next.overlayDescription))
      }
      if (fresh.length > 0 && !this.#o.focused()) {
        next.flashing = true
        this.#call(() => this.#o.ops.flash(true))
      } else if (needsYou === 0 && this.#state.flashing) {
        next.flashing = false
        this.#call(() => this.#o.ops.flash(false))
      }
    } else {
      next.badge = badgeCount(needsYou, platform)
      if (next.badge !== this.#state.badge && next.badge !== null) {
        const count = next.badge
        this.#call(() => this.#o.ops.setBadge(count))
      }
    }
    this.#state = next
  }

  /** Apply the current overlay / badge again (the window did not exist when they were set). */
  reapply(): void {
    const s = this.#state
    if (this.#o.platform === 'win32') {
      if (s.overlay !== null) this.#call(() => this.#o.ops.setOverlay(s.overlay, s.overlayDescription))
    } else if (s.badge !== null) {
      const count = s.badge
      this.#call(() => this.#o.ops.setBadge(count))
    }
  }

  /** The window gained focus: stop flashing. */
  focused(): void {
    if (!this.#state.flashing) return
    this.#state = { ...this.#state, flashing: false }
    this.#call(() => this.#o.ops.flash(false))
  }

  #call(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.#o.log?.warn('attention surface update failed', { err })
    }
  }
}
