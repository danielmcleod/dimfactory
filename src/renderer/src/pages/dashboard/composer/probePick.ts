// A vendor picked from the pass rows' "More" list is probed (selecting one triggers vendors.probe, and the row shows
// 'Checking…' until it finishes; Gemini is such a vendor).
import { invoke } from '../../../ipc/client.ts'
import { upsertProbes } from '../../../state/actions.ts'
import { useStore } from '../../../state/store.ts'
import { toast } from '../../../state/toasts.ts'

const inFlight = new Set<string>()

/** Tests: forget the probes in flight. */
export function resetProbePickForTests(): void {
  inFlight.clear()
}

/**
 * `vendors.probe {vendor}` for a built vendor just picked. Its view in the store reads `checking` meanwhile (the
 * picker's note, the health dots) and core's answer replaces it. Never more than one probe per vendor from here at a
 * time; an older core without the command changes nothing.
 */
export async function probePicked(vendor: string): Promise<void> {
  const view = useStore.getState().probes.byVendor[vendor]
  if (view === undefined || !view.built || inFlight.has(vendor)) return
  inFlight.add(vendor)
  upsertProbes([{ ...view, checking: true }])
  let answered = false
  try {
    const r = await invoke('vendors.probe', { vendor })
    if (r.ok) {
      upsertProbes(r.value)
      answered = r.value.some((v) => v.vendor === vendor)
    } else if (r.error.code !== 'UNSUPPORTED') toast({ level: 'error', message: r.error.message })
  } finally {
    inFlight.delete(vendor)
    const now = useStore.getState().probes.byVendor[vendor]
    if (!answered && now?.checking === true) upsertProbes([{ ...now, checking: false }])
  }
}
