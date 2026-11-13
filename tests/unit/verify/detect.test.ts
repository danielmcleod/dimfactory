// verify.detect (IPC; Settings → Isolation & Verify): configured commands first, then detected ones
// not configured yet, each with its trust state (trusted / untrusted / changed with the granted body / invalid) and
// where argv[0] resolves. trust.set for a verify command adds the script body its hash covers, read now, and refuses
// (CONFLICT) when the body changed since the hash the user was shown.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import { VERIFY_COMMANDS, createHandlers, dispatch } from '../../../src/core/handlers.ts'
import type { HandlerContext } from '../../../src/core/handlers.ts'
import { detectVerifyCommands } from '../../../src/core/verify/detect.ts'
import { scriptsBody } from '../../../src/core/verify/discover.ts'
import { commandHash } from '../../../src/core/verify/trust.ts'
import { COMMAND_AREA } from '../../../src/shared/ipc.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import { pkg, removeDir, tempDir, writeFiles } from './helpers.ts'

let root = ''
let bin = ''
beforeEach(() => {
  root = tempDir()
  bin = tempDir('dim-factory-verify-bin-')
})
afterEach(() => {
  removeDir(root)
  removeDir(bin)
})

const isWin = process.platform === 'win32'
function fakeTool(name: string): string {
  const file = join(bin, isWin ? `${name}.cmd` : name)
  writeFileSync(file, isWin ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
  if (!isWin) chmodSync(file, 0o755)
  return file
}

const grantFor = (argv: string[], body: string | undefined, at = 1): TrustGrants['commands'] => ({
  [commandGrantHash({ kind: 'verify', argv, cwdRel: '.', ...(body !== undefined ? { body } : {}) })]: {
    kind: 'verify',
    argv,
    cwdRel: '.',
    ...(body !== undefined ? { body } : {}),
    at,
  },
})

describe('detectVerifyCommands', () => {
  it('configured first (with trust states), then detected ones not configured; resolution through PATH', async () => {
    writeFiles(root, {
      'package.json': pkg({ lint: 'eslint .', test: 'vitest run', build: 'vite build' }),
      'pnpm-lock.yaml': '',
    })
    const pnpm = fakeTool('pnpm')
    // A body is the package.json's scripts map; lint's grant is for an older map.
    const now = scriptsBody({ lint: 'eslint .', test: 'vitest run', build: 'vite build' })
    const older = scriptsBody({ lint: 'eslint src', test: 'vitest run', build: 'vite build' })
    const grants: TrustGrants = {
      commands: {
        ...grantFor(['pnpm', 'run', 'test'], now),
        ...grantFor(['pnpm', 'run', 'lint'], older),
      },
    }
    const out = await detectVerifyCommands({
      folder: root,
      configured: [
        { name: 'test', run: 'pnpm run test' },
        { name: 'lint', run: ['pnpm', 'run', 'lint'], timeoutMs: 60_000 },
        { name: 'bad', run: 'pnpm test && rm -rf x', enabled: false },
      ],
      grants,
      pathEntries: [bin],
    })
    expect(
      out.map((c) => [
        c.name,
        c.source,
        c.configured,
        c.trust,
        c.trusted,
        c.resolved,
        c.timeoutMs,
        c.enabledByDefault,
      ]),
    ).toEqual([
      ['test', 'config', true, 'trusted', true, pnpm, 600_000, true],
      ['lint', 'config', true, 'changed', false, pnpm, 60_000, true],
      ['bad', 'config', true, 'invalid', false, null, 600_000, false],
      ['build', 'package.json', false, 'untrusted', false, pnpm, 600_000, false],
    ])
    const [test, lint, bad, build] = out
    expect(test).toMatchObject({
      id: 'config:.:test',
      argv: ['pnpm', 'run', 'test'],
      run: ['pnpm', 'run', 'test'],
      body: now,
      hash: commandHash({ run: ['pnpm', 'run', 'test'], cwdRel: '.' }, now),
    })
    expect(lint).toMatchObject({ body: now, grantedBody: older })
    expect(bad?.error).toMatch(/use a package script/)
    expect(build).toMatchObject({ id: 'package.json:.:build', kind: 'build' })
  })

  it('a command that does not resolve reads resolved: null', async () => {
    writeFiles(root, { 'go.mod': 'module x\n' })
    const out = await detectVerifyCommands({ folder: root, configured: [], grants: {}, pathEntries: [bin] })
    expect(out.map((c) => [c.name, c.resolved])).toEqual([
      ['go build', null],
      ['go vet', null],
      ['go test', null],
    ])
  })

  it('below the scope root, `cwd` is relative to the folder (what verify.commands[].cwd means)', async () => {
    writeFiles(root, {
      'packages/app/package.json': pkg({ test: 'vitest run' }),
      'packages/app/e2e/package.json': pkg({ e2e: 'playwright test' }),
    })
    const folder = join(root, 'packages', 'app')
    const out = await detectVerifyCommands({
      folder,
      scopeRoot: root,
      configured: [{ name: 'e2e', run: ['npm', 'run', 'e2e'], cwd: 'e2e' }],
      grants: {},
      pathEntries: [bin],
    })
    expect(out.map((c) => [c.name, c.cwdRel, c.cwd])).toEqual([
      ['e2e', 'packages/app/e2e', 'e2e'],
      ['test', 'packages/app', '.'],
    ])
    // Written back as `cwd`, the configured entry reads as the same command (no packages/app/packages/app).
    const again = await detectVerifyCommands({
      folder,
      scopeRoot: root,
      configured: [{ name: 'test', run: ['npm', 'run', 'test'] }],
      grants: {},
      pathEntries: [bin],
    })
    expect(again.map((c) => [c.name, c.source, c.cwdRel])).toEqual([['test', 'config', 'packages/app']])
  })
})

describe('verify handlers', () => {
  function setup(grants: TrustGrants = {}, commands: unknown[] = []) {
    const trustSet = vi.fn((req: unknown) => Promise.resolve({ req }))
    const ctx = {
      kind: 'app',
      readOnly: false,
      config: {
        trustGet: (folder: string) =>
          Promise.resolve({ folder, folderKey: '0123456789abcdef', scopeRoot: root, grants }),
        snapshot: () => Promise.resolve({ config: { verify: { commands } } }),
        trustSet,
      },
    } as unknown as HandlerContext
    return { h: createHandlers(ctx), trustSet }
  }

  it('verify.detect is a core command', () => {
    for (const c of VERIFY_COMMANDS) expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, c)).toBe(true)
  })

  it('verify.detect answers the folder’s commands; a missing folder is NOT_FOUND', async () => {
    writeFiles(root, { 'package.json': pkg({ test: 'jest' }) })
    const { h } = setup({}, [{ name: 'unit', run: 'npm test' }])
    const r = await dispatch(h, 'verify.detect', { folder: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((c) => [c.name, c.source, c.trust])).toEqual([
      ['unit', 'config', 'untrusted'],
      ['test', 'package.json', 'untrusted'],
    ])
    const missing = await dispatch(h, 'verify.detect', { folder: join(root, 'nope') })
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND')
  })

  it('trust.set adds the body a verify grant covers, read now; the shown hash must still match', async () => {
    writeFiles(root, { 'package.json': pkg({ test: 'vitest run' }) })
    const { h, trustSet } = setup()
    const argv = ['npm', 'run', 'test']
    const body = scriptsBody({ test: 'vitest run' })
    const shown = commandHash({ argv, cwdRel: '.' }, body)
    const ok = await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.', hash: shown } },
      trusted: true,
    })
    expect(ok.ok).toBe(true)
    expect(trustSet).toHaveBeenCalledWith({
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.' } },
      trusted: true,
      body,
    })

    writeFiles(root, { 'package.json': pkg({ test: 'vitest run && node x.js' }) })
    const stale = await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.', hash: shown } },
      trusted: true,
    })
    expect(stale.ok ? null : stale.error.code).toBe('CONFLICT')
    expect(trustSet).toHaveBeenCalledTimes(1)

    // A revoke (the grant's Undo) never widens trust: the shown hash does not have to match.
    const revoke = await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.', hash: shown } },
      trusted: false,
    })
    expect(revoke.ok).toBe(true)
    expect(trustSet).toHaveBeenLastCalledWith({
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.' } },
      trusted: false,
      body: scriptsBody({ test: 'vitest run && node x.js' }),
    })
  })

  it('trust.set: a fixed tool command has no body; a deps grant is passed as it is', async () => {
    const { h, trustSet } = setup()
    await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv: ['cargo', 'test'], cwdRel: '.' } },
      trusted: true,
    })
    expect(trustSet).toHaveBeenLastCalledWith({
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv: ['cargo', 'test'], cwdRel: '.' } },
      trusted: true,
    })
    await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'deps', argv: ['pnpm', 'install'], cwdRel: '.' } },
      trusted: false,
    })
    expect(trustSet).toHaveBeenLastCalledWith({
      folder: root,
      grant: { kind: 'command', command: { kind: 'deps', argv: ['pnpm', 'install'], cwdRel: '.' } },
      trusted: false,
    })
    const bad = await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv: ['x'], cwdRel: '.', hash: 'nothex' } },
      trusted: true,
    })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
  })
})
