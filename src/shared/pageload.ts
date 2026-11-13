// Dim Factory's own "page loads without console errors" check, a Verify command like the game play-test: it is never
// spawned. Its argv names the page (relative to the command's folder): `dimf:pageload dist/index.html` opens a React
// site's build, `dimf:pageload index.html` a plain page. The app opens it in a hidden, sandboxed preview with no
// internet and reports what went wrong while it loaded.
import type { BlockedRequest } from './playtest.ts'
import { isPlaytestArgv } from './playtest.ts'
import type { SmokeConsoleError, SmokeFailedLoad } from './preview.ts'

export const PAGELOAD_COMMAND_NAME = 'Page loads (Dim Factory)'
/** Its program: a name no program has, so it is never looked up on PATH or spawned. */
export const PAGELOAD_PROGRAM = 'dimf:pageload'

/** The argv that checks one page (relative to the command's folder, `/` separators). */
export function pageloadArgv(page: string): string[] {
  return [PAGELOAD_PROGRAM, page]
}

/** Whether an argv is the built-in page-load check (its first word, exactly). */
export function isPageloadArgv(argv: readonly string[]): boolean {
  return argv[0] === PAGELOAD_PROGRAM
}

/** Whether an argv is one of Dim Factory's own checks (never spawned, needs no trust). */
export function isBuiltinCheckArgv(argv: readonly string[]): boolean {
  return isPlaytestArgv(argv) || isPageloadArgv(argv)
}

/** What loading the page showed. */
export interface PageloadReport {
  url: string
  loaded: boolean
  consoleErrors: SmokeConsoleError[]
  failedLoads: SmokeFailedLoad[]
  /** Requests to other computers, blocked (the check has no internet). */
  blocked: BlockedRequest[]
  durationMs: number
  /** Why it could not load the page (UI copy). */
  error?: string
}
