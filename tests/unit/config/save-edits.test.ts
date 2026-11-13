// Property test for the JSONC edit engine behind config saves: any sequence of add/replace/remove edits yields text
// that parses cleanly, equals the same edits applied to a plain object (with emptied objects pruned unless they still
// hold a comment), keeps the root-level comments and every comment inside a container that was not itself replaced
// or removed, and keeps the file's line endings.
import fc from 'fast-check'
import { parse as parseJsonc } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { applyConfigEdits, ConfigEditError } from '../../../src/core/config/save.ts'
import type { ConfigEdit } from '../../../src/core/config/save.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Doc {
  text: string
  /** Comment tag (`inner-N`) → the path of the object holding it (`a/b`). */
  inner: Record<string, string>
}

const DOCS: Doc[] = [
  { text: '{}', inner: {} },
  {
    text: [
      '{',
      '  // root-1',
      '  "a": {',
      '    "b": 1, // trailing b',
      '    "c": [1, 2]',
      '  },',
      '  /* root-2 */',
      '  "b": "x" // trailing root b',
      '  // root-3',
      '}',
      '',
    ].join('\n'),
    inner: {},
  },
  { text: '{ "a": { "b": true }, "c": null }', inner: {} },
  { text: ['{', '    "a": 1,', '    // root-4', '    "c": { "a": 2, },', '}', ''].join('\n'), inner: {} },
  {
    text: [
      '{',
      '  "a": {',
      '    // inner-1',
      '    "b": 1',
      '  },',
      '  "c": { "a": { /* inner-2 */ "b": 2 } }',
      '}',
      '',
    ].join('\n'),
    inner: { 'inner-1': 'a', 'inner-2': 'c/a' },
  },
]

const keyArb = fc.constantFrom('a', 'b', 'c')
const valueArb: fc.Arbitrary<Json> = fc.oneof(
  fc.integer({ min: -5, max: 5 }),
  fc.constantFrom('x', 'y z', ''),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
  fc.dictionary(keyArb, fc.integer({ min: 0, max: 3 }), { maxKeys: 2 }),
)
const pathArb = fc.array(keyArb, { minLength: 1, maxLength: 3 })
const editArb: fc.Arbitrary<ConfigEdit> = fc.oneof(
  fc.record({ op: fc.constantFrom('add' as const, 'replace' as const), path: pathArb, value: valueArb }),
  fc.record({ op: fc.constant('remove' as const), path: pathArb }),
)

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Model state: the value, and the paths of objects that hold a comment. */
interface Model {
  doc: Obj
  commented: Set<string>
}

/** Comments inside the node at `path` (and below) go with it when it is replaced or removed. */
function dropComments(commented: Set<string>, path: readonly string[]): Set<string> {
  const p = path.join('/')
  return new Set([...commented].filter((c) => c !== p && !c.startsWith(`${p}/`)))
}

/** The model: same lenient semantics on a plain object. Returns null where the engine must refuse. */
function applyModel(m: Model, edit: ConfigEdit): Model | null {
  const out = structuredClone(m.doc)
  const parents: Obj[] = [out]
  let cur: Obj = out
  for (const seg of edit.path.slice(0, -1)) {
    const next = cur[seg]
    if (next === undefined) {
      if (edit.op === 'remove') return { doc: out, commented: m.commented }
      const created: Obj = {}
      cur[seg] = created
      cur = created
    } else if (isObj(next)) {
      cur = next
    } else {
      return edit.op === 'remove' ? { doc: out, commented: m.commented } : null
    }
    parents.push(cur)
  }
  const last = edit.path[edit.path.length - 1] as string
  if (edit.op === 'remove') {
    if (!(last in cur)) return { doc: out, commented: m.commented }
    delete cur[last]
    const commented = dropComments(m.commented, edit.path)
    for (let i = parents.length - 1; i > 0; i--) {
      const p = parents[i] as Obj
      // An emptied object that still holds a comment stays (and so do its ancestors).
      if (Object.keys(p).length > 0 || commented.has(edit.path.slice(0, i).join('/'))) break
      delete (parents[i - 1] as Obj)[edit.path[i - 1] as string]
    }
    return { doc: out, commented }
  }
  if (edit.op === 'test') return { doc: out, commented: m.commented }
  const existed = last in cur
  const same = existed && deepEqual(cur[last], edit.value)
  cur[last] = structuredClone(edit.value) as Json
  return { doc: out, commented: existed && !same ? dropComments(m.commented, edit.path) : m.commented }
}

const comments = (text: string): string[] =>
  (text.match(/(\/\/|\/\*) (root|inner)-\d( \*\/)?/g) ?? []).map((c) => /(root|inner)-\d/.exec(c)?.[0] ?? c)

describe('applyConfigEdits (property)', () => {
  it('matches the object model, parses cleanly, keeps comments and the EOL style', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DOCS),
        fc.constantFrom('\n', '\r\n'),
        fc.array(editArb, { maxLength: 10 }),
        (doc, eol, edits) => {
          let text = doc.text.replace(/\n/g, eol)
          let model: Model = { doc: parseJsonc(text) as Obj, commented: new Set(Object.values(doc.inner)) }
          const roots = comments(text).filter((c) => c.startsWith('root-'))
          for (const edit of edits) {
            const expected = applyModel(model, edit)
            let next: string
            try {
              next = applyConfigEdits(text, [edit])
            } catch (err) {
              expect(err).toBeInstanceOf(ConfigEditError)
              expect(expected).toBeNull()
              continue
            }
            expect(expected).not.toBeNull()
            const errors: ParseError[] = []
            const value: unknown = parseJsonc(next, errors, { allowTrailingComma: true })
            expect(errors).toEqual([])
            expect(value).toEqual(expected?.doc)
            text = next
            model = expected as Model
          }
          const kept = Object.entries(doc.inner)
            .filter(([, path]) => model.commented.has(path))
            .map(([tag]) => tag)
          expect(comments(text).sort()).toEqual([...roots, ...kept].sort())
          // A one-line document has no EOL to keep; new lines then default to LF.
          if (eol === '\r\n' && doc.text.includes('\n')) expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/)
          if (eol === '\n') expect(text).not.toMatch(/\r/)
        },
      ),
      { numRuns: 600 },
    )
  })
})
