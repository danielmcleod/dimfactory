// `isolation.verifyReady` (run.isolation.verifyReady, Prepare step 5; resolution;
// deps_missing): every enabled verify command's program resolves in the worktree after deps (PATH, node_modules/.bin,
// .venv, repo wrappers); a missing one fails with deps_missing before Implement; a command that cannot run as written
// is run.verify's business, not readiness's.
import { chmodSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '../../../../src/core/config/builtins.ts'
import {
  VERIFY_READY_CHECK_ID,
  checkVerifyReady,
  verifyReadyResult,
  wantsVerifyReady,
} from '../../../../src/core/prepare/readiness.ts'
import type { VerifyCommandConfig } from '../../../../src/shared/config-schema.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'

const isWin = process.platform === 'win32'
const PATH = dirname(process.execPath)

let wt = ''
beforeEach(() => {
  wt = tempDir('dim-factory-ready-')
})
afterEach(() => removeDir(wt))

const config = (commands: VerifyCommandConfig[], over: Record<string, unknown> = {}) =>
  resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { isolation: { mode: 'worktree' }, verify: { enabled: true, commands }, ...over },
  })

/** A project-local bin (what the install puts in node_modules/.bin). */
function localBin(dir: string, name: string): void {
  const file = join(dir, 'node_modules', '.bin', isWin ? `${name}.cmd` : name)
  writeFiles(dir, {
    [join('node_modules', '.bin', isWin ? `${name}.cmd` : name)]: isWin ? '@echo off\n' : '#!/bin/sh\n',
  })
  if (!isWin) chmodSync(file, 0o755)
}

describe('checkVerifyReady', () => {
  it('ready when every program resolves; a local bin counts once the install made it', async () => {
    const cfg = config([
      { name: 'check', run: ['node', 'check.js'] },
      { name: 'test', run: ['vitest', 'run'] },
    ])
    const before = await checkVerifyReady(cfg, { worktreeFolder: wt, worktreeRoot: wt, pathEnv: PATH })
    expect(before.ok).toBe(false)
    expect(before.missing.map((m) => m.name)).toEqual(['test'])
    expect(before.commands[0]?.resolved).not.toBeNull()
    expect(before.reason).toBe(
      "Verify cannot run in the run's copy: test needs vitest. Install the project's dependencies (or set the install command), then Retry.",
    )
    localBin(wt, 'vitest')
    const after = await checkVerifyReady(cfg, { worktreeFolder: wt, worktreeRoot: wt, pathEnv: PATH })
    expect(after).toMatchObject({ ok: true, missing: [], reason: '' })
    expect(after.commands[1]?.resolved).toContain(join('node_modules', '.bin'))
  })

  it('reads each command where it runs (cwd below the worktree root), named as verify:1 names them', async () => {
    writeFiles(wt, { 'app/README.md': '\n' })
    localBin(join(wt, 'app'), 'eslint')
    const cfg = config([
      { name: 'lint', run: ['eslint', '.'] },
      { name: 'lint', run: ['eslint', '.'], cwd: '..' },
    ])
    const r = await checkVerifyReady(cfg, {
      worktreeFolder: join(wt, 'app'),
      worktreeRoot: wt,
      pathEnv: PATH,
    })
    expect(r.commands.map((c) => [c.name, c.cwdRel, c.resolved !== null])).toEqual([
      ['lint', 'app', true],
      ['lint (2)', '.', false],
    ])
  })

  it('a command that cannot run as written is left to run.verify; disabled commands are not read', async () => {
    const cfg = config([
      { name: 'shell', run: 'a && b' },
      { name: 'off', run: ['nothing-here'], enabled: false },
    ])
    const r = await checkVerifyReady(cfg, { worktreeFolder: wt, worktreeRoot: wt, pathEnv: PATH })
    expect(r.ok).toBe(true)
    expect(r.commands).toEqual([
      expect.objectContaining({ name: 'shell', resolved: null, error: expect.any(String) as string }),
    ])
  })

  it('as a CheckResult: deps_missing, blocking, with the install-command link', async () => {
    const cfg = config([{ name: 'test', run: ['vitest', 'run'] }])
    const r = await checkVerifyReady(cfg, {
      worktreeFolder: wt,
      worktreeRoot: wt,
      pathEnv: `${PATH}${delimiter}`,
    })
    const res = verifyReadyResult(r, 5)
    expect(res).toMatchObject({
      id: VERIFY_READY_CHECK_ID,
      scope: 'run',
      status: 'fail',
      blocking: true,
      category: 'deps_missing',
      title: 'The test check cannot find vitest in the run’s copy',
      at: 5,
    })
    expect(res.detail).toContain('`vitest run` needs vitest')
    expect(res.recovery).toEqual([
      expect.objectContaining({ kind: 'settings_link', pointer: '/isolation/worktree/installCommand' }),
    ])
    localBin(wt, 'vitest')
    const ok = verifyReadyResult(
      await checkVerifyReady(cfg, { worktreeFolder: wt, worktreeRoot: wt, pathEnv: PATH }),
      6,
    )
    expect(ok).toMatchObject({
      status: 'pass',
      blocking: false,
      detail: '1 command found after installing dependencies.',
    })
  })

  it('applies only to an isolated run with Verify on and a round to run', () => {
    const cmds = [{ name: 'c', run: ['node', 'c.js'] }]
    expect(wantsVerifyReady(config(cmds))).toBe(true)
    expect(wantsVerifyReady(config(cmds, { isolation: { mode: 'inPlace' } }))).toBe(false)
    expect(wantsVerifyReady(config(cmds, { verify: { enabled: false, commands: cmds } }))).toBe(false)
    expect(wantsVerifyReady(config(cmds, { verify: { enabled: true, commands: cmds, runAfter: [] } }))).toBe(
      false,
    )
  })
})
