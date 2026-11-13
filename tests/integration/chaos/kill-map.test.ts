// Chaos (kill at each effect boundary): the map behind the kill-*.test.ts cases. The child
// Dim Factory drives each of the suite's runs to its end with DIM_FACTORY_E2E_CHAOS_TRACE set (no kill), listing every
// point it reaches (src/core/chaos.ts). Every controller effect kind, user command and named inner point those runs
// reach has a kill case in one of the kill files, except the effects that only touch this process's memory (a timer,
// the live count) or rewrite run.json with nothing new to recover (persist, atomic like every home write; each kill
// case also plants the temp file a cut write leaves). A new effect kind, command or point fails this test until a
// kill case covers it. And the runs reach every effect boundary: spawn, snapshot, reconcile, revert, branch,
// verify, apply, finalize, a card's answer, a patch write and an index write.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildAction } from './fixtures/core-child.ts'
import type { ScenarioSpec } from '../run/scenario.ts'
import {
  ANSWER_RUN,
  ASK_SPEC,
  Chaos,
  FULL_RUN,
  FULL_SPEC,
  ISO_APPLY_RUN,
  ISO_DISCARD_RUN,
  ISO_SPEC,
  PATCH_RUN,
  PATCH_SPEC,
  STOP_RUN,
} from './helpers.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Effects with no kill case, and why none is needed. */
const NO_KILL_CASE: Record<string, string> = {
  'effect:timer': "arms a timer in this process's memory; a relaunch loads every timer disarmed",
  'effect:clearTimer': "clears a timer in this process's memory",
  'effect:liveCount': "the tray's live count, in this process's memory",
  'effect:persist':
    'run.json again with nothing a relaunch acts on (the transition before it was written ahead)',
}

/**
 * Points named by what they carry, one family each: the index lines differ only in the status they write (the suite
 * kills right after the completion's, `index:appended:completed`).
 */
const FAMILIES = ['index:appended:']

const RUNS: [string, ScenarioSpec, { overrides: Record<string, unknown>; actions: ChildAction[] }][] = [
  ['in place, full', FULL_SPEC, FULL_RUN],
  ['isolated, applied and undone', ISO_SPEC, ISO_APPLY_RUN],
  ['isolated, discarded', ISO_SPEC, ISO_DISCARD_RUN],
  ['a recovery patch', PATCH_SPEC, PATCH_RUN],
  ['two asks allowed', ASK_SPEC, ANSWER_RUN],
  ['stopped during an ask', ASK_SPEC, STOP_RUN],
]

/** The point names the kill files kill at (`'<point>#<n>'` literals). */
function killedPoints(): Set<string> {
  const out = new Set<string>()
  for (const f of readdirSync(HERE).filter(
    (n) => /^kill-.*\.test\.ts$/.test(n) && n !== 'kill-map.test.ts',
  )) {
    for (const m of readFileSync(join(HERE, f), 'utf8').matchAll(/'([a-z][a-z0-9-]*:[A-Za-z0-9:_-]+)#\d+'/g))
      out.add(m[1] as string)
  }
  return out
}

describe('chaos: every boundary the runs reach has a kill case', () => {
  it('traces the suite runs and finds each effect, command and inner point killed somewhere', async () => {
    const traced = await Promise.all(
      RUNS.map(async ([name, spec, plan]) => {
        const w = await chaos.world(spec, { trustCheck: true })
        const trace = join(w.sc.dir, 'trace.txt')
        const k = await chaos.child(w, plan, { trace })
        expect(k.done, `${name}: ${k.out}`).toBe(true)
        return readFileSync(trace, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      }),
    )
    const reached = new Set(traced.flat())
    // The effect boundaries the chaos suite must reach, reached by these runs.
    for (const p of [
      'effect:spawn',
      'effect:snapshot',
      'effect:reconcile',
      'effect:revert',
      'effect:branch',
      'effect:verify',
      'effect:apply',
      'effect:finalizePreview',
      'effect:undoApply',
      'effect:removeWorktree',
      'command:card',
      'effect:apply-patch',
      'effect:index',
      'index:appended:completed',
    ])
      expect(reached, p).toContain(p)
    const killed = killedPoints()
    const uncovered = [...reached]
      .filter((p) => !p.startsWith('event:') && !(p in NO_KILL_CASE) && !killed.has(p))
      .filter((p) => !FAMILIES.some((f) => p.startsWith(f) && [...killed].some((k) => k.startsWith(f))))
      .sort()
    expect(uncovered, 'points reached with no kill case').toEqual([])
  }, 300_000)
})
