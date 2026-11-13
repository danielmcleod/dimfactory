// What the user's dimfactory.json says about each vendor: the configured
// executable path and default model, read with config.read {scope:'user'} and read again after every config change.
import { useCallback, useEffect, useState } from 'react'
import type { JsonPatchOp } from '@shared/failure.ts'
import { invoke } from '../../../ipc/client.ts'
import { useConfigEpoch } from '../../../state/selectors.ts'

export interface VendorUserConfig {
  /** Absent: not set (auto-detect). */
  path?: string | null
  /** Absent: not set (the CLI's own default); null also means the CLI default. */
  defaultModel?: string | null
  /** Absent: not set (the model's own default effort); null also means the default. */
  defaultEffort?: string | null
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** `vendors.<id>.{path, defaultModel, defaultEffort}` of the user file's parsed value. */
export function vendorSettingsOf(value: unknown): Record<string, VendorUserConfig> {
  const out: Record<string, VendorUserConfig> = {}
  const vendors = rec(rec(value)?.['vendors'])
  if (vendors === null) return out
  for (const [id, raw] of Object.entries(vendors)) {
    const v = rec(raw)
    if (v === null) continue
    const entry: VendorUserConfig = {}
    const path = v['path']
    if (typeof path === 'string' || path === null) entry.path = path
    const model = v['defaultModel']
    if (typeof model === 'string' || model === null) entry.defaultModel = model
    const effort = v['defaultEffort']
    if (typeof effort === 'string' || effort === null) entry.defaultEffort = effort
    out[id] = entry
  }
  return out
}

/** The user file's vendor settings (null until read; empty when it cannot be read). Reads only when enabled. */
export function useVendorUserConfig(enabled: boolean): {
  vendors: Record<string, VendorUserConfig> | null
  reload: () => void
} {
  const epoch = useConfigEpoch()
  const [vendors, setVendors] = useState<Record<string, VendorUserConfig> | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void invoke('config.read', { scope: 'user' }).then((r) => {
      if (alive) setVendors(r.ok ? vendorSettingsOf(r.value.value) : {})
    })
    return () => {
      alive = false
    }
  }, [enabled, epoch, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { vendors, reload }
}

/** The JSON pointer of a vendor setting. */
export function vendorPointer(vendor: string, key: 'path' | 'defaultModel' | 'defaultEffort'): string {
  return `/vendors/${vendor}/${key}`
}

/** Set a value, or remove the key when `value` is undefined (back to the inherited default). */
export function setOrRemove(pointer: string, value: unknown): JsonPatchOp[] {
  return value === undefined ? [{ op: 'remove', path: pointer }] : [{ op: 'replace', path: pointer, value }]
}
