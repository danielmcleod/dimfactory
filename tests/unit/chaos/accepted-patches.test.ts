// Chaos (resolved.json `patches[]`; P22): the run's load puts
// the recovery patches the reducer accepted (RunState.configPatches) into resolved.json when a kill cut the append
// short, matching entries as written: once each, after what the file holds, and never twice, also beside entries a
// run recorded before RunState kept them. tests/integration/chaos/kill-patch-index.test.ts kills the real write.
import { describe, expect, it } from 'vitest'
import { withAcceptedPatches } from '../../../src/core/resolved-json.ts'

const entry = (at: number, label = 'Use the default model') => ({
  at,
  ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
  label,
  source: 'recovery',
  step: 'plan',
  actionId: 'plan:default-model',
})

describe('withAcceptedPatches', () => {
  it('returns the same object when resolved.json already has every accepted patch (or none was accepted)', () => {
    const doc = { config: {}, patches: [entry(1), entry(2)] }
    expect(withAcceptedPatches(doc, [entry(1), entry(2)])).toBe(doc)
    expect(withAcceptedPatches(doc, [])).toBe(doc)
    expect(withAcceptedPatches(doc, undefined)).toBe(doc)
    const bare = { config: {} }
    expect(withAcceptedPatches(bare, undefined)).toBe(bare)
  })

  it('appends the patch a kill kept out of resolved.json, once', () => {
    const doc = { config: { a: 1 }, patches: [entry(1)] }
    const out = withAcceptedPatches(doc, [entry(1), entry(2)])
    expect(out).toEqual({ config: { a: 1 }, patches: [entry(1), entry(2)] })
    expect(doc.patches).toHaveLength(1)
    expect(withAcceptedPatches(out, [entry(1), entry(2)])).toBe(out)
    expect(withAcceptedPatches({ config: {} }, [entry(1)])).toEqual({ config: {}, patches: [entry(1)] })
  })

  it('keeps entries recorded before RunState listed them, and adds only the accepted one missing', () => {
    // A run made by an earlier version: resolved.json has one patch its state never listed; the next patch was
    // accepted by the current version and its append was cut short.
    const doc = { config: {}, patches: [entry(1, 'an older fix')] }
    expect(withAcceptedPatches(doc, [entry(2)])).toEqual({
      config: {},
      patches: [entry(1, 'an older fix'), entry(2)],
    })
  })

  it('counts identical entries one for one', () => {
    const doc = { config: {}, patches: [entry(5)] }
    expect(withAcceptedPatches(doc, [entry(5), entry(5)])).toEqual({
      config: {},
      patches: [entry(5), entry(5)],
    })
  })
})
