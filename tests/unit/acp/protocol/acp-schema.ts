// The pinned ACP schema (src/core/adapters/acp-base/protocol/v1.25.0/) as a validator for the unit suites (every
// fixture frame against the vendored protocol). Reuses the JSON Schema subset validator of
// scripts/codex-fixture-check.mjs; ACP definitions live under `$defs` and name their method in `x-method` / `x-side`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validate } from '../../../../scripts/codex-fixture-check.mjs'
import { ACP_PROTOCOL_DIR } from './fixtures.ts'
import type { Json } from './fixtures.ts'

export const STABLE: unknown = JSON.parse(readFileSync(join(ACP_PROTOCOL_DIR, 'schema.json'), 'utf8'))
export const UNSTABLE: unknown = JSON.parse(
  readFileSync(join(ACP_PROTOCOL_DIR, 'schema.unstable.json'), 'utf8'),
)

const defsOf = (bundle: unknown): Record<string, Json> =>
  ((bundle as Json)['$defs'] ?? {}) as Record<string, Json>

/** Every method the schema names: its side and the definitions of its params, result and notification. */
export interface SchemaMethod {
  side: string
  request?: string
  response?: string
  notification?: string
}

export function schemaMethods(bundle: unknown): Map<string, SchemaMethod> {
  const out = new Map<string, SchemaMethod>()
  for (const [name, def] of Object.entries(defsOf(bundle))) {
    const method = def['x-method']
    const side = def['x-side']
    if (typeof method !== 'string' || typeof side !== 'string') continue
    const entry = out.get(method) ?? { side }
    if (name.endsWith('Request') && !name.endsWith('CancelRequest')) entry.request = name
    else if (name.endsWith('Response')) entry.response = name
    else if (name.endsWith('Notification')) entry.notification = name
    out.set(method, entry)
  }
  return out
}

/** Problems of `value` against the definition `name` of both pinned schemas (stable and unstable). */
export function checkDef(name: string, value: unknown): string[] {
  const problems: string[] = []
  for (const [label, bundle] of [
    ['stable', STABLE],
    ['unstable', UNSTABLE],
  ] as const) {
    if (defsOf(bundle)[name] === undefined) {
      if (label === 'unstable') problems.push(`${name}: not in the unstable schema`)
      continue
    }
    problems.push(...validate(bundle, { $ref: `#/$defs/${name}` }, value).map((p) => `${label} ${name} ${p}`))
  }
  return problems
}

/**
 * Methods Gemini CLI 0.62 still speaks that schema v1.25.0 dropped (protocol.ts ACP_METHODS, stable: false). A frame
 * of one of these is checked as JSON-RPC only.
 */
const UNPINNED = new Set(['session/set_model'])

const ERROR = {
  type: 'object',
  required: ['code', 'message'],
  properties: { code: { type: 'integer' }, message: { type: 'string' } },
}

/**
 * Every schema problem of one ACP recording: each frame is JSON-RPC 2.0, each request and notification is valid for
 * its method's definition on the side that sent it, each response for the result of the request it answers (under
 * that request's own id space), each error a JSON-RPC error object.
 */
export function checkAcpRecording(text: string): string[] {
  const methods = schemaMethods(STABLE)
  const frames = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(1)
    .map((l) => JSON.parse(l) as Json)
  const problems: string[] = []
  /** Request ids by sender: client (in) and agent (out). */
  const asked = { in: new Map<string, string>(), out: new Map<string, string>() }
  frames.forEach((f, i) => {
    if ((f['dir'] !== 'in' && f['dir'] !== 'out') || typeof f['line'] !== 'string') return
    const dir = f['dir']
    const at = `frame ${i + 2} (${dir})`
    let msg: Json
    try {
      msg = JSON.parse(f['line']) as Json
    } catch {
      problems.push(`${at}: not JSON`)
      return
    }
    if (msg['jsonrpc'] !== '2.0') problems.push(`${at}: no "jsonrpc":"2.0"`)
    const method = msg['method']
    if (typeof method === 'string') {
      const isRequest = Object.hasOwn(msg, 'id')
      if (isRequest) asked[dir].set(JSON.stringify(msg['id']), method)
      if (UNPINNED.has(method)) return
      const m = methods.get(method)
      // The host (in) calls agent-side methods; the agent (out) calls client-side ones.
      const wantSide = dir === 'in' ? 'agent' : 'client'
      if (m === undefined || (m.side !== wantSide && m.side !== 'protocol')) {
        problems.push(`${at}: ${method} is not handled by the ${wantSide} in the schema`)
        return
      }
      const def = isRequest ? m.request : m.notification
      if (def === undefined) {
        problems.push(`${at}: ${method} is not a ${isRequest ? 'request' : 'notification'}`)
        return
      }
      problems.push(...checkDef(def, msg['params']).map((p) => `${at} ${method}: ${p}`))
      return
    }
    // A response: it answers a request the other side made.
    const other = dir === 'in' ? asked.out : asked.in
    const answered = other.get(JSON.stringify(msg['id']))
    if (answered === undefined) {
      problems.push(`${at}: answers an id no request of the other side used`)
      return
    }
    if (Object.hasOwn(msg, 'error')) {
      problems.push(...validate(STABLE, ERROR, msg['error']).map((p) => `${at} error: ${p}`))
      return
    }
    if (UNPINNED.has(answered)) return
    const def = methods.get(answered)?.response
    if (def === undefined) problems.push(`${at}: no result definition for ${answered}`)
    else problems.push(...checkDef(def, msg['result']).map((p) => `${at} ${answered}: ${p}`))
  })
  return problems
}
