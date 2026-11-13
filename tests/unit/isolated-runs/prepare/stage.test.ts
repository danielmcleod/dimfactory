// Prepare step 3's decision in the worktree (Prepare, deps detection; depsConsent): an
// edited command over installCommand over detection, `install: 'never'` skipping, trust against the SOURCE folder's
// grants with the body the consent card grants; and the rows' one-line summaries (no em dash, stable wording).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDeps } from '../../../../src/core/prepare/detectDeps.ts'
import type { DepsPlan } from '../../../../src/core/prepare/detectDeps.ts'
import type { InstallResult } from '../../../../src/core/prepare/install.ts'
import { copyInsSummary, decideDepsStage, installSummary } from '../../../../src/core/prepare/stage.ts'
import { depsHash, readDepsBody } from '../../../../src/core/prepare/trust.ts'
import type { TrustGrants } from '../../../../src/shared/ipc.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'

let wt = ''
beforeEach(() => {
  wt = tempDir('dim-factory-stage-')
})
afterEach(() => removeDir(wt))

const opts = (grants: TrustGrants = {}, edited?: string) => ({
  worktreeFolder: wt,
  worktreeRoot: wt,
  grants: () => Promise.resolve(grants),
  ...(edited !== undefined ? { edited } : {}),
})

async function grantsFor(plan: DepsPlan): Promise<TrustGrants> {
  const body = (await readDepsBody(wt, plan)).body ?? ''
  return {
    commands: { [depsHash(plan, body)]: { kind: 'deps', argv: plan.argv, cwdRel: plan.cwdRel, body, at: 1 } },
  }
}

describe('decideDepsStage', () => {
  it('install off, nothing found, a command that cannot be read', async () => {
    expect(await decideDepsStage({ install: 'never', installCommand: null }, opts())).toEqual({
      plan: null,
      skip: 'Install dependencies is off',
    })
    expect(await decideDepsStage({ install: 'ask', installCommand: null }, opts())).toEqual({
      plan: null,
      skip: 'Nothing to install was found',
    })
    expect(await decideDepsStage({ install: 'ask', installCommand: 'a | b' }, opts())).toMatchObject({
      plan: null,
      source: 'config',
      error: expect.stringMatching(/needs a shell/) as string,
    })
    expect(await decideDepsStage({ install: 'ask', installCommand: null }, opts({}, 'x; y'))).toMatchObject({
      plan: null,
      source: 'edited',
    })
  })

  it('detected, untrusted: the view and the body to grant; with the grant: trusted', async () => {
    writeFiles(wt, { 'package.json': '{}\n', 'package-lock.json': '{}\n' })
    const first = await decideDepsStage({ install: 'ask', installCommand: null }, opts())
    expect(first).toMatchObject({
      source: 'detected',
      trust: 'untrusted',
      view: {
        manager: 'npm',
        argv: ['npm', 'ci'],
        cwdRel: '.',
        lockfile: 'package-lock.json',
        source: 'detected',
      },
    })
    expect(first.body).toBe((await readDepsBody(wt, first.plan as DepsPlan)).body)
    const grants = await grantsFor((await detectDeps(wt)) as DepsPlan)
    expect((await decideDepsStage({ install: 'auto', installCommand: null }, opts(grants))).trust).toBe(
      'trusted',
    )
    writeFiles(wt, { 'package-lock.json': '{"changed":true}\n' })
    const changed = await decideDepsStage({ install: 'ask', installCommand: null }, opts(grants))
    expect(changed).toMatchObject({
      trust: 'changed',
      grantedBody: expect.stringContaining('package-lock.json') as string,
    })
  })

  it('an edited command wins over installCommand, which wins over detection', async () => {
    writeFiles(wt, { 'package.json': '{}\n', 'package-lock.json': '{}\n' })
    const config = await decideDepsStage({ install: 'ask', installCommand: ['npm', 'install'] }, opts())
    expect(config).toMatchObject({ source: 'config', view: { manager: 'custom', argv: ['npm', 'install'] } })
    const edited = await decideDepsStage(
      { install: 'ask', installCommand: ['npm', 'install'] },
      opts({}, 'npm ci --ignore-scripts'),
    )
    expect(edited).toMatchObject({
      source: 'edited',
      view: { argv: ['npm', 'ci', '--ignore-scripts'], source: 'edited' },
    })
  })

  it('a command trust cannot cover is invalid, with why', async () => {
    writeFiles(wt, { 'package.json': '{"scripts":{}}\n' })
    const r = await decideDepsStage({ install: 'ask', installCommand: 'pnpm -r install' }, opts())
    expect(r).toMatchObject({ trust: 'invalid', reason: expect.stringMatching(/-r/) as string })
  })
})

describe('summaries', () => {
  it('copy-ins', () => {
    expect(copyInsSummary({ copied: [], skipped: [], refused: [], bytes: 0 })).toBe('Copied nothing')
    expect(
      copyInsSummary({
        copied: ['.env', 'a', 'b', 'c'],
        skipped: [{ path: 'src/x.ts', reason: 'tracked' }],
        refused: [{ glob: '../x', reason: 'outside' }],
        bytes: 10,
      }),
    ).toBe('Copied 4 files (.env, a, b, 1 more); 2 paths left out')
    expect(
      copyInsSummary({
        copied: ['.env'],
        skipped: [{ path: '', reason: 'Stopped' }],
        refused: [],
        bytes: 1,
        truncated: true,
      }),
    ).toBe('Copied 1 file (.env); stopped at a limit')
  })

  it('install', () => {
    const base: InstallResult = {
      status: 'pass',
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      exitCode: 0,
      durationMs: 41_000,
      excerpt: '',
      steps: [],
      logPath: '',
      liveLog: '',
    }
    expect(installSummary(base)).toBe('Installed with pnpm install --frozen-lockfile in 41s')
    expect(installSummary({ ...base, viaCorepack: true })).toBe(
      'Installed with pnpm install --frozen-lockfile in 41s (through corepack)',
    )
    expect(
      installSummary({
        ...base,
        status: 'fail',
        exitCode: 1,
        reason: 'pnpm install --frozen-lockfile failed with exit 1',
      }),
    ).toBe('pnpm install --frozen-lockfile failed with exit 1')
    expect(installSummary({ ...base, status: 'fail', timedOut: true, reason: 'Timed out after 15m' })).toBe(
      'pnpm install --frozen-lockfile: Timed out after 15m',
    )
    expect(installSummary({ ...base, status: 'env', reason: 'Dim Factory could not find pnpm' })).toBe(
      'Dim Factory could not find pnpm',
    )
    expect(installSummary({ ...base, status: 'skipped-untrusted', reason: 'Not allowed yet' })).toBe(
      'pnpm install --frozen-lockfile was not run: Not allowed yet',
    )
  })
})
