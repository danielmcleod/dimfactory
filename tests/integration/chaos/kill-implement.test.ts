// Chaos (kill at each effect boundary; "Crash relaunch", state-machine rows P24, R5, R6, R7; the branch prep
// write-ahead; verify rounds): the child Dim Factory is killed at each effect boundary from the plan gate's
// answer to the end of verify:1 (the pre-Implement reconcile, the run branch, S0, Implement, S1, the verify round),
// then relaunched on the same home and checked as helpers.ts verifyRelaunch says.
import { afterEach, describe, expect, it } from 'vitest'
import {
  Chaos,
  FULL_RUN,
  FULL_SPEC,
  folderVersion,
  runDoc,
  settled,
  value,
  verifyRelaunch,
  version,
} from './helpers.ts'
import type { KillExpect } from './helpers.ts'
import { git, passArgvs } from '../run/scenario.ts'

const chaos = new Chaos()
afterEach(async () => chaos.dispose())

const CASES: [string, string, KillExpect][] = [
  ['the pre-Implement reconcile (R5)', 'effect:reconcile#1', { paused: ['implement'] }],
  ['the run branch', 'effect:branch#1', { paused: ['implement'] }],
  ['the run branch recorded, its ref not yet written', 'branch:intent#1', { paused: ['implement'] }],
  ['the run branch made, not yet recorded', 'event:branch-result#1', { paused: ['implement'] }],
  ['the S0 snapshot', 'effect:snapshot#3', { paused: ['implement'] }],
  ["Implement's spawn", 'effect:spawn#2', { paused: ['implement'] }],
  ["Implement's process up and recorded", 'spawn:recorded#2', { paused: ['implement'] }],
  ["Implement's answer arrived, not yet reduced", 'event:adapter:done#2', { paused: ['implement'] }],
  ['the S1 snapshot', 'effect:snapshot#4', { paused: ['verify:1'] }],
  ['the S1 snapshot taken, not yet recorded', 'event:snapshot-done#4', { paused: ['verify:1'] }],
  ["verify:1's trust check", 'effect:verifyCheck#1', { paused: ['verify:1'] }],
  ['verify:1 starting', 'effect:verify#1', { paused: ['verify:1'] }],
  ['the verify command up, not yet in procs.json', 'verify:spawned#1', { paused: ['verify:1'] }],
  ['the verify command up and recorded', 'verify:recorded#1', { paused: ['verify:1'] }],
  ['verify:1 done, its result not yet reduced', 'event:verify-result#1', { paused: ['verify:1'] }],
]

/** The run branches in the folder's repository. */
const runBranches = (folder: string): string[] =>
  git(folder, 'branch', '--list', 'dim/*', '--format=%(refname:short)')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

describe('chaos: kill from the plan gate to the end of verify:1, then relaunch', () => {
  for (const [what, point, want] of CASES) {
    it(`${what} (${point})`, async () => {
      const w = await chaos.world(FULL_SPEC, { trustCheck: true })
      const k = await chaos.child(w, FULL_RUN, { kill: point })
      const r = await verifyRelaunch(chaos, w, k, point, want)
      // At most one run branch, whatever moment the kill hit (R5 write-ahead: an intent is settled, never doubled).
      expect(runBranches(w.folder).length).toBeLessThanOrEqual(1)
      if (r.snap.branch !== undefined) expect(runBranches(w.folder)).toEqual([r.snap.branch.name])
    }, 180_000)
  }

  it('Resume after a kill with Implement running resumes its session and finishes the run', async () => {
    const w = await chaos.world(
      {
        ...FULL_SPEC,
        resume: [
          { recording: 'C08b-resume-fix', write: version('0.1.0'), text: 'Done.' },
          { recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F1 fixed' },
        ],
      },
      { trustCheck: true },
    )
    // Implement's session started (its init named it): the transcript exists, so Resume resumes it (P19).
    const point = 'event:adapter:session#2'
    const k = await chaos.child(w, FULL_RUN, { kill: point })
    const { core, runId } = await verifyRelaunch(chaos, w, k, point, { paused: ['implement'] })
    const sid = runDoc(w.home, runId).state.steps.implement.sessionId
    expect(sid).toBeDefined()
    value(await core.invoke('runs.resume', { runId }))
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const end = await c.waitFor(settled, 180_000)
    expect(end).toMatchObject({ status: 'completed', outcome: 'fixed' })
    // Implement went on in the session run.json recorded before the kill (the fake replays its recording's own id,
    // which Fix then reuses).
    expect(passArgvs(w.sc.entries()).filter((a) => a.includes(`--resume=${sid}`))).toHaveLength(1)
    expect(end.steps.fix.sessionNote).toBe('reused the Implement session')
    expect(folderVersion(w.folder)).toContain('1.0.0')
    // One run branch, the one the run recorded.
    expect(runBranches(w.folder)).toEqual([end.branch?.name])
  }, 300_000)
})
