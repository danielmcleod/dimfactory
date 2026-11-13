// Explain's context: the files the run changed (names and counts, never the diff), how to run the result (Run &
// Preview's detection and RUN.md), the acceptance checklist, and the gathering helper over a real folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileChange } from '@shared/ipc.ts'
import {
  EXPLAIN_FILES_MAX,
  gatherExplainInputs,
  renderChangedFiles,
  renderChecklist,
  renderHowToRun,
} from '@core/explain/context.ts'

const change = (path: string, status: FileChange['status'] = 'M', added = 1, deleted = 0): FileChange => ({
  status,
  path,
  oldMode: '100644',
  newMode: '100644',
  oldSha: 'a',
  newSha: 'b',
  added,
  deleted,
  binary: false,
  gitlink: false,
  eolOnly: false,
})

describe('renderChangedFiles', () => {
  it('lists each file with what happened to it and the line counts, never its content', () => {
    const text = renderChangedFiles([
      change('src/todo.ts', 'A', 40),
      change('README.md', 'M', 3, 1),
      { ...change('src/new.ts', 'R'), oldPath: 'src/old.ts' },
    ])
    expect(text).toBe(
      [
        '3 files changed (44 lines added, 1 removed):',
        '- added: src/todo.ts',
        '- changed: README.md',
        '- renamed: src/new.ts (from src/old.ts)',
      ].join('\n'),
    )
  })

  it('caps the list and counts the rest; null without changes', () => {
    const many = Array.from({ length: EXPLAIN_FILES_MAX + 5 }, (_, i) => change(`f${i}.ts`))
    const text = renderChangedFiles(many) ?? ''
    expect(text.split('\n')).toHaveLength(EXPLAIN_FILES_MAX + 2)
    expect(text.endsWith('- and 5 more')).toBe(true)
    expect(renderChangedFiles([])).toBeNull()
  })
})

describe('renderHowToRun', () => {
  it('names the detected commands and quotes RUN.md', () => {
    const text = renderHowToRun(
      [
        { label: 'npm run dev', kind: 'server', note: 'Opens a dev server' },
        { label: 'Serve index.html', kind: 'static', urlHint: 'http://localhost:8080' },
      ],
      { text: '# Run\nnpm install && npm run dev', truncated: false },
    )
    expect(text).toBe(
      [
        'Ways Dim Factory found to run it:',
        '- npm run dev (Opens a dev server)',
        '- Serve index.html (opens http://localhost:8080)',
        '',
        "The project's RUN.md:",
        '# Run\nnpm install && npm run dev',
      ].join('\n'),
    )
  })

  it('null when nothing says how to run it', () => {
    expect(renderHowToRun([], null)).toBeNull()
    expect(renderHowToRun([], { text: '  ', truncated: false })).toBeNull()
  })
})

describe('renderChecklist', () => {
  it('one line per criterion with its status word and evidence; null without criteria', () => {
    expect(
      renderChecklist({
        review: 'done',
        findings: false,
        counts: { met: 1, notMet: 1, unknown: 0, notChecked: 0 },
        items: [
          { id: 'AC1', text: 'Adds an item', status: 'met', evidence: 'tests pass' },
          { id: 'AC2', text: 'Clears', status: 'not-met' },
        ],
      }),
    ).toBe('- Met: Adds an item (tests pass)\n- Not met: Clears')
    expect(renderChecklist(undefined)).toBeNull()
  })
})

describe('gatherExplainInputs', () => {
  let dir = ''
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it("reads the folder's run commands and RUN.md, and survives a changes reader that fails", async () => {
    dir = await mkdtemp(join(tmpdir(), 'dimf-explain-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
    )
    await writeFile(join(dir, 'RUN.md'), 'Run `npm start`.\n')
    const out = await gatherExplainInputs(dir, () => Promise.reject(new Error('no shadow')))
    expect(out.files).toBeNull()
    expect(out.run).toContain('Ways Dim Factory found to run it:')
    expect(out.run).toContain('start')
    expect(out.run).toContain('Run `npm start`.')
    const withChanges = await gatherExplainInputs(dir, () => Promise.resolve([change('index.js', 'A', 2)]))
    expect(withChanges.files).toBe('1 file changed (2 lines added, 0 removed):\n- added: index.js')
  })

  it('an empty folder gives nothing to run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dimf-explain-'))
    const out = await gatherExplainInputs(dir, () => Promise.resolve([]))
    expect(out).toEqual({ files: null, run: null })
  })
})
