// Declarations for scripts/redact-grok.mjs (the Grok fixture redaction).

export const REDACTED: '<REDACTED>'
export const GROK_HOME_PLACEHOLDER: '<GROK_HOME>'
export const PROJECT_PLACEHOLDER: '<PROJECT>'

/** Files in the Grok home that are never opened (credentials and grants). */
export const NEVER_READ: readonly string[]

/** The session-folder rule on a plain text line (stderr). */
export function redactGrokText(text: string): string

/** The protocol rules on one parsed agent message: a redacted copy and the count of each rule that changed it. */
export function redactGrokValue(input: unknown): { value: unknown; counts: Record<string, number> }

/** One profile file as text; throws for a credential file; undefined when absent or unreadable. */
export function readProfileText(path: string): string | undefined

export interface GrokProfileTerms {
  /** Matched verbatim: MCP commands, args, URLs and env values, the OIDC and auth provider settings, AGENTS.md lines. */
  literals: string[]
  /** Matched as whole words in free text: MCP server names. */
  names: string[]
  /** Always 0 (TOML is read line by line). */
  skipped: number
}
/** The terms `<grokHome>/config.toml` and `AGENTS.md` name; read only, credential files never opened. */
export function profileTerms(grokHome: string): GrokProfileTerms
