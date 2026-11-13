// Recorded fixture → ClassifyInput. A fixture directory opts into classifier assertions with an
// `expected.failure.json`: {"category": <FailureCategory|null>, "classifiedBy"?, "rule"?, "appInitiated"?}.
// `category: null` asserts "not a failure". Phase 2 recordings (C09 auth, C08 bogus resume, C11 bad flag,
// C12 max-turns, …) add these files; nothing else needs to change.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ClassifyInput, AppKill } from '@core/heal/classify.ts'
import type { ClassifiedBy, FailureCategory } from '@shared/failure.ts'

export interface ExpectedFailure {
  category: FailureCategory | null
  classifiedBy?: ClassifiedBy
  rule?: string
  appInitiated?: AppKill
  /** Fixed clock for resetsAt-based assertions. */
  now?: number
}

export interface FixtureCase {
  id: string
  dir: string
  vendor: string
  input: ClassifyInput
  expected: ExpectedFailure
}

interface Frame {
  t?: number
  dir?: string
  line?: string
  code?: number | null
  signal?: string | null
  kind?: string
  vendor?: string
}

export function inputFromRecording(recordingPath: string, vendor: string): ClassifyInput {
  const structured: unknown[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let exitCode: number | null | undefined
  let signal: string | null | undefined
  let lastT = 0
  let malformed = 0
  let maxMalformed = 0
  for (const raw of readFileSync(recordingPath, 'utf8').split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const f = JSON.parse(raw) as Frame
    if (f.kind === 'header') continue
    if (typeof f.t === 'number') lastT = f.t
    if (f.dir === 'out' && typeof f.line === 'string') {
      try {
        structured.push(JSON.parse(f.line))
        malformed = 0
      } catch {
        stdout.push(f.line)
        maxMalformed = Math.max(maxMalformed, ++malformed)
      }
    } else if (f.dir === 'err' && typeof f.line === 'string') {
      stderr.push(f.line)
    } else if (f.dir === 'exit') {
      exitCode = f.code ?? null
      signal = f.signal ?? null
    }
  }
  const input: ClassifyInput = { vendor, structured, stderrTail: stderr, stdoutTail: stdout, ranMs: lastT }
  if (exitCode !== undefined) input.exitCode = exitCode
  if (signal !== undefined) input.signal = signal
  if (maxMalformed > 0) input.protocol = { malformedLines: maxMalformed }
  return input
}

/** Every `tests/fixtures/<vendor>/<route>/<ID>/` with both recording.jsonl and expected.failure.json. */
export function failureFixtureCases(root: string): FixtureCase[] {
  const out: FixtureCase[] = []
  if (!existsSync(root)) return out
  const dirs = (p: string): string[] =>
    readdirSync(p)
      .map((n) => join(p, n))
      .filter((d) => statSync(d).isDirectory())
  for (const vendorDir of dirs(root)) {
    const vendor = vendorDir.split(/[\\/]/).pop()!
    for (const routeDir of dirs(vendorDir)) {
      for (const dir of dirs(routeDir)) {
        const rec = join(dir, 'recording.jsonl')
        const exp = join(dir, 'expected.failure.json')
        if (!existsSync(rec) || !existsSync(exp)) continue
        const expected = JSON.parse(readFileSync(exp, 'utf8')) as ExpectedFailure
        const input = inputFromRecording(rec, vendor)
        if (expected.appInitiated) input.appInitiated = { kind: expected.appInitiated }
        if (expected.now !== undefined) input.now = expected.now
        out.push({ id: dir.split(/[\\/]/).pop()!, dir, vendor, input, expected })
      }
    }
  }
  return out
}
