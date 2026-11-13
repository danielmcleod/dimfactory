// The launch probe on every start (background probes; authoritative preflight reads vendor bin/version/protocol
// from the launch probe). First launch probes the primary vendors itself; on every
// later launch nothing else would, and vendor health, the setup card and live preflight would wait on "Not checked
// yet". After first launch, this probes each built vendor that still has no probe (token-free; core records it and
// pushes the `probe` event).
import type { Cmd, Result } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'

export type ProbeInvoke = (cmd: Cmd, req?: unknown) => Promise<Result<unknown>>

export interface LaunchProbeLog {
  warn(msg: string, data?: Record<string, unknown>): void
}

/** Probes the built vendors `vendors.list` shows without a probe; returns the vendors it probed. */
export async function probeUnprobedVendors(invoke: ProbeInvoke, log?: LaunchProbeLog): Promise<string[]> {
  const listed = await invoke('vendors.list')
  if (!listed.ok) {
    log?.warn('launch probe: vendors.list failed', { code: listed.error.code })
    return []
  }
  const todo = (listed.value as ProbeView[]).filter((v) => v.built && v.probe === null).map((v) => v.vendor)
  await Promise.all(
    todo.map(async (vendor) => {
      const r = await invoke('vendors.probe', { vendor })
      if (!r.ok) log?.warn('launch probe failed', { vendor, code: r.error.code, message: r.error.message })
    }),
  )
  return todo
}
