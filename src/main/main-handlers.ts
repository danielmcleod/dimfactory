// Commands main answers itself: app.info/ready/quit, dialog.pickFolder,
// shell.open, log.write, events.focus, state.get/set, ui.setTheme and e2e.state; notifications.* and e2e.power /
// e2e.clock, and diagnostics.* (diagnostics.ts), when their deps are given (the router answers UNSUPPORTED
// otherwise).
// Electron-free: every platform call is injected (index.ts passes dialog, shell, nativeTheme, the window).
import type { SharePageReport } from '../shared/share-check.ts'
import type { TryItReport } from '../shared/try-it.ts'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { Core } from '@core/app-core.ts'
import { configLocation } from '@core/config/backups.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { LogData } from '@core/log.ts'
import type {
  AppInfo,
  E2EState,
  LogLevel,
  McpBridgeCommand,
  NotificationShortcutStatus,
  NotificationTestResult,
  Req,
  ShellOpenRequest,
  ThemeState,
} from '@shared/ipc.ts'
import type { Accent, Theme } from '@shared/config-schema.ts'
import type { PreviewPlaytestView, PreviewSessionView, PreviewSmokeView } from '@shared/preview.ts'
import type { AppStateStore } from './app-state.ts'
import type { Diagnostics } from './diagnostics.ts'
import { LOG_WRITE_DATA_MAX, LOG_WRITE_MSG_MAX } from './constants.ts'
import type { QuitResult } from './quit.ts'
import type { MainHandlers } from './router.ts'
import { allowedExternalUrl } from './urls.ts'
import { editorInstallUrl } from './mcp-links.ts'

export interface MainHandlerDeps {
  core: Pick<Core, 'paths' | 'log'>
  /** Everything AppInfo needs except git. */
  appInfo: () => Omit<AppInfo, 'git'>
  /** `git --version` of the configured binary (cached; null when git is missing). */
  gitInfo: () => Promise<AppInfo['git']>
  /** The native folder picker (null when cancelled). */
  pickFolder: (defaultPath: string | undefined) => Promise<string | null>
  /** The native file picker, several files (empty when cancelled; absent: UNSUPPORTED). */
  pickFiles?: (defaultPath: string | undefined) => Promise<string[]>
  /** DIM_FACTORY_E2E_PICK_FILES under DIM_FACTORY_E2E=1: answer these paths without a dialog. */
  e2ePickFiles?: string[]
  /** shell.openPath: '' on success, else the error text. */
  openPath: (path: string) => Promise<string>
  /** shell.showItemInFolder (absent: the file's folder is opened instead). */
  showItemInFolder?: (path: string) => void
  openExternal: (url: string) => Promise<void>
  theme: { set(req: { theme?: Theme; accent?: Accent }): Promise<ThemeState> }
  appState: AppStateStore
  setFocus: (runIds: string[]) => void
  rendererReady: (route: string | undefined) => void
  requestQuit: (confirmed: boolean) => Promise<QuitResult>
  /** DIM_FACTORY_E2E=1 only (the router hides e2e.* otherwise). */
  e2eState: () => E2EState
  /** DIM_FACTORY_E2E_PICK_FOLDER under DIM_FACTORY_E2E=1: answer without a dialog. */
  e2ePickFolder?: string
  isDirectory?: (path: string) => Promise<boolean>
  /** notifications.test / notifications.repairShortcut (absent: the router answers UNSUPPORTED). */
  notifications?: {
    test(): Promise<NotificationTestResult>
    repairShortcut(): Promise<NotificationShortcutStatus>
  }
  /** DIM_FACTORY_E2E=1 only: e2e.power (the powerMonitor path) and e2e.clock (core clock advance → now). */
  e2ePower?: (event: 'suspend' | 'resume') => Promise<void>
  e2eClock?: (advanceMs: number) => Promise<{ now: number }>
  /** diagnostics.build / copy / save (absent: the router answers UNSUPPORTED). */
  diagnostics?: Diagnostics
  /**
   * mcp.addToEditor: the editor's install link, built here from the bridge command only (absent: the router answers
   * UNSUPPORTED). `recordEditorLink` (E2E): record the link instead of opening it.
   */
  mcp?: { bridge: McpBridgeCommand; recordEditorLink?: (url: string) => void }
  /** Run & Preview's preview window, Open in browser and the smoke check (preview.ts; absent: UNSUPPORTED). */
  preview?: {
    open(sessionId: string, target: 'app' | 'browser'): Promise<void>
    openPair(sessionIds: readonly [string, string], labels: readonly [string, string]): Promise<void>
    smoke(sessionId: string): Promise<PreviewSmokeView>
    savePdf(sessionId: string): Promise<{ path: string }>
    playtest(sessionId: string): Promise<PreviewPlaytestView>
    tryIt(sessionId: string): Promise<TryItReport>
    shareCheck(sessionId: string): Promise<SharePageReport>
    phone(sessionId: string, on: boolean): Promise<PreviewSessionView>
  }
}

const defaultIsDirectory = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

const defaultIsFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** Cap a renderer log message and its data (the logger also redacts and cuts strings). */
export function capLogWrite(msg: string, data: unknown): { msg: string; data?: LogData } {
  const m = msg.length > LOG_WRITE_MSG_MAX ? `${msg.slice(0, LOG_WRITE_MSG_MAX)}…` : msg
  if (data === undefined) return { msg: m }
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch {
    return { msg: m, data: { data: '[unserializable]' } }
  }
  if (json === undefined) return { msg: m }
  if (json.length > LOG_WRITE_DATA_MAX) {
    return {
      msg: m,
      data: { truncated: true, bytes: json.length, preview: json.slice(0, LOG_WRITE_DATA_MAX) },
    }
  }
  const wrapped = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { data }
  return { msg: m, data: wrapped as LogData }
}

/** Keys the log record itself owns; renderer data under these names would pass as another part's line. */
const RECORD_KEYS: ReadonlySet<string> = new Set(['ts', 'level', 'msg', 'part'])

/**
 * The renderer's (capped) data as it goes into the log record: keys the record owns (ts, level, msg, part) move
 * under `rendererData`, so every renderer line stays a part=renderer line with main's own time and level.
 */
export function rendererLogData(data: LogData | undefined): LogData | undefined {
  if (data === undefined) return undefined
  const entries = Object.entries(data)
  if (!entries.some(([k]) => RECORD_KEYS.has(k))) return data
  return {
    ...Object.fromEntries(entries.filter(([k]) => !RECORD_KEYS.has(k))),
    rendererData: Object.fromEntries(entries.filter(([k]) => RECORD_KEYS.has(k))),
  }
}

export type ShellTarget =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  /** A file to show selected in its folder (never opened or run). */
  | { kind: 'reveal'; path: string }

/** Where a shell.open request points; VALIDATION / NOT_FOUND otherwise. */
export async function resolveShellOpen(
  req: ShellOpenRequest,
  paths: Core['paths'],
  isDirectory: (p: string) => Promise<boolean>,
  isFile: (p: string) => Promise<boolean> = defaultIsFile,
): Promise<ShellTarget> {
  switch (req.target) {
    case 'runFolder':
    case 'rawLog':
    case 'worktree': {
      // paths.run / paths.worktree reject ids that are not a single safe path segment (VALIDATION).
      const run = paths.run(req.runId)
      if (!(await isDirectory(run.dir))) throw new DimFactoryError('NOT_FOUND', `Run ${req.runId} not found.`)
      if (req.target === 'rawLog' && (await isDirectory(run.rawDir)))
        return { kind: 'path', path: run.rawDir }
      if (req.target === 'worktree') {
        const wt = paths.worktree(req.runId)
        if (!(await isDirectory(wt))) throw new DimFactoryError('NOT_FOUND', 'This run has no worktree.')
        return { kind: 'path', path: wt }
      }
      return { kind: 'path', path: run.dir }
    }
    case 'folder':
      if (!isAbsolute(req.path) || !(await isDirectory(req.path))) {
        throw new DimFactoryError('VALIDATION', 'Only an existing folder can be opened.')
      }
      return { kind: 'path', path: req.path }
    case 'logs':
      return { kind: 'path', path: paths.logsDir }
    case 'home':
      return { kind: 'path', path: paths.home }
    case 'url': {
      const url = allowedExternalUrl(req.url)
      if (url === null)
        throw new DimFactoryError('VALIDATION', 'Only https links to known documentation sites open.')
      return { kind: 'url', url }
    }
    case 'configFile': {
      // Settings → Config file: the file config.read shows (the user's, or the one a project folder uses).
      const path =
        req.scope === 'user'
          ? paths.userConfig
          : (await configLocation('project', req.folder, { home: paths.home })).path
      if (!(await isFile(path)))
        throw new DimFactoryError('NOT_FOUND', 'This dimfactory.json does not exist yet.')
      return { kind: 'path', path }
    }
    case 'uploadFile': {
      // Only an existing .zip, and only shown in its folder: a path the renderer sends is never opened or run.
      if (!isAbsolute(req.path) || !/\.zip$/i.test(req.path))
        throw new DimFactoryError('VALIDATION', 'Only an upload file (a .zip) can be shown.')
      if (!(await isFile(req.path)))
        throw new DimFactoryError('NOT_FOUND', 'The upload file is not there any more.')
      return { kind: 'reveal', path: req.path }
    }
  }
}

export function createMainHandlers(d: MainHandlerDeps): MainHandlers {
  const isDirectory = d.isDirectory ?? defaultIsDirectory
  const rendererLog = d.core.log.child({ part: 'renderer' })
  const notifications = d.notifications
  const { e2ePower, e2eClock, diagnostics, mcp, preview } = d
  return {
    ...(preview !== undefined
      ? {
          // Only a session id comes from the renderer: the URL is core's, checked again here (loopback http only).
          'preview.open': (req: Req<'preview.open'>) => preview.open(req.sessionId, req.target),
          // Only two session ids and the labels for the title: both URLs are core's, checked again here like one.
          'preview.openPair': (req: Req<'preview.openPair'>) => preview.openPair(req.sessionIds, req.labels),
          'preview.smoke': (req: Req<'preview.smoke'>) => preview.smoke(req.sessionId),
          // Only a session id: main prints the document's own loopback page; core picks where the PDF goes.
          'preview.savePdf': (req: Req<'preview.savePdf'>) => preview.savePdf(req.sessionId),
          // Only a session id: core reads the folder's playtest.json; main plays it in its hidden play-test window.
          'preview.playtest': (req: Req<'preview.playtest'>) => preview.playtest(req.sessionId),
          // Only a session id: main walks the session's own page in its hidden window, with no internet.
          'preview.tryIt': (req: Req<'preview.tryIt'>) => preview.tryIt(req.sessionId),
          // Only a session id: main reads the session's own page at a phone's width in its hidden window, no internet.
          'preview.shareCheck': (req: Req<'preview.shareCheck'>) => preview.shareCheck(req.sessionId),
          // Only a session id and on or off: main sizes its own game preview window and emulates touch in it.
          'preview.phone': (req: Req<'preview.phone'>) => preview.phone(req.sessionId, req.phone),
        }
      : {}),
    ...(mcp !== undefined
      ? {
          'mcp.addToEditor': async (req: Req<'mcp.addToEditor'>) => {
            // A vscode: / cursor: link for Dim Factory's own bridge, never a URL the renderer sent.
            const url = editorInstallUrl(req.editor, mcp.bridge)
            if (mcp.recordEditorLink !== undefined) mcp.recordEditorLink(url)
            else await d.openExternal(url)
          },
        }
      : {}),
    ...(diagnostics !== undefined
      ? {
          'diagnostics.build': (req: Req<'diagnostics.build'>) => diagnostics.build(req),
          'diagnostics.copy': (req: Req<'diagnostics.copy'>) => diagnostics.copy(req),
          'diagnostics.save': (req: Req<'diagnostics.save'>) => diagnostics.save(req),
        }
      : {}),
    ...(notifications !== undefined
      ? {
          'notifications.test': () => notifications.test(),
          'notifications.repairShortcut': () => notifications.repairShortcut(),
        }
      : {}),
    ...(e2ePower !== undefined ? { 'e2e.power': (req: Req<'e2e.power'>) => e2ePower(req.event) } : {}),
    ...(e2eClock !== undefined ? { 'e2e.clock': (req: Req<'e2e.clock'>) => e2eClock(req.advanceMs) } : {}),
    'app.info': async () => ({ ...d.appInfo(), git: await d.gitInfo() }),
    'app.ready': (req) => {
      d.rendererReady(req.route)
      return Promise.resolve()
    },
    'app.quit': (req) => d.requestQuit(req.confirm),
    'dialog.pickFolder': async (req) => {
      if (d.e2ePickFolder !== undefined) return d.e2ePickFolder
      return d.pickFolder(req.defaultPath)
    },
    ...(d.pickFiles !== undefined || d.e2ePickFiles !== undefined
      ? {
          'dialog.pickFiles': async (req: Req<'dialog.pickFiles'>) => {
            if (d.e2ePickFiles !== undefined) return [...d.e2ePickFiles]
            return d.pickFiles !== undefined ? d.pickFiles(req.defaultPath) : []
          },
        }
      : {}),
    'shell.open': async (req) => {
      const t = await resolveShellOpen(req, d.core.paths, isDirectory)
      if (t.kind === 'url') {
        await d.openExternal(t.url)
        return
      }
      if (t.kind === 'reveal' && d.showItemInFolder !== undefined) {
        d.showItemInFolder(t.path)
        return
      }
      const err = await d.openPath(t.kind === 'reveal' ? dirname(t.path) : t.path)
      if (err !== '') {
        const what = req.target === 'configFile' ? 'The file' : 'The folder'
        throw new DimFactoryError('INTERNAL', `${what} could not be opened: ${err}`)
      }
    },
    'log.write': (req) => {
      const { msg, data } = capLogWrite(req.msg, req.data)
      const level: LogLevel = req.level
      rendererLog[level](msg, rendererLogData(data))
      return Promise.resolve()
    },
    'events.focus': (req) => {
      // The request schema bounds the list; a partial focus would silently break the renderer's stream.
      d.setFocus(req.runIds)
      return Promise.resolve()
    },
    'state.get': () => d.appState.get(),
    'state.set': (req) => d.appState.set(req),
    'ui.setTheme': (req) => d.theme.set(req),
    'e2e.state': () => Promise.resolve(d.e2eState()),
  }
}
