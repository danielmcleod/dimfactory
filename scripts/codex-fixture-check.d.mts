// Declarations for scripts/codex-fixture-check.mjs (the Codex fixture suites).

/** The committed schema bundle (protocol/v0.160.0/schema/codex_app_server_protocol.schemas.json). */
export const COMMITTED_BUNDLE: string
/** tests/fixtures/codex */
export const FIXTURES: string

/** Problems of `value` against `schema` (a JSON Schema node; `{ $ref }` into `bundle`), as `<path>: <reason>`. */
export function validate(
  bundle: unknown,
  schema: unknown,
  value: unknown,
  path?: string,
  depth?: number,
): string[]
export function resolveRef(bundle: unknown, ref: string): unknown
/** `#/definitions/<name>` or `#/definitions/v2/<name>`; undefined when the bundle has no such definition. */
export function definitionRef(bundle: unknown, name: string): string | undefined

export interface TypedFrame {
  /** 1-based line number in the recording. */
  index: number
  dir: 'in' | 'out'
  kind?: 'request' | 'notification' | 'response' | 'error'
  method?: string | undefined
  msg?: Record<string, unknown>
  /** Schema definition the value must satisfy; null = not typed by protocol.ts; undefined = unknown id. */
  def?: string | null | undefined
  value?: unknown
  problem?: string
}

export function typedFrames(text: string): { header: Record<string, unknown>; frames: TypedFrame[] }
/** Every schema problem of one JSON-RPC recording (empty = every frame is valid). */
export function checkRecording(bundle: unknown, text: string): string[]
/** The JSON-RPC recordings (header protocol jsonrpc) under `dir`, sorted. */
export function jsonRpcRecordings(dir: string): string[]
