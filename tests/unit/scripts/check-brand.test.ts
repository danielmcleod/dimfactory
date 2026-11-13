// scripts/check-brand.mjs: the former product name is a finding everywhere but where the allowlist says why (private
// notes, live recordings and the vendor text their expected events pass on, the replay's mask, the former project
// folder's notice, the check itself), and the repository holds none.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST, PRIVATE_NOTES, checkFiles, isLiveRecording, main } from '../../../scripts/check-brand.mjs'

const repo = join(import.meta.dirname, '..', '..', '..')
const LIVE_HEADER = '{"kind":"header","schemaVersion":1,"vendor":"claude"}'
const SYNTH_HEADER = '{"kind":"header","schemaVersion":1,"vendor":"codex","synthesized":true}'
const recording = (header: string, frames: string[]): string => [header, ...frames].join('\n') + '\n'
const VENDOR_TEXT =
  '{"t":1,"dir":"out","line":"{\\"result\\":\\"The call was denied by the user in Conductor, so it did not run.\\"}"}'

const found = (files: { path: string; text: string | undefined }[]): string[] =>
  checkFiles(files).findings.map((f) => `${f.path}:${f.line}`)

describe('findings', () => {
  it('reports the name in any case, in code, prose and paths', () => {
    expect(
      found([
        { path: 'src/a.ts', text: "const a = 1\nexport const NAME = 'conductor'\n" },
        { path: 'README.md', text: '# CONDUCTOR\n\nConductor runs passes.\n' },
        { path: 'src/conductor.ts', text: 'export {}\n' },
        { path: 'build/icon.png', text: undefined },
      ]),
    ).toEqual(['src/a.ts:2', 'README.md:1', 'README.md:3', 'src/conductor.ts:0'])
  })

  it('is clean without it', () => {
    expect(checkFiles([{ path: 'src/a.ts', text: "export const NAME = 'dim-factory'\n" }])).toEqual({
      scanned: 1,
      findings: [],
    })
  })
})

describe('the allowlist', () => {
  it('says why for every entry', () => {
    for (const e of ALLOWLIST) expect(e.why.length, e.id).toBeGreaterThan(20)
  })

  it('allows the private notes, the check itself and its test', () => {
    expect(
      found([
        { path: PRIVATE_NOTES[0] ?? '', text: 'Conductor\n' },
        { path: `${PRIVATE_NOTES[2] ?? ''}conductor-notes.txt`, text: 'Conductor\n' },
        { path: 'scripts/check-brand.mjs', text: 'conductor\n' },
        { path: 'tests/unit/scripts/check-brand.test.ts', text: 'conductor\n' },
      ]),
    ).toEqual([])
  })

  it('allows a live recording, not a synthesized one', () => {
    expect(
      found([
        {
          path: 'tests/fixtures/claude/stdio/C01-x/recording.jsonl',
          text: recording(LIVE_HEADER, [VENDOR_TEXT]),
        },
        {
          path: 'tests/fixtures/codex/app-server/X99-y/recording.jsonl',
          text: recording(SYNTH_HEADER, [VENDOR_TEXT]),
        },
      ]),
    ).toEqual(['tests/fixtures/codex/app-server/X99-y/recording.jsonl:2'])
    expect(isLiveRecording(recording(LIVE_HEADER, []))).toBe(true)
    expect(isLiveRecording(recording(SYNTH_HEADER, []))).toBe(false)
    expect(isLiveRecording('not json\n')).toBe(false)
  })

  it("allows in a live recording's expected events only the vendor text the recording holds", () => {
    const dir = 'tests/fixtures/claude/stdio/C04-x'
    const events = [
      '{ "type": "done", "result": "The call was denied by the user in Conductor, so it did not run." }',
      '{ "type": "error", "message": "Conductor paused the pass." }',
    ].join('\n')
    expect(
      found([
        { path: `${dir}/recording.jsonl`, text: recording(LIVE_HEADER, [VENDOR_TEXT]) },
        { path: `${dir}/expected.events.json`, text: events },
      ]),
    ).toEqual([`${dir}/expected.events.json:2`])
    // Beside a synthesized recording nothing is allowed.
    const syn = 'tests/fixtures/codex/app-server/X99-y'
    expect(
      found([
        {
          path: `${syn}/recording.jsonl`,
          text: recording(SYNTH_HEADER, ['{"t":1,"dir":"out","line":"{}"}']),
        },
        { path: `${syn}/expected.events.json`, text: events },
      ]),
    ).toEqual([`${syn}/expected.events.json:1`, `${syn}/expected.events.json:2`])
  })

  it("allows only the replay mask's line in the fake CLI and the former folder's line in the brand module", () => {
    expect(
      found([
        {
          path: 'tests/fake-cli/fake-cli.mjs',
          text: "export const RECORDED_HOST_NAMES = Object.freeze(['Conductor', 'conductor'])\n// Conductor\n",
        },
        {
          path: 'src/shared/brand.ts',
          text: "export const FORMER_PROJECT_DIRNAME = '.conductor'\nexport const X = 'conductor'\n",
        },
      ]),
    ).toEqual(['tests/fake-cli/fake-cli.mjs:2', 'src/shared/brand.ts:2'])
  })
})

describe('the repository', () => {
  it('names the former product only where the allowlist says why', () => {
    const out: string[] = []
    const code = main([], { root: repo, log: (l) => out.push(l), err: (l) => out.push(l) })
    expect(
      out.filter((l) => !l.startsWith('No former product name')),
      out.join('\n'),
    ).toEqual([])
    expect(code).toBe(0)
  })

  it('usage errors exit 2', () => {
    const err: string[] = []
    expect(main(['--nope'], { root: repo, log: () => undefined, err: (l) => err.push(l) })).toBe(2)
    expect(err[0]).toMatch(/^usage: node scripts\/check-brand\.mjs/)
  })
})
