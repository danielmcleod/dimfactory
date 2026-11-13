// Run & Preview: how a folder can be run (detected without tokens), the preview sessions Dim Factory started, and
// the smoke check of a preview's page. Types and constants only (the renderer imports them; no zod here).
import type { Finding } from './findings.ts'
import type { CheckResult } from './preflight.ts'
import type {
  BlockedRequest,
  GameCheck,
  GameMeasures,
  PlaytestReport,
  PreviewNetworkMode,
} from './playtest.ts'

/** Settings → Preview: where Open preview shows the page (`ask`: both buttons are offered). */
export const PREVIEW_OPEN_TARGETS = ['ask', 'app', 'browser'] as const
export type PreviewOpenTarget = (typeof PREVIEW_OPEN_TARGETS)[number]

/**
 * What running a command gives:
 * - `server`: a long-running process that prints a URL (a dev server, `docker compose up`, a notebook server);
 * - `static`: files Dim Factory serves itself with its read-only loopback server (nothing is spawned);
 * - `app`: a program that opens its own window (Electron), so there is no page to preview;
 * - `command`: a program that runs and prints (a CLI or a script); its output is the result.
 * - `document`: Markdown Dim Factory renders itself as a readable page (core/preview/document.ts), served read-only
 *   on loopback like `static` (nothing is spawned), with Save as PDF.
 */
export const PREVIEW_KINDS = ['server', 'static', 'app', 'command', 'document'] as const
export type PreviewKind = (typeof PREVIEW_KINDS)[number]

export const PREVIEW_SOURCES = [
  'package.json',
  'static',
  'python',
  'docker',
  'cargo',
  'go',
  'electron',
  'notebook',
  'pack',
  'document',
] as const
export type PreviewSource = (typeof PREVIEW_SOURCES)[number]

/** A preview command's trust: `none` for the static server and the document view (nothing runs). */
export type PreviewTrust = 'trusted' | 'untrusted' | 'changed' | 'none'

/** One way to run the folder. */
export interface PreviewCommand {
  /** Stable within a folder (`pkg:dev`, `static:docs`, `python:app.py`, `pack:documents:mkdocs`). */
  id: string
  /** As the user would type it (`pnpm run dev`), or `Serve index.html` for the static server. */
  label: string
  kind: PreviewKind
  source: PreviewSource
  /** The pack that adds it (source `pack`). */
  packId?: string
  /** No shell ever reads it. Empty for `static`. */
  argv: string[]
  /** Where it runs, relative to the scope root (`/` separators, `.` for the root). */
  cwdRel: string
  /** `static`: the folder served, relative to the run folder (`.` for the folder itself). */
  staticRoot?: string
  /** `document`: the Markdown file or folder of Markdown files shown, relative to the run folder (`/` separators). */
  docPath?: string
  /** Where the page is expected when the output may not say (a compose file's first published port). */
  urlHint?: string
  /** One line about it ("Opens its own window", "Needs Docker"). */
  note?: string
  trust: PreviewTrust
  /** The trust grant's hash (trust.set's `hash`), absent for `static` and commands trust cannot cover. */
  hash?: string
  /** Why it cannot run as detected (trust cannot cover what it runs). */
  error?: string
}

export const PREVIEW_STATUSES = ['starting', 'running', 'stopping', 'stopped', 'exited', 'failed'] as const
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number]

/** The most recent output lines a session view carries (the panel shows fewer). */
export const PREVIEW_TAIL_LINES = 200
/** A tail line longer than this is cut (the whole line stays in the log file). */
export const PREVIEW_LINE_MAX = 400

/** A preview Dim Factory started (a process, or its static server). */
export interface PreviewSessionView {
  id: string
  /** The folder it runs for (a run's folder, or its isolated copy). */
  folder: string
  /** The run whose panel started it; absent when started on demand. */
  runId?: string
  commandId: string
  label: string
  kind: PreviewKind
  status: PreviewStatus
  /** The page's loopback URL once known (parsed from the output, or the static server's). */
  url: string | null
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  /** Why it ended or failed, in words. */
  reason?: string
  /** The newest output lines (ANSI removed), at most PREVIEW_TAIL_LINES. */
  tail: string[]
  /** Output lines so far (the tail is the newest of them). */
  lines: number
  /** The whole output (capped like a verify log), for "Open log". */
  logPath?: string
  /**
   * A `docker compose` preview: Stop ends only the compose command, so the panel also offers "Stop containers too"
   * (`docker compose down` for the same compose files, run only when the user clicks it).
   */
  compose?: true
  /** That `docker compose down`, once asked for: running, done, or failed (with why, in words). */
  composeDown?: { status: 'running' | 'done' | 'failed'; reason?: string }
  /** A game's preview (its folder is a game: the Games category, a playtest.json or the starter's test hook). */
  game?: true
  /**
   * What its page may reach: `loopback` (this computer only: a game's default) or `internet` ("Allow internet for this
   * preview", and every other preview).
   */
  network?: PreviewNetworkMode
  /** Requests to other computers its pages made while loopback-only (blocked): how many, and the first hosts. */
  blocked?: { count: number; hosts: string[] }
  /** A game's preview window is at Phone size (390 by 844, touch emulation on). */
  phone?: true
}

/** At most this many blocked hosts are kept per preview. */
export const PREVIEW_BLOCKED_HOSTS_MAX = 20

/** One console error the smoke check saw. */
export interface SmokeConsoleError {
  message: string
  /** The script and line, when the page said. */
  source?: string
  line?: number
}

/** One request that failed while the page loaded. */
export interface SmokeFailedLoad {
  url: string
  /** `404`, `net::ERR_CONNECTION_REFUSED`… */
  error: string
}

/** The smoke check of a preview's page (no model): what the page logged and failed to load, and how it looked. */
export interface PreviewSmokeView {
  sessionId: string
  runId?: string
  at: number
  url: string
  /** The page loaded (its main document answered). */
  loaded: boolean
  consoleErrors: SmokeConsoleError[]
  failedLoads: SmokeFailedLoad[]
  /** A small JPEG of the page as a data: URL (the full PNG is `screenshotPath`). */
  thumbnail: string | null
  screenshotPath: string | null
  /** A run's smoke check: the console errors as `[should]` findings (source `preview`). */
  findings: Finding[]
  /** The check could not run (the page never answered, the window failed). */
  error?: string
  /** A game's built-in checks (canvas, loop, frames, seed, pause, hook, offline). */
  checks?: GameCheck[]
  measures?: GameMeasures
  /** A game's requests to other computers, blocked (no internet for game previews). */
  blocked?: BlockedRequest[]
  /** A game: a picture of a moment of play (the title screen is `screenshotPath`). */
  gameplayPath?: string | null
}

/** `preview.playtest`: the game's playtest.json played in the hidden play-test window. */
export interface PreviewPlaytestView {
  sessionId: string
  at: number
  /** What it saw; null when nothing was played (`problem` says why). */
  report: PlaytestReport | null
  /** There is no playtest.json, or it does not fit its format. */
  problem?: string
}

/** RUN.md as the panel shows it: the first PREVIEW_RUN_MD_MAX bytes. */
export const PREVIEW_RUN_MD_MAX = 32 * 1024

/** `preview.detect`: everything the Run it panel shows for a folder (or a run's folder). */
export interface PreviewInfo {
  folder: string
  scopeRoot: string
  /**
   * The folder whose trust grants apply (trust.set's `folder`): `folder` itself, or the run's folder for a run whose
   * changes are still in its isolated copy (`folder` is then the copy).
   */
  trustFolder: string
  runId?: string
  commands: PreviewCommand[]
  /** Non-blocking checks: a tool a command needs is not installed (never a failure). */
  checks: CheckResult[]
  /** The folder's RUN.md, when it has one. */
  runMd: { text: string; truncated: boolean } | null
  /** Previews started for this folder that are still listed (running, or ended in this session). */
  sessions: PreviewSessionView[]
  /** A run's last smoke check (kept with the run). */
  smoke: PreviewSmokeView | null
  /** Settings → Preview. */
  openIn: PreviewOpenTarget
}

/** The hosts a preview URL may name: loopback only. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * A loopback http(s) URL a preview may open, normalized (`0.0.0.0` and `[::]` read as 127.0.0.1), or null. No user
 * info, a port when given in range. Pure (both main and the renderer use it).
 */
export function previewUrlOf(raw: string, opts: { httpOnly?: boolean } = {}): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && (opts.httpOnly === true || u.protocol !== 'https:')) return null
  if (u.username !== '' || u.password !== '') return null
  const host = u.hostname.toLowerCase()
  if (host === '0.0.0.0' || host === '[::]') u.hostname = '127.0.0.1'
  else if (!LOOPBACK_HOSTS.includes(host)) return null
  return u.href
}

/** The origin a preview window may navigate within (scheme, host and port of its URL). */
export function previewOrigin(url: string): string | null {
  const ok = previewUrlOf(url)
  return ok === null ? null : new URL(ok).origin
}
