// Electron main entry (boot steps 1–7, close and quit). Before ready: home → userData under
// DIM_FACTORY_HOME → AUMID + toast CLSID → single-instance lock → crash reporter + event-loop monitor → createCore
// (home lock, recovery). On ready: hardening, theme, Start-menu shortcut repair, push + tray, notifications and
// attention surfaces, IPC, window, quit and power wiring, then background work. `--smoke-test` runs this same
// boot and reports through stdout (smoke.ts).
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  clipboard,
  crashReporter,
  dialog,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  shell,
} from 'electron'
import type { BrowserWindow, NativeImage, OpenDialogOptions } from 'electron'
import { createCore } from '@core/app-core.ts'
import type { Core, CoreNotification } from '@core/app-core.ts'
import { errorMessage, unwrap } from '@core/errors.ts'
import { gitSettings, gitVersion } from '@core/git/exec.ts'
import { readHealTemplate } from '@core/heal/healer.ts'
import { readCatalogRefreshTemplate } from '@core/catalog/refresh.ts'
import { HOME_ENV, homePaths, resolveHome } from '@core/home.ts'
import { runMcpBridge } from '@core/mcp/bridge.ts'
import type { Logger } from '@core/log.ts'
import { parseRequest } from '@shared/ipc-schemas.ts'
import type { AppInfo, Cmd, Platform, Result } from '@shared/ipc.ts'
import { IPC_PROTOCOL } from '@shared/ipc.ts'
import { createAppStateStore, observeAppState } from './app-state.ts'
import { AttentionSurfaces } from './attention-surfaces.ts'
import { bootFailure, recoveredNotice } from './boot-messages.ts'
import {
  APP_ID,
  WINDOW_TITLE,
  E2E_DIAGNOSTICS_PATH_ENV,
  E2E_PICK_FILES_ENV,
  E2E_PICK_FOLDER_ENV,
  NOTIFICATION_PAUSE_MS,
  QUIT_BUDGET_MS,
  TOAST_ACTIVATOR_CLSID,
  dropE2EEnv,
  isE2E,
} from './constants.ts'
import { createCoreHostBridge } from './core-host.ts'
import { createDiagnostics, machineFacts } from './diagnostics.ts'
import { diffSelfCheck } from './diff-self-check.ts'
import { FocusOverride, buildE2EState, installE2EGlobals, liveProcs } from './e2e.ts'
import { registerCommandIpc } from './ipc.ts'
import { probeUnprobedVendors } from './launch-probes.ts'
import { attachWindowLifecycle, installAppLifecycle } from './lifecycle.ts'
import { createMainHandlers } from './main-handlers.ts'
import { bridgeCommand, isMcpBridgeLaunch } from './mcp-links.ts'
import { installAppMenu, installWindowKeys } from './menu.ts'
import { createElectronNotifier, installActivationHandler } from './native-notifier.ts'
import { RecordingNotifier } from './notification-recorder.ts'
import { ActivationQueue, NotificationCenter } from './notifications.ts'
import { isPaused, notificationSettingsOf } from './notifications-model.ts'
import { startEventLoopMonitor } from './perf.ts'
import type { EventLoopMonitor } from './perf.ts'
import { PowerRouter, installPowerMonitor } from './power.ts'
import { PreviewWindows } from './preview.ts'
import { PushSink, startHeartbeat } from './push.ts'
import { realTimers } from './push-routing.ts'
import { QuitController, withinBudget } from './quit.ts'
import type { CloseToTray } from './quit.ts'
import { withRecoveryHost } from './recovery-host.ts'
import { createRouter } from './router.ts'
import { ACTIVE_RUN_STATUSES, RunsModel, trayKey } from './runs-model.ts'
import { installRendererFiles, registerAppScheme } from './renderer-files.ts'
import { installHardening } from './security.ts'
import { allUsersStartMenuShortcutPath, repairShortcut, startMenuShortcutPath } from './shortcut.ts'
import type { RepairInput, ShortcutIo } from './shortcut.ts'
import { SmokeRun, printLine } from './smoke.ts'
import { smokeFailLine, smokeMode } from './smoke-args.ts'
import type { SmokeMode } from './smoke-args.ts'
import { ThemeController, backgroundFor, uiSettingsOf } from './theme.ts'
import { createTray } from './tray.ts'
import type { TrayController } from './tray.ts'
import { trayRoute } from './tray-model.ts'
import { isAppDocumentLoad, rendererTarget, urlForLog } from './urls.ts'
import { createMainWindow, revealRoute, revealWindow, windowIcon, windowsAppDetails } from './window.ts'

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const platform: Platform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

void main().catch((err: unknown) => {
  console.error('Dim Factory main failed', err)
  app.exit(1)
})

async function main(): Promise<void> {
  // The built renderer is served as app://dim-factory/ (renderer-files.ts); the scheme's privileges must be
  // registered before the app is ready.
  registerAppScheme(protocol)
  // A packaged build ignores every DIM_FACTORY_E2E* switch (constants.ts dropE2EEnv), before anything reads them.
  const e2eEnvIgnored = dropE2EEnv(env, app.isPackaged)
  // `Dim Factory --mcp`: the stdio bridge for outside agents. It talks to the running app over loopback, so it opens no
  // window, takes neither the single-instance lock nor the home lock, and writes nothing to the home.
  if (isMcpBridgeLaunch(process.argv)) {
    // Electron's process.stdin delivers nothing from a pipe on Windows; the inherited handle (fd 0) does.
    const input = createReadStream('', { fd: 0, autoClose: false })
    const code = await runMcpBridge({
      stateFile: homePaths(resolveHome({ env })).state,
      input,
      output: process.stdout,
    })
    app.exit(code)
    return
  }
  const smoke = smokeMode(process.argv, env)
  if (smoke.enabled && !smoke.ok) {
    await printLine(smokeFailLine(smoke.reason))
    app.exit(smoke.exitCode)
    return
  }
  const e2e = isE2E(env)

  // ---- Boot 1–4 (synchronous, before ready) ----
  const home = resolveHome({ env })
  // One userData (and single-instance lock) per home, so isolated test homes never collide with a real Dim Factory.
  if ((env[HOME_ENV]?.trim() ?? '') !== '') app.setPath('userData', homePaths(home).electronUserData)
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID)
    // Set the fixed toast CLSID now so the identity never changes between versions.
    if (typeof app.setToastActivatorCLSID === 'function') {
      try {
        app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID)
      } catch (err) {
        console.error('setToastActivatorCLSID failed', err)
      }
    }
  }
  if (!app.requestSingleInstanceLock()) {
    if (smoke.enabled)
      await finishWithoutCore(smoke, 'another Dim Factory is already running with this home folder')
    else app.exit(0)
    return
  }
  crashReporter.start({ uploadToServer: false })
  const perf = startEventLoopMonitor()

  // ---- Boot 5–6: home lock, core, recovery ----
  let onNotify: (n: CoreNotification) => void = () => undefined
  // The catalog scheduler's "Model prices may be out of date" (the `catalog` event).
  let onCatalogDue: () => void = () => undefined
  const coreP = createCore({
    home,
    host: { kind: 'app', notify: (n) => onNotify(n), notifyCatalog: () => onCatalogDue() },
    // Easy mode's default projects folder goes in the OS's Documents folder (a redirected one included).
    ...documentsDirOption(),
    externalMcp: {
      bridge: bridgeCommand({
        execPath: process.execPath,
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
      }),
    },
  })
  coreP.catch(() => undefined)
  await app.whenReady()
  let core: Core
  try {
    core = await coreP
  } catch (err) {
    await bootFailed(err, home, smoke, e2e)
    return
  }
  onReady(core, {
    smoke,
    e2e,
    e2eEnvIgnored,
    perf,
    setNotify: (fn) => (onNotify = fn),
    setCatalogNotify: (fn) => (onCatalogDue = fn),
  })
}

/** createCore failed (home locked, newer schema, storage): explain and quit. */
/** The OS's Documents folder for the core (Easy mode's projects folder), when Electron can say where it is. */
function documentsDirOption(): { documentsDir?: string } {
  try {
    return { documentsDir: app.getPath('documents') }
  } catch {
    return {}
  }
}

async function bootFailed(err: unknown, home: string, smoke: SmokeMode, e2e: boolean): Promise<void> {
  const f = bootFailure(err, home)
  if (smoke.enabled) {
    await finishWithoutCore(smoke, `boot failed: ${f.code} ${errorMessage(err)}`)
    return
  }
  // Under E2E a modal dialog would hang the harness.
  if (e2e) console.error(f.message)
  else dialog.showErrorBox(f.title, f.message)
  app.exit(1)
}

async function finishWithoutCore(smoke: SmokeMode, reason: string): Promise<void> {
  if (!smoke.enabled) return
  await printLine(smokeFailLine(reason))
  app.exit(1)
}

interface ReadyOptions {
  smoke: SmokeMode
  e2e: boolean
  /** DIM_FACTORY_E2E* names a packaged build removed from its environment (logged). */
  e2eEnvIgnored: string[]
  perf: EventLoopMonitor
  setNotify: (fn: (n: CoreNotification) => void) => void
  setCatalogNotify: (fn: () => void) => void
}

/** Boot 7: everything that needs app.whenReady() and the core. */
function onReady(core: Core, o: ReadyOptions): void {
  const { e2e, perf } = o
  const log: Logger = core.log.child({ part: 'main' })
  perf.setLog((msg, data) => log.info(msg, data))
  const packaged = app.isPackaged
  log.info('main boot', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged,
    e2e,
    smoke: o.smoke.enabled,
    recoveredPaused: core.recovery.paused.length,
  })
  if (o.e2eEnvIgnored.length > 0)
    log.warn('ignored E2E switches in a packaged build', { names: o.e2eEnvIgnored })

  const target = rendererTarget({
    devUrl: env['ELECTRON_RENDERER_URL'],
    packaged,
    rendererDir: join(here, '../renderer'),
  })
  let win: BrowserWindow | null = null
  const liveWindow = (): BrowserWindow | null => (win !== null && !win.isDestroyed() ? win : null)
  const showWindow = (): void => revealWindow(liveWindow())
  const openRoute = (hash: string | null): void => {
    if (hash === null) showWindow()
    else revealRoute(liveWindow(), hash, log)
  }
  const openExternal = (url: string): void => {
    shell
      .openExternal(url)
      .catch((err: unknown) => log.warn('openExternal failed', { url: urlForLog(url), err }))
  }

  // ---- Run & Preview's windows (their own sandboxed sessions; see preview.ts) ----
  /** E2E: the last page Open in browser would have opened (the developer's browser is never opened). */
  let lastPreviewBrowserUrl: string | null = null
  const previews = new PreviewWindows({
    preview: core.preview,
    openExternal: (url) => shell.openExternal(url),
    log: log.child({ part: 'preview' }),
    showImmediately: e2e,
    icon: windowIcon(trayIconDir(packaged), process.platform),
    ...(e2e ? { recordExternal: (url: string) => (lastPreviewBrowserUrl = url) } : {}),
  })

  // A game's built-in Verify play-test plays in main's hidden play-test window.
  core.preview.attachPlaytester(previews)

  // ---- hardening ----
  installHardening({ target, openExternal, log, isPreview: (wc) => previews.owns(wc) })
  // The built renderer's files go out on app:// with the CSP as a header (its workers take theirs from it), and
  // nothing on file:// is served to the window's session.
  installRendererFiles({ target, protocol, readFile: (p) => readFile(p), log })
  installAppMenu(process.platform)

  // ---- push ----
  const push = new PushSink({
    target: () => {
      const w = liveWindow()
      return w !== null && !w.webContents.isDestroyed() ? w.webContents : null
    },
    log,
  })
  core.bus.attach(push)

  // ---- theme ----
  const ui = uiSettingsOf(core.config.user?.value)
  const theme = new ThemeController({
    native: nativeTheme,
    initial: ui,
    persist: async (ops) => {
      unwrap(await core.invoke('config.patch', { scope: 'user', ops }))
    },
    onChange: (s) => {
      push.emit({ kind: 'theme', theme: s })
      liveWindow()?.setBackgroundColor(backgroundFor(s.resolved))
    },
  })
  const closeToTray = (): CloseToTray => uiSettingsOf(core.config.user?.value).closeToTray

  // ---- Windows Start-menu shortcut repair (packaged, outside E2E/smoke only) --------
  const shortcutIo: ShortcutIo = {
    exists: (p) => existsSync(p),
    read: (p) => shell.readShortcutLink(p),
    write: (p, operation, details) => shell.writeShortcutLink(p, operation, details),
  }
  // A per-machine install puts the shortcut in the all-users Start menu (%ProgramData%).
  const programData =
    process.platform === 'win32' ? (process.env['ProgramData'] ?? process.env['ALLUSERSPROFILE']) : undefined
  const shortcutRepair = (mode: RepairInput['mode']): RepairInput => ({
    context: { platform: process.platform, packaged, e2e, smoke: o.smoke.enabled },
    io: shortcutIo,
    path: process.platform === 'win32' ? startMenuShortcutPath(app.getPath('appData')) : '',
    ...(programData !== undefined && programData !== ''
      ? { allUsersPath: allUsersStartMenuShortcutPath(programData) }
      : {}),
    want: { exePath: process.execPath, aumid: APP_ID, clsid: TOAST_ACTIVATOR_CLSID },
    mode,
    log,
  })
  let shortcut = repairShortcut(shortcutRepair('boot'))

  // ---- runs model + tray ----
  const runs = new RunsModel()
  let tray: TrayController | null = null
  let trayTimer: ReturnType<typeof setTimeout> | undefined
  let lastTray = ''
  // state.json notifications.pausedUntil, followed through every state.get / state.set (tray, Settings).
  let pausedUntil: number | null = null
  let pauseTimer: ReturnType<typeof setTimeout> | undefined
  const activePause = (): number | null => (isPaused(pausedUntil, Date.now()) ? pausedUntil : null)
  const updateTray = (): void => {
    const s = { ...runs.trayState(), notifications: { pausedUntil: activePause() } }
    const k = trayKey(s)
    if (k === lastTray) return
    lastTray = k
    try {
      tray?.update(s)
    } catch (err) {
      log.warn('tray update failed', { err })
    }
  }
  const scheduleTray = (): void => {
    if (trayTimer !== undefined) return
    trayTimer = setTimeout(() => {
      trayTimer = undefined
      updateTray()
    }, 100)
  }
  /** The tray now, not after the debounce (a pending update is folded in). */
  const flushTray = (): void => {
    if (trayTimer !== undefined) clearTimeout(trayTimer)
    trayTimer = undefined
    updateTray()
  }
  const appState = observeAppState(createAppStateStore(core.paths), (s) => {
    pausedUntil = s.notifications.pausedUntil
    if (pauseTimer !== undefined) clearTimeout(pauseTimer)
    pauseTimer = undefined
    const until = activePause()
    // The tray drops "paused until" when the hour is over.
    if (until !== null) pauseTimer = setTimeout(scheduleTray, Math.min(until - Date.now() + 50, 2 ** 31 - 1))
    scheduleTray()
  })
  void appState.get().catch((err: unknown) => log.warn('could not read state.json', { err }))

  // ---- notifications + attention surfaces ---------
  const focus = new FocusOverride()
  const windowFocused = (): boolean => {
    const real = liveWindow()?.isFocused() === true
    return e2e ? focus.resolve(real) : real
  }
  const bridge = createCoreHostBridge(core)
  // Nothing reaches the developer's desktop from E2E or smoke runs: the recorder stands in.
  const recorder = e2e || o.smoke.enabled ? new RecordingNotifier() : null
  const notifications = new NotificationCenter({
    platform,
    // Alert-style notifications with actions need a signed bundle; unsigned dev builds get open-to-answer text.
    macActions: platform === 'darwin' && packaged,
    notifier: recorder ?? createElectronNotifier({ platform, log }),
    settings: () => notificationSettingsOf(core.config.user?.value),
    pausedUntil: () => pausedUntil,
    focused: windowFocused,
    now: () => core.clock.now(),
    wallNow: () => Date.now(),
    timers: realTimers,
    pendingAsks: (runId) => bridge.pendingAsks(runId),
    answer: (a) => bridge.answer(a),
    openRun: (runId) => openRoute(trayRoute({ kind: 'open-run', runId })),
    showWindow,
    toast: (t) =>
      push.emit({
        kind: 'toast',
        level: t.level,
        message: t.message,
        ...(t.skipInRunView !== undefined ? { skipInRunView: t.skipInRunView } : {}),
        ...(t.askRunId !== undefined ? { askRunId: t.askRunId } : {}),
      }),
    log,
  })
  const overlays = new Map<string, NativeImage>()
  const surfaces = new AttentionSurfaces({
    platform,
    focused: windowFocused,
    log,
    ops: {
      setOverlay: (icon, description) => {
        const w = liveWindow()
        if (w === null) return
        let img: NativeImage | null = null
        if (icon !== null) {
          img = overlays.get(icon) ?? nativeImage.createFromPath(join(trayIconDir(packaged), icon))
          overlays.set(icon, img)
        }
        w.setOverlayIcon(img, description)
      },
      flash: (on) => liveWindow()?.flashFrame(on),
      setBadge: (count) => void app.setBadgeCount(count),
    },
  })
  o.setNotify((n) => {
    // The tray, overlay and badge show what needs you no later than the notification that announces it: a run's
    // notify effect runs before core's `attention` event reaches main, and the tray is otherwise debounced (100 ms).
    // Core's attention already counts the new state here (the run's state is set before its effects run).
    const a = core.attention()
    runs.setAttention(a.needsYou, a.items)
    surfaces.update(a.needsYou, a.items)
    flushTray()
    try {
      const facts = bridge.facts(n)
      if (facts !== null) notifications.notify(facts)
    } catch (err) {
      log.warn('notification failed', { kind: n.kind, err })
    }
  })
  // A catalog refresh became due. The event toggle (off by default), the focus rule (an in-app toast while
  // focused) and the pause apply as for every notification; the consent card itself is the Dashboard's.
  o.setCatalogNotify(() => {
    try {
      notifications.notify({ kind: 'catalog' })
    } catch (err) {
      log.warn('notification failed', { kind: 'catalog', err })
    }
  })
  const activations = new ActivationQueue((args) => void notifications.activate(args))

  // ---- power (powerMonitor drives the timers; e2e.power takes the same path) ----
  const power = new PowerRouter({ apply: (state) => bridge.power(state), log })
  if (!o.smoke.enabled) installPowerMonitor(powerMonitor, power)
  // The factory's schedule waits for power on battery (unless the user allowed it): tell it which it is, and when it
  // changes. Never under E2E (the test machine's battery is not the test's).
  if (!o.smoke.enabled && !e2e) {
    const battery = (): void => {
      void core.factory?.setOnBattery(powerMonitor.isOnBatteryPower()).catch(() => undefined)
    }
    battery()
    powerMonitor.on('on-battery', battery)
    powerMonitor.on('on-ac', battery)
  }

  // User-file changes made outside the app (another editor): follow ui.theme / ui.accent.
  let configTimer: ReturnType<typeof setTimeout> | undefined
  const followUserConfig = (): void => {
    if (configTimer !== undefined) clearTimeout(configTimer)
    configTimer = setTimeout(() => {
      configTimer = undefined
      core.config
        .reloadUser()
        .then((load) => {
          if (load.value !== undefined) theme.follow(uiSettingsOf(load.value))
        })
        .catch((err: unknown) => log.warn('user config reload failed', { err }))
    }, 300)
  }
  core.bus.attach({
    name: 'main-state',
    global: (ev) => {
      if (ev.kind === 'run-summary') {
        if (runs.upsert(ev.summary)) scheduleTray()
      } else if (ev.kind === 'attention') {
        if (runs.setAttention(ev.needsYou, ev.items)) scheduleTray()
        surfaces.update(ev.needsYou, ev.items)
        notifications.attentionChanged()
      } else if (ev.kind === 'config-changed' && ev.scope === 'user') {
        followUserConfig()
      } else if (ev.kind === 'preview' && ev.session.endedAt !== undefined) {
        // A preview that ended takes its windows with it.
        previews.closeFor(ev.session.id)
      }
    },
  })
  void bootstrapRuns(core, runs)
    .then(() => {
      scheduleTray()
      const a = core.attention()
      surfaces.update(a.needsYou, a.items)
    })
    .catch((err: unknown) => log.warn('could not load the active runs', { err }))

  // ---- quit ----
  let stopHeartbeat: (() => void) | undefined
  const quitter = new QuitController({
    interruptible: () => runs.interruptibleRunIds(),
    requestConfirmation: (runIds) => {
      push.emit({ kind: 'app', state: 'quit-requested', activeRuns: runIds.length, runIds })
      showWindow()
    },
    beforeShutdown: () => {
      previews.closeAll()
      core.preview.attachPlaytester(null)
      stopHeartbeat?.()
      notifications.dispose()
      if (pauseTimer !== undefined) clearTimeout(pauseTimer)
      push.flush()
      tray?.dispose()
      tray = null
    },
    shutdown: () => core.shutdown(),
    exit: (code) => {
      perf.stop()
      app.exit(code)
    },
    log,
  })

  const setPause = (until: number | null): void => {
    appState
      .set({ notificationsPausedUntil: until })
      .catch((err: unknown) => log.warn('could not change the notification pause', { err }))
  }
  try {
    tray = createTray({
      iconDir: trayIconDir(packaged),
      onOpen: showWindow,
      // The composer is on the Dashboard, the window's home screen.
      onNewRun: () => openRoute(trayRoute({ kind: 'new-run' })),
      onOpenRun: (runId) => openRoute(trayRoute({ kind: 'open-run', runId })),
      onPauseNotifications: () => setPause(Date.now() + NOTIFICATION_PAUSE_MS),
      onResumeNotifications: () => setPause(null),
      onQuit: () => void quitter.request(false),
    })
  } catch (err) {
    log.warn('tray unavailable', { err })
  }
  installAppLifecycle({ quit: quitter, e2e, showWindow, log })

  // ---- renderer readiness, recovery notice, heartbeat, smoke ----
  let recoveryNoticePending = true
  const smoke = o.smoke.enabled
    ? new SmokeRun({
        verify: async () => {
          const r = await core.invoke('runs.list', {})
          if (!r.ok) return `${r.error.code} ${r.error.message}`
          // The self-heal template ships next to the bundled core (out/main/internal/heal.md); so does
          // the price refresh's (out/main/internal/catalog-refresh.md).
          try {
            readHealTemplate()
            readCatalogRefreshTemplate()
          } catch (err) {
            return errorMessage(err)
          }
          // The Diff tab's highlighter worker ships in the package and starts under the CSP.
          const page = liveWindow()?.webContents
          if (page === undefined) return 'the window is gone'
          return diffSelfCheck((script) => page.executeJavaScript(script) as Promise<unknown>)
        },
        report: () => ({
          version: app.getVersion(),
          electron: process.versions.electron ?? 'unknown',
          platform: process.platform,
          eventLoopP95Ms: perf.read().p95Ms,
        }),
        shutdown: async () => {
          tray?.dispose()
          tray = null
          await withinBudget(core.shutdown(), QUIT_BUDGET_MS)
        },
        print: (line) => printLine(line),
        exit: (code) => {
          perf.stop()
          app.exit(code)
        },
      })
    : null
  const rendererReady = (route: string | undefined): void => {
    log.info('renderer ready', route !== undefined ? { route: route.slice(0, 200) } : {})
    // Every page load (first, reload, crash reload) starts from what it fetched; attention and the theme are
    // push-only (sent on change), so a new page hears the current ones now. Its preload's theme is the boot one.
    const attention = core.attention()
    push.emit({ kind: 'attention', needsYou: attention.needsYou, items: attention.items })
    push.emit({ kind: 'theme', theme: theme.state })
    if (recoveryNoticePending) {
      recoveryNoticePending = false
      const notice = recoveredNotice(
        core.recovery.paused.map((p) => p.runId),
        runs.activeCount,
      )
      if (notice !== null) push.emit(notice)
    }
    // Heartbeats carry core's time (the renderer's countdowns run on it; E2E moves it with e2e.clock).
    stopHeartbeat ??= startHeartbeat({
      shouldBeat: () => liveWindow()?.isVisible() === true || runs.activeCount > 0,
      beat: (at) => push.emit({ kind: 'heartbeat', at }),
      now: () => core.clock.now(),
    })
    // Toast activations that launched the app (or came in while the page loaded) are answered now.
    activations.open()
    smoke?.rendererReady()
  }

  // ---- IPC (registered before the page loads) ----
  let gitP: Promise<AppInfo['git']> | undefined
  const pick = env[E2E_PICK_FOLDER_ENV]?.trim()
  const pickFiles = env[E2E_PICK_FILES_ENV]?.trim()
  const appInfo = (): Omit<AppInfo, 'git'> => ({
    name: app.getName(),
    version: app.getVersion(),
    platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
    },
    home: core.paths.home,
    logsDir: core.paths.logsDir,
    packaged,
    e2e,
    ipcProtocol: IPC_PROTOCOL,
    notifications: platform === 'win32' ? { aumid: shortcut.aumid, clsid: shortcut.clsid } : null,
  })
  const gitInfo = (): Promise<AppInfo['git']> =>
    (gitP ??= gitVersion()
      .then((v) => ({ path: gitSettings().executable, version: `${v.major}.${v.minor}.${v.patch}` }))
      .catch(() => {
        gitP = undefined
        return null
      }))
  // Settings → Diagnostics: the bundle (redacted for this machine), copied or saved.
  const diagPath = env[E2E_DIAGNOSTICS_PATH_ENV]?.trim()
  const diagnostics = createDiagnostics({
    core,
    appInfo: async () => ({ ...appInfo(), git: await gitInfo() }),
    now: () => Date.now(),
    redact: machineFacts(),
    writeClipboard: (text) => clipboard.writeText(text),
    chooseSavePath: async (defaultName) => {
      const w = liveWindow()
      const opts = {
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Text', extensions: ['txt'] }],
      }
      const r = w !== null ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || r.filePath === undefined || r.filePath === '' ? null : r.filePath
    },
    ...(e2e && diagPath !== undefined && diagPath !== '' ? { e2eSavePath: diagPath } : {}),
  })
  /** E2E: the last editor install link mcp.addToEditor would have opened. */
  let lastEditorUrl: string | null = null
  const handlers = createMainHandlers({
    core,
    appInfo,
    gitInfo,
    diagnostics,
    pickFolder: async (defaultPath) => {
      const w = liveWindow()
      const opts: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath !== undefined ? { defaultPath } : {}),
      }
      const r = w !== null ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    pickFiles: async (defaultPath) => {
      const w = liveWindow()
      const opts: OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        ...(defaultPath !== undefined ? { defaultPath } : {}),
      }
      const r = w !== null ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? [] : r.filePaths
    },
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (url) => shell.openExternal(url),
    theme,
    appState,
    setFocus: (ids) => push.setFocus(ids),
    rendererReady,
    requestQuit: (confirmed) => quitter.request(confirmed),
    e2eState: () =>
      buildE2EState({
        clock: core.clock,
        activeRuns: runs.activeCount,
        procs: liveProcs(core, runs.activeRunIds()),
        windowFocused: windowFocused(),
        tray: tray?.current ?? null,
        eventLoop: perf,
        notifications: recorder?.state() ?? [],
        extra: {
          attention: surfaces.current,
          notificationsPausedUntil: activePause(),
          focusSimulated: focus.simulated,
          power: power.state,
          mcpEditorUrl: lastEditorUrl,
          previewBrowserUrl: lastPreviewBrowserUrl,
        },
      }),
    ...(e2e && pick !== undefined && pick !== '' ? { e2ePickFolder: pick } : {}),
    ...(e2e && pickFiles !== undefined && pickFiles !== ''
      ? { e2ePickFiles: pickFiles.split(delimiter).filter((p) => p !== '') }
      : {}),
    // Outside agents: main builds the editor's MCP install link from the bridge command itself. E2E records it
    // instead of opening an editor on the developer's machine.
    mcp: {
      bridge: bridgeCommand({ execPath: process.execPath, packaged, appPath: app.getAppPath() }),
      ...(e2e ? { recordEditorLink: (url: string) => (lastEditorUrl = url) } : {}),
    },
    preview: {
      open: (sessionId, target) => previews.open(sessionId, target),
      openPair: (sessionIds, labels) => previews.openPair(sessionIds, labels),
      smoke: (sessionId) => previews.smoke(sessionId),
      savePdf: (sessionId) => previews.savePdf(sessionId),
      playtest: (sessionId) => previews.playtest(sessionId),
      tryIt: (sessionId) => previews.tryIt(sessionId),
      shareCheck: (sessionId) => previews.shareCheck(sessionId),
      phone: (sessionId, on) => previews.phone(sessionId, on),
    },
    notifications: {
      test: () => Promise.resolve(notifications.test()),
      repairShortcut: () => {
        shortcut = repairShortcut(shortcutRepair('manual'))
        return Promise.resolve(shortcut)
      },
    },
    ...(e2e
      ? {
          e2ePower: async (event: 'suspend' | 'resume') => {
            await power.handle(event, 'e2e')
          },
          e2eClock: async (advanceMs: number) => ({ now: await bridge.advanceClock(advanceMs) }),
        }
      : {}),
  })
  const router = createRouter({
    e2e,
    parse: (cmd: Cmd, raw: unknown) => parseRequest(cmd, raw),
    main: handlers,
    // The router has already checked the request against the command's schema. recovery.execute's copy / open
    // happens here in main, before the renderer hears the result (recovery-host.ts).
    core: withRecoveryHost(
      (cmd: Cmd, req: unknown) =>
        (core.invoke as (c: Cmd, r: unknown) => Promise<Result<unknown>>).call(core, cmd, req),
      {
        writeClipboard: (text) => clipboard.writeText(text),
        openExternal: (url) => shell.openExternal(url),
        log,
      },
    ),
    onFailure: (cmd, cid, error) => {
      if (error.code === 'INTERNAL') log.error('command failed', { cmd, cid, error })
      else if (error.code === 'FORBIDDEN') log.warn('command refused', { cmd, cid })
    },
  })
  registerCommandIpc({ getWindow: liveWindow, target, router })

  // ---- window ----
  const w = createMainWindow({
    preload: join(here, '../preload/index.cjs'),
    target,
    theme: theme.state,
    showImmediately: e2e,
    icon: windowIcon(trayIconDir(packaged), process.platform),
    // Windows: the taskbar shows the logo whether Dim Factory is installed or run from its folder (windowsAppDetails).
    appDetails:
      process.platform === 'win32'
        ? windowsAppDetails({
            appId: APP_ID,
            displayName: WINDOW_TITLE,
            exePath: process.execPath,
            packaged,
            iconFile: windowIcon(trayIconDir(packaged), process.platform),
          })
        : undefined,
    // E2E only: the developer's resting mouse never reaches a test window (Playwright's input still does).
    ignoreOsPointer: e2e,
    // E2E only: a spec's window size holds on a CI Mac whose display is smaller than it.
    largerThanScreen: e2e,
    log,
    onLoadFailed: (reason) => void smoke?.fail(`the renderer failed to load: ${reason}`),
  })
  win = w
  attachWindowLifecycle(w, { quit: quitter, closeToTray, platform: process.platform })
  installWindowKeys(w, { platform: process.platform, packaged, quit: () => void quitter.request(false) })
  // A window coming back from the tray or the taskbar hears from main at once, not up to 5 s later.
  const beatNow = (): void => {
    if (stopHeartbeat !== undefined) push.emit({ kind: 'heartbeat', at: core.clock.now() })
  }
  w.on('show', beatNow)
  w.on('restore', beatNow)
  // Taskbar overlay / Dock badge set before the window existed; the flash stops once the user is back.
  surfaces.reapply()
  w.on('focus', () => {
    if (windowFocused()) surfaces.focused()
  })
  // Windows: toast clicks and actions, live or from Action Center. Never registered for E2E or smoke runs (Electron
  // registers its COM activator then); the E2E global replays activations instead.
  if (!e2e && !o.smoke.enabled) installActivationHandler(platform, (args) => activations.push(args))
  // A new document of the app (reload, crash reload) focuses again itself; nothing queued is for it. Navigations
  // elsewhere (a dropped file) are blocked by the hardening and must leave the focus and the queue alone. This runs
  // before the new document exists, so it never drops anything the new page asked for.
  w.webContents.on('did-start-navigation', (ev) => {
    if (isAppDocumentLoad(ev, target)) push.resetForReload()
  })
  let crashes: number[] = []
  w.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    if (smoke !== null) {
      void smoke.fail(`the renderer process exited (${details.reason})`)
      return
    }
    if (quitter.quitting || details.reason === 'clean-exit') return
    const now = Date.now()
    crashes = [...crashes.filter((t) => now - t < 60_000), now]
    // Reload a crashed page, but not in a loop.
    if (crashes.length <= 3) w.webContents.reload()
  })
  app.on('second-instance', () => showWindow())

  if (e2e && recorder !== null) {
    installE2EGlobals({
      eventLoop: { read: () => perf.read(), reset: () => perf.reset() },
      notifications: {
        list: () => recorder.list(),
        act: (target, action) => recorder.act(target, action),
        activate: (args) => notifications.activate(args),
        clear: () => recorder.clear(),
      },
      focus: {
        simulate: (focused) => {
          focus.simulate(focused)
          if (windowFocused()) surfaces.focused()
        },
      },
      // Retention on demand (the schedule is off under E2E); the deletes it starts are awaited too.
      history: {
        retention: async (ro) => {
          const report = await core.history.retention(ro)
          await core.history.settled()
          return report
        },
      },
    })
  }

  // ---- background work ----
  if (smoke !== null) {
    void smoke.start()
    return
  }
  // First launch probes the vendor CLIs; every later launch probes them here (the launch probe). A smoke run skips
  // both (it checks the shell, not the vendors).
  const coreInvoke = (cmd: Cmd, req?: unknown): Promise<Result<unknown>> =>
    (core.invoke as (c: Cmd, r: unknown) => Promise<Result<unknown>>).call(core, cmd, req)
  core
    .firstLaunch()
    .then((r) => log.info('first launch', { status: r?.status ?? 'read-only' }))
    .catch((err: unknown) => log.warn('first launch failed', { err }))
    .then(() => probeUnprobedVendors(coreInvoke, log))
    .catch((err: unknown) => log.warn('launch probe failed', { err }))
}

/**
 * The active runs at boot and who needs the user (later changes arrive as bus events). Recovery's attention event
 * fired inside createCore, before main attached to the bus, so it is read from the core instead.
 */
async function bootstrapRuns(core: Core, runs: RunsModel): Promise<void> {
  const r = await core.invoke('runs.list', { status: [...ACTIVE_RUN_STATUSES], limit: 1000 })
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  runs.reset(r.value.items)
  const a = core.attention()
  runs.setAttention(a.needsYou, a.items)
}

/** `build/tray` in development, `<resources>/tray` when packaged: tray icons, taskbar overlays and the window icon. */
function trayIconDir(packaged: boolean): string {
  return packaged ? join(process.resourcesPath, 'tray') : join(app.getAppPath(), 'build', 'tray')
}
