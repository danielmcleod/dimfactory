// Running a core command from a Run view control (interaction rules: no confirm dialogs, errors
// as toasts with core's own message). A busy flag per control keeps the label visible while the call is in flight,
// and the run's snapshot is refetched at once so the view does not wait for the debounced refresh.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Cmd, InvokeArgs, Res, Result } from '@shared/ipc.ts'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'

/** invoke + error toast; refetches `refresh` (a runId) after a success. Resolves to the Result. */
export async function runCommand<C extends Cmd>(
  refresh: string | null,
  cmd: C,
  ...args: InvokeArgs<C>
): Promise<Result<Res<C>>> {
  const r = await invoke(cmd, ...args)
  if (!r.ok) toast({ level: 'error', message: r.error.message })
  else if (refresh !== null) void fetchSnapshot(refresh)
  return r
}

/** Copy text to the clipboard; resolves to whether it worked (a toast says so either way). */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast({ level: 'info', message: `${what} copied to the clipboard` })
    return true
  } catch {
    toast({ level: 'error', message: `Could not copy the ${what.toLowerCase()} to the clipboard.` })
    return false
  }
}

/**
 * A busy flag for one control and a runner that sets it around an async action. A second press while busy is
 * ignored. The flag is not touched after unmount.
 */
export function useBusy(): [busy: string | null, run: (tag: string, fn: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = useCallback((tag: string, fn: () => Promise<unknown>) => {
    if (busyRef.current !== null) return
    busyRef.current = tag
    setBusy(tag)
    void fn()
      .catch((err: unknown) =>
        toast({ level: 'error', message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        busyRef.current = null
        if (mounted.current) setBusy(null)
      })
  }, [])
  return [busy, run]
}
