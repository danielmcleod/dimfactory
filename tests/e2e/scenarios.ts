// Fake-Claude scenarios for the E2E specs, built on the integration helpers'
// recordings (tests/integration/run/scenario.ts), plus a rewrite that turns one pass's final answer into a long
// stream of text deltas (reload-mid-stream.spec.ts, and performance.spec.ts's 5 MB replay).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'

export const VERSION_WRITE = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
export const FIX_WRITE = { path: 'src/version.test.ts', content: 'import "./version"\n' }

/**
 * Plan → Implement (asks to run a PowerShell command, then writes a file) → Review finds 2 must + 1 should → Fix
 * resumes Implement's session.
 */
export const FIXED_FLOW: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C03-accept-edits', write: VERSION_WRITE }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  resume: [
    {
      recording: 'C08b-resume-fix',
      write: FIX_WRITE,
      text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 skipped: not worth the churn',
    },
  ],
}

/** Plan → Implement (no asks; writes a file) → both reviewers answer NO FINDINGS (the default) → Fix skipped. */
export const CLEAN_FLOW: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
}

/** Implement parks in a long sleep right after it reads its prompt (Stop and kill tests). */
export const PARKED_IMPLEMENT: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE, delayMs: 300_000 }],
}

/**
 * Plan → Implement whose final answer is `text` (no asks; rewrite it into many deltas with streamDeltas on
 * 'implement-1') → NO FINDINGS reviewers.
 */
export function streamingImplement(text: string): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE, text }],
  }
}

/** Deterministic markdown-ish text of about `bytes` characters (ASCII, so characters = bytes). */
export function longText(bytes: number): string {
  const words = ['factories', 'stream', 'delta', 'replay', 'buffer', 'review', 'implement', 'focus', 'seq']
  const lines: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const line =
      i % 40 === 0
        ? `## Section ${i / 40 + 1}`
        : `- line ${i}: ${Array.from({ length: 10 }, (_, k) => words[(i * 7 + k) % words.length]).join(' ')}`
    lines.push(line)
    size += line.length + 1
  }
  return `${lines.join('\n')}\n`.slice(0, bytes)
}

/** Split text into chunks of `size` characters (the last may be shorter). */
export function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/**
 * Rewrite `<name>.script.jsonl` (written by makeScenario with `text: fullText`): the one text delta carrying
 * `fullText` becomes deltas of `chunkSize` characters, with a `sleep` of `sleepMs` after every `sleepEvery`.
 */
export function streamDeltas(
  sc: Scenario,
  name: string,
  fullText: string,
  o: { chunkSize: number; sleepMs?: number; sleepEvery?: number },
): void {
  const file = join(sc.dir, `${name}.script.jsonl`)
  const lines = readFileSync(file, 'utf8').split('\n')
  let replaced = 0
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const op = JSON.parse(line) as { op: string; line?: unknown }
    const frame = op.op === 'stdout' && typeof op.line === 'string' ? tryJson(op.line) : undefined
    const delta = frame?.['event'] as { delta?: { type?: string; text?: string } } | undefined
    if (
      frame?.['type'] === 'stream_event' &&
      delta?.delta?.type === 'text_delta' &&
      delta.delta.text === fullText
    ) {
      const parts = chunk(fullText, o.chunkSize)
      parts.forEach((text, i) => {
        delta.delta = { type: 'text_delta', text }
        out.push(JSON.stringify({ op: 'stdout', line: JSON.stringify(frame) }))
        if (o.sleepMs !== undefined && (i + 1) % (o.sleepEvery ?? 1) === 0)
          out.push(JSON.stringify({ op: 'sleep', ms: o.sleepMs }))
      })
      replaced++
      continue
    }
    out.push(line)
  }
  if (replaced !== 1) throw new Error(`${name}: expected one delta carrying the full text, found ${replaced}`)
  writeFileSync(file, `${out.join('\n')}\n`)
}

function tryJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
