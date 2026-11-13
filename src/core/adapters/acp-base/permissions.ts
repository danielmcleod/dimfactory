// ACP permission requests (permissions and the decision table): what a
// `session/request_permission` asks for in Dim Factory's words (ask kind, detail, allow-cache query) and the plan exit a
// native Plan pass captures. The option each decision selects is protocol.ts permissionReply (the decision table).
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { AllowRule, AskKind } from '../../../shared/events.ts'
import { relativeInside } from '../../real-path.ts'
import type { AllowQuery } from '../allow-cache.ts'
import { exactRuleFor } from '../allow-cache.ts'
import type { AcpShellRequest } from './config.ts'
import { askKindOf as protocolAskKind } from './protocol.ts'
import type { Rec } from './wire.ts'
import { arr, contentText, rec, str } from './wire.ts'

/** A vendor's reader of its `execute` requests (AcpVendorConfig.shellRequest). */
export type ShellReader = (toolCall: Rec) => AcpShellRequest

export const DETAIL_MAX = 2000
const SUMMARY_MAX = 200
/** A plan file read for a plan exit is capped (a plan is a few KB; anything larger is not one). */
export const PLAN_FILE_MAX_BYTES = 1024 * 1024

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** ACP ToolKind → the ask kind every ACP vendor shares (edit/delete/move → edit, execute → shell, fetch → network). */
export function askKindOf(kind: string | undefined): AskKind {
  return protocolAskKind(kind)
}

/**
 * The tool name Dim Factory reports for an ACP ToolKind. Mutating kinds share the names the engine's plan-end guard
 * knows (`edit`, `shell`: supervisor isWriteTool), so a Plan pass that edits is noticed whatever the vendor calls it.
 */
export function toolNameOf(kind: string | undefined): string {
  const k = kind ?? ''
  switch (k) {
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'execute':
      return 'shell'
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
      return k
    case 'switch_mode':
      return 'mode'
    default:
      return 'tool'
  }
}

/** A path as the ask shows it: relative inside the pass folder, as given elsewhere. */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path
  // As written, else by real paths: Gemini (Node) resolves against its getcwd(), which on macOS reads /private/var
  // for the /var folder the host gave it.
  const rel = relativeInside(cwd, path)
  return rel !== null && rel !== '' ? rel.split('\\').join('/') : path
}

/** The paths a tool call names (`locations[].path`, diff paths), in order, distinct. */
export function toolPaths(toolCall: Rec | undefined): string[] {
  const out: string[] = []
  const add = (p: string | undefined): void => {
    if (p !== undefined && p !== '' && !out.includes(p)) out.push(p)
  }
  for (const l of arr(toolCall?.['locations'])) add(str(rec(l)?.['path']))
  for (const c of arr(toolCall?.['content'])) {
    const r = rec(c)
    if (str(r?.['type']) === 'diff') add(str(r?.['path']))
  }
  return out
}

/** The folder keys a shell request's rawInput may name (a command that runs elsewhere is never cached here). */
const DIR_KEYS = ['dir_path', 'directory', 'cwd', 'workdir'] as const

/** `rawInput.command` (a string, or an argv joined by spaces), when the request names it. */
function rawCommandOf(toolCall: Rec | undefined): string | undefined {
  const raw = rec(toolCall?.['rawInput'])
  const c = raw?.['command']
  if (typeof c === 'string' && c.trim() !== '') return c
  if (Array.isArray(c) && c.every((x) => typeof x === 'string') && c.length > 0) return c.join(' ')
  return undefined
}

/**
 * What a shell request runs and where, as the ACP base reads it without a vendor rule: `rawInput.command` and the
 * folder keys of rawInput (none: the session's folder; two that disagree: unknown). Free text (the title, a content
 * block) is never read as the command (Gemini's text content is its explanation, not the command).
 */
export function rawShellRequest(toolCall: Rec | undefined): AcpShellRequest {
  const raw = rec(toolCall?.['rawInput'])
  const dirs = new Set<string>()
  for (const k of DIR_KEYS) {
    const d = str(raw?.[k])
    if (d !== undefined && d !== '' && d !== '.') dirs.add(d)
  }
  return {
    command: rawCommandOf(toolCall),
    dir: dirs.size === 0 ? '' : dirs.size === 1 ? [...dirs][0] : undefined,
  }
}

const isExecute = (toolCall: Rec | undefined): boolean => str(toolCall?.['kind']) === 'execute'

/** A shell request read the vendor's way (its `shellRequest`), else from rawInput. */
export function shellRequestOf(toolCall: Rec | undefined, shell?: ShellReader): AcpShellRequest {
  if (shell !== undefined && toolCall !== undefined && isExecute(toolCall)) return shell(toolCall)
  return rawShellRequest(toolCall)
}

/** The shell command of a tool call, when the vendor names it with certainty (rawInput, or the vendor's rule). */
export function commandOf(toolCall: Rec | undefined, shell?: ShellReader): string | undefined {
  return shellRequestOf(toolCall, shell).command
}

/**
 * Where a request runs, for the allow cache: a folder as named (absolute, or relative to the pass folder), `''` for
 * the session's own folder, undefined when Dim Factory cannot tell (then nothing is matched or cached for it).
 */
export function placeOf(toolCall: Rec | undefined, shell?: ShellReader): string | undefined {
  return shellRequestOf(toolCall, shell).dir
}

const urlOf = (toolCall: Rec | undefined): string | undefined => {
  const raw = rec(toolCall?.['rawInput'])
  const u = str(raw?.['url']) ?? str(arr(raw?.['urls'])[0])
  return u !== undefined && /^https?:\/\//i.test(u) ? u : undefined
}

/** One line for a tool event: the vendor's title, else a path, else the command. */
export function toolSummary(toolCall: Rec | undefined, cwd: string, shell?: ShellReader): string {
  const title = str(toolCall?.['title'])?.trim()
  if (title !== undefined && title !== '') return clip(title.split(/\r?\n/)[0] ?? title, SUMMARY_MAX)
  const path = toolPaths(toolCall)[0]
  if (path !== undefined) return clip(displayPath(path, cwd), SUMMARY_MAX)
  const cmd = commandOf(toolCall, shell)
  if (cmd !== undefined) return clip(cmd, SUMMARY_MAX)
  return toolNameOf(str(toolCall?.['kind']))
}

/** A tool row's name is a label, not a sentence: longer names are clipped. */
const ROW_NAME_MAX = 48

/**
 * An MCP tool call's server and tool, when the call says so: Gemini titles them `<tool> (<server> MCP Server)` (ACP has
 * no server field), and an agent that uses Claude-style tool names sends `mcp__<server>__<tool>` as the tool name.
 */
export function mcpToolOf(toolCall: Rec | undefined): { server: string; tool: string } | undefined {
  const title = str(toolCall?.['title'])?.trim() ?? ''
  const t = /^(\S+) \((.+) MCP Server\)$/.exec(title)
  if (t?.[1] !== undefined && t[2] !== undefined && t[2].trim() !== '')
    return { server: t[2].trim(), tool: t[1] }
  const name = str(toolCall?.['name'])?.trim() ?? ''
  const n = /^mcp__([^_].*?)__(.+)$/.exec(name)
  if (n?.[1] !== undefined && n[2] !== undefined) return { server: n[1], tool: n[2] }
  return undefined
}

/** The first short string argument of rawInput (what an MCP or other tool was asked for), on one line. */
function firstArgOf(toolCall: Rec | undefined): string | undefined {
  const raw = rec(toolCall?.['rawInput'])
  for (const v of Object.values(raw ?? {})) {
    const s = typeof v === 'string' ? v.trim().split(/\r?\n/)[0]?.trim() : undefined
    if (s !== undefined && s !== '') return s
  }
  return undefined
}

const oneLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.trim() ?? ''

/**
 * A tool row as the run view shows it: a name and a short summary. A kind Dim Factory knows (read, edit, shell, …)
 * names the row by its kind, so the plan-end guard sees edits and commands whatever the vendor calls them. Any other
 * tool (kind `other`, or none) is named for what it is: an MCP tool as `mcp:<server>/<tool>`, a mode switch as `mode`,
 * else the call's tool name, else its title; `tool` only when the call names nothing.
 */
export function toolRowOf(
  toolCall: Rec | undefined,
  cwd: string,
  shell?: ShellReader,
  exitTitle?: RegExp,
): { name: string; summary: string } {
  const kindName = toolNameOf(str(toolCall?.['kind']))
  const summary = toolSummary(toolCall, cwd, shell)
  if (kindName !== 'tool') return { name: kindName, summary }
  if (isModeSwitch(toolCall, exitTitle)) return { name: 'mode', summary }
  const mcp = mcpToolOf(toolCall)
  if (mcp !== undefined) {
    const name = clip(`mcp:${mcp.server}/${mcp.tool}`, ROW_NAME_MAX)
    const arg = firstArgOf(toolCall) ?? toolPaths(toolCall).map((p) => displayPath(p, cwd))[0]
    return { name, summary: arg !== undefined ? clip(arg, SUMMARY_MAX) : '' }
  }
  const own = oneLine(str(toolCall?.['name']) ?? '')
  if (own !== '') return { name: clip(own, ROW_NAME_MAX), summary: summary === own ? '' : summary }
  const title = oneLine(str(toolCall?.['title']) ?? '')
  if (title !== '') {
    // The title names the row; the summary adds what it does not already say (a path or the command).
    const path = toolPaths(toolCall).map((p) => displayPath(p, cwd))[0]
    const detail = path ?? commandOf(toolCall, shell) ?? firstArgOf(toolCall)
    return {
      name: clip(title, ROW_NAME_MAX),
      summary: detail !== undefined && !title.includes(detail) ? clip(oneLine(detail), SUMMARY_MAX) : '',
    }
  }
  return { name: kindName, summary }
}

/**
 * What the ask shows: the title, then the command (when the title is not it), the vendor's note on a shell request
 * (Gemini's explanation: where it runs and why), the paths and the URL the request names.
 */
export function askDetail(toolCall: Rec | undefined, cwd: string, shell?: ShellReader): string {
  const lines: string[] = []
  const title = str(toolCall?.['title'])?.trim()
  if (title !== undefined && title !== '') lines.push(title)
  const req = shellRequestOf(toolCall, shell)
  const cmd = req.command
  if (cmd !== undefined && cmd.trim() !== title) lines.push(`$ ${cmd}`)
  const note = req.note?.trim()
  if (note !== undefined && note !== '' && note !== title) lines.push(note)
  const paths = toolPaths(toolCall).map((p) => displayPath(p, cwd))
  if (paths.length > 0 && !(paths.length === 1 && title?.includes(paths[0]!) === true)) lines.push(...paths)
  const url = urlOf(toolCall)
  if (url !== undefined && title?.includes(url) !== true) lines.push(url)
  if (lines.length === 0) lines.push(`${toolNameOf(str(toolCall?.['kind']))} request`)
  return clip(lines.join('\n'), DETAIL_MAX)
}

/**
 * The tool identity an allow rule is keyed on: the kind's name (`shell`, `edit`, …) for the kinds Dim Factory reads
 * criteria from; for any other tool (an MCP tool, kind `other`), the tool itself (its name, else its title), so a
 * rule for one such tool never covers another.
 */
export function allowToolOf(toolCall: Rec | undefined): string {
  const kind = str(toolCall?.['kind'])
  const name = toolNameOf(kind)
  if (askKindOf(kind) !== 'other') return name
  const id = str(toolCall?.['name'])?.trim() || str(toolCall?.['title'])?.trim()
  return id !== undefined && id !== '' ? `${name}:${id}` : name
}

/**
 * What the request asks for, in allow-cache terms (an exact argv, the exact paths, or the exact URL). A command is
 * read only when the request names it with certainty and on one line (a line break separates commands, which an argv
 * split on spaces would hide).
 */
export function allowQueryOf(vendor: string, toolCall: Rec | undefined, shell?: ShellReader): AllowQuery {
  const kind = str(toolCall?.['kind'])
  const q: AllowQuery = { vendor, kind: askKindOf(kind), tool: allowToolOf(toolCall) }
  const cmd = kind === 'execute' ? commandOf(toolCall, shell) : undefined
  if (cmd !== undefined && !/[\r\n\0]/.test(cmd)) {
    q.argv = cmd
      .trim()
      .split(/\s+/)
      .filter((t) => t !== '')
  }
  const paths = toolPaths(toolCall)
  if (paths.length === 1) q.path = paths[0]!
  else if (paths.length > 1) q.paths = paths
  const url = urlOf(toolCall)
  if (url !== undefined) q.url = url
  return q
}

/**
 * The rule "Allow for this run" adds for a request: the exact argv, path or URL it names. A tool Dim Factory reads no
 * criteria from (an MCP tool) gets a rule for that tool alone only when `sessionScoped`: the user chose the vendor's
 * own session-wide option for it (e.g. Gemini "Always allow tool X"), whose scope the rule takes, never wider. undefined:
 * nothing to key on, never cached.
 */
export function allowRuleOf(
  vendor: string,
  toolCall: Rec | undefined,
  sessionScoped = false,
  shell?: ShellReader,
): AllowRule | undefined {
  const q = allowQueryOf(vendor, toolCall, shell)
  // A shell request whose command Dim Factory cannot read with certainty is never cached.
  if (q.kind === 'shell' && q.argv === undefined) return undefined
  const exact = exactRuleFor(q)
  if (exact !== undefined) return exact
  if (!sessionScoped || q.kind !== 'other' || q.tool === toolNameOf(str(toolCall?.['kind']))) return undefined
  return { vendor, kind: q.kind, tool: q.tool, match: {}, source: 'vendor-suggestion' }
}

// ---- mode switches and the plan exit --------------------------------------------------------------------------

/** The tool name of a plan-mode switch (`exit_plan_mode`, `enter_plan_mode`), or a title that starts with it. */
const PLAN_EXIT_NAME = /^exit_?plan_?mode$/i
const PLAN_ENTER_NAME = /^enter_?plan_?mode$/i
const PLAN_EXIT_TITLE = /^\s*exit[ _]plan[ _]mode\b/i
const PLAN_ENTER_TITLE = /^\s*enter[ _]plan[ _]mode\b/i

/**
 * Kinds a mode switch can carry besides `switch_mode` (a vendor that does not use ACP's own kind for it). A tool of
 * any other kind (a shell command, an edit, a fetch) is never read as a mode switch, whatever its title says: a
 * command whose text mentions "exit plan mode" is asked about (or rejected) as the command it is.
 */
const NEUTRAL_KINDS: ReadonlySet<string> = new Set(['', 'other', 'think'])

const named = (toolCall: Rec | undefined, name: RegExp, title: RegExp): boolean =>
  name.test(str(toolCall?.['name'])?.trim() ?? '') || title.test(str(toolCall?.['title']) ?? '')

/** The plan file a vendor's title-only plan exit names (`exitTitle` group 1), when the title is one. */
export function planExitFileOf(toolCall: Rec | undefined, exitTitle: RegExp | undefined): string | undefined {
  if (exitTitle === undefined) return undefined
  const kind = str(toolCall?.['kind']) ?? ''
  if (kind !== 'switch_mode' && !NEUTRAL_KINDS.has(kind)) return undefined
  const m = exitTitle.exec(str(toolCall?.['title'])?.trim() ?? '')
  const file = m?.[1]?.trim()
  return file !== undefined && file !== '' ? file : undefined
}

const titledExit = (toolCall: Rec | undefined, exitTitle: RegExp | undefined): boolean =>
  exitTitle !== undefined && exitTitle.test(str(toolCall?.['title'])?.trim() ?? '')

/**
 * A request to change the session's mode: `switch_mode` kind, or a tool of no other kind named for entering or
 * leaving plan mode, or titled as the vendor's own plan exit (`exitTitle`: Gemini's exit_plan_mode arrives as kind
 * `other`, titled `Requesting plan approval for: <plan file>`). Dim Factory never lets the agent change its
 * own mode (an approved plan exit could widen what the pass may do: Gemini's headless flow switches to YOLO after an
 * approved exit).
 */
export function isModeSwitch(toolCall: Rec | undefined, exitTitle?: RegExp): boolean {
  const kind = str(toolCall?.['kind']) ?? ''
  if (kind === 'switch_mode') return true
  if (!NEUTRAL_KINDS.has(kind)) return false
  return (
    named(toolCall, PLAN_EXIT_NAME, PLAN_EXIT_TITLE) ||
    named(toolCall, PLAN_ENTER_NAME, PLAN_ENTER_TITLE) ||
    titledExit(toolCall, exitTitle)
  )
}

/** A request to leave plan mode (Gemini `exit_plan_mode`): it carries the plan, or names its file. */
export function isPlanExit(toolCall: Rec | undefined, exitTitle?: RegExp): boolean {
  if (!isModeSwitch(toolCall, exitTitle)) return false
  if (named(toolCall, PLAN_EXIT_NAME, PLAN_EXIT_TITLE) || titledExit(toolCall, exitTitle)) return true
  return str(toolCall?.['kind']) === 'switch_mode' && !named(toolCall, PLAN_ENTER_NAME, PLAN_ENTER_TITLE)
}

const PLAN_KEYS = ['plan', 'plan_content', 'planContent', 'markdown'] as const
const PLAN_PATH_KEYS = ['plan_path', 'planPath', 'plan_file', 'planFile', 'path', 'file_path'] as const

/** Whether `file` (after symlinks) is inside one of `roots`. */
function insideRoots(file: string, roots: readonly string[]): boolean {
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return false
  }
  return roots.some((root) => {
    let r: string
    try {
      r = realpathSync(root)
    } catch {
      return false
    }
    const rel = relative(r, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/**
 * A plan file the vendor wrote (Gemini plan mode: `~/.gemini/tmp/<project>/<session>/plans/*.md`), read only when it
 * is a Markdown file of plausible size inside one of `roots` (the vendor's own temp folder). Never anything else.
 */
export function readPlanFile(path: string, roots: readonly string[]): string | undefined {
  if (roots.length === 0 || !/\.md$/i.test(path) || !isAbsolute(path)) return undefined
  if (!insideRoots(path, roots)) return undefined
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > PLAN_FILE_MAX_BYTES) return undefined
    const text = readFileSync(path, 'utf8')
    return text.trim() !== '' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * The plan a plan-exit request carries, first that applies: a text content block, a diff's new text, a plan field of
 * `rawInput`, then the plan file it names (its title's file for a vendor's title-only exit, a path field of rawInput,
 * its locations), read only inside `planRoots`.
 */
export function planTextOf(
  toolCall: Rec | undefined,
  planRoots: readonly string[],
  exitTitle?: RegExp,
): string | undefined {
  for (const c of arr(toolCall?.['content'])) {
    const r = rec(c)
    const type = str(r?.['type'])
    const text =
      type === 'content' ? contentText(r?.['content']) : type === 'diff' ? str(r?.['newText']) : undefined
    if (text !== undefined && text.trim() !== '') return text
  }
  const raw = rec(toolCall?.['rawInput'])
  for (const k of PLAN_KEYS) {
    const v = str(raw?.[k])
    if (v !== undefined && v.trim() !== '') return v
  }
  const paths = [
    planExitFileOf(toolCall, exitTitle),
    ...PLAN_PATH_KEYS.map((k) => str(raw?.[k])),
    ...toolPaths(toolCall),
  ].filter((p): p is string => p !== undefined && p !== '')
  for (const p of paths) {
    const text = readPlanFile(p, planRoots)
    if (text !== undefined) return text
  }
  return undefined
}
