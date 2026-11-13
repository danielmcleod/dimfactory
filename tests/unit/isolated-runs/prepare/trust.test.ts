// Deps trust (deps detection "with a trust grant (kind deps)", trust.json; the
// SOURCE folder's grants): the body names the setup steps and each source file's sha256 (CRLF read as LF), the hash is
// sha256(JSON{kind:'deps', argv, cwdRel, body}), a lockfile change turns a grant into `changed` (re-consent), a grant
// written for the source folder covers the same files in the run's copy (another folder key), a verify grant never
// counts, and a configured command's scripts are part of its body (another package's scripts: invalid).
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandGrantHash, grantTrust, trustGrantsFor } from '../../../../src/core/config/trust.ts'
import { detectDeps, planFromCommand } from '../../../../src/core/prepare/detectDeps.ts'
import type { DepsPlan } from '../../../../src/core/prepare/detectDeps.ts'
import { changedSources } from '../../../../src/core/prepare/facts.ts'
import {
  checkDepsTrust,
  depsGrantCommand,
  depsHash,
  depsTrustOf,
  grantDeps,
  readDepsBody,
} from '../../../../src/core/prepare/trust.ts'
import type { TrustGrants } from '../../../../src/shared/ipc.ts'
import { removeDir, tempDir, writeFiles } from '../../verify/helpers.ts'

let source = ''
let copy = ''
const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
beforeEach(() => {
  source = tempDir('dim-factory-trust-src-')
  copy = tempDir('dim-factory-trust-wt-')
})
afterEach(() => {
  removeDir(source)
  removeDir(copy)
})

const PKG = '{"name":"p","scripts":{"postinstall":"node setup.js"}}\n'

async function pnpmPlan(dir: string): Promise<DepsPlan> {
  writeFiles(dir, { 'package.json': PKG, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })
  const plan = await detectDeps(dir)
  if (plan === null) throw new Error('no plan')
  return plan
}

const grantsOf = (folder: string): Promise<TrustGrants> =>
  trustGrantsFor(folder, { home: home(), folderScope: { scopeRoot: folder } })

describe('readDepsBody', () => {
  it('names each source by its sha256; CRLF and LF read alike; a missing file is named', async () => {
    const plan = await pnpmPlan(source)
    const body = await readDepsBody(source, plan)
    expect(body.error).toBeUndefined()
    const lines = (body.body ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^file pnpm-lock\.yaml sha256 [0-9a-f]{64}$/)
    expect(lines[1]).toMatch(/^file package\.json sha256 [0-9a-f]{64}$/)

    writeFileSync(join(copy, 'package.json'), PKG.replace(/\n/g, '\r\n'))
    writeFileSync(join(copy, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\r\n")
    expect((await readDepsBody(copy, plan)).body).toBe(body.body)

    const gone = await readDepsBody(source, { ...plan, sources: [...plan.sources, 'pnpm-workspace.yaml'] })
    expect(gone.body?.split('\n').at(-1)).toBe('file pnpm-workspace.yaml missing')
  })

  it('names the setup steps first (requirements.txt: the venv)', async () => {
    writeFiles(source, { 'requirements.txt': 'requests==2.32.0\n' })
    const plan = await detectDeps(source, { platform: 'win32' })
    const body = (await readDepsBody(source, plan as DepsPlan)).body ?? ''
    expect(body.split('\n')[0]).toBe('step py -3 -m venv .venv')
    expect(body.split('\n')[1]).toMatch(/^file requirements\.txt sha256 /)
  })

  it('never reads through a link', async (ctx) => {
    writeFiles(source, { 'real.lock': 'x\n', 'package.json': PKG })
    try {
      symlinkSync(join(source, 'real.lock'), join(source, 'pnpm-lock.yaml'), 'file')
    } catch {
      ctx.skip() // file symbolic links need Developer Mode or elevation on Windows
    }
    const plan: DepsPlan = {
      manager: 'pnpm',
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      cwdRel: '.',
      lockfile: 'pnpm-lock.yaml',
      sources: ['pnpm-lock.yaml'],
      via: 'lockfile',
      tools: ['pnpm'],
    }
    expect((await readDepsBody(source, plan)).body).toBe('file pnpm-lock.yaml is a link')
  })

  it('a configured command that runs package scripts covers the scripts map; another package’s is invalid', async () => {
    writeFiles(source, { 'package.json': PKG, 'package-lock.json': '{}\n' })
    const r = await planFromCommand('npm run setup', source)
    const body = (await readDepsBody(source, r.plan as DepsPlan)).body ?? ''
    expect(body).toContain('file package-lock.json sha256 ')
    expect(body).toContain('script\n{\n  "postinstall": "node setup.js"\n}')
    const other = await planFromCommand('pnpm --filter web install', source)
    const bad = await readDepsBody(source, other.plan as DepsPlan)
    expect(bad.body).toBeNull()
    expect(bad.error).toMatch(/--filter/)
    expect(await checkDepsTrust(source, other.plan as DepsPlan, {})).toMatchObject({ trust: 'invalid' })
  })
})

describe('deps grants', () => {
  it('the hash is sha256(JSON{kind:deps, argv, cwdRel, body})', async () => {
    const plan = await pnpmPlan(source)
    const body = (await readDepsBody(source, plan)).body ?? ''
    expect(depsGrantCommand(plan, body)).toEqual({ kind: 'deps', argv: plan.argv, cwdRel: '.', body })
    expect(depsHash(plan, body)).toBe(commandGrantHash({ kind: 'deps', argv: plan.argv, cwdRel: '.', body }))
    // The same argv and body as a verify grant is another hash.
    expect(depsHash(plan, body)).not.toBe(
      commandGrantHash({ kind: 'verify', argv: plan.argv, cwdRel: '.', body }),
    )
  })

  it('granted in the SOURCE folder, it covers the same files in the run’s copy; a lockfile change asks again', async () => {
    const plan = await pnpmPlan(source)
    const body = (await readDepsBody(source, plan)).body ?? ''
    expect(depsTrustOf(plan, body, await grantsOf(source))).toMatchObject({ trust: 'untrusted' })

    await grantDeps(source, plan, body, { home: home(), folderScope: { scopeRoot: source } })
    const stored = JSON.parse(readFileSync(join(home(), 'trust.json'), 'utf8')) as {
      folders: Record<string, { path: string; grants: TrustGrants }>
    }
    const entry = Object.values(stored.folders)[0]
    expect(entry?.path).toBe(source)
    expect(Object.values(entry?.grants.commands ?? {})).toEqual([
      expect.objectContaining({ kind: 'deps', argv: plan.argv, cwdRel: '.', body }),
    ])

    // The run's copy (another folder key, no grants of its own) with the same files: trusted by the source's grants.
    await pnpmPlan(copy)
    expect(await grantsOf(copy)).toEqual({})
    const sourceGrants = await grantsOf(source)
    expect(await checkDepsTrust(copy, plan, sourceGrants)).toMatchObject({ trust: 'trusted' })

    // The lockfile changes: the grant is for other files now (consent again), and the change is named.
    writeFileSync(join(copy, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\n")
    const changed = await checkDepsTrust(copy, plan, sourceGrants)
    expect(changed).toMatchObject({ trust: 'changed', grantedBody: body })
    if (changed.trust !== 'changed') throw new Error('not changed')
    expect(changedSources(changed.grantedBody, changed.body)).toEqual(['pnpm-lock.yaml'])

    // package.json's scripts (lifecycle scripts run on install) count too.
    writeFileSync(join(copy, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    writeFileSync(join(copy, 'package.json'), PKG.replace('setup.js', 'evil.js'))
    const again = await checkDepsTrust(copy, plan, sourceGrants)
    expect(again.trust).toBe('changed')
    if (again.trust === 'changed')
      expect(changedSources(again.grantedBody, again.body)).toEqual(['package.json'])
  })

  it('another command, another folder or a verify grant never trusts it', async () => {
    const plan = await pnpmPlan(source)
    const body = (await readDepsBody(source, plan)).body ?? ''
    await grantTrust(
      source,
      { kind: 'command', command: { kind: 'verify', argv: plan.argv, cwdRel: '.', body } },
      { home: home(), folderScope: { scopeRoot: source } },
    )
    expect(depsTrustOf(plan, body, await grantsOf(source)).trust).toBe('untrusted')
    await grantDeps(source, { argv: ['pnpm', 'install'], cwdRel: '.' }, body, {
      home: home(),
      folderScope: { scopeRoot: source },
    })
    expect(depsTrustOf(plan, body, await grantsOf(source)).trust).toBe('untrusted')
    await grantDeps(source, { argv: plan.argv, cwdRel: 'packages/app' }, body, {
      home: home(),
      folderScope: { scopeRoot: source },
    })
    expect(depsTrustOf(plan, body, await grantsOf(source)).trust).toBe('untrusted')
  })

  it('changed names the newest grant’s body for the same command and folder', () => {
    const plan = { argv: ['npm', 'ci'], cwdRel: '.' }
    const g = (body: string, at: number) => ({
      kind: 'deps' as const,
      argv: plan.argv,
      cwdRel: '.',
      body,
      at,
    })
    const grants: TrustGrants = {
      commands: { [depsHash(plan, 'old')]: g('old', 1), [depsHash(plan, 'newer')]: g('newer', 5) },
    }
    expect(depsTrustOf(plan, 'now', grants)).toMatchObject({ trust: 'changed', grantedBody: 'newer' })
    expect(depsTrustOf(plan, 'newer', grants)).toMatchObject({ trust: 'trusted' })
  })
})
