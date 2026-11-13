// Shared CLI option parsing: `--home`, run policies (`--gates`, `--cards`, `--asks`, `--auto`), and `--set k=v` on
// any run-override path (RunOverridesZ).
import { z } from 'zod'
import type { RunOverrides } from '../shared/config-schema.ts'
import { RunOverridesZ, validateSemantics } from '../shared/config-schema.ts'
import { isPassName } from '../shared/run.ts'
import { validKeysAt } from '../core/config/load.ts'
import { suggestName } from '../core/prompts/template.ts'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type GatePolicy = 'approve' | 'ask' | 'stop'
export type CardPolicy = 'default' | 'stop' | 'ask'
export type AskPolicy = 'ask' | 'allow' | 'deny'

export interface RunPolicy {
  gates: GatePolicy
  cards: CardPolicy
  asks: AskPolicy
  /** `asks` came from the `--asks` flag (not the TTY / non-TTY default). */
  asksFromFlag?: boolean
  /** `--plan-file <f|->`: the approved plan replaces the generated one at the plan gate. */
  planFile?: string
  tty: boolean
}

function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of ${allowed.join('|')} (got "${value}")`)
  }
  return value as T
}

/** TTY: cards, gates and asks are prompted. Non-TTY defaults: gates and cards stop the run, asks are denied. */
export function runPolicy(
  v: {
    gates?: string | undefined
    cards?: string | undefined
    asks?: string | undefined
    'plan-file'?: string | undefined
  },
  tty: boolean,
): RunPolicy {
  const p: RunPolicy = {
    gates: oneOf('--gates', v.gates, ['approve', 'ask', 'stop'] as const) ?? (tty ? 'ask' : 'stop'),
    cards: oneOf('--cards', v.cards, ['default', 'stop'] as const) ?? (tty ? 'ask' : 'stop'),
    asks: oneOf('--asks', v.asks, ['ask', 'allow', 'deny'] as const) ?? (tty ? 'ask' : 'deny'),
    tty,
  }
  if (v['plan-file'] !== undefined) p.planFile = v['plan-file']
  if (v.asks !== undefined) p.asksFromFlag = true
  return p
}

// ---- --set ------------------------------------------------------------------------------------------------------

/** The run settings `--set` accepts: the top-level keys of RunOverridesZ. */
export const RUN_SETTING_KEYS: readonly string[] = Object.keys(RunOverridesZ.shape)

/** The schema at `segs` inside RunOverridesZ (optional/nullable unwrapped), or undefined off the schema. */
function schemaAt(segs: readonly string[]): z.ZodType | undefined {
  let cur: z.ZodType | undefined = RunOverridesZ
  for (const seg of segs) {
    const u = unwrap(cur)
    if (u instanceof z.ZodObject) cur = (u.shape as Record<string, z.ZodType | undefined>)[seg]
    else if (u instanceof z.ZodRecord) cur = u.valueType as z.ZodType
    else return undefined
    if (cur === undefined) return undefined
  }
  return unwrap(cur)
}

function unwrap(s: z.ZodType | undefined): z.ZodType | undefined {
  let cur = s
  for (let i = 0; i < 16 && cur !== undefined; i++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodExactOptional || cur instanceof z.ZodNullable) {
      cur = cur.unwrap() as z.ZodType
    } else break
  }
  return cur
}

/** `{a: {b: value}}` for `['a', 'b']`. */
function nest(segs: readonly string[], value: unknown): Record<string, unknown> {
  let out: unknown = value
  for (let i = segs.length - 1; i >= 0; i--) out = { [segs[i] as string]: out }
  return out as Record<string, unknown>
}

function mergeInto(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k]
    if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof cur === 'object' &&
      cur !== null &&
      !Array.isArray(cur)
    ) {
      mergeInto(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else target[k] = v
  }
}

/** Value readings to try, in order: JSON (true, 3, null, ["a"]), the text itself, a comma-separated list. */
function valueCandidates(text: string): unknown[] {
  const out: unknown[] = []
  try {
    out.push(JSON.parse(text) as unknown)
  } catch {
    // not JSON: a plain string
  }
  out.push(text)
  if (text.includes(',')) {
    out.push(
      text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    )
  }
  return out
}

/**
 * `--set` entries → run overrides. A key is any RunOverridesZ path: `profile`, `auto`, `passes.<pass>.<key>` (or
 * `<pass>.<key>` for short), `gates.*`, `planning.native`, `isolation.*`, `verify.*`. Values are read as JSON when
 * they parse (true, 300000, null, ["a","b"]), else as text (or a comma-separated list where a list is expected);
 * `<pass>.model=default` (or empty) is null: the CLI's own default model. Settings outside a run (timeouts, vendors,
 * …) belong in dimfactory.json and are a usage error here.
 */
export function parseSets(sets: readonly string[]): RunOverrides {
  const out: Record<string, unknown> = {}
  for (const raw of sets) {
    const eq = raw.indexOf('=')
    if (eq <= 0) throw new UsageError(`--set expects key=value (got "${raw}")`)
    const key = raw.slice(0, eq).trim()
    const text = raw.slice(eq + 1).trim()
    const segs = key.split('.').map((s) => s.trim())
    if (segs.some((s) => s === '')) throw new UsageError(`--set ${key}: empty key segment`)
    if (isPassName(segs[0])) segs.unshift('passes')
    // Every key on the way must exist (with a "did you mean" for typos).
    for (let i = 0; i < segs.length; i++) {
      const valid = validKeysAt(segs.slice(0, i), RunOverridesZ)
      const seg = segs[i] as string
      if (valid.length === 0 || valid.includes(seg)) continue
      if (i === 0) {
        throw new UsageError(
          `--set ${key}: "${seg}" is not a run setting (run settings: ${RUN_SETTING_KEYS.join(', ')}; ` +
            `<pass>.<key> is short for passes.<pass>.<key>). Set it in dimfactory.json instead.`,
        )
      }
      const hint = suggestName(seg, valid)
      throw new UsageError(
        `--set ${key}: unknown key "${seg}"${hint !== undefined ? ` (did you mean "${hint}"?)` : ''}. ` +
          `Keys here: ${valid.join(', ')}`,
      )
    }
    const leaf = schemaAt(segs)
    const isModel = segs[0] === 'passes' && segs.length === 3 && segs[2] === 'model'
    const candidates = isModel && (text === 'default' || text === '') ? [null] : valueCandidates(text)
    const accepted = candidates.find((v) => RunOverridesZ.safeParse(nest(segs, v)).success)
    if (accepted === undefined) {
      if (leaf instanceof z.ZodBoolean)
        throw new UsageError(`--set ${key} takes true or false (got "${text}")`)
      const r = RunOverridesZ.safeParse(nest(segs, candidates[0]))
      const why = r.success ? 'invalid value' : (r.error.issues[0]?.message ?? 'invalid value')
      throw new UsageError(`--set ${key}=${text}: ${why}`)
    }
    if (segs[0] === 'passes' && segs[2] === 'mode' && accepted === 'full') {
      throw new UsageError(`--set ${key}=full: "full" is only set by Auto mode; use --auto instead`)
    }
    mergeInto(out, nest(segs, accepted))
  }
  const overrides = RunOverridesZ.parse(out)
  const semantic = validateSemantics(overrides, { scope: 'user' })[0]
  if (semantic !== undefined) {
    const where = semantic.pointer.slice(1).replace(/\//g, '.')
    throw new UsageError(`--set ${where}: ${semantic.message}`)
  }
  return overrides
}

export const POLICY_OPTIONS = {
  gates: { type: 'string' },
  cards: { type: 'string' },
  asks: { type: 'string' },
  'plan-file': { type: 'string' },
  json: { type: 'boolean', default: false },
  home: { type: 'string' },
} as const
