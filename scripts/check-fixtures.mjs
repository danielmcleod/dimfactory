#!/usr/bin/env node
// The synthesized-fixture check: every vendor recording under tests/fixtures is synthesized, and no fixture file
// carries what a recording of a real account would (an email, an organization or account id, a thinking-block
// signature, a vendor's own message or tool id, a paid plan's name, a long base64 run), nor text a live recording
// held. tests/unit/fixtures-synthesized.test.ts runs it on the working tree; the publish tooling runs it on the tree
// it is about to publish and refuses on any finding.
//
//   node scripts/check-fixtures.mjs [--ref <tree-ish>] [--publish]
//
// The live recordings stay in tests/fixtures-private (never published). When that folder exists, the text their
// model wrote is cut into 8-word runs and no fixture may repeat one (runs made only of code tokens, which the
// synthesizer keeps on purpose, are skipped). Without it, that part is skipped and says so.
// A finding prints as `path:line  kind`, never the matched value.
//
// Exit: 0 clean · 1 findings · 2 usage or git error
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeProse, isCodeLike } from './synthesize-fixtures.mjs'
import { treeFiles, workingTreeFiles } from './tree-files.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Where the published fixtures live, and where the live recordings are kept (excluded from publishing). */
export const FIXTURES_PREFIX = 'tests/fixtures/'
export const PRIVATE_PREFIX = 'tests/fixtures-private/'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Email domains that are reserved for examples and tests. */
const EXAMPLE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
/** OpenAI organization and user ids. */
const OPENAI_ACCOUNT_ID_RE = /\b(?:org|user)-[A-Za-z0-9]{20,}\b/
/** The vendors' own ids as their services issue them (Anthropic's start 01; OpenAI's response items are hex). */
const ANTHROPIC_ID_RE = /\b(?:msg|req|toolu|srvtoolu)_01[A-Za-z0-9]{20,}\b/g
const OPENAI_ITEM_ID_RE = /\b(?:msg|rs|call|fc|ws)_[0-9a-f]{32,}\b/g
/** A long base64 run (a signature or an encrypted blob). */
const BASE64_RE = /[A-Za-z0-9+/]{160,}={0,2}/
/** Keys that hold an account's identity, and the values a synthesized fixture may give them. */
const ACCOUNT_KEYS = new Set([
  'organization',
  'orgId',
  'orgName',
  'organizationId',
  'organization_id',
  'organizationUuid',
  'account_uuid',
  'accountUuid',
  'accountId',
  'account_id',
  'userId',
  'user_id',
])
const PLACEHOLDER = /^(?:<[A-Z_]+>|\[REDACTED\]|Example Organization|)$/
/** Plan names a real account reports; a synthesized one says Example Plan, unknown or free. */
const PLAN_KEYS = new Set(['subscriptionType', 'planType', 'plan_type'])
const PLAN_OK = /^(?:Example Plan|example|unknown|free|none|)$/i

/** A synthetic id: marked fake by the synthesizer, or spelled synthetic by a fixture's own generator. */
const syntheticId = (s) => /fa4e|synth|fake|test|0{4}|0a1b2c3d|1a2b3c4d|a1b2c3d4/i.test(s)

/** One finding per kind and line. */
function push(out, seen, path, line, kind) {
  const key = `${path}:${line}:${kind}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ path, line, kind })
}

function visitJson(value, onEntry, key) {
  if (Array.isArray(value)) value.forEach((v) => visitJson(v, onEntry, key))
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) visitJson(v, onEntry, k)
  else onEntry(key, value)
}

/** The JSON values a recording line holds: the frame, and the vendor's JSON line inside it. */
function lineValues(text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  const out = [v]
  if (isObject(v) && typeof v.line === 'string') {
    try {
      out.push(JSON.parse(v.line))
    } catch {
      // a raw (non-JSON) line
    }
  }
  return out
}

/** Whitespace tokens of a text in 8-token runs, each run that holds a prose word. */
export function shingles(text, n = 8) {
  const toks = text.split(/\s+/).filter((t) => t !== '')
  const out = []
  for (let i = 0; i + n <= toks.length; i++) {
    const run = toks.slice(i, i + n)
    if (run.every((t) => isCodeLike(t))) continue
    out.push(run.join(' ').toLowerCase())
  }
  return out
}

/**
 * The runs of a model text that the synthesizer rewrites: a run whose every token it keeps on purpose (code, JSON
 * keys, protocol values such as model ids) is not live text.
 */
function changedShingles(text) {
  const all = (t) => {
    const toks = t.split(/\s+/).filter((x) => x !== '')
    const out = []
    for (let i = 0; i + 8 <= toks.length; i++)
      out.push(
        toks
          .slice(i, i + 8)
          .join(' ')
          .toLowerCase(),
      )
    return out
  }
  const before = all(text)
  const after = all(fakeProse(text))
  if (before.length !== after.length) return shingles(text)
  return before.filter((s, i) => s !== after[i] && !s.split(' ').every((t) => isCodeLike(t)))
}

/** What a live recording's model wrote: assistant text, results, agent messages, plans, tool inputs. */
function modelTexts(frameJson, vendor) {
  const out = []
  const add = (s) => {
    if (typeof s === 'string' && s.length >= 40) out.push(s)
  }
  if (!isObject(frameJson)) return out
  if (vendor === 'claude') {
    const m = frameJson.message
    if (
      frameJson.type === 'assistant' &&
      isObject(m) &&
      m.model !== '<synthetic>' &&
      Array.isArray(m.content)
    )
      for (const c of m.content) {
        if (!isObject(c)) continue
        add(c.text)
        add(c.thinking)
        if (c.input !== undefined) visitJson(c.input, (_k, v) => add(v))
      }
    if (frameJson.type === 'result' && frameJson.is_error !== true) add(frameJson.result)
  } else {
    const item = isObject(frameJson.params) ? frameJson.params.item : frameJson.item
    if (isObject(item) && /^(?:agentMessage|agent_message|plan|reasoning)$/.test(String(item.type)))
      visitJson(item, (k, v) => (k === 'text' || k === 'summary' || k === 'content' ? add(v) : undefined))
  }
  return out
}

/** The 8-word runs of model text in the live recordings under `privateDir` (empty when the folder is absent). */
export function realTextShingles(privateDir = join(ROOT, 'tests', 'fixtures-private')) {
  const set = new Set()
  if (!existsSync(privateDir)) return set
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name === 'recording.jsonl') {
        const lines = readFileSync(p, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
        let vendor = 'claude'
        try {
          vendor = JSON.parse(lines[0]).vendor ?? vendor
        } catch {
          // not a recording
        }
        // Text the host sent or the CLI itself wrote (a denial the model may quote) stays in a fixture on purpose.
        // A string that is part of what the model wrote (a delta, a tool input passed on) is not kept text.
        const frames = lines
          .slice(1)
          .map((l) => lineValues(l))
          .filter(([frame, inner]) => isObject(frame) && inner !== undefined)
        const texts = frames.flatMap(([frame, inner]) =>
          frame.dir === 'out' ? modelTexts(inner, vendor) : [],
        )
        const keptText = new Set()
        for (const [, inner] of frames)
          visitJson(inner, (_k, v) => {
            if (typeof v === 'string' && v.length >= 40 && !texts.some((t) => t.includes(v))) keptText.add(v)
          })
        const keptShingles = new Set([...keptText].flatMap((t) => shingles(t)))
        for (const t of texts) for (const s of changedShingles(t)) if (!keptShingles.has(s)) set.add(s)
      }
    }
  }
  walk(privateDir)
  return set
}

/**
 * The findings for a set of files (`{ path, text }`, repo-relative paths with forward slashes): only the files under
 * tests/fixtures are read. With `publish` (a tree about to be published), any file under tests/fixtures-private
 * is a finding by itself.
 */
export function checkFixtureFiles(files, { realShingles = new Set(), publish = false } = {}) {
  const findings = []
  const seen = new Set()
  let scanned = 0
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/')
    if (path.startsWith(PRIVATE_PREFIX)) {
      if (publish) push(findings, seen, path, 0, 'live recording folder')
      continue
    }
    if (!path.startsWith(FIXTURES_PREFIX) || f.text === undefined) continue
    scanned++
    const isRecording = /(?:^|\/|\.)recording\.jsonl$/.test(path)
    const isJsonl = path.endsWith('.jsonl')
    const lines = f.text.split('\n')
    if (isRecording) {
      let header
      try {
        header = JSON.parse(lines[0])
      } catch {
        header = undefined
      }
      if (!isObject(header) || header.synthesized !== true) push(findings, seen, path, 1, 'not synthesized')
    }
    lines.forEach((text, i) => {
      const line = i + 1
      for (const m of text.matchAll(EMAIL_RE))
        if (!EXAMPLE_DOMAIN.test(m[1])) push(findings, seen, path, line, 'email')
      if (OPENAI_ACCOUNT_ID_RE.test(text)) push(findings, seen, path, line, 'account id')
      for (const m of text.matchAll(ANTHROPIC_ID_RE))
        if (!syntheticId(m[0])) push(findings, seen, path, line, 'vendor id')
      for (const m of text.matchAll(OPENAI_ITEM_ID_RE))
        if (!syntheticId(m[0])) push(findings, seen, path, line, 'vendor id')
      if (isJsonl && BASE64_RE.test(text)) push(findings, seen, path, line, 'base64')
      if (isJsonl)
        for (const v of lineValues(text))
          visitJson(v, (k, val) => {
            if (typeof val !== 'string') return
            if (k === 'signature' && val !== '' && val !== '<REDACTED>')
              push(findings, seen, path, line, 'signature')
            if (k !== undefined && ACCOUNT_KEYS.has(k) && !PLACEHOLDER.test(val))
              push(findings, seen, path, line, 'account id')
            if (k !== undefined && PLAN_KEYS.has(k) && !PLAN_OK.test(val))
              push(findings, seen, path, line, 'plan')
          })
      if (realShingles.size > 0 && text.length > 40)
        for (const s of shingles(lineText(text)))
          if (realShingles.has(s)) push(findings, seen, path, line, 'live text')
    })
  }
  return { findings, scanned, realText: realShingles.size > 0 }
}

/** A JSONL line's string values, decoded and joined (so escaped text compares as written); other lines as they are. */
function lineText(text) {
  const vals = lineValues(text)
  if (vals.length === 0) return text
  const parts = []
  for (const v of vals) visitJson(v, (_k, val) => (typeof val === 'string' ? parts.push(val) : undefined))
  return parts.join('\n')
}

export function run(argv) {
  let ref
  let publish = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') ref = argv[++i]
    else if (argv[i] === '--publish') publish = true
    else {
      console.error(`unknown argument: ${argv[i]}`)
      return 2
    }
  }
  const files = ref === undefined ? workingTreeFiles(ROOT) : treeFiles(ROOT, ref)
  const realShingles = realTextShingles()
  const r = checkFixtureFiles(files, { realShingles, publish })
  for (const f of r.findings) console.log(`${f.path}:${f.line}  ${f.kind}`)
  console.log(
    `Fixture check: ${r.findings.length === 0 ? 'clean' : `${r.findings.length} finding(s)`} (${r.scanned} files` +
      `${r.realText ? `, ${realShingles.size} live text runs compared` : ', no live recordings here to compare text with'})`,
  )
  return r.findings.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = run(process.argv.slice(2))
