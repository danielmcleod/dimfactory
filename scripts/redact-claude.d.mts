// Declarations for scripts/redact-claude.mjs (the Claude fixture redaction).

export const REDACTED: '<REDACTED>'
/** A plan window's reset time in a recording. */
export const QUOTA_RESETS_AT: 0
/** What an MCP tool's id (`mcp__<server>__<tool>`) becomes. */
export const MCP_TOOL_REDACTED: 'mcp__<REDACTED>'
/** The CLI's own subagents; any other listed name came from the user's profile or a plugin. */
export const BUILTIN_AGENTS: readonly string[]
/** The CLI's own output styles. */
export const BUILTIN_OUTPUT_STYLES: readonly string[]
/** Files in the Claude config folder that are never opened (the login and the account record). */
export const NEVER_READ: readonly string[]

export interface ClaudeRuleContext {
  /** The profile's own names, lower case: they also take a plain skill or command name in init's lists. */
  names?: ReadonlySet<string>
}
/** The protocol rules on one parsed CLI frame: a redacted copy and the count of each rule that changed it. */
export function redactClaudeValue(
  input: unknown,
  ctx?: ClaudeRuleContext,
): { value: unknown; counts: Record<string, number> }

/** One profile file as text; throws for a credential or account file; undefined when absent or unreadable. */
export function readProfileText(path: string): string | undefined

/** A name worth matching as a whole word in free text (8 characters or more, hyphenated or namespaced). */
export function proseName(name: string): boolean

export interface ClaudeProfileTerms {
  /**
   * Matched verbatim: hook and status-line commands, settings env values, CLAUDE.md lines, and each synced folder's
   * name (two account ids joined by `_`) with each of those ids on its own.
   */
  literals: string[]
  /** Skills, commands, subagents, output styles, plugins: exact in listings, whole words when {@link proseName}. */
  names: string[]
  /** Files that would not parse. */
  skipped: number
}
/** The terms a Claude config folder's own files name; read only, credential and account files never opened. */
export function profileTerms(configDir: string): ClaudeProfileTerms

/** The built-in command names (lower case) of an initialize reply or a commands_changed push; [] otherwise. */
export function builtinCommandNames(msg: unknown): string[]
