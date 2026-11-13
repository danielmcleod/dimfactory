// Test helper: the asks a scripted fake Claude pass raises, rewritten. Each `can_use_tool` control request of the
// script gets the tool and input given (in order), and the answer the script waits for accepts any answer (allow or
// deny), so a test decides what the user does. More asks than the recording has are made by repeating its last ask
// (with a new request id) right after it was answered. `prepend` ops run before the recorded frames: a file the
// project should hold before its first ask (a package.json, say).
import { readFileSync, writeFileSync } from 'node:fs'

export interface ScriptedAsk {
  tool: 'Bash' | 'Write' | 'Edit' | 'WebFetch'
  input: Record<string, unknown>
}

type Op = Record<string, unknown> & { op: string }

function frame(op: Op): Record<string, unknown> | undefined {
  if (op.op !== 'stdout' || typeof op['line'] !== 'string') return undefined
  try {
    const f = JSON.parse(op['line']) as unknown
    return f !== null && typeof f === 'object' ? (f as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const isAsk = (op: Op): boolean => {
  const f = frame(op)
  const req = f?.['request'] as Record<string, unknown> | undefined
  return f?.['type'] === 'control_request' && req?.['subtype'] === 'can_use_tool'
}

const isAnswer = (op: Op): boolean => {
  const m = op['match'] as Record<string, unknown> | undefined
  return op.op === 'expectStdin' && m?.['type'] === 'control_response'
}

/** Rewrite the asks of one scripted pass (see the header). */
export function rewriteAsks(file: string, asks: readonly ScriptedAsk[], prepend: readonly Op[] = []): void {
  let ops = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Op)
  const askAt = (): number[] => ops.flatMap((op, i) => (isAsk(op) ? [i] : []))
  // More asks than recorded: repeat the last ask and its answer after it.
  let extra = 0
  while (askAt().length < asks.length) {
    const at = askAt()
    const last = at[at.length - 1]
    if (last === undefined) throw new Error(`${file}: the recording raises no ask`)
    const answer = ops.findIndex((op, i) => i > last && isAnswer(op))
    if (answer < 0) throw new Error(`${file}: an ask without its answer`)
    extra++
    const f = frame(ops[last] as Op) as Record<string, unknown>
    const copy: Op = { op: 'stdout', line: JSON.stringify({ ...f, request_id: `perm-extra-${extra}` }) }
    const ans = structuredClone(ops[answer] as Op)
    const m = ans['match'] as { response: Record<string, unknown> }
    m.response = { ...m.response, request_id: `$extra_request_${extra}` }
    ops = [...ops.slice(0, answer + 1), copy, ans, ...ops.slice(answer + 1)]
  }
  const at = askAt()
  asks.forEach((a, n) => {
    const i = at[n] as number
    const f = frame(ops[i] as Op) as Record<string, unknown>
    const req = { ...(f['request'] as Record<string, unknown>) }
    req['tool_name'] = a.tool
    req['display_name'] = a.tool
    req['input'] = a.input
    delete req['permission_suggestions']
    delete req['description']
    ops[i] = { op: 'stdout', line: JSON.stringify({ ...f, request: req }) }
    const answer = ops.findIndex((op, j) => j > i && isAnswer(op))
    const ans = ops[answer] as Op
    const m = ans['match'] as { response: Record<string, unknown> }
    // Any answer (allow or deny) goes on.
    m.response = { ...m.response, response: '$_' }
  })
  writeFileSync(file, `${[...prepend, ...ops].map((o) => JSON.stringify(o)).join('\n')}\n`)
}
