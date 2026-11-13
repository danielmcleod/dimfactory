// Declarations for scripts/redact-muse.mjs (the Muse fixture redaction).

export const REDACTED: '<REDACTED>'
export const MUSE_PROMPT_FILE: '<PROMPT_FILE>'
/** Inherited variables a Muse recording never takes from the recorder's env. */
export const MUSE_ENV_DROP: readonly string[]

/** The plugin and MCP rules on a plain text line (stderr). */
export function redactMuseText(text: string): string

/** The protocol rules on one parsed record: a redacted copy and the count of each rule that changed it. */
export function redactMuseValue(input: unknown): { value: unknown; counts: Record<string, number> }

/** What the isolated home folder (--muse-home) becomes in a recording. */
export const MUSE_HOME_PLACEHOLDER: '<MUSE_HOME>'

/** The variables that point Muse at the isolated home (the same keys on every OS). */
export function museHomeEnv(museHome: string): {
  HOME: string
  USERPROFILE: string
  XDG_CONFIG_HOME: string
  APPDATA: string
  LOCALAPPDATA: string
}

/** The terms the isolated profile's settings and AGENTS.md name (read in memory only). */
export function profileTerms(museHome: string): { literals: string[]; names: string[]; skipped: number }
