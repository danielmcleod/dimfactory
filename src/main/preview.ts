// Run & Preview in main: the preview window, Open in browser, the smoke check and the play-test.
//
// The preview window shows a running preview's page (a loopback http URL core read from its output, or its static
// server's; never a URL the renderer sends). It is a separate BrowserWindow with no preload, no node integration,
// context isolation, the sandbox, web security on, no <webview>, and its own in-memory session partition per preview
// (nothing it stores reaches the app or another preview). On that session every permission request and check is
// denied but `fullscreen` (a game's full screen button), which only the visible window's partition allows; downloads
// are refused, and requests other than web schemes (file:, custom schemes) are cancelled. A game's preview is
// loopback-only: its pages may reach this computer and nothing else (each request to another computer is cancelled and
// recorded on the session, so it becomes a finding) until the user clicks "Allow internet for this preview" (the
// session's `network`, read at every request). Its page may navigate (top frame and frames) only within the preview's
// own origin; window.open is denied. It never gets Dim Factory's IPC: the command channel accepts only the main window
// (ipc.ts), and it has no preload to reach it. F11 toggles the window's full screen and Escape leaves it; the page takes
// the keyboard focus once it has loaded, so a game plays at once. Open in browser hands the same loopback http URL to
// the system browser (shell.openExternal).
//
// The pair window (two running previews next to each other: a match's two results) is one more window built the same
// way. Its own page stays empty; each preview is a WebContentsView on top of it, on that preview's own partition and
// confined to that preview's own origin, the first on the left. It closes when either preview ends, and it takes no
// Phone size.
//
// Phone size (a game's preview window: the Phone size button, or Ctrl+Shift+M in the window) sizes the page to 390 by
// 844 and turns on touch emulation, so the game sees a touch screen and a click arrives as a tap. It goes through the
// DevTools protocol (webContents.debugger) of that window alone: main attaches it only to a webContents it made for a
// preview (never the app's own window or the Save as PDF window), sends only the few commands preview-model.ts lists,
// and detaches it when Phone size is turned off or the window closes. The hidden smoke and play-test windows use the
// same channel, the same way, for a play-test's phone scenarios (touch taps) and reduced motion.
//
// The smoke check (no model) loads the page in a hidden window built the same way, records console errors, failed
// loads and blocked requests, waits for the page to settle, captures a screenshot, and hands what it saw to core
// (core.preview.recordSmoke), which turns a run's console errors into [should] findings. For a game it also runs the
// built-in game checks (playtest.ts) in that window, rendered off screen at 60 frames a second so the game's loop runs.
//
// The play-test (a game's playtest.json, or core's built-in Verify play-test through attachPlaytester) plays the page in
// a hidden window built the same way on its own partition: muted, every permission denied, loopback-only, off screen,
// background throttling off. Real input goes in with sendInputEvent; the page is read only with fixed scripts.
//
// Save as PDF (a rendered document view only): the document's loopback page is loaded in a hidden window built the
// same way (its own partition, sandboxed, no preload, confined to its origin), printed with webContents.printToPDF,
// and the bytes go to core (core.preview.savePdf), which writes them next to the document in its project folder.
//
// Try it for me and Before I share it open the page in the page-load check's hidden window on this computer only: the
// first presses what a visitor would, the second reads the page at a phone's width and opens its links to its own site.
import type { SharePageReport } from '../shared/share-check.ts'
import { SHARE_LINKS_MAX, SHARE_LOOK, shareOpenScript } from '../shared/share-check.ts'
import type { TryItReport } from '../shared/try-it.ts'
import { TRY_IT_LOOK, TRY_IT_MAX_STEPS, TRY_IT_NEXT } from '../shared/try-it.ts'
import { BrowserWindow, WebContentsView, session } from 'electron'
import type { Session, WebContents } from 'electron'
import type { CorePreview } from '@core/app-core.ts'
import type { MainPlaytester } from '@core/preview/game.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { Logger } from '@core/log.ts'
import type { PageloadReport } from '@shared/pageload.ts'
import type { BlockedRequest, PlaytestReport, PlaytestSpec, PreviewNetworkMode } from '@shared/playtest.ts'
import type {
  PreviewPlaytestView,
  PreviewSessionView,
  PreviewSmokeView,
  SmokeConsoleError,
  SmokeFailedLoad,
} from '@shared/preview.ts'
import { previewOrigin } from '@shared/preview.ts'
import { GameDriver, isAborted, runGameChecks, runScenarios } from './playtest.ts'
import type { PageEmulator } from './playtest.ts'
import {
  DESKTOP_SIZE,
  PAIR_GAP_COLOR,
  PAIR_SIZE,
  PHONE_SIZE,
  PREVIEW_DEBUGGER_METHODS,
  debuggerAllowed,
  failedLoadOf,
  fullscreenKeyAction,
  navigationAllowed,
  openableUrl,
  pairBounds,
  pairTitle,
  phoneKeyAction,
  previewPermissionAllowed,
  previewTitle,
  reducedMotionCommand,
  requestDecision,
  touchEmulationCommands,
  touchTapCommands,
} from './preview-model.ts'
import type { DebuggerCommand, PreviewPartitionKind } from './preview-model.ts'
import { urlForLog } from './urls.ts'

/** How long the smoke check waits for the page to load, then for late errors once it has. */
export const SMOKE_LOAD_TIMEOUT_MS = 30_000
export const SMOKE_SETTLE_MS = 1500
/** How long Save as PDF waits for the document page to load. */
export const PDF_LOAD_TIMEOUT_MS = 30_000
const THUMB_WIDTH = 480
/** The hidden check windows' own size (content area). */
const HIDDEN_SIZE = { width: 1280, height: 800 } as const
/** At most this many console errors, failed loads and blocked requests are kept per check. */
const ITEMS_MAX = 50

export interface PreviewWindowsDeps {
  preview: CorePreview
  openExternal: (url: string) => Promise<void>
  log: Pick<Logger, 'info' | 'warn'>
  /** Show the preview window at once (E2E; otherwise on ready-to-show). */
  showImmediately?: boolean
  /** E2E: record Open in browser instead of opening the developer's browser. */
  recordExternal?: (url: string) => void
  /**
   * The preview window's own icon (title bar, Alt+Tab), as the main window's (window.ts windowIcon). Without it a
   * build that is not installed (development, the tests) shows the icon of the Electron executable; an installed
   * build's executable carries the logo itself. Undefined keeps the executable's.
   */
  icon?: string | undefined
}

const SANDBOXED = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true,
} as const

/** What a preview session's requests may reach, read at each request, and who hears of a blocked one. */
interface NetworkPolicy {
  mode(): PreviewNetworkMode
  onBlocked(url: string): void
}

/**
 * A preview's session: no permission but `fullscreen` in the visible window's partition (previewPermissionAllowed),
 * no downloads, web schemes only, and (loopback-only) nothing from another computer. Idempotent per session.
 */
function hardenSession(
  ses: Session,
  kind: PreviewPartitionKind,
  done: WeakSet<Session>,
  policy: NetworkPolicy,
): void {
  if (done.has(ses)) return
  done.add(ses)
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(previewPermissionAllowed(kind, permission)),
  )
  ses.setPermissionCheckHandler((_wc, permission) => previewPermissionAllowed(kind, permission))
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (ev) => ev.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => {
    const decision = requestDecision(details.url, policy.mode())
    if (decision === 'blocked') policy.onBlocked(details.url)
    callback({ cancel: decision !== 'allow' })
  })
}

/** Keep a preview page inside its origin: navigations, redirects and frames elsewhere are stopped; no new windows. */
function confine(wc: WebContents, origin: string, log: PreviewWindowsDeps['log']): void {
  wc.setWindowOpenHandler(({ url }) => {
    log.warn('preview: blocked window.open', { url: urlForLog(url) })
    return { action: 'deny' }
  })
  wc.on('will-navigate', (ev) => {
    if (navigationAllowed(ev.url, origin)) return
    ev.preventDefault()
    log.warn('preview: blocked navigation', { url: urlForLog(ev.url) })
  })
  wc.on('will-frame-navigate', (ev) => {
    if (ev.isMainFrame || navigationAllowed(ev.url, origin)) return
    ev.preventDefault()
    log.warn('preview: blocked frame navigation', { url: urlForLog(ev.url) })
  })
  wc.on('will-redirect', (ev) => {
    if (navigationAllowed(ev.url, origin)) return
    ev.preventDefault()
    log.warn('preview: blocked redirect', { url: urlForLog(ev.url) })
  })
  wc.on('will-attach-webview', (ev) => ev.preventDefault())
}

/** How long a press gets to show what it did. */
const TRY_IT_SETTLE_MS = 700

/** A partition name for a session id (no `persist:`: kept in memory only). */
const partitionFor = (kind: PreviewPartitionKind, sessionId: string): string =>
  `preview-${kind}-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}`

/** The core's built-in Verify play-test plays here: one partition, one play-test at a time. */
const VERIFY_PLAYTEST_PARTITION = 'preview-playtest-verify'
/** The core's built-in Verify page-load check opens its page here (this computer only), one at a time. */
const VERIFY_PAGELOAD_PARTITION = 'preview-pageload-verify'

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return '?'
  }
}

/** What a hidden window saw while it was open. */
interface Watch {
  consoleErrors: SmokeConsoleError[]
  failedLoads: SmokeFailedLoad[]
  blocked: BlockedRequest[]
}

export class PreviewWindows implements MainPlaytester {
  readonly #d: PreviewWindowsDeps
  readonly #windows = new Map<string, Set<BrowserWindow>>()
  readonly #contents = new WeakSet<WebContents>()
  /** The preview webContents the DevTools protocol may be attached to, and for what kind of window. */
  readonly #debuggable = new WeakMap<WebContents, PreviewPartitionKind>()
  /** The visible preview windows at Phone size. */
  readonly #phone = new WeakSet<BrowserWindow>()
  /** Each preview window's title as it reads now (the page's own, and whether it is at Phone size). */
  readonly #titles = new WeakMap<BrowserWindow, () => string>()
  /** The pair windows: whose two previews each shows, left then right, and the pages it shows them in. */
  readonly #pairs = new WeakMap<
    BrowserWindow,
    { sessionIds: readonly [string, string]; pages: readonly [WebContents, WebContents] }
  >()
  readonly #hardened = new WeakSet<Session>()
  /** The hidden check open on a partition hears of the requests it blocked. */
  readonly #blockedSinks = new Map<string, (b: BlockedRequest) => void>()
  /** Play-tests run one at a time. */
  #playing: Promise<unknown> = Promise.resolve()

  constructor(d: PreviewWindowsDeps) {
    this.#d = d
  }

  /** A webContents of a preview (window or smoke check): the app's own hardening leaves its navigation to this file. */
  owns(wc: WebContents): boolean {
    return this.#contents.has(wc)
  }

  /**
   * Send DevTools protocol commands to a preview's own page (see the header): only a webContents this file made for a
   * window kind that may have it, only the listed commands. Attaches on first use. False when it could not.
   */
  async #debug(wc: WebContents, cmds: readonly DebuggerCommand[]): Promise<boolean> {
    const kind = this.#debuggable.get(wc)
    if (kind === undefined || !debuggerAllowed(kind) || wc.isDestroyed()) return false
    if (!cmds.every((c) => PREVIEW_DEBUGGER_METHODS.has(c.method))) return false
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      for (const c of cmds) await wc.debugger.sendCommand(c.method, c.params)
      return true
    } catch (err) {
      this.#d.log.warn('preview: a DevTools protocol command failed', { err })
      return false
    }
  }

  /** Let go of a preview page's DevTools protocol (Phone size off, the window closing). */
  #detach(wc: WebContents): void {
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // already gone
    }
  }

  /**
   * What a hidden check window's play-test may change: phone size with touch, reduced motion, a touch tap. Turning one
   * off also lets go of the protocol, which clears every emulation (a page loaded after it sees no touch screen).
   */
  #emulatorFor(win: BrowserWindow): PageEmulator {
    const wc = win.webContents
    const off = async (cmds: readonly DebuggerCommand[]): Promise<boolean> => {
      const ok = !wc.debugger.isAttached() || (await this.#debug(wc, cmds))
      this.#detach(wc)
      return ok
    }
    return {
      viewport: async (phone) => {
        const ok = phone
          ? await this.#debug(wc, touchEmulationCommands(true))
          : await off(touchEmulationCommands(false))
        if (!win.isDestroyed()) {
          const size = phone ? PHONE_SIZE : HIDDEN_SIZE
          win.setContentSize(size.width, size.height)
        }
        return ok
      },
      reducedMotion: (on) =>
        on ? this.#debug(wc, [reducedMotionCommand(true)]) : off([reducedMotionCommand(false)]),
      tap: (x, y) => this.#debug(wc, touchTapCommands(x, y)),
    }
  }

  /** The URL of a running preview, checked: loopback http only. */
  #urlOf(sessionId: string): string {
    const s = this.#d.preview.session(sessionId)
    if (s === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
    if (s.status !== 'running') throw new DimFactoryError('CONFLICT', 'That preview is not running.')
    const url = openableUrl(s.url)
    if (url === null) {
      throw new DimFactoryError(
        'VALIDATION',
        s.url === null
          ? 'Its output has not named the page yet.'
          : 'Only a page on this computer over http opens from Dim Factory.',
      )
    }
    return url
  }

  /** A session's partition, hardened with its network policy (the session's mode, read at every request). */
  #sessionPartition(kind: PreviewPartitionKind, sessionId: string): { partition: string; ses: Session } {
    const partition = partitionFor(kind, sessionId)
    const ses = session.fromPartition(partition)
    hardenSession(ses, kind, this.#hardened, {
      mode: () => this.#d.preview.session(sessionId)?.network ?? 'internet',
      onBlocked: (url) => {
        this.#d.preview.recordBlocked(sessionId, url)
        this.#blockedSinks.get(partition)?.({ url, host: hostOf(url) })
        this.#d.log.info('preview: blocked a request to another computer', { url: urlForLog(url) })
      },
    })
    return { partition, ses }
  }

  async open(sessionId: string, target: 'app' | 'browser'): Promise<void> {
    const url = this.#urlOf(sessionId)
    if (target === 'browser') {
      if (this.#d.recordExternal !== undefined) this.#d.recordExternal(url)
      else await this.#d.openExternal(url)
      return
    }
    const existing = this.#windowOf(sessionId)
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      existing.webContents.focus()
      return
    }
    const origin = previewOrigin(url) as string
    const { partition } = this.#sessionPartition('window', sessionId)
    const win = new BrowserWindow({
      width: DESKTOP_SIZE.width,
      height: DESKTOP_SIZE.height,
      useContentSize: true,
      show: false,
      title: previewTitle('', url),
      ...(this.#d.icon !== undefined ? { icon: this.#d.icon } : {}),
      autoHideMenuBar: true,
      webPreferences: { ...SANDBOXED, partition },
    })
    this.#contents.add(win.webContents)
    // A game's preview window may take Phone size (touch emulation over its own DevTools protocol).
    if (this.#d.preview.session(sessionId)?.game === true) this.#debuggable.set(win.webContents, 'window')
    confine(win.webContents, origin, this.#d.log)
    let pageTitle = ''
    win.on('page-title-updated', (ev, title) => {
      ev.preventDefault()
      pageTitle = title
      win.setTitle(previewTitle(title, url, this.#phone.has(win)))
    })
    this.#titles.set(win, () => previewTitle(pageTitle, url, this.#phone.has(win)))
    const set = this.#windows.get(sessionId) ?? new Set<BrowserWindow>()
    set.add(win)
    this.#windows.set(sessionId, set)
    const wc = win.webContents
    // Closing the window lets go of its DevTools protocol, and Phone size ends with it.
    win.on('close', () => {
      this.#detach(wc)
      if (this.#phone.delete(win)) this.#d.preview.setPhone(sessionId, false)
    })
    win.on('closed', () => set.delete(win))
    // F11 toggles full screen, Escape leaves it (the page still gets Escape: a game pauses on it); Ctrl+Shift+M
    // toggles Phone size (a game's window).
    win.webContents.on('before-input-event', (ev, input) => {
      if (this.#debuggable.has(wc) && phoneKeyAction(input) === 'toggle') {
        ev.preventDefault()
        void this.#setPhone(win, sessionId, !this.#phone.has(win)).catch((err: unknown) =>
          this.#d.log.warn('preview: Phone size failed', { err }),
        )
        return
      }
      const action = fullscreenKeyAction(input, win.isFullScreen())
      if (action === 'toggle') {
        ev.preventDefault()
        win.setFullScreen(!win.isFullScreen())
      } else if (action === 'leave') win.setFullScreen(false)
    })
    // The page takes the keyboard focus once it has loaded: a game's keys work without a click first.
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed() && win.isVisible()) win.webContents.focus()
    })
    if (this.#d.showImmediately === true) win.show()
    else
      win.once('ready-to-show', () => {
        win.show()
        win.webContents.focus()
      })
    this.#d.log.info('preview window', { sessionId, url: urlForLog(url) })
    // A page that fails to load shows the browser's own error; the window stays for a reload.
    win.loadURL(url).catch(() => undefined)
  }

  /**
   * Phone size for a game's preview window (opened first when it is not open): 390 by 844 with touch emulation, or the
   * desktop size again. Answers the session as core keeps it (its `phone`).
   */
  async phone(sessionId: string, on: boolean): Promise<PreviewSessionView> {
    const s = this.#d.preview.session(sessionId)
    if (s === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
    if (s.game !== true) throw new DimFactoryError('VALIDATION', "Phone size is for a game's preview.")
    let win = this.#windowOf(sessionId)
    if (win === undefined) {
      if (!on) return s
      await this.open(sessionId, 'app')
      win = this.#windowOf(sessionId)
    }
    if (win === undefined) throw new DimFactoryError('INTERNAL', 'The preview window did not open.')
    await this.#setPhone(win, sessionId, on)
    return this.#d.preview.session(sessionId) ?? s
  }

  /** A preview's own window. A pair window it is shown in is not one: that shows two, and takes no Phone size. */
  #windowOf(sessionId: string): BrowserWindow | undefined {
    return [...(this.#windows.get(sessionId) ?? [])].find((w) => !w.isDestroyed() && !this.#pairs.has(w))
  }

  /**
   * Two running previews next to each other in one window (see the header), the first on the left, each named by its
   * label in the title. A preview that is not running, or has no page on this computer, is refused as open() refuses
   * it. Opening the same pair again brings its window forward.
   */
  openPair(sessionIds: readonly [string, string], labels: readonly [string, string]): Promise<void> {
    // Nothing here waits, so a refusal is handed back as a rejection, the way open() gives its own.
    try {
      this.#showPair(sessionIds, labels)
      return Promise.resolve()
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  #showPair(sessionIds: readonly [string, string], labels: readonly [string, string]): void {
    const [a, b] = sessionIds
    const urls = [this.#urlOf(a), this.#urlOf(b)] as const
    const title = pairTitle(labels)
    const existing = [...(this.#windows.get(a) ?? [])].find((w) => {
      const pair = this.#pairs.get(w)
      return !w.isDestroyed() && pair?.sessionIds[0] === a && pair.sessionIds[1] === b
    })
    if (existing !== undefined) {
      existing.setTitle(title)
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      this.#pairs.get(existing)?.pages[0].focus()
      return
    }
    const partitions = [
      this.#sessionPartition('window', a).partition,
      this.#sessionPartition('window', b).partition,
    ] as const
    const win = new BrowserWindow({
      width: PAIR_SIZE.width,
      height: PAIR_SIZE.height,
      useContentSize: true,
      show: false,
      title,
      backgroundColor: PAIR_GAP_COLOR,
      ...(this.#d.icon !== undefined ? { icon: this.#d.icon } : {}),
      autoHideMenuBar: true,
      webPreferences: { ...SANDBOXED, partition: partitions[0] },
    })
    // The window's own page stays empty (nothing is ever loaded in it): the two previews are views on top of it. It is
    // kept like a preview's page all the same, on the left preview's partition and inside that preview's origin, so it
    // is never in the app's session.
    this.#contents.add(win.webContents)
    confine(win.webContents, previewOrigin(urls[0]) as string, this.#d.log)
    const side = (partition: string, url: string): WebContentsView => {
      const view = new WebContentsView({ webPreferences: { ...SANDBOXED, partition } })
      this.#contents.add(view.webContents)
      confine(view.webContents, previewOrigin(url) as string, this.#d.log)
      win.contentView.addChildView(view)
      return view
    }
    const views = [side(partitions[0], urls[0]), side(partitions[1], urls[1])] as const
    const pages = [views[0].webContents, views[1].webContents] as const
    // Left half and right half of whatever room the window has now.
    const layout = (): void => {
      if (win.isDestroyed()) return
      const [width = 0, height = 0] = win.getContentSize()
      const bounds = pairBounds(width, height)
      views[0].setBounds(bounds[0])
      views[1].setBounds(bounds[1])
    }
    layout()
    win.on('resize', layout)
    this.#pairs.set(win, { sessionIds: [a, b], pages })
    // Under both previews, so the window closes when either of them ends (closeFor).
    const sets = [a, b].map((id) => {
      const set = this.#windows.get(id) ?? new Set<BrowserWindow>()
      set.add(win)
      this.#windows.set(id, set)
      return set
    })
    win.on('closed', () => {
      for (const set of sets) set.delete(win)
      // A view's page outlives its window unless it is closed here: a game would play on, unseen and still heard.
      for (const wc of pages) {
        this.#contents.delete(wc)
        if (!wc.isDestroyed()) wc.close()
      }
    })
    // The window's own page never loads, so it has no ready-to-show: the window is shown once a side has a page to
    // show, or the browser's own error in its place. The left page takes the keyboard focus.
    let shown = false
    const reveal = (): void => {
      if (shown || win.isDestroyed()) return
      shown = true
      win.show()
      pages[0].focus()
    }
    if (this.#d.showImmediately === true) reveal()
    else
      for (const wc of pages) {
        wc.once('dom-ready', reveal)
        wc.once('did-fail-load', reveal)
      }
    this.#d.log.info('preview pair window', {
      sessionIds: [a, b],
      urls: [urlForLog(urls[0]), urlForLog(urls[1])],
    })
    // A page that fails to load shows the browser's own error; the window stays for a reload.
    pages[0].loadURL(urls[0]).catch(() => undefined)
    pages[1].loadURL(urls[1]).catch(() => undefined)
  }

  async #setPhone(win: BrowserWindow, sessionId: string, on: boolean): Promise<void> {
    if (win.isDestroyed()) return
    const wc = win.webContents
    if (on) {
      if (win.isFullScreen()) win.setFullScreen(false)
      if (!(await this.#debug(wc, touchEmulationCommands(true)))) {
        this.#detach(wc)
        throw new DimFactoryError('INTERNAL', 'Phone size could not be turned on for this window.')
      }
      win.setContentSize(PHONE_SIZE.width, PHONE_SIZE.height)
      this.#phone.add(win)
    } else {
      if (wc.debugger.isAttached()) await this.#debug(wc, touchEmulationCommands(false))
      this.#detach(wc)
      win.setContentSize(DESKTOP_SIZE.width, DESKTOP_SIZE.height)
      this.#phone.delete(win)
    }
    win.setTitle(this.#titles.get(win)?.() ?? previewTitle('', wc.getURL(), on))
    this.#d.preview.setPhone(sessionId, on)
    this.#d.log.info('preview: phone size', { sessionId, on })
    // The game starts again on the new screen (a page reads touch support as it loads).
    wc.reload()
    if (win.isVisible()) wc.focus()
  }

  /** Close the windows of a preview that ended. */
  closeFor(sessionId: string): void {
    for (const w of this.#windows.get(sessionId) ?? []) if (!w.isDestroyed()) w.close()
    this.#windows.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.#windows.keys()]) this.closeFor(id)
  }

  /** Save as PDF (see the header): the path core wrote. */
  async savePdf(sessionId: string): Promise<{ path: string }> {
    const s = this.#d.preview.session(sessionId)
    if (s === undefined || s.kind !== 'document') {
      throw new DimFactoryError('NOT_FOUND', 'Open the document first, then save it as a PDF.')
    }
    const url = this.#urlOf(sessionId)
    const origin = previewOrigin(url) as string
    const { partition } = this.#sessionPartition('pdf', sessionId)
    const win = new BrowserWindow({
      width: 900,
      height: 1200,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { ...SANDBOXED, partition, backgroundThrottling: false },
    })
    const wc = win.webContents
    this.#contents.add(wc)
    confine(wc, origin, this.#d.log)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new DimFactoryError('INTERNAL', 'The document did not load in time.')),
          PDF_LOAD_TIMEOUT_MS,
        )
        wc.once('did-finish-load', () => {
          clearTimeout(timer)
          resolve()
        })
        wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return
          clearTimeout(timer)
          reject(new DimFactoryError('INTERNAL', `The document did not load: ${description} (${code})`))
        })
        wc.loadURL(url).catch(() => undefined)
      })
      const pdf = await wc.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: false })
      const path = await this.#d.preview.savePdf(sessionId, pdf)
      this.#d.log.info('preview: saved a PDF', { sessionId, bytes: pdf.length })
      return { path }
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  /**
   * A hidden window for a check on a hardened partition: confined to `origin`, muted, recording console errors, failed
   * loads and blocked requests. `offscreen`: rendered off screen at 60 frames a second (a game's loop runs as on a
   * screen; a plain hidden window draws no frames).
   */
  #hidden(o: {
    partition: string
    ses: Session
    origin: string
    offscreen: boolean
    kind: 'smoke' | 'playtest'
  }): {
    win: BrowserWindow
    wc: WebContents
    watch: Watch
    emulator: PageEmulator
    dispose: () => void
  } {
    const watch: Watch = { consoleErrors: [], failedLoads: [], blocked: [] }
    // Each failure once: a game's checks load its page several times.
    const addLoad = (f: SmokeFailedLoad): void => {
      if (watch.failedLoads.length >= ITEMS_MAX) return
      if (!watch.failedLoads.some((x) => x.url === f.url && x.error === f.error)) watch.failedLoads.push(f)
    }
    const onCompleted = (d: { url: string; statusCode: number }): void => {
      const error = failedLoadOf({ url: d.url, statusCode: d.statusCode })
      if (error !== null) addLoad({ url: d.url, error })
    }
    const onError = (d: { url: string; error: string }): void => {
      // A blocked request is recorded as blocked, not as a failed load.
      if (d.error === 'net::ERR_BLOCKED_BY_CLIENT' && watch.blocked.some((b) => b.url === d.url)) return
      const error = failedLoadOf({ url: d.url, error: d.error })
      if (error !== null) addLoad({ url: d.url, error })
    }
    o.ses.webRequest.onCompleted(onCompleted)
    o.ses.webRequest.onErrorOccurred(onError)
    this.#blockedSinks.set(o.partition, (b) => {
      // Each address once (a game reloads during its checks).
      if (watch.blocked.length < ITEMS_MAX && !watch.blocked.some((x) => x.url === b.url))
        watch.blocked.push(b)
    })
    const win = new BrowserWindow({
      width: HIDDEN_SIZE.width,
      height: HIDDEN_SIZE.height,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        ...SANDBOXED,
        partition: o.partition,
        backgroundThrottling: false,
        ...(o.offscreen ? { offscreen: true } : {}),
      },
    })
    const wc = win.webContents
    this.#contents.add(wc)
    // A game's check window may emulate phone size and reduced motion (its own DevTools protocol only).
    if (o.offscreen) this.#debuggable.set(wc, o.kind)
    confine(wc, o.origin, this.#d.log)
    wc.setAudioMuted(true)
    if (o.offscreen) {
      wc.setFrameRate(60)
      wc.on('paint', () => undefined)
    }
    wc.on('console-message', (ev) => {
      const e = ev as unknown as { level?: string; message?: string; lineNumber?: number; sourceId?: string }
      if (e.level !== 'error' || watch.consoleErrors.length >= ITEMS_MAX) return
      const message = (e.message ?? '').slice(0, 2000)
      const seen = watch.consoleErrors.some(
        (x) =>
          x.message === message &&
          (x.source ?? '') === (e.sourceId ?? '') &&
          (x.line ?? 0) === (e.lineNumber ?? 0),
      )
      if (seen) return
      watch.consoleErrors.push({
        message,
        ...(e.sourceId !== undefined && e.sourceId !== '' ? { source: e.sourceId } : {}),
        ...(e.lineNumber !== undefined && e.lineNumber > 0 ? { line: e.lineNumber } : {}),
      })
    })
    const dispose = (): void => {
      o.ses.webRequest.onCompleted(null)
      o.ses.webRequest.onErrorOccurred(null)
      this.#blockedSinks.delete(o.partition)
      this.#detach(wc)
      if (!win.isDestroyed()) win.destroy()
    }
    return { win, wc, watch, emulator: this.#emulatorFor(win), dispose }
  }

  /** The smoke check (see the header). */
  async smoke(sessionId: string): Promise<PreviewSmokeView> {
    const url = this.#urlOf(sessionId)
    const origin = previewOrigin(url) as string
    const game = this.#d.preview.session(sessionId)?.game === true
    const { partition, ses } = this.#sessionPartition('smoke', sessionId)
    await ses.clearStorageData().catch(() => undefined)
    const h = this.#hidden({ partition, ses, origin, offscreen: game, kind: 'smoke' })
    const wc = h.wc
    let loaded = false
    let error: string | undefined
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          error = `The page did not load within ${SMOKE_LOAD_TIMEOUT_MS / 1000} seconds`
          resolve()
        }, SMOKE_LOAD_TIMEOUT_MS)
        wc.once('did-finish-load', () => {
          loaded = true
          clearTimeout(timer)
          resolve()
        })
        wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return
          error = `The page did not load: ${description} (${code})`
          clearTimeout(timer)
          resolve()
        })
        wc.loadURL(url).catch(() => undefined)
      })
      if (loaded) await new Promise((r) => setTimeout(r, SMOKE_SETTLE_MS))
      let png: Uint8Array | null = null
      let thumbnail: string | null = null
      if (loaded) {
        const image = await wc.capturePage().catch(() => null)
        if (image !== null && !image.isEmpty()) {
          png = image.toPNG()
          const size = image.getSize()
          const small =
            size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image
          thumbnail = `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`
        }
      }
      // A game: the built-in checks in the same window (its loop runs: it is rendered off screen).
      let gameSeen: Awaited<ReturnType<typeof runGameChecks>> | null = null
      if (game && loaded) {
        const driver = new GameDriver(wc, {
          clearStorage: () => ses.clearStorageData(),
          emulator: h.emulator,
        })
        gameSeen = await runGameChecks(driver, url).catch((err: unknown) => {
          this.#d.log.warn('preview: the game checks failed', { err })
          return null
        })
      }
      return await this.#d.preview.recordSmoke(sessionId, {
        url,
        loaded,
        consoleErrors: [...h.watch.consoleErrors],
        failedLoads: [...h.watch.failedLoads],
        thumbnail,
        png,
        ...(error !== undefined ? { error } : {}),
        ...(game
          ? {
              checks: [...(gameSeen?.checks ?? []), ...watchChecks(h.watch)],
              measures: gameSeen?.measures ?? {},
              blocked: [...h.watch.blocked],
              gamePng: gameSeen?.gameplayPng ?? null,
            }
          : h.watch.blocked.length > 0
            ? { blocked: [...h.watch.blocked] }
            : {}),
      })
    } finally {
      h.dispose()
    }
  }

  /**
   * Play a loopback page in the hidden play-test window (see the header): the built-in game checks, then each scenario
   * of `spec` (none for null). One play-test at a time. Never throws for what the game does; `error` says why it could
   * not finish.
   */
  async playUrl(o: {
    url: string
    spec: PlaytestSpec | null
    shotsDir: string | null
    signal?: AbortSignal
    partition?: { partition: string; ses: Session }
  }): Promise<PlaytestReport> {
    const turn = this.#playing.then(() => this.#play(o))
    this.#playing = turn.catch(() => undefined)
    return turn
  }

  async #play(o: {
    url: string
    spec: PlaytestSpec | null
    shotsDir: string | null
    signal?: AbortSignal
    partition?: { partition: string; ses: Session }
  }): Promise<PlaytestReport> {
    const started = Date.now()
    const url = openableUrl(o.url)
    const empty = (error: string): PlaytestReport => ({
      url: o.url,
      loaded: false,
      hook: false,
      scenarios: [],
      checks: [],
      measures: {},
      consoleErrors: [],
      failedLoads: [],
      blocked: [],
      durationMs: Date.now() - started,
      error,
    })
    if (url === null) return empty('Only a page on this computer over http can be played.')
    const origin = previewOrigin(url) as string
    let part = o.partition
    if (part === undefined) {
      const ses = session.fromPartition(VERIFY_PLAYTEST_PARTITION)
      hardenSession(ses, 'playtest', this.#hardened, {
        // The verify play-test always plays a game: this computer only.
        mode: () => 'loopback',
        onBlocked: (u) => this.#blockedSinks.get(VERIFY_PLAYTEST_PARTITION)?.({ url: u, host: hostOf(u) }),
      })
      part = { partition: VERIFY_PLAYTEST_PARTITION, ses }
    }
    const ses = part.ses
    const h = this.#hidden({ partition: part.partition, ses, origin, offscreen: true, kind: 'playtest' })
    const driver = new GameDriver(h.wc, {
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      clearStorage: () => ses.clearStorageData(),
      emulator: h.emulator,
    })
    try {
      let error: string | undefined
      const seen = await runGameChecks(driver, url).catch((err: unknown) => {
        error = isAborted(err) ? 'The play-test was stopped or ran out of time' : String(err)
        return null
      })
      const scenarios =
        o.spec === null || seen === null ? [] : await runScenarios(driver, url, o.spec, o.shotsDir)
      const report: PlaytestReport = {
        url,
        loaded: seen !== null && seen.checks.some((c) => c.id === 'hook' && c.status !== 'skipped'),
        hook: seen?.hook ?? false,
        scenarios,
        checks: [...(seen?.checks ?? []), ...watchChecks(h.watch)],
        measures: seen?.measures ?? {},
        consoleErrors: [...h.watch.consoleErrors],
        failedLoads: [...h.watch.failedLoads],
        blocked: [...h.watch.blocked],
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
      }
      this.#d.log.info('preview: play-test', {
        url: urlForLog(url),
        scenarios: scenarios.length,
        failed: scenarios.filter((s) => s.status !== 'pass').length,
        ms: report.durationMs,
      })
      return report
    } finally {
      h.dispose()
      await ses.clearStorageData().catch(() => undefined)
    }
  }

  /**
   * The built-in page-load check (core's `dimf:pageload`): open a loopback page in a hidden, sandboxed window on its own
   * partition with no internet, let it settle, and answer whether it loaded and what went wrong (console errors, its
   * own files that did not load, requests to other computers it blocked). One at a time, with the play-tests. Never
   * throws for what the page does.
   */
  async checkPage(o: { url: string; signal?: AbortSignal }): Promise<PageloadReport> {
    const turn = this.#playing.then(() => this.#checkPage(o))
    this.#playing = turn.catch(() => undefined)
    return turn
  }

  async #checkPage(o: { url: string; signal?: AbortSignal }): Promise<PageloadReport> {
    const started = Date.now()
    const url = openableUrl(o.url)
    const report = (r: Omit<PageloadReport, 'url' | 'durationMs'>): PageloadReport => ({
      url: o.url,
      durationMs: Date.now() - started,
      ...r,
    })
    if (url === null)
      return report({
        loaded: false,
        consoleErrors: [],
        failedLoads: [],
        blocked: [],
        error: 'Only a page on this computer over http can be checked.',
      })
    const origin = previewOrigin(url) as string
    const ses = session.fromPartition(VERIFY_PAGELOAD_PARTITION)
    hardenSession(ses, 'smoke', this.#hardened, {
      // The check reads the project's own page: this computer only.
      mode: () => 'loopback',
      onBlocked: (u) => this.#blockedSinks.get(VERIFY_PAGELOAD_PARTITION)?.({ url: u, host: hostOf(u) }),
    })
    await ses.clearStorageData().catch(() => undefined)
    const h = this.#hidden({
      partition: VERIFY_PAGELOAD_PARTITION,
      ses,
      origin,
      offscreen: false,
      kind: 'smoke',
    })
    const wc = h.wc
    let loaded = false
    let error: string | undefined
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          error = `The page did not load within ${SMOKE_LOAD_TIMEOUT_MS / 1000} seconds`
          done()
        }, SMOKE_LOAD_TIMEOUT_MS)
        const onAbort = (): void => {
          error = 'The check was stopped'
          done()
        }
        function done(): void {
          clearTimeout(timer)
          o.signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        o.signal?.addEventListener('abort', onAbort, { once: true })
        wc.once('did-finish-load', () => {
          loaded = true
          done()
        })
        wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return
          error = `The page did not load: ${description} (${code})`
          done()
        })
        wc.loadURL(url).catch(() => undefined)
      })
      // Scripts that run after the load (a React app rendering, a fetch at start) have a moment to fail.
      if (loaded && o.signal?.aborted !== true) await new Promise((r) => setTimeout(r, SMOKE_SETTLE_MS))
      const r = report({
        loaded,
        consoleErrors: [...h.watch.consoleErrors],
        failedLoads: [...h.watch.failedLoads],
        blocked: [...h.watch.blocked],
        ...(error !== undefined ? { error } : {}),
      })
      this.#d.log.info('preview: page-load check', {
        url: urlForLog(url),
        loaded,
        errors: r.consoleErrors.length + r.failedLoads.length,
        ms: r.durationMs,
      })
      return r
    } finally {
      h.dispose()
      await ses.clearStorageData().catch(() => undefined)
    }
  }

  /**
   * Try it for me (shared/try-it.ts): open the session's page in a hidden window on this computer only, then press what
   * a visitor would, noting what each press breaks. One at a time, with the play-tests. Never throws for what the page
   * does. Nothing can leave this computer, and links to mail apps and other sites are refused by the window.
   */
  async tryIt(sessionId: string): Promise<TryItReport> {
    const url = this.#urlOf(sessionId)
    const turn = this.#playing.then(() => this.#tryIt(url))
    this.#playing = turn.catch(() => undefined)
    return turn
  }

  async #tryIt(url: string): Promise<TryItReport> {
    const origin = previewOrigin(url) as string
    const ses = session.fromPartition(VERIFY_PAGELOAD_PARTITION)
    hardenSession(ses, 'smoke', this.#hardened, {
      mode: () => 'loopback',
      onBlocked: (u) => this.#blockedSinks.get(VERIFY_PAGELOAD_PARTITION)?.({ url: u, host: hostOf(u) }),
    })
    await ses.clearStorageData().catch(() => undefined)
    const h = this.#hidden({
      partition: VERIFY_PAGELOAD_PARTITION,
      ses,
      origin,
      offscreen: false,
      kind: 'smoke',
    })
    const wc = h.wc
    const report: TryItReport = { url, loaded: false, steps: [], skipped: [], openProblems: [] }
    /** Errors since the last look, in plain words. */
    let errorsSeen = 0
    let loadsSeen = 0
    const newProblems = (): string[] => {
      const errors = h.watch.consoleErrors
        .slice(errorsSeen)
        .map((e) => `The page reported an error: ${e.message}`)
      const loads = h.watch.failedLoads
        .slice(loadsSeen)
        .map((f) => `A file did not load: ${urlForLog(f.url)}`)
      errorsSeen = h.watch.consoleErrors.length
      loadsSeen = h.watch.failedLoads.length
      return [...errors, ...loads]
    }
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          report.error = `The page did not open within ${SMOKE_LOAD_TIMEOUT_MS / 1000} seconds.`
          resolve()
        }, SMOKE_LOAD_TIMEOUT_MS)
        wc.once('did-finish-load', () => {
          report.loaded = true
          clearTimeout(timer)
          resolve()
        })
        wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return
          report.error = `The page did not open: ${description}.`
          clearTimeout(timer)
          resolve()
        })
        wc.loadURL(url).catch(() => undefined)
      })
      if (!report.loaded) return report
      await new Promise((r) => setTimeout(r, SMOKE_SETTLE_MS))
      report.openProblems = newProblems()
      const skipped = new Set<string>()
      for (let i = 0; i < TRY_IT_MAX_STEPS; i++) {
        // A press that changes page throws away the answer; the walk goes on from the new page.
        const next = (await wc
          .executeJavaScript(TRY_IT_NEXT)
          .catch(() => ({ did: 'a link', skipped: [] }))) as {
          did: string | null
          skipped: string[]
        }
        for (const s of next.skipped) skipped.add(s)
        if (next.did === null) break
        await new Promise((r) => setTimeout(r, TRY_IT_SETTLE_MS))
        const problems = newProblems()
        const look = (await wc.executeJavaScript(TRY_IT_LOOK).catch(() => null)) as { blank: boolean } | null
        if (look?.blank === true) problems.push('The page went blank.')
        report.steps.push({ did: next.did, problems })
      }
      report.skipped = [...skipped]
      return report
    } finally {
      h.dispose()
      await ses.clearStorageData().catch(() => undefined)
    }
  }

  /**
   * Before I share it (shared/share-check.ts): open the session's page in a hidden window at a phone's width, on this
   * computer only, and read what a phone and a link preview would see; then open the page's links to its own site and
   * its preview image, from inside the page, to see which answer. One at a time, with the play-tests. Never throws for
   * what the page does.
   */
  async shareCheck(sessionId: string): Promise<SharePageReport> {
    const url = this.#urlOf(sessionId)
    const turn = this.#playing.then(() => this.#shareCheck(url))
    this.#playing = turn.catch(() => undefined)
    return turn
  }

  async #shareCheck(url: string): Promise<SharePageReport> {
    const origin = previewOrigin(url) as string
    const ses = session.fromPartition(VERIFY_PAGELOAD_PARTITION)
    hardenSession(ses, 'smoke', this.#hardened, {
      mode: () => 'loopback',
      onBlocked: (u) => this.#blockedSinks.get(VERIFY_PAGELOAD_PARTITION)?.({ url: u, host: hostOf(u) }),
    })
    await ses.clearStorageData().catch(() => undefined)
    const h = this.#hidden({
      partition: VERIFY_PAGELOAD_PARTITION,
      ses,
      origin,
      offscreen: false,
      kind: 'smoke',
    })
    h.win.setContentSize(PHONE_SIZE.width, PHONE_SIZE.height)
    const wc = h.wc
    const report: SharePageReport = {
      url,
      loaded: false,
      title: '',
      viewport: false,
      phone: { width: PHONE_SIZE.width, wide: false },
      links: { checked: 0, broken: [], otherSites: 0, more: false },
      failedFiles: [],
    }
    /** A page's own address as it reads on the site ("/about.html"); another site's in full. */
    const shown = (u: string): string => {
      try {
        const p = new URL(u)
        return p.origin === origin ? `${p.pathname}${p.search}` : urlForLog(u)
      } catch {
        return u
      }
    }
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          report.error = `The page did not open within ${SMOKE_LOAD_TIMEOUT_MS / 1000} seconds.`
          resolve()
        }, SMOKE_LOAD_TIMEOUT_MS)
        wc.once('did-finish-load', () => {
          report.loaded = true
          clearTimeout(timer)
          resolve()
        })
        wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
          if (!isMainFrame || code === -3) return
          report.error = `The page did not open: ${description}.`
          clearTimeout(timer)
          resolve()
        })
        wc.loadURL(url).catch(() => undefined)
      })
      if (!report.loaded) return report
      await new Promise((r) => setTimeout(r, SMOKE_SETTLE_MS))
      // What the page itself asked for and did not get, before the check opens anything of its own.
      report.failedFiles = [...new Set(h.watch.failedLoads.map((f) => shown(f.url)))]
      const look = (await wc.executeJavaScript(SHARE_LOOK).catch(() => null)) as {
        title: string
        image: string
        viewport: boolean
        wide: boolean
        screenWidth: number
        part: string | null
        own: { href: string; url: string }[]
        otherSites: number
      } | null
      if (look === null) {
        report.error = 'The page could not be read.'
        return report
      }
      report.title = look.title
      report.viewport = look.viewport
      report.phone = {
        width: look.screenWidth > 0 ? look.screenWidth : PHONE_SIZE.width,
        wide: look.wide,
        ...(look.part !== null ? { part: look.part } : {}),
      }
      const own = look.own.slice(0, SHARE_LINKS_MAX)
      let image: { src: string; url: string | null; full: boolean } | null = null
      if (look.image !== '') {
        let abs: URL | null = null
        try {
          abs = new URL(look.image, url)
        } catch {
          abs = null
        }
        image = {
          src: look.image,
          url: abs !== null && abs.origin === origin ? abs.href : null,
          full: /^https?:\/\//i.test(look.image),
        }
      }
      const toOpen = [...own.map((l) => l.url), ...(image?.url != null ? [image.url] : [])]
      const bad = new Set(
        toOpen.length === 0
          ? []
          : (((await wc.executeJavaScript(shareOpenScript(toOpen)).catch(() => toOpen)) as string[]) ?? []),
      )
      report.links = {
        checked: own.length,
        broken: own.filter((l) => bad.has(l.url)).map((l) => l.href),
        otherSites: look.otherSites,
        more: look.own.length > own.length,
      }
      if (image !== null) {
        report.image = {
          src: image.src,
          loads: image.url === null ? (image.full ? null : false) : !bad.has(image.url),
          full: image.full,
        }
      }
      return report
    } finally {
      h.dispose()
      await ses.clearStorageData().catch(() => undefined)
    }
  }

  /** Play-test (the Run it panel, the Done screen): the session's game and its playtest.json, kept by core. */
  async playtest(sessionId: string): Promise<PreviewPlaytestView> {
    const url = this.#urlOf(sessionId)
    const spec = await this.#d.preview.playtestSpec(sessionId)
    if ('problem' in spec) return this.#d.preview.recordPlaytest(sessionId, null, spec.problem)
    const part = this.#sessionPartition('playtest', sessionId)
    const report = await this.playUrl({ url, spec: spec.spec, shotsDir: null, partition: part })
    return this.#d.preview.recordPlaytest(sessionId, report)
  }
}

/** The checks a hidden window's watch gives: console errors and failed loads, requests to other computers. */
function watchChecks(w: Watch): PlaytestReport['checks'] {
  const errors = w.consoleErrors.length + w.failedLoads.length
  return [
    errors === 0
      ? { id: 'errors', status: 'pass', title: 'No console errors or failed loads' }
      : {
          id: 'errors',
          status: 'fail',
          title: `${w.consoleErrors.length} console error${w.consoleErrors.length === 1 ? '' : 's'} and ${w.failedLoads.length} failed load${w.failedLoads.length === 1 ? '' : 's'}`,
          detail: [
            ...w.consoleErrors.map((e) => e.message),
            ...w.failedLoads.map((f) => `${f.url} (${f.error})`),
          ]
            .slice(0, 3)
            .join('; '),
        },
    w.blocked.length === 0
      ? { id: 'offline', status: 'pass', title: 'Nothing was loaded from the internet' }
      : {
          id: 'offline',
          status: 'fail',
          title: `It tried to reach the internet (${[...new Set(w.blocked.map((b) => b.host))].slice(0, 3).join(', ')}): blocked`,
          detail: w.blocked
            .slice(0, 3)
            .map((b) => b.url)
            .join('; '),
        },
  ]
}
