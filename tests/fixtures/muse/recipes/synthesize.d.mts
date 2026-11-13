// Declarations for tests/fixtures/muse/recipes/synthesize.mjs (the Muse exec fixture generator).

export interface SynthesizedMuseScenario {
  id: string
  slug: string
  note: string
  pass: { mode: 'autoedit' | 'full'; prompt: string }
  /** The approval flag the adapter passes (default --disable-approval). */
  argvMode?: string
  exitCode?: number
}

export const SCENARIOS: readonly SynthesizedMuseScenario[]

/** Scenarios recorded live (`<ID>-<slug>`): their recipe is generated, their recording and expected events are not. */
export const LIVE: ReadonlySet<string>

/** Every file the generator owns: absolute path → content (LF). */
export function synthesize(): Map<string, string>

/** Files in the generator's folders that it does not write (absolute paths). */
export function strays(files?: Map<string, string>): string[]

/** Generated files whose committed content differs or that are missing, and stray files (absolute paths). */
export function outOfDate(files?: Map<string, string>): string[]
