// Preflight `run.verify` (commands and trust, resolution; deps_missing,
// verify_untrusted): Verify on with no command blocks and names the detected ones (Settings, never a config_patch:
// the config_patch allowlist forbids verify commands); a command that needs a shell blocks; an argv[0] that does not resolve
// blocks (deps_missing); an untrusted or changed command warns with a link to Settings, where its script is shown
// before Trust (never a blind grant; the trust card asks at run time, Auto skips it); all trusted and
// found passes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig, VerifyCommandConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { grantTrust, trustGrantsFor } from '@core/config/trust.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { scriptsBody } from '@core/verify/discover.ts'
import type { PreflightDeps } from '@core/preflight/engine.ts'
import { healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'

let root: string
let folder: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-preflight-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const verifyResults = (r: PreflightReport): CheckResult[] =>
  all(r).filter((x) => x.id.startsWith('run.verify'))

function config(
  verify: { enabled?: boolean; commands?: VerifyCommandConfig[] },
  auto = false,
): ResolvedConfig {
  return resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: { verify: { enabled: verify.enabled ?? true, commands: verify.commands ?? [] }, auto },
  })
}

function packageJson(scripts: Record<string, string>): void {
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'p', scripts }, null, 2))
}

async function preflight(
  cfg: ResolvedConfig,
  mode: 'live' | 'authoritative' = 'authoritative',
  over: Partial<PreflightDeps> = {},
): Promise<PreflightReport> {
  const engine = createPreflightEngine(
    healthyDeps({
      home,
      platform: process.platform,
      trustGrants: (f) => trustGrantsFor(f, { home, folderScope: { scopeRoot: folder } }),
      ...over,
    }),
  )
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  return engine.run(mode, { folder, config: cfg })
}

const NODE_CHECK: VerifyCommandConfig = { name: 'check', run: ['node', 'check.mjs'] }

describe('run.verify', () => {
  it('does not apply while Verify is off', async () => {
    const r = await preflight(config({ enabled: false, commands: [NODE_CHECK] }))
    expect(verifyResults(r)).toEqual([])
  })

  it('Verify on with no command → blocks, names the detected commands, links to Settings (no config_patch)', async () => {
    packageJson({ lint: 'eslint .', test: 'vitest run', build: 'tsc -b' })
    const r = await preflight(config({ commands: [] }))
    const [res] = verifyResults(r)
    expect(r.ok).toBe(false)
    expect(res).toMatchObject({
      id: 'run.verify',
      status: 'fail',
      blocking: true,
      category: 'config_invalid',
      title: 'Verify is on but has no commands',
    })
    // build is off by default, so it is not suggested.
    expect(res?.detail).toBe(
      'This project suggests: lint (npm run lint), test (npm run test). Add the ones to run in Settings, or turn Verify off.',
    )
    expect(res?.recovery).toEqual([
      {
        id: 'run.verify.settings',
        label: 'Choose verify commands',
        kind: 'settings_link',
        route: 'settings/isolation',
        pointer: '/verify/commands',
        suggested: { scope: 'project', folder },
      },
    ])
    expect(res?.recovery.some((a) => a.kind === 'config_patch')).toBe(false)
  })

  it('disabled entries do not count: every command off is "no commands"', async () => {
    const r = await preflight(config({ commands: [{ ...NODE_CHECK, enabled: false }] }))
    expect(verifyResults(r)[0]).toMatchObject({ id: 'run.verify', title: 'Verify is on but has no commands' })
  })

  it('a command line with shell syntax blocks ("use a package script")', async () => {
    const r = await preflight(config({ commands: [{ name: 'test', run: 'npm test | tee out.txt' }] }))
    const [res] = verifyResults(r)
    expect(res).toMatchObject({
      id: 'run.verify.test',
      status: 'fail',
      blocking: true,
      category: 'config_invalid',
      title: 'The test check cannot run as written',
    })
    expect(res?.detail).toMatch(/use a package script/)
  })

  it('argv[0] that does not resolve → blocking deps_missing (copy the install command, edit in Settings)', async () => {
    packageJson({ test: 'vitest run' })
    const r = await preflight(
      config({ commands: [{ name: 'unit', run: ['dim-factory-no-such-tool-x9', 'run'] }] }),
    )
    const [res] = verifyResults(r)
    expect(res).toMatchObject({
      id: 'run.verify.unit',
      status: 'fail',
      blocking: true,
      category: 'deps_missing',
      title: 'The unit check cannot find dim-factory-no-such-tool-x9',
    })
    expect(res?.recovery.map((a) => [a.kind, a.label])).toEqual([
      ['shell_copy', 'Copy npm install'],
      ['settings_link', 'Edit the verify commands'],
    ])
  })

  it('untrusted → a warning (the trust card asks at run time) linking to Settings, never a blind grant', async () => {
    packageJson({ test: 'vitest run' })
    const r = await preflight(config({ commands: [{ name: 'test', run: ['npm', 'run', 'test'] }] }))
    expect(r.ok).toBe(true)
    const [res] = verifyResults(r)
    expect(res).toMatchObject({
      id: 'run.verify.test',
      status: 'warn',
      blocking: false,
      category: 'verify_untrusted',
      title: 'The test check is not trusted yet',
      detail:
        'Verify asks you to trust `npm run test` when it gets there, or review and trust it in Settings now.',
    })
    // The chip used to grant the script read at preflight without showing it. Settings shows the
    // command with its script (and what changed), and grants only the hash it showed.
    expect(res?.recovery).toEqual([
      {
        id: 'run.verify.test.trust',
        label: 'Review and trust in Settings',
        kind: 'settings_link',
        route: 'settings/isolation',
        pointer: '/verify/commands',
        suggested: { scope: 'project', folder },
      },
    ])
  })

  it('Auto: the warning says Verify skips it (Auto never trusts a command on its own)', async () => {
    packageJson({ test: 'vitest run' })
    const r = await preflight(config({ commands: [{ name: 'test', run: ['npm', 'run', 'test'] }] }, true))
    expect(verifyResults(r)[0]?.detail).toBe(
      'Auto never trusts a command on its own, so Verify skips `npm run test`. Review and trust it in Settings to run it.',
    )
  })

  it('trusted and found → pass; a changed script body → warns again (new hash)', async () => {
    packageJson({ test: 'vitest run' })
    await grantTrust(
      folder,
      {
        kind: 'command',
        command: {
          kind: 'verify',
          argv: ['npm', 'run', 'test'],
          cwdRel: '.',
          body: scriptsBody({ test: 'vitest run' }),
        },
      },
      { home, folderScope: { scopeRoot: folder } },
    )
    const cfg = config({ commands: [{ name: 'test', run: ['npm', 'run', 'test'] }] })
    const ok = await preflight(cfg, 'live')
    expect(verifyResults(ok)).toEqual([
      expect.objectContaining({ id: 'run.verify', status: 'pass', detail: '1 command ready: test.' }),
    ])
    packageJson({ test: 'vitest run --coverage' })
    const again = await preflight(cfg, 'live')
    expect(verifyResults(again)[0]).toMatchObject({
      status: 'warn',
      title: 'The test check changed since you trusted it',
    })
    expect(verifyResults(again)[0]?.recovery.map((a) => [a.kind, a.label])).toEqual([
      ['settings_link', 'Review and trust in Settings'],
    ])
  })

  it('blockers come before trust warnings; each command reports once', async () => {
    packageJson({ test: 'vitest run' })
    const r = await preflight(
      config({
        commands: [
          { name: 'test', run: ['npm', 'run', 'test'] },
          { name: 'shell', run: 'echo hi && exit 1' },
        ],
      }),
    )
    expect(r.blocking.map((x) => x.id)).toEqual(['run.verify.shell'])
    expect(r.warnings.filter((x) => x.id.startsWith('run.verify')).map((x) => x.id)).toEqual([
      'run.verify.test',
    ])
  })

  it('the facts seam: no I/O when `verifyFacts` is given', async () => {
    const r = await preflight(config({ commands: [NODE_CHECK] }), 'live', {
      verifyFacts: () =>
        Promise.resolve({
          commands: [
            {
              name: 'check',
              argv: ['node', 'check.mjs'],
              cwdRel: '.',
              body: null,
              trust: 'trusted',
              resolved: 'node',
            },
          ],
          detected: [],
        }),
    })
    expect(verifyResults(r)).toEqual([expect.objectContaining({ status: 'pass' })])
  })
})
