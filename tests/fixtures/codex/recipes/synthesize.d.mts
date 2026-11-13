// Declarations for tests/fixtures/codex/recipes/synthesize.mjs (the Codex fixture generator).

export interface SynthesizedScenario {
  id: string
  slug: string
  route: 'app-server' | 'exec'
  pass: Record<string, unknown>
  note?: string
  argv?: string[]
  expected: Record<string, unknown>[]
}

export const SCENARIOS: readonly SynthesizedScenario[]

/** Every file the generator owns: absolute path → content (LF). */
export function synthesize(): Map<string, string>

/** Generated files whose committed content differs, or that are missing (absolute paths). */
export function outOfDate(files?: Map<string, string>): string[]
