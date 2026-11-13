#!/usr/bin/env node
// Codex fixtures against an app-server JSON schema: run weekly in CI, with the type diff, as the P0 stdin replay
// against the latest Codex CLI.
//
//   node scripts/codex-fixture-check.mjs [--schema <bundle.json>] [--fixtures <dir>] [--report <file.md>]
//   node scripts/codex-fixture-check.mjs --live-handshake --bin <codex> [--report <file.md>]
//
// Default mode validates every frame of every JSON-RPC recording under tests/fixtures/codex/app-server/ against the
// schema bundle (default: the committed protocol/v0.160.0/schema/), with the frame's own definition: a client request
// against ClientRequest, a server notification against ServerNotification, a response against the result type of the
// request it answers (protocol.ts METHODS). The weekly job runs it with the latest CLI's bundle
// (`gen-codex-types.mjs --check --schema-out <dir>`): every recorded host frame is the stdin Dim Factory sends, so a
// latest CLI that would refuse one of them shows up here, without an account or a single token.
//
// --live-handshake replays X01b's host frames (initialize, initialized, windowsSandbox/readiness) against a real
// codex with an empty temp CODEX_HOME and validates the answers against the committed schema. Nothing else is sent:
// no thread, no turn, no model call, and the user's ~/.codex is never read or written.
//
// Exit: 0 clean · 1 problems found · 2 usage error or the CLI could not be run.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_PROTOCOL_FOLDER, METHODS, SCHEMA_BUNDLE_FILE } from '../src/core/adapters/codex/protocol.ts'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
export const COMMITTED_BUNDLE = join(
  ROOT,
  'src',
  'core',
  'adapters',
  'codex',
  'protocol',
  CODEX_PROTOCOL_FOLDER,
  'schema',
  SCHEMA_BUNDLE_FILE,
)
export const FIXTURES = join(ROOT, 'tests', 'fixtures', 'codex')
const HANDSHAKE = join(FIXTURES, 'app-server', 'X01b-handshake-readiness', 'recording.jsonl')

class UsageError extends Error {}

// ---- a small JSON Schema (draft-07) validator: the subset generate-json-schema emits -----------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function typeOk(type, v) {
  switch (type) {
    case 'object':
      return isObj(v)
    case 'array':
      return Array.isArray(v)
    case 'string':
      return typeof v === 'string'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'null':
      return v === null
    default:
      return true
  }
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Validates `value` against `schema` in `bundle`. Supports $ref (#/definitions/…), type, enum, const, properties,
 * required, additionalProperties, items, oneOf/anyOf (any branch), allOf, minimum, minLength; format, default and
 * annotations are ignored. Returns problems as `<path>: <reason>` (empty = valid).
 */
export function validate(bundle, schema, value, path = '$', depth = 0) {
  if (depth > 64) return [`${path}: schema nesting too deep`]
  if (schema === true || schema === undefined) return []
  if (schema === false) return [`${path}: not allowed`]
  if (!isObj(schema)) return []
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(bundle, schema.$ref)
    if (target === undefined) return [`${path}: unknown $ref ${schema.$ref}`]
    return validate(bundle, target, value, path, depth + 1)
  }
  const problems = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeOk(t, value))) {
      return [
        `${path}: expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
      ]
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEq(e, value)))
    problems.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`)
  if ('const' in schema && !deepEq(schema.const, value))
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum)
    problems.push(`${path}: ${value} < ${schema.minimum}`)
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength)
    problems.push(`${path}: shorter than ${schema.minLength}`)
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (!Object.hasOwn(value, r)) problems.push(`${path}.${r}: required`)
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) problems.push(...validate(bundle, props[k], v, `${path}.${k}`, depth + 1))
      else if (schema.additionalProperties === false) problems.push(`${path}.${k}: not allowed here`)
      else if (isObj(schema.additionalProperties))
        problems.push(...validate(bundle, schema.additionalProperties, v, `${path}.${k}`, depth + 1))
    }
  }
  if (Array.isArray(value) && schema.items !== undefined && !Array.isArray(schema.items)) {
    value.forEach((item, i) =>
      problems.push(...validate(bundle, schema.items, item, `${path}[${i}]`, depth + 1)),
    )
  }
  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) problems.push(...validate(bundle, s, value, path, depth + 1))
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[key])) continue
    const branches = schema[key]
    const results = branches.map((s) => validate(bundle, s, value, path, depth + 1))
    if (results.some((r) => r.length === 0)) continue
    // Report the branch the value says it is (its `method` or `type` tag), else the closest one.
    const tagged = branches.flatMap((s, i) => (taggedAs(bundle, s, value) ? [results[i]] : []))
    const pool = tagged.length > 0 ? tagged : results
    const best = pool.reduce((a, b) => (b.length < a.length ? b : a))
    problems.push(...(best.length > 0 ? best : [`${path}: matches no ${key} branch`]))
  }
  return problems
}

/** A union branch whose `method` / `type` tag (enum or const) names the value's own tag. */
function taggedAs(bundle, branch, value) {
  if (!isObj(value)) return false
  const s = isObj(branch) && typeof branch.$ref === 'string' ? resolveRef(bundle, branch.$ref) : branch
  if (!isObj(s) || !isObj(s.properties)) return false
  for (const tag of ['method', 'type']) {
    const p = s.properties[tag]
    if (!isObj(p) || typeof value[tag] !== 'string') continue
    if (p.const === value[tag] || (Array.isArray(p.enum) && p.enum.includes(value[tag]))) return true
  }
  return false
}

export function resolveRef(bundle, ref) {
  if (!ref.startsWith('#/')) return undefined
  let node = bundle
  for (const part of ref.slice(2).split('/')) {
    if (!isObj(node) || !Object.hasOwn(node, part)) return undefined
    node = node[part]
  }
  return node
}

/** A definition by name (top level or under definitions.v2). */
export function definitionRef(bundle, name) {
  const defs = isObj(bundle?.definitions) ? bundle.definitions : {}
  if (Object.hasOwn(defs, name) && name !== 'v2') return `#/definitions/${name}`
  if (isObj(defs.v2) && Object.hasOwn(defs.v2, name)) return `#/definitions/v2/${name}`
  return undefined
}

// ---- recordings → typed frames ---------------------------------------------------------------------------------

const RESULT_OF = new Map(METHODS.filter((m) => m.result !== undefined).map((m) => [m.method, m.result]))

/** The JSON-RPC message of each frame, with the schema definition it must satisfy. */
export function typedFrames(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const frames = lines.map((l) => JSON.parse(l))
  const header = frames[0]
  const out = []
  /** Request ids by direction → method, to type the responses. */
  const clientRequests = new Map()
  const serverRequests = new Map()
  frames.slice(1).forEach((f, i) => {
    if ((f.dir !== 'in' && f.dir !== 'out') || typeof f.line !== 'string') return
    let msg
    try {
      msg = JSON.parse(f.line)
    } catch {
      out.push({ index: i + 2, dir: f.dir, problem: 'not JSON' })
      return
    }
    const from = f.dir === 'in' ? 'client' : 'server'
    const own = from === 'client' ? clientRequests : serverRequests
    const peer = from === 'client' ? serverRequests : clientRequests
    let root
    let kind
    if (typeof msg.method === 'string') {
      kind = Object.hasOwn(msg, 'id') ? 'request' : 'notification'
      root =
        from === 'client'
          ? kind === 'request'
            ? 'ClientRequest'
            : 'ClientNotification'
          : kind === 'request'
            ? 'ServerRequest'
            : 'ServerNotification'
      if (kind === 'request') own.set(JSON.stringify(msg.id), msg.method)
      out.push({ index: i + 2, dir: f.dir, kind, method: msg.method, msg, def: root, value: msg })
      return
    }
    const method = peer.get(JSON.stringify(msg.id))
    kind = Object.hasOwn(msg, 'error') ? 'error' : 'response'
    if (kind === 'error') {
      out.push({ index: i + 2, dir: f.dir, kind, method, msg, def: null, value: msg.error })
      return
    }
    out.push({
      index: i + 2,
      dir: f.dir,
      kind,
      method,
      msg,
      def: method === undefined ? undefined : (RESULT_OF.get(method) ?? null),
      value: msg.result,
    })
  })
  return { header, frames: out }
}

const RPC_ERROR = {
  type: 'object',
  required: ['code', 'message'],
  properties: { code: { type: 'integer' }, message: { type: 'string' } },
}

/** Every schema problem of one JSON-RPC recording (empty = every frame is valid). */
export function checkRecording(bundle, text) {
  const { frames } = typedFrames(text)
  const problems = []
  for (const f of frames) {
    const at = `frame ${f.index} (${f.dir} ${f.kind ?? '?'}${f.method ? ` ${f.method}` : ''})`
    if (f.problem) {
      problems.push(`${at}: ${f.problem}`)
      continue
    }
    if (f.kind === 'error') {
      problems.push(...validate(bundle, RPC_ERROR, f.value).map((p) => `${at}: ${p}`))
      continue
    }
    if (f.def === undefined) {
      problems.push(`${at}: answers an id no request of the other side used`)
      continue
    }
    if (f.def === null) {
      // A response whose type Dim Factory's table does not name (an empty object or null result).
      if (f.value !== null && !isObj(f.value)) problems.push(`${at}: result is not an object`)
      continue
    }
    const ref = definitionRef(bundle, f.def)
    if (ref === undefined) {
      problems.push(`${at}: the schema has no ${f.def}`)
      continue
    }
    problems.push(...validate(bundle, { $ref: ref }, f.value).map((p) => `${at}: ${p}`))
  }
  return problems
}

/** The JSON-RPC recordings under `dir` (<ID>-<slug>/recording.jsonl with "protocol":"jsonrpc"). */
export function jsonRpcRecordings(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name === 'recording.jsonl')
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => {
      const first = readFileSync(p, 'utf8').split('\n')[0] ?? ''
      try {
        return JSON.parse(first).protocol === 'jsonrpc'
      } catch {
        return false
      }
    })
    .sort()
}

// ---- live handshake ---------------------------------------------------------------------------------------------

/** X01b's host frames against a real CLI (empty temp CODEX_HOME); returns the answers, one per request. */
async function liveHandshake(bin, timeoutMs = 60_000) {
  const { frames } = typedFrames(readFileSync(HANDSHAKE, 'utf8'))
  const sends = frames.filter((f) => f.dir === 'in').map((f) => f.msg)
  const home = mkdtempSync(join(tmpdir(), 'dim-factory-codex-handshake-'))
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CODEX_|OPENAI_|NODE_OPTIONS$)/i.test(k)) env[k] = v
  }
  env.CODEX_HOME = home
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
    cwd: home,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const answers = new Map()
  const notifications = []
  let buffer = ''
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.method === 'string') notifications.push(msg)
      else if (Object.hasOwn(msg, 'id')) {
        answers.set(JSON.stringify(msg.id), msg)
        waiters.get(JSON.stringify(msg.id))?.()
      }
    }
  })
  child.stderr.resume()
  const exited = new Promise((done) => child.once('close', (code) => done(code)))
  const failed = new Promise((_, fail) => child.once('error', (e) => fail(e)))
  try {
    for (const msg of sends) {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
      if (!Object.hasOwn(msg, 'id')) continue
      const key = JSON.stringify(msg.id)
      await Promise.race([
        failed,
        new Promise((done, fail) => {
          if (answers.has(key)) return done()
          const timer = setTimeout(
            () => fail(new Error(`no answer to ${msg.method} in ${timeoutMs} ms`)),
            timeoutMs,
          )
          waiters.set(key, () => {
            clearTimeout(timer)
            done()
          })
        }),
      ])
    }
    child.stdin.end()
    const code = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done('timeout'), 10_000)),
    ])
    if (code === 'timeout') child.kill()
    return { sends, answers, notifications, code }
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  }
}

function liveProblems(bundle, r) {
  const problems = []
  for (const msg of r.sends) {
    if (!Object.hasOwn(msg, 'id')) continue
    const answer = r.answers.get(JSON.stringify(msg.id))
    if (answer === undefined) {
      problems.push(`${msg.method}: no answer`)
      continue
    }
    if (Object.hasOwn(answer, 'error')) {
      // Off Windows, readiness may well be refused (there is no Windows sandbox to report on).
      if (msg.method === 'windowsSandbox/readiness' && process.platform !== 'win32') continue
      problems.push(`${msg.method}: error ${JSON.stringify(answer.error)}`)
      continue
    }
    const type = RESULT_OF.get(msg.method)
    const ref = type ? definitionRef(bundle, type) : undefined
    if (ref !== undefined)
      problems.push(...validate(bundle, { $ref: ref }, answer.result).map((p) => `${msg.method}: ${p}`))
  }
  const root = definitionRef(bundle, 'ServerNotification')
  for (const n of r.notifications) {
    // A notification method this schema does not know is drift too (the adapter treats it as liveness).
    if (root !== undefined)
      problems.push(...validate(bundle, { $ref: root }, n).map((p) => `notification ${n.method}: ${p}`))
  }
  if (r.code !== 0) problems.push(`the app-server exited ${r.code} after stdin closed (expected 0)`)
  return problems
}

// ---- CLI --------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { liveHandshake: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--schema') opts.schema = next()
    else if (a === '--fixtures') opts.fixtures = next()
    else if (a === '--report') opts.report = next()
    else if (a === '--bin') opts.bin = next()
    else if (a === '--live-handshake') opts.liveHandshake = true
    else if (a === '--help') opts.help = true
    else throw new UsageError(`unknown argument ${a}`)
  }
  return opts
}

async function main(opts) {
  const schemaPath = resolve(opts.schema ?? COMMITTED_BUNDLE)
  const bundle = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const lines = []
  let problemCount = 0
  if (opts.liveHandshake) {
    if (!opts.bin) throw new UsageError('--live-handshake needs --bin <codex>')
    const r = await liveHandshake(opts.bin)
    const problems = liveProblems(bundle, r)
    problemCount += problems.length
    lines.push(`## Codex live handshake (${opts.bin}) against ${relative(ROOT, schemaPath)}`, '')
    lines.push(problems.length === 0 ? 'Clean.' : problems.map((p) => `- ${p}`).join('\n'))
  } else {
    const dir = resolve(opts.fixtures ?? join(FIXTURES, 'app-server'))
    const files = jsonRpcRecordings(dir)
    if (files.length === 0) throw new UsageError(`no JSON-RPC recordings under ${dir}`)
    lines.push(`## Codex fixtures (${files.length}) against ${relative(ROOT, schemaPath) || schemaPath}`, '')
    for (const file of files) {
      const problems = checkRecording(bundle, readFileSync(file, 'utf8'))
      problemCount += problems.length
      if (problems.length > 0) {
        lines.push(`### ${relative(dir, dirname(file))}`, ...problems.map((p) => `- ${p}`), '')
      }
    }
    if (problemCount === 0) lines.push('Every frame is valid.')
  }
  const text = `${lines.join('\n')}\n`
  process.stdout.write(text)
  if (opts.report) writeFileSync(resolve(opts.report), text)
  return problemCount === 0 ? 0 : 1
}

const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
if (process.platform === 'win32' ? argv1.toLowerCase() === SELF.toLowerCase() : argv1 === SELF) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      process.stdout.write(
        `${readFileSync(SELF, 'utf8')
          .split('\n')
          .slice(1)
          .filter((l) => l.startsWith('//'))
          .map((l) => l.replace(/^\/\/ ?/, ''))
          .join('\n')}\n`,
      )
    } else {
      process.exitCode = await main(opts)
    }
  } catch (err) {
    process.stderr.write(`codex-fixture-check: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  }
}
