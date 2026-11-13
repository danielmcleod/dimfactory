// `dimf doctor` (read-only): per vendor the resolved path and source, version, transport and auth; git;
// home writability; the home lock holder; the PATH source.
import { parseArgs } from 'node:util'
import { gitVersion } from '../../core/git/exec.ts'
import { homePaths, probeHomeWritable } from '../../core/home.ts'
import { resolvePathEnv } from '../../core/proc/path-env.ts'
import { readHomeLock } from '../../core/store/home-lock.ts'
import type { CliIo } from '../io.ts'
import { EXIT, usage, when, withReadOnlyCore } from '../session.ts'

export const DOCTOR_USAGE = 'dimf doctor [--json] [--home dir]'

const HOME_OPT = { home: { type: 'string' }, json: { type: 'boolean', default: false } } as const

export async function doctorCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: { json?: boolean | undefined; home?: string | undefined }
  try {
    v = parseArgs({ args: [...args], options: HOME_OPT, allowPositionals: false, strict: true }).values
  } catch (err) {
    return usage(io, 'doctor', DOCTOR_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, async (core) => {
    const [probes, git, writable, lock, pathEnv] = await Promise.all([
      core.invoke('vendors.probe', {}),
      gitVersion().then(
        (g) => ({ ok: true as const, version: g.raw }),
        (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
      ),
      probeHomeWritable(homePaths(core.paths.home)),
      readHomeLock(core.paths).catch(() => null),
      resolvePathEnv({ env: io.env }).catch(() => null),
    ])
    const vendors = probes.ok ? probes.value : []
    const report = {
      home: core.paths.home,
      homeWritable: writable.ok,
      lock: lock !== null ? { pid: lock.pid, kind: lock.kind, since: lock.acquiredAt } : null,
      git,
      path:
        pathEnv !== null
          ? { source: pathEnv.source, entries: pathEnv.entries.length, warnings: pathEnv.warnings }
          : null,
      vendors: vendors.map((p) => ({
        vendor: p.vendor,
        built: p.built,
        health: p.health,
        detail: p.healthDetail,
        binary: p.probe?.binary?.path ?? null,
        source: p.probe?.binary?.source ?? null,
        version: p.probe?.version ?? null,
        transport: p.probe?.transport ?? null,
        auth: p.probe?.checks.find((c) => c.id === `vendor.${p.vendor}.auth`)?.title ?? null,
        failing: p.probe?.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.title}`) ?? [],
      })),
    }
    const healthy =
      writable.ok &&
      git.ok &&
      report.vendors.filter((x) => x.built).every((x) => x.health === 'ready' || x.health === 'warning')
    if (v.json === true) {
      io.out(JSON.stringify(report, null, 2))
      return healthy ? EXIT.completed : EXIT.failed
    }
    io.out(
      `Home:   ${report.home} (${writable.ok ? 'writable' : `NOT writable: ${writable.ok ? '' : writable.error.message}`})`,
    )
    io.out(
      `Lock:   ${lock !== null ? `held by ${lock.kind} pid ${lock.pid} since ${when(lock.acquiredAt)}` : 'free'}`,
    )
    io.out(`Git:    ${git.ok ? git.version : `missing (${git.error})`}`)
    if (pathEnv !== null) io.out(`PATH:   ${pathEnv.source} (${pathEnv.entries.length} entries)`)
    for (const x of report.vendors) {
      if (!x.built) continue
      io.out(`${x.vendor}: ${x.detail}`)
      if (x.binary !== null) io.out(`  binary    ${x.binary} (${x.source ?? '?'})`)
      if (x.version !== null) io.out(`  version   ${x.version} · ${x.transport ?? '?'}`)
      if (x.auth !== null) io.out(`  auth      ${x.auth}`)
      for (const f of x.failing) io.out(`  FAIL      ${f}`)
    }
    return healthy ? EXIT.completed : EXIT.failed
  })
}
