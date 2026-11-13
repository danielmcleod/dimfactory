// Declarations for scripts/redact-gemini.mjs (the Gemini fixture redaction).

export const REDACTED: '<REDACTED>'
export const GEMINI_HOME_PLACEHOLDER: '<GEMINI_CLI_HOME>'
export const PROJECT_PLACEHOLDER: '<PROJECT>'

/** Files under `.gemini` that are never opened (credentials, the account's identity). */
export const NEVER_READ: readonly string[]

/** The project rule on a plain text line (stderr). */
export function redactGeminiText(text: string): string

/** The protocol rules on one parsed agent message: a redacted copy and the count of each rule that changed it. */
export function redactGeminiValue(input: unknown): { value: unknown; counts: Record<string, number> }

/** One profile file as text; throws for a credential file; undefined when absent or unreadable. */
export function readProfileText(path: string): string | undefined

/** JSON with comments and trailing commas; undefined when it cannot be read. */
export function parseJsonc(text: string): unknown

export interface GeminiProfileTerms {
  /** Matched verbatim: MCP commands, args, URLs and env values, GEMINI.md lines, the install's ids. */
  literals: string[]
  /** Matched as whole words in free text: MCP server, extension and custom command names. */
  names: string[]
  /** JSON files that could not be read. */
  skipped: number
}
/** The terms `<geminiCliHome>/.gemini` names; read only, credential files never opened. */
export function profileTerms(geminiCliHome: string): GeminiProfileTerms
