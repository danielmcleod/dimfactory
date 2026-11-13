// Declarations for scripts/check-fixtures.mjs (every published fixture is synthesized and carries no account data).

export const FIXTURES_PREFIX: 'tests/fixtures/'
export const PRIVATE_PREFIX: 'tests/fixtures-private/'

export interface FixtureFinding {
  path: string
  line: number
  kind: string
}
export interface FixtureCheck {
  findings: FixtureFinding[]
  scanned: number
  /** Whether live text was compared (the live recordings were there). */
  realText: boolean
}
/** A text's 8-token runs that hold a prose word, lower case. */
export function shingles(text: string, n?: number): string[]
/** The 8-word runs of model text in the live recordings (empty when the folder is absent). */
export function realTextShingles(privateDir?: string): Set<string>
export function checkFixtureFiles(
  files: Iterable<{ path: string; text: string | undefined }>,
  o?: { realShingles?: ReadonlySet<string>; publish?: boolean },
): FixtureCheck
/** The command line; returns the exit code. */
export function run(argv: readonly string[]): number
