// ACP argv and env rules (extraArgs are placed at the end of argv, validated against
// managedFlags at load and again before spawn; `flagMap` renames a managed flag). Prompts never go in argv: they
// travel in session/prompt over JSON-RPC.
import type { EnvInput } from '../../proc/env.ts'
import { sanitizeEnv } from '../../proc/env.ts'
import type { AcpVendorConfig } from './config.ts'

const flagName = (arg: string): string =>
  arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
/** Spelling-insensitive identity of a flag (`--skip-trust` ≡ `--skip_trust` ≡ `--skipTrust`). */
export const flagKey = (arg: string): string =>
  flagName(arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')

type FlagRules = Pick<AcpVendorConfig, 'displayName' | 'managedFlags' | 'forbiddenFlags' | 'cliFlags'>

/**
 * The single-letter flags of a combined short-flag argument (`-dy` → `-d`, `-y`), or null for anything else. The
 * CLIs' parsers (yargs for Gemini) read such an argument letter by letter, so `-dy` is `--debug --yolo` (every
 * layer that checks flags reads it letter by letter too).
 */
export function acpShortFlagCluster(arg: string): string[] | null {
  if (!/^-[^-]/.test(arg) || arg.length <= 2) return null
  return [...arg.slice(1)].map((ch) => `-${ch}`)
}

/**
 * The user's extraArgs for an ACP vendor: flags (and the value right after a flag), never a positional first word (a
 * prompt), never a flag Dim Factory manages or one that widens what a pass may do, also as one letter of a combined
 * short flag (`-dy`, `-dm`). undefined: fine.
 */
export function acpExtraArgsProblem(
  cfg: FlagRules,
  extraArgs: readonly string[] | undefined,
): string | undefined {
  const managed = new Set(cfg.managedFlags.map(flagKey))
  const forbidden = new Set(cfg.forbiddenFlags.map(flagKey))
  // A single letter is compared as itself (`-y`, `-m`): flagKey would fold `-y` and `--y` together.
  const managedShort = new Set(cfg.managedFlags.filter((f) => /^-[^-]$/.test(f)))
  const forbiddenShort = new Set(cfg.forbiddenFlags.filter((f) => /^-[^-]$/.test(f)))
  const list = extraArgs ?? []
  let valueAllowed = false
  for (const a of list) {
    if (/[\r\n\0]/.test(a)) return `extraArgs entry ${JSON.stringify(a.slice(0, 40))} contains a newline`
    if (a.startsWith('-') && a !== '-') {
      const key = flagKey(a)
      const name = flagName(a)
      if (managed.has(key)) return `extraArgs may not set ${name}; Dim Factory manages it`
      if (forbidden.has(key) || /^dangerously/.test(key))
        return `extraArgs may not set ${name}; it widens what a pass may do`
      const letters = acpShortFlagCluster(a)
      const managedHit = letters?.find((l) => managedShort.has(l))
      if (managedHit !== undefined)
        return `extraArgs may not combine ${managedHit} with other short flags (${JSON.stringify(a.slice(0, 40))}); Dim Factory manages ${managedHit}`
      const forbiddenHit = letters?.find((l) => forbiddenShort.has(l))
      if (forbiddenHit !== undefined)
        return `extraArgs may not combine ${forbiddenHit} with other short flags (${JSON.stringify(a.slice(0, 40))}); it widens what a pass may do`
      valueAllowed = !a.includes('=')
      continue
    }
    if (!valueAllowed) {
      return `extraArgs for ${cfg.displayName} are flags only (got ${JSON.stringify(a.slice(0, 40))})`
    }
    valueAllowed = false
  }
  return undefined
}

const LONG_FLAG = /^--[A-Za-z][\w-]*$/

/** flagMap may rename a managed flag only to a long flag the CLI does not already define. */
export function acpFlagMapProblem(
  cfg: FlagRules,
  flagMap: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const managed = new Set(cfg.managedFlags.map(flagKey))
  const forbidden = new Set(cfg.forbiddenFlags.map(flagKey))
  const cliFlags = new Set((cfg.cliFlags ?? []).map(flagKey))
  const targets = new Set<string>()
  for (const [from, to] of Object.entries(flagMap ?? {})) {
    if (!cfg.managedFlags.includes(from)) return `flagMap key ${from} is not a flag Dim Factory manages`
    if (!LONG_FLAG.test(to)) return `flagMap value ${JSON.stringify(to)} is not a long flag name (--name)`
    const key = flagKey(to)
    if (forbidden.has(key) || /^dangerously/.test(key))
      return `flagMap may not rename ${from} to ${to}; that flag widens what a pass may do`
    if (key !== flagKey(from) && managed.has(key))
      return `flagMap may not rename ${from} to ${to}; Dim Factory manages ${to} itself`
    if (key !== flagKey(from) && cliFlags.has(key))
      return `flagMap may not rename ${from} to ${to}; ${cfg.displayName} already uses ${to} for something else`
    if (targets.has(key)) return `flagMap renames two flags to ${to}`
    targets.add(key)
  }
  return undefined
}

/** Dim Factory's own flags renamed by the user's flagMap (only managed flags; the value after `=` is kept). */
export function applyAcpFlagMap(
  cfg: Pick<AcpVendorConfig, 'managedFlags'>,
  argv: readonly string[],
  flagMap: Readonly<Record<string, string>> | undefined,
): string[] {
  if (flagMap === undefined || Object.keys(flagMap).length === 0) return [...argv]
  return argv.map((arg) => {
    const name = flagName(arg)
    const to = flagMap[name]
    if (to === undefined || !cfg.managedFlags.includes(name)) return arg
    return name === arg ? to : `${to}${arg.slice(name.length)}`
  })
}

/** The child env of an ACP agent: sanitized, the resolved PATH, `vendors.<id>.env` on top. */
export function acpEnv(
  base: EnvInput,
  o: {
    vendor: string
    path: string | undefined
    pathPrepend?: readonly string[] | undefined
    vendorEnv?: EnvInput | undefined
    platform?: NodeJS.Platform | undefined
  },
): Record<string, string> {
  return sanitizeEnv(base, {
    purpose: 'vendor',
    vendor: o.vendor,
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.pathPrepend !== undefined && o.pathPrepend.length > 0 ? { pathPrepend: o.pathPrepend } : {}),
    ...(o.vendorEnv !== undefined ? { vendorEnv: o.vendorEnv } : {}),
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
  })
}
