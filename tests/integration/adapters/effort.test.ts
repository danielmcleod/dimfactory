// Claude with a pass effort that is not a plain level (`high --x`): the launch fails config_invalid before anything is
// spawned, as a managed flag in extraArgs does (the config schema never lets one through; this is the adapter's own
// guard).
import { beforeAll, describe, expect, it } from 'vitest'
import type { FakeSetup } from './helpers.ts'
import { drive, fakeAdapter, fakeSetup, tempDir, terminals } from './helpers.ts'

let setup: FakeSetup

beforeAll(async () => {
  setup = await fakeSetup()
})

describe('claude adapter: effort', () => {
  it.each(['high --x', 'High', '--dangerously-skip-permissions'])(
    'effort %j fails the pass before spawning (config_invalid)',
    async (effort) => {
      const adapter = fakeAdapter(setup)
      const { entries, handle } = await drive(
        adapter,
        {
          runId: 'r',
          step: 'implement',
          cwd: tempDir(),
          prompt: 'hi',
          mode: 'autoedit',
          planNative: false,
          allowRules: [],
          askTimeoutMs: 1000,
          trustFolder: false,
          effort,
        },
        new Map(),
      )
      expect(handle.pid).toBeUndefined()
      expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'config_invalid' }])
    },
  )
})
