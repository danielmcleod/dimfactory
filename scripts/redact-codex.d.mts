// Declarations for scripts/redact-codex.mjs (the Codex fixture redaction).

export const REDACTED: '<REDACTED>'
/** A quota window's length and reset time in a recording. */
export const QUOTA_WINDOW_MINS: 0
export const QUOTA_RESETS_AT: 0

/** The userAgent without the machine (OS build, architecture, terminal); a value with no space is left alone. */
export function redactUserAgent(ua: string): string

/** The protocol rules on one parsed server message: a redacted copy and the count of each rule that changed it. */
export function redactCodexValue(input: unknown): { value: unknown; counts: Record<string, number> }

export interface TomlEntry {
  path: string[]
  /** The string value; null for a table header, an inline table or a non-string scalar. */
  value: string | null
}
/** Every key path of a TOML document with its string value; `skipped` counts statements it could not read. */
export function tomlStrings(text: string): { entries: TomlEntry[]; skipped: number }

/** Lines of instructions text worth matching verbatim (markers off, 24 characters or more). */
export function instructionLines(text: string): string[]

export interface ProfileTerms {
  /** Matched verbatim: MCP commands, args, URLs and env values, trusted folders, instruction lines. */
  literals: string[]
  /** Matched as whole words in free text: MCP server names (4 characters or more). */
  names: string[]
  /** Config statements the scanner could not read. */
  skipped: number
}
/** The terms a Codex profile's own files name (config.toml, AGENTS.md, the instructions file); read only. */
export function profileTerms(codexHome: string): ProfileTerms

export interface WordMatcher {
  re: RegExp
  replacement: string
}
export function wordMatchers(names: readonly string[], replacement?: string): WordMatcher[]

/** `matchers` in free text: a text line, or the string values of a parsed message that read as prose. */
export function redactTerms<T>(value: T, matchers: readonly WordMatcher[]): { value: T; count: number }
