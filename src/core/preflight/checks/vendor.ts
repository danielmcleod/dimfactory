// Vendor-scope checks: `vendor.<v>.{bin,version,auth,protocol,plan,
// winSandbox,env}` come from the adapter's launch probe. Live and passBoundary read the probe store only;
// authoritative probes when the store is empty or stale and re-runs only `vendor.<v>.auth` (10 min TTL).
import { homedir } from 'node:os'
import type { ResolvedConfig } from '../../../shared/config-schema.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import { vendorCheckId } from '../../../shared/preflight.ts'
import { PASS_NAMES } from '../../../shared/run.ts'
import { claudeEnv } from '../../adapters/claude/launch.ts'
import { authChecks } from '../../adapters/claude/probe.ts'
import type { EnvInput } from '../../proc/env.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import type { ResolveResult } from '../../proc/resolve-cli.ts'
import { execCapture } from '../../proc/spawn.ts'
import type { CheckContext, PreflightCheckDef, PreflightInput } from '../engine.ts'

export type AuthRechecker = (vendor: string, o: { timeoutMs: number }) => Promise<CheckResult[]>

export interface ClaudeAuthRecheckOptions {
  /** Dim Factory's own env (default process.env). */
  env?: EnvInput
  /** `vendors.claude.env`. */
  vendorEnv?: Record<string, string>
  /** cwd for `claude auth status` (the adapter uses the OS home). */
  home?: string
  /** A fixed PATH (tests); default path-env. */
  pathEnv?: string
  now?: () => number
}

/**
 * `PreflightDeps.recheckAuth` for Claude: `claude auth status` (token-free, JSON) within the budget, mapped by the
 * adapter's own `authChecks` to `vendor.claude.{auth,env}`. Returns [] (keep the probe's result) when the binary
 * does not resolve or the command times out. Bridges the gap until the Adapter contract has an auth-only re-check.
 */
export function claudeAuthRechecker(
  adapter: { resolveBinary(force?: boolean): Promise<ResolveResult> },
  o: ClaudeAuthRecheckOptions = {},
): AuthRechecker {
  return async (vendor, { timeoutMs }) => {
    if (vendor !== 'claude') return []
    const r = await adapter.resolveBinary()
    if (!r.ok) return []
    const base = o.env ?? process.env
    const path = o.pathEnv ?? (await resolvePathEnv({ env: base })).path
    const env = claudeEnv(base, {
      route: 'readonly',
      path,
      pathPrepend: r.cli.pathPrepend,
      vendorEnv: o.vendorEnv,
    })
    const res = await execCapture(r.cli.command, [...r.cli.prefixArgs, 'auth', 'status'], {
      env,
      cwd: o.home ?? homedir(),
      timeoutMs,
    })
    if (res.timedOut) return []
    return authChecks(res, env, (o.now ?? Date.now)()).checks
  }
}

/** Dispatch `recheckAuth` by vendor (vendors without an entry keep their probe result). */
export function authRecheckers(byVendor: Readonly<Record<string, AuthRechecker>>): AuthRechecker {
  return (vendor, o) => byVendor[vendor]?.(vendor, o) ?? Promise.resolve([])
}

/** Vendors used by the enabled passes (configured ids, in pass order, de-duplicated). */
export function configuredVendors(config: ResolvedConfig | undefined): string[] {
  if (config === undefined) return []
  const out: string[] = []
  for (const p of PASS_NAMES) {
    const pass = config.passes[p]
    if (pass.enabled && !out.includes(pass.vendor)) out.push(pass.vendor)
  }
  return out
}

export function vendorDisplayName(ctx: CheckContext, vendor: string): string {
  return ctx.deps.adapters.get(vendor)?.displayName ?? vendor
}

/** The def id for a vendor (its results carry `vendor.<v>.<check>` ids from the probe). */
export const vendorDefId = (vendor: string): string => `vendor.${vendor}`

/** One def per vendor of the enabled passes. Registry ids (`local-x` → `codex`) are resolved by VendorAccess. */
export function vendorCheckDefs(input: PreflightInput): PreflightCheckDef[] {
  return configuredVendors(input.config).map((configured) => ({
    id: vendorDefId(configured),
    scope: 'vendor',
    title: `${configured} CLI`,
    dependsOn: [],
    cost: 'spawn',
    // The probe store is the cache (launch probe + 10 min auth); the engine cache is not used.
    ttlMs: 0,
    modes: ['live', 'authoritative'],
    appliesTo: () => true,
    subjectKey: (ctx) => ctx.vendors.resolveId(configured),
    async run(ctx: CheckContext): Promise<CheckResult[]> {
      const id = ctx.vendors.resolveId(configured)
      const name = vendorDisplayName(ctx, configured)
      if (ctx.deps.adapters.get(configured) === undefined) {
        return [
          ctx.result({
            id: vendorCheckId(configured, 'bin'),
            status: 'fail',
            title: `Unknown vendor "${configured}"`,
            detail: 'This vendor is not known to Dim Factory. Pick another vendor for the pass.',
            category: 'config_invalid',
          }),
        ]
      }
      const snap = ctx.mode === 'authoritative' ? await ctx.vendors.ensure(id) : ctx.vendors.latest(id)
      if (snap === undefined) {
        return [
          ctx.result({
            id: vendorCheckId(id, 'bin'),
            status: 'skip',
            title: `Checking ${name}…`,
            detail: `${name} has not been probed yet; results appear when the launch check finishes.`,
            ttlMs: 0,
          }),
        ]
      }
      return snap.checks
    },
  }))
}
