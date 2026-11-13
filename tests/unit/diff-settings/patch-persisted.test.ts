// Persisted patches (history runs render the persisted .patch files): git/patch.ts
// parsePatchFiles reads a run's saved `diffs/<a>..<b>.patch` back into the rows the shadow would give (status, paths,
// modes, line counts, binary, gitlink, EOL-only, rename similarity), withoutCrOnlyHunks approximates "Ignore line
// endings" for it, and patchSectionFor finds one file's section.
import { describe, expect, it } from 'vitest'
import { parsePatchFiles, patchSectionFor, withoutCrOnlyHunks } from '../../../src/core/git/patch.ts'

const SUB_OLD = 'b'.repeat(40)
const SUB_NEW = 'c'.repeat(40)

const PATCH = [
  'diff --git a/mod.txt b/mod.txt',
  'index 1111111..2222222 100644',
  '--- a/mod.txt',
  '+++ b/mod.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  'diff --git a/eol.txt b/eol.txt',
  'index 3333333..4444444 100644',
  '--- a/eol.txt',
  '+++ b/eol.txt',
  '@@ -1,2 +1,2 @@',
  '-a',
  '-b',
  '+a\r',
  '+b\r',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 5555555..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/new file.txt b/new file.txt',
  'new file mode 100755',
  'index 0000000..6666666',
  '--- /dev/null',
  '+++ b/new file.txt\t',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+--- not a header',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 86%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  'index 7777777..8888888 100644',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/img.png b/img.png',
  'index 9999999..aaaaaaa 100644',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/sub b/sub',
  'index bbbbbbb..ccccccc 160000',
  '--- a/sub',
  '+++ b/sub',
  '@@ -1 +1 @@',
  `-Subproject commit ${SUB_OLD}`,
  `+Subproject commit ${SUB_NEW}`,
  'diff --git a/noeol.txt b/noeol.txt',
  'index ddddddd..eeeeeee 100644',
  '--- a/noeol.txt',
  '+++ b/noeol.txt',
  '@@ -1 +1 @@',
  '-last',
  '\\ No newline at end of file',
  '+last',
  'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
  'index 0123456..789abcd 100644',
  '--- "a/tab\\there.txt"',
  '+++ "b/tab\\there.txt"',
  '@@ -1 +1,2 @@',
  ' keep',
  '+more',
  '',
].join('\n')

describe('parsePatchFiles', () => {
  const rows = parsePatchFiles(PATCH)
  const by = new Map(rows.map((r) => [r.path, r]))

  it('reads one row per section in order', () => {
    expect(rows.map((r) => `${r.status} ${r.path}`)).toEqual([
      'M mod.txt',
      'M eol.txt',
      'D gone.txt',
      'A new file.txt',
      'R new/name.ts',
      'M img.png',
      'M run.sh',
      'M sub',
      'M noeol.txt',
      'M tab\there.txt',
    ])
  })

  it('counts lines by the hunk headers (a removed or added line that looks like a header still counts)', () => {
    expect(by.get('mod.txt')).toMatchObject({ added: 1, deleted: 1, oldSha: '1111111', newSha: '2222222' })
    expect(by.get('new file.txt')).toMatchObject({
      added: 2,
      deleted: 0,
      oldMode: '000000',
      newMode: '100755',
      oldSha: '0000000',
    })
    expect(by.get('gone.txt')).toMatchObject({ added: 0, deleted: 1, newMode: '000000', newSha: '0000000' })
    expect(by.get('tab\there.txt')).toMatchObject({ added: 1, deleted: 0 })
  })

  it('marks EOL-only changes, but not a change in the final newline', () => {
    expect(by.get('eol.txt')?.eolOnly).toBe(true)
    expect(by.get('mod.txt')?.eolOnly).toBe(false)
    expect(by.get('noeol.txt')?.eolOnly).toBe(false)
  })

  it('reads renames with their similarity, binaries, gitlinks and mode-only changes', () => {
    expect(by.get('new/name.ts')).toMatchObject({ status: 'R', oldPath: 'old/name.ts', similarity: 86 })
    expect(by.get('img.png')).toMatchObject({ binary: true, added: null, deleted: null, eolOnly: false })
    expect(by.get('sub')).toMatchObject({
      gitlink: true,
      oldMode: '160000',
      newMode: '160000',
      binary: false,
    })
    expect(by.get('run.sh')).toMatchObject({ oldMode: '100644', newMode: '100755', added: 0, deleted: 0 })
  })

  it('returns nothing for an empty patch', () => {
    expect(parsePatchFiles('')).toEqual([])
  })
})

describe('withoutCrOnlyHunks', () => {
  it('drops hunks whose only change is a CR, keeping real ones and the header', () => {
    const eol = patchSectionFor(PATCH, { path: 'eol.txt' })?.text ?? ''
    const stripped = withoutCrOnlyHunks(eol)
    expect(stripped).toContain('diff --git a/eol.txt b/eol.txt')
    expect(stripped).not.toContain('@@')
    expect(stripped).not.toContain('+++ ')
    const mod = patchSectionFor(PATCH, { path: 'mod.txt' })?.text ?? ''
    expect(withoutCrOnlyHunks(mod)).toBe(mod)
  })

  it('keeps a hunk mixing real and CR-only lines whole, and drops only the CR-only one of two', () => {
    const section = [
      'diff --git a/x.txt b/x.txt',
      'index 1111111..2222222 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+a\r',
      ' b',
      '@@ -10,2 +10,2 @@',
      '-old',
      '+new',
      ' tail',
      '',
    ].join('\n')
    const out = withoutCrOnlyHunks(section)
    expect(out).not.toContain('@@ -1,2 +1,2 @@')
    expect(out).toContain('@@ -10,2 +10,2 @@')
    expect(out).toContain('+new')
  })
})

describe('patchSectionFor', () => {
  it('finds a section by its exact header, a rename by either path, and a quoted path', () => {
    expect(patchSectionFor(PATCH, { path: 'gone.txt' })?.header).toBe('diff --git a/gone.txt b/gone.txt')
    expect(patchSectionFor(PATCH, { path: 'new/name.ts', oldPath: 'old/name.ts' })?.text).toContain(
      'rename to new/name.ts',
    )
    expect(patchSectionFor(PATCH, { path: 'tab\there.txt' })?.text).toContain('+more')
    expect(patchSectionFor(PATCH, { path: 'nope.txt' })).toBeUndefined()
  })
})
