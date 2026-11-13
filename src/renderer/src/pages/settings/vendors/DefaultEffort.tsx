// A vendor's default effort level (config `vendors.<id>.defaultEffort`, used by passes that set none), next to its
// default model. The levels are the ones the default model lists (else every level the vendor's models list), from
// vendors.models or the probe (read once by the card for both). Choosing writes the user file with config.patch, with Undo. Only vendors with an
// effort setting (shared supportsEffort) show it.
import { useState } from 'react'
import type { ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../../ipc/client.ts'
import { toast } from '../../../state/toasts.ts'
import { EffortSelect } from '../../dashboard/composer/EffortSelect.tsx'
import type { Row } from './DefaultModel.tsx'
import { setOrRemove, vendorPointer } from './userConfig.ts'

export function DefaultEffort({
  view,
  models,
  model,
  current,
  onSaved,
}: {
  view: ProbeView
  /** The vendor's models (DefaultModel.tsx useModels): the levels come with them. */
  models: readonly Row[]
  /** The vendor's default model as the user set it (null/undefined: the CLI's default model). */
  model: string | null | undefined
  /** The user's setting: undefined when not set, null for the default effort. */
  current: string | null | undefined
  onSaved: () => void
}): React.JSX.Element {
  const [shown, setShown] = useState<string | null | undefined>(current)
  const [busy, setBusy] = useState(false)
  const pointer = vendorPointer(view.vendor, 'defaultEffort')

  const patch = async (next: string | null | undefined): Promise<boolean> => {
    const r = await invoke('config.patch', { scope: 'user', ops: setOrRemove(pointer, next ?? undefined) })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    return r.ok
  }

  const choose = async (effort: string | null): Promise<void> => {
    const next = effort ?? undefined
    const previous = shown
    if ((next ?? null) === (previous ?? null)) return
    setShown(next)
    setBusy(true)
    const ok = await patch(next)
    setBusy(false)
    if (!ok) {
      setShown(previous)
      return
    }
    onSaved()
    toast({
      level: 'info',
      message:
        next === undefined
          ? `${view.displayName} uses the default effort`
          : `${view.displayName} default effort: ${next}`,
      action: {
        label: 'Undo',
        onClick: async () => {
          if (await patch(previous)) {
            setShown(previous)
            onSaved()
          }
        },
      },
    })
  }

  return (
    <EffortSelect
      id={`vendor-${view.vendor}`}
      label={`${view.displayName} default effort`}
      model={model ?? null}
      value={shown ?? null}
      options={models}
      disabled={busy}
      onChange={(effort) => void choose(effort)}
      className="w-64 max-w-full"
    />
  )
}
