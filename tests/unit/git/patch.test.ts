// Prompt-patch post-processing and diff-tree parsers: lockfile collapsing, EOL-only
// sections (2.17 header-only and newer omitted forms), cap stubs, quoting.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  PROMPT_PATCH_MAX_BYTES,
  buildPromptPatch,
  collapseReason,
  expectedDiffHeader,
  isLockfile,
  isMinifiedOrMap,
  mergeDiff,
  parseNumstatZ,
  parseRawZ,
  promptPatchCap,
  quoteGitPath,
  splitPatchSections,
  unquoteGitPath,
} from '../../../src/core/git/patch.ts'
import type { PromptPatchFile } from '../../../src/core/git/patch.ts'
import type { FileChange } from '../../../src/shared/ipc.ts'

const Z = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

function change(path: string, over: Partial<FileChange> = {}): FileChange {
  return {
    status: 'M',
    path,
    oldMode: '100644',
    newMode: '100644',
    oldSha: A,
    newSha: B,
    added: 1,
    deleted: 1,
    binary: false,
    gitlink: false,
    eolOnly: false,
    ...over,
  }
}

function file(c: FileChange, generated = false): PromptPatchFile {
  return { change: c, added: c.added, deleted: c.deleted, generated }
}

function section(path: string, body: string, oldPath = path): string {
  return (
    `diff --git a/${oldPath} b/${path}\nindex 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${path}\n` +
    `@@ -1 +1 @@\n${body}`
  )
}

describe('diff-tree -z parsers', () => {
  it('parses --raw records incl. renames, adds, deletes and gitlinks', () => {
    const out =
      `:100644 100644 ${A} ${B} M\0mod.txt\0` +
      `:000000 100644 ${Z} ${B} A\0new file.txt\0` +
      `:100644 000000 ${A} ${Z} D\0gone.txt\0` +
      `:100644 100644 ${A} ${B} R086\0old/name.ts\0new/name.ts\0` +
      `:160000 160000 ${A} ${B} M\0sub\0`
    expect(parseRawZ(out)).toEqual([
      { status: 'M', oldMode: '100644', newMode: '100644', oldSha: A, newSha: B, path: 'mod.txt' },
      { status: 'A', oldMode: '000000', newMode: '100644', oldSha: Z, newSha: B, path: 'new file.txt' },
      { status: 'D', oldMode: '100644', newMode: '000000', oldSha: A, newSha: Z, path: 'gone.txt' },
      {
        status: 'R',
        score: 86,
        oldMode: '100644',
        newMode: '100644',
        oldSha: A,
        newSha: B,
        path: 'new/name.ts',
        oldPath: 'old/name.ts',
      },
      { status: 'M', oldMode: '160000', newMode: '160000', oldSha: A, newSha: B, path: 'sub' },
    ])
  })

  it('parses --numstat records incl. binary "-" and rename triples', () => {
    const out =
      '3\t1\tmod.txt\0-\t-\timg.png\0' + '0\t0\t\0old/name.ts\0new/name.ts\0' + '2\t0\tpath\twith tab\0'
    expect(parseNumstatZ(out)).toEqual([
      { added: 3, deleted: 1, path: 'mod.txt' },
      { added: null, deleted: null, path: 'img.png' },
      { added: 0, deleted: 0, path: 'new/name.ts', oldPath: 'old/name.ts' },
      { added: 2, deleted: 0, path: 'path\twith tab' },
    ])
  })

  it('merges raw + numstat; EOL-only when the CR-ignoring numstat drops the file or reports 0/0', () => {
    const raw =
      `:100644 100644 ${A} ${B} M\0eol-a.txt\0` +
      `:100644 100644 ${A} ${B} M\0eol-b.txt\0` +
      `:100644 100644 ${A} ${B} M\0real.txt\0` +
      `:100644 100644 ${A} ${B} M\0img.png\0` +
      `:160000 160000 ${A} ${B} M\0sub\0`
    const num =
      '5\t5\teol-a.txt\0' + '2\t2\teol-b.txt\0' + '4\t4\treal.txt\0' + '-\t-\timg.png\0' + '1\t1\tsub\0'
    // git ≥ 2.2x omits CR-only files; 2.17 prints 0 0
    const numCr = '0\t0\teol-b.txt\0' + '1\t1\treal.txt\0' + '-\t-\timg.png\0' + '1\t1\tsub\0'
    const { changes, promptStats } = mergeDiff(raw, num, numCr)
    const by = new Map(changes.map((c) => [c.path, c]))
    expect(by.get('eol-a.txt')).toMatchObject({ eolOnly: true, added: 5, deleted: 5 })
    expect(by.get('eol-b.txt')).toMatchObject({ eolOnly: true })
    expect(by.get('real.txt')).toMatchObject({ eolOnly: false, added: 4, deleted: 4 })
    expect(promptStats.get('real.txt')).toEqual({ added: 1, deleted: 1 })
    expect(by.get('img.png')).toMatchObject({ binary: true, added: null, deleted: null, eolOnly: false })
    expect(by.get('sub')).toMatchObject({ gitlink: true, binary: false, eolOnly: false })
  })
})

describe('path quoting', () => {
  it('quotes like git with core.quotepath=false (only ", \\ and control characters)', () => {
    expect(quoteGitPath('a/plain name.txt')).toBe('a/plain name.txt')
    expect(quoteGitPath('a/ünïcödé.txt')).toBe('a/ünïcödé.txt')
    expect(quoteGitPath('a/tab\there')).toBe('"a/tab\\there"')
    expect(quoteGitPath('a/quote"x')).toBe('"a/quote\\"x"')
    expect(quoteGitPath('a/back\\slash')).toBe('"a/back\\\\slash"')
    expect(quoteGitPath('a/bell\u0007')).toBe('"a/bell\\a"')
    expect(quoteGitPath('a/esc\u001b')).toBe('"a/esc\\033"')
    for (const p of ['a/tab\there', 'a/quote"x', 'a/back\\slash', 'a/esc\u001bü', 'plain']) {
      expect(unquoteGitPath(quoteGitPath(p))).toBe(p)
    }
  })

  it('builds the exact diff --git header for plain, quoted and renamed paths', () => {
    expect(expectedDiffHeader({ path: 'x y.txt' })).toBe('diff --git a/x y.txt b/x y.txt')
    expect(expectedDiffHeader({ path: 'new.txt', oldPath: 'old.txt' })).toBe('diff --git a/old.txt b/new.txt')
    expect(expectedDiffHeader({ path: 'q"t' })).toBe('diff --git "a/q\\"t" "b/q\\"t"')
  })
})

describe('collapse rules and cap', () => {
  it('recognizes lockfiles, minified files, maps, generated and binaries', () => {
    for (const p of [
      'package-lock.json',
      'web/pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'Cargo.lock',
      'go.sum',
    ]) {
      expect(isLockfile(p), p).toBe(true)
    }
    expect(isLockfile('src/lock.ts')).toBe(false)
    expect(isMinifiedOrMap('dist/app.min.js')).toBe(true)
    expect(isMinifiedOrMap('dist/app.js.map')).toBe(true)
    expect(isMinifiedOrMap('src/mini.ts')).toBe(false)
    expect(collapseReason(change('img.png', { binary: true }), false)).toBe('binary')
    expect(collapseReason(change('gen/x.ts'), true)).toBe('generated')
    expect(collapseReason(change('src/x.ts'), false)).toBeNull()
  })

  it('caps at min(150 KB, 0.25 × contextWindow × 3.5), unknown window → 200,000', () => {
    expect(promptPatchCap()).toBe(PROMPT_PATCH_MAX_BYTES)
    expect(promptPatchCap(null)).toBe(promptPatchCap(DEFAULT_CONTEXT_WINDOW))
    expect(promptPatchCap(32_000)).toBe(28_000)
    expect(promptPatchCap(1_000_000)).toBe(150 * 1024)
    expect(promptPatchCap(-5)).toBe(PROMPT_PATCH_MAX_BYTES)
  })
})

describe('buildPromptPatch', () => {
  it('collapses a lockfile to one stat line and keeps real sections', () => {
    const lock = change('package-lock.json', { added: 120, deleted: 80 })
    const src = change('src/a.ts')
    const raw = section('package-lock.json', '-old\n+new\n'.repeat(50)) + section('src/a.ts', '-a\n+b\n')
    const out = buildPromptPatch(raw, [file(lock), file(src)], { capBytes: 100_000 })
    expect(out.text).toBe(
      'Files changed (2):\n' +
        'M package-lock.json +120 -80 [collapsed: lockfile]\n' +
        'M src/a.ts +1 -1\n' +
        '\n' +
        '[collapsed: package-lock.json +120 -80 (lockfile)]\n' +
        section('src/a.ts', '-a\n+b\n'),
    )
    expect(out.collapsed).toEqual(['package-lock.json'])
    expect(out.omitted).toEqual([])
    expect(out.truncated).toBe(false)
    expect(out.bytes).toBe(Buffer.byteLength(out.text))
  })

  it('lists EOL-only files separately and drops their empty sections (2.17 header-only form)', () => {
    const eol = change('docs/readme.md', { added: 3, deleted: 3, eolOnly: true })
    const src = change('src/a.ts')
    const raw =
      'diff --git a/docs/readme.md b/docs/readme.md\nindex 1111111..2222222 100644\n' +
      section('src/a.ts', '-a\n+b\n')
    const files = [{ change: eol, added: 0, deleted: 0, generated: false }, file(src)]
    const out = buildPromptPatch(raw, files, { capBytes: 100_000 })
    expect(out.eolOnly).toEqual(['docs/readme.md'])
    expect(out.text).toContain('M docs/readme.md (line endings only)\n')
    expect(out.text).toContain('\nLine endings only (1): docs/readme.md\n')
    expect(out.text).not.toContain('diff --git a/docs/readme.md')
    // newer git omits the section entirely: same result
    const newer = buildPromptPatch(section('src/a.ts', '-a\n+b\n'), files, { capBytes: 100_000 })
    expect(newer.text).toBe(out.text)
  })

  it('keeps a rename whose content only changed line endings', () => {
    const ren = change('new.txt', { status: 'R', oldPath: 'old.txt', added: 2, deleted: 2, eolOnly: true })
    const raw =
      'diff --git a/old.txt b/new.txt\nsimilarity index 50%\nrename from old.txt\nrename to new.txt\n'
    const out = buildPromptPatch(raw, [{ change: ren, added: 0, deleted: 0, generated: false }], {
      capBytes: 100_000,
    })
    expect(out.text).toContain('R old.txt -> new.txt (line endings only)')
    expect(out.text).toContain('rename from old.txt\nrename to new.txt\n')
  })

  it('replaces the largest sections with stubs until the patch fits', () => {
    const big = change('big.ts', { added: 400, deleted: 0 })
    const mid = change('mid.ts', { added: 40, deleted: 0 })
    const small = change('small.ts')
    const raw =
      section('big.ts', '+x\n'.repeat(400)) +
      section('mid.ts', '+y\n'.repeat(40)) +
      section('small.ts', '-a\n+b\n')
    const files = [file(big), file(mid), file(small)]
    const full = buildPromptPatch(raw, files, { capBytes: 100_000 })
    const cap = full.bytes - 900
    const out = buildPromptPatch(raw, files, { capBytes: cap })
    expect(out.omitted).toEqual(['big.ts'])
    expect(out.text).toContain('[diff omitted: big.ts +400 -0 — read the file if needed]\n')
    expect(out.text).toContain(section('mid.ts', '+y\n'.repeat(40)))
    expect(out.bytes).toBeLessThanOrEqual(cap)
    const afterBig = buildPromptPatch(raw, files, { capBytes: out.bytes }).bytes
    const tighter = buildPromptPatch(raw, files, { capBytes: afterBig - 50 })
    expect(tighter.omitted).toEqual(['big.ts', 'mid.ts'])
    expect(tighter.bytes).toBeLessThanOrEqual(afterBig - 50)
    expect(tighter.truncated).toBe(false)
  })

  it('cuts the text when even stubs do not fit, and never exceeds the cap', () => {
    const files = Array.from({ length: 50 }, (_, i) => file(change(`some/long/path/number-${i}.ts`)))
    const raw = files.map((f) => section(f.change.path, '-a\n+b\n')).join('')
    const out = buildPromptPatch(raw, files, { capBytes: 500 })
    expect(out.truncated).toBe(true)
    expect(out.bytes).toBeLessThanOrEqual(500)
    expect(out.text).toContain('[diff truncated')
  })

  it('collapses binaries and generated files, marks gitlinks, keeps unmatched sections', () => {
    const bin = change('logo.png', { binary: true, added: null, deleted: null })
    const gen = change('gen/api.ts', { added: 10, deleted: 2 })
    const sub = change('vendor/lib', { gitlink: true, oldMode: '160000', newMode: '160000' })
    const raw =
      'diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n' +
      section('gen/api.ts', '-g\n+h\n') +
      'diff --git a/vendor/lib b/vendor/lib\nindex 1111111..2222222 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit a\n+Subproject commit b\n' +
      section('mystery.txt', '-m\n+n\n')
    const out = buildPromptPatch(raw, [file(bin), file(gen, true), file(sub)], { capBytes: 100_000 })
    expect(out.collapsed).toEqual(['logo.png', 'gen/api.ts'])
    expect(out.text).toContain('[collapsed: logo.png (binary) (binary)]')
    expect(out.text).toContain('[collapsed: gen/api.ts +10 -2 (generated)]')
    expect(out.text).toContain('M vendor/lib (submodule)')
    expect(out.text).toContain('+Subproject commit b')
    expect(out.text).toContain('diff --git a/mystery.txt b/mystery.txt')
  })

  it('splits sections only at column-0 diff headers and keeps CRLF content', () => {
    const raw = 'diff --git a/x b/x\n@@ -1 +1 @@\n-diff --git a/fake b/fake\r\n+y\r\ndiff --git a/z b/z\n'
    const s = splitPatchSections(raw)
    expect(s.map((x) => x.header)).toEqual(['diff --git a/x b/x', 'diff --git a/z b/z'])
    expect(s[0]?.text).toContain('-diff --git a/fake b/fake\r\n')
    expect(s[0]?.hasHunks).toBe(true)
    expect(s[1]?.hasHunks).toBe(false)
  })
})
