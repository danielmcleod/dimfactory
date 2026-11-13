// Storage schema version policy: every non-config JSON file carries schemaVersion:1, and a
// newer version opens read-only. Older versions are upgraded in memory and
// written back only when next modified; unknown fields are preserved.
import { DimFactoryError } from '../errors.ts'
import { readJsonFile, writeJsonAtomic } from './atomic.ts'
import type { AtomicWriteOptions } from './atomic.ts'

export const CURRENT_SCHEMA_VERSION = 1

export interface VersionInfo {
  /** The file's schemaVersion (absent ⇒ 1). */
  version: number
  /** True when the file was written by a newer Dim Factory: show it, never save it. */
  readOnly: boolean
}

/** Upgrader from version `n` to `n + 1`, keyed by `n`. */
export type Upgraders = Readonly<Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>>

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Read the `schemaVersion` of a parsed document. A missing field means 1; a non-integer is corrupt. */
export function schemaVersionOf(doc: unknown): number | null {
  if (!isPlainObject(doc)) return null
  const v = doc['schemaVersion']
  if (v === undefined) return 1
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null
}

export function versionInfo(doc: unknown, current: number = CURRENT_SCHEMA_VERSION): VersionInfo | null {
  const version = schemaVersionOf(doc)
  return version === null ? null : { version, readOnly: version > current }
}

/**
 * Bring an older document up to `current` in memory. A newer document is returned unchanged (read-only).
 * Throws STORAGE when a needed upgrader is missing.
 */
export function upgradeDoc(
  doc: Record<string, unknown>,
  upgraders: Upgraders = {},
  current: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  let version = schemaVersionOf(doc) ?? 1
  let out = doc
  while (version < current) {
    const up = upgraders[version]
    if (up === undefined) {
      throw new DimFactoryError('STORAGE', `no upgrader from schemaVersion ${version} to ${version + 1}`)
    }
    version++
    out = withSchemaVersion(up(out), version)
  }
  return out
}

/** Throw NEWER_SCHEMA when `info` says the file must not be written. */
export function assertWritable(info: VersionInfo, what: string): void {
  if (info.readOnly) {
    throw new DimFactoryError(
      'NEWER_SCHEMA',
      `${what} was created by a newer Dim Factory (schemaVersion ${info.version}); it is read-only here`,
      { details: { version: info.version, current: CURRENT_SCHEMA_VERSION } },
    )
  }
}

export type VersionedRead<T> =
  | { kind: 'missing' }
  | { kind: 'corrupt'; error: string }
  | { kind: 'ok'; value: T; version: number; readOnly: boolean }

export interface VersionedReadOptions<T> {
  current?: number
  upgraders?: Upgraders
  /** Validate/narrow the (upgraded) object; throw or return null to mark the file corrupt. */
  validate?: (doc: Record<string, unknown>) => T | null
}

/** Read a versioned JSON file: missing / corrupt / ok (upgraded in memory, or read-only when newer). */
export async function readVersionedJson<T = Record<string, unknown>>(
  file: string,
  opts: VersionedReadOptions<T> = {},
): Promise<VersionedRead<T>> {
  const current = opts.current ?? CURRENT_SCHEMA_VERSION
  const r = await readJsonFile(file)
  if (r.kind === 'missing') return r
  if (r.kind === 'corrupt') return { kind: 'corrupt', error: r.error }
  const info = versionInfo(r.value, current)
  if (info === null || !isPlainObject(r.value)) {
    return { kind: 'corrupt', error: 'not an object with a valid schemaVersion' }
  }
  const doc = info.readOnly ? r.value : upgradeDoc(r.value, opts.upgraders, current)
  let value: T | null
  try {
    value = opts.validate ? opts.validate(doc) : (doc as T)
  } catch (err) {
    return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) }
  }
  if (value === null) return { kind: 'corrupt', error: 'validation failed' }
  return { kind: 'ok', value, version: info.version, readOnly: info.readOnly }
}

/**
 * Write a versioned JSON file atomically with `schemaVersion: current`. Refuses (NEWER_SCHEMA) when the file on
 * disk is newer, unless the caller already checked (`knownWritable`).
 */
export async function writeVersionedJson(
  file: string,
  value: object,
  opts: AtomicWriteOptions & { current?: number; knownWritable?: boolean } = {},
): Promise<void> {
  const current = opts.current ?? CURRENT_SCHEMA_VERSION
  if (opts.knownWritable !== true) {
    const r = await readJsonFile(file)
    if (r.kind === 'ok') {
      const info = versionInfo(r.value, current)
      if (info !== null) assertWritable(info, file)
    }
  }
  await writeJsonAtomic(file, withSchemaVersion(value, current), opts)
}

/** `{schemaVersion: current, ...value}` with schemaVersion first and forced to `current`. */
export function withSchemaVersion(
  value: object,
  current: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete rest['schemaVersion']
  return { schemaVersion: current, ...rest }
}
