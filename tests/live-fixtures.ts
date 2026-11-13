// The vendor fixtures' root. The published Claude and Codex fixtures are synthesized (scripts/synthesize-fixtures.mjs);
// the live recordings they were made from stay in tests/fixtures-private, which is never published. With
// DIM_FACTORY_LIVE_FIXTURES=1 and that folder present, the replay tests that walk every recording (the Claude
// normalizer's snapshots, the Codex adapter's replays) run on the live recordings and their own expected events instead.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PRIVATE = fileURLToPath(new URL('./fixtures-private/', import.meta.url))

/** Whether this run replays the live recordings (opt-in, local only). */
export const LIVE_FIXTURES = process.env['DIM_FACTORY_LIVE_FIXTURES'] === '1' && existsSync(PRIVATE)
/** tests/fixtures/, or tests/fixtures-private/ under DIM_FACTORY_LIVE_FIXTURES=1. */
export const FIXTURES_ROOT = LIVE_FIXTURES ? PRIVATE : fileURLToPath(new URL('./fixtures/', import.meta.url))
