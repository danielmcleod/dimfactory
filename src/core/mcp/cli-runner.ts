// Running the user's Codex or Claude Code CLI for a plugin install (codex-plugin.ts, claude-plugin.ts): found the way
// the vendor's adapter finds it (`vendors.<id>.path`, then the usual places; only the configured path under the E2E
// vendor-search hook), run with a vendor environment (proc/env.ts sanitizeEnv, plus `vendors.<id>.env`) for at most
// a minute per command.
import { claudeCliSpec } from '../adapters/claude/cli-spec.ts'
import { codexCliSpec } from '../adapters/codex/cli-spec.ts'
import { sanitizeEnv } from '../proc/env.ts'
import { resolvePathEnv } from '../proc/path-env.ts'
import { resolveCli } from '../proc/resolve-cli.ts'
import type { CliSpec } from '../proc/resolve-cli.ts'
import { execCapture } from '../proc/spawn.ts'
import type { PluginCliRunner } from './plugin-install.ts'

export const PLUGIN_COMMAND_TIMEOUT_MS = 60_000

export interface PluginCliRunnerOptions {
  env: Readonly<Record<string, string | undefined>>
  /** Read when a command runs (the user file may change). */
  vendor: () => { path: string | null; env: Record<string, string> | undefined }
  search: 'all' | 'configured'
}

function vendorCliRunner(spec: CliSpec, vendor: string, o: PluginCliRunnerOptions): PluginCliRunner {
  return async (args) => {
    const v = o.vendor()
    const pathEnv = (await resolvePathEnv({ env: o.env })).path
    const r = await resolveCli(spec, {
      configuredPath: v.path,
      env: o.env,
      ...(pathEnv !== undefined ? { pathEnv } : {}),
      ...(v.env !== undefined ? { vendorEnv: v.env } : {}),
      ...(o.search === 'configured' ? { candidates: 'configured' as const } : {}),
    })
    if (!r.ok) return null
    const cli = r.cli
    const env = sanitizeEnv(o.env, {
      purpose: 'vendor',
      vendor,
      ...(pathEnv !== undefined ? { path: pathEnv } : {}),
      pathPrepend: cli.pathPrepend,
      ...(v.env !== undefined ? { vendorEnv: v.env } : {}),
    })
    const res = await execCapture(cli.command, [...cli.prefixArgs, ...args], {
      env,
      timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
      killTree: true,
    })
    const output = `${res.stdout}${res.stderr}${res.error !== undefined ? res.error.message : ''}`
    return { code: res.code, output, timedOut: res.timedOut }
  }
}

export function codexRunner(o: PluginCliRunnerOptions): PluginCliRunner {
  return vendorCliRunner(codexCliSpec, 'codex', o)
}

export function claudeRunner(o: PluginCliRunnerOptions): PluginCliRunner {
  return vendorCliRunner(claudeCliSpec, 'claude', o)
}
