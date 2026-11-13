// The grounding checks as pure tables: the claims a message makes, the evidence a pass's tools leave, the imports in
// added lines and whether they resolve, the dependencies a manifest gained, and each check's findings.
import { describe, expect, it } from 'vitest'
import { checkClaims, pathRefs } from '@core/grounding/claims.ts'
import {
  claimsVsEvidence,
  driftNotes,
  editFindings,
  fixContradictions,
  ghostPaths,
  importFindings,
  packageFindings,
  runGroundingChecks,
} from '@core/grounding/checks.ts'
import type { GroundingInput } from '@core/grounding/checks.ts'
import { commandKind, editPaths, newGroundingTrack, noteTool } from '@core/grounding/evidence.ts'
import type { GroundingTrack } from '@core/grounding/evidence.ts'
import { hallucinationSignals } from '@core/grounding/hallucination.ts'
import type { ImportFacts } from '@core/grounding/imports.ts'
import { importedNames, importsOf, importResolves } from '@core/grounding/imports.ts'
import { addedLinesByFile } from '@core/grounding/patch.ts'
import type { Finding } from '@shared/findings.ts'

const track = (o: Partial<GroundingTrack> = {}): GroundingTrack => ({ ...newGroundingTrack(), ...o })

const input = (o: Partial<GroundingInput> = {}): GroundingInput => ({
  step: 'implement',
  finalText: '',
  changed: new Set(),
  files: new Set(),
  added: new Map(),
  ...o,
})

describe('claims: paths a message names', () => {
  it.each([
    ['Updated `src/a.ts` to add the flag.', 'src/a.ts', true, false],
    ['- Created src/cli/version.ts', 'src/cli/version.ts', true, false],
    ['I deleted old/legacy.js', 'old/legacy.js', true, true],
    ['See `src/a.ts:12` for the entry point.', 'src/a.ts', false, false],
    ['Next step: you could update README.md.', 'README.md', false, false],
    ['I did not change config.json.', 'config.json', false, false],
  ])('%s', (text, path, claim, deleted) => {
    expect(pathRefs(text)).toEqual([expect.objectContaining({ path, claim, deleted })])
  })

  it.each([
    ['Bumped to version 1.2.3 (see https://example.com/a.js).'],
    ['e.g. this works'],
    ['```\nupdated src/in-a-fence.ts\n```'],
    ['Set the env var /usr/local/bin/tool.sh'],
  ])('no path in %s', (text) => {
    expect(pathRefs(text)).toEqual([])
  })
})

describe('claims: checks a message says it ran', () => {
  it.each([
    ['All tests pass.', ['tests']],
    ['I ran the tests and they are green.', ['tests']],
    ['12 passed', ['tests']],
    ['The build succeeds and typecheck is clean.', ['build']],
    ['tsc reports no errors', ['build']],
    ['I ran `npm run lint`.', ['build']],
    ['I ran the migration script.', ['ran']],
    ['The tests should pass now.', []],
    ['I could not run the tests.', []],
    ['Tests do not pass yet.', []],
  ])('%s', (text, kinds) => {
    expect(checkClaims(text).map((c) => c.kind)).toEqual(kinds)
  })
})

describe('evidence: what tools leave', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run test:unit', 'test'],
    ['npx vitest run src', 'test'],
    ['python -m pytest -q', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['npm run build', 'build'],
    ['npx tsc --noEmit', 'build'],
    ['cargo check', 'build'],
    ['go vet ./...', 'build'],
    ['ls -la', 'other'],
    ['git status', 'other'],
  ] as const)('%s is %s', (cmd, kind) => {
    expect(commandKind(cmd)).toBe(kind)
  })

  it('edit summaries: one path, or Codex lettered lists', () => {
    expect(editPaths('src/a.ts')).toEqual({ all: ['src/a.ts'], modified: ['src/a.ts'] })
    expect(editPaths('M src/a.ts, A src/b.ts, R x.ts -> y.ts')).toEqual({
      all: ['src/a.ts', 'src/b.ts', 'y.ts'],
      modified: ['src/a.ts', 'x.ts'],
    })
  })

  it('counts shells, failed edits, reads and edits without a read', () => {
    const t = newGroundingTrack()
    noteTool(t, { type: 'tool', name: 'Bash', summary: 'npm test', phase: 'start', fp: '1' })
    noteTool(t, { type: 'tool', name: 'Bash', summary: 'npm run build', phase: 'start', fp: '2' })
    noteTool(t, { type: 'tool', name: 'shell', summary: 'Read src/known.ts', phase: 'start', fp: '3' })
    // A start without a fingerprint (a subagent's progress row) does not count.
    noteTool(t, { type: 'tool', name: 'Bash', summary: 'npm test', phase: 'start' })
    noteTool(t, { type: 'tool', name: 'Edit', summary: 'src/a.ts', phase: 'end', status: 'failed' })
    noteTool(t, { type: 'tool', name: 'Edit', summary: 'src/a.ts', phase: 'end', status: 'failed' })
    noteTool(t, {
      type: 'tool',
      name: 'edit',
      summary: 'M src/known.ts, M src/other.ts',
      phase: 'start',
      fp: '4',
    })
    expect(t).toEqual({
      shells: 2,
      tests: 1,
      builds: 1,
      failedEdits: { 'src/a.ts': 2 },
      reads: ['src/known.ts'],
      unreadEdits: ['src/other.ts'],
    })
  })
})

describe('check 1: ghost paths', () => {
  it.each([
    ['Updated `src/a.ts`.', ['src/a.ts'], ['src/a.ts'], []],
    [
      'Updated `src/gone.ts`.',
      [],
      [],
      ['must:The AI said it changed `src/gone.ts`, but there is no such file.'],
    ],
    [
      'Updated `src/b.ts`.',
      [],
      ['src/b.ts'],
      ['must:The AI said it changed `src/b.ts`, but Implement did not change it.'],
    ],
    [
      'Deleted `src/c.ts`.',
      [],
      ['src/c.ts'],
      ['must:The AI said it deleted `src/c.ts`, but it is still there.'],
    ],
    ['Updated index.ts.', ['src/index.ts'], ['src/index.ts'], []],
    [
      'The handler lives in `src/missing.ts`.',
      [],
      [],
      ['should:The AI mentions `src/missing.ts`, but there is no such file.'],
    ],
    ['The handler lives in `src/here.ts`.', [], ['src/here.ts'], []],
  ])('%s', (finalText, changed, files, want) => {
    const out = ghostPaths(input({ finalText, changed: new Set(changed), files: new Set(files) }))
    expect(out.map((f) => `${f.severity}:${f.title}`)).toEqual(want)
    for (const f of out) expect(f.source).toBe('grounding')
  })
})

describe('check 2: claims against evidence and Verify', () => {
  const verifyFail = [{ name: 'test', argv: ['npm', 'test'], status: 'fail' as const }]
  it.each([
    ['All tests pass.', track(), undefined, ['The AI said it ran the tests, but none ran.']],
    ['All tests pass.', track({ shells: 1, tests: 1 }), undefined, []],
    [
      'All tests pass.',
      track({ shells: 1, tests: 1 }),
      verifyFail,
      ["The AI said the tests pass, but Verify's `test` failed."],
    ],
    [
      'The build succeeds.',
      track({ shells: 1 }),
      undefined,
      ['The AI said the build succeeds, but it never ran a build.'],
    ],
    ['The build succeeds.', track({ shells: 1, builds: 1 }), undefined, []],
    ['I ran the seed script.', track(), undefined, ['The AI said it ran a command, but it ran none.']],
    ['I ran the seed script.', track({ shells: 1 }), undefined, []],
    // No evidence recorded: only Verify can contradict.
    ['All tests pass.', undefined, undefined, []],
  ])('%s', (finalText, evidence, verify, want) => {
    const out = claimsVsEvidence(input({ finalText, evidence, verify }))
    expect(out.map((f) => f.title)).toEqual(want)
    for (const f of out) expect(f.severity).toBe('must')
  })
})

const facts = (o: Partial<ImportFacts> = {}): ImportFacts => ({
  files: new Set(['src/util.ts', 'src/lib/index.ts', 'app/models.py', 'app/__init__.py', 'src/config.rs']),
  npm: {
    manifest: true,
    names: new Set(['react', '@scope/pkg']),
    aliases: ['@/', '@shared/'],
    installed: () => false,
  },
  python: { manifest: true, names: new Set(['requests', 'pyyaml', 'scikit-learn']) },
  go: { module: 'example.com/me/app', requires: ['github.com/pkg/errors'] },
  rust: { manifest: true, crates: new Set(['serde', 'my_crate']) },
  ...o,
})

describe('check 3: imports in added lines', () => {
  it.each([
    ['src/a.ts', "import { x } from './util.js'", true],
    ['src/a.ts', "import x from './lib'", true],
    ['src/a.ts', "import x from './nope'", false],
    ['src/a.ts', "import fs from 'node:fs'", true],
    ['src/a.ts', "import path from 'path'", true],
    ['src/a.ts', "import React from 'react'", true],
    ['src/a.ts', "import { y } from '@scope/pkg/sub'", true],
    ['src/a.ts', "import { z } from '@shared/run.ts'", true],
    ['src/a.ts', "const q = require('left-padx')", false],
    ['app/views.py', 'import os, json', true],
    ['app/views.py', 'import requests', true],
    ['app/views.py', 'import yaml', true],
    ['app/views.py', 'from sklearn.linear_model import X', true],
    ['app/views.py', 'from app.models import User', true],
    ['app/views.py', 'from . import models', true],
    ['app/views.py', 'import fakelib', false],
    ['main.go', 'import "fmt"', true],
    ['main.go', '\t"github.com/pkg/errors"', true],
    ['main.go', '\t"example.com/me/app/internal"', true],
    ['main.go', '\t"github.com/made/up"', false],
    ['src/main.rs', 'use std::fs;', true],
    ['src/main.rs', 'use serde::Deserialize;', true],
    ['src/main.rs', 'use config::Settings;', true],
    ['src/main.rs', 'use invented_crate::Thing;', false],
  ])('%s: %s', (file, line, ok) => {
    const refs = importsOf(file, [line])
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((r) => importResolves(r, facts()))).toBe(ok)
  })

  it('a project without a manifest is not judged for packages', () => {
    const f = facts({ npm: { manifest: false, names: new Set(), aliases: [], installed: () => false } })
    expect(importsOf('a.js', ["require('anything')"]).every((r) => importResolves(r, f))).toBe(true)
  })

  it('findings: a missing file is [must], a missing package [should]; both flagged', () => {
    const added = new Map([['src/a.ts', ["import x from './nope'", "import q from 'left-padx'"]]])
    const out = importFindings(input({ added, imports: facts() }))
    expect(out.map((f) => [f.severity, f.title, f.flags])).toEqual([
      ['must', '`src/a.ts` imports `./nope`, but there is no such file.', ['possible-hallucination']],
      [
        'should',
        '`src/a.ts` imports `left-padx`, which the project does not have (not in package.json, the lockfile or node_modules).',
        ['possible-hallucination'],
      ],
    ])
  })

  it('the names added lines import (the verify rule reads them)', () => {
    const added = addedLinesByFile(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '+++ b/src/a.ts',
        "@@ -0,0 +1,2 @@\n+import x from 'left-padx/sub'\n+import y from './local'",
        'diff --git a/m.py b/m.py',
        '+++ b/m.py',
        '@@ -0,0 +1 @@\n+from fakelib.core import z',
      ].join('\n'),
    )
    expect([...importedNames(added)].sort()).toEqual(['fakelib', 'left-padx'])
  })
})

describe('check 4: edits', () => {
  it('repeated failed edits and edits without a read are [should]', () => {
    const out = editFindings(
      input({ evidence: track({ failedEdits: { 'a.ts': 3, 'b.ts': 1 }, unreadEdits: ['c.ts'] }) }),
    )
    expect(out.map((f) => [f.severity, f.title])).toEqual([
      ['should', 'Edits to `a.ts` failed 3 times: the AI may have guessed what the file says.'],
      ['should', 'The AI changed `c.ts` without reading it first.'],
    ])
  })
})

describe('check 6: dependencies', () => {
  it('not installed is [should]; unknown to the registry is [must] and flagged', () => {
    const dep = (name: string) => ({ manifest: 'package.json', ecosystem: 'npm' as const, name })
    const out = packageFindings(input({ notInstalled: [dep('a'), dep('b')], registryMissing: [dep('b')] }))
    expect(out.map((f) => [f.severity, f.title, f.flags])).toEqual([
      ['must', '`b` is not on npm: the AI may have made up this package.', ['possible-hallucination']],
      ['should', '`a` was added to package.json but is not installed (no lockfile entry).', []],
    ])
  })
})

describe('check 5: failures that point to a made-up name', () => {
  it.each([
    ["src/a.ts(3,10): error TS2305: Module '\"x\"' has no exported member 'y'.", ['ts']],
    ["error TS2339: Property 'foo' does not exist on type 'Bar'.", ['ts']],
    ["Error: Cannot find module 'left-padx'", ['node-module']],
    ['ModuleNotFoundError: No module named fakelib', ['python']],
    ["AttributeError: module 'os' has no attribute 'nope'", ['python']],
    ['error[E0425]: cannot find value `x` in this scope', ['rust']],
    ['./main.go:5:2: undefined: Foo', ['go']],
    ['FAIL src/a.test.ts\n  expected 1 to be 2', []],
  ])('%s', (text, ids) => {
    expect(hallucinationSignals(text)).toEqual(ids)
  })
})

describe('check 7: Fix said fixed, the next check still finds it', () => {
  const f = (id: string, n: number): Finding => ({
    id,
    n,
    severity: 'must',
    source: 'verify',
    title: `t${n}`,
    body: '',
    flags: [],
    round: 1,
  })
  it.each([
    [{ a: 'fixed' }, ['a'], ['Fix said F1 was fixed, but the next check still finds it: t1']],
    [{ a: 'fixed' }, [], []],
    [{ a: 'disputed' }, ['a'], []],
    [{}, ['a'], []],
    [
      { a: 'fixed', b: 'fixed' },
      ['a', 'b'],
      [
        'Fix said F1 was fixed, but the next check still finds it: t1',
        'Fix said F2 was fixed, but the next check still finds it: t2',
      ],
    ],
  ] as const)('%j open %j', (report, open, want) => {
    const out = fixContradictions([f('a', 1), f('b', 2)], report, new Set(open))
    expect(out.map((x) => x.title)).toEqual(want)
    for (const x of out) expect(x).toMatchObject({ severity: 'must', source: 'grounding' })
  })
})

describe('check 8: plan drift (notes only)', () => {
  it('names the plan files the run did not touch', () => {
    const notes = driftNotes(
      input({
        plan: '1. Update `src/a.ts`\n2. Update `src/b.ts`',
        changed: new Set(['src/a.ts']),
      }),
    )
    expect(notes).toEqual(['The plan names a file the run did not change: src/b.ts.'])
  })

  it('every check together: findings must first, the drift notes for Implement', () => {
    const out = runGroundingChecks(
      input({
        finalText: 'The handler lives in `src/missing.ts`. All tests pass.',
        evidence: track(),
        plan: '1. Update `src/a.ts`\n2. Update `src/b.ts`',
        changed: new Set(['src/a.ts']),
        files: new Set(['src/a.ts', 'src/b.ts']),
      }),
    )
    expect(out.findings.map((x) => x.severity)).toEqual(['must', 'should'])
    expect(out.notes).toHaveLength(1)
  })
})

describe('pathRefs reads claims by sentence', () => {
  it('does not take a verb in one sentence as a claim about a path in the next', () => {
    const text = 'I found and fixed the problem. `samples/multi-item.json` now comes out at **$190.73**.'
    expect(pathRefs(text)).toEqual([
      expect.objectContaining({ path: 'samples/multi-item.json', claim: false }),
    ])
  })
  it('still takes a claim in the same sentence, and a dot inside a path does not end one', () => {
    const text = 'Nothing else moved. I fixed `src/coupons.js` and updated test.js today.'
    expect(pathRefs(text)).toEqual([
      expect.objectContaining({ path: 'src/coupons.js', claim: true }),
      expect.objectContaining({ path: 'test.js', claim: true }),
    ])
  })
})

describe('noteTool reads through a shell', () => {
  const reads = (summary: string): string[] => {
    const t = newGroundingTrack()
    noteTool(t, { type: 'tool', name: 'shell', summary, phase: 'start', fp: '1' })
    return t.reads
  }
  it('takes every file of a Codex line, with its $ prefix', () => {
    expect(reads('$ Get-Content src/a.js; Get-Content src/b.js')).toEqual(['src/a.js', 'src/b.js'])
    expect(reads('$ cat a.ts b.ts && head -n 5 c.ts')).toContain('c.ts')
    expect(reads('$ sed -n 1,20p src/a.js')).toEqual(['src/a.js'])
  })
  it('an edit after such a read is not an unread edit', () => {
    const t = newGroundingTrack()
    noteTool(t, {
      type: 'tool',
      name: 'shell',
      summary: '$ Get-Content src/a.js; Get-Content src/b.js',
      phase: 'start',
      fp: '1',
    })
    noteTool(t, { type: 'tool', name: 'edit', summary: 'M src/a.js', phase: 'start', fp: '2' })
    expect(t.unreadEdits).toEqual([])
  })
  it('does not count a command that reads nothing', () => {
    expect(reads('$ node bin/invoice.js samples/x.json')).toEqual([])
    expect(reads('$ git status --short')).toEqual([])
  })
})
