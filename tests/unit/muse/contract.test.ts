// The Muse fixtures as committed (fixtures, contract invariants: per-adapter P1 fixtures pass
// replay + contract; synthesized fixtures marked and generated with --check, as Codex's and Gemini's). The replay itself is
// tests/integration/muse/replay.test.ts; this checks what each recording says without running anything.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIVE, SCENARIOS, outOfDate, synthesize } from '../../fixtures/muse/recipes/synthesize.mjs'

const FIXTURES = fileURLToPath(new URL('../../fixtures/muse/', import.meta.url))
const EXEC = join(FIXTURES, 'exec')
type Rec = Record<string, unknown>

const ids = readdirSync(EXEC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

function load(id: string): { header: Rec; frames: Rec[]; records: Rec[]; expected: Rec[] } {
  const lines = readFileSync(join(EXEC, id, 'recording.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
  const [header, ...frames] = lines.map((l) => JSON.parse(l) as Rec)
  const records = frames.filter((f) => f['dir'] === 'out').map((f) => JSON.parse(f['line'] as string) as Rec)
  const expected = JSON.parse(readFileSync(join(EXEC, id, 'expected.events.json'), 'utf8')) as Rec[]
  return { header: header!, frames, records, expected }
}

describe('the generator', () => {
  it('is up to date (`node tests/fixtures/muse/recipes/synthesize.mjs --check`), with no stray file', () => {
    expect(outOfDate(synthesize())).toEqual([])
  })

  it('owns M01-M05, none recorded live yet', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['M01', 'M02', 'M03', 'M04', 'M05'])
    expect(ids.map((id) => id.slice(0, 3))).toEqual(['M01', 'M02', 'M03', 'M04', 'M05'])
    expect([...LIVE]).toEqual([])
  })

  it('every scenario has a live re-record recipe (record.txt, prompt.md, pass.json)', () => {
    for (const id of ids) {
      const recipe = join(FIXTURES, 'recipes', id)
      const record = readFileSync(join(recipe, 'record.txt'), 'utf8')
      expect(record).toContain('node scripts/record-fixture.mjs --muse')
      expect(record).toContain(`--out tests/fixtures/muse/exec/${id}`)
      expect(record).toContain('--env-file')
      expect(record).toContain(`${id}/prompt.md`)
      const pass = JSON.parse(readFileSync(join(recipe, 'pass.json'), 'utf8')) as Rec
      expect(readFileSync(join(recipe, 'prompt.md'), 'utf8')).toBe(`${String(pass['prompt'])}\n`)
    }
  })
})

describe.each(ids)('%s', (id) => {
  const f = load(id)
  const pass = f.header['pass'] as Rec
  const argv = f.header['argv'] as string[]

  it('is marked synthesized, with its sources and a target CLI version', () => {
    expect(f.header).toMatchObject({
      kind: 'header',
      vendor: 'muse',
      route: 'exec',
      scenario: id,
      synthesized: true,
    })
    expect(String(f.header['synthesizedFrom'])).toContain('dev.meta.ai/docs/muse-code')
    expect(String(f.header['synthesizedFrom'])).toContain('muse-codes 0.1.4')
    expect(f.header['cliVersion']).toBe('1.4.2')
  })

  it('runs as Dim Factory runs Muse: the prompt only in the file, --yolo only in full mode, the grant', () => {
    expect(argv.slice(0, 5)).toEqual(['muse', 'exec', '--json', '--prompt-file', '<PROMPT_FILE>'])
    expect(argv.some((a) => a.includes(String(pass['prompt'])))).toBe(false)
    expect(argv.includes('--yolo')).toBe(pass['mode'] === 'full')
    expect(argv.includes('--disable-approval')).toBe(pass['mode'] === 'autoedit')
    // Autoedit turns the sandbox's network off; --yolo has no sandbox to set.
    expect(argv.join(' ').includes('--sandbox-network restricted')).toBe(pass['mode'] === 'autoedit')
    expect(argv).toContain('--trust-workspace')
    expect(pass['trustFolder']).toBe(true)
    expect(['implement', 'fix']).toContain(pass['step'])
    // The key, and the isolated home the recorder points Muse at (--muse-home).
    expect(f.header['envKeys']).toEqual([
      'APPDATA',
      'HOME',
      'LOCALAPPDATA',
      'META_API_KEY',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
    ])
  })

  it('opens with the prompt file and the stdin close; one exit at the end', () => {
    expect(f.frames[0]).toEqual({
      t: 0,
      dir: 'promptFile',
      argvPath: '--prompt-file',
      content: `${String(pass['prompt'])}\n`,
    })
    expect(f.frames[1]).toMatchObject({ dir: 'eof' })
    expect(f.frames.filter((x) => x['dir'] === 'exit')).toHaveLength(1)
    expect(f.frames.at(-1)).toMatchObject({ dir: 'exit' })
    expect(f.frames.filter((x) => x['dir'] === 'in')).toEqual([])
  })

  it('one session, one terminal record (completed with exit 0, or failed with a non-zero exit)', () => {
    const sessions = new Set(f.records.map((r) => (r['stream'] as Rec)['id']))
    expect(sessions.size).toBe(1)
    const terminals = f.records.filter((r) => String(r['payload_type']).startsWith('run.terminal.'))
    expect(terminals).toHaveLength(1)
    expect(f.records.at(-1)).toBe(terminals[0])
    const exit = f.frames.at(-1)!
    const completed = terminals[0]!['payload_type'] === 'run.terminal.completed'
    expect(exit['code'] === 0).toBe(completed)
  })

  it('expected events: exactly one terminal, never an ask, session first, usage never negative', () => {
    const events = f.expected.filter((e) =>
      ['session', 'text', 'tool', 'ask', 'done', 'error'].includes(String(e['type'])),
    )
    expect(events[0]).toMatchObject({ type: 'session' })
    expect(events.filter((e) => e['type'] === 'ask')).toEqual([])
    const terms = events.filter((e) => e['type'] === 'done' || (e['type'] === 'error' && e['fatal'] === true))
    expect(terms).toHaveLength(1)
    expect(events.at(-1)).toBe(terms[0])
    const usage = (terms[0]!['usage'] ?? {}) as Record<string, number>
    for (const v of Object.values(usage)) expect(v).toBeGreaterThanOrEqual(0)
    // Every tool row that starts also ends, by the same id.
    const tools = events.filter((e) => e['type'] === 'tool')
    const starts = tools.filter((e) => e['phase'] === 'start').map((e) => e['id'])
    const ends = tools.filter((e) => e['phase'] === 'end').map((e) => e['id'])
    expect(ends).toEqual(starts)
  })
})
