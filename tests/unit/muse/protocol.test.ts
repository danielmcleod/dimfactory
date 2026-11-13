// The pinned Muse record shapes ("Shapes pinned from `muse schema generate-json-schema`";
// built without a Muse CLI): the committed schema's hash, its provenance (synthesized, sources with URLs and
// dates), and every record of every Muse fixture checked against the envelope and the payloads the schema pins.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MUSE_PIN, MUSE_PROTOCOL_DIR, READ_PAYLOAD_TYPES } from '@core/adapters/muse/protocol.ts'

const MUSE_DIR = fileURLToPath(new URL('../../../src/core/adapters/muse/', import.meta.url))
const PIN_DIR = join(MUSE_DIR, MUSE_PROTOCOL_DIR)
const FIXTURES = fileURLToPath(new URL('../../fixtures/muse/exec/', import.meta.url))

type Rec = Record<string, unknown>
const schema = JSON.parse(readFileSync(join(PIN_DIR, 'exec-records.schema.json'), 'utf8')) as Rec
const meta = JSON.parse(readFileSync(join(PIN_DIR, 'meta.json'), 'utf8')) as Rec

describe('the pin', () => {
  it('the committed schema has the hash MUSE_PIN records (LF bytes)', () => {
    const bytes = readFileSync(join(PIN_DIR, 'exec-records.schema.json'))
    expect(bytes.includes(0x0d)).toBe(false)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MUSE_PIN.committedSha256)
  })

  it('says it is synthesized, targets 1.4.2, has no live schema yet, and names every source with a date', () => {
    expect(MUSE_PIN).toMatchObject({ synthesized: true, targetCliVersion: '1.4.2', liveSchemaSha256: null })
    expect(schema['x-synthesized']).toBe(true)
    expect(meta).toMatchObject({
      vendor: 'muse',
      synthesized: true,
      targetCliVersion: '1.4.2',
      liveSchema: null,
    })
    const sources = meta['sources'] as { url: string; fetched: string; what: string }[]
    expect(sources.length).toBeGreaterThanOrEqual(6)
    for (const s of sources) {
      expect(s.fetched).toMatch(/^2026-10-\d{2}$/)
      expect(s.what.length).toBeGreaterThan(10)
    }
    const official = sources.filter((s) => s.url.startsWith('https://dev.meta.ai/docs/muse-code'))
    expect(official.length).toBeGreaterThanOrEqual(5)
    const readme = readFileSync(join(PIN_DIR, 'README.md'), 'utf8')
    for (const s of official) expect(readme).toContain(s.url)
  })

  it('pins the payload types the adapter reads', () => {
    // A const names the type as it is; a pattern escapes its dots (`^run\.terminal\.`).
    const rules = JSON.stringify((schema['allOf'] as Rec[]).map((r) => r['if']))
    for (const t of READ_PAYLOAD_TYPES)
      expect(rules.includes(`"${t}"`) || rules.includes(t.replace(/\./g, '\\\\.'))).toBe(true)
    for (const def of [
      'RunOutputDelta',
      'RunTerminal',
      'TaskLifecycle',
      'ToolResult',
      'ModelConfigured',
      'Usage',
    ])
      expect((schema['$defs'] as Rec)[def]).toBeDefined()
  })
})

// ---- every fixture record against the pinned shapes ---------------------------------------------------------------

const ENVELOPE = schema['required'] as string[]
const enumOf = (path: string[]): unknown[] => {
  let v: unknown = schema
  for (const p of path) v = (v as Rec)[p]
  return (v as { enum: unknown[] }).enum
}
const RECORD_TYPES = enumOf(['properties', 'record_type'])
const DURABILITY = enumOf(['properties', 'durability'])
const STREAM_KINDS = enumOf(['$defs', 'StreamRef', 'properties', 'kind'])
const TASK_EVENTS = enumOf(['$defs', 'TaskLifecycle', 'properties', 'event', 'properties', 'kind'])

/** The pinned payload rules, by type (what the adapter relies on). */
function payloadProblems(type: string, p: Rec): string[] {
  const out: string[] = []
  const need = (keys: string[]) => {
    for (const k of keys) if (!(k in p)) out.push(`${type}: no ${k}`)
  }
  if (type === 'run.output.delta') {
    need(['kind', 'command_id', 'text'])
    if (p['kind'] !== 'run_output_delta') out.push(`${type}: kind`)
    if (typeof p['text'] !== 'string') out.push(`${type}: text`)
  } else if (type.startsWith('run.terminal.')) {
    need(['kind', 'command_id', 'terminal'])
    if (p['kind'] !== 'run_terminal') out.push(`${type}: kind`)
    if (type !== `run.terminal.${String(p['terminal'])}`)
      out.push(`${type}: terminal does not match the type`)
  } else if (type.startsWith('task.lifecycle.')) {
    need(['kind', 'command_id', 'task_id', 'event'])
    const e = p['event'] as Rec
    if (!TASK_EVENTS.includes(e['kind'])) out.push(`${type}: event kind ${String(e['kind'])}`)
    if (type !== `task.lifecycle.${String(e['kind'])}`)
      out.push(`${type}: event kind does not match the type`)
    if (e['task_id'] !== p['task_id']) out.push(`${type}: task ids differ`)
  } else if (type === 'tool.result') {
    need(['kind', 'command_id', 'call_id'])
    if (p['kind'] !== 'tool_result') out.push(`${type}: kind`)
  } else if (type === 'run.model.configured') {
    need(['kind', 'command_id', 'model_id'])
  }
  return out
}

describe('every Muse fixture record has the pinned shape', () => {
  const ids = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  it.each(ids)('%s', (id) => {
    const lines = readFileSync(join(FIXTURES, id, 'recording.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
    const out = lines
      .slice(1)
      .map((l) => JSON.parse(l) as Rec)
      .filter((f) => f['dir'] === 'out')
    expect(out.length).toBeGreaterThan(0)
    const problems: string[] = []
    let last = 0
    for (const f of out) {
      const r = JSON.parse(f['line'] as string) as Rec
      for (const k of ENVELOPE) if (!(k in r)) problems.push(`no ${k}`)
      if (r['schema_version'] !== 1 || r['payload_schema_version'] !== 1) problems.push('schema versions')
      if (!RECORD_TYPES.includes(r['record_type'])) problems.push(`record_type ${String(r['record_type'])}`)
      if (!DURABILITY.includes(r['durability'])) problems.push(`durability ${String(r['durability'])}`)
      const stream = r['stream'] as Rec
      if (!STREAM_KINDS.includes(stream['kind']) || typeof stream['id'] !== 'string') problems.push('stream')
      const seq = r['sequence'] as number
      if (seq !== last + 1) problems.push(`sequence ${seq} after ${last}`)
      last = seq
      problems.push(...payloadProblems(r['payload_type'] as string, r['payload'] as Rec))
    }
    expect(problems).toEqual([])
  })
})
