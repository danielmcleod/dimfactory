// Muse redaction for fixture recordings (deterministic, in two layers, as for Codex and Gemini: the shared stable-id
// rules in src/shared/redact.ts, and these recorder-only rules). A `muse exec --json` record carries what only Muse's
// journal says is personal:
//
//   redactMuseValue(record)  protocol rules on one record: the provider's own request and response ids in a model
//                            call's status facets (they name the account's calls at Meta), the plugins and MCP
//                            servers of the user's profile as they appear in task kinds, operations and tool names
//                            (`reminder.agent.plugin:<plugin>:<name>`, `tool.mcp__<server>__<tool>`), and the
//                            producer's provider identity. Pure and idempotent; every value keeps its type.
//                            tests/unit/fixtures-redaction.test.ts checks each committed Muse recording is a fixed
//                            point of it.
//   redactMuseText(text)     the plugin and MCP rules on a plain text line (stderr).
//   profileTerms(museHome)   what the isolated profile's own settings name: MCP servers, plugins, hooks,
//                            skills and their commands, args, URLs and env values (`<museHome>/.config/muse/
//                            settings.json`), and its AGENTS.md lines. Read in memory only; never written; nothing
//                            else of the profile is opened.
//
// Muse has no profile-folder variable (its settings are ~/.config/muse/settings.json), so a recording runs with the
// home itself pointed at an isolated folder (the recorder's --muse-home: HOME, USERPROFILE, XDG_CONFIG_HOME, APPDATA
// and LOCALAPPDATA inside it), never the everyday ~/.config/muse with its MCP servers, plugins, hooks, skills and
// remembered permission profile. It signs in with META_API_KEY from --env-file (an API key always wins over a stored
// sign-in, dev.meta.ai/docs/muse-code/auth); only the key's name reaches the header.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { instructionLines } from './redact-codex.mjs'

export const REDACTED = '<REDACTED>'
/** What the isolated home folder (--muse-home) becomes in a recording. */
export const MUSE_HOME_PLACEHOLDER = '<MUSE_HOME>'
/**
 * The variables that point Muse at the isolated home (--muse-home): set on every OS, so a recording's header (its
 * envKeys) is the same everywhere. `.config` is XDG_CONFIG_HOME; APPDATA and LOCALAPPDATA are where a Windows build
 * would keep its files.
 */
export function museHomeEnv(museHome) {
  return {
    HOME: museHome,
    USERPROFILE: museHome,
    XDG_CONFIG_HOME: join(museHome, '.config'),
    APPDATA: join(museHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(museHome, 'AppData', 'Local'),
  }
}
/** What the prompt file's path becomes in a recording's header argv (Dim Factory writes it under runs/<id>/prompts). */
export const MUSE_PROMPT_FILE = '<PROMPT_FILE>'
/** Inherited variables a Muse recording never takes from the recorder's own env (keys, Muse's own switches). */
export const MUSE_ENV_DROP = Object.freeze(['^META_', '^MUSE_'])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `plugin:<name>:` (a reminder task's plugin) and `mcp__<server>__` (an MCP tool's server), raw text. */
const PLUGIN = /(plugin:)([^:\s"'<>]+)(:)/g
const MCP = /(mcp__)([^_\s"'<>][^\s"'<>]*?)(__)/g

function nameRules(text) {
  let n = 0
  const out = text
    .replace(PLUGIN, (all, head, name, tail) => {
      if (name === REDACTED) return all
      n++
      return `${head}${REDACTED}${tail}`
    })
    .replace(MCP, (all, head, name, tail) => {
      if (name === REDACTED) return all
      n++
      return `${head}${REDACTED}${tail}`
    })
  return { text: out, n }
}

/** The plugin and MCP rules on a plain line (stderr, a non-JSON stdout line). */
export function redactMuseText(text) {
  return nameRules(text).text
}

/** Keys of a model call's producer detail whose values identify the account's calls at the provider. */
const PROVIDER_IDS = new Set(['request_id', 'response_id'])

/**
 * The protocol rules on one parsed record: a redacted copy and the count of each rule that changed it. Every string
 * goes through the name rules; a producer facet's request and response ids become `<REDACTED>`.
 */
export function redactMuseValue(input) {
  const counts = {}
  const tally = (k, n = 1) => {
    if (n > 0) counts[k] = (counts[k] ?? 0) + n
  }
  const walk = (v, key, inProducer) => {
    if (typeof v === 'string') {
      if (inProducer && PROVIDER_IDS.has(key) && v !== REDACTED) {
        tally('muse-provider-id')
        return REDACTED
      }
      const r = nameRules(v)
      tally('muse-profile-name', r.n)
      return r.text
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, inProducer))
    if (isObject(v)) {
      // A status facet `{kind:'producer', detail:{…}}`: its detail names the provider's own ids.
      const producer = inProducer || v.kind === 'producer'
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, producer)]))
    }
    return v
  }
  return { value: walk(input, '', false), counts }
}

// ---- the isolated profile's own settings --------------------------------------------------------------------------

/** A value specific enough to match verbatim anywhere: a path, URL, package or secret, never a plain word. */
const distinctive = (v) =>
  typeof v === 'string' && v.trim().length >= 8 && (/[\\/:@.]/.test(v) || v.trim().length >= 16)

/** Settings sections whose own keys name something of the user's (an MCP server, a plugin, a hook, a skill). */
const NAMED_SECTION = /mcp|plugin|hook|skill|agent|marketplace|provider|extension/i

function readSmall(path) {
  try {
    if (!existsSync(path)) return undefined
    const st = statSync(path)
    return st.isFile() && st.size <= 1024 * 1024 ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * The terms the isolated profile's settings name (`<museHome>/.config/muse/settings.json`, and its AGENTS.md):
 * `literals` (every distinctive string value: commands, args, URLs, env values, paths) are matched verbatim; `names`
 * (the keys of MCP, plugin, hook and skill sections, 4 characters or more) as whole words in free text. `skipped` counts
 * a settings file that is not JSON (it names nothing). Read in memory only.
 */
export function profileTerms(museHome) {
  const literals = new Set()
  const names = new Set()
  let skipped = 0
  const dir = join(museHome, '.config', 'muse')
  const text = readSmall(join(dir, 'settings.json'))
  if (text !== undefined) {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      skipped++
    }
    const walk = (v, named) => {
      if (typeof v === 'string') {
        if (distinctive(v)) literals.add(v.trim())
        return
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x, false)
        return
      }
      if (!isObject(v)) return
      for (const [k, x] of Object.entries(v)) {
        if (named && k.length >= 4) names.add(k)
        walk(x, NAMED_SECTION.test(k) && isObject(x))
      }
    }
    if (value !== undefined) walk(value, false)
  }
  const agents = readSmall(join(dir, 'AGENTS.md'))
  if (agents !== undefined) for (const l of instructionLines(agents)) literals.add(l)
  return {
    literals: [...literals].sort((a, b) => b.length - a.length),
    names: [...names].sort((a, b) => b.length - a.length),
    skipped,
  }
}
