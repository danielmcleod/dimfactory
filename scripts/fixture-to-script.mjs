#!/usr/bin/env node
// Converts a raw recording.jsonl into a hand-editable fake-cli script.jsonl:
//   out -> stdout · err -> stderr · in -> expectStdin (partial match) · exit -> exit
// Volatile ids the host sent (request_id/requestId/id/uuid) become "$captures", and later output that echoes
// them is rewritten to "$var", so the script answers whatever ids the host generates at replay time.
//
//   node scripts/fixture-to-script.mjs <recording.jsonl | fixtureDir> [--out <script.jsonl> | --out -] [--sleep]
//
// --sleep keeps the recorded timing as sleep ops (default: none). Default output: script.jsonl next to the
// recording.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISO_TIME_RE,
  TIMESTAMP_KEY_RE,
  VOLATILE_KEYS,
  hostNamePattern,
  isPlaceholder,
  parseJsonl,
  tryParseJson,
} from '../tests/fake-cli/fake-cli.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {string} text recording.jsonl content
 * @param {{sleep?: boolean}} [options]
 * @returns {string} script.jsonl content
 */
export function recordingToScript(text, { sleep = false } = {}) {
  const entries = parseJsonl(text, 'recording.jsonl')
  const header = entries[0]?.value
  if (!isObject(header) || header.kind !== 'header')
    throw new Error('not a recording: the first line must be a header')

  /** recorded id value -> var name */
  const ids = new Map()
  let counter = 0
  const ops = [{ op: 'label', name: 'start', source: header.scenario ?? null, vendor: header.vendor ?? null }]
  let prevT = 0

  // Input frames: volatile ids become fresh captures; placeholders and timestamps match anything.
  const toPattern = (value, key) => {
    if (
      key !== undefined &&
      VOLATILE_KEYS.has(key) &&
      (typeof value === 'string' || typeof value === 'number')
    ) {
      if (isPlaceholder(value)) return '$_'
      counter += 1
      const name = `${key.replace(/[^A-Za-z0-9_]/g, '_')}_${counter}`
      if (!ids.has(value)) ids.set(value, name)
      return `$${name}`
    }
    if (isPlaceholder(value)) return '$_'
    if (
      key !== undefined &&
      TIMESTAMP_KEY_RE.test(key) &&
      (typeof value === 'string' || typeof value === 'number')
    )
      return '$_'
    if (typeof value === 'string') {
      if (ISO_TIME_RE.test(value)) return '$_'
      // The host's name when the recording was made matches the host's name now (masked like an id).
      const host = hostNamePattern(value)
      if (host !== undefined) return { $regex: host }
      // A literal '$' would read as a var reference; match such strings exactly via a regex instead.
      return value.includes('$') ? { $regex: `^${escapeRe(value)}$` } : value
    }
    if (Array.isArray(value)) return value.map((v) => toPattern(v, undefined))
    if (isObject(value)) {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = toPattern(v, k)
      return out
    }
    return value
  }

  // Output frames: recorded ids the host chose are replaced by their capture vars.
  const toTemplate = (value, key) => {
    const volatile = key !== undefined && VOLATILE_KEYS.has(key)
    if (typeof value === 'string') {
      if (ids.has(value) && (volatile || value.length >= 4)) return `$${ids.get(value)}`
      let out = value
      for (const [from, name] of ids) {
        if (typeof from === 'string' && from.length >= 8 && out.includes(from))
          out = out.split(from).join(`\${${name}}`)
      }
      return out
    }
    if (typeof value === 'number' && volatile && ids.has(value)) return `$${ids.get(value)}`
    if (Array.isArray(value)) return value.map((v) => toTemplate(v, undefined))
    if (isObject(value)) {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = toTemplate(v, k)
      return out
    }
    return value
  }

  const textOp = (op, frame) => {
    const line = String(frame.line ?? '')
    if (frame.eol === false || frame.crlf === true) {
      return { op, raw: line + (frame.eol === false ? '' : '\r\n') }
    }
    const parsed = tryParseJson(line)
    if (op === 'stdout' && parsed.ok && parsed.value !== null && typeof parsed.value === 'object') {
      const templated = toTemplate(parsed.value, undefined)
      const rendered = JSON.stringify(templated)
      // Keep the recorded bytes unless an id substitution is needed.
      return { op, line: rendered === JSON.stringify(parsed.value) ? line : rendered }
    }
    return { op, line }
  }

  for (const { value: frame } of entries.slice(1)) {
    if (!isObject(frame)) continue
    if (sleep && typeof frame.t === 'number' && frame.t > prevT)
      ops.push({ op: 'sleep', ms: frame.t - prevT })
    if (typeof frame.t === 'number') prevT = frame.t
    switch (frame.dir) {
      case 'out':
        ops.push(textOp('stdout', frame))
        break
      case 'err':
        ops.push(textOp('stderr', frame))
        break
      case 'in': {
        const line = String(frame.line ?? '')
        const parsed = tryParseJson(line)
        ops.push(
          parsed.ok && parsed.value !== null && typeof parsed.value === 'object'
            ? { op: 'expectStdin', match: toPattern(parsed.value, undefined) }
            : { op: 'expectStdin', matchRegex: `^${escapeRe(line)}$` },
        )
        break
      }
      case 'exit':
        ops.push(
          typeof frame.code === 'number'
            ? { op: 'exit', code: frame.code }
            : { op: 'exit', ...(typeof frame.signal === 'string' ? { signal: frame.signal } : { code: 1 }) },
        )
        break
      default:
        break
    }
  }
  return ops.map((op) => JSON.stringify(op)).join('\n') + '\n'
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function main(argv) {
  let input
  let out
  let sleep = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out = argv[++i]
    else if (a === '--sleep') sleep = true
    else if (a === '--help') {
      process.stdout.write(
        'usage: node scripts/fixture-to-script.mjs <recording.jsonl|fixtureDir> [--out <file>|-] [--sleep]\n',
      )
      return 0
    } else if (input === undefined) input = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (input === undefined) throw new Error('missing <recording.jsonl | fixtureDir>')
  let file = resolve(input)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'recording.jsonl')
  const script = recordingToScript(readFileSync(file, 'utf8'), { sleep })
  if (out === '-') {
    process.stdout.write(script)
    return 0
  }
  const target = resolve(out ?? join(dirname(file), 'script.jsonl'))
  writeFileSync(target, script)
  process.stdout.write(`${target}\n`)
  return 0
}

const self = fileURLToPath(import.meta.url)
const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
if (process.platform === 'win32' ? argv1.toLowerCase() === self.toLowerCase() : argv1 === self) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`fixture-to-script: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  }
}
