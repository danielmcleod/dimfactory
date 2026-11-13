// runs.output serves core's parsed findings (findings.json, a FindingsFile) besides the pass texts (src/core/handlers.ts;
// runs.output with RunOutputFile; the PassCard lists Review and Critic findings).
import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createHandlers, dispatch } from '../../../src/core/handlers.ts'
import type { HandlerContext } from '../../../src/core/handlers.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'

const RUN_ID = '20261006T120000Z-ab12'

function handlers(doc: RunDoc | null) {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  const ctx = { paths, readDoc: () => Promise.resolve(doc) } as unknown as HandlerContext
  return { h: createHandlers(ctx), paths }
}

const docWith = (outputs: Record<string, number>): RunDoc =>
  ({ runId: RUN_ID, state: { outputs }, lastSeq: 0 }) as unknown as RunDoc

const file: FindingsFile = {
  schemaVersion: 1,
  runId: RUN_ID,
  round: 1,
  sources: { review: { status: 'ok', count: 1, rawFile: 'review.md' } },
  findings: [
    { id: 'a1', n: 1, severity: 'must', source: 'review', title: 'x', body: '', flags: [], round: 1 },
  ],
  selected: { a1: true },
}

describe('runs.output findings', () => {
  it("returns findings.json's text with core's output version", async () => {
    const { h, paths } = handlers(docWith({ findings: 3 }))
    const run = paths.run(RUN_ID)
    await mkdir(run.dir, { recursive: true })
    await writeFile(run.findingsJson, JSON.stringify(file))
    const r = await dispatch(h, 'runs.output', { runId: RUN_ID, file: 'findings' })
    if (!r.ok) throw new Error(r.error.message)
    expect(JSON.parse(r.value.text)).toEqual(file)
    expect(r.value.version).toBe(3)
  })

  it('answers NOT_FOUND before any reviewer finished, and for an unknown run', async () => {
    const { h, paths } = handlers(docWith({}))
    await mkdir(paths.run(RUN_ID).dir, { recursive: true })
    const none = await dispatch(h, 'runs.output', { runId: RUN_ID, file: 'findings' })
    expect(none.ok ? null : none.error).toMatchObject({
      code: 'NOT_FOUND',
      message: `Run ${RUN_ID} has no findings yet.`,
    })
    const missing = await handlers(null)
      .h['runs.output']?.({ runId: RUN_ID, file: 'findings' })
      .catch((e: unknown) => e)
    expect(missing).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('still refuses outputs that are not served', async () => {
    const { h } = handlers(docWith({}))
    const r = await dispatch(h, 'runs.output', { runId: RUN_ID, file: 'resolved' })
    expect(r.ok ? null : r.error.code).toBe('VALIDATION')
  })
})
