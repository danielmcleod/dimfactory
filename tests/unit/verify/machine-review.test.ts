// Verify review fixes in the reducer (R11 "verify:2 … pass: completed(fixed)" and the runner-step
// note). R11: only a pass is evidence. A command that failed in verify:1 and did not run and pass in verify:2
// (Auto skipping a script Fix changed, Skip verify after an environment failure, the user's Skip) leaves its [must]
// open: completed(findings-open) with a note naming it, never `fixed`. Runner steps: a round that stops being live
// (Stop, quit, relaunch) settles its running and queued rows, so none keeps reading "Running" with a spinner.
// Nothing moves on its own: a round the config runs is `planned` in the snapshot (its timeline node is there from the
// start) and a first round's rows are the configured names from its start (RunConfig.verify.names).
import { describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { TRUST_CHOICE, VERIFY_ENV_CHOICE } from '@core/supervisor/cards.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import {
  VERIFY_REASON,
  runConfigFromResolved,
  uniqueVerifyNames,
  unverifiedAfterFix,
} from '@core/supervisor/machine.ts'
import { VFlow, changed, result, trusted, untrusted, verifyMust, verifyShould } from './machine-helpers.ts'

/** verify:1 fails `test` (a [must]) → the reviewers find nothing → Fix → S2 → verify:2's trust check is out. */
function toVerify2(o: ConstructorParameters<typeof VFlow>[0] = {}, failing = ['test']): VFlow {
  const f = new VFlow(o).toS1()
  f.check([...failing.map((n) => trusted(n)), trusted('lint')])
  f.round(
    [...failing.map((n) => result(n, 'fail')), result('lint', 'pass')],
    failing.map((n) => verifyMust(n)),
  )
  f.snapshot('post-verify-1', 'tree-changed')
  f.toJoinAfterVerify('none', 'none')
  if (f.state.cards.some((c) => c.view.kind === 'gate:beforeFix')) f.choose('gate:beforeFix', 'continue')
  f.fixToS2()
  expect(f.step('verify:2')).toMatchObject({ status: 'running', attempt: 1 })
  return f
}

describe('only a pass after Fix completes `fixed`', () => {
  it('Auto: Fix changed the failing script → verify:2 skips it as changed → findings-open, never fixed', () => {
    const f = toVerify2({ auto: true })
    f.check([changed('test', 'vitest run', 'exit 0'), trusted('lint')], 'verify:2')
    f.round(
      [
        result('test', 'skipped-untrusted', { reason: VERIFY_REASON.changed, trust: 'changed' }),
        result('lint', 'pass'),
      ],
      [verifyShould('test')],
      'verify:2',
    )
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.state.notes).toContain(
      `test did not run after Fix, so its failure is still open. ${VERIFY_REASON.changed}`,
    )
    expect(unverifiedAfterFix(f.state)).toEqual([{ name: 'test', reason: VERIFY_REASON.changed }])
  })

  it('Auto: every command skipped (untrusted) → verify:2 reads skipped "no command ran" → findings-open', () => {
    const f = toVerify2({ auto: true })
    f.check([untrusted('test'), untrusted('lint')], 'verify:2')
    f.round(
      [
        result('test', 'skipped-untrusted', { reason: VERIFY_REASON.notTrusted }),
        result('lint', 'skipped-untrusted', { reason: VERIFY_REASON.notTrusted }),
      ],
      [verifyShould('test'), verifyShould('lint')],
      'verify:2',
    )
    expect(f.step('verify:2')).toMatchObject({ status: 'skipped', reason: 'no command ran' })
    expect(f.state.outcome).toBe('findings-open')
  })

  it('non-Auto: verify:2 could not run the failing command, [Skip verify] → findings-open with a note', () => {
    const f = toVerify2()
    f.check([trusted('test'), trusted('lint')], 'verify:2')
    f.round(
      [result('test', 'env', { reason: 'A program it runs was not found: vitest' }), result('lint', 'pass')],
      [],
      'verify:2',
    )
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
    expect(f.state).toMatchObject({ status: 'completed', outcome: 'findings-open' })
    expect(f.state.notes).toContain(
      'test did not run after Fix, so its failure is still open. A program it runs was not found: vitest',
    )
  })

  it('non-Auto: the user skips the failing command on its trust card → findings-open', () => {
    const f = toVerify2()
    f.check([changed('test', 'vitest run', 'vitest run --bail'), trusted('lint')], 'verify:2')
    f.choose('trust', TRUST_CHOICE.skip)
    f.round(
      [result('test', 'skipped', { reason: VERIFY_REASON.userSkipped }), result('lint', 'pass')],
      [],
      'verify:2',
    )
    expect(f.state.outcome).toBe('findings-open')
    expect(f.state.notes).toContain(
      `test did not run after Fix, so its failure is still open. ${VERIFY_REASON.userSkipped}`,
    )
  })

  it('the failing command passes after Fix while another could not run → fixed (what failed was verified)', () => {
    const f = toVerify2()
    f.check([trusted('test'), trusted('lint')], 'verify:2')
    f.round([result('test', 'pass'), result('lint', 'env')], [], 'verify:2')
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
    expect(f.state.outcome).toBe('fixed')
    expect(unverifiedAfterFix(f.state)).toEqual([])
  })

  it('two failing commands: both must pass; one skipped → findings-open naming only that one', () => {
    const f = toVerify2({}, ['test', 'typecheck'])
    f.check([trusted('test'), trusted('typecheck'), trusted('lint')], 'verify:2')
    f.round(
      [
        result('test', 'pass'),
        result('typecheck', 'skipped', { reason: 'It cannot run as configured.' }),
        result('lint', 'pass'),
      ],
      [],
      'verify:2',
    )
    expect(f.state.outcome).toBe('findings-open')
    expect(unverifiedAfterFix(f.state).map((u) => u.name)).toEqual(['typecheck'])
  })

  it('verify:1 had no failure (Fix ran for the reviewers) and verify:2 ran nothing → fixed, as before', () => {
    const f = new VFlow().toS1()
    f.check([trusted('test')])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-changed')
    f.toJoinAfterVerify('ok', 'none', [verifyMust('r1', 'r1')])
    if (f.state.cards.some((c) => c.view.kind === 'gate:beforeFix')) f.choose('gate:beforeFix', 'continue')
    f.fixToS2()
    f.check([trusted('test')], 'verify:2')
    f.round([result('test', 'env')], [], 'verify:2')
    f.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
    expect(f.state.outcome).toBe('fixed')
  })
})

describe('a round that stops being live settles its rows (no "Running" for good)', () => {
  const running = (): VFlow => {
    const f = new VFlow().toS1()
    f.check([trusted('typecheck'), trusted('test')])
    f.send({ t: 'verify-progress', req: f.roundReq(), running: 'typecheck' })
    expect(f.step('verify:1').verify?.commands.map((c) => c.status)).toEqual(['running', 'queued'])
    return f
  }
  const rows = (f: VFlow): [string, string, string | undefined][] =>
    (f.step('verify:1').verify?.commands ?? []).map((c) => [c.name, c.status, c.reason])

  it('Stop: the running command and the queued one read skipped with why; the late result changes nothing', () => {
    const f = running()
    f.user({ kind: 'stop' })
    expect(f.step('verify:1').status).toBe('cancelled')
    expect(rows(f)).toEqual([
      ['typecheck', 'skipped', VERIFY_REASON.stopped.running],
      ['test', 'skipped', VERIFY_REASON.stopped.queued],
    ])
    f.round([
      result('typecheck', 'skipped', { reason: 'Stopped before it finished' }),
      result('test', 'skipped', { reason: 'Stopped before it ran' }),
    ])
    expect(rows(f).map((r) => r[1])).toEqual(['skipped', 'skipped'])
  })

  it('quit: settled as interrupted; Resume reruns the round with the rows queued again', () => {
    const f = running()
    f.send({ t: 'quit' })
    expect(f.step('verify:1')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    expect(rows(f)).toEqual([
      ['typecheck', 'skipped', VERIFY_REASON.interrupted.running],
      ['test', 'skipped', VERIFY_REASON.interrupted.queued],
    ])
  })

  it('relaunch: settled as interrupted; Resume queues them again from the trust check', () => {
    const f = running()
    f.send({ t: 'relaunch' })
    expect(f.step('verify:1')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(rows(f).map((r) => r[1])).toEqual(['skipped', 'skipped'])
    f.user({ kind: 'resume' })
    expect(rows(f)).toEqual([
      ['typecheck', 'queued', undefined],
      ['test', 'queued', undefined],
    ])
  })

  it('every reason is UI copy without an em dash', () => {
    for (const r of [VERIFY_REASON.stopped, VERIFY_REASON.interrupted]) {
      expect(r.running).not.toContain('—')
      expect(r.queued).not.toContain('—')
    }
  })
})

describe('nothing moves on its own: a round is known before it begins', () => {
  it('toRunSnapshot marks a verify round the config runs as `planned` while it waits', () => {
    const on = new VFlow()
    expect(toRunSnapshot(on.state, 0).steps['verify:1'].planned).toBe(true)
    expect(toRunSnapshot(on.state, 0).steps['verify:2'].planned).toBe(true)
    expect(toRunSnapshot(new VFlow({ enabled: false }).state, 0).steps['verify:1'].planned).toBeUndefined()
    const fixOnly = toRunSnapshot(new VFlow({ runAfter: ['fix'] }).state, 0)
    expect([fixOnly.steps['verify:1'].planned, fixOnly.steps['verify:2'].planned]).toEqual([undefined, true])
    const noFix = toRunSnapshot(new VFlow({ fix: false }).state, 0)
    expect(noFix.steps['verify:2'].planned).toBeUndefined()
    // Begun: the step speaks for itself.
    on.toS1()
    expect(on.step('verify:1').status).toBe('running')
    expect(toRunSnapshot(on.state, 0).steps['verify:1'].planned).toBeUndefined()
  })

  it("RunConfig.verify.names (enabled, unique) are a first round's rows from its start; the check fills them in place", () => {
    const cfg = runConfigFromResolved(
      resolveBuiltinConfig({
        profile: 'claude-only',
        overrides: {
          verify: {
            enabled: true,
            commands: [
              { name: 'test', run: 'npm test' },
              { name: 'off', run: 'npm run off', enabled: false },
              { name: 'test', run: 'npm run test:e2e' },
            ],
          },
        },
      }),
    )
    expect(cfg.verify.names).toEqual(['test', 'test (2)'])
    expect(uniqueVerifyNames(['a', 'a', 'b', 'a'])).toEqual(['a', 'a (2)', 'b', 'a (3)'])
    expect(runConfigFromResolved(resolveBuiltinConfig({ profile: 'claude-only' })).verify).not.toHaveProperty(
      'names',
    )

    const f = new VFlow()
    f.state = {
      ...f.state,
      config: { ...f.state.config, verify: { ...f.state.config.verify, names: ['typecheck', 'test'] } },
    }
    f.toS1()
    expect(f.step('verify:1').verify?.commands.map((c) => [c.name, c.status, c.argv])).toEqual([
      ['typecheck', 'queued', []],
      ['test', 'queued', []],
    ])
    f.check([trusted('typecheck', ['npm', 'run', 'typecheck']), trusted('test')])
    expect(f.step('verify:1').verify?.commands.map((c) => [c.name, c.status, c.argv])).toEqual([
      ['typecheck', 'queued', ['npm', 'run', 'typecheck']],
      ['test', 'queued', ['npm', 'run', 'test']],
    ])
  })
})
