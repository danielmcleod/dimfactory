// The verify:0 baseline (the rounds table and "already failing before this run"): the map keeps pass,
// fail and env by command name (nothing for a command that did not run), the names are verify:1's (uniqueVerifyNames),
// the round runs in the worktree with the SOURCE folder's grants and never stops at the first failure, baseline.json
// round-trips, and a command failing in the baseline renders as pre-existing: a [should], not blocking the Fix skip
// rule, not making the outcome verify-failed.
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../../src/core/home.ts'
import {
  baselineCommands,
  baselineOf,
  baselinePath,
  readBaseline,
  runBaseline,
  uniqueNames,
  wantsBaseline,
  writeBaseline,
} from '../../../../src/core/prepare/baseline.ts'
import type { BaselineDeps } from '../../../../src/core/prepare/baseline.ts'
import { writeJsonAtomic } from '../../../../src/core/store/atomic.ts'
import { uniqueVerifyNames } from '../../../../src/core/supervisor/machine.ts'
import {
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from '../../../../src/core/verify/render.ts'
import type { VerifyRoundOptions, VerifyRoundResult } from '../../../../src/core/verify/run.ts'
import { resolveBuiltinConfig } from '../../../../src/core/config/builtins.ts'
import type { VerifyCommandResult } from '../../../../src/shared/verify.ts'
import type { TrustGrants } from '../../../../src/shared/ipc.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'

const paths = () => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
const RUN = '20261009T120000Z-baseline'

const result = (
  name: string,
  status: VerifyCommandResult['status'],
  extra: Partial<VerifyCommandResult> = {},
) =>
  ({
    name,
    argv: ['pnpm', 'run', name],
    status,
    exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null,
    durationMs: 1000,
    excerpt: status === 'fail' ? 'Tests: 1 failed' : '',
    logPath: '',
    ...extra,
  }) satisfies VerifyCommandResult

describe('baseline map', () => {
  it('keeps pass, fail and env; a command that did not run is unknown before the run', () => {
    expect(
      baselineOf([
        result('typecheck', 'pass'),
        result('test', 'fail'),
        result('lint', 'env'),
        result('e2e', 'skipped-untrusted'),
        result('build', 'skipped'),
      ]),
    ).toEqual({ typecheck: 'pass', test: 'fail', lint: 'env' })
  })

  it('names commands exactly as verify:1 does', () => {
    const names = ['test', 'lint', 'test', 'test (2)', 'test']
    expect(uniqueNames(names)).toEqual(uniqueVerifyNames(names))
  })

  it('baseline.json round-trips; a missing or odd file reads as no baseline', async () => {
    expect(await readBaseline(paths(), RUN)).toBeUndefined()
    await writeBaseline(paths(), RUN, { test: 'fail', lint: 'pass' })
    expect(baselinePath(paths(), RUN)).toBe(join(paths().run(RUN).dir, 'verify', 'baseline.json'))
    expect(await readBaseline(paths(), RUN)).toEqual({ test: 'fail', lint: 'pass' })
    await writeJsonAtomic(baselinePath(paths(), RUN), { test: 'fail', odd: 'maybe', n: 1 })
    expect(await readBaseline(paths(), RUN)).toEqual({ test: 'fail' })
    await writeJsonAtomic(baselinePath(paths(), RUN), ['test'])
    expect(await readBaseline(paths(), RUN)).toBeUndefined()
  })
})

describe('wantsBaseline', () => {
  const cfg = (over: Record<string, unknown>) =>
    resolveBuiltinConfig({ profile: 'claude-only', overrides: over })
  const cmds = [{ name: 'test', run: ['node', 't.js'] }]
  it('only for an isolated run with Verify on, a round to compare and verify.baseline', () => {
    expect(
      wantsBaseline(
        cfg({ isolation: { mode: 'worktree' }, verify: { enabled: true, baseline: true, commands: cmds } }),
      ),
    ).toBe(true)
    expect(wantsBaseline(cfg({ verify: { enabled: true, baseline: true, commands: cmds } }))).toBe(false)
    expect(
      wantsBaseline(
        cfg({ isolation: { mode: 'worktree' }, verify: { enabled: true, baseline: false, commands: cmds } }),
      ),
    ).toBe(false)
    expect(
      wantsBaseline(
        cfg({
          isolation: { mode: 'worktree' },
          verify: { enabled: true, baseline: true, commands: cmds, runAfter: [] },
        }),
      ),
    ).toBe(false)
  })
})

describe('runBaseline', () => {
  it('runs verify:0 in the worktree with the source grants, never failFast, and writes baseline.json', async () => {
    const wt = tempDir('dim-factory-baseline-wt-')
    try {
      writeFiles(wt, { 'package.json': '{"scripts":{"test":"x","lint":"y"}}\n', 'app/README.md': '\n' })
      const config = resolveBuiltinConfig({
        profile: 'claude-only',
        overrides: {
          verify: {
            enabled: true,
            failFast: true,
            commands: [
              { name: 'test', run: 'npm run test', timeoutMs: 5000 },
              { name: 'test', run: ['npm', 'run', 'lint'] },
              { name: 'off', run: 'npm run x', enabled: false },
              { name: 'shell', run: 'a && b' },
            ],
          },
        },
      })
      const source: TrustGrants = { commands: {} }
      const grants = vi.fn(() => Promise.resolve(source))
      const seen: VerifyRoundOptions[] = []
      const runRound = vi.fn(
        (d: Parameters<NonNullable<BaselineDeps['runRound']>>[0], o: VerifyRoundOptions) => {
          seen.push(o)
          expect(d.grants).toBe(grants)
          return Promise.resolve({
            results: [result('test', 'fail'), result('test (2)', 'pass'), result('shell', 'skipped')],
            logDir: '',
            outputLog: '',
          } satisfies VerifyRoundResult)
        },
      )
      const r = await runBaseline(
        { paths: paths(), grants, runRound },
        { runId: RUN, config, worktreeFolder: join(wt, 'app'), worktreeRoot: wt },
      )
      expect(seen[0]).toMatchObject({
        runId: RUN,
        round: 'verify:0',
        folder: join(wt, 'app'),
        scopeRoot: wt,
        failFast: false,
      })
      expect(seen[0]?.commands).toEqual([
        { name: 'test', argv: ['npm', 'run', 'test'], cwdRel: 'app', timeoutMs: 5000 },
        { name: 'test (2)', argv: ['npm', 'run', 'lint'], cwdRel: 'app' },
        expect.objectContaining({
          name: 'shell',
          argv: [],
          error: expect.stringMatching(/needs a shell/) as string,
        }),
      ])
      expect(r.baseline).toEqual({ test: 'fail', 'test (2)': 'pass' })
      expect(await readBaseline(paths(), RUN)).toEqual(r.baseline)
      expect(r.path).toBe(baselinePath(paths(), RUN))
    } finally {
      removeDir(wt)
    }
  })

  it('baselineCommands reads cwdRel relative to the worktree root', async () => {
    const wt = tempDir('dim-factory-baseline-cmds-')
    try {
      writeFiles(wt, { 'pkg/sub/x.txt': '\n' })
      const config = resolveBuiltinConfig({
        profile: 'claude-only',
        overrides: {
          verify: { enabled: true, commands: [{ name: 'c', run: ['node', 'c.js'], cwd: 'sub' }] },
        },
      })
      expect(await baselineCommands(config, join(wt, 'pkg'), wt)).toEqual([
        { name: 'c', argv: ['node', 'c.js'], cwdRel: 'pkg/sub' },
      ])
    } finally {
      removeDir(wt)
    }
  })
})

describe('a baseline failure is pre-existing (render.ts takes the map)', () => {
  const round = [result('test', 'fail'), result('lint', 'fail'), result('typecheck', 'pass')]
  const baseline = { test: 'fail', lint: 'pass', typecheck: 'pass' } as const

  it('{{verify}} says "already failing before this run" for it only', () => {
    const text = renderVerifySection(round, baseline)
    expect(text).toContain('- FAIL (already failing before this run) `pnpm run test` (exit 1, 1s)')
    expect(text).toContain('- FAIL `pnpm run lint` (exit 1, 1s)')
  })

  it('it is a [should] flagged preexisting; the new failure stays [must]', () => {
    const f = verifyFindings(round, { baseline })
    expect(f.map((x) => [x.severity, x.flags])).toEqual([
      ['must', []],
      ['should', ['preexisting']],
    ])
  })

  it('it does not block the Fix skip rule or make the outcome verify-failed', () => {
    expect(verifyHasMustFailures([result('test', 'fail')], baseline)).toBe(false)
    expect(verifyHasMustFailures([result('test', 'fail')])).toBe(true)
    // env in the baseline is not a failure there: a later failure is new.
    expect(verifyHasMustFailures([result('test', 'fail')], { test: 'env' })).toBe(true)
  })
})
