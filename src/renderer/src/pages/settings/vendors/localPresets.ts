// Local model presets in Settings → Vendors (`local.presets` {id, label, baseUrl, model, apiKeyEnv?, contextWindow?},
// user-only; add, a `/models` dropdown, a context warning, Test). Pure helpers: reading the presets from the user file, checking a draft the way the config schema will (and
// stricter for the address: a local model lives on this computer, so only a loopback host), the patch ops, and words.
import type { JsonPatchOp } from '@shared/failure.ts'
import type { LocalPreset } from '@shared/vendors.ts'

/** config-schema.ts LocalPresetZ `id` (tests keep them equal). */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/
/** config-schema.ts EnvNameZ and FORBIDDEN_ENV_PATTERN (tests keep them equal). */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const FORBIDDEN_ENV = /^(PATH|NODE_OPTIONS|ELECTRON_\w*)$/i
/** config-schema.ts `isAllowedPresetUrl`'s shape (scheme, host, optional port, then anything). */
const URL_SHAPE = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/?#:@\s[\]]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i
/** config-schema.ts LOOPBACK_HOST. */
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

export const MAX_PRESETS = 20
export const MAX_LABEL = 60
export const MAX_MODEL = 128
export const MAX_URL = 2048
export const MAX_CONTEXT = 100_000_000
/** Warn below 32k tokens of context. */
export const CONTEXT_WARN_TOKENS = 32_768

export const POINTER = '/local/presets'
export const URL_EXAMPLE = 'http://localhost:11434/v1'

/**
 * A loopback host as core reads it (`isLoopbackHost`): localhost, 127.x.x.x or [::1]. Not a name under .localhost:
 * Windows asks DNS for those, so one could lead off this computer.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host)
}

/** Why a base URL cannot be used, or null: the schema's shape, and (stricter) a server on this computer only. */
export function presetUrlProblem(url: string): string | null {
  const u = url.trim()
  if (u === '') return `Enter the server's address, for example ${URL_EXAMPLE}`
  if (u.length > MAX_URL) return `Use at most ${MAX_URL} characters`
  const m = URL_SHAPE.exec(u)
  if (m === null) return `Enter an address that starts with http:// or https://, for example ${URL_EXAMPLE}`
  if (!isLoopbackHost(m[2] ?? ''))
    return 'Use a server on this computer: localhost, 127.0.0.1 or [::1]. Dim Factory sends nothing elsewhere.'
  return null
}

/** Why an API key variable name cannot be used, or null ('' is fine: no key). */
export function envNameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return null
  if (!ENV_NAME_PATTERN.test(n)) return 'Use letters, digits and _ only, not starting with a digit'
  if (FORBIDDEN_ENV.test(n)) return 'Dim Factory manages this variable; choose another name'
  return null
}

/** `qwen` from "Qwen 2.5 Coder" (lowercase, dashes, at most 24), unique among `taken` with `-2`, `-3`… */
export function slugId(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'local'
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const id = `${base.slice(0, 24 - suffix.length).replace(/-+$/g, '')}${suffix}`
    if (!taken.has(id)) return id
  }
  return base
}

/** What the form holds (every field as typed). */
export interface PresetDraft {
  label: string
  id: string
  baseUrl: string
  model: string
  apiKeyEnv: string
  contextWindow: string
}

export type DraftField = keyof PresetDraft
export type DraftErrors = Partial<Record<DraftField, string>>

export function draftOf(p: LocalPreset): PresetDraft {
  return {
    label: p.label,
    id: p.id,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeyEnv: p.apiKeyEnv ?? '',
    contextWindow: p.contextWindow !== undefined ? String(p.contextWindow) : '',
  }
}

export const EMPTY_DRAFT: PresetDraft = {
  label: '',
  id: '',
  baseUrl: '',
  model: '',
  apiKeyEnv: '',
  contextWindow: '',
}

/** A context window as typed: undefined for an empty box, NaN for something that is not a whole number. */
export function parseContext(text: string): number | undefined {
  const t = text.trim().replace(/[,_\s]/g, '')
  if (t === '') return undefined
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

/**
 * The draft as a preset the config accepts, or the problem with each field. `others` are the other presets' ids (the
 * id must be unique; an existing preset keeps its id, since passes and settings name it as `local-<id>`).
 */
export function validateDraft(
  d: PresetDraft,
  others: ReadonlySet<string>,
): { ok: true; preset: LocalPreset } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {}
  const label = d.label.trim()
  if (label === '') errors.label = 'Give it a name'
  else if (label.length > MAX_LABEL) errors.label = `Use at most ${MAX_LABEL} characters`
  const id = d.id.trim()
  if (!PRESET_ID_PATTERN.test(id))
    errors.id = 'Use lowercase letters, digits and dashes (at most 24), starting with a letter or digit'
  else if (others.has(id)) errors.id = `Another local model already uses "${id}"`
  const url = presetUrlProblem(d.baseUrl)
  if (url !== null) errors.baseUrl = url
  const model = d.model.trim()
  if (model === '') errors.model = 'Enter the model the server should run'
  else if (model.length > MAX_MODEL) errors.model = `Use at most ${MAX_MODEL} characters`
  const env = envNameProblem(d.apiKeyEnv)
  if (env !== null) errors.apiKeyEnv = env
  const context = parseContext(d.contextWindow)
  if (context !== undefined && (!Number.isInteger(context) || context < 1 || context > MAX_CONTEXT))
    errors.contextWindow = 'Enter a whole number of tokens, or leave it empty'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const apiKeyEnv = d.apiKeyEnv.trim()
  return {
    ok: true,
    preset: {
      id,
      label,
      baseUrl: d.baseUrl.trim(),
      model,
      ...(apiKeyEnv !== '' ? { apiKeyEnv } : {}),
      ...(context !== undefined ? { contextWindow: context } : {}),
    },
  }
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** `local.presets` of the user file's parsed value (entries that are not presets are left out). */
export function presetsOf(value: unknown): LocalPreset[] {
  const list = rec(rec(value)?.['local'])?.['presets']
  if (!Array.isArray(list)) return []
  return list.flatMap((raw: unknown): LocalPreset[] => {
    const p = rec(raw)
    if (p === null) return []
    const { id, label, baseUrl, model, apiKeyEnv, contextWindow } = p
    if (typeof id !== 'string' || typeof label !== 'string' || typeof baseUrl !== 'string') return []
    if (typeof model !== 'string') return []
    return [
      {
        id,
        label,
        baseUrl,
        model,
        ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}),
        ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      },
    ]
  })
}

/** Whether the user file has settings for this preset's vendor (`vendors.local-<id>`), which go with it. */
export function hasVendorSettings(value: unknown, id: string): boolean {
  return rec(rec(value)?.['vendors'])?.[`local-${id}`] !== undefined
}

/** One write of the whole list (and, when a preset goes, its `vendors.local-<id>` settings, which name it). */
export function presetsOps(next: readonly LocalPreset[], removeVendorOf?: string): JsonPatchOp[] {
  return [
    { op: 'replace', path: POINTER, value: next },
    ...(removeVendorOf !== undefined
      ? [{ op: 'remove' as const, path: `/vendors/local-${removeVendorOf}` }]
      : []),
  ]
}

/** `32k`, `128k`, `8,192`. */
export function tokensText(n: number): string {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : n.toLocaleString('en-US')
}

/** Below 32k tokens the plan and diffs may not fit; null at or above. */
export function contextWarning(tokens: number | undefined): string | null {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens >= CONTEXT_WARN_TOKENS) return null
  return `Its context window (${tokens.toLocaleString('en-US')} tokens) is under 32k: a plan or a diff may not fit.`
}

/** The vendor id passes use for a preset. */
export function presetVendor(id: string): string {
  return `local-${id}`
}
