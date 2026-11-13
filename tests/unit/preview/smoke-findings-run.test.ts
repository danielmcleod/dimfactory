// The preview smoke check's findings join the run's findings (`preview-findings`): the findings list, findings.json
// and Re-run from Fix see them as [should] findings of source `preview`, and a repeat check never lists the same error
// twice (the latest check replaces the earlier one's).
import { describe, expect, it } from 'vitest'
import { smokeFindings } from '@core/preview/smoke.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import {
  RERUN_TEXT,
  carriedFindings,
  defaultFindingIds,
  rerunFromFixUnavailable,
} from '@core/supervisor/rerun.ts'
import type { EffectOf, FindingInput } from '@core/supervisor/types.ts'
import type { Finding } from '@shared/findings.ts'
import { Flow, completedFixed, must, should } from '../rerun/helpers.ts'

const err = (message: string) => ({ message, source: 'http://localhost:5173/main.js', line: 3 })
const asInput = (fs: readonly Finding[]): FindingInput[] =>
  fs.map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    body: f.body,
    flags: f.flags,
    round: f.round,
  }))

describe('preview smoke findings join the run', () => {
  it('a finished run lists them after its own, ticked for Re-run from Fix, and findings.json names the source', () => {
    const f = completedFixed()
    const before = f.state.findings!.list.map((x) => x.id)
    const smoke = smokeFindings([err('TypeError: x is undefined'), err('TypeError: x is undefined')])
    expect(smoke).toHaveLength(1)
    f.send({ t: 'preview-findings', findings: asInput(smoke) })
    const list = f.state.findings!.list
    expect(list.map((x) => x.id)).toEqual([...before, smoke[0]!.id])
    expect(list.map((x) => x.n)).toEqual(list.map((_, i) => i + 1))
    const added = list.at(-1)!
    expect(added).toMatchObject({ severity: 'should', source: 'preview', title: smoke[0]!.title })
    expect(carriedFindings(f.state).map((x) => x.id)).toContain(added.id)
    expect(defaultFindingIds(f.state)).toContain(added.id)
    // The snapshot's Re-run from Fix (the findings picker) offers it.
    const snap = toRunSnapshot(f.state, 0)
    expect(snap.rerunFromFix.available).toBe(true)
    const offered = (snap.rerunFromFix as { findings?: Finding[] }).findings ?? []
    expect(offered.map((x) => x.id)).toContain(added.id)
    // findings.json is rewritten with a `preview` source, announced by an `output` body.
    const write = f.effects.find((e): e is EffectOf<'writeFindings'> => e.t === 'writeFindings')
    expect(write?.doc.sources.preview).toEqual({ status: 'ok', count: 1, rawFile: 'preview/smoke.json' })
    expect(write?.doc.findings.map((x) => x.id)).toContain(added.id)
    expect(f.effects.some((e) => e.t === 'emit' && e.body.t === 'output' && e.body.file === 'findings')).toBe(
      true,
    )
    // Nothing is sent to a Fix on its own: the gate's selection is unchanged.
    expect(f.state.findings!.selected).not.toContain(added.id)
  })

  it('a repeat check with the same errors changes nothing; a new one replaces the earlier check', () => {
    const f = completedFixed()
    const own = f.state.findings!.list.length
    const first = smokeFindings([err('TypeError: x is undefined')])
    f.send({ t: 'preview-findings', findings: asInput(first) })
    const v1 = f.state.outputs.findings
    f.send({ t: 'preview-findings', findings: asInput(first) })
    expect(f.state.findings!.list).toHaveLength(own + 1)
    expect(f.state.outputs.findings).toBe(v1)
    expect(f.effects.some((e) => e.t === 'writeFindings')).toBe(false)

    const second = smokeFindings([err('TypeError: x is undefined'), err('ReferenceError: y is not defined')])
    f.send({ t: 'preview-findings', findings: asInput(second) })
    const preview = f.state.findings!.list.filter((x) => x.source === 'preview')
    expect(preview.map((x) => x.title)).toEqual(second.map((x) => x.title))
    expect(f.state.findings!.list).toHaveLength(own + 2)
    expect(new Set(f.state.findings!.list.map((x) => x.id)).size).toBe(own + 2)

    // A clean check takes them away again.
    f.send({ t: 'preview-findings', findings: [] })
    expect(f.state.findings!.list).toHaveLength(own)
    expect(f.state.findings!.preview).toBeUndefined()
  })

  it('a clean run (nothing to fix) becomes eligible for Re-run from Fix once the preview finds something', () => {
    const f = new Flow({ beforeFix: false })
    f.toJoin()
    expect(rerunFromFixUnavailable(f.state)).toBe(RERUN_TEXT.noFindings)
    const smoke = smokeFindings([err('Uncaught Error: boom')])
    f.send({ t: 'preview-findings', findings: asInput(smoke) })
    expect(rerunFromFixUnavailable(f.state)).toBeUndefined()
    expect(carriedFindings(f.state).map((x) => [x.id, x.severity, x.source])).toEqual([
      [smoke[0]!.id, 'should', 'preview'],
    ])
    expect(defaultFindingIds(f.state)).toEqual([smoke[0]!.id])
  })

  it('an id already used by the run gets a suffix, and a must from the input is still a should', () => {
    const f = new Flow()
    f.toJoin(['ok', [must('r1'), should('r2')]], ['none', []])
    f.send({
      t: 'preview-findings',
      findings: [
        { id: 'r1', severity: 'must', title: 'The preview page logged a console error: x', body: '' },
      ],
    })
    const added = f.state.findings!.list.at(-1)!
    expect(added.id).toBe('r1-2')
    expect(added.severity).toBe('should')
    expect(added.source).toBe('preview')
  })

  it('a run with no findings yet ignores an empty check', () => {
    const f = new Flow()
    f.toImplementRunning()
    const before = structuredClone(f.state)
    f.send({ t: 'preview-findings', findings: [] })
    expect(f.state.findings).toEqual(before.findings)
  })
})
