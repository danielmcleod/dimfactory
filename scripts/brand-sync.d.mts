// Declarations for scripts/brand-sync.mjs (writes src/shared/brand.ts's names into the files that cannot import it).

export interface LineRule {
  /** Matches exactly one line of the file. */
  re: RegExp
  /** What that line becomes. */
  line: string
}
export const LINE_RULES: Readonly<Record<string, readonly LineRule[]>>
export const SYNCED_FILES: readonly string[]
/** package.json's brand fields (name, productName, author, desktopName, bin). */
export function packageFields(): Record<string, unknown>
/** One file's text in sync with the brand; throws when a rule's line is missing or ambiguous. */
export function syncText(file: string, text: string): { text: string; changed: boolean }
/** The command line; returns the exit code (0 in sync or written, 1 out of sync with --check, 2 error). */
export function main(
  argv: readonly string[],
  o?: { root?: string; log?: (line: string) => void; err?: (line: string) => void },
): number
