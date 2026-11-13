// "Suggest choices": one cheap, read-only model call that proposes values for the Brief's open groups. It runs the
// way the self-healer runs its vendor (the read-only `heal` route: Claude's read-only tool cut with Bash, PowerShell,
// WebFetch and WebSearch disallowed and no session persistence, Codex read-only and ephemeral) in a Dim Factory-owned
// folder under DIM_FACTORY_HOME, never the user's folder. The answer is one JSON block, validated against the pack:
// anything it cannot use is dropped, and the rest is shown pre-ticked but editable.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { BRIEF_OTHER_MAX, fieldIsSet } from '../../shared/brief.ts'
import type {
  BriefFact,
  BriefInput,
  BriefSuggestion,
  BriefSuggestResult,
  BriefSuggestTarget,
  Pack,
  PackGroup,
} from '../../shared/brief.ts'
import type { RedactOptions } from '../../shared/redact.ts'
import { HEAL_VENDORS } from '../../shared/vendors.ts'
import type { AdapterRegistry } from '../adapters/registry.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions } from '../adapters/types.ts'
import { DimFactoryError } from '../errors.ts'
import { cleanHealText, healRedactOptions } from '../heal/heal-input.ts'
import { healerFlagMap } from '../heal/healer.ts'
import { healCopy } from '../heal/parse-heal.ts'
import { homePaths } from '../home.ts'
import { realPath } from '../real-path.ts'
import { normalizeText, render } from '../prompts/template.ts'

/** One suggestion call gets 90 s. */
export const SUGGEST_TIMEOUT_MS = 90_000
/** About how many tokens one call takes (the cost hint). */
export const SUGGEST_TOKENS = 4000
/** A suggestion's reason, as one line of UI copy. */
export const SUGGEST_REASON_MAX = 200
export const SUGGEST_NO_VENDOR_MESSAGE = 'Suggest choices needs Claude or Codex signed in.'
export const SUGGEST_INVALID_JSON = 'The answer was not valid JSON.'
export const SUGGEST_WRONG_SHAPE = 'The answer did not match the expected shape.'

/** After the answer (or a stop), how long the process may take to exit before it is stopped again. */
const EXIT_GRACE_MS = 10_000
/** A read-only call never asks; anything that still does is denied. */
const ASK_TIMEOUT_MS = 30_000
const ERROR_MAX = 2000
const EXCERPT_MAX = 600

export interface SuggestLog {
  info: (m: string, d?: Record<string, unknown>) => void
  warn: (m: string, d?: Record<string, unknown>) => void
}

export interface SuggestDeps {
  /** DIM_FACTORY_HOME: the call runs in `tmp/brief-suggest/<id>/`. */
  home: string
  registry: Pick<AdapterRegistry, 'get' | 'isBuilt' | 'list'>
  /** Is the vendor ready to answer (default: its adapter's probe is ok). */
  isReady?: (vendor: string) => Promise<boolean>
  /** `vendors.<id>.flagMap`, without renames of the flags that keep the call read-only (healerFlagMap). */
  flagMap?: (vendor: string) => Readonly<Record<string, string>> | undefined
  timeoutMs?: number
  now?: () => number
  /** The prompt template text (default: internal/brief-suggest.md). */
  template?: string
  log?: SuggestLog
}

export interface SuggestRequest {
  task: string
  pack: Pack
  brief: BriefInput
  facts: readonly BriefFact[]
  /** The Plan pass's vendor and model as resolved for the folder. */
  vendor: string
  model: string | null
}

// ---- template ------------------------------------------------------------------------------------------------------

/**
 * Where internal/brief-suggest.md is read from: next to the sources (src/core/prompts/internal/), or, in the bundled
 * app whose core is out/main/index.js, `out/main/internal/` (the build copies it there).
 */
export const SUGGEST_TEMPLATE_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL('../prompts/internal/brief-suggest.md', import.meta.url)),
  fileURLToPath(new URL('./internal/brief-suggest.md', import.meta.url)),
]

let templateMemo: string | undefined

/** The suggest template (internal/brief-suggest.md, normalized). Throws when no copy is found. */
export function readSuggestTemplate(candidates: readonly string[] = SUGGEST_TEMPLATE_CANDIDATES): string {
  if (candidates === SUGGEST_TEMPLATE_CANDIDATES && templateMemo !== undefined) return templateMemo
  for (const path of candidates) {
    try {
      const text = normalizeText(readFileSync(path, 'utf8'))
      if (candidates === SUGGEST_TEMPLATE_CANDIDATES) templateMemo = text
      return text
    } catch {
      // try the next location
    }
  }
  throw new Error(`The suggest prompt template is missing (looked in ${candidates.join(', ')})`)
}

// ---- prompt values -------------------------------------------------------------------------------------------------

/** The task block's own delimiters; a task carrying them could close the block early. */
const TASK_DELIMITER = /<<<\s*TASK|TASK\s*>>>/gi

/** The answer schema as the prompt shows it. */
const ANSWER_SCHEMA_TEXT = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'choices', 'reason'],
        properties: {
          group: { type: 'string', description: 'a group id' },
          choices: { type: 'array', items: { type: 'string', description: 'an option id of that group' } },
          other: {
            type: 'string',
            maxLength: BRIEF_OTHER_MAX,
            description: 'only where other text is allowed',
          },
          reason: { type: 'string', maxLength: SUGGEST_REASON_MAX, description: 'one line' },
        },
      },
    },
  },
})

function groupLine(g: PackGroup): string {
  const kind = `${g.multi ? 'several' : 'one'}${g.other ? ', other text allowed' : ''}`
  return `- ${g.id} (${kind}): ${g.options.map((o) => `${o.id} = ${o.label}`).join('; ')}`
}

const orNone = (lines: string[]): string => (lines.length > 0 ? lines.join('\n') : '(none)')

/** The suggest template's values: the task, the pack's groups, the locked facts and the choices already made. */
export function suggestValues(o: {
  task: string
  pack: Pack
  brief: BriefInput
  facts: readonly BriefFact[]
}): Record<string, string> {
  const choices: string[] = []
  for (const [group, field] of Object.entries(o.brief.fields)) {
    if (!fieldIsSet(field)) continue
    const parts: string[] = []
    if (field.choices.length > 0) parts.push(field.choices.join(', '))
    const other = field.other?.trim()
    if (other !== undefined && other !== '') parts.push(`other: ${healCopy(other, BRIEF_OTHER_MAX)}`)
    choices.push(`- ${group}: ${parts.join('; ')}`)
  }
  return {
    task: o.task.replace(TASK_DELIMITER, '[delimiter removed]'),
    category: `${o.pack.label} (${o.pack.id})`,
    groups: o.pack.groups.map(groupLine).join('\n'),
    facts: orNone(o.facts.map((f) => `- ${f.group}: ${f.label} (${f.evidence})`)),
    choices: orNone(choices),
    jsonSchema: ANSWER_SCHEMA_TEXT,
  }
}

// ---- the answer ----------------------------------------------------------------------------------------------------

const AnswerZ = z.strictObject({
  suggestions: z
    .array(
      z.strictObject({
        group: z.string(),
        choices: z.array(z.string()).max(50),
        other: z.string().nullable().optional(),
        reason: z.string(),
      }),
    )
    .max(50),
})

export type ParseSuggestResult =
  { ok: true; suggestions: BriefSuggestion[]; dropped: number } | { ok: false; error: string }

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g

/** The JSON text of the answer: its first ```json fenced block, else the one object the text holds. */
function answerJson(text: string): string | null {
  const src = text.replace(/\r\n?/g, '\n')
  const block = [...src.matchAll(FENCE)].find((m) => {
    const lang = (m[1] ?? '').toLowerCase()
    return lang === 'json' || lang === 'jsonc' || (lang === '' && /^\s*\{/.test(m[2] ?? ''))
  })
  if (block !== undefined) return block[2] ?? ''
  const start = src.indexOf('{')
  const end = src.lastIndexOf('}')
  return start !== -1 && end > start ? src.slice(start, end + 1) : null
}

/**
 * Parse and validate a "Suggest choices" answer against the pack. Unknown groups and options, a single-choice group
 * with several choices, Other text where the group allows none, an empty reason, a group a repository fact locks and
 * a group the user already set are all dropped (`dropped` counts each value left out). An answer that is not JSON,
 * or not the expected shape, is refused; no usable suggestion at all is still an answer (an empty list).
 */
export function parseSuggestAnswer(
  text: string,
  pack: Pack,
  o: { facts: readonly BriefFact[]; brief: BriefInput },
): ParseSuggestResult {
  const body = answerJson(text)
  if (body === null) return { ok: false, error: SUGGEST_INVALID_JSON }
  let json: unknown
  try {
    json = JSON.parse(body) as unknown
  } catch {
    return { ok: false, error: SUGGEST_INVALID_JSON }
  }
  const r = AnswerZ.safeParse(json)
  if (!r.success) return { ok: false, error: SUGGEST_WRONG_SHAPE }

  const locked = new Set(o.facts.map((f) => f.group))
  const seen = new Set<string>()
  const out: BriefSuggestion[] = []
  let dropped = 0
  for (const s of r.data.suggestions) {
    const group = pack.groups.find((g) => g.id === s.group)
    if (
      group === undefined ||
      seen.has(group.id) ||
      locked.has(group.id) ||
      fieldIsSet(o.brief.fields[group.id])
    ) {
      dropped++
      continue
    }
    const reason = healCopy(s.reason, SUGGEST_REASON_MAX)
    if (reason === '') {
      dropped++
      continue
    }
    const choices: string[] = []
    for (const id of s.choices) {
      if (!group.options.some((opt) => opt.id === id)) dropped++
      else if (!choices.includes(id)) choices.push(id)
    }
    if (!group.multi && choices.length > 1) {
      dropped++
      continue
    }
    let other: string | undefined
    const rawOther = s.other ?? undefined
    if (rawOther !== undefined && rawOther.trim() !== '') {
      if (group.other) other = healCopy(rawOther, BRIEF_OTHER_MAX)
      else dropped++
    }
    if (choices.length === 0 && other === undefined) continue
    seen.add(group.id)
    out.push({ group: group.id, choices, ...(other !== undefined ? { other } : {}), reason })
  }
  return { ok: true, suggestions: out, dropped }
}

// ---- vendor choice -------------------------------------------------------------------------------------------------

interface Choice {
  vendor: string
  adapter: Adapter
  model: string | null
}

async function choose(
  deps: SuggestDeps,
  vendor: string,
  model: string | null,
  o: { images?: boolean } = {},
): Promise<Choice | null> {
  const known = HEAL_VENDORS as readonly string[]
  const candidates = [...new Set([vendor, ...HEAL_VENDORS])].filter((v) => known.includes(v))
  for (const v of candidates) {
    if (!deps.registry.isBuilt(v)) continue
    const adapter = deps.registry.get(v)
    if (adapter === undefined) continue
    let ready: boolean
    try {
      ready = deps.isReady !== undefined ? await deps.isReady(v) : (await adapter.probe()).ok
    } catch {
      ready = false
    }
    if (!ready) continue
    // A call with a picture goes only to a vendor whose adapter sends pictures now (after its probe chose the route).
    if (o.images === true && adapter.acceptsImages?.() !== true) continue
    // The requested model is an id for the requested vendor only; a fallback vendor uses its default.
    return { vendor: v, adapter, model: v === vendor ? model : null }
  }
  return null
}

/**
 * The vendor that answers: the requested one when it has the read-only route (HEAL_VENDORS), is built and ready
 * (with its model), else the first ready of HEAL_VENDORS on its default model. null when none is ready.
 */
export async function chooseSuggester(
  deps: SuggestDeps,
  vendor: string,
  model: string | null,
  o: { images?: boolean } = {},
): Promise<{ vendor: string; model: string | null } | null> {
  const c = await choose(deps, vendor, model, o)
  return c === null ? null : { vendor: c.vendor, model: c.model }
}

// ---- one process ---------------------------------------------------------------------------------------------------

type Conversation =
  { kind: 'done'; text: string } | { kind: 'timeout'; error: string } | { kind: 'failed'; error: string }

function delay(ms: number): Promise<'late'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('late'), ms).unref()
  })
}

async function settleProcess(adapter: Adapter, handle: RunHandle): Promise<void> {
  const r = await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
  if (r !== 'late') return
  await adapter.stop(handle, 'user').catch(() => undefined)
  await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
}

function exitText(info: ExitInfo): string {
  return info.signal !== null ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`
}

async function converse(
  adapter: Adapter,
  opts: StartOptions,
  timeoutMs: number,
  redact: RedactOptions,
  label = 'Suggest choices',
): Promise<Conversation> {
  const handle = adapter.start(opts)
  let text = ''
  const result = await new Promise<Conversation>((resolve) => {
    let settled = false
    const finish = (r: Conversation): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({
        kind: 'timeout',
        error: `${label} took longer than ${Math.round(timeoutMs / 1000)} s, so Dim Factory stopped it.`,
      })
      void adapter.stop(handle, 'timeout').catch(() => undefined)
    }, timeoutMs)
    handle.onEvent((e) => {
      switch (e.type) {
        case 'text':
          text += e.delta
          return
        case 'done':
          finish({ kind: 'done', text: e.result.trim() !== '' ? e.result : text })
          return
        case 'error':
          if (e.fatal) {
            const raw = e.raw.trim() !== '' ? `\n${cleanHealText(e.raw, redact, ERROR_MAX)}` : ''
            finish({ kind: 'failed', error: `${cleanHealText(e.message, redact, 500)}${raw}` })
          }
          return
        case 'ask':
          // A read-only call never needs a permission; refuse anything that asks.
          adapter.answer(handle, e.requestId, 'deny')
          return
        case 'session':
        case 'tool':
          return
      }
    })
    void handle.exited.then((info) =>
      finish({
        kind: 'failed',
        error: `${adapter.displayName} ended without an answer (${exitText(info)}).`,
      }),
    )
  })
  await settleProcess(adapter, handle)
  return result
}

// ---- one read-only answer ------------------------------------------------------------------------------------------

/** What another one-off read-only call (Easy's "Help me choose", "Look it over") asks. */
export interface ReadOnlyAsk {
  /** The vendor and model to ask first (chooseSuggester's rule picks who answers). */
  vendor: string
  model: string | null
  prompt: string
  /** The call's folder under `<home>/tmp/` (one fresh folder per call, deleted after). */
  area: string
  /** Pictures sent with the prompt (copied into the call's folder first); only a vendor that takes them answers. */
  images?: readonly string[]
  /** The call's name in a timeout message ("Help me choose took longer than ..."). */
  label: string
  /** Why nobody can answer (UI copy), when no vendor is ready. */
  noVendor: string
  /**
   * A project folder the call reads ("Ask about it"), on the same read-only route: it runs there instead of a fresh
   * folder of its own, and nothing is copied into it or removed from it. Never with `images`.
   */
  folder?: string
  /** This call's own time limit (default: the deps', else SUGGEST_TIMEOUT_MS). */
  timeoutMs?: number
}

/**
 * One read-only, ephemeral call on the same route as "Suggest choices" (the healer's read-only route, in a Dim
 * Factory-owned folder unless `folder` names a project to read): the answer's text and who gave it. Throws a
 * DimFactoryError with UI copy when nobody can answer (UNSUPPORTED), the call times out (TIMEOUT) or the process fails
 * (SPAWN). Logs metadata only.
 */
export async function readOnlyAnswer(
  deps: SuggestDeps,
  ask: ReadOnlyAsk,
): Promise<{ vendor: string; model: string | null; text: string }> {
  const now = deps.now ?? Date.now
  const images = ask.images ?? []
  if (ask.folder !== undefined && images.length > 0) {
    throw new DimFactoryError('INTERNAL', 'A call that reads a project folder takes no pictures.')
  }
  const choice = await choose(deps, ask.vendor, ask.model, { images: images.length > 0 })
  if (choice === null) throw new DimFactoryError('UNSUPPORTED', ask.noVendor)
  const redact = healRedactOptions()
  const id = `${ask.area}-${randomBytes(4).toString('hex')}`
  const own = ask.folder === undefined
  // Dim Factory's own folder is spelled by its real name (not an 8.3 short name or a linked temp folder), the way a
  // run's folder is: the agent reports paths in its cwd's spelling, and they are compared with real names.
  const cwd = ask.folder ?? join(await realPath(homePaths(deps.home).tmpDir), ask.area, `${now()}-${id}`)
  const meta = { area: ask.area, vendor: choice.vendor, model: choice.model, images: images.length }
  try {
    if (own) await mkdir(cwd, { recursive: true })
    const pictures: string[] = []
    for (const [i, src] of images.entries()) {
      const to = join(cwd, `picture-${i + 1}${extname(src).toLowerCase() || '.png'}`)
      await copyFile(src, to)
      pictures.push(to)
    }
    const flagMap = healerFlagMap(deps.flagMap?.(choice.vendor))
    const opts: StartOptions = {
      runId: id,
      step: 'heal',
      cwd,
      prompt: ask.prompt,
      model: choice.model,
      mode: 'readonly',
      planNative: false,
      allowRules: [],
      trustFolder: false,
      ephemeral: true,
      askTimeoutMs: ASK_TIMEOUT_MS,
      ...(pictures.length > 0 ? { images: pictures } : {}),
      ...(flagMap !== undefined ? { flagMap } : {}),
    }
    deps.log?.info('read-only call started', meta)
    const timeoutMs = ask.timeoutMs ?? deps.timeoutMs ?? SUGGEST_TIMEOUT_MS
    const r = await converse(choice.adapter, opts, timeoutMs, redact, ask.label)
    if (r.kind !== 'done') {
      deps.log?.warn('read-only call failed', { ...meta, reason: r.kind })
      throw new DimFactoryError(r.kind === 'timeout' ? 'TIMEOUT' : 'SPAWN', r.error)
    }
    deps.log?.info('read-only call answered', meta)
    return { vendor: choice.vendor, model: choice.model, text: r.text }
  } finally {
    // Only the call's own folder goes; a project folder it read stays exactly as it was.
    if (own)
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
  }
}

/** The start of an answer, cleaned for an error message (redacted, one bounded excerpt). */
export function answerExcerpt(text: string): string {
  return cleanHealText(text, healRedactOptions(), EXCERPT_MAX)
}

// ---- suggestChoices ------------------------------------------------------------------------------------------------

/**
 * Ask the model for brief values. Throws a DimFactoryError with UI copy when no vendor is ready (UNSUPPORTED), the
 * prompt cannot be built (INTERNAL), the call times out (TIMEOUT), the process fails (SPAWN) or the answer is not
 * usable JSON (VALIDATION, with the start of the answer, redacted). Logs metadata only, never the task.
 */
export async function suggestChoices(deps: SuggestDeps, req: SuggestRequest): Promise<BriefSuggestResult> {
  const log = deps.log
  const now = deps.now ?? Date.now
  const choice = await choose(deps, req.vendor, req.model)
  if (choice === null) throw new DimFactoryError('UNSUPPORTED', SUGGEST_NO_VENDOR_MESSAGE)

  let prompt: string
  try {
    const values = suggestValues({ task: req.task, pack: req.pack, brief: req.brief, facts: req.facts })
    prompt = render(deps.template ?? readSuggestTemplate(), values, { template: 'suggest' }).text
  } catch (err) {
    throw new DimFactoryError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err })
  }

  const redact = healRedactOptions()
  const id = `suggest-${randomBytes(4).toString('hex')}`
  const cwd = join(await realPath(homePaths(deps.home).tmpDir), 'brief-suggest', `${now()}-${id}`)
  const meta = { category: req.pack.id, vendor: choice.vendor, model: choice.model }
  try {
    await mkdir(cwd, { recursive: true })
    const flagMap = healerFlagMap(deps.flagMap?.(choice.vendor))
    const opts: StartOptions = {
      runId: id,
      step: 'heal',
      cwd,
      prompt,
      model: choice.model,
      mode: 'readonly',
      planNative: false,
      allowRules: [],
      trustFolder: false,
      ephemeral: true,
      askTimeoutMs: ASK_TIMEOUT_MS,
      ...(flagMap !== undefined ? { flagMap } : {}),
    }
    log?.info('brief suggest started', { ...meta, groups: req.pack.groups.length })
    const r = await converse(choice.adapter, opts, deps.timeoutMs ?? SUGGEST_TIMEOUT_MS, redact)
    if (r.kind !== 'done') {
      log?.warn('brief suggest failed', { ...meta, reason: r.kind })
      throw new DimFactoryError(r.kind === 'timeout' ? 'TIMEOUT' : 'SPAWN', r.error)
    }
    const parsed = parseSuggestAnswer(r.text, req.pack, { facts: req.facts, brief: req.brief })
    if (!parsed.ok) {
      log?.warn('brief suggest failed', { ...meta, reason: 'answer' })
      const excerpt = cleanHealText(r.text, redact, EXCERPT_MAX)
      throw new DimFactoryError(
        'VALIDATION',
        `${parsed.error}${excerpt !== '' ? `\nThe answer began: ${excerpt}` : ''}`,
      )
    }
    log?.info('brief suggest answered', {
      ...meta,
      suggestions: parsed.suggestions.length,
      dropped: parsed.dropped,
    })
    return {
      category: req.pack.id,
      suggestions: parsed.suggestions,
      vendor: choice.vendor,
      model: choice.model,
    }
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
  }
}

// ---- cost hint -----------------------------------------------------------------------------------------------------

/** What one "Suggest choices" call would cost, or why it cannot run (UI copy). */
export function suggestTarget(o: {
  vendor: string | null
  model: string | null
  ready: boolean
  price?: (vendor: string, model: string | null, tokens: number) => number | null
}): BriefSuggestTarget {
  if (o.vendor === null || !o.ready) {
    return { vendor: null, model: null, tokens: SUGGEST_TOKENS, usd: null, reason: SUGGEST_NO_VENDOR_MESSAGE }
  }
  let usd: number | null
  try {
    usd = o.price?.(o.vendor, o.model, SUGGEST_TOKENS) ?? null
  } catch {
    usd = null
  }
  return { vendor: o.vendor, model: o.model, tokens: SUGGEST_TOKENS, usd }
}
