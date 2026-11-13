// Synthesizes C23s (an automatic compaction in the middle of a pass's turn) under tests/fixtures/claude/stdio/. It is
// NOT a recording: an automatic compaction needs a context near the window's auto-compact threshold (live C23b:
// 167,000 of 200,000), far more tokens than a fixture should spend. The frames are C23a's (made from a live
// recording with claude.exe 2.1.289, haiku), rearranged: its first request, then its manual compaction's frames moved into the turn
// with `trigger: "auto"` (SDKCompactBoundaryMessage in @anthropic-ai/claude-agent-sdk 0.3.289) and the second
// request after it, then the result. The prompt sizes are raised so the first request is near the threshold and the
// one after the compaction is small, as an automatic compaction leaves it. Run again after a re-record of C23a:
//   node tests/fixtures/claude/recipes/C23s-compact-auto/synthesize.mjs
// then `pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u -t "C23s"`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STDIO = join(HERE, '..', '..', 'stdio')
const SOURCE = join(STDIO, 'C23a-compact-manual', 'recording.jsonl')
const OUT = join(STDIO, 'C23s-compact-auto')

const lines = readFileSync(SOURCE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
const header = lines[0]
const frames = lines.slice(1)

/** The CLI line of a frame, parsed. */
const inner = (f) => JSON.parse(f.line)
/** A copy of `f` with its CLI line changed by `edit`. */
const withLine = (f, edit) => {
  const v = inner(f)
  edit(v)
  return { ...f, line: JSON.stringify(v) }
}
const find = (pred, from = 0) => {
  for (let i = from; i < frames.length; i++) {
    const f = frames[i]
    if (f.dir !== 'out' || typeof f.line !== 'string') continue
    if (pred(inner(f))) return i
  }
  throw new Error('C23a no longer has the frame this needs')
}

const result1 = find((v) => v.type === 'result')
const compacting = find((v) => v.type === 'system' && v.subtype === 'status' && v.status === 'compacting')
const compacted = find((v) => v.type === 'system' && v.subtype === 'status' && v.compact_result === 'success')
const init2 = find((v) => v.type === 'system' && v.subtype === 'init', compacted)
const boundary = find((v) => v.type === 'system' && v.subtype === 'compact_boundary')
const toolResult = find((v) => v.type === 'user')

// Request one near the threshold; the request after the compaction small.
const big = (v) => {
  if (v.type !== 'assistant' || v.message?.usage === undefined) return
  v.message.usage.cache_read_input_tokens = 158_400
  v.message.usage.cache_creation_input_tokens = 8_189
}
const small = (v) => {
  if (v.type !== 'assistant' || v.message?.usage === undefined) return
  v.message.usage.cache_read_input_tokens = 0
  v.message.usage.cache_creation_input_tokens = 31_500
}

const out = []
// The handshake, the prompt and the first request with its tool call and result.
for (let i = 0; i <= toolResult; i++) out.push(frames[i].dir === 'out' ? withLine(frames[i], big) : frames[i])
// The automatic compaction, before the next request.
out.push(frames[compacting], frames[compacted], frames[init2])
out.push(
  withLine(frames[boundary], (v) => {
    v.compact_metadata.trigger = 'auto'
    v.compact_metadata.pre_tokens = 167_210
    v.compact_metadata.post_tokens = 31_020
    v.compact_metadata.cumulative_dropped_tokens = 136_190
  }),
)
// The second request and the result.
for (let i = toolResult + 1; i <= result1; i++) {
  const f = frames[i]
  if (f.dir !== 'out') continue
  const v = inner(f)
  if (v.type === 'system' && v.subtype === 'status') continue
  out.push(withLine(f, small))
}
out.push(frames.find((f) => f.dir === 'eof') ?? { t: 0, dir: 'eof' }, frames.find((f) => f.dir === 'exit'))

let t = 0
const timed = out.filter((f) => f !== undefined).map((f) => ({ ...f, t: (t += 10) }))
const h = {
  ...header,
  scenario: 'C23s-compact-auto',
  synthesized: true,
  synthesizedFrom:
    'C23a-compact-manual (made from a live 2.1.289 recording): its frames rearranged, its compaction made automatic ' +
    '(SDKCompactBoundaryMessage trigger auto) and moved into the turn',
}
delete h.recordedAt
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'recording.jsonl'), [h, ...timed].map((x) => JSON.stringify(x)).join('\n') + '\n')
console.log(`wrote ${join(OUT, 'recording.jsonl')} (${timed.length} frames)`)
