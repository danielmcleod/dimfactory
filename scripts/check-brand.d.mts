// Declarations for scripts/check-brand.mjs (the former product name stays only where its allowlist says why).
import type { CheckedFile } from './tree-files.mjs'

/** The private notes (planning and research kept on main, never published). */
export const PRIVATE_NOTES: readonly string[]

/** The former name, any case (global). */
export const FORMER_NAME: RegExp

/** Whether a recording's text is a live one (its header does not say `"synthesized": true`). */
export function isLiveRecording(text: string): boolean

export interface AllowEntry {
  id: string
  /** A repo path: a file, or a folder and everything in it (trailing `/`). */
  path?: string
  /** A family of files. */
  test?: (path: string) => boolean
  /** Only the lines it matches. */
  line?: RegExp
  /** Only a live recording's text. */
  live?: boolean
  /** Only a match whose surrounding words are in the sibling live recording. */
  echo?: boolean
  why: string
}
export const ALLOWLIST: readonly AllowEntry[]

export interface BrandFinding {
  path: string
  /** 1-based; 0 for a path that names it. */
  line: number
  /** 1-based; 0 for a path. */
  col: number
  text: string
}
export function checkFiles(
  files: Iterable<CheckedFile>,
  o?: { readSibling?: (path: string) => string | undefined },
): { scanned: number; findings: BrandFinding[] }

/** The command line; returns the exit code (0 clean, 1 found, 2 usage or git error). */
export function main(
  argv: readonly string[],
  o?: { root?: string; log?: (line: string) => void; err?: (line: string) => void },
): number
