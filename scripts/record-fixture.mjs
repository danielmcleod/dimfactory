#!/usr/bin/env node
// Raw fixture recorder: spawns a vendor CLI (no shell), feeds scripted stdin frames, answers requests with
// rule-based responders, and writes a redacted <out>/recording.jsonl (header, {t,dir,line} frames, exit).
//
//   node scripts/record-fixture.mjs --bin <exe> [--arg <a>]... --cwd <dir> --out <fixtureDir>
//     --vendor <v> --route <r> --id <ID> --slug <slug> [--cli-version <x>]
//     [--stdin <frames.jsonl>] [--responders <rules.json>] [--timing on|off] [--keep-stdin]
//     [--env-file <f>] [--env KEY=VALUE]... [--env-drop <regex>]... [--redact-literal <text>]...
//     [--timeout <ms>] [-- <more args>]
//   Codex: [--codex-app-server] --codex-home <dir> [--allow-user-codex-home] [--output-file <flag>]
//     [--pass-file <json>] [--var NAME=VALUE]...
//   ACP (Gemini): --acp --vendor gemini --gemini-home <dir> [--allow-user-gemini-home] [--entry <file.js>]
//     [--pass-file <json>] [--var NAME=VALUE]...
//   ACP (Grok): --acp --vendor grok --grok-home <dir> [--allow-user-grok-home] [--pass-file <json>]
//     [--var NAME=VALUE]...
//   Muse: --muse --muse-home <dir> [--allow-user-muse-home] [--pass-file <json>]
//
// --stdin   one frame per line, written verbatim with LF. Directive lines pace the script:
//             {"$wait": <partial match on a stdout JSON frame>, "$timeoutMs": 30000}
//             {"$sleep": <ms>}    {"$close": true}    {"$kill": true}  (hard-kills the process tree:
//             taskkill /T /F on win32, SIGKILL elsewhere; the exit frame gets "killed":"tree")
//           stdin is closed after the last frame unless --keep-stdin.
// --responders  [{"when": <partial match, "$var" captures>, "reply": <frame, "$var" substituted>, "once": true}]
//           One rule set answers Claude control_requests, JSON-RPC server requests and ACP permissions.
//           A .mjs/.js path instead loads a module whose default export (frame) => reply | reply[] | undefined
//           is called for every stdout JSON frame (for replies a partial match cannot express).
// The inherited env is cleaned like a Dim Factory child's (sanitizeEnv; inside a Claude Code session also every
//           host-session variable), so NO_COLOR=1 and TERM=dumb are set as for a real pass.
// --env-drop  case-insensitive regex; matching inherited variables are removed before --env-file/--env apply.
//           The patterns (never the dropped names or values) go into the header as envDrop.
// --redact-literal  extra literal (e.g. an account or org id) replaced by <REDACTED> in every recorded line.
// --timing off  every t is 0 and recordedAt is omitted, so identical runs give byte-identical files
//           (frame order is deterministic when output and input are causally ordered via $wait/responders).
// .cmd shims cannot be spawned without a shell: pass the native exe, or --bin node --arg <entry.js>.
//
// Codex (tests/fixtures/codex/README.md, including the Windows sandbox procedure):
// --codex-home <dir>  CODEX_HOME for the recorded CLI (required for --vendor codex). The everyday ~/.codex is refused
//           unless --allow-user-codex-home: record against an isolated profile (~/.codex-fixtures). The path is
//           replaced by <CODEX_HOME> in every recorded line; OPENAI_* and CODEX_* (other than CODEX_HOME) are not
//           inherited.
//           Every line the CLI writes (out, err, the -o file) also goes through scripts/redact-codex.mjs: the
//           protocol rules (the machine in the userAgent, the plan and credits, the remote-control identity, MCP
//           servers, apps, hooks, config warnings, custom instructions) and the terms the profile's own files name
//           (config.toml MCP servers and trusted folders, instructions, AGENTS.md; read in memory, never written),
//           plus the git user.name the sandbox's commits carry. The summary's "profile" gives counts, never values.
// Every line the CLI writes (any vendor) also loses the machine's temp folder and the path under it (<TMP>, after the
//           sandbox rule): a scratch folder names the session that made it, and a shell that cuts or wraps a long
//           sandbox path in its tables leaves a part no other rule sees whole (src/shared/redact.ts redactTempFolder).
// --codex-app-server  JSON-RPC mode: vendor codex, route app-server, argv `app-server --listen stdio://` unless
//           given; the header says "protocol":"jsonrpc"; a server request no responder answers gets -32601 (as a
//           real host does); streamed item deltas (agentMessage, plan, reasoning, command output) are rebalanced
//           like Claude's text deltas so a split path or literal is still redacted.
//           Server requests are answered by --responders only (a stdin frame cannot answer one: the -32601 would
//           already be on its way); a rule with "reply": null leaves its request pending without the -32601.
//           Directive {"$wait": <match>, "$capture": {"threadId": "result.thread.id"}} binds vars from the matched
//           frame; later stdin frames and responder replies have "$threadId" (whole value) or ${threadId} (inside a
//           string) filled in. --var NAME=VALUE pre-binds one (a thread another recording created, for a resume).
//           (Captures work in every mode; a recipe without them is sent byte for byte as before.)
// With --vendor codex the recording also gets {"dir":"eof"} where the recorder closed stdin (the replay waits for the
//           host's close there), {"dir":"hold"} before the exit when a $kill stopped it (the replay idles until its
//           host kills it), and --output-file <flag> (exec: -o) adds {"dir":"file","argvPath":<flag>,"content"} with
//           what the CLI left in that file, before the exit frame.
// --pass-file <json>  merged into the header as "pass": how Dim Factory ran the pass (step, mode, answers, stop), for
//           the Codex replay suites (tests/fixtures/codex/README.md "Header").
//
// ACP (Gemini and Grok over the shared ACP base; tests/fixtures/gemini/README.md):
// --acp     JSON-RPC 2.0 mode for an ACP agent (Gemini `--acp`): route acp unless given; the header says
//           "protocol":"jsonrpc" and "jsonrpc":"2.0"; an agent request no responder answers gets -32601 with the
//           header; streamed agent_message_chunk / agent_thought_chunk text is rebalanced like the other deltas; eof
//           and hold frames as for Codex. $wait/$capture/--var/--pass-file work as above ($cwd is bound to --cwd).
// --entry <file.js>  the agent's JS entry, spawned as `--bin <system node> <entry> <args>` (an npm shim is never run
//           through a shell): the header's argv is `<vendor> <args>` with "launch":"node <entry>".
// --gemini-home <dir>  GEMINI_CLI_HOME for the recorded Gemini CLI (required for --vendor gemini): the folder that
//           holds `.gemini`. The everyday home (whose .gemini is ~/.gemini) is refused unless --allow-user-gemini-home.
//           The path becomes <GEMINI_CLI_HOME> in every recorded line (the everyday home, when allowed, is left to the
//           home rule: `~/.gemini/…`); GEMINI_* and GOOGLE_* are not inherited (pass a
//           key with --env-file; only its name reaches the header). Every line the CLI writes also goes through
//           scripts/redact-gemini.mjs: the project folder under .gemini/tmp, MCP names in tool titles and options, the
//           quota's tier and resets, and the terms the profile's own files name (settings.json MCP servers, GEMINI.md,
//           custom commands, extensions, the install's ids; read in memory, never written). Credential files
//           (oauth_creds.json, google_accounts.json, …) are never opened.
//           A `[MODE_UPDATE] <mode>` chunk (Gemini's mode echo) is recorded as sent, never rebalanced into
//           its neighbours; when Gemini asks to leave plan mode (its exit_plan_mode request names the plan file), the
//           plan file is recorded as a {"dir":"file","path":…,"content":…} frame before the request, so the replay
//           has it where the adapter reads it. Only a .md file of 1 MB or less under <GEMINI_CLI_HOME>/.gemini/tmp is
//           read, never anything else of the profile.
// --grok-home <dir>  GROK_HOME for the recorded Grok CLI (required for --vendor grok): the folder Grok keeps its
//           profile in (its everyday one is ~/.grok, which is refused unless --allow-user-grok-home). The path becomes
//           <GROK_HOME> in every recorded line (the everyday one, when allowed, is left to the home rule: `~/.grok/…`);
//           GROK_* and XAI_* are not inherited (pass a key with --env-file; only its name reaches the header), and
//           GROK_DISABLE_AUTOUPDATER=1 is set as Dim Factory's launch sets it. Every line the CLI writes also goes through
//           scripts/redact-grok.mjs: the session group folder under sessions/, an SSO issuer or auth provider label in
//           authMethods, team and principal ids, and the terms the profile's own files name (config.toml MCP servers,
//           its OIDC and auth provider settings, AGENTS.md; read in memory, never written). Credential files (auth.json,
//           mcp_credentials.json, …) are never opened. Grok is a native binary: --bin <grok> -- agent --no-leader stdio.
//
// Muse (tests/fixtures/muse/README.md):
// --muse    `muse exec --json` lines: vendor muse, route exec; the argv after -- must hold --prompt-file <file> (the
//           recipe's prompt.md), recorded first as a {"dir":"promptFile","argvPath":"--prompt-file","content"} frame and
//           named <PROMPT_FILE> in the header's argv; eof and hold frames as for Codex. META_* and MUSE_* are not
//           inherited: sign in with META_API_KEY from --env-file (only its name reaches the header). Every line the CLI
//           writes also goes through scripts/redact-muse.mjs (the provider's request and response ids, plugin and MCP
//           server names).
// --muse-home <dir>  (required for --muse) the folder that stands in for the home of the recorded Muse:
//           Muse has no profile-folder variable, so HOME, USERPROFILE, XDG_CONFIG_HOME (<dir>/.config), APPDATA and
//           LOCALAPPDATA (under <dir>/AppData) point at it, and Muse loads that isolated profile's ~/.config/muse (its
//           MCP servers, plugins, hooks, skills and remembered permission profile), never the everyday one, which is
//           refused unless --allow-user-muse-home. The path becomes <MUSE_HOME> in every recorded line, and what the
//           profile's settings.json and AGENTS.md name is redacted too (read in memory, never written). Nothing else of
//           the profile is opened.
//
// Claude (tests/fixtures/claude/README.md "Redaction"):
// --claude-config <dir>  the Claude config folder whose profile is scrubbed from every line the CLI writes (--vendor
//           claude only; default: CLAUDE_CONFIG_DIR given with --env, else ~/.claude). scripts/redact-claude.mjs: the
//           protocol rules (the commands the CLI does not mark built in, the user's and plugins' subagents, skills and
//           output styles, plugins, MCP servers and tools, hook frames, plan-limit resets and billing flags) and the
//           names and literals the folder's own
//           files give (skills, commands, agents, output styles, plugins, hook and status-line commands, settings env
//           values, CLAUDE.md; read in memory, never written; .credentials.json and .claude.json are never opened),
//           plus the git user.name. The names of the commands and agents the CLI's own initialize reply does not mark
//           built in are learned from the stream as well; a name it marks built in is never taken.
//
// Exit: 0 recorded · 2 usage or spawn error · 3 timed out ($wait or --timeout; the recording is still written)
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isHostSessionLeftover } from '../src/core/adapters/claude/launch.ts'
import { GEMINI_MODE_UPDATE, GEMINI_PLAN_EXIT_TITLE } from '../src/core/adapters/gemini/wire.ts'
import { getEnv, sanitizeEnv } from '../src/core/proc/env.ts'
import { redactLine, redactTempFolder, redactText } from '../src/shared/redact.ts'
import {
  getPath,
  matchPartial,
  substituteText,
  substituteValue,
  tryParseJson,
} from '../tests/fake-cli/fake-cli.mjs'
import {
  BUILTIN_AGENTS,
  builtinCommandNames,
  profileTerms as claudeProfileTerms,
  proseName,
  redactClaudeValue,
} from './redact-claude.mjs'
import { REDACTED, profileTerms, redactCodexValue, redactTerms, wordMatchers } from './redact-codex.mjs'
import {
  GEMINI_HOME_PLACEHOLDER,
  profileTerms as geminiProfileTerms,
  redactGeminiText,
  redactGeminiValue,
} from './redact-gemini.mjs'
import {
  GROK_HOME_PLACEHOLDER,
  profileTerms as grokProfileTerms,
  redactGrokText,
  redactGrokValue,
} from './redact-grok.mjs'
import {
  MUSE_ENV_DROP,
  MUSE_HOME_PLACEHOLDER,
  MUSE_PROMPT_FILE,
  museHomeEnv,
  profileTerms as museProfileTerms,
  redactMuseText,
  redactMuseValue,
} from './redact-muse.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** ACP session/update kinds whose `content.text` streams (rebalanced like the other deltas). */
const ACP_CHUNK_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])

/** Codex app-server notifications whose `params.delta` streams text (rebalanced like Claude's deltas). */
const CODEX_DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
])

const VALUE_OPTIONS = new Set([
  '--bin',
  '--arg',
  '--cwd',
  '--out',
  '--vendor',
  '--route',
  '--id',
  '--slug',
  '--cli-version',
  '--stdin',
  '--responders',
  '--timing',
  '--env-file',
  '--env',
  '--timeout',
  '--env-drop',
  '--redact-literal',
  '--codex-home',
  '--output-file',
  '--pass-file',
  '--var',
  '--gemini-home',
  '--entry',
  '--grok-home',
  '--muse-home',
  '--claude-config',
])
const MULTI = new Set(['--arg', '--env', '--env-drop', '--redact-literal', '--var'])
const FLAGS = new Set([
  '--keep-stdin',
  '--help',
  '--codex-app-server',
  '--allow-user-codex-home',
  '--acp',
  '--allow-user-gemini-home',
  '--allow-user-grok-home',
  '--muse',
  '--allow-user-muse-home',
])

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { '--arg': [], '--env': [], '--env-drop': [], '--redact-literal': [], '--var': [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      opts['--arg'].push(...argv.slice(i + 1))
      break
    }
    const eq = token.indexOf('=')
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token
    if (FLAGS.has(name)) {
      opts[name] = true
      continue
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option ${token}`)
    let value
    if (name !== token) value = token.slice(eq + 1)
    else {
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`)
      value = argv[++i] // taken verbatim, so --arg --version works
    }
    if (MULTI.has(name)) opts[name].push(value)
    else opts[name] = value
  }
  return opts
}

function usage() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('//'))
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n')
}

/**
 * The inherited env, cleaned like a Dim Factory child's (sanitizeEnv in src/core/proc/env.ts): NODE_OPTIONS,
 * CLAUDECODE, ELECTRON_*, npm_*, GIT_* … are always removed, and when the recorder runs inside a Claude Code session
 * every host-session variable (CLAUDE_CODE_*, CLAUDE_EFFORT, the default ANTHROPIC_BASE_URL, …) goes too, so the
 * recorded CLI is never a nested host session. --env-drop removes more on top.
 */
function recorderEnv(base) {
  const launchedFromClaude = getEnv(base, 'CLAUDECODE') === '1'
  const kept = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (launchedFromClaude && isHostSessionLeftover(k, v)) continue
    kept[k] = v
  }
  return sanitizeEnv(kept, { purpose: 'vendor', launchedFromClaude })
}

function parseEnvFile(path) {
  const env = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) throw new UsageError(`${path}: expected KEY=VALUE, got "${line}"`)
    let value = line.slice(eq + 1).trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    env[line.slice(0, eq).trim()] = value
  }
  return env
}

function parseFrames(path) {
  const frames = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const parsed = tryParseJson(line)
    const v = parsed.ok ? parsed.value : undefined
    const isDirective =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).length > 0 &&
      Object.keys(v).every((k) => k.startsWith('$'))
    if (!isDirective) frames.push({ kind: 'send', line })
    else if ('$wait' in v) {
      const capture = v.$capture
      if (
        capture !== undefined &&
        (capture === null || typeof capture !== 'object' || Array.isArray(capture))
      )
        throw new UsageError(`${path}: $capture must be an object of var → path`)
      frames.push({
        kind: 'wait',
        match: v.$wait,
        timeoutMs: Number(v.$timeoutMs ?? 30_000),
        ...(capture ? { capture } : {}),
      })
    } else if ('$sleep' in v) frames.push({ kind: 'sleep', ms: Number(v.$sleep) })
    else if ('$close' in v) frames.push({ kind: 'close' })
    else if ('$kill' in v) frames.push({ kind: 'kill' })
    else throw new UsageError(`${path}: unknown directive ${line}`)
  }
  return frames
}

async function loadResponderModule(path) {
  const mod = await import(pathToFileURL(resolve(path)).href)
  if (typeof mod.default !== 'function') throw new UsageError(`${path}: default export must be a function`)
  return mod.default
}

function parseResponders(path) {
  const parsed = tryParseJson(readFileSync(path, 'utf8'))
  if (!parsed.ok || !Array.isArray(parsed.value))
    throw new UsageError(`${path}: expected a JSON array of rules`)
  return parsed.value.map((rule, i) => {
    if (rule === null || typeof rule !== 'object' || rule.when === undefined || rule.reply === undefined) {
      throw new UsageError(`${path}[${i}]: a rule needs "when" and "reply"`)
    }
    return { when: rule.when, reply: rule.reply, once: rule.once === true, used: false }
  })
}

/**
 * CODEX_HOME for a Codex recording: required, an existing directory, and never the everyday ~/.codex unless
 * --allow-user-codex-home (recordings use an isolated profile, never the user's own).
 */
function codexHomeOption(opts) {
  const given = opts['--codex-home']
  if (opts['--vendor'] !== 'codex') {
    if (given !== undefined) throw new UsageError('--codex-home is only for --vendor codex')
    return null
  }
  if (given === undefined || given === '')
    throw new UsageError(
      '--codex-home <dir> is required for --vendor codex (an isolated profile such as ~/.codex-fixtures)',
    )
  const dir = resolve(given)
  if (!existsSync(dir))
    throw new UsageError(
      `--codex-home ${dir} does not exist (create it and run \`codex login\` with it first)`,
    )
  const everyday = resolve(homedir(), '.codex')
  const same = process.platform === 'win32' ? dir.toLowerCase() === everyday.toLowerCase() : dir === everyday
  if (same && opts['--allow-user-codex-home'] !== true) {
    throw new UsageError(
      `--codex-home is the everyday ${everyday}; record against an isolated profile or pass --allow-user-codex-home`,
    )
  }
  return dir
}

/**
 * GEMINI_CLI_HOME for a Gemini recording: required, an existing directory (the one that holds `.gemini`), and never
 * the everyday home unless --allow-user-gemini-home (its .gemini is the user's own profile; recordings use an
 * isolated one). The `.gemini` folder itself is refused as a likely mistake (the CLI would make a `.gemini` inside
 * it).
 */
function geminiHomeOption(opts) {
  const given = opts['--gemini-home']
  if (opts['--vendor'] !== 'gemini') {
    if (given !== undefined) throw new UsageError('--gemini-home is only for --vendor gemini')
    if (opts['--allow-user-gemini-home'] === true)
      throw new UsageError('--allow-user-gemini-home is only for --vendor gemini')
    return null
  }
  if (given === undefined || given === '')
    throw new UsageError(
      '--gemini-home <dir> is required for --vendor gemini (a folder for an isolated profile, such as ~/.gemini-fixtures)',
    )
  const dir = resolve(given)
  if (!existsSync(dir))
    throw new UsageError(
      `--gemini-home ${dir} does not exist (create it, then run \`gemini\` once with GEMINI_CLI_HOME set to it and sign in)`,
    )
  const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase())
  if (same(dir, resolve(homedir(), '.gemini')) || basename(dir).toLowerCase() === '.gemini')
    throw new UsageError(
      `--gemini-home names a .gemini folder; pass the folder that holds it (GEMINI_CLI_HOME)`,
    )
  if (same(dir, resolve(homedir())) && opts['--allow-user-gemini-home'] !== true) {
    throw new UsageError(
      `--gemini-home is the everyday home (its .gemini is your own profile); record against an isolated profile or pass --allow-user-gemini-home`,
    )
  }
  return dir
}

/**
 * GROK_HOME for a Grok recording: required, an existing directory (the profile folder itself, which Grok's
 * GROK_HOME names), and never the everyday ~/.grok unless --allow-user-grok-home. The home folder itself is refused as
 * a likely mistake (Grok would use it as its profile folder).
 */
function grokHomeOption(opts) {
  const given = opts['--grok-home']
  if (opts['--vendor'] !== 'grok') {
    if (given !== undefined) throw new UsageError('--grok-home is only for --vendor grok')
    if (opts['--allow-user-grok-home'] === true)
      throw new UsageError('--allow-user-grok-home is only for --vendor grok')
    return null
  }
  if (given === undefined || given === '')
    throw new UsageError(
      '--grok-home <dir> is required for --vendor grok (an isolated profile folder, such as ~/.grok-fixtures)',
    )
  const dir = resolve(given)
  if (!existsSync(dir))
    throw new UsageError(
      `--grok-home ${dir} does not exist (create it, then run \`grok login\` once with GROK_HOME set to it)`,
    )
  const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase())
  if (same(dir, resolve(homedir())))
    throw new UsageError(
      '--grok-home names the home folder; pass the profile folder Grok should use (GROK_HOME)',
    )
  if (same(dir, resolve(homedir(), '.grok')) && opts['--allow-user-grok-home'] !== true) {
    throw new UsageError(
      `--grok-home is the everyday ${dir} (your own profile); record against an isolated profile or pass --allow-user-grok-home`,
    )
  }
  return dir
}

/**
 * The home folder for a Muse recording: required, an existing directory that stands in for the user's
 * home (museHomeEnv points HOME, USERPROFILE, XDG_CONFIG_HOME, APPDATA and LOCALAPPDATA at it), so Muse loads the
 * isolated profile's ~/.config/muse, never the everyday one (refused unless --allow-user-muse-home). A `.config` or
 * `muse` folder is refused as a likely mistake (the home itself is wanted).
 */
function museHomeOption(opts, museVendor) {
  const given = opts['--muse-home']
  if (!museVendor) {
    if (given !== undefined) throw new UsageError('--muse-home is only for --muse')
    if (opts['--allow-user-muse-home'] === true)
      throw new UsageError('--allow-user-muse-home is only for --muse')
    return null
  }
  if (given === undefined || given === '')
    throw new UsageError(
      '--muse-home <dir> is required for --muse (a folder that stands in for the home, such as ~/.muse-fixtures)',
    )
  const dir = resolve(given)
  if (!existsSync(dir))
    throw new UsageError(
      `--muse-home ${dir} does not exist (create it; Muse signs in with META_API_KEY from --env-file)`,
    )
  const name = basename(dir).toLowerCase()
  if (name === '.config' || name === 'muse')
    throw new UsageError(
      `--muse-home names a settings folder; pass the folder that stands in for the home (its .config/muse is the profile)`,
    )
  const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase())
  if (same(dir, resolve(homedir())) && opts['--allow-user-muse-home'] !== true) {
    throw new UsageError(
      `--muse-home is the everyday home (its ~/.config/muse is your own profile); record against an isolated folder or pass --allow-user-muse-home`,
    )
  }
  return dir
}

/** Inherited variables a Grok recording never takes from the recorder's own env (keys, homes, Grok's own switches). */
const GROK_ENV_DROP = ['^GROK_', '^XAI_']

/** Inherited variables a Gemini recording never takes from the recorder's own env (keys, projects, other homes). */
const GEMINI_ENV_DROP = ['^GEMINI_', '^GOOGLE_']
/** A Google Cloud project named in the recorded CLI's env names the account: its value is redacted everywhere. */
const PROJECT_ENV_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_QUOTA_PROJECT']

/** The value after `flag` in argv (`-o <v>`, `--flag=<v>`); undefined when absent. */
function argvValueOf(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1]
    if (flag.startsWith('--') && argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1)
  }
  return undefined
}

/** Inherited variables a Codex recording never takes from the recorder's own env (keys, other homes). */
const CODEX_ENV_DROP = ['^OPENAI_', '^CODEX_']

function readHostVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** Spellings of an absolute path as they appear in raw text and inside JSON strings (one or two levels). */
function pathSpellings(p) {
  const back = p.replace(/\//g, '\\')
  const json1 = back.replace(/\\/g, '\\\\')
  return [...new Set([p, p.replace(/\\/g, '/'), back, json1, json1.replace(/\\/g, '\\\\')])]
}

function userSegments(username) {
  return ['/', '\\', '\\\\', '\\\\\\\\'].flatMap((sep) => [`Users${sep}${username}`, `home${sep}${username}`])
}

/**
 * The git user.name as seen from `cwd` (the sandbox's own or the global one): a review that runs `git log` prints
 * it with every commit. Undefined when git has none or cannot run.
 */
function gitUserName(cwd) {
  try {
    const r = spawnSync('git', ['config', '--get', 'user.name'], {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    })
    const name = r.status === 0 ? r.stdout.trim() : ''
    return name.length >= 4 ? name : undefined
  } catch {
    return undefined
  }
}

/** A folder path for comparison: forward slashes, no trailing slash, case-folded where the file system folds case. */
function folderKey(p) {
  const key = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'linux' ? key : key.toLowerCase()
}

function pathVariants(p) {
  const out = [p]
  try {
    out.push(realpathSync.native(p))
  } catch {
    // keep the given path
  }
  for (const v of [...out])
    if (process.platform === 'darwin' && v.startsWith('/private/')) out.push(v.slice(8))
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts['--help']) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  const codexRpc = opts['--codex-app-server'] === true
  if (codexRpc) {
    opts['--vendor'] ??= 'codex'
    opts['--route'] ??= 'app-server'
    if (opts['--vendor'] !== 'codex') throw new UsageError('--codex-app-server records --vendor codex')
    if (opts['--arg'].length === 0) opts['--arg'].push('app-server', '--listen', 'stdio://')
  }
  const acp = opts['--acp'] === true
  if (acp) {
    if (codexRpc) throw new UsageError('--acp and --codex-app-server are different protocols')
    if (!opts['--vendor']) throw new UsageError('--acp needs --vendor (the ACP agent, e.g. gemini)')
    opts['--route'] ??= 'acp'
  }
  /** JSON-RPC by message: the Codex app-server or an ACP agent. */
  const rpc = codexRpc || acp
  // Muse (`muse exec --json`, one record per line; museMode below).
  const museVendor = opts['--muse'] === true
  if (museVendor) {
    if (rpc) throw new UsageError('--muse records exec lines, not a JSON-RPC protocol')
    opts['--vendor'] ??= 'muse'
    opts['--route'] ??= 'exec'
    if (opts['--vendor'] !== 'muse') throw new UsageError('--muse records --vendor muse')
  } else if (opts['--vendor'] === 'muse') throw new UsageError('--vendor muse is recorded with --muse')
  for (const req of ['--bin', '--out', '--vendor', '--route', '--id', '--slug']) {
    if (!opts[req]) throw new UsageError(`${req} is required`)
  }
  // The Gemini options first: a --gemini-home given to another vendor is the mistake to name, not that vendor's own
  // missing home.
  const geminiHome = geminiHomeOption(opts)
  const grokHome = grokHomeOption(opts)
  const museHome = museHomeOption(opts, museVendor)
  const codexHome = codexHomeOption(opts)
  const claudeVendor = opts['--vendor'] === 'claude'
  if (!claudeVendor && opts['--claude-config'] !== undefined)
    throw new UsageError('--claude-config is only for --vendor claude')
  const entry = opts['--entry']
  if (entry !== undefined && !existsSync(resolve(entry)))
    throw new UsageError(`--entry ${resolve(entry)} does not exist`)
  const timing = opts['--timing'] ?? 'on'
  if (timing !== 'on' && timing !== 'off') throw new UsageError('--timing must be on or off')
  const timeoutMs = opts['--timeout'] === undefined ? 120_000 : Number(opts['--timeout'])
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new UsageError('--timeout must be a positive number of ms')

  const bin = opts['--bin']
  const args = opts['--arg']
  const cwd = resolve(opts['--cwd'] ?? process.cwd())
  const outDir = resolve(opts['--out'])
  const extraEnv = opts['--env-file'] ? parseEnvFile(opts['--env-file']) : {}
  for (const kv of opts['--env']) {
    const eq = kv.indexOf('=')
    if (eq <= 0) throw new UsageError(`--env expects KEY=VALUE, got "${kv}"`)
    extraEnv[kv.slice(0, eq)] = kv.slice(eq + 1)
  }
  if (codexHome !== null) extraEnv.CODEX_HOME = codexHome
  if (geminiHome !== null) extraEnv.GEMINI_CLI_HOME = geminiHome
  if (grokHome !== null) {
    extraEnv.GROK_HOME = grokHome
    // As Dim Factory's launch does: the recorded agent never updates itself.
    extraEnv.GROK_DISABLE_AUTOUPDATER = '1'
  }
  // The recorded Muse's home is the isolated folder (the everyday one, when allowed, is the home itself).
  if (museHome !== null) Object.assign(extraEnv, museHomeEnv(museHome))
  // Claude: the config folder whose profile is scrubbed (--claude-config, else the recorded CLI's CLAUDE_CONFIG_DIR).
  const claudeConfigDir = claudeVendor
    ? resolve(opts['--claude-config'] ?? extraEnv.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
    : null
  const frames = opts['--stdin'] ? parseFrames(opts['--stdin']) : []
  const responderPath = opts['--responders']
  const responderModule =
    responderPath && /.m?js$/i.test(responderPath) ? await loadResponderModule(responderPath) : null
  const responders = responderPath && responderModule === null ? parseResponders(responderPath) : []
  const envDropPatterns = [
    ...(codexHome !== null ? CODEX_ENV_DROP : []),
    ...(geminiHome !== null ? GEMINI_ENV_DROP : []),
    ...(grokHome !== null ? GROK_ENV_DROP : []),
    ...(museVendor ? MUSE_ENV_DROP : []),
    ...opts['--env-drop'],
  ]
  const envDrop = envDropPatterns.map((p) => {
    try {
      return new RegExp(p, 'i')
    } catch {
      throw new UsageError(`--env-drop: invalid regex ${p}`)
    }
  })
  // A Google Cloud project the recorded CLI is given (--env-file) names the account: redacted like a literal.
  const literals = [
    ...opts['--redact-literal'],
    ...(geminiHome !== null ? PROJECT_ENV_KEYS.flatMap((k) => (extraEnv[k] ? [extraEnv[k]] : [])) : []),
  ].filter((l) => l.length > 0)
  const keepStdin = opts['--keep-stdin'] === true
  const codexVendor = opts['--vendor'] === 'codex'
  const geminiVendor = geminiHome !== null
  const grokVendor = grokHome !== null
  /** Recordings whose host closes stdin and kills like an adapter does: eof and hold frames. */
  const hostFrames = codexVendor || acp || museVendor
  // Muse: the prompt is the file `--prompt-file` names (Dim Factory writes it before the spawn, never argv). The
  // recording opens with a promptFile frame holding its text (the replay checks the file the adapter wrote), and the
  // header's argv names it <PROMPT_FILE>.
  const promptFileArg = museVendor ? argvValueOf(args, '--prompt-file') : undefined
  if (museVendor && (promptFileArg === undefined || !existsSync(resolve(cwd, promptFileArg))))
    throw new UsageError(
      '--muse: the recorded argv needs --prompt-file <an existing file> (the recipe prompt.md)',
    )
  const outputFlag = opts['--output-file']
  if (outputFlag !== undefined && argvValueOf(args, outputFlag) === undefined)
    throw new UsageError(`--output-file ${outputFlag}: the recorded argv has no ${outputFlag} <file>`)
  let pass
  if (opts['--pass-file'] !== undefined) {
    try {
      pass = JSON.parse(readFileSync(resolve(opts['--pass-file']), 'utf8'))
    } catch (err) {
      throw new UsageError(`--pass-file: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (pass === null || typeof pass !== 'object' || Array.isArray(pass))
      throw new UsageError('--pass-file must hold a JSON object')
  }
  // Codex and ACP recipes name the sandbox folder $cwd (tests/fixtures/*/recipes); --var cwd=… overrides it.
  const presetVars = opts['--vendor'] === 'codex' || acp ? { cwd } : {}
  for (const kv of opts['--var']) {
    const eq = kv.indexOf('=')
    if (eq <= 0) throw new UsageError(`--var expects NAME=VALUE, got "${kv}"`)
    presetVars[kv.slice(0, eq)] = kv.slice(eq + 1)
  }

  const base = { mode: 'fixture', home: homedir(), username: userInfo().username, hostname: hostname() }
  const cwdVariants = pathVariants(cwd)
  const counts = {}
  const tally = (c) => {
    for (const [k, n] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + n
  }
  const literalVariants = [...new Set(literals.flatMap((l) => [l, JSON.stringify(l).slice(1, -1)]))].sort(
    (a, b) => b.length - a.length,
  )
  const redactLiterals = (text) => {
    let out = text
    for (const l of literalVariants) {
      const parts = out.split(l)
      if (parts.length > 1) tally({ literal: parts.length - 1 })
      out = parts.join('<REDACTED>')
    }
    return out
  }
  // CODEX_HOME (often under the home dir) → <CODEX_HOME>, and GEMINI_CLI_HOME → <GEMINI_CLI_HOME>, before the home
  // rule would turn them into a ~ path. GEMINI_CLI_HOME may be the everyday home itself (--allow-user-gemini-home):
  // that one is left to the home rule (`~/.gemini/…`), which runs after the sandbox rule as usual.
  const sameFolder = (a, b) => folderKey(a) === folderKey(b)
  const profileHomes = [
    ...(codexHome !== null ? [[codexHome, '<CODEX_HOME>', 'codexHome']] : []),
    ...(geminiHome !== null && !sameFolder(geminiHome, base.home)
      ? [[geminiHome, GEMINI_HOME_PLACEHOLDER, 'geminiHome']]
      : []),
    // GROK_HOME is the profile folder itself; the everyday ~/.grok (when allowed) is left to the home rule.
    ...(grokHome !== null && !sameFolder(grokHome, join(base.home, '.grok'))
      ? [[grokHome, GROK_HOME_PLACEHOLDER, 'grokHome']]
      : []),
    // The isolated Muse home; the everyday home (when allowed) is left to the home rule.
    ...(museHome !== null && !sameFolder(museHome, base.home)
      ? [[museHome, MUSE_HOME_PLACEHOLDER, 'museHome']]
      : []),
  ]
  const homeRules = profileHomes.flatMap(([dir, placeholder, id]) =>
    [...new Set(pathVariants(dir).flatMap(pathSpellings))]
      .sort((a, b) => b.length - a.length)
      .map((s) => ({
        re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), process.platform === 'linux' ? 'g' : 'gi'),
        placeholder,
        id,
      })),
  )
  const redactProfileHomes = (text) => {
    let out = text
    for (const { re, placeholder, id } of homeRules) {
      out = out.replace(re, () => {
        tally({ [id]: 1 })
        return placeholder
      })
    }
    return out
  }
  // Codex and Gemini: what the profile's own files name and the git identity the sandbox's commits carry, redacted in
  // every line the CLI writes (never in the host's own frames); scripts/redact-codex.mjs, scripts/redact-gemini.mjs.
  const profile =
    codexHome !== null
      ? profileTerms(codexHome)
      : geminiHome !== null
        ? geminiProfileTerms(geminiHome)
        : grokHome !== null
          ? grokProfileTerms(grokHome)
          : museHome !== null
            ? museProfileTerms(museHome)
            : claudeConfigDir !== null
              ? claudeProfileTerms(claudeConfigDir)
              : { literals: [], names: [], skipped: 0 }
  // A folder the path rules already name (CODEX_HOME, GEMINI_CLI_HOME, the home folder, the sandbox, or a folder above
  // one of them, as when the profile trusts its own CODEX_HOME as a project) is left to them: as a literal it would
  // turn `<CODEX_HOME>`, `~` and `<CWD>` paths into a bare <REDACTED>. A folder below one of them stays a literal.
  const coveredFolders = [
    ...(codexHome !== null ? pathVariants(codexHome) : []),
    ...(geminiHome !== null ? pathVariants(geminiHome) : []),
    ...(grokHome !== null ? pathVariants(grokHome) : []),
    ...(museHome !== null ? pathVariants(museHome) : []),
    ...pathVariants(base.home),
    ...cwdVariants,
  ].map(folderKey)
  const profileLiterals = profile.literals.filter((l) => {
    if (!isAbsolute(l)) return true
    const key = folderKey(l)
    return !coveredFolders.some((c) => c === key || c.startsWith(`${key}/`))
  })
  // Muse: its protocol rules, what the isolated profile's settings name and the git user.name
  // (scripts/redact-muse.mjs).
  const profileVendor = codexVendor || geminiVendor || grokVendor || museVendor || claudeVendor
  const gitName = profileVendor ? gitUserName(cwd) : undefined
  const profileSpellings = [
    ...new Set(
      profileLiterals.flatMap((l) => [
        ...(/[\\/]/.test(l) ? pathSpellings(l) : [l]),
        JSON.stringify(l).slice(1, -1),
      ]),
    ),
  ].sort((a, b) => b.length - a.length)
  const profileRules = profileSpellings.map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))
  // Claude: every profile name is matched exactly in the CLI's own listings (claudeNames), only the distinctive
  // ones as words in free text; a name the CLI's initialize reply marks built in is dropped from both (claudeBuiltins),
  // and the names of the commands and agents it does not mark built in are added (learnClaudeNames).
  const claudeBuiltins = new Set()
  const claudeLearned = new Set()
  const claudeNames = new Set()
  // A learned name is a word in free text only when namespaced (`plugin:skill`): a synced skill's plain name
  // (computer-use, deep-research) is a common term that the CLI's own descriptions use too.
  const proseNames = () =>
    claudeVendor
      ? [...new Set([...profile.names, ...[...claudeLearned].filter((n) => n.includes(':'))])].filter(
          (n) => proseName(n) && !claudeBuiltins.has(n.toLowerCase()),
        )
      : profile.names
  const buildWords = () => wordMatchers([...proseNames(), ...(gitName !== undefined ? [gitName] : [])])
  const refreshClaudeNames = () => {
    claudeNames.clear()
    for (const n of [...profile.names, ...claudeLearned])
      if (!claudeBuiltins.has(n.toLowerCase())) claudeNames.add(n.toLowerCase())
  }
  refreshClaudeNames()
  let words = buildWords()
  /** Claude: what an initialize reply or a commands_changed push says is built in, and what it does not. */
  const learnClaudeNames = (value) => {
    const list = value?.response?.response?.commands ?? value?.commands
    const agents = value?.response?.response?.agents
    let changed = false
    for (const b of builtinCommandNames(value))
      if (!claudeBuiltins.has(b)) {
        claudeBuiltins.add(b)
        changed = true
      }
    const learn = (n) => {
      if (typeof n !== 'string' || n === REDACTED || n.length < 3 || claudeLearned.has(n)) return
      claudeLearned.add(n)
      changed = true
    }
    if (Array.isArray(list))
      for (const c of list)
        if (c !== null && typeof c === 'object' && c.builtin !== true) {
          learn(c.name)
          if (Array.isArray(c.aliases)) c.aliases.forEach(learn)
        }
    if (Array.isArray(agents))
      for (const a of agents)
        if (a !== null && typeof a === 'object' && !BUILTIN_AGENTS.includes(a.name)) learn(a.name)
    if (!changed) return
    refreshClaudeNames()
    words = buildWords()
    resetNeedles()
  }
  const redactProfileLiterals = (text, count) => {
    let out = text
    for (const re of profileRules) {
      out = out.replace(re, () => {
        if (count) tally({ profile: 1 })
        return REDACTED
      })
    }
    return out
  }
  /** The vendor's protocol rules and the profile's names, on one (already shared-redacted) line the CLI wrote. */
  const redactProfileLine = (text, count) => {
    const parsed = tryParseJson(text)
    if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object') {
      const rules = geminiVendor
        ? redactGeminiValue(parsed.value)
        : grokVendor
          ? redactGrokValue(parsed.value)
          : museVendor
            ? redactMuseValue(parsed.value)
            : claudeVendor
              ? redactClaudeValue(parsed.value, { names: claudeNames })
              : redactCodexValue(parsed.value)
      const terms = redactTerms(rules.value, words)
      if (count) tally({ ...rules.counts, ...(terms.count > 0 ? { 'profile-name': terms.count } : {}) })
      return Object.keys(rules.counts).length > 0 || terms.count > 0 ? JSON.stringify(terms.value) : text
    }
    const terms = redactTerms(
      geminiVendor
        ? redactGeminiText(text)
        : grokVendor
          ? redactGrokText(text)
          : museVendor
            ? redactMuseText(text)
            : text,
      words,
    )
    if (count && terms.count > 0) tally({ 'profile-name': terms.count })
    return terms.value
  }
  // The machine's temp folder and the path under it, in what the CLI writes (after the sandbox rule; also in the `~`
  // form the home rule leaves): a scratch folder's session id, and a sandbox path a shell cut or wrapped.
  const tmpVariants = pathVariants(tmpdir())
  const redactTmp = (text, count) => {
    let out = text
    for (const t of tmpVariants) {
      const r = redactTempFolder(out, {
        tmp: t,
        home: base.home,
        caseInsensitive: process.platform !== 'linux',
      })
      if (count && r.count > 0) tally({ tmp: r.count })
      out = r.text
    }
    return out
  }
  // One pass per cwd spelling (given, real, macOS /private-less); redaction is idempotent.
  /** Gemini: the sandbox first, should it sit under GEMINI_CLI_HOME (the home rule would cut it). */
  const sandboxFirst = (text) => {
    if (!geminiVendor) return text
    let out = text
    for (const v of cwdVariants) out = redactText(out, { mode: 'fixture', cwd: v }).text
    return out
  }
  const redact = (line, count = true, dir = 'out') => {
    const cli = dir !== 'in'
    const server = profileVendor && cli
    let text = redactLiterals(
      redactProfileHomes(sandboxFirst(server ? redactProfileLiterals(line, count) : line)),
    )
    for (const v of cwdVariants) {
      const r = redactLine(text, { ...base, cwd: v })
      if (count) tally(r.counts)
      text = r.text
    }
    text = redactLiterals(text)
    if (cli) text = redactTmp(text, count)
    return server ? redactProfileLine(text, count) : text
  }
  /** argv (the host's) and file content (`server`: what the CLI wrote, the profile's terms too) as plain text. */
  const redactArg = (arg, server = false) => {
    let text = redactLiterals(
      redactProfileHomes(sandboxFirst(server ? redactProfileLiterals(arg, true) : arg)),
    )
    for (const v of cwdVariants) text = redactText(text, { ...base, cwd: v }).text
    text = redactLiterals(text)
    if (!server) return text
    text = redactTmp(text, true)
    const terms = redactTerms(text, words)
    if (terms.count > 0) tally({ 'profile-name': terms.count })
    return terms.value
  }

  const header = {
    kind: 'header',
    schemaVersion: 1,
    vendor: opts['--vendor'],
    route: opts['--route'],
    scenario: `${opts['--id']}-${opts['--slug']}`,
    ...(opts['--cli-version'] ? { cliVersion: opts['--cli-version'] } : {}),
    ...(rpc ? { protocol: 'jsonrpc' } : {}),
    ...(acp ? { jsonrpc: '2.0' } : {}),
    os: process.platform,
    arch: process.arch,
    ...(timing === 'on' ? { recordedAt: new Date().toISOString() } : {}),
    // An --entry run is `node <entry> <args>`: the header names the agent itself (the entry path is the machine's).
    // Muse: the prompt file's path is <PROMPT_FILE> (Dim Factory's is under runs/<id>/prompts, the recipe's elsewhere).
    argv: [entry !== undefined ? opts['--vendor'] : basename(bin), ...args].map((a, i, all) =>
      museVendor && all[i - 1] === '--prompt-file' ? MUSE_PROMPT_FILE : redactArg(a),
    ),
    ...(entry !== undefined ? { launch: 'node <entry>' } : {}),
    envKeys: Object.keys(extraEnv).sort(),
    ...(envDropPatterns.length > 0 ? { envDrop: envDropPatterns } : {}),
    ...(pass !== undefined ? { pass } : {}),
    hostVersion: readHostVersion(),
  }

  // Streamed deltas can split a path or literal across frames, where no per-line rule sees it whole. Any
  // trailing fragment that could start a sensitive needle is carried into the next delta of the same block
  // (or appended back to the last one at content_block_stop), so the concatenated text is unchanged.
  const baseNeedles = () =>
    [
      ...cwdVariants.flatMap(pathSpellings),
      ...pathSpellings(base.home),
      ...profileHomes.flatMap(([dir]) => pathVariants(dir).flatMap(pathSpellings)),
      ...tmpVariants.flatMap(pathSpellings),
      ...literalVariants,
      ...profileSpellings,
      ...proseNames(),
      ...(gitName !== undefined ? [gitName] : []),
      ...(base.username.length > 1 ? userSegments(base.username) : []),
      ...(base.hostname.length > 2 ? [base.hostname] : []),
    ].map((n) => n.toLowerCase())
  let needles = baseNeedles()
  let longestNeedle = Math.max(0, ...needles.map((n) => n.length))
  function resetNeedles() {
    needles = baseNeedles()
    longestNeedle = Math.max(0, ...needles.map((n) => n.length))
  }
  const heldSuffix = (text) => {
    const lower = text.toLowerCase()
    for (let start = Math.max(0, lower.length - longestNeedle + 1); start < lower.length; start++) {
      const tail = lower.slice(start)
      if (needles.some((n) => n.length > tail.length && n.startsWith(tail))) return text.length - start
    }
    return 0
  }
  const deltaBlocks = new Map()
  /** Rebalances one delta string of `value` (holder[field]) within its block `key`; records the frame. */
  const rebalance = (dir, value, key, holder, field) => {
    const block = deltaBlocks.get(key) ?? { carry: '' }
    const pending = block.carry + holder[field]
    const hold = heldSuffix(pending)
    holder[field] = pending.slice(0, pending.length - hold)
    block.carry = pending.slice(pending.length - hold)
    const frame = record(dir, JSON.stringify(value))
    block.last = { frame, value, holder, field }
    deltaBlocks.set(key, block)
    return frame
  }
  /** Records a streamed delta with its fragments rebalanced; null when the frame is not one. */
  const recordDelta = (dir, value) => {
    // Codex app-server: item/*Delta {itemId, delta}; the block ends with that item's item/completed or the turn.
    if (codexRpc && typeof value.method === 'string') {
      const params = value.params !== null && typeof value.params === 'object' ? value.params : undefined
      if (value.method === 'item/completed') flushDeltas((k) => k.endsWith(`:${params?.item?.id ?? ''}`))
      if (value.method === 'turn/completed') flushDeltas(null)
      if (!CODEX_DELTA_METHODS.has(value.method) || typeof params?.delta !== 'string') return null
      return rebalance(dir, value, `${value.method}:${params.itemId ?? ''}`, params, 'delta')
    }
    // ACP: session/update chunks {sessionId, update:{sessionUpdate, content:{type:'text', text}}}; a block is one kind
    // of chunk in one session, ended by any other update of that session or by a response (the prompt's end).
    if (acp) {
      const params = value.params !== null && typeof value.params === 'object' ? value.params : undefined
      const update = params?.update !== null && typeof params?.update === 'object' ? params.update : undefined
      if (value.method === 'session/update' && update !== undefined) {
        const session = `${params.sessionId ?? ''}:`
        const content =
          update.content !== null && typeof update.content === 'object' ? update.content : undefined
        if (
          ACP_CHUNK_KINDS.has(update.sessionUpdate) &&
          content?.type === 'text' &&
          typeof content.text === 'string' &&
          !(geminiVendor && GEMINI_MODE_UPDATE.test(content.text.trim()))
        ) {
          const key = `${session}${update.sessionUpdate}`
          flushDeltas((k) => k.startsWith(session) && k !== key)
          return rebalance(dir, value, key, content, 'text')
        }
        flushDeltas((k) => k.startsWith(session))
        return null
      }
      if (typeof value.method !== 'string' && Object.hasOwn(value, 'id')) flushDeltas(null)
      return null
    }
    if (value.type !== 'stream_event' || value.event === null || typeof value.event !== 'object') return null
    const ev = value.event
    const key = `${value.parent_tool_use_id ?? ''}:${ev.index ?? ''}`
    if (ev.type === 'content_block_stop') flushDeltas((k) => k === key)
    if (ev.type === 'message_stop') flushDeltas(null)
    if (ev.type !== 'content_block_delta' || ev.delta === null || typeof ev.delta !== 'object') return null
    const field = ['partial_json', 'text', 'thinking'].find((f) => typeof ev.delta[f] === 'string')
    if (field === undefined) return null
    return rebalance(dir, value, key, ev.delta, field)
  }
  /** Puts each held fragment back onto its block's last delta (`which`: the blocks to flush; null = all). */
  const flushDeltas = (which) => {
    for (const [key, block] of deltaBlocks) {
      if (which !== null && !which(key)) continue
      if (block.carry !== '' && block.last) {
        const { frame, value, holder, field } = block.last
        holder[field] += block.carry
        frame.line = redact(JSON.stringify(value), false, frame.dir)
      }
      deltaBlocks.delete(key)
    }
  }

  const recorded = []
  const t0 = performance.now()
  const now = () => (timing === 'on' ? Math.round(performance.now() - t0) : 0)
  const record = (dir, raw) => {
    let line = raw
    const frame = { t: now(), dir }
    const crlf = line.endsWith('\r')
    if (crlf) line = line.slice(0, -1)
    frame.line = redact(line, true, dir)
    if (crlf) frame.crlf = true
    recorded.push(frame)
    return frame
  }
  // Muse: the prompt file as the CLI will read it, first (the host's text: the host rules, not the profile's).
  if (promptFileArg !== undefined) {
    recorded.push({
      t: now(),
      dir: 'promptFile',
      argvPath: '--prompt-file',
      content: redactArg(readFileSync(resolve(cwd, promptFileArg), 'utf8')),
    })
  }

  const inherited = recorderEnv(process.env)
  for (const key of Object.keys(inherited)) if (envDrop.some((re) => re.test(key))) delete inherited[key]

  let child
  try {
    child = spawn(bin, entry !== undefined ? [resolve(entry), ...args] : args, {
      cwd,
      env: { ...inherited, ...extraEnv },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    throw new UsageError(`cannot spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const exited = new Promise((done, fail) => {
    child.once('error', (e) => {
      if (child.pid === undefined) fail(new UsageError(`cannot spawn ${bin}: ${e.message}`))
    })
    child.once('close', (code, signal) => done({ code, signal }))
  })

  let stdinOpen = true
  child.stdin.on('error', () => {
    stdinOpen = false // the CLI exited or closed its stdin; later writes are dropped
  })
  const writeIn = (line) => {
    if (!stdinOpen) {
      process.stderr.write(`record-fixture: stdin already closed, dropped: ${line.slice(0, 120)}\n`)
      return
    }
    record('in', line)
    child.stdin.write(`${line}\n`)
  }
  const closeStdin = () => {
    if (!stdinOpen) return
    stdinOpen = false
    child.stdin.end()
    // Codex and ACP: the replay waits for the host's close here (exec reads its prompt to EOF; app-server and an ACP
    // agent exit on it).
    if (hostFrames) recorded.push({ t: now(), dir: 'eof' })
  }
  /** $capture vars (and --var presets), filled into later stdin frames ("$v" whole value, ${v} inside a string). */
  const captured = { ...presetVars }
  const fill = (line) => {
    if (Object.keys(captured).length === 0) return line
    const parsed = tryParseJson(line)
    if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object')
      return JSON.stringify(substituteValue(parsed.value, captured))
    return substituteText(line, captured)
  }

  // ---- stdin pump: synchronous between directives so frame order stays deterministic ----
  const outFrames = []
  let frameIndex = 0
  let waitCursor = 0
  let pendingTimer = null
  let failure = null
  let pumpDone = false
  const pump = () => {
    if (pumpDone || pendingTimer !== null || failure !== null) return
    while (frameIndex < frames.length) {
      const f = frames[frameIndex]
      if (f.kind === 'send') {
        writeIn(fill(f.line))
      } else if (f.kind === 'close') {
        closeStdin()
      } else if (f.kind === 'kill') {
        killTree()
      } else if (f.kind === 'sleep') {
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          frameIndex++
          pump()
        }, f.ms)
        return
      } else {
        let hit = -1
        for (let i = waitCursor; i < outFrames.length; i++) {
          if (outFrames[i] !== undefined && matchPartial(f.match, outFrames[i]).ok) {
            hit = i
            break
          }
        }
        if (hit === -1) {
          if (f.timer === undefined) {
            f.timer = setTimeout(() => {
              failure = `timed out after ${f.timeoutMs} ms on $wait ${JSON.stringify(f.match)}`
              kill()
            }, f.timeoutMs)
          }
          return
        }
        clearTimeout(f.timer)
        waitCursor = hit + 1
        for (const [name, path] of Object.entries(f.capture ?? {})) {
          const value = getPath(outFrames[hit], path)
          if (value === undefined) {
            failure = `$capture ${name}: ${path} is not in the frame $wait matched`
            kill()
            return
          }
          captured[name] = value
        }
      }
      frameIndex++
    }
    pumpDone = true
    if (!keepStdin) closeStdin()
  }

  /**
   * Answers one stdout frame from the responders; true when a rule took it. A rule whose reply is null takes the
   * frame without answering (a Codex ask left pending until the server resolves it; no -32601 either).
   */
  const answer = (frame) => {
    if (responderModule !== null) {
      const reply = responderModule(frame)
      if (reply === undefined || reply === null) return false
      for (const r of Array.isArray(reply) ? reply : [reply])
        writeIn(typeof r === 'string' ? r : JSON.stringify(r))
      return true
    }
    for (const rule of responders) {
      if (rule.once && rule.used) continue
      const m = matchPartial(rule.when, frame)
      if (!m.ok) continue
      rule.used = true
      if (rule.reply === null) return true
      const replies = Array.isArray(rule.reply) ? rule.reply : [rule.reply]
      for (const reply of replies) {
        const value = substituteValue(reply, { ...captured, ...m.binds })
        writeIn(typeof value === 'string' ? value : JSON.stringify(value))
      }
      return true
    }
    return false
  }
  const respond = (frame) => {
    if (answer(frame) || !rpc || Array.isArray(frame)) return
    // A JSON-RPC server request nothing answered: -32601, as a host that does not know the method replies.
    if (typeof frame.method === 'string' && Object.hasOwn(frame, 'id')) {
      writeIn(
        JSON.stringify({
          ...(acp ? { jsonrpc: '2.0' } : {}),
          id: frame.id,
          error: { code: -32601, message: `Unsupported by the recorder: ${frame.method}` },
        }),
      )
    }
  }

  const splitter = (dir) => {
    let buffer = ''
    return {
      push(chunk) {
        buffer += chunk
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          onLine(dir, line)
          nl = buffer.indexOf('\n')
        }
      },
      flush() {
        if (buffer === '') return
        const frame = record(dir, buffer)
        frame.eol = false
        buffer = ''
      },
    }
  }
  /**
   * Gemini: the plan file its exit_plan_mode request names (title `Requesting plan approval for: <file>`), as a file
   * frame before the request: only a .md of 1 MB or less inside <GEMINI_CLI_HOME>/.gemini/tmp (after symlinks), the
   * folder Dim Factory reads plans from; anything else is left out.
   */
  const recordPlanFile = (value) => {
    if (!geminiVendor || value.method !== 'session/request_permission') return
    const title = value.params?.toolCall?.title
    const m = typeof title === 'string' ? GEMINI_PLAN_EXIT_TITLE.exec(title.trim()) : null
    const file = m?.[1]
    if (file === undefined || !isAbsolute(file) || !/\.md$/i.test(file)) return
    try {
      const root = realpathSync(join(geminiHome, '.gemini', 'tmp'))
      const real = realpathSync(file)
      const rel = relative(root, real)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
      const st = statSync(real)
      if (!st.isFile() || st.size > 1024 * 1024) return
      recorded.push({
        t: now(),
        dir: 'file',
        path: redactGeminiText(redactArg(file, true)),
        content: redactArg(readFileSync(real, 'utf8'), true),
      })
      tally({ 'gemini-plan-file': 1 })
    } catch {
      // not there (yet): the replay then has no plan file, as the live run had none
    }
  }
  const onLine = (dir, line) => {
    if (dir !== 'out') {
      record(dir, line)
      return
    }
    const parsed = tryParseJson(line.trim())
    const value =
      parsed.ok && parsed.value !== null && typeof parsed.value === 'object' ? parsed.value : undefined
    if (value !== undefined && !Array.isArray(value)) recordPlanFile(value)
    if (claudeVendor && value !== undefined && !Array.isArray(value)) learnClaudeNames(value)
    const rebalanced =
      value !== undefined && !Array.isArray(value) && !line.endsWith('\r')
        ? recordDelta(dir, structuredClone(value))
        : null
    if (rebalanced === null) record(dir, line)
    outFrames.push(value)
    if (value !== undefined) respond(value)
    pump()
  }
  const out = splitter('out')
  const err = splitter('err')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => out.push(c))
  child.stderr.on('data', (c) => err.push(c))

  let timedOut = false
  let killedTree = false
  let killTimer = null
  const killTree = () => {
    killedTree = true
    if (process.platform === 'win32' && child.pid !== undefined) {
      const tk = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      })
      tk.once('error', () => child.kill('SIGKILL'))
    } else child.kill('SIGKILL')
  }
  const kill = () => {
    timedOut = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
  }
  const deadline = setTimeout(() => {
    failure ??= `timed out after ${timeoutMs} ms`
    kill()
  }, timeoutMs)

  pump()

  let exit
  try {
    exit = await exited
  } finally {
    clearTimeout(deadline)
    clearTimeout(killTimer)
    clearTimeout(pendingTimer)
    for (const f of frames) clearTimeout(f.timer)
  }
  // Partial (unterminated) final lines are flushed at close, after all data, so their position is stable.
  out.flush()
  err.flush()
  flushDeltas(null)
  if (outputFlag !== undefined) {
    // What the CLI left in the file the argv names (exec -o: the final message); absent → no frame.
    const file = resolve(cwd, argvValueOf(args, outputFlag))
    if (existsSync(file)) {
      recorded.push({
        t: now(),
        dir: 'file',
        argvPath: outputFlag,
        content: redactArg(readFileSync(file, 'utf8'), true),
      })
    }
  }
  // Codex and ACP: a $kill stopped a CLI that was still running; the replay holds there until its host kills it too.
  if (hostFrames && killedTree) recorded.push({ t: now(), dir: 'hold' })
  recorded.push({
    t: now(),
    dir: 'exit',
    code: exit.code,
    signal: exit.signal,
    ...(timedOut ? { timedOut: true } : {}),
    ...(killedTree ? { killed: 'tree' } : {}),
  })

  mkdirSync(outDir, { recursive: true })
  const target = join(outDir, 'recording.jsonl')
  const text = [header, ...recorded].map((x) => JSON.stringify(x)).join('\n') + '\n'
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, target)

  const summary = {
    recording: target,
    frames: {
      in: recorded.filter((f) => f.dir === 'in').length,
      out: recorded.filter((f) => f.dir === 'out').length,
      err: recorded.filter((f) => f.dir === 'err').length,
    },
    exit: { code: exit.code, signal: exit.signal },
    timedOut,
    ...(killedTree ? { killed: 'tree' } : {}),
    redactions: counts,
    // What the profile named (counts only: the values never leave memory).
    ...(profileVendor
      ? {
          profile: {
            literals: profile.literals.length,
            names: profile.names.length,
            ...(claudeVendor
              ? { learnedNames: claudeLearned.size, builtinCommands: claudeBuiltins.size }
              : {}),
            unreadConfigStatements: profile.skipped,
            gitName: gitName !== undefined,
          },
        }
      : {}),
    ...(failure ? { failure } : {}),
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (failure) process.stderr.write(`record-fixture: ${failure}\n`)
  return timedOut ? 3 : 0
}

try {
  if (!existsSync(join(ROOT, 'src', 'shared', 'redact.ts'))) throw new Error('src/shared/redact.ts not found')
  process.exitCode = await main()
} catch (err) {
  process.stderr.write(`record-fixture: ${err instanceof Error ? err.message : String(err)}\n`)
  if (err instanceof UsageError) process.stderr.write('Run with --help for usage.\n')
  process.exitCode = 2
}
