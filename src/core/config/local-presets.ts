// Local presets (`local.presets`): `vendor: "local-<presetId>"` runs on the
// Codex adapter with the user's preset. One lookup for the engine (StartOptions.local), preflight
// (ReadinessNeed.local, the unknown-preset check) and the healer.
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { LocalPreset } from '../../shared/vendors.ts'
import { localPresetIdOf } from '../../shared/vendors.ts'

/**
 * The preset a `local-<id>` vendor names (a copy), or undefined for any other vendor and for a preset the config does
 * not list (preflight's `pass.<p>.vendor` blocks that one before any spawn).
 */
export function localPresetFor(
  config: Pick<ResolvedConfig, 'local'>,
  vendor: string,
): LocalPreset | undefined {
  const id = localPresetIdOf(vendor)
  if (id === null) return undefined
  const p = config.local.presets.find((x) => x.id === id)
  return p === undefined ? undefined : { ...p }
}

/**
 * The preset as a pass runs it: a model the pass names (picked from the server's list in the composer) replaces the
 * preset's own (the model shown is the model that runs), and the preset's context window, which is its
 * model's, is dropped for another model (readiness asks the server instead). Null / '' keeps the preset's model.
 */
export function presetForModel(preset: LocalPreset, model: string | null | undefined): LocalPreset {
  if (model === undefined || model === null || model.trim() === '' || model === preset.model) return preset
  const { contextWindow: _ctx, ...rest } = preset
  return { ...rest, model }
}

/** The preset id a `local-<id>` vendor names when the config lists no such preset, else null. */
export function unknownLocalPreset(
  config: Pick<ResolvedConfig, 'local'> | undefined,
  vendor: string,
): string | null {
  const id = localPresetIdOf(vendor)
  if (id === null || config === undefined) return null
  return config.local.presets.some((p) => p.id === id) ? null : id
}
