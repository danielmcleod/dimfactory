// Settings → Profiles view helpers (built-in profiles, how a profile's passes resolve, semantic rules; a list with a
// scope chip; built-ins read-only, Duplicate to edit; duplicate / rename / delete with undo; Set as default for user
// or project; PassRowsEditor). Pure functions over what config.read gave for the user
// file and a project file: which profiles exist and where, what each pass of a profile says, why an action is not
// available, and the config.patch ops of each action. Core validates and writes; nothing here resolves a run's config.
import type { FixConfig, PassConfig, ProfileConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ExtensionLevel } from '@shared/extensions.ts'
import { defaultExtensionLevel } from '@shared/extensions.ts'
import type { Mode, PassName } from '@shared/run.ts'
import { pointer } from '../general/configWrite.ts'
import { BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES, PASS_BASE, isBuiltinProfile } from './builtins.ts'

export type ProfileScope = 'builtin' | 'user' | 'project'

export const SCOPE_LABEL: Readonly<Record<ProfileScope, string>> = {
  builtin: 'Built-in',
  user: 'Yours',
  project: 'Project',
}

/** ProfileNameZ. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
export const PROFILE_NAME_MAX = 32

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `profiles` of a parsed config file (an object per name; anything else is left out). */
export function profilesOf(file: unknown): Record<string, ProfileConfig> {
  const out: Record<string, ProfileConfig> = {}
  const profiles = isObj(file) ? file['profiles'] : undefined
  if (!isObj(profiles)) return out
  for (const [name, def] of Object.entries(profiles)) if (isObj(def)) out[name] = def
  return out
}

/** The file's own `profile` (its default), or null. */
export function fileDefault(file: unknown): string | null {
  const p = isObj(file) ? file['profile'] : undefined
  return typeof p === 'string' ? p : null
}

function merge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a
  if (!isObj(a) || !isObj(b)) return structuredClone(b)
  const out: Obj = { ...a }
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = merge(out[k], v)
  return out
}

export interface ProfileEntry {
  name: string
  /** Where the profile is defined first (a built-in name a file also sets stays built-in). */
  scope: ProfileScope
  /** The profile as the layers merge it (built-in, then your file, then the project's): what Duplicate copies. */
  definition: ProfileConfig
  /** The definition in its own file (user or project scope): what Rename moves and the editor writes to. */
  own: ProfileConfig | null
}

/**
 * Every profile, built-ins first, then your file's, then the project's (the resolver's own order), each with
 * its scope and definition. `project` is null when no project is chosen.
 */
export function profileEntries(user: unknown, project: unknown): ProfileEntry[] {
  const mine = profilesOf(user)
  const theirs = project === null ? {} : profilesOf(project)
  const names: string[] = [...BUILTIN_PROFILE_NAMES]
  for (const n of [...Object.keys(mine), ...Object.keys(theirs)]) if (!names.includes(n)) names.push(n)
  return names.map((name) => {
    const scope: ProfileScope = isBuiltinProfile(name) ? 'builtin' : name in mine ? 'user' : 'project'
    const base = isBuiltinProfile(name) ? BUILTIN_PROFILES[name] : {}
    const definition = merge(merge(base, mine[name]), theirs[name]) as ProfileConfig
    const own = scope === 'user' ? (mine[name] ?? null) : scope === 'project' ? (theirs[name] ?? null) : null
    return { name, scope, definition, own }
  })
}

// ---- passes ---------------------------------------------------------------------------------------------------------

export interface PassView {
  /** undefined: the profile names no vendor for this pass. */
  vendor: string | undefined
  model: string | null
  /** null: the vendor's default effort. */
  effort: string | null
  /** The pass's Extensions level (the base value when the profile sets none). */
  extensions: ExtensionLevel
  mode: Mode
  enabled: boolean
  /** Fix only. */
  inherit?: 'implement' | null
  reuseSession?: boolean
  /** Fix only: vendor, model and mode are Implement's (inherit on and none of them set for Fix itself). */
  sameAsImplement?: boolean
}

/** A pass of a profile as it reads with the base values filled in (profile then pass base, and Fix's inherit; one profile). */
export function passView(def: ProfileConfig, pass: PassName): PassView {
  const raw: PassConfig & FixConfig = { ...PASS_BASE[pass], ...(def[pass] ?? {}) }
  const view: PassView = {
    vendor: raw.vendor,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    extensions: raw.extensions ?? defaultExtensionLevel(pass),
    mode: raw.mode ?? 'readonly',
    enabled: raw.enabled ?? true,
  }
  if (pass !== 'fix') return view
  const own = def.fix ?? {}
  const inherit = raw.inherit ?? null
  const impl = passView(def, 'implement')
  const explicit = own.vendor !== undefined || own.model !== undefined || own.mode !== undefined
  // Implement's model (and its effort, which goes with it) while Fix runs on Implement's vendor.
  const sameVendor = (own.vendor ?? impl.vendor) === impl.vendor
  return {
    ...view,
    inherit,
    reuseSession: raw.reuseSession ?? true,
    sameAsImplement: inherit === 'implement' && !explicit,
    ...(inherit === 'implement'
      ? {
          vendor: own.vendor ?? impl.vendor,
          model: own.model !== undefined ? own.model : sameVendor ? impl.model : null,
          effort:
            own.effort !== undefined
              ? own.effort
              : sameVendor && own.model === undefined
                ? impl.effort
                : null,
          mode: own.mode ?? impl.mode,
          extensions: own.extensions ?? impl.extensions,
        }
      : {}),
  }
}

/** Plan, Review and Critic always run read-only; a file never holds "full" (only Auto produces it). */
export const READ_ONLY: ReadonlySet<PassName> = new Set<PassName>(['plan', 'review', 'critic'])

export function fileModes(pass: PassName): Mode[] {
  return READ_ONLY.has(pass) ? ['readonly'] : ['readonly', 'autoedit']
}

// ---- names ----------------------------------------------------------------------------------------------------------

/** Why a new profile name cannot be used, or null. */
export function nameError(name: string, existing: readonly string[], current?: string): string | null {
  if (name === '') return 'Enter a name.'
  if (!PROFILE_NAME.test(name))
    return 'Use lowercase letters, digits and dashes (at most 32), starting with a letter or a digit.'
  if (name !== current && existing.includes(name)) return `A profile called ${name} already exists.`
  return null
}

/** `<base>-copy`, `<base>-copy-2`, … : a free valid name of at most 32 characters. */
export function copyName(base: string, existing: readonly string[]): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`
    const name = `${base.slice(0, PROFILE_NAME_MAX - suffix.length)}${suffix}`
    if (!existing.includes(name)) return name
  }
}

// ---- ops ------------------------------------------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v)

export function profilePointer(name: string, ...rest: string[]): string {
  return pointer('profiles', name, ...rest)
}

export function duplicateOps(name: string, definition: ProfileConfig): JsonPatchOp[] {
  return [{ op: 'add', path: profilePointer(name), value: clone(definition) }]
}

/** Move the profile to its new name; the file's own default follows it. */
export function renameOps(
  from: string,
  to: string,
  own: ProfileConfig,
  fileDefaultName: string | null,
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [
    { op: 'add', path: profilePointer(to), value: clone(own) },
    { op: 'remove', path: profilePointer(from) },
  ]
  if (fileDefaultName === from) ops.push({ op: 'replace', path: '/profile', value: to })
  return ops
}

export function deleteOps(name: string): JsonPatchOp[] {
  return [{ op: 'remove', path: profilePointer(name) }]
}

export function defaultOps(name: string): JsonPatchOp[] {
  return [{ op: 'replace', path: '/profile', value: name }]
}

export type PassField = 'model' | 'effort' | 'extensions' | 'mode' | 'enabled' | 'reuseSession'

export function fieldOps(name: string, pass: PassName, field: PassField, value: unknown): JsonPatchOp[] {
  return [{ op: 'replace', path: profilePointer(name, pass, field), value }]
}

/** A new vendor clears the model and the effort level (another vendor's would not run). */
export function vendorOps(name: string, pass: PassName, vendor: string): JsonPatchOp[] {
  return [
    { op: 'replace', path: profilePointer(name, pass, 'vendor'), value: vendor },
    { op: 'replace', path: profilePointer(name, pass, 'model'), value: null },
    { op: 'replace', path: profilePointer(name, pass, 'effort'), value: null },
  ]
}

/**
 * Fix's "same as Implement" (`fix.inherit` copies vendor, model and mode unless Fix sets them). On:
 * Fix's own vendor, model and mode go, so Implement's apply. Off: Fix keeps what it ran with, now as its own values.
 */
export function inheritOps(name: string, on: boolean, current: PassView): JsonPatchOp[] {
  if (on) {
    return [
      { op: 'replace', path: profilePointer(name, 'fix', 'inherit'), value: 'implement' },
      { op: 'remove', path: profilePointer(name, 'fix', 'vendor') },
      { op: 'remove', path: profilePointer(name, 'fix', 'model') },
      { op: 'remove', path: profilePointer(name, 'fix', 'effort') },
      { op: 'remove', path: profilePointer(name, 'fix', 'mode') },
      { op: 'remove', path: profilePointer(name, 'fix', 'extensions') },
    ]
  }
  const ops: JsonPatchOp[] = [{ op: 'replace', path: profilePointer(name, 'fix', 'inherit'), value: null }]
  if (current.vendor !== undefined)
    ops.push({ op: 'replace', path: profilePointer(name, 'fix', 'vendor'), value: current.vendor })
  ops.push(
    { op: 'replace', path: profilePointer(name, 'fix', 'model'), value: current.model },
    { op: 'replace', path: profilePointer(name, 'fix', 'effort'), value: current.effort },
    { op: 'replace', path: profilePointer(name, 'fix', 'mode'), value: current.mode },
    { op: 'replace', path: profilePointer(name, 'fix', 'extensions'), value: current.extensions },
  )
  return ops
}

// ---- what can be done -------------------------------------------------------------------------------------------------

export interface ProfileFacts {
  entry: ProfileEntry
  /** Your default as core resolves it (no folder). */
  userDefault: string | null
  /** The `profile` your file sets, if any. */
  userFileDefault: string | null
  /** The `profile` the chosen project's file sets, if any. */
  projectDefault: string | null
  folder: string | null
}

export const CHOOSE_PROJECT = 'Choose a project first.'

export function renameBlocked(f: ProfileFacts): string | null {
  if (f.entry.scope === 'builtin')
    return 'Built-in profiles cannot be renamed: duplicate it to make your own.'
  if (f.entry.own === null) return 'This profile is not in a file Dim Factory can edit.'
  return null
}

export function deleteBlocked(f: ProfileFacts): string | null {
  if (f.entry.scope === 'builtin') return 'Built-in profiles cannot be deleted.'
  if (f.entry.own === null) return 'This profile is not in a file Dim Factory can edit.'
  if (f.entry.scope === 'user' && f.userFileDefault === f.entry.name)
    return 'It is your default profile: make another one your default first.'
  if (f.entry.scope === 'project' && f.projectDefault === f.entry.name)
    return "It is this project's default profile: make another one its default first."
  return null
}

export function userDefaultBlocked(f: ProfileFacts): string | null {
  if (f.entry.scope === 'project')
    return 'A profile of one project cannot be your default: other folders do not have it.'
  if (f.userDefault === f.entry.name) return 'It is your default profile already.'
  return null
}

export function projectDefaultBlocked(f: ProfileFacts): string | null {
  if (f.folder === null) return CHOOSE_PROJECT
  if (f.entry.scope === 'user')
    return 'Teammates do not have your own profiles: duplicate it into the project first.'
  if (f.projectDefault === f.entry.name) return "It is this project's default profile already."
  return null
}

export function projectDuplicateBlocked(folder: string | null): string | null {
  return folder === null ? CHOOSE_PROJECT : null
}
