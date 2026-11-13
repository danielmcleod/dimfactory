// Suggestions read the names in a project's folder, bounded, and leave out what no person wrote.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { guardrailSuggestions, projectPaths } from '@core/guardrails/suggest.ts'

const root = mkdtempSync(join(tmpdir(), 'guard-suggest-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const put = (rel: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), '')
}

describe('suggestions for a project', () => {
  it('reads the names, skipping dependency folders', async () => {
    put('migrations/1.sql')
    put('.github/workflows/ci.yml')
    put('node_modules/x/migrations/2.sql')
    const paths = await projectPaths(root)
    expect(paths.sort()).toEqual(['.github/workflows/ci.yml', 'migrations/1.sql'])
  })

  it('offers a rule for each with a reason', async () => {
    const got = await guardrailSuggestions(root)
    expect(got.map((s) => s.rule)).toEqual([
      { kind: 'protectedFiles', paths: ['migrations/**'] },
      { kind: 'protectedFiles', paths: ['.github/**'] },
    ])
  })

  it('offers nothing for a missing folder', async () => {
    expect(await guardrailSuggestions(join(root, 'nope'))).toEqual([])
  })
})
