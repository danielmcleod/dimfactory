// Theme source (main owns nativeTheme.themeSource; the preload passes the initial theme and the window's
// backgroundColor matches it): ui.theme / ui.accent from the user dimfactory.json, `ui.setTheme` persisting through
// config.patch, and `theme` pushes when the setting or the OS appearance changes. Electron-free: nativeTheme is
// injected.
import type { Accent, DimFactoryConfig, Theme } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ResolvedTheme, ThemeState } from '@shared/ipc.ts'
import { WINDOW_BACKGROUND } from './constants.ts'
import type { CloseToTray } from './quit.ts'

export interface UiSettings {
  theme: Theme
  accent: Accent
  closeToTray: CloseToTray
}

/** The builtin defaults (core config/defaults.ts `ui`). */
export const DEFAULT_UI: UiSettings = { theme: 'system', accent: 'slate', closeToTray: 'auto' }

/** The user file's `ui` section over the defaults (an invalid or missing file gives the defaults). */
export function uiSettingsOf(cfg: Pick<DimFactoryConfig, 'ui'> | undefined): UiSettings {
  const ui = cfg?.ui
  return {
    theme: ui?.theme ?? DEFAULT_UI.theme,
    accent: ui?.accent ?? DEFAULT_UI.accent,
    closeToTray: ui?.closeToTray ?? DEFAULT_UI.closeToTray,
  }
}

export function themeStateOf(theme: Theme, accent: Accent, dark: boolean): ThemeState {
  return { theme, resolved: dark ? 'dark' : 'light', accent }
}

export function backgroundFor(resolved: ResolvedTheme): string {
  return WINDOW_BACKGROUND[resolved]
}

/** The ui.setTheme write: one JSON Patch op per given field, into the user file. */
export function themePatchOps(req: { theme?: Theme; accent?: Accent }): JsonPatchOp[] {
  const ops: JsonPatchOp[] = []
  if (req.theme !== undefined) ops.push({ op: 'add', path: '/ui/theme', value: req.theme })
  if (req.accent !== undefined) ops.push({ op: 'add', path: '/ui/accent', value: req.accent })
  return ops
}

/** The part of Electron's nativeTheme the controller uses. */
export interface NativeThemeLike {
  themeSource: Theme
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

export interface ThemeControllerOptions {
  native: NativeThemeLike
  initial: { theme: Theme; accent: Accent }
  /** Persist the ops into the user dimfactory.json (config.patch); throws on failure. */
  persist: (ops: JsonPatchOp[]) => Promise<void>
  /** A new ThemeState (push `{kind:'theme'}`, window background). Called only when the state changed. */
  onChange: (s: ThemeState) => void
}

export class ThemeController {
  readonly #o: ThemeControllerOptions
  #theme: Theme
  #accent: Accent
  #lastKey: string

  constructor(o: ThemeControllerOptions) {
    this.#o = o
    this.#theme = o.initial.theme
    this.#accent = o.initial.accent
    o.native.themeSource = this.#theme
    this.#lastKey = key(this.state)
    o.native.on('updated', () => this.#changed())
  }

  get state(): ThemeState {
    return themeStateOf(this.#theme, this.#accent, this.#o.native.shouldUseDarkColors)
  }

  /** ui.setTheme: persist first; the running app follows only a successful write. */
  async set(req: { theme?: Theme; accent?: Accent }): Promise<ThemeState> {
    const ops = themePatchOps(req)
    if (ops.length === 0) return this.state
    await this.#o.persist(ops)
    this.#apply(req.theme ?? this.#theme, req.accent ?? this.#accent)
    return this.state
  }

  /** The user file changed on disk (another editor): follow it without writing. */
  follow(ui: { theme: Theme; accent: Accent }): void {
    this.#apply(ui.theme, ui.accent)
  }

  #apply(theme: Theme, accent: Accent): void {
    this.#accent = accent
    if (theme !== this.#theme) {
      this.#theme = theme
      this.#o.native.themeSource = theme
    }
    this.#changed()
  }

  #changed(): void {
    const s = this.state
    const k = key(s)
    if (k === this.#lastKey) return
    this.#lastKey = k
    this.#o.onChange(s)
  }
}

const key = (s: ThemeState): string => `${s.theme}|${s.resolved}|${s.accent}`
