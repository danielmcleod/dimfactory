#!/usr/bin/env node
// Codex app-server protocol types (generated with generate-ts, committed under
// protocol/v0.160.0/, diffed weekly in CI). Runs only the generators of an installed codex, with an empty temp CODEX_HOME.
//
//   node scripts/gen-codex-types.mjs [--bin <codex>] [--folder v0.160.0] [--out-root <dir>]
//   node scripts/gen-codex-types.mjs --check [--bin <codex>] [--report <file.md>] [--strict]
//
// Write mode replaces <out-root>/<folder>/ with:
//   *.ts, v2/*.ts, serde_json/*.ts   `codex app-server generate-ts --experimental` output, byte for byte (LF)
//   schema/codex_app_server_protocol.schemas.json   the `generate-json-schema --experimental` bundle (LF)
//   methods.json                     every method by direction, with `experimental` from a stable-schema diff
//   meta.json                        cliVersion, the commands, file count and a content hash
// --experimental is used because Dim Factory's native Plan sends turn/start.collaborationMode, an experimental field
// (initialize capabilities.experimentalApi). methods.json marks what a stable-only client cannot use.
//
// --check generates into a temp dir and compares with the committed folder (meta.json aside). The report lists
// added/removed/changed files and methods, the watched types whose definition changed (informational) and the shape
// problems (protocol.ts shapeProblems) the new schema has and the committed one has not. Exit: 0 no breaking change ·
// 1 a required method (protocol.ts REQUIRED_METHODS) is missing or a new shape problem appeared (a property or value
// Dim Factory sends or reads is gone, or a type Dim Factory sends gained a required property) · 1 any difference with
// --strict · 2 usage or generator failure. Nothing outside the temp dir is written in --check mode.
// --schema-out <dir> (with --check) also keeps the generated schema bundle there, for scripts/codex-fixture-check.mjs.
//
// The generators never contact the network or an account; CODEX_HOME points at an empty temp directory (codex then
// refuses to create its PATH helper binaries there and says so on stderr, which is expected).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_PROTOCOL_FOLDER,
  REQUIRED_METHODS,
  SCHEMA_BUNDLE_FILE,
  WATCHED_TYPES,
  methodSetFromSchema,
  shapeProblems,
} from '../src/core/adapters/codex/protocol.ts'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const DEFAULT_OUT_ROOT = join(ROOT, 'src', 'core', 'adapters', 'codex', 'protocol')
const GENERATED_BY = 'scripts/gen-codex-types.mjs'

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { check: false, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--bin') opts.bin = next()
    else if (a === '--folder') opts.folder = next()
    else if (a === '--out-root') opts.outRoot = next()
    else if (a === '--report') opts.report = next()
    else if (a === '--schema-out') opts.schemaOut = next()
    else if (a === '--check') opts.check = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--help') opts.help = true
    else throw new UsageError(`unknown argument ${a}`)
  }
  return opts
}

/** The env for the generators: inherited, minus Codex sandbox and API-key variables, with an empty CODEX_HOME. */
function generatorEnv(codexHome) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^(CODEX_|OPENAI_|NODE_OPTIONS$)/i.test(k)) continue
    env[k] = v
  }
  env.CODEX_HOME = codexHome
  env.NO_COLOR = '1'
  return env
}

function run(bin, args, env) {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  if (r.error) throw new Error(`${bin} ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} exited ${r.status}\n${(r.stderr ?? '').trim().slice(-2000)}`)
  }
  return r
}

/** `codex-cli 0.160.1` → `0.160.1` (prerelease suffix kept). */
export function parseCodexVersion(text) {
  const m = /codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)
  return m ? m[1] : null
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replace(/\\/g, '/'))
    .sort()
}

const lf = (text) => text.replace(/\r\n/g, '\n')

/**
 * Generate into `<tmp>/out`: TS, the schema bundle, methods.json. Returns the output dir, the CLI version and
 * the parsed bundle.
 */
function generate(bin) {
  const tmp = mkdtempSync(join(tmpdir(), 'dim-factory-codex-gen-'))
  const home = join(tmp, 'codex-home')
  mkdirSync(home)
  const env = generatorEnv(home)
  const v = run(bin, ['--version'], env)
  const cliVersion = parseCodexVersion(`${v.stdout}\n${v.stderr}`)
  if (cliVersion === null)
    throw new Error(`not a Codex CLI: ${bin} --version printed ${JSON.stringify(v.stdout)}`)

  const ts = join(tmp, 'ts')
  const schemaExp = join(tmp, 'schema-experimental')
  const schemaStable = join(tmp, 'schema-stable')
  for (const d of [ts, schemaExp, schemaStable]) mkdirSync(d)
  run(bin, ['app-server', 'generate-ts', '--experimental', '--out', ts], env)
  run(bin, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaExp], env)
  run(bin, ['app-server', 'generate-json-schema', '--out', schemaStable], env)

  const out = join(tmp, 'out')
  mkdirSync(out)
  for (const rel of listFiles(ts)) {
    if (!rel.endsWith('.ts')) continue
    const target = join(out, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, lf(readFileSync(join(ts, rel), 'utf8')))
  }
  const bundleText = lf(readFileSync(join(schemaExp, SCHEMA_BUNDLE_FILE), 'utf8'))
  mkdirSync(join(out, 'schema'))
  writeFileSync(join(out, 'schema', SCHEMA_BUNDLE_FILE), bundleText)
  const bundle = JSON.parse(bundleText)
  const stable = JSON.parse(readFileSync(join(schemaStable, SCHEMA_BUNDLE_FILE), 'utf8'))
  writeFileSync(join(out, 'methods.json'), `${JSON.stringify(methodsInventory(bundle, stable), null, 2)}\n`)
  return { tmp, out, cliVersion, bundle }
}

/** Every method by direction; `experimental` = absent from the stable (non --experimental) schema. */
export function methodsInventory(bundle, stable) {
  const exp = methodSetFromSchema(bundle)
  const st = methodSetFromSchema(stable)
  const list = (key) => [...exp[key]].sort().map((method) => ({ method, experimental: !st[key].has(method) }))
  const fields = (type) => {
    const all = exp.fieldsOf(type)
    const plain = st.fieldsOf(type)
    return all.sort().map((name) => ({ name, experimental: !plain.includes(name) }))
  }
  return {
    clientRequests: list('clientRequests'),
    clientNotifications: list('clientNotifications'),
    serverRequests: list('serverRequests'),
    serverNotifications: list('serverNotifications'),
    fields: Object.fromEntries(WATCHED_TYPES.map((t) => [t, fields(t)])),
  }
}

/** sha256 over a generated folder but meta.json: each file as path, NUL, bytes, NUL, in sorted path order. */
export function contentHash(dir) {
  const h = createHash('sha256')
  for (const rel of listFiles(dir)) {
    if (rel === 'meta.json') continue
    h.update(rel)
      .update('\0')
      .update(readFileSync(join(dir, rel)))
      .update('\0')
  }
  return h.digest('hex')
}

function writeMode(opts) {
  const bin = opts.bin ?? 'codex'
  const folder = opts.folder ?? CODEX_PROTOCOL_FOLDER
  const target = join(resolve(opts.outRoot ?? DEFAULT_OUT_ROOT), folder)
  const { tmp, out, cliVersion } = generate(bin)
  try {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const rel of listFiles(out)) {
      const dest = join(target, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, readFileSync(join(out, rel)))
    }
    const files = listFiles(target)
    const meta = {
      schemaVersion: 1,
      folder,
      cliVersion,
      generatedBy: GENERATED_BY,
      commands: [
        'codex app-server generate-ts --experimental --out <tmp>/ts',
        'codex app-server generate-json-schema --experimental --out <tmp>/schema-experimental',
        'codex app-server generate-json-schema --out <tmp>/schema-stable (methods.json experimental flags only)',
      ],
      codexHome: 'empty temp directory',
      files: files.length + 1,
      sha256: contentHash(target),
    }
    writeFileSync(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ target, cliVersion, files: meta.files }, null, 2)}\n`)
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Committed folder vs freshly generated output: file and method differences, and what they break. */
export function compareGenerated(committedDir, generatedDir) {
  const a = new Set(listFiles(committedDir).filter((f) => f !== 'meta.json'))
  const b = new Set(listFiles(generatedDir).filter((f) => f !== 'meta.json'))
  const added = [...b].filter((f) => !a.has(f))
  const removed = [...a].filter((f) => !b.has(f))
  const changed = [...a].filter(
    (f) => b.has(f) && !readFileSync(join(committedDir, f)).equals(readFileSync(join(generatedDir, f))),
  )
  const bundleOf = (dir) => {
    const p = join(dir, 'schema', SCHEMA_BUNDLE_FILE)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  }
  const oldBundle = bundleOf(committedDir)
  const newBundle = bundleOf(generatedDir)
  const methods = { added: [], removed: [] }
  const missingRequired = []
  const watchedChanged = []
  const newShapeProblems = []
  if (newBundle !== null) {
    const now = methodSetFromSchema(newBundle)
    for (const r of REQUIRED_METHODS) if (!now[r.set].has(r.method)) missingRequired.push(r.method)
    // Only problems the committed schema did not have: those are the drift (a known one was decided on before).
    const known = new Set(oldBundle !== null ? shapeProblems(methodSetFromSchema(oldBundle)) : [])
    for (const p of shapeProblems(now)) if (!known.has(p)) newShapeProblems.push(p)
    if (oldBundle !== null) {
      const before = methodSetFromSchema(oldBundle)
      for (const key of ['clientRequests', 'clientNotifications', 'serverRequests', 'serverNotifications']) {
        for (const m of now[key]) if (!before[key].has(m)) methods.added.push(`${key}: ${m}`)
        for (const m of before[key]) if (!now[key].has(m)) methods.removed.push(`${key}: ${m}`)
      }
      for (const t of WATCHED_TYPES) {
        if (JSON.stringify(before.definition(t) ?? null) !== JSON.stringify(now.definition(t) ?? null))
          watchedChanged.push(t)
      }
    }
  } else {
    missingRequired.push(`(no ${SCHEMA_BUNDLE_FILE} in the generated output)`)
  }
  const different = added.length + removed.length + changed.length > 0
  return {
    different,
    breaking: missingRequired.length > 0 || newShapeProblems.length > 0,
    files: { added, removed, changed },
    methods,
    missingRequired,
    newShapeProblems,
    watchedChanged,
  }
}

export function reportMarkdown(r, { cliVersion, committedVersion, folder }) {
  const lines = [
    `## Codex protocol diff: committed ${folder} (codex-cli ${committedVersion}) vs codex-cli ${cliVersion}`,
    '',
  ]
  if (!r.different) {
    lines.push('No difference.')
    return `${lines.join('\n')}\n`
  }
  lines.push(
    r.breaking ? '**Breaking for Dim Factory.**' : 'Differences found; nothing Dim Factory requires changed.',
  )
  lines.push('')
  if (r.missingRequired.length > 0) lines.push(`- Required methods missing: ${r.missingRequired.join(', ')}`)
  if (r.newShapeProblems.length > 0)
    lines.push(`- Shapes Dim Factory relies on broke: ${r.newShapeProblems.join('; ')}`)
  if (r.watchedChanged.length > 0)
    lines.push(`- Watched types whose definition changed (re-read them): ${r.watchedChanged.join(', ')}`)
  if (r.methods.added.length > 0) lines.push(`- Methods added: ${r.methods.added.join(', ')}`)
  if (r.methods.removed.length > 0) lines.push(`- Methods removed: ${r.methods.removed.join(', ')}`)
  const cap = (list) => (list.length > 40 ? [...list.slice(0, 40), `... and ${list.length - 40} more`] : list)
  for (const [label, list] of [
    ['Files added', r.files.added],
    ['Files removed', r.files.removed],
    ['Files changed', r.files.changed],
  ]) {
    if (list.length > 0) lines.push(`- ${label} (${list.length}): ${cap(list).join(', ')}`)
  }
  lines.push('')
  lines.push(
    'To take the new types: `node scripts/gen-codex-types.mjs --bin <codex>` (a new folder name only when the ' +
      'protocol broke), then re-run the Codex suites.',
  )
  return `${lines.join('\n')}\n`
}

function checkMode(opts) {
  const bin = opts.bin ?? 'codex'
  const folder = opts.folder ?? CODEX_PROTOCOL_FOLDER
  const committed = join(resolve(opts.outRoot ?? DEFAULT_OUT_ROOT), folder)
  if (!existsSync(committed) || !statSync(committed).isDirectory())
    throw new UsageError(`no committed protocol folder at ${committed}`)
  const metaPath = join(committed, 'meta.json')
  const committedVersion = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')).cliVersion : '?'
  const { tmp, out, cliVersion } = generate(bin)
  try {
    const r = compareGenerated(committed, out)
    const text = reportMarkdown(r, { cliVersion, committedVersion, folder })
    process.stdout.write(text)
    if (opts.report) writeFileSync(resolve(opts.report), text)
    if (opts.schemaOut) {
      const dir = resolve(opts.schemaOut)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, SCHEMA_BUNDLE_FILE), readFileSync(join(out, 'schema', SCHEMA_BUNDLE_FILE)))
      writeFileSync(join(dir, 'cli-version.txt'), `${cliVersion}\n`)
    }
    if (r.breaking) return 1
    return opts.strict && r.different ? 1 : 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function usage() {
  return readFileSync(SELF, 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('//'))
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n')
}

const argv1 = process.argv[1] ? resolve(process.argv[1]) : ''
if (process.platform === 'win32' ? argv1.toLowerCase() === SELF.toLowerCase() : argv1 === SELF) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      process.stdout.write(`${usage()}\n`)
      process.exitCode = 0
    } else {
      process.exitCode = opts.check ? checkMode(opts) : writeMode(opts)
    }
  } catch (err) {
    process.stderr.write(`gen-codex-types: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  }
}
