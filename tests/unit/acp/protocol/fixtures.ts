// Loads the Gemini ACP fixtures (tests/fixtures/gemini/acp/<ID>-<slug>/) for the unit suites: the recording's
// header, frames and JSON-RPC messages, and expected.events.json.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GEMINI_FIXTURES = fileURLToPath(new URL('../../../fixtures/gemini/', import.meta.url))
export const ACP_PROTOCOL_DIR = fileURLToPath(
  new URL('../../../../src/core/adapters/acp-base/protocol/v1.25.0/', import.meta.url),
)

export type Json = Record<string, unknown>

export interface Frame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'eof' | 'hold' | 'file' | 'exit'
  line?: string
  code?: number | null
  /** A `file` frame: a file the CLI wrote at that point (Gemini's plan file), and what it holds. */
  path?: string
  content?: string
}

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  costUsd?: number
}

export interface Pass {
  kind: 'pass' | 'probe'
  step?: string
  mode?: 'readonly' | 'autoedit' | 'full'
  planNative?: boolean
  prompt?: string
  model?: string
  trustFolder?: boolean
  answers?: { decision: string; why?: string }[]
  stop?: { after: Json; reason: 'user' | 'timeout' }
  resume?: { sessionId: string; priorUsage?: Usage }
}

export interface Fixture {
  name: string
  dir: string
  text: string
  header: Json & { argv: string[]; pass?: Pass; synthesized?: boolean; scenario: string; route: string }
  frames: Frame[]
  expected: Json[]
}

export function fixtureNames(): string[] {
  return readdirSync(join(GEMINI_FIXTURES, 'acp'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadFixture(name: string): Fixture {
  const dir = join(GEMINI_FIXTURES, 'acp', name)
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json)
  const expected = JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as Json[]
  return {
    name,
    dir,
    text,
    header: header as Fixture['header'],
    frames: frames as unknown as Frame[],
    expected,
  }
}

export const allFixtures = (): Fixture[] => fixtureNames().map(loadFixture)

export function message(f: Frame): Json | undefined {
  if (f.line === undefined) return undefined
  try {
    const v = JSON.parse(f.line) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

/** The messages one side sent, in order. */
export function messages(fx: Fixture, dir: 'in' | 'out'): Json[] {
  return fx.frames.flatMap((f) => {
    if (f.dir !== dir) return []
    const m = message(f)
    return m === undefined ? [] : [m]
  })
}

/** The params of the first client request for `method`. */
export function requestParams(fx: Fixture, method: string): Json | undefined {
  const m = messages(fx, 'in').find((x) => x['method'] === method && 'id' in x)
  return m === undefined ? undefined : ((m['params'] ?? {}) as Json)
}

/** The answer (result or error message) to the client request for `method`. */
export function responseTo(fx: Fixture, method: string): Json | undefined {
  const req = messages(fx, 'in').find((x) => x['method'] === method && 'id' in x)
  if (req === undefined) return undefined
  return messages(fx, 'out').find((m) => m['id'] === req['id'] && typeof m['method'] !== 'string')
}

/** The session/update `update` objects the agent sent, in order. */
export function updates(fx: Fixture): Json[] {
  return messages(fx, 'out')
    .filter((m) => m['method'] === 'session/update')
    .map((m) => (m['params'] as Json)['update'] as Json)
}

export const EVENT_TYPES = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
export const READ_ONLY_STEPS = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])
