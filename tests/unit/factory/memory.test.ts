// Project memory (factory/memory.ts): reading the file capped, the run note, the update with it, the diff, and
// writing an approved update only onto the file it was made from.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUN_NOTES_HEADING,
  memoryFileOf,
  memorySkeleton,
  readMemory,
  runNote,
  sha256,
  unifiedDiff,
  withRunNote,
  writeProposal,
} from '@core/factory/memory.ts'
import type { MemoryProposalDoc } from '@core/factory/memory.ts'
import { MEMORY_RUN_NOTES_MAX } from '@shared/factory.ts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dimf-memory-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('readMemory', () => {
  it('no file: nothing, not capped', async () => {
    expect(await readMemory(join(tmp(), 'DIM_FACTORY.md'), 1000)).toEqual({
      text: null,
      exists: false,
      bytes: 0,
      capped: false,
      sha256: null,
    })
  })

  it('a short file: its text (BOM and CRLF normalized, trailing lines trimmed) and its sha256', async () => {
    const file = memoryFileOf(tmp())
    const raw = '\uFEFF# Memory\r\n- tabs\r\n\r\n'
    writeFileSync(file, raw)
    const r = await readMemory(file, 1000)
    expect(r).toMatchObject({ text: '# Memory\n- tabs', exists: true, capped: false, sha256: sha256(raw) })
    expect(r.bytes).toBe(Buffer.byteLength(raw, 'utf8'))
  })

  it('an empty file reads as no memory', async () => {
    const file = memoryFileOf(tmp())
    writeFileSync(file, '\n  \n')
    expect((await readMemory(file, 1000)).text).toBeNull()
  })

  it('a long file is cut at the cap, never in the middle of a character, with a line saying so', async () => {
    const file = memoryFileOf(tmp())
    // 2 KB of three-byte characters on one line: the cut falls inside a character.
    writeFileSync(file, '€'.repeat(700))
    const r = await readMemory(file, 1024)
    expect(r.capped).toBe(true)
    const [body, note] = (r.text ?? '').split('\n\n')
    expect(Buffer.byteLength(body ?? '', 'utf8')).toBeLessThanOrEqual(1024)
    expect(body).toMatch(/^€+$/)
    expect(note).toBe('(The rest of DIM_FACTORY.md was left out: it is longer than 1 KB.)')
  })

  it('cuts at a line end when one is near the cap', async () => {
    const file = memoryFileOf(tmp())
    writeFileSync(file, `${'a'.repeat(900)}\n${'b'.repeat(500)}`)
    const r = await readMemory(file, 1024)
    expect(r.text?.split('\n\n')[0]).toBe('a'.repeat(900))
  })
})

describe('runNote', () => {
  it('the date, run, title, outcome and the facts there are', () => {
    const at = new Date(2026, 9, 24, 12).getTime()
    expect(runNote({ displayNo: 12, title: 'Add  a\n--version flag', at, outcomeText: 'Done' })).toBe(
      '- 2026-10-24 · Run #12 · Add a --version flag · Done',
    )
    expect(
      runNote({
        displayNo: 3,
        title: 'T',
        at,
        outcomeText: 'Done',
        recipe: 'Bug fix',
        branch: 'dim/x',
        checks: { passed: ['test', 'lint'], failed: ['coverage'] },
        deployTarget: 'Netlify',
      }),
    ).toBe(
      '- 2026-10-24 · Run #3 · T · Done · recipe Bug fix · branch dim/x · checks: test, lint passed; coverage failed · deploy config for Netlify',
    )
    expect(
      runNote({ displayNo: 1, title: 'T', at, outcomeText: 'Done', checks: { passed: [], failed: [] } }),
    ).toBe('- 2026-10-24 · Run #1 · T · Done')
  })
})

describe('withRunNote', () => {
  it('no file yet: the skeleton with the note under Run notes', () => {
    const next = withRunNote(null, '- note 1')
    expect(next).toBe(`${memorySkeleton().replace(/\n+$/, '')}\n\n- note 1\n`)
    expect(next).toContain('# Project memory')
    expect(next).toContain('Dim Factory reads this file at the start of every run')
  })

  it('a file without the section gets it at the end', () => {
    expect(withRunNote('# Mine\n\nMy rules.\n', '- n')).toBe(
      `# Mine\n\nMy rules.\n\n${RUN_NOTES_HEADING}\n\n- n\n`,
    )
  })

  it('keeps the newest notes and the sections after it', () => {
    let text = `# M\n\n${RUN_NOTES_HEADING}\n\nSome words.\n\n## Later\n\nkeep me\n`
    for (let i = 1; i <= MEMORY_RUN_NOTES_MAX + 2; i++) text = withRunNote(text, `- note ${i}`)
    const lines = text.split('\n')
    const notes = lines.filter((l) => l.startsWith('- note '))
    expect(notes).toHaveLength(MEMORY_RUN_NOTES_MAX)
    expect(notes[0]).toBe('- note 3')
    expect(notes.at(-1)).toBe(`- note ${MEMORY_RUN_NOTES_MAX + 2}`)
    expect(text).toContain('Some words.')
    expect(text.endsWith('## Later\n\nkeep me\n')).toBe(true)
    expect(text.indexOf('## Later')).toBeGreaterThan(text.indexOf(notes.at(-1) ?? ''))
  })

  it('CRLF files are read as LF', () => {
    expect(withRunNote(`# M\r\n\r\n${RUN_NOTES_HEADING}\r\n`, '- n')).toBe(
      `# M\n\n${RUN_NOTES_HEADING}\n\n- n\n`,
    )
  })
})

describe('unifiedDiff', () => {
  it('a new file: every line added', () => {
    const d = unifiedDiff(null, 'a\nb\n', 'DIM_FACTORY.md')
    expect(d).toEqual({
      diff: '--- /dev/null\n+++ b/DIM_FACTORY.md\n@@ -0,0 +1,2 @@\n+a\n+b\n',
      added: 2,
      removed: 0,
    })
  })

  it('an append: three lines of context before it', () => {
    const d = unifiedDiff('1\n2\n3\n4\n5\n', '1\n2\n3\n4\n5\n6\n', 'f')
    expect(d.diff).toBe('--- a/f\n+++ b/f\n@@ -3,3 +3,4 @@\n 3\n 4\n 5\n+6\n')
    expect([d.added, d.removed]).toEqual([1, 0])
  })

  it('a change in the middle, and two far apart changes as two hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')
    const after = before.replace('l2\n', 'L2\n').replace('l18\n', 'L18\n')
    const d = unifiedDiff(before, after, 'f')
    const hunks = d.diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunks).toEqual(['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@'])
    expect(d.diff).toContain('-l2\n+L2\n')
    expect([d.added, d.removed]).toEqual([2, 2])
  })

  it('no change: headers only', () => {
    expect(unifiedDiff('a\n', 'a\n', 'f')).toEqual({ diff: '--- a/f\n+++ b/f\n', added: 0, removed: 0 })
  })
})

describe('writeProposal', () => {
  const proposal = (file: string, base: string | null, next: string): MemoryProposalDoc => ({
    id: 'r1',
    folder: '/x',
    file,
    runId: 'r1',
    displayNo: 1,
    title: 't',
    createdAt: 1,
    baseSha256: base === null ? null : sha256(base),
    next,
  })

  it('writes onto the file it was made from (or onto no file)', async () => {
    const file = memoryFileOf(tmp())
    await writeProposal(proposal(file, null, 'new\n'))
    expect(readFileSync(file, 'utf8')).toBe('new\n')
    await writeProposal(proposal(file, 'new\n', 'newer\n'))
    expect(readFileSync(file, 'utf8')).toBe('newer\n')
  })

  it('refuses a file that changed since (CONFLICT), leaving it as it is', async () => {
    const file = memoryFileOf(tmp())
    writeFileSync(file, 'yours\n')
    await expect(writeProposal(proposal(file, 'older\n', 'next\n'))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(writeProposal(proposal(file, null, 'next\n'))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(readFileSync(file, 'utf8')).toBe('yours\n')
  })
})
