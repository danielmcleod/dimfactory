// What the composer's buttons do with the pending overrides (one click saves, an undo toast follows; pass rows'
// [Save to project] / [Reset], footer "Save all overrides as project default", Critic swap).
// config.save writes core's minimal diff; Undo restores the file from core's backup (or removes the keys a new file
// got) and puts the overrides back as they were.
import { useCallback, useRef, useState } from 'react'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import type { PassName } from '@shared/run.ts'
import { invoke } from '../../../ipc/client.ts'
import { stepLabel } from '../../../lib/format.ts'
import { toast } from '../../../state/toasts.ts'
import {
  dropPass,
  isEmptyOverrides,
  NO_OVERRIDES,
  passOverride,
  restorePass,
  setPassValues,
} from './overrides.ts'
import type { PassValues } from './overrides.ts'
import type { OverridesUpdate } from './state.ts'
import { withoutTools } from './tools.ts'

/** JSON pointers of the leaves of an override object (what a save to a new file added). */
export function leafPointers(v: unknown, prefix = ''): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return prefix === '' ? [] : [prefix]
  return Object.entries(v).flatMap(([k, x]) =>
    leafPointers(x, `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`),
  )
}

/** Undo a config.save: restore core's backup of the file, or remove what a save to a new file wrote. */
async function undoWrite(folder: string, res: ConfigWriteResult, written: string[]): Promise<boolean> {
  const r =
    res.backupId !== null
      ? await invoke('config.restoreBackup', { scope: 'project', folder, backupId: res.backupId })
      : await invoke('config.patch', {
          scope: 'project',
          folder,
          ops: written.map((path) => ({ op: 'remove' as const, path })),
        })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  return true
}

export interface ComposerActions {
  /** The pass whose row is being saved, or 'all' for the footer. */
  saving: PassName | 'all' | null
  saveRow: (pass: PassName) => Promise<void>
  resetRow: (pass: PassName) => void
  saveAll: () => Promise<void>
  swapCritic: (to: string, label: string) => void
}

export function useComposerActions(
  folder: string | null,
  overrides: RunOverrides,
  update: (fn: OverridesUpdate) => void,
): ComposerActions {
  const [saving, setSaving] = useState<PassName | 'all' | null>(null)
  const current = useRef(overrides)
  current.current = overrides

  const saveRow = useCallback(
    async (pass: PassName): Promise<void> => {
      const row = passOverride(current.current, pass)
      if (folder === null || row === undefined) return
      const label = stepLabel(pass)
      setSaving(pass)
      const r = await invoke('config.save', {
        scope: 'project',
        folder,
        overrides: current.current,
        mode: 'row',
        pass,
      })
      setSaving(null)
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      update((o) => dropPass(o, pass))
      const res = r.value
      if (!res.changed) {
        toast({ level: 'info', message: `${label} already matches ${res.path}` })
        return
      }
      const written = leafPointers({ passes: { [pass]: row } })
      toast({
        level: 'info',
        message: `Saved ${label} to ${res.path}`,
        action: {
          label: 'Undo',
          onClick: async () => {
            if (await undoWrite(folder, res, written)) update((o) => restorePass(o, pass, row))
          },
        },
      })
    },
    [folder, update],
  )

  const resetRow = useCallback(
    (pass: PassName): void => {
      const row = passOverride(current.current, pass)
      if (row === undefined) return
      update((o) => dropPass(o, pass))
      toast({
        level: 'info',
        message: `${stepLabel(pass)} reset to the folder's settings`,
        action: { label: 'Undo', onClick: () => update((o) => restorePass(o, pass, row)) },
      })
    },
    [update],
  )

  const saveAll = useCallback(async (): Promise<void> => {
    // The run's Tools are for this run only: they are never saved, and stay pending after the save.
    const all = withoutTools(current.current)
    if (folder === null || isEmptyOverrides(all)) return
    setSaving('all')
    const r = await invoke('config.save', {
      scope: 'project',
      folder,
      overrides: all,
      mode: 'projectDefault',
    })
    setSaving(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    update((o) => (o.tools !== undefined ? { tools: o.tools } : NO_OVERRIDES))
    const res = r.value
    if (!res.changed) {
      toast({ level: 'info', message: `The project default already matches: ${res.path}` })
      return
    }
    const written = leafPointers(all)
    toast({
      level: 'info',
      message: `Saved as the project default in ${res.path}`,
      action: {
        label: 'Undo',
        onClick: async () => {
          if (await undoWrite(folder, res, written))
            update((o) => ({ ...all, ...(o.tools !== undefined ? { tools: o.tools } : {}) }))
        },
      },
    })
  }, [folder, update])

  const swapCritic = useCallback(
    (to: string, label: string): void => {
      const before = passOverride(current.current, 'critic')
      const values: PassValues = { vendor: to, model: null }
      update((o) => setPassValues(o, 'critic', values))
      toast({
        level: 'info',
        message: `Critic runs on ${label} for this run`,
        action: { label: 'Undo', onClick: () => update((o) => restorePass(o, 'critic', before)) },
      })
    },
    [update],
  )

  return { saving, saveRow, resetRow, saveAll, swapCritic }
}
