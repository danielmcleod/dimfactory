// The post-compaction reminder over ACP: there is no way to add it to a session there, so a pass that asks for it
// reports it as not supported once the agent says it compacted (G11's compaction_update), and sends nothing more
// (the fake deep-compares every host frame).
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import {
  acpScenario,
  drive,
  expectNoMismatch,
  fakeGemini,
  fakeSetup,
  loadFixture,
  signalsOf,
  tempDir,
} from './helpers.ts'

describe('ACP: the post-compaction reminder', () => {
  it('G11: a compaction with the reminder asked for is reported as not supported, nothing is sent', async () => {
    const f = loadFixture('G11-compaction-update')
    const p = (f.header.pass ?? {}) as {
      step?: StartOptions['step']
      mode?: StartOptions['mode']
      prompt?: string
    }
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(f.recording), { vendorEnv: { FAKE_CLI_OUT_CWD: '1' } })
    let asked = 0
    const o: StartOptions = {
      runId: 'run-replay',
      step: p.step ?? 'implement',
      cwd: tempDir('gemini-reminder-'),
      prompt: p.prompt ?? '',
      mode: p.mode ?? 'autoedit',
      planNative: false,
      allowRules: [],
      askTimeoutMs: 600_000,
      trustFolder: false,
      compactionReminder: () => {
        asked += 1
        return Promise.resolve('reminder')
      },
    }
    const d = await drive(fake.adapter, o, [])
    expectNoMismatch(fake.logEntries())
    const signals = signalsOf(d.entries)
    expect(signals.some((s) => s.type === 'compaction' && s.phase === 'end')).toBe(true)
    expect(signals.filter((s) => s.type === 'meta' && s.key === 'compactionReminder')).toEqual([
      { type: 'meta', key: 'compactionReminder', value: { unsupported: true } },
    ])
    expect(asked).toBe(0)
  }, 60_000)
})
