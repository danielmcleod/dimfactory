// Integration fix (commands and trust; Settings → Isolation & Verify, commands with their trust
// state): Untrust in Settings revokes the grant for the command's current script; a grant for an older script of the
// same command (argv and cwd) stayed in trust.json, so the command read "changed since you trusted it" right after the
// user untrusted it (ui-standards.spec.ts' verify walk). The revoke now removes those too; a grant is still only ever made
// for the body read now, and other commands' grants are left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import { createHandlers, dispatch } from '../../../src/core/handlers.ts'
import type { HandlerContext } from '../../../src/core/handlers.ts'
import { otherVerifyGrantBodies } from '../../../src/core/handlers-verify.ts'
import { scriptsBody } from '../../../src/core/verify/discover.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import { pkg, removeDir, tempDir, writeFiles } from './helpers.ts'

let root = ''
beforeEach(() => {
  root = tempDir()
})
afterEach(() => removeDir(root))

const ARGV = ['npm', 'run', 'lint']
// A body is the package.json's scripts map.
const DOT = scriptsBody({ lint: 'eslint .' })
const SRC = scriptsBody({ lint: 'eslint src' })

function grant(argv: string[], body: string | undefined, cwdRel = '.'): NonNullable<TrustGrants['commands']> {
  return {
    [commandGrantHash({ kind: 'verify', argv, cwdRel, ...(body !== undefined ? { body } : {}) })]: {
      kind: 'verify',
      argv,
      cwdRel,
      ...(body !== undefined ? { body } : {}),
      at: 1,
    },
  }
}

function setup(grants: TrustGrants) {
  const trustSet = vi.fn((req: unknown) => Promise.resolve({ req }))
  const ctx = {
    kind: 'app',
    readOnly: false,
    config: {
      trustGet: (folder: string) =>
        Promise.resolve({ folder, folderKey: '0123456789abcdef', scopeRoot: root, grants }),
      snapshot: () => Promise.resolve({ config: { verify: { commands: [] } } }),
      trustSet,
    },
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), trustSet }
}

describe('Untrust a verify command', () => {
  it("revokes the current script's grant and the command's grants for older scripts", async () => {
    writeFiles(root, { 'package.json': pkg({ lint: 'eslint src' }) })
    const { h, trustSet } = setup({
      commands: {
        ...grant(ARGV, DOT),
        ...grant(ARGV, SRC),
        ...grant(['npm', 'run', 'test'], 'vitest run'),
        ...grant(ARGV, DOT, 'packages/app'),
      },
    })
    const r = await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv: ARGV, cwdRel: '.' } },
      trusted: false,
    })
    expect(r.ok).toBe(true)
    const command = { kind: 'command', command: { kind: 'verify', argv: ARGV, cwdRel: '.' } }
    expect(trustSet.mock.calls.map((c) => c[0])).toEqual([
      { folder: root, grant: command, trusted: false, body: DOT },
      { folder: root, grant: command, trusted: false, body: SRC },
    ])
  })

  it('a grant made now covers only the body read now (older grants are left)', async () => {
    writeFiles(root, { 'package.json': pkg({ lint: 'eslint src' }) })
    const { h, trustSet } = setup({ commands: grant(ARGV, DOT) })
    await dispatch(h, 'trust.set', {
      folder: root,
      grant: { kind: 'command', command: { kind: 'verify', argv: ARGV, cwdRel: '.' } },
      trusted: true,
    })
    expect(trustSet).toHaveBeenCalledTimes(1)
    expect(trustSet).toHaveBeenLastCalledWith(expect.objectContaining({ trusted: true, body: SRC }))
  })

  it('otherVerifyGrantBodies: same argv and cwd (normalized), another body; a bodiless grant included', () => {
    const grants: TrustGrants = {
      commands: {
        ...grant(ARGV, 'a'),
        ...grant(ARGV, undefined),
        ...grant(ARGV, 'b'),
        ...grant([...ARGV, '--fix'], 'a'),
      },
    }
    expect(otherVerifyGrantBodies(grants, { argv: ARGV, cwdRel: './' }, 'b').sort()).toEqual(['a', undefined])
    expect(otherVerifyGrantBodies({}, { argv: ARGV, cwdRel: '.' }, 'b')).toEqual([])
  })
})
