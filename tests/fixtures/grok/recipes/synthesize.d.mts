// Declarations for tests/fixtures/grok/recipes/synthesize.mjs (the Grok ACP fixture generator).

export interface SynthesizedScenario {
  id: string
  slug: string
  pass: Record<string, unknown>
  note: string
  argv?: string[]
  expected: Record<string, unknown>[] | (() => Record<string, unknown>[])
}

export const SCENARIOS: readonly SynthesizedScenario[]

/** Grok's optionPrefs (no allow-session option; options that widen the session refused by name). */
export const GROK_PREFS: {
  readonly allowSession: readonly string[]
  readonly forbidden: readonly string[]
  readonly forbiddenName: RegExp
}

/** Scenarios recorded live (`<ID>-<slug>`): their recipe is generated, their recording and expected events are not. */
export const LIVE: ReadonlySet<string>

/** Every file the generator owns: absolute path → content (LF). */
export function synthesize(): Map<string, string>

/** Files in the generator's folders that it does not write (absolute paths). */
export function strays(files?: Map<string, string>): string[]

/** Generated files whose committed content differs or that are missing, and stray files (absolute paths). */
export function outOfDate(files?: Map<string, string>): string[]
