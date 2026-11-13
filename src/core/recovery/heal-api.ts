// Self-heal seam (the internal/heal.md template; state machine row P17): what the executors
// hand the healer and what they keep of its answer. The healer itself (heal/healer.ts: prompt, spawn, parse, denylist,
// cache) sits behind `HealApi`, which app-core wires to `runHealer`; tests pass a fake.
//
// Defence in depth around the healer:
//  - its tail is stderr plus status/control frames only (stdin, assistant, tool and stream frames are dropped, a frame
//    keeps only its status fields, a string over 300 characters is cut, and everything is redacted for `heal`), so the
//    task, plan, diff and file bodies never reach it (the healer filters again with buildHealInput);
//  - its suggestions are checked again here: config patches against the config_patch allowlist and the vendor's own
//    extraArgs / flagMap rules (with a preview against the run's config), shell commands with the parser's own checks
//    (heal/shell-check.ts: the shell denylist and the command families a heal may suggest), settings links to Dim Factory's
//    own pages; any other kind, or anything that fails, is dropped and counted in `hidden`;
//  - a failed heal offers the vendor's docs.
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { HealView, RecoveryAction } from '../../shared/failure.ts'
import { redactLine } from '../../shared/redact.ts'
import type { StepKey } from '../../shared/run.ts'
import { DimFactoryError } from '../errors.ts'
import type { HealOutcome, HealRequest } from '../heal/healer.ts'
import { shellCommandProblem } from '../heal/shell-check.ts'
import { checkRecoveryOps, patchPreview, patchResolved } from './config-patch.ts'
import type { VendorArgsCheck } from './config-patch.ts'
import { docsLink } from './docs.ts'
import { settingsHref } from './routes.ts'

/** The contract between the executors and the healer (heal/healer.ts owns it). */
export type { HealOutcome, HealRequest }

/** HEAL_API: the healer as the executors call it. */
export interface HealApi {
  diagnose(req: HealRequest): Promise<HealOutcome>
  /**
   * The healer's own evidence filter over a spawn's raw log (heal/heal-input.ts readHealTail); absent: the
   * conservative {@link healTail} here.
   */
  tail?(rawLogFile: string): Promise<string[]>
}

// ---- the tail ---------------------------------------------------------------------------------------------------

/** "Last 40 lines" (the internal/heal.md template). */
export const HEAL_TAIL_LINES = 40
/** Strings over 300 characters are truncated. */
export const HEAL_STRING_MAX = 300

/** Frames that carry content (the model's words, tool inputs and results, streamed deltas): never in the tail. */
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'assistant',
  'user',
  'stream_event',
  'tool_progress',
  'tool_use',
  'tool_result',
  'text',
  'item',
  'delta',
  'agent_message',
  'reasoning',
])

/** The status fields a kept frame may show (anything else is dropped). */
const KEEP_KEYS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'is_error',
  'duration_ms',
  'num_turns',
  'stop_reason',
  'errors',
  'error',
  'api_error_status',
  'error_status',
  'status',
  'code',
  'message',
  'method',
  'attempt',
  'retry_delay_ms',
  'model',
  'permissionMode',
  'claude_code_version',
  'apiKeySource',
  'rate_limit_info',
  'rateLimitType',
  'resetsAt',
  'response',
  'request',
  'willRetry',
])

const cut = (s: string): string => (s.length > HEAL_STRING_MAX ? `${s.slice(0, HEAL_STRING_MAX)}…` : s)

/** A frame's status fields only (depth-limited); strings cut at 300 characters. */
function project(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return cut(v)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  if (depth > 2) return undefined
  if (Array.isArray(v)) {
    const items = v.slice(0, 5).map((x) => project(x, depth + 1))
    return items.filter((x) => x !== undefined)
  }
  if (typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o['type'] === 'string' && CONTENT_TYPES.has(o['type'])) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) {
    if (!KEEP_KEYS.has(k)) continue
    // A message that is an object is a conversation turn (content), never a status.
    if (k === 'message' && typeof x !== 'string') continue
    const p = project(x, depth + 1)
    if (p !== undefined) out[k] = p
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** One stdout line as the healer may see it: a status/control frame projected, or null (content, or not a frame). */
export function statusFrame(line: string): string | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const type = typeof o['type'] === 'string' ? o['type'] : undefined
  if (type !== undefined && CONTENT_TYPES.has(type)) return null
  // A permission request carries the tool's input (file contents, commands): only its kind is kept.
  if (type === 'control_request') {
    const req = o['request']
    const subtype =
      typeof req === 'object' && req !== null ? (req as Record<string, unknown>)['subtype'] : undefined
    return JSON.stringify({ type, request: { subtype: typeof subtype === 'string' ? cut(subtype) : null } })
  }
  // JSON-RPC: errors and method names only (params carry items and deltas).
  if (type === undefined && ('jsonrpc' in o || 'method' in o || 'id' in o)) {
    const out: Record<string, unknown> = {}
    if (typeof o['method'] === 'string') out['method'] = cut(o['method'])
    if (o['error'] !== undefined) out['error'] = project(o['error'], 1)
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null
  }
  const p = project(o, 0)
  return p === undefined ? null : JSON.stringify(p)
}

/** A raw-log entry (runs/<id>/raw/<step>-<n>.ndjson): `in` = what Dim Factory wrote to the CLI (the prompt). */
export interface RawLine {
  dir: 'in' | 'out' | 'err'
  line: string
}

/**
 * The healer's evidence from a spawn's raw log: stderr lines and stdout status/control frames, never stdin; each
 * redacted for `heal` and at most 300 characters; the last {@link HEAL_TAIL_LINES}.
 */
export function healTail(lines: readonly RawLine[], o: { home?: string } = {}): string[] {
  const out: string[] = []
  for (const l of lines) {
    let text: string | null = null
    if (l.dir === 'err') text = l.line.replace(/\r?\n$/, '')
    else if (l.dir === 'out') text = statusFrame(l.line)
    if (text === null || text.trim() === '') continue
    const red = redactLine(text, { mode: 'heal', ...(o.home !== undefined ? { home: o.home } : {}) }).text
    out.push(cut(red))
  }
  return out.slice(-HEAL_TAIL_LINES)
}

/** Parse a raw log file's text (`{t, dir, line}` per line); unreadable lines are skipped. */
export function parseRawLog(text: string): RawLine[] {
  const out: RawLine[] = []
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue
    try {
      const v = JSON.parse(l) as { dir?: unknown; line?: unknown }
      if ((v.dir === 'in' || v.dir === 'out' || v.dir === 'err') && typeof v.line === 'string') {
        out.push({ dir: v.dir, line: v.line })
      }
    } catch {
      // a torn last line
    }
  }
  return out
}

// ---- the outcome ------------------------------------------------------------------------------------------------

export interface SanitizeOptions {
  /** The failed step (ids are namespaced to it). */
  step: StepKey | 'probe'
  /**
   * Outside a run: what makes this diagnosis's ids unique (`probe:<nonce>-<n>`). The run-less actions are stored with
   * their check until its report is replaced, so a second diagnosis must never reuse the first one's ids.
   */
  nonce?: string
  /** The run's config (the config patch previews); absent outside a run. */
  config?: ResolvedConfig
  managedFlags?: Readonly<Record<string, readonly string[]>>
  /** The vendor adapter's own extraArgs / flagMap rules (config-patch.ts guardResolved). */
  vendorArgs?: VendorArgsCheck
}

/** One healer suggestion, checked again; null when Dim Factory will not offer it. */
function safeAction(a: RecoveryAction, o: SanitizeOptions): RecoveryAction | null {
  switch (a.kind) {
    case 'config_patch': {
      try {
        const ops = checkRecoveryOps(a.ops, {
          target: a.target,
          managedFlags: o.managedFlags,
          vendorArgs: o.vendorArgs,
        })
        // Against the run's config: it must apply, parse, and leave everything protected as it is.
        if (o.config !== undefined) {
          patchResolved(o.config, ops, { managedFlags: o.managedFlags, vendorArgs: o.vendorArgs })
        }
        return { ...a, ops, preview: patchPreview(ops, o.config) }
      } catch (err) {
        if (err instanceof DimFactoryError) return null
        throw err
      }
    }
    case 'shell_copy':
      // The same checks the healer's parser applied (heal/shell-check.ts): the denylist and the command families.
      return shellCommandProblem(a.command) === undefined ? a : null
    case 'settings_link':
      try {
        settingsHref(a.route, a.pointer)
        return a
      } catch {
        return null
      }
    case 'retry':
    case 'resume':
    case 'vendor_setup':
    case 'switch_vendor':
    case 'grant':
    case 'wait_until':
    case 'skip_pass':
    case 'close_run':
    case 'open_docs':
    case 'heal':
      // The healer suggests config, settings and shell fixes only (the internal/heal.md template).
      return null
  }
}

/**
 * The healer's outcome as the step keeps it (StepView.heal): every suggestion checked again (unsafe ones counted in
 * `hidden`), ids made unique to the step, and a failed heal offering the vendor's docs.
 */
export function healViewOf(
  outcome: HealOutcome,
  trigger: 'auto' | 'user',
  o: SanitizeOptions & { vendor?: string },
): HealView {
  const actions: RecoveryAction[] = []
  let hidden = Math.max(0, Math.floor(outcome.hidden))
  const base = o.nonce !== undefined ? `${o.step}:${o.nonce}` : `${o.step}:heal`
  outcome.actions.forEach((a, n) => {
    const safe = safeAction(a, o)
    if (safe === null) {
      hidden++
      return
    }
    const id = `${base}-${n + 1}`
    // In a run, a fix the healer would also keep for later runs (a renamed flag: `persist`) is offered twice, as the
    // snag shows a config fix: to this run only, and applied and saved ("Apply and save to user").
    if (safe.kind === 'config_patch' && safe.persist !== undefined && o.config !== undefined) {
      const { persist: _saved, ...runOnly } = safe
      actions.push({ ...runOnly, target: 'resolved', id }, { ...safe, target: 'resolved', id: `${id}-save` })
      return
    }
    actions.push({ ...safe, id })
  })
  if (outcome.status === 'failed' && actions.length === 0) {
    const url = docsLink(o.vendor, 'install')
    if (url !== null) {
      actions.push({ id: `${base}-docs`, label: 'Open the setup guide', kind: 'open_docs', url })
    }
  }
  const view: HealView = { status: outcome.status, trigger, at: outcome.at, actions, hidden }
  if (outcome.diagnosis !== undefined && outcome.diagnosis.trim() !== '') {
    view.diagnosis = outcome.diagnosis.trim().slice(0, HEAL_STRING_MAX)
  }
  if (outcome.confidence !== undefined) view.confidence = outcome.confidence
  if (outcome.category !== undefined) view.category = outcome.category
  if (outcome.error !== undefined && outcome.error !== '') view.error = outcome.error.slice(0, 2000)
  return view
}

/** A HealView for a heal that could not run at all (no healer in this core, or it threw). */
export function failedHeal(
  trigger: 'auto' | 'user',
  at: number,
  error: string,
  vendor?: string,
  step: StepKey | 'probe' = 'probe',
): HealView {
  return healViewOf({ status: 'failed', actions: [], hidden: 0, error, at }, trigger, {
    step,
    ...(vendor !== undefined ? { vendor } : {}),
  })
}
