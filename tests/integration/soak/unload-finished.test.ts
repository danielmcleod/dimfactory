// Soak (createCore `unloadFinishedAfterMs`): a finished run with nothing
// in flight leaves memory a while after its last change, as a run from an earlier launch is: its controller closed and
// dropped, its events.jsonl closed. Reads come from its files unchanged, and an action loads it again (Revert all after
// the run; its Undo after the run was unloaded once more). A run that has not finished stays loaded. Before, every run
// of a session stayed loaded until it was removed (about 0.7 MB of heap and an open file each in the soak).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexHangs } from '../../unit/balanced/engine/helpers.ts'
import { ScriptedCodex, World, settled, value } from '../balanced/engine/helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const UNLOAD_MS = 150

async function until(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`never: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const SPEC = {
  plan: [{ recording: 'C06-plan-native-host' }],
  implement: [
    {
      recording: 'C08a-session-id-implement',
      write: { path: 'src/version.ts', content: 'export const v = 1\n' },
    },
  ],
}

describe('finished runs leave memory (soak)', () => {
  it('unloads a completed run; reads come from its files; Revert all and its Undo load it again', async () => {
    const t = await w.boot(SPEC, new ScriptedCodex(codexHangs), {
      core: { unloadFinishedAfterMs: UNLOAD_MS },
    })
    const run = await w.start(t, { profile: 'claude-only', gates: { afterPlan: false } })
    const done = await run.c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    await run.c.settle(15_000)
    const loaded = value(await t.core.invoke('runs.get', { runId: run.runId }))

    // ---- unloaded: controller closed and gone, events.jsonl closed ----
    const gone = (): boolean => t.core.controller(run.runId) === undefined && !t.core.bus.isOpen(run.runId)
    await until(gone, 'the finished run unloaded')
    expect(run.c.closed).toBe(true)

    // ---- reads: the same snapshot, the same row, the whole event log ----
    const unloaded = value(await t.core.invoke('runs.get', { runId: run.runId }))
    expect(unloaded.summary).toEqual(loaded.summary)
    expect(unloaded.steps).toEqual(loaded.steps)
    expect(unloaded.lastSeq).toBe(loaded.lastSeq)
    const row = value(await t.core.invoke('runs.list', {})).items.find((s) => s.runId === run.runId)
    expect(row).toEqual(loaded.summary)
    const page = value(await t.core.invoke('runs.events', { runId: run.runId, sinceSeq: 0 }))
    expect(page.events.at(-1)?.seq).toBe(loaded.lastSeq)

    // ---- an action loads it again: Revert all of the run's change ----
    const file = join(t.folder, 'src', 'version.ts')
    expect(readFileSync(file, 'utf8')).toBe('export const v = 1\n')
    const reverted = value(await t.core.invoke('diff.revert', { runId: run.runId, paths: 'all' }))
    expect(reverted.deleted).toEqual(['src/version.ts'])
    expect(existsSync(file)).toBe(false)
    expect(t.core.controller(run.runId)).toBeDefined()

    // ---- idle again: unloaded again; the Undo it recorded survives in run.json and loads it once more ----
    await until(gone, 'the run unloaded after the revert')
    value(await t.core.invoke('diff.undoRevert', { runId: run.runId, undoToken: reverted.undoToken }))
    expect(readFileSync(file, 'utf8')).toBe('export const v = 1\n')
    await until(gone, 'the run unloaded after the undo')
  }, 240_000)

  it('keeps a run that has not finished loaded (waiting at the plan gate)', async () => {
    const t = await w.boot(SPEC, new ScriptedCodex(codexHangs), {
      core: { unloadFinishedAfterMs: UNLOAD_MS },
    })
    const run = await w.start(t, { profile: 'claude-only', gates: { afterPlan: true } })
    await run.c.waitFor((s) => s.cards.some((c) => c.view.kind === 'gate:afterPlan'), 120_000)
    await new Promise((r) => setTimeout(r, UNLOAD_MS * 6))
    expect(t.core.controller(run.runId)).toBe(run.c)
    expect(run.c.closed).toBe(false)
    expect(t.core.bus.isOpen(run.runId)).toBe(true)
  }, 240_000)
})
