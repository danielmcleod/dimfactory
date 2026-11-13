// Easy mode's project permission as the screens read it: one folder's (with its uses, during a run too) and the list of
// every folder that has one (Settings and Easy settings). Core announces every grant, use and revoke
// (`easy-permission`); the readers ask again then. Revoking goes through core, which stops it covering anything at once.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { EasyPermissionState, EasyPermissionView } from '@shared/easy.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from './toasts.ts'

let epoch = 0
const listeners = new Set<() => void>()

/** Something changed for a folder's permission: every reader asks again. */
export function bumpEasyPermission(_folder: string): void {
  epoch++
  for (const l of [...listeners]) l()
}

function useEpoch(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => epoch,
    () => epoch,
  )
}

/** A folder's permission (and its uses during `runId`); null until core answered (none when it could not). */
export function useEasyPermission(folder: string | null, runId?: string): EasyPermissionState | null {
  const e = useEpoch()
  const [v, setV] = useState<EasyPermissionState | null>(null)
  useEffect(() => {
    if (folder === null) return
    let alive = true
    void invoke('easy.permission', { folder, ...(runId !== undefined ? { runId } : {}) }).then((r) => {
      // Unanswered reads as none (a screen that waits for it never waits forever).
      if (alive) setV(r.ok ? r.value : { folder, at: 0, uses: 0, granted: false, runUses: 0 })
    })
    return () => {
      alive = false
    }
  }, [folder, runId, e])
  return v
}

/**
 * Every folder with the permission (null until core answered). `deferMs`: read only once the reader has been shown that
 * long (Settings: a section switch costs no IPC).
 */
export function useEasyPermissions(deferMs = 0): { list: EasyPermissionView[] | null; error: string | null } {
  const e = useEpoch()
  const [v, setV] = useState<{ list: EasyPermissionView[] | null; error: string | null }>({
    list: null,
    error: null,
  })
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void invoke('easy.permissions').then((r) => {
        if (alive) setV(r.ok ? { list: r.value, error: null } : { list: null, error: r.error.message })
      })
    }
    const t = deferMs > 0 ? setTimeout(read, deferMs) : undefined
    if (t === undefined) read()
    return () => {
      alive = false
      if (t !== undefined) clearTimeout(t)
    }
  }, [e, deferMs])
  return v
}

/** Take a folder's permission back (core stops it at once). False when core refused. */
export async function revokeEasyPermission(folder: string): Promise<boolean> {
  const r = await invoke('easy.revokePermission', { folder })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  bumpEasyPermission(folder)
  return true
}
