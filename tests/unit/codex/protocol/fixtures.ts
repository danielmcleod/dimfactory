// Loads the Codex fixtures (tests/fixtures/codex/{app-server,exec}/<ID>-<slug>/) for the unit suites: the
// recording's header, frames and JSON messages, and expected.events.json.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CODEX_FIXTURES = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))

export type Route = 'app-server' | 'exec'
export type Json = Record<string, unknown>

export interface Frame {
  t?: number
  dir: 'in' | 'out' | 'err' | 'eof' | 'file' | 'hold' | 'exit'
  line?: string
  code?: number | null
  argvPath?: string
  content?: string
}

export interface Pass {
  kind: 'pass' | 'probe' | 'listModels' | 'vendorSetup'
  route?: 'exec'
  step?: string
  mode?: 'readonly' | 'autoedit' | 'full'
  planNative?: boolean
  prompt?: string
  answers?: { decision: string; why?: string }[]
  resume?: { sessionId: string; priorUsage?: Usage }
  local?: { baseUrl: string; model: string }
  structured?: boolean
  [k: string]: unknown
}

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface Fixture {
  name: string
  route: Route
  dir: string
  text: string
  header: Json & { argv: string[]; pass?: Pass; synthesized?: boolean; scenario: string; route: string }
  frames: Frame[]
  expected: Json[]
}

export function fixtureNames(route: Route): string[] {
  return readdirSync(join(CODEX_FIXTURES, route), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function loadFixture(route: Route, name: string): Fixture {
  const dir = join(CODEX_FIXTURES, route, name)
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json)
  const expected = JSON.parse(readFileSync(join(dir, 'expected.events.json'), 'utf8')) as Json[]
  return {
    name,
    route,
    dir,
    text,
    header: header as Fixture['header'],
    frames: frames as unknown as Frame[],
    expected,
  }
}

export const allFixtures = (): Fixture[] => [
  ...fixtureNames('app-server').map((n) => loadFixture('app-server', n)),
  ...fixtureNames('exec').map((n) => loadFixture('exec', n)),
]

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

export const EVENT_TYPES = new Set(['session', 'text', 'tool', 'ask', 'done', 'error'])
export const READ_ONLY_STEPS = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])

/** The result the CLI answered to the first client request for `method` (live balanced run: thread/start, model/list). */
export function resultOf(fx: Fixture, method: string): unknown {
  const req = messages(fx, 'in').find((x) => x['method'] === method && 'id' in x)
  if (req === undefined) return undefined
  return messages(fx, 'out').find((x) => x['id'] === req['id'] && 'result' in x)?.['result']
}
