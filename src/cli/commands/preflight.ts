// `dimf preflight <folder>` (read-only): the launch probe, then the live preflight the composer shows.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { CheckResult, PreflightReport } from '../../shared/preflight.ts'
import { UsageError, parseSets } from '../args.ts'
import { recoveryLine } from '../hints.ts'
import type { HintContext } from '../hints.ts'
import type { CliIo } from '../io.ts'
import { EXIT, cliName, usage, withReadOnlyCore } from '../session.ts'

export const PREFLIGHT_USAGE = 'dimf preflight <folder> [--profile p] [--set k=v]... [--json] [--home dir]'

const HOME_OPT = { home: { type: 'string' }, json: { type: 'boolean', default: false } } as const

const MARK: Record<CheckResult['status'], string> = { pass: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' }

export function reportLines(r: PreflightReport, hints?: HintContext): string[] {
  const out: string[] = []
  out.push(
    r.ok
      ? `Preflight passed (${r.info.length} checks ok, ${r.warnings.length} warnings)`
      : `Preflight blocked: ${r.blocking.length} problem(s)`,
  )
  for (const c of [...r.blocking, ...r.warnings, ...r.info]) {
    out.push(`  ${MARK[c.status]} ${c.id.padEnd(34)} ${c.title}`)
    if (c.status === 'fail' || c.status === 'warn') {
      for (const d of c.detail.split('\n').filter((l) => l.trim() !== '')) out.push(`         ${d}`)
      for (const a of c.recovery) out.push(`         ${recoveryLine(a, hints)}`)
    }
  }
  return out
}

export async function preflightCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: {
    profile?: string | undefined
    set?: string[] | undefined
    json?: boolean | undefined
    home?: string | undefined
  }
  let folder: string
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { ...HOME_OPT, profile: { type: 'string' }, set: { type: 'string', multiple: true } },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <folder>')
    folder = resolve(io.cwd, parsed.positionals[0] ?? '.')
  } catch (err) {
    return usage(io, 'preflight', PREFLIGHT_USAGE, err)
  }
  let overrides
  try {
    overrides = parseSets(v.set ?? [])
    if (v.profile !== undefined) overrides.profile = v.profile
  } catch (err) {
    return usage(io, 'preflight', PREFLIGHT_USAGE, err)
  }
  return withReadOnlyCore(
    io,
    v.home,
    async (core) => {
      // The launch probe (vendor checks come only from it; live preflight never spawns a vendor). Skipped while the
      // user dimfactory.json has errors: its `vendors` section is what names the binaries to probe.
      if (core.settings.issues.length === 0) await core.invoke('vendors.probe', {})
      const r = await core.invoke('preflight.run', { folder, overrides })
      if (!r.ok) {
        io.err(`dimf preflight: ${r.error.message}`)
        return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
      }
      if (v.json === true) io.out(JSON.stringify(r.value, null, 2))
      else {
        const hints = { cli: cliName(io), folder, ...(v.home !== undefined ? { home: v.home } : {}) }
        for (const l of reportLines(r.value, hints)) io.out(l)
      }
      return r.value.ok ? EXIT.completed : EXIT.preflightBlocked
    },
    { configBanner: false },
  )
}

// ---- doctor ---------------------------------------------------------------------------------------------------------
