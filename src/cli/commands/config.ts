// `dimf config …`:
//   resolve [<folder>]   every resolved value with where it came from (default / user / project / run / auto /
//                        inherit / vendor / cli, plus file:line) — read-only
//   restore              "Restore last good": the last dimfactory.json that loaded without errors (else the newest
//                        backup) replaces the current one, which is backed up first
//   trust <folder> …     a one-time grant in trust.json (projectAuto, largeFolder; vendorFolder --vendor gemini;
//                        recipeAuto --recipe <id>)
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { ConfigIssue, ResolvedWithProvenance, TrustGrantInput } from '../../shared/ipc.ts'
import { needsFolderTrust } from '../../shared/vendors.ts'
import { describeProvenance, provenanceAt, toJsonPointer } from '../../core/config/provenance.ts'
import type { ResolveIssue } from '../../core/config/resolve.ts'
import { formatConfigIssue } from '../../core/preflight/checks/app.ts'
import { UsageError, parseSets } from '../args.ts'
import { shellArg } from '../hints.ts'
import type { CliIo } from '../io.ts'
import { EXIT, cliName, usage, withReadOnlyCore, withWritableCore } from '../session.ts'

export const CONFIG_RESOLVE_USAGE =
  'dimf config resolve [<folder>] [--profile p] [--set k=v]... [--json] [--home dir]'
export const CONFIG_RESTORE_USAGE = 'dimf config restore [--project <folder>] [--backup <id>] [--home dir]'
export const CONFIG_TRUST_USAGE =
  'dimf config trust <folder> projectAuto|largeFolder|vendorFolder|recipeAuto [--vendor id] [--recipe id] [--revoke] [--home dir]'
export const CONFIG_USAGE = [CONFIG_RESOLVE_USAGE, CONFIG_RESTORE_USAGE, CONFIG_TRUST_USAGE].join('\n  ')

export async function configCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'resolve':
      return resolveCommand(rest, io)
    case 'restore':
      return restoreCommand(rest, io)
    case 'trust':
      return trustCommand(rest, io)
    case undefined:
      io.err('dimf config: expected resolve, restore or trust')
      io.err(`usage: ${CONFIG_USAGE}`)
      return EXIT.usage
    default:
      io.err(`dimf config: unknown subcommand "${sub}"`)
      io.err(`usage: ${CONFIG_USAGE}`)
      return EXIT.usage
  }
}

// ---- resolve ----------------------------------------------------------------------------------------------------

/** Leaves of the resolved config in order (a prompt template is one leaf). */
function leaves(v: unknown, segs: string[] = []): [string[], unknown][] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [[segs, v]]
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return [[segs, v]]
  if (segs.length === 3 && segs[0] === 'passes' && segs[2] === 'promptTemplate') return [[segs, v]]
  return entries.flatMap(([k, x]) => leaves(x, [...segs, k]))
}

function valueText(segs: readonly string[], v: unknown): string {
  // vendors.<id>.env values may be secrets: show that they are set, not what they are.
  if (segs[0] === 'vendors' && segs[2] === 'env' && segs.length === 4) return '(set, hidden)'
  if (segs[0] === 'passes' && segs[2] === 'promptTemplate' && typeof v === 'object' && v !== null) {
    const t = v as { name?: unknown; layer?: unknown }
    return `${String(t.name)} (${String(t.layer)})`
  }
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** Text lines for `config resolve`: the files, their problems, then one line per value. */
export function resolveLines(r: ResolvedWithProvenance, folder: string | undefined): string[] {
  const out: string[] = []
  out.push(
    folder !== undefined
      ? `Config for ${folder}${r.scopeRoot !== null && r.scopeRoot !== folder ? ` (scope root ${r.scopeRoot})` : ''}`
      : 'Config (no folder: user layer only)',
  )
  const fileLine = (label: string, l: ResolvedWithProvenance['layers']['user'] | null): void => {
    if (l === null) return
    const state = !l.exists ? 'not found' : l.valid ? 'ok' : 'HAS ERRORS (ignored: the layers below apply)'
    out.push(`  ${label.padEnd(8)} ${l.path}  ${state}`)
  }
  fileLine('user', r.layers.user)
  fileLine('project', r.layers.project)
  if (r.issues.length > 0) {
    out.push('Problems:')
    for (const i of r.issues) out.push(`  ${i.severity === 'error' ? 'x' : '!'} ${formatConfigIssue(i)}`)
  }
  out.push('')
  const rows = leaves(r.config).map(([segs, v]) => {
    const pointer = toJsonPointer(segs)
    return {
      key: segs.join('.'),
      value: valueText(segs, v),
      where: describeProvenance(provenanceAt(r.provenance, pointer)),
    }
  })
  const kw = Math.min(44, Math.max(...rows.map((x) => x.key.length)))
  const vw = Math.min(28, Math.max(...rows.map((x) => x.value.length)))
  for (const x of rows) out.push(`${x.key.padEnd(kw)}  ${x.value.padEnd(vw)}  ${x.where}`)
  return out
}

function resolveIssueLine(i: ResolveIssue): string {
  const where = i.file !== undefined ? `${i.file}${i.line !== undefined ? `:${i.line}` : ''} ` : ''
  return `${where}${i.message}${i.pointer !== '' && i.file === undefined ? ` (${i.pointer})` : ''}`
}

async function resolveCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: {
    profile?: string | undefined
    set?: string[] | undefined
    json?: boolean
    home?: string | undefined
  }
  let folder: string | undefined
  let overrides
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        home: { type: 'string' },
        json: { type: 'boolean', default: false },
        profile: { type: 'string' },
        set: { type: 'string', multiple: true },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length > 1) throw new UsageError('expected at most one <folder>')
    const f = parsed.positionals[0]
    folder = f !== undefined ? resolve(io.cwd, f) : undefined
    overrides = parseSets(v.set ?? [])
    if (v.profile !== undefined) overrides.profile = v.profile
  } catch (err) {
    return usage(io, 'config resolve', CONFIG_RESOLVE_USAGE, err)
  }
  return withReadOnlyCore(
    io,
    v.home,
    async (core) => {
      const r = await core.invoke('config.resolve', {
        ...(folder !== undefined ? { folder } : {}),
        overrides,
      })
      if (!r.ok) {
        const d = (r.error.details ?? {}) as { issues?: ResolveIssue[]; configIssues?: ConfigIssue[] }
        if (v.json === true) {
          io.out(JSON.stringify({ error: r.error }, null, 2))
          return EXIT.failed
        }
        io.err(`The config does not resolve: ${r.error.message}`)
        for (const i of d.issues ?? []) io.err(`  x ${resolveIssueLine(i)}`)
        for (const i of d.configIssues ?? [])
          io.err(`  ${i.severity === 'error' ? 'x' : '!'} ${formatConfigIssue(i)}`)
        return EXIT.failed
      }
      if (v.json === true) io.out(JSON.stringify(r.value, null, 2))
      else for (const l of resolveLines(r.value, folder)) io.out(l)
      const layers = [r.value.layers.user, r.value.layers.project].filter(
        (l): l is NonNullable<typeof l> => l !== null && l.exists && !l.valid,
      )
      if (v.json !== true) {
        for (const l of layers) {
          const req =
            l.scope === 'project' && folder !== undefined ? { scope: l.scope, folder } : { scope: l.scope }
          const read = await core.invoke('config.read', req)
          const home = v.home !== undefined ? ` --home ${shellArg(v.home)}` : ''
          const project =
            l.scope === 'project' && folder !== undefined ? ` --project ${shellArg(folder)}` : ''
          io.err(
            read.ok && read.value.backups.length > 0
              ? `${l.path} has errors, so runs are blocked. Fix it, or restore the last good version: ` +
                  `${cliName(io)} config restore${project}${home}`
              : `${l.path} has errors, so runs are blocked. Fix it (there is no earlier version to restore).`,
          )
        }
      }
      return layers.length > 0 ? EXIT.failed : EXIT.completed
    },
    { configBanner: false },
  )
}

// ---- restore ----------------------------------------------------------------------------------------------------

async function restoreCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: { project?: string | undefined; backup?: string | undefined; home?: string | undefined }
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { home: { type: 'string' }, project: { type: 'string' }, backup: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    })
    v = parsed.values
  } catch (err) {
    return usage(io, 'config restore', CONFIG_RESTORE_USAGE, err)
  }
  const folder = v.project !== undefined ? resolve(io.cwd, v.project) : undefined
  const scope = folder !== undefined ? 'project' : 'user'
  return withWritableCore(
    io,
    v.home,
    async (core) => {
      try {
        const out = await core.config.restoreBackup({
          scope,
          ...(folder !== undefined ? { folder } : {}),
          backupId: v.backup ?? 'last-good',
        })
        const from =
          out.restoredFrom === 'last-good'
            ? 'the last version that loaded without errors'
            : `backup ${out.restoredFrom ?? v.backup ?? '?'}`
        io.out(out.changed ? `Restored ${out.path} from ${from}.` : `${out.path} already matches ${from}.`)
        if (out.backupId !== null) io.out(`The replaced text was backed up as ${out.backupId}.`)
        for (const l of out.diff.split('\n').filter((x) => x !== '')) io.out(`  ${l}`)
      } catch (err) {
        io.err(`dimf config restore: ${err instanceof Error ? err.message : String(err)}`)
        return EXIT.failed
      }
      const check = await core.invoke('config.read', { scope, ...(folder !== undefined ? { folder } : {}) })
      const errors = check.ok ? check.value.issues.filter((i) => i.severity === 'error') : []
      if (errors.length > 0) {
        io.err('The restored file still has errors:')
        for (const i of errors) io.err(`  x ${formatConfigIssue(i)}`)
        return EXIT.failed
      }
      io.out('It loads without errors.')
      return EXIT.completed
    },
    { configBanner: false },
  )
}

// ---- trust ------------------------------------------------------------------------------------------------------

const TRUST_KINDS = ['projectAuto', 'largeFolder', 'vendorFolder', 'recipeAuto'] as const

const TRUST_COPY: Readonly<Record<(typeof TRUST_KINDS)[number], string>> = {
  projectAuto: "the project's dimfactory.json may turn on Auto mode (until the file changes)",
  largeFolder: 'snapshots of this large folder are allowed (until it doubles in size)',
  vendorFolder: 'the vendor works in this folder without its own folder-trust prompt',
  recipeAuto: 'the project recipe may turn on Auto mode (until its file changes)',
}

async function trustCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: {
    revoke?: boolean
    home?: string | undefined
    vendor?: string | undefined
    recipe?: string | undefined
  }
  let folder: string
  let grant: TrustGrantInput
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        home: { type: 'string' },
        revoke: { type: 'boolean', default: false },
        vendor: { type: 'string' },
        recipe: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    const [f, k] = parsed.positionals
    if (f === undefined || k === undefined || parsed.positionals.length !== 2) {
      throw new UsageError(
        'expected <folder> and a grant (projectAuto, largeFolder, vendorFolder or recipeAuto)',
      )
    }
    if (!(TRUST_KINDS as readonly string[]).includes(k)) {
      throw new UsageError(`unknown grant "${k}" (use ${TRUST_KINDS.join(', ')})`)
    }
    const kind = k as (typeof TRUST_KINDS)[number]
    // trust.json vendorFolder: the folder trusted for one vendor that asks for it (Gemini).
    if (kind === 'vendorFolder') {
      if (v.vendor === undefined || v.vendor === '') throw new UsageError('vendorFolder needs --vendor <id>')
      if (!needsFolderTrust(v.vendor)) {
        throw new UsageError(`${v.vendor} does not ask Dim Factory to trust folders`)
      }
      if (v.recipe !== undefined) throw new UsageError('--recipe goes with recipeAuto only')
      grant = { kind, vendor: v.vendor }
    } else if (kind === 'recipeAuto') {
      // trust.json recipeAuto: a project recipe that turns on Auto mode, for its file as it is now.
      if (v.recipe === undefined || v.recipe === '') throw new UsageError('recipeAuto needs --recipe <id>')
      if (v.vendor !== undefined) throw new UsageError('--vendor goes with vendorFolder only')
      grant = { kind, recipeId: v.recipe }
    } else {
      if (v.vendor !== undefined) throw new UsageError('--vendor goes with vendorFolder only')
      if (v.recipe !== undefined) throw new UsageError('--recipe goes with recipeAuto only')
      grant = { kind }
    }
    folder = resolve(io.cwd, f)
  } catch (err) {
    return usage(io, 'config trust', CONFIG_TRUST_USAGE, err)
  }
  const kind = grant.kind as (typeof TRUST_KINDS)[number]
  const trusted = v.revoke !== true
  return withWritableCore(io, v.home, async (core) => {
    const r = await core.invoke('trust.set', { folder, grant, trusted })
    if (!r.ok) {
      io.err(`dimf config trust: ${r.error.message}`)
      return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
    }
    const which =
      grant.kind === 'vendorFolder'
        ? ` (${grant.vendor})`
        : grant.kind === 'recipeAuto'
          ? ` (${grant.recipeId})`
          : ''
    io.out(
      trusted
        ? `Allowed for ${r.value.scopeRoot}: ${TRUST_COPY[kind]}${which}.`
        : `Revoked for ${r.value.scopeRoot}: ${kind}${which}.`,
    )
    return EXIT.completed
  })
}
