// What a phrase reads like in the synthesized fixtures. The Claude and Codex fixtures made from live recordings
// replace every prose word the model wrote (and every tool output) with a fake word of the same length, keeping code
// tokens (scripts/synthesize-fixtures.mjs). A test that checks such text names the original phrase through `synth`, so
// it says what it means and still matches the fixture exactly.
import { fakeProse } from '../scripts/synthesize-fixtures.mjs'

/** `phrase` as the synthesized fixtures carry it. */
export const synth = (phrase: string): string => fakeProse(phrase)

/** A RegExp that matches `phrase` as the synthesized fixtures carry it, literally. */
export const synthRe = (phrase: string): RegExp =>
  new RegExp(synth(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
