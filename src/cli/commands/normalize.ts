// `dimf normalize claude <recording.jsonl|stdout.jsonl>`: prints the normalized events and adapter
// signals as NDJSON. Recordings also get their recorded host answers.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { ClaudeRoute, RecordingEntry } from '../../core/adapters/claude/normalize.ts'
import { ClaudeNormalizer, normalizeRecording } from '../../core/adapters/claude/normalize.ts'
import { parseFrame } from '../../core/adapters/claude/protocol.ts'

export const NORMALIZE_USAGE =
  'dimf normalize claude <recording.jsonl|stdout.jsonl> [--route plan|readonly|edit] [--liveness] [--stdin]'

const ROUTES: readonly ClaudeRoute[] = ['plan', 'readonly', 'edit']

export function normalizeFile(
  text: string,
  o: { route?: ClaudeRoute; liveness?: boolean; stdin?: boolean } = {},
): RecordingEntry[] {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  let entries: RecordingEntry[]
  if (parseFrame(first)?.['kind'] === 'header') {
    entries = normalizeRecording(text, o.route !== undefined ? { route: o.route } : {})
  } else {
    const n = new ClaudeNormalizer({ route: o.route ?? 'edit', askTimeoutMs: 600_000, now: () => 0 })
    entries = []
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const s = n.line(line)
      entries.push(...s.signals, ...s.events, ...s.stdin.map((frame) => ({ type: 'stdin' as const, frame })))
    }
  }
  return entries.filter(
    (e) => (o.liveness === true || e.type !== 'liveness') && (o.stdin === true || e.type !== 'stdin'),
  )
}

export function normalizeCommand(args: readonly string[], out: (s: string) => void): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      route: { type: 'string' },
      liveness: { type: 'boolean', default: false },
      stdin: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  const [vendor, file] = positionals
  if (vendor !== 'claude' || file === undefined) {
    out(`usage: ${NORMALIZE_USAGE}`)
    return 2
  }
  const route = values.route
  if (route !== undefined && !(ROUTES as readonly string[]).includes(route)) {
    out(`--route must be one of ${ROUTES.join(', ')}`)
    return 2
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    out(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const entries = normalizeFile(text, {
    ...(route !== undefined ? { route: route as ClaudeRoute } : {}),
    liveness: values.liveness,
    stdin: values.stdin,
  })
  for (const e of entries) out(JSON.stringify(e))
  return 0
}
