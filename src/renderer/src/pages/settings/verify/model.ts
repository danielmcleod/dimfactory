// Settings → Isolation & Verify: the verify command list (discovery, `verify.commands[]` and trust.json; the
// run.verify check). A run verifies with `verify.commands` (core's resolved list);
// discovery (verify.detect) offers the commands it found in the project, each with its trust state. This joins the two
// into one row per command, and builds the new `verify.commands` list for a change (one config.patch replaces the
// list, so the Undo toast puts the whole list back). Pure functions; core's answers are read defensively.
import type { VerifyCommandConfig } from '@shared/config-schema.ts'
import type { VerifyCommand, VerifyTrustState } from '@shared/verify.ts'
import { displayArgv, tokenizeCommand } from './argv.ts'

/** One command of the table. */
export interface VerifyRow {
  /** Stable while the list changes: the configured entry's name, or the detected command's id. */
  key: string
  name: string
  argv: string[]
  /** The command as one line. */
  line: string
  /** Where it runs, relative to the scope root (trust.json's `cwdRel`). */
  cwdRel: string
  /**
   * Where it runs, relative to the project folder: `verify.commands[].cwd` as core reads it (`.` for the folder).
   * Below a repository's root the two differ, and writing `cwdRel` as `cwd` named a folder that does
   * not exist.
   */
  cwd: string
  source: string
  /** In `verify.commands` (index into the resolved list). */
  configIndex: number | null
  /** A run would run it: configured and not turned off. */
  enabled: boolean
  trust: VerifyTrustState | 'unknown'
  /** The grant hash core showed (trust.set refuses it once the script changed since). */
  hash: string | null
  body: string | null
  /** `changed`: the body the existing grant covers. */
  grantedBody: string | null
  /** Why core cannot run it as configured. */
  error: string | null
  /** argv[0] does not resolve on this computer (core's `resolved` is null). */
  notFound: boolean
  /** Discovery suggests it by default (a project's typecheck, lint and test). */
  suggested: boolean
}

/** Where a command came from, in words. */
export const SOURCE_TEXT: Readonly<Record<string, string>> = {
  'package.json': 'package.json script',
  Makefile: 'Makefile target',
  makefile: 'Makefile target',
  pyproject: 'Python project',
  cargo: 'Cargo',
  go: 'Go module',
  dotnet: '.NET project',
  maven: 'Maven project',
  gradle: 'Gradle project',
  config: 'Added in your settings',
}

export function sourceText(source: string): string {
  return SOURCE_TEXT[source] ?? source
}

/** The trust state in words. */
export const TRUST_TEXT: Readonly<Record<VerifyRow['trust'], string>> = {
  trusted: 'Trusted',
  untrusted: 'Not trusted',
  changed: 'Changed since you trusted it',
  invalid: 'Cannot run as written',
  unknown: 'Not checked yet',
}

/** A configured command's argv: its own, or its line as core tokenizes it ([] when core would refuse it). */
export function configArgv(c: Pick<VerifyCommandConfig, 'run'>): string[] {
  if (Array.isArray(c.run)) return [...c.run]
  const t = tokenizeCommand(c.run)
  return t.ok ? t.argv : []
}

const keyOf = (argv: readonly string[], cwdRel: string): string => `${cwdRel}\u0000${argv.join('\u0000')}`

const normCwd = (cwd: string | undefined): string => {
  const c = (cwd ?? '.').replace(/\\/g, '/').replace(/\/+$/, '')
  return c === '' || c === './' ? '.' : c.startsWith('./') ? c.slice(2) : c
}

function isDetected(v: unknown): v is VerifyCommand {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return typeof d['name'] === 'string' && typeof d['id'] === 'string'
}

function trustOf(d: VerifyCommand): VerifyRow['trust'] {
  const t = (d as { trust?: unknown }).trust
  if (t === 'trusted' || t === 'untrusted' || t === 'changed' || t === 'invalid') return t
  return d.trusted ? 'trusted' : 'untrusted'
}

function argvOf(d: VerifyCommand): string[] {
  const raw = Array.isArray(d.argv) ? d.argv : Array.isArray(d.run) ? d.run : []
  return raw.filter((a): a is string => typeof a === 'string')
}

/**
 * The table's rows: the configured commands first (core's resolved `verify.commands`, with discovery's trust state for
 * each), then the commands discovery found that are not configured. `detected` null: discovery has not answered.
 */
export function verifyRows(
  configured: readonly VerifyCommandConfig[],
  detected: readonly VerifyCommand[] | null,
): VerifyRow[] {
  const found = (detected ?? []).filter(isDetected)
  const byName = new Map(
    found.filter((d) => d.configured === true || d.source === 'config').map((d) => [d.name, d]),
  )
  const rows: VerifyRow[] = []
  const taken = new Set<string>()
  configured.forEach((c, i) => {
    const d = byName.get(c.name)
    const argv = d !== undefined && argvOf(d).length > 0 ? argvOf(d) : configArgv(c)
    const cwdRel = d?.cwdRel ?? normCwd(c.cwd)
    const cwd = normCwd(c.cwd)
    taken.add(keyOf(argv, cwdRel))
    rows.push({
      key: `config:${c.name}`,
      name: c.name,
      argv,
      line: argv.length > 0 ? displayArgv(argv) : Array.isArray(c.run) ? c.run.join(' ') : c.run,
      cwdRel,
      cwd,
      source: 'config',
      configIndex: i,
      enabled: c.enabled !== false,
      trust: d !== undefined ? trustOf(d) : detected === null ? 'unknown' : 'untrusted',
      hash: d?.hash ?? null,
      body: d?.body ?? null,
      grantedBody: d?.grantedBody ?? null,
      error: d?.error ?? null,
      notFound: d !== undefined && 'resolved' in d && d.resolved === null,
      suggested: false,
    })
  })
  for (const d of found) {
    if (d.configured === true || d.source === 'config') continue
    const argv = argvOf(d)
    const k = keyOf(argv, d.cwdRel)
    if (taken.has(k)) continue
    taken.add(k)
    rows.push({
      key: `detected:${d.id}`,
      name: d.name,
      argv,
      line: displayArgv(argv),
      cwdRel: d.cwdRel,
      // Discovery looks in the project folder itself: '.' when an older core does not say.
      cwd: typeof d.cwd === 'string' ? normCwd(d.cwd) : '.',
      source: d.source,
      configIndex: null,
      enabled: false,
      trust: trustOf(d),
      hash: d.hash,
      body: d.body ?? null,
      grantedBody: d.grantedBody ?? null,
      error: d.error ?? null,
      notFound: 'resolved' in d && d.resolved === null,
      suggested: d.enabledByDefault,
    })
  }
  return rows
}

/** A detected command as a `verify.commands` entry (`cwd` relative to the project folder, as core reads it). */
export function entryFor(row: Pick<VerifyRow, 'name' | 'argv' | 'cwd'>): VerifyCommandConfig {
  return {
    name: row.name,
    run: [...row.argv],
    ...(row.cwd !== '.' && row.cwd !== '' ? { cwd: row.cwd } : {}),
  }
}

/** The list with a row turned on or off: a configured entry's `enabled`, or a detected command added. */
export function withEnabled(
  list: readonly VerifyCommandConfig[],
  row: VerifyRow,
  enabled: boolean,
): VerifyCommandConfig[] {
  if (row.configIndex === null) return enabled ? [...list, entryFor(row)] : [...list]
  return list.map((c, i) => {
    if (i !== row.configIndex) return c
    const { enabled: _was, ...rest } = c
    return enabled ? rest : { ...rest, enabled: false }
  })
}

/** The list without a configured row. */
export function withoutRow(list: readonly VerifyCommandConfig[], row: VerifyRow): VerifyCommandConfig[] {
  return row.configIndex === null ? [...list] : list.filter((_, i) => i !== row.configIndex)
}

/** The list with the detected commands discovery suggests added (those not configured yet). */
export function withSuggested(
  list: readonly VerifyCommandConfig[],
  rows: readonly VerifyRow[],
): VerifyCommandConfig[] {
  return [
    ...list,
    ...rows.filter((r) => r.configIndex === null && r.suggested && r.error === null).map(entryFor),
  ]
}

/** Why a new command's name cannot be used, or null. */
export function nameProblem(name: string, list: readonly VerifyCommandConfig[]): string | null {
  const n = name.trim()
  if (n === '') return 'Give the command a name.'
  if (n.length > 40) return 'A name has at most 40 characters.'
  if (list.some((c) => c.name === n)) return `There is already a command named ${n}.`
  return null
}

/** Why a folder for a new command cannot be used, or null (relative to the project, inside it). */
export function folderProblem(folder: string): string | null {
  const f = folder.trim().replace(/\\/g, '/')
  if (f === '' || f === '.') return null
  if (f.startsWith('/') || /^[A-Za-z]:/.test(f)) return 'Use a folder inside the project, relative to it.'
  if (f.split('/').includes('..')) return 'Use a folder inside the project, relative to it.'
  return null
}
