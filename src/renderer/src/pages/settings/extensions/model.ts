// Settings > Extensions, pure parts: the level each pass resolves to, which passes may use a discovered item, and the
// allow list after a tick. Core's resolved config and its discovery answer are the only sources.
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { AllowedExtensions, ExtensionLevel } from '@shared/extensions.ts'
import { allowedFor, defaultExtensionLevel, extensionsVendor } from '@shared/extensions.ts'
import { PASS_NAMES } from '@shared/run.ts'
import type { PassName } from '@shared/run.ts'
import { stepLabel } from '../../../lib/format.ts'

export type ResolvedSlice = Partial<Pick<ResolvedConfig, 'passes' | 'extensions'>>

export interface PassLevel {
  pass: PassName
  vendor: string
  level: ExtensionLevel
  enabled: boolean
}

/** Each pass's vendor, level and on/off as core resolved them (read defensively: an older core sends no level). */
export function passLevels(config: ResolvedSlice | null): PassLevel[] {
  if (config?.passes === undefined) return []
  const passes = config.passes
  return PASS_NAMES.map((pass) => {
    const p = passes[pass] as Partial<ResolvedConfig['passes'][PassName]> | undefined
    return {
      pass,
      vendor: p?.vendor ?? '',
      level: p?.extensions ?? defaultExtensionLevel(pass),
      enabled: p?.enabled ?? true,
    }
  })
}

/** The vendor's allow list as core resolved it. */
export function allowedOf(config: ResolvedSlice | null, vendor: string): AllowedExtensions {
  return allowedFor(config?.extensions, vendor)
}

/**
 * The passes that may use an item of `vendor`: those on it at Pass through, and those at Allowed list while the item is
 * ticked. Passes that are off are left out.
 */
export function usedBy(levels: readonly PassLevel[], vendor: string, ticked: boolean): PassName[] {
  return levels
    .filter((l) => l.enabled && extensionsVendor(l.vendor) === vendor)
    .filter((l) => l.level === 'passthrough' || (l.level === 'allowed' && ticked))
    .map((l) => l.pass)
}

/** "Used by Review and Critic", or "Not used by any pass". */
export function usedByText(passes: readonly PassName[]): string {
  if (passes.length === 0) return 'Not used by any pass'
  const names = passes.map(stepLabel)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
  return `Used by ${list}`
}

/** The list with `name` ticked or not (order kept, no duplicates). */
export function withTicked(list: readonly string[], name: string, on: boolean): string[] {
  const rest = list.filter((n) => n !== name)
  return on ? [...rest, name] : rest
}
