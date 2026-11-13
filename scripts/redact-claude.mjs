// Claude profile redaction for fixture recordings (tests/fixtures/claude/README.md "Redaction"). The shared rules
// (src/shared/redact.ts) already take tokens, emails, account and organization keys, the home folder, the user name
// in paths and the host name, and the recorder's literals take the account and organization ids and names. A
// recording made against the user's everyday ~/.claude also carries what the profile itself adds to the CLI's frames:
// the user's own skills, slash commands, subagents and output styles, the skills claude.ai syncs to the account,
// installed plugins, MCP servers and hooks. Two layers, as for Codex:
//
//   redactClaudeValue(msg, ctx?)  protocol rules on one parsed CLI frame (stdout JSON): in the initialize reply and a
//                                 commands_changed push, every command the CLI does not mark `builtin` and every
//                                 subagent or output style that is not one of the CLI's own; in an `mcp_status` reply
//                                 each server's name, definition (a claude.ai connector's address and id), server
//                                 info, error and tools (its status, scope, source and config type stay); in system/init the
//                                 namespaced skills and commands (`plugin:skill`), the subagents that are not built in,
//                                 plugins not loaded from `builtin`, MCP server names and MCP tools; hook frames' names
//                                 and output; an MCP tool's name and input anywhere; a subagent type that is not built in;
//                                 a plan-limit event's reset times and billing flags (as Codex's quota rule); in a
//                                 context-usage breakdown (the get_context_usage reply, a /context result) the names of
//                                 skills that are not built in, MCP server names and memory file paths outside the
//                                 sandbox; a thinking block's signature (it carries the organization id).
//                                 `ctx.names` (the profile's names, lower case) also takes a plain skill or command name
//                                 in init's lists. Pure and idempotent, and every value keeps its type.
//                                 tests/unit/fixtures-redaction.test.ts checks each committed Claude recording is a
//                                 fixed point of it (without ctx).
//   profileTerms(configDir)       what the profile's own files name: the user's skills, commands, subagents and
//                                 output styles, the enabled and installed plugins, the folder claude.ai syncs skills
//                                 and plugins into (named by the account's ids; each id on its own too), the hook
//                                 and status-line commands, the settings' env values and the user's CLAUDE.md lines.
//                                 Read in memory only, never written; the recorder reports counts, never values.
//                                 Credential and account files are never opened (NEVER_READ).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { instructionLines } from './redact-codex.mjs'

export const REDACTED = '<REDACTED>'
/** A plan window's reset time in a recording (a number, so the frame stays valid; 0 reads as a stand-in). */
export const QUOTA_RESETS_AT = 0
/** What an MCP tool's id (`mcp__<server>__<tool>`) becomes. */
export const MCP_TOOL_REDACTED = `mcp__${REDACTED}`

/**
 * The CLI's own subagents (2.1.289; `claude` is FleetView's catch-all). Any other name in a listing came from the user's
 * profile or a plugin; a built-in agent a later CLI adds is redacted too, which only costs fidelity.
 */
export const BUILTIN_AGENTS = Object.freeze([
  'claude',
  'Explore',
  'general-purpose',
  'Plan',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
])
/** The CLI's own output styles (2.1.289); the user's come from <config>/output-styles. */
export const BUILTIN_OUTPUT_STYLES = Object.freeze([
  'default',
  'Proactive',
  'Concise',
  'Explanatory',
  'Learning',
])

/** Files in the Claude config folder that are never opened: the login and the account record. */
export const NEVER_READ = Object.freeze(['.credentials.json', '.claude.json', 'credentials.json'])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const builtinAgent = (name) => BUILTIN_AGENTS.includes(name)
/** A plugin's or a synced skill's namespaced name (`anthropic-skills:docx`, `my-plugin:review`). */
const namespaced = (name) => /^[^:\s]+:[^:\s]/.test(name)
const MCP_TOOL = /^mcp__.+/
/** Keys that name a subagent type (the Agent tool's input, task frames). */
const AGENT_TYPE_KEY = /^(subagent_?type|agent_?type)$/i

/**
 * The protocol rules on one parsed CLI frame. Returns a redacted copy and the count of each rule that changed something
 * (claude-command, claude-agent, claude-skill, claude-plugin, claude-mcp, claude-hook, claude-output-style,
 * claude-quota, claude-memory, claude-signature).
 * `ctx.names`: the profile's own names (lower case), which also take a plain skill or command name in init's lists.
 */
export function redactClaudeValue(input, ctx = {}) {
  const counts = {}
  if (!isObject(input)) return { value: input, counts }
  const names = ctx.names instanceof Set ? ctx.names : new Set()
  const value = structuredClone(input)
  const bump = (id) => {
    counts[id] = (counts[id] ?? 0) + 1
  }
  const put = (holder, key, next, id) => {
    if (!Object.hasOwn(holder, key)) return
    if (JSON.stringify(holder[key]) === JSON.stringify(next)) return
    holder[key] = next
    bump(id)
  }
  /** Every string under `v` becomes the placeholder; structure, numbers and booleans stay. */
  const scrub = (v) => {
    if (typeof v === 'string') return REDACTED
    if (Array.isArray(v)) return v.map(scrub)
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
    return v
  }
  /** A list of command records (initialize, commands_changed): what the CLI does not mark built in is scrubbed. */
  const commandList = (holder, key) => {
    if (!Array.isArray(holder[key])) return
    put(
      holder,
      key,
      holder[key].map((c) => (isObject(c) && c.builtin !== true ? scrub(c) : c)),
      'claude-command',
    )
  }
  /** A list of agent records ({name, description, model?}): the user's and plugins' are scrubbed. */
  const agentRecords = (holder, key) => {
    if (!Array.isArray(holder[key])) return
    put(
      holder,
      key,
      holder[key].map((a) => (isObject(a) && !builtinAgent(a.name) ? scrub(a) : a)),
      'claude-agent',
    )
  }
  /** A list of names: entries `drop` picks become the placeholder. */
  const nameList = (holder, key, drop, id) => {
    if (!Array.isArray(holder[key])) return
    put(
      holder,
      key,
      holder[key].map((n) => (typeof n === 'string' && n !== REDACTED && drop(n) ? REDACTED : n)),
      id,
    )
  }
  const userSkill = (n) => namespaced(n) || names.has(n.toLowerCase())
  const userStyle = (s) => !BUILTIN_OUTPUT_STYLES.includes(s)
  /**
   * A context-usage breakdown (the `get_context_usage` reply, camelCase; the /context result's `context_usage`,
   * snake_case): which skill, MCP server and memory file costs how many tokens. The names of skills that are not the
   * CLI's own (`source` other than `built-in`) and of MCP servers, and a memory file's path outside the sandbox, are the
   * user's; the token counts, sources and types stay.
   */
  const contextUsage = (holder) => {
    if (!isObject(holder)) return
    const skillRecords = (list) => {
      if (!Array.isArray(list)) return list
      return list.map((s) => {
        if (!isObject(s) || s.source === 'built-in') return s
        const out = { ...s }
        for (const k of ['name', 'plugin_name', 'pluginName']) if (typeof s[k] === 'string') out[k] = REDACTED
        return out
      })
    }
    if (isObject(holder.skills) && Array.isArray(holder.skills.skillFrontmatter))
      put(holder.skills, 'skillFrontmatter', skillRecords(holder.skills.skillFrontmatter), 'claude-skill')
    if (Array.isArray(holder.skills)) put(holder, 'skills', skillRecords(holder.skills), 'claude-skill')
    for (const [key, field] of [
      ['mcpTools', 'serverName'],
      ['mcp_tools', 'server_name'],
    ]) {
      if (!Array.isArray(holder[key])) continue
      put(
        holder,
        key,
        holder[key].map((t) =>
          isObject(t) && typeof t[field] === 'string' ? { ...t, [field]: REDACTED } : t,
        ),
        'claude-mcp',
      )
    }
    for (const key of ['memoryFiles', 'memory_files']) {
      if (!Array.isArray(holder[key])) continue
      put(
        holder,
        key,
        holder[key].map((m) =>
          isObject(m) && typeof m.path === 'string' && !m.path.startsWith('<CWD>')
            ? { ...m, path: REDACTED }
            : m,
        ),
        'claude-memory',
      )
    }
  }

  // ---- by frame ----
  const response = isObject(value.response) ? value.response.response : undefined
  if (value.type === 'control_response' && isObject(response)) {
    // An `mcp_status` reply: what each server is called and where it lives is the user's; how it stands is not.
    if (Array.isArray(response.mcpServers))
      put(
        response,
        'mcpServers',
        response.mcpServers.map((s) => {
          if (!isObject(s)) return s
          const out = { ...s }
          if (typeof s.name === 'string') out.name = REDACTED
          if (isObject(s.config))
            out.config = {
              ...scrub(s.config),
              ...(typeof s.config.type === 'string' ? { type: s.config.type } : {}),
            }
          for (const k of ['serverInfo', 'error', 'tools']) if (s[k] !== undefined) out[k] = scrub(s[k])
          return out
        }),
        'claude-mcp',
      )
    contextUsage(response)
    commandList(response, 'commands')
    agentRecords(response, 'agents')
    nameList(response, 'available_output_styles', userStyle, 'claude-output-style')
    if (typeof response.output_style === 'string' && userStyle(response.output_style))
      put(response, 'output_style', REDACTED, 'claude-output-style')
  }
  if (isObject(value.context_usage)) contextUsage(value.context_usage)
  if (value.type === 'system') {
    const sub = value.subtype
    if (sub === 'init') {
      nameList(value, 'slash_commands', userSkill, 'claude-skill')
      nameList(value, 'terminal_slash_commands', userSkill, 'claude-skill')
      nameList(value, 'skills', userSkill, 'claude-skill')
      nameList(value, 'agents', (n) => !builtinAgent(n), 'claude-agent')
      if (Array.isArray(value.plugins))
        put(
          value,
          'plugins',
          value.plugins.map((p) => (isObject(p) && p.path !== 'builtin' ? scrub(p) : p)),
          'claude-plugin',
        )
      if (Array.isArray(value.mcp_servers))
        put(
          value,
          'mcp_servers',
          value.mcp_servers.map((s) =>
            isObject(s) ? { ...s, ...(typeof s.name === 'string' ? { name: REDACTED } : {}) } : s,
          ),
          'claude-mcp',
        )
      if (typeof value.output_style === 'string' && userStyle(value.output_style))
        put(value, 'output_style', REDACTED, 'claude-output-style')
    } else if (sub === 'commands_changed') commandList(value, 'commands')
    else if (typeof sub === 'string' && sub.startsWith('hook_')) {
      for (const k of ['hook_name', 'output', 'stdout', 'stderr'])
        if (typeof value[k] === 'string' && value[k] !== '') put(value, k, REDACTED, 'claude-hook')
    }
  }

  // A plan-limit event: when the account's windows reset dates its usage (as Codex's quota rule), and the
  // billing flags say whether it can buy credits or has a saved card. Resets become 0 and the flags false (numbers
  // and booleans, so the frame stays valid); the status, window type and utilization stay.
  if (value.type === 'rate_limit_event' && isObject(value.rate_limit_info)) {
    const info = value.rate_limit_info
    for (const k of ['resetsAt', 'overageResetsAt'])
      if (typeof info[k] === 'number') put(info, k, QUOTA_RESETS_AT, 'claude-quota')
    if (isObject(info.unifiedWindows))
      for (const w of Object.values(info.unifiedWindows))
        if (isObject(w) && typeof w.resetsAt === 'number') put(w, 'resetsAt', QUOTA_RESETS_AT, 'claude-quota')
    for (const k of ['hasChargeableSavedPaymentMethod', 'canUserPurchaseCredits'])
      if (typeof info[k] === 'boolean') put(info, k, false, 'claude-quota')
  }

  // ---- by shape and key, anywhere in the frame ----
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string' && MCP_TOOL.test(v[i]) && v[i] !== MCP_TOOL_REDACTED) {
          v[i] = MCP_TOOL_REDACTED
          bump('claude-mcp')
        } else walk(v[i])
      }
      return
    }
    if (!isObject(v)) return
    // A thinking block's signature (and its streamed `signature_delta`) is an opaque token that carries the
    // organization id inside it (base64): never kept. An empty signature stays empty.
    if (
      (v.type === 'thinking' || v.type === 'signature_delta') &&
      typeof v.signature === 'string' &&
      v.signature !== '' &&
      v.signature !== REDACTED
    )
      put(v, 'signature', REDACTED, 'claude-signature')
    // An MCP tool call: its server and tool name, and what it was sent.
    if (v.type === 'tool_use' && typeof v.name === 'string' && MCP_TOOL.test(v.name)) {
      put(v, 'name', MCP_TOOL_REDACTED, 'claude-mcp')
      if (v.input !== undefined) put(v, 'input', scrub(v.input), 'claude-mcp')
    }
    // The Skill tool naming a plugin's or the user's own skill.
    if (v.type === 'tool_use' && v.name === 'Skill' && isObject(v.input) && typeof v.input.skill === 'string')
      if (v.input.skill !== REDACTED && userSkill(v.input.skill))
        put(v.input, 'skill', REDACTED, 'claude-skill')
    // A subagent type tally (result.subagent_stats.by_type): a key per type.
    if (isObject(v.by_type) && Object.keys(v.by_type).some((k) => !builtinAgent(k) && k !== REDACTED)) {
      const tally = {}
      for (const [k, n] of Object.entries(v.by_type)) {
        const key = builtinAgent(k) ? k : REDACTED
        tally[key] = typeof n === 'number' && typeof tally[key] === 'number' ? tally[key] + n : n
      }
      put(v, 'by_type', tally, 'claude-agent')
    }
    for (const [k, child] of Object.entries(v)) {
      if (typeof child === 'string') {
        if (AGENT_TYPE_KEY.test(k) && !builtinAgent(child) && child !== REDACTED)
          put(v, k, REDACTED, 'claude-agent')
        else if (MCP_TOOL.test(child) && child !== MCP_TOOL_REDACTED)
          put(v, k, MCP_TOOL_REDACTED, 'claude-mcp')
      } else walk(child)
    }
  }
  walk(value)
  return { value, counts }
}

// ---- the profile's own files ------------------------------------------------------------------------------------

/** One profile file as text; throws for a credential or account file; undefined when absent or unreadable. */
export function readProfileText(path) {
  if (NEVER_READ.includes(basename(path))) throw new Error(`refusing to read ${basename(path)} (credentials)`)
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function readJson(path) {
  const text = readProfileText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function dirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function files(path, ext) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext))
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** The `name:` of a markdown file's front matter, if any. */
function frontMatterName(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? '')
  const line = m?.[1]?.split(/\r?\n/).find((l) => /^name\s*:/i.test(l))
  const name = line
    ?.replace(/^name\s*:\s*/i, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
  return name !== undefined && name !== '' ? name : undefined
}

/** A value specific enough to match verbatim anywhere: a path, URL, package or secret, never a plain word. */
const distinctive = (v) =>
  typeof v === 'string' && v.trim().length >= 8 && (/[\\/:@.]/.test(v) || v.trim().length >= 16)

/** A name worth matching as a whole word in free text: long and hyphenated or namespaced, never a common word. */
export const proseName = (n) => n.length >= 8 && /[-_:]/.test(n)

/** One of the account's ids (a UUID); a synced folder's name joins two of them with `_`. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A synced folder (skills/synced, plugins/synced) as literals: its whole name and each account id in it on
 * its own, since a frame or a file can name the organization or the account alone (`organization_uuid`,
 * `account_uuid`), which the whole name would never match.
 */
function syncedLiterals(bucket) {
  if (!distinctive(bucket)) return []
  return [bucket, ...bucket.split('_').filter((part) => ACCOUNT_ID.test(part))]
}

/**
 * The terms a Claude profile names: `names` (skills, commands, subagents, output styles, plugins and marketplaces),
 * matched exactly in the CLI's own listings and, when {@link proseName}, as whole words in free text; `literals`
 * (hook and status-line commands, the settings' env values, the synced buckets' names and each account id in them,
 * CLAUDE.md lines), matched verbatim. `skipped` counts files that would not parse.
 */
export function profileTerms(configDir) {
  const names = new Set()
  const literals = new Set()
  let skipped = 0
  const addName = (n) => {
    if (typeof n !== 'string') return
    const t = n.trim()
    if (t.length >= 3 && t !== REDACTED) names.add(t)
  }
  const md = (path) => frontMatterName(readProfileText(path))

  // Skills: <config>/skills/<dir>/SKILL.md. The skills claude.ai syncs (skills/synced/<bucket>/<dir>) are not taken by
  // name: the CLI lists them namespaced (`anthropic-skills:docx`) or as commands it does not mark built in, which the
  // protocol rules take, and their plain names (docs, pdf, run…) are common words or the CLI's own (deep-research).
  // Only the bucket, named by the account's ids, is a literal, and each of those ids on its own.
  const skillsDir = join(configDir, 'skills')
  for (const d of dirs(skillsDir)) {
    if (d === 'synced') continue
    addName(d)
    addName(md(join(skillsDir, d, 'SKILL.md')))
  }
  for (const bucket of dirs(join(skillsDir, 'synced')))
    for (const l of syncedLiterals(bucket)) literals.add(l)
  // Subagents and output styles: one markdown file each.
  for (const [sub, keep] of [
    ['agents', (n) => !BUILTIN_AGENTS.includes(n)],
    ['output-styles', (n) => !BUILTIN_OUTPUT_STYLES.includes(n)],
  ]) {
    for (const f of files(join(configDir, sub), '.md')) {
      const name = md(join(configDir, sub, f)) ?? f.slice(0, -3)
      if (keep(name)) addName(name)
      if (keep(f.slice(0, -3))) addName(f.slice(0, -3))
    }
  }
  // Slash commands: <config>/commands/**/*.md, a nested one as `dir:name`.
  const walkCommands = (dir, prefix) => {
    for (const f of files(dir, '.md')) addName(`${prefix}${f.slice(0, -3)}`)
    for (const d of dirs(dir)) walkCommands(join(dir, d), `${prefix}${d}:`)
  }
  walkCommands(join(configDir, 'commands'), '')
  // Plugins: installed (installed_plugins.json) and enabled (settings), `name@marketplace` and each half.
  const plugin = (id) => {
    if (typeof id !== 'string') return
    addName(id)
    for (const part of id.split('@')) addName(part)
  }
  const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'))
  if (installed === undefined && existsSync(join(configDir, 'plugins', 'installed_plugins.json'))) skipped++
  if (isObject(installed?.plugins)) for (const id of Object.keys(installed.plugins)) plugin(id)
  for (const bucket of dirs(join(configDir, 'plugins', 'synced')))
    for (const l of syncedLiterals(bucket)) literals.add(l)
  // Settings: enabled plugins, hook and status-line commands, the env's values, an API key helper.
  for (const file of ['settings.json', 'settings.local.json']) {
    const path = join(configDir, file)
    const s = readJson(path)
    if (s === undefined) {
      if (existsSync(path)) skipped++
      continue
    }
    if (isObject(s.enabledPlugins)) for (const id of Object.keys(s.enabledPlugins)) plugin(id)
    const commandsIn = (v) => {
      if (Array.isArray(v)) v.forEach(commandsIn)
      else if (isObject(v))
        for (const [k, x] of Object.entries(v)) {
          if ((k === 'command' || k === 'url') && distinctive(x)) literals.add(x.trim())
          else commandsIn(x)
        }
    }
    commandsIn(s.hooks)
    commandsIn(s.statusLine)
    if (distinctive(s.apiKeyHelper)) literals.add(s.apiKeyHelper.trim())
    if (isObject(s.env)) for (const x of Object.values(s.env)) if (distinctive(x)) literals.add(x.trim())
  }
  // The user's own instructions.
  const memory = readProfileText(join(configDir, 'CLAUDE.md'))
  if (memory !== undefined) for (const l of instructionLines(memory)) literals.add(l)
  return {
    literals: [...literals].sort((a, b) => b.length - a.length),
    names: [...names].sort((a, b) => b.length - a.length),
    skipped,
  }
}

/** The built-in command names of an initialize reply or a commands_changed push (lower case), or [] for another frame. */
export function builtinCommandNames(msg) {
  const list = isObject(msg?.response) ? msg.response.response?.commands : msg?.commands
  if (!Array.isArray(list)) return []
  return list
    .filter((c) => isObject(c) && c.builtin === true && typeof c.name === 'string')
    .map((c) => c.name.toLowerCase())
}
