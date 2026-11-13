import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkAllowlisted,
  isUserOnlyPath,
  parseJsonPointer,
  validatePatchOps,
} from '../../../src/core/config/patch.ts'
import { patchConfig } from '../../../src/core/config/save.ts'
import { DimFactoryError } from '../../../src/core/errors.ts'
import type { JsonPatchOp } from '../../../src/shared/failure.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

const replace = (path: string, value: unknown): JsonPatchOp => ({ op: 'replace', path, value })

describe('parseJsonPointer', () => {
  it('parses RFC 6901 pointers and rejects malformed ones', () => {
    expect(parseJsonPointer('')).toEqual([])
    expect(parseJsonPointer('/vendors/claude/flagMap/--a~1b~0c')).toEqual([
      'vendors',
      'claude',
      'flagMap',
      '--a/b~c',
    ])
    expect(parseJsonPointer('profile')).toBeNull()
    expect(parseJsonPointer('/a~2')).toBeNull()
    expect(parseJsonPointer('/a~')).toBeNull()
  })
})

describe('config_patch allowlist', () => {
  it.each([
    ['/profile', 'fast'],
    ['/passes/implement/vendor', 'claude'],
    ['/passes/fix/model', null],
    ['/passes/plan/enabled', false],
    ['/passes/review/enabled', true],
    ['/passes/critic/enabled', false],
    ['/passes/fix/reuseSession', false],
    ['/timeouts/stallMs', 600_000],
    ['/timeouts/askMs', 60_000],
    ['/isolation/branch', 'runBranch'],
    ['/isolation/worktree/install', 'never'],
    ['/vendors/codex/extraArgs', ['--verbose']],
    ['/vendors/codex/extraArgs/-', '--verbose'],
    ['/vendors/claude/flagMap/--permission-mode', '--perm-mode'],
  ])('allows %s', (path, value) => {
    const r = validatePatchOps([replace(path, value)], { scope: 'user' })
    expect(r.rejected).toEqual([])
    expect(r.ok).toBe(true)
  })

  it.each([
    ['/vendors/claude/path', 'C:\\evil\\claude.exe', /Executable paths/],
    ['/verify/commands', [{ name: 'x', run: 'rm -rf /' }], /Verify commands/],
    ['/verify/enabled', true, /Verify commands/],
    ['/isolation/worktree/installCommand', 'npm i evil', /Install commands/],
    ['/auto', true, /Auto mode/],
    ['/passes/implement/mode', 'full', /mode escalation/],
    ['/passes/review/mode', 'autoedit', /mode escalation/],
    ['/profiles/mine/implement/mode', 'autoedit', /mode escalation/],
    ['/passes/implement/enabled', false, /Only Plan, Review and Critic/],
    ['/passes/review', { mode: 'full' }, /cannot be changed/],
    ['/passes/review/promptTemplate', 'x', /cannot be changed/],
    ['/vendors/claude/env', { PATH: 'x' }, /cannot be changed/],
    ['/isolation/mode', 'worktree', /cannot be changed/],
    ['/isolation/worktree/install', 'auto', /escalation/],
    ['/vendors/claude/extraArgs', ['--dangerously-skip-permissions'], /mode escalation/],
    ['/vendors/codex/extraArgs/-', '--full-auto', /mode escalation/],
    ['/vendors/gemini/flagMap/--approval-mode', '--yolo', /mode escalation/],
    ['/vendors/claude/flagMap/--model', 'not a flag', /look like a flag/],
    ['/ui/theme', 'dark', /cannot be changed/],
  ])('rejects %s', (path, value, reason) => {
    const r = validatePatchOps([replace(path, value)], { scope: 'user' })
    expect(r.ok).toBe(false)
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]?.kind).toBe('forbidden')
    expect(r.rejected[0]?.reason).toMatch(reason)
  })

  it('re-validates extraArgs and flagMap keys against managedFlags', () => {
    const managedFlags = { claude: ['--permission-mode', '--model'] }
    const args = validatePatchOps([replace('/vendors/claude/extraArgs', ['--model=opus'])], {
      scope: 'user',
      managedFlags,
    })
    expect(args.rejected[0]?.reason).toMatch(/managed by Dim Factory/)
    const key = validatePatchOps([replace('/vendors/claude/flagMap/--verbose', '--loud')], {
      scope: 'user',
      managedFlags,
    })
    expect(key.rejected[0]?.reason).toMatch(/not a flag Dim Factory manages/)
  })

  it('rejects malformed ops and unsafe segments as invalid', () => {
    const r = validatePatchOps(
      [
        { op: 'move', path: '/profile', from: '/x' },
        { op: 'replace', path: '/profile' },
        { op: 'replace', path: 'profile', value: 'x' },
        { op: 'replace', path: '', value: {} },
        { op: 'add', path: '/vendors/__proto__/extraArgs', value: [] },
        { op: 'replace', path: '/profile', value: 'x', extra: 1 },
      ],
      { scope: 'user', allowlist: false },
    )
    expect(r.rejected.map((x) => x.kind)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
    ])
  })

  it('test ops are never blocked by the allowlist (they write nothing)', () => {
    expect(
      validatePatchOps([{ op: 'test', path: '/vendors/claude/path', value: null }], { scope: 'user' }).ok,
    ).toBe(true)
  })

  it('checkAllowlisted matches the config_patch allowlist exactly', () => {
    expect(checkAllowlisted(['timeouts', 'nope']).ok).toBe(false)
    expect(checkAllowlisted(['passes', 'nope', 'model']).ok).toBe(false)
    expect(checkAllowlisted(['vendors', 'Bad_Id', 'extraArgs']).ok).toBe(false)
    expect(checkAllowlisted(['vendors', 'claude', 'flagMap']).ok).toBe(false)
  })
})

describe('user-only routing', () => {
  it('forces user-only paths to the user scope and drops a project scope as unsafe', () => {
    expect(isUserOnlyPath(['vendors', 'claude'])).toBe(true)
    expect(isUserOnlyPath(['selfHeal', 'enabled'])).toBe(true)
    expect(isUserOnlyPath(['passes'])).toBe(false)
    const ops = [replace('/vendors/codex/extraArgs', ['-v']), replace('/profile', 'fast')]
    const r = validatePatchOps(ops, { scope: 'project' })
    expect(r.routed.user).toEqual([ops[0]])
    expect(r.routed.project).toEqual([ops[1]])
    expect(r.forcedToUser).toEqual([ops[0]])
    const asUser = validatePatchOps(ops, { scope: 'user' })
    expect(asUser.routed.user).toEqual(ops)
    expect(asUser.forcedToUser).toEqual([])
  })

  it('applies to Settings writes too (allowlist off)', () => {
    const r = validatePatchOps([replace('/ui/theme', 'dark')], { scope: 'project', allowlist: false })
    expect(r.ok).toBe(true)
    expect(r.routed.user).toHaveLength(1)
    expect(r.forcedToUser).toHaveLength(1)
  })
})

describe('patchConfig + allowlist', () => {
  it('refuses the whole patch (FORBIDDEN) and writes nothing when any op is outside the allowlist', async () => {
    await writeFile(join(home(), 'dimfactory.json'), '{}\n')
    let err: unknown
    try {
      await patchConfig({
        home: home(),
        scope: 'user',
        ops: [replace('/profile', 'fast'), replace('/vendors/claude/path', 'C:\\x.exe')],
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('FORBIDDEN')
    expect(await readdir(home())).toEqual(['dimfactory.json'])
  })

  it('Settings (allowlist off) may write any schema-valid key', async () => {
    const out = await patchConfig({
      home: home(),
      scope: 'user',
      allowlist: false,
      ops: [replace('/gates/afterPlan', false), replace('/vendors/claude/path', 'C:\\tools\\claude.exe')],
    })
    expect(out.changed).toBe(true)
  })
})
