// What Easy made a folder as (its kind, idea and short title), asked of core's project list once per folder; null for a
// folder Easy did not make (or when core did not answer), 'loading' until then.
import { useEffect, useState } from 'react'
import type { EasyProjectView } from '@shared/easy.ts'
import { invoke } from '../../ipc/client.ts'

const key = (folder: string): string => folder.replace(/[\\/]+$/, '').toLowerCase()

export function useEasyProject(folder: string): EasyProjectView | null | 'loading' {
  const [v, setV] = useState<EasyProjectView | null | 'loading'>('loading')
  useEffect(() => {
    let alive = true
    void invoke('easy.projects').then((r) => {
      if (!alive) return
      const k = key(folder)
      setV(r.ok ? (r.value.find((p) => key(p.folder) === k) ?? null) : null)
    })
    return () => {
      alive = false
    }
  }, [folder])
  return v
}
