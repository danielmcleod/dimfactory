// A pass's changes against guardrails, read from a real shadow repository, and the undo that puts a protected file back.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { revertTo } from '../../../src/core/git/revert.ts'
import { openShadow } from '../../../src/core/git/shadow.ts'
import type { Shadow } from '../../../src/core/git/shadow.ts'
import { checkPassChanges } from '../../../src/core/guardrails/check.ts'
import { dependenciesIn } from '../../../src/core/guardrails/manifests.ts'
import type { GuardrailRule } from '../../../src/shared/guardrails.ts'
import { cleanupTemps, initRepo, tempDir, write } from './helpers.ts'

const RUN = '20261103T120000Z-guard'

afterEach(() => {
  cleanupTemps()
})

async function setUp(
  files: Record<string, string>,
): Promise<{ folder: string; shadow: Shadow; start: string }> {
  const folder = tempDir('guard-')
  initRepo(folder)
  for (const [path, text] of Object.entries(files)) write(folder, path, text)
  const shadow = await openShadow(folder, { home: tempDir('guard-home-') })
  const rec = await shadow.snapshot(RUN, 'S0')
  return { folder, shadow, start: rec.commit }
}

async function check(
  shadow: Shadow,
  start: string,
  rules: GuardrailRule[],
  allowAgentSettings = false,
): Promise<Awaited<ReturnType<typeof checkPassChanges>>> {
  const now = await shadow.treeNow()
  return checkPassChanges(shadow, start, now.tree, rules, allowAgentSettings)
}

describe('guardrails on a real folder', () => {
  it('finds a changed protected file and puts it back, leaving other work alone', async () => {
    const { folder, shadow, start } = await setUp({ 'migrations/1.sql': 'one\n', 'src/a.ts': 'a\n' })
    write(folder, 'migrations/1.sql', 'changed\n')
    write(folder, 'src/a.ts', 'kept\n')
    const r = await check(shadow, start, [{ kind: 'protectedFiles', paths: ['migrations/**'] }])
    expect(r.findings.map((f) => f.subject)).toEqual(['migrations/1.sql'])
    expect(r.undoPaths).toEqual(['migrations/1.sql'])
    const undone = await revertTo(shadow, start, { runId: RUN, paths: r.undoPaths })
    expect(undone.ok).toBe(true)
    expect(readFileSync(join(folder, 'migrations/1.sql'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(folder, 'src/a.ts'), 'utf8')).toBe('kept\n')
  })

  it('catches a protected file deleted however it happened, and restores it', async () => {
    const { folder, shadow, start } = await setUp({ 'migrations/1.sql': 'one\n' })
    rmSync(join(folder, 'migrations/1.sql'))
    const r = await check(shadow, start, [{ kind: 'protectedFiles', paths: ['migrations/**'] }])
    expect(r.findings).toHaveLength(1)
    await revertTo(shadow, start, { runId: RUN, paths: r.undoPaths })
    expect(existsSync(join(folder, 'migrations/1.sql'))).toBe(true)
  })

  it('removes a settings file a run added, with no rule set', async () => {
    const { folder, shadow, start } = await setUp({ 'a.txt': 'a\n' })
    write(folder, '.claude/settings.json', '{"permissions":{"allow":["Bash(*)"]}}\n')
    const r = await check(shadow, start, [])
    expect(r.findings[0]).toMatchObject({ self: true, subject: '.claude/settings.json' })
    await revertTo(shadow, start, { runId: RUN, paths: r.undoPaths })
    expect(existsSync(join(folder, '.claude/settings.json'))).toBe(false)
  })

  it('takes the old path along when a protected file is renamed, so both come back', async () => {
    const body = 'a line long enough for git to see this as a rename\n'.repeat(5)
    const { folder, shadow, start } = await setUp({ 'keep/data.txt': body })
    rmSync(join(folder, 'keep/data.txt'))
    write(folder, '.codex/data.txt', body)
    const r = await check(shadow, start, [])
    expect(r.undoPaths.sort()).toEqual(['.codex/data.txt', 'keep/data.txt'])
    await revertTo(shadow, start, { runId: RUN, paths: r.undoPaths })
    expect(readFileSync(join(folder, 'keep/data.txt'), 'utf8')).toBe(body)
    expect(existsSync(join(folder, '.codex/data.txt'))).toBe(false)
  })

  it('leaves settings files alone under the explicit exception', async () => {
    const { folder, shadow, start } = await setUp({ 'a.txt': 'a\n' })
    write(folder, '.codex/config.toml', 'x = 1\n')
    expect((await check(shadow, start, [], true)).findings).toEqual([])
  })

  it('finds a test marked as skipped from the lines the change added', async () => {
    const { folder, shadow, start } = await setUp({ 'src/a.test.ts': "it('x', () => {})\n" })
    write(folder, 'src/a.test.ts', "it.skip('x', () => {})\n")
    const r = await check(shadow, start, [{ kind: 'testsNotWeakened' }])
    expect(r.findings[0]).toMatchObject({
      kind: 'testsNotWeakened',
      onBreak: 'ask',
      subject: 'src/a.test.ts',
    })
    expect(r.undoPaths).toEqual([])
  })

  it('names a new dependency, and not one that was already there', async () => {
    const before = JSON.stringify({ dependencies: { react: '19.0.0' } })
    const { folder, shadow, start } = await setUp({ 'package.json': before })
    write(folder, 'package.json', JSON.stringify({ dependencies: { react: '19.1.0', 'left-pad': '1.0.0' } }))
    const r = await check(shadow, start, [{ kind: 'newDependencies' }])
    expect(r.findings.map((f) => f.subject)).toEqual(['left-pad'])
  })

  it('counts changes for a size limit', async () => {
    const { folder, shadow, start } = await setUp({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    write(folder, 'a.txt', 'a\nb\nc\n')
    write(folder, 'b.txt', 'x\n')
    const r = await check(shadow, start, [{ kind: 'maxChanges', files: 1, lines: 2 }])
    expect(r.findings.map((f) => f.subject)).toEqual(['2 files', '4 lines'])
  })

  it('finds nothing in an ordinary change', async () => {
    const { folder, shadow, start } = await setUp({ 'src/a.ts': 'a\n' })
    write(folder, 'src/a.ts', 'b\n')
    write(folder, 'CLAUDE.md', 'notes\n')
    const r = await check(shadow, start, [
      { kind: 'protectedFiles', paths: ['migrations/**'] },
      { kind: 'testsNotWeakened' },
    ])
    expect(r.findings).toEqual([])
  })
})

describe('reading manifests', () => {
  it('reads each common manifest', () => {
    expect(dependenciesIn('package.json', '{"devDependencies":{"Vite":"1"}}')).toEqual(['vite'])
    expect(dependenciesIn('requirements.txt', 'flask==2\n# c\n-r other.txt\nrequests>=2\n')).toEqual([
      'flask',
      'requests',
    ])
    expect(
      dependenciesIn('go.mod', 'module m\nrequire (\n  github.com/a/b v1.0.0\n)\nrequire c.io/d v2.0.0\n'),
    ).toEqual(['c.io/d', 'github.com/a/b'])
    expect(dependenciesIn('Cargo.toml', '[package]\nname = "x"\n[dependencies]\nserde = "1"\n')).toEqual([
      'serde',
    ])
    expect(dependenciesIn('pyproject.toml', '[project]\ndependencies = ["flask>=2", "rich"]\n')).toEqual([
      'flask',
      'rich',
    ])
  })

  it('reads a broken manifest as naming nothing', () => {
    expect(dependenciesIn('package.json', '{ not json')).toEqual([])
    expect(dependenciesIn('README.md', 'x')).toEqual([])
  })
})
