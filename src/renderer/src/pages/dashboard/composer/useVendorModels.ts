// Model suggestions per vendor for the pass rows (the CLI's list plus the catalog's, or free text):
// core's vendors.models (CLI list merged with the catalog, with pricing), asked for once per vendor when a model box
// is first used; until it answers, or when this core lacks it, the probe's own model list. When the catalog
// changes (an applied update, an undo, a price edit) every vendor already asked for is asked again, so new models and
// their "no pricing" chips show at once. Codex's models come the same way (its app-server `model/list`); a local
// preset's are its server's only.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../../ipc/client.ts'
import { useCatalogEpoch } from '../../../state/catalog.ts'
import { modelOptionsFromProbe } from './model.ts'

/**
 * A local preset (`local-<id>`) runs on Codex, but its models are the local server's (`GET {baseUrl}/models`,
 * source `local-server`): Codex's own list never stands in for them.
 */
export function forVendor(vendor: string, options: readonly ModelOption[]): ModelOption[] {
  return vendor.startsWith('local-') ? options.filter((o) => o.source === 'local-server') : [...options]
}

export interface VendorModels {
  options: (vendor: string) => ModelOption[] | null
  want: (vendor: string) => void
}

export function useVendorModels(probes: readonly ProbeView[]): VendorModels {
  const [byVendor, setByVendor] = useState<Readonly<Record<string, ModelOption[]>>>({})
  const asked = useRef(new Set<string>())

  const ask = useCallback((vendor: string) => {
    void invoke('vendors.models', { vendor }).then((r) => {
      if (r.ok) setByVendor((cur) => ({ ...cur, [vendor]: forVendor(vendor, r.value) }))
    })
  }, [])

  const want = useCallback(
    (vendor: string) => {
      if (asked.current.has(vendor)) return
      asked.current.add(vendor)
      ask(vendor)
    },
    [ask],
  )

  const epoch = useCatalogEpoch()
  const seenEpoch = useRef(epoch)
  useEffect(() => {
    if (seenEpoch.current === epoch) return
    seenEpoch.current = epoch
    for (const vendor of asked.current) ask(vendor)
  }, [epoch, ask])

  const options = useCallback(
    (vendor: string): ModelOption[] | null => {
      const fromCore = byVendor[vendor]
      if (fromCore !== undefined) return fromCore
      const fromProbe = modelOptionsFromProbe(probes.find((p) => p.vendor === vendor))
      return fromProbe.length > 0 ? fromProbe : null
    },
    [byVendor, probes],
  )

  return { options, want }
}
