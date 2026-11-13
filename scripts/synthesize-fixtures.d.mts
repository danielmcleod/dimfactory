// Declarations for scripts/synthesize-fixtures.mjs (live recordings → synthesized fixtures).

export const PRIVATE_DIR: string
export const PUBLIC_DIR: string
/** The marker every generated id carries. */
export const FAKE_MARK: 'fa4e'
/** recordedAt of every synthesized recording. */
export const BASE_TIME: string
export const SYNTH_NOTE: string

/** A fake UUID for an id (same shape and case; a fake maps to itself). */
export function fakeUuid(id: string): string
/** A fake of an id's body: same length and alphabet, starting with the fake marker. */
export function fakeToken(body: string, kind?: string): string
/** Every id-shaped string in a text → its fake. */
export function fakeIdsInText(text: string, extra?: ReadonlyMap<string, string>): string
/** A fake word for a run of letters: same length and case pattern. */
export function fakeWord(run: string): string
/** Whether a whitespace-free token is code (kept by fakeProse). */
export function isCodeLike(token: string): boolean
/** Model text → synthetic text of the same length: prose words faked, code tokens and whitespace kept. */
export function fakeProse(text: string): string
/** A tool input or structured output: keys kept, string values faked. */
export function fakeInput<T>(value: T, key?: string): T
/** A JSON text's string values rewritten in place (keys, numbers and layout kept). */
export function rewriteJsonText(
  text: string,
  leaf: (value: string, key: string | undefined) => string,
): string
/** One live recording's text → its synthetic text. */
export function synthesizeRecording(text: string): string
export function synthesizeAuthStatus(text: string): string
export function synthesizePass(text: string): string
export function synthesizeScript(text: string, recordingFull: boolean): string
export interface SynthJob {
  src: string
  target: string
  kind: 'recording' | 'script' | 'auth' | 'pass' | 'ids'
}
export function plan(o?: { from?: string; to?: string; only?: string[] }): SynthJob[]
/** The command line; returns the exit code. */
export function run(argv: readonly string[]): number
