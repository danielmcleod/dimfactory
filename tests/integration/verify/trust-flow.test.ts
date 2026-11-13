// "Trust a verify command" through a real core's IPC handlers (commands and trust, trust.json, Settings → Isolation
// & Verify): verify.detect shows the sandbox's detected and configured commands untrusted;
// trust.set with the hash the user was shown writes a grant covering the script body; verify.detect then reads
// trusted; Implement-style edits to the script read `changed` with the granted body for the diff, and the old hash
// can no longer grant. A configured command with shell syntax reads `invalid`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { scriptsBody } from '../../../src/core/verify/discover.ts'
import type { VerifyCommand } from '../../../src/shared/verify.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (let attempt = 0; ; attempt++) {
    try {
      cleanup(...dirs)
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 60 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw err
      await delay(250)
    }
  }
  dirs.splice(0)
})

async function boot(): Promise<{ core: Core; folder: string }> {
  const sc = await makeScenario({})
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return { core, folder }
}

async function detect(core: Core, folder: string): Promise<VerifyCommand[]> {
  const r = await core.invoke('verify.detect', { folder })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

const byName = (list: readonly VerifyCommand[], name: string): VerifyCommand => {
  const c = list.find((x) => x.name === name)
  if (c === undefined) throw new Error(`no ${name} in ${list.map((x) => x.name).join(', ')}`)
  return c
}

describe('flow: trust a verify command', () => {
  it('detect → trust with the shown hash → trusted → the script changes → changed (and the old hash cannot grant)', async () => {
    const { core, folder } = await boot()
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    writeFileSync(
      join(folder, '.dimfactory', 'dimfactory.json'),
      JSON.stringify({ verify: { commands: [{ name: 'piped', run: 'npm test | tee out.txt' }] } }),
    )

    // A body is the package.json's scripts map (a script may run any other).
    const pkgFile = join(folder, 'package.json')
    const scriptsNow = (): string =>
      scriptsBody((JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts: Record<string, string> }).scripts)
    const shown = scriptsNow()
    expect(shown).toContain('"test": "node --test src/index.test.ts"')

    const first = await detect(core, folder)
    expect(first.map((c) => [c.name, c.source, c.trust])).toEqual([
      ['piped', 'config', 'invalid'],
      ['test', 'package.json', 'untrusted'],
    ])
    const test = byName(first, 'test')
    expect(test).toMatchObject({
      argv: ['npm', 'run', 'test'],
      cwdRel: '.',
      body: shown,
      configured: false,
    })
    expect(test.resolved).not.toBeNull()

    const grant = {
      kind: 'command' as const,
      command: { kind: 'verify' as const, argv: test.argv, cwdRel: '.' },
    }
    const granted = await core.invoke('trust.set', {
      folder,
      grant: { ...grant, command: { ...grant.command, hash: test.hash } },
      trusted: true,
    })
    expect(granted.ok).toBe(true)
    const stored = await core.invoke('trust.get', { folder })
    expect(stored.ok && stored.value.grants.commands?.[test.hash]).toMatchObject({
      kind: 'verify',
      argv: ['npm', 'run', 'test'],
      cwdRel: '.',
      body: shown,
    })
    expect(byName(await detect(core, folder), 'test')).toMatchObject({ trust: 'trusted', trusted: true })

    // Implement edits the script.
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts: Record<string, string> }
    pkg.scripts['test'] = "node --test src/index.test.ts && node -e \"require('fs').rmSync('.')\""
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    const after = byName(await detect(core, folder), 'test')
    expect(after).toMatchObject({
      trust: 'changed',
      trusted: false,
      grantedBody: shown,
      body: scriptsNow(),
    })
    expect(after.body).toContain('rmSync')
    expect(after.hash).not.toBe(test.hash)

    const stale = await core.invoke('trust.set', {
      folder,
      grant: { ...grant, command: { ...grant.command, hash: test.hash } },
      trusted: true,
    })
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT')
    expect(byName(await detect(core, folder), 'test').trust).toBe('changed')

    // Trusting what is shown now works.
    const again = await core.invoke('trust.set', {
      folder,
      grant: { ...grant, command: { ...grant.command, hash: after.hash } },
      trusted: true,
    })
    expect(again.ok).toBe(true)
    expect(byName(await detect(core, folder), 'test').trust).toBe('trusted')
  })
})
