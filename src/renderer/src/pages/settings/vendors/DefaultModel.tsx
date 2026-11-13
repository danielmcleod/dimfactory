// A vendor's default model (config `vendors.<id>.defaultModel`,
// used by passes whose model is null). The list is vendors.models (the CLI's models + the catalog, with a "no pricing"
// note), or the probe's models when that is not available. Choosing writes the user file with config.patch, with Undo.
// The trigger is one width, so a long choice (Gemini's "The CLI's default (gemini-3-pro-preview)") is cut with an
// ellipsis; its tooltip says it in full (UI standard: text cut with an ellipsis says itself in full).
import { useEffect, useState } from 'react'
import type { ModelInfo, ModelOption, ProbeView } from '@shared/vendors.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { invoke } from '../../../ipc/client.ts'
import { useCatalogEpoch } from '../../../state/catalog.ts'
import { toast } from '../../../state/toasts.ts'
import { setOrRemove, vendorPointer } from './userConfig.ts'

/** Select value for "no default model: the CLI decides" (Radix Select reserves the empty string). */
export const CLI_DEFAULT = '__cli_default__'

export type Row = Pick<ModelOption, 'id' | 'label' | 'isDefault' | 'aliases' | 'efforts'> & {
  hasPricing?: boolean
}

function rowsFromProbe(models: readonly ModelInfo[]): Row[] {
  return models.map((m) => ({
    id: m.id,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
    ...(m.aliases !== undefined ? { aliases: m.aliases } : {}),
    ...(m.efforts !== undefined ? { efforts: m.efforts } : {}),
  }))
}

/** The vendor's models: vendors.models, else (until it answers, or without it) the probe's. */
export function useModels(view: ProbeView): Row[] {
  const [listed, setListed] = useState<Row[] | null>(null)
  // Read again when the catalog changes (an applied update can add models or prices).
  const catalogEpoch = useCatalogEpoch()
  useEffect(() => {
    let alive = true
    void invoke('vendors.models', { vendor: view.vendor }).then((r) => {
      if (alive && r.ok) setListed(r.value)
    })
    return () => {
      alive = false
    }
  }, [view.vendor, catalogEpoch])
  return listed ?? rowsFromProbe(view.probe?.models ?? [])
}

function modelText(m: Row): string {
  const name = m.label !== undefined && m.label !== m.id ? `${m.label} (${m.id})` : m.id
  return m.hasPricing === false ? `${name} · no pricing` : name
}

/** The "no default model" choice: the CLI's own default, named when the CLI says which it is. */
export function cliDefaultText(cliDefault: Pick<Row, 'id'> | undefined): string {
  return cliDefault !== undefined ? `The CLI's default (${cliDefault.id})` : "The CLI's default"
}

export function DefaultModel({
  view,
  models,
  current,
  triggerId,
  onSaved,
}: {
  view: ProbeView
  /** The vendor's models (useModels; the card reads them once for this and the default effort). */
  models: readonly Row[]
  /** The user's setting: undefined when not set, null for the CLI default. */
  current: string | null | undefined
  triggerId: string
  onSaved: () => void
}): React.JSX.Element {
  const [shown, setShown] = useState<string | null | undefined>(current)
  const [busy, setBusy] = useState(false)
  const value = shown ?? CLI_DEFAULT
  const cliDefault = models.find((m) => m.isDefault === true)
  const rows =
    shown !== undefined && shown !== null && !models.some((m) => m.id === shown)
      ? [{ id: shown }, ...models]
      : models
  const pointer = vendorPointer(view.vendor, 'defaultModel')
  const chosen = rows.find((m) => m.id === value)
  const chosenText =
    value === CLI_DEFAULT ? cliDefaultText(cliDefault) : chosen !== undefined ? modelText(chosen) : value

  const patch = async (next: string | null | undefined): Promise<boolean> => {
    const r = await invoke('config.patch', { scope: 'user', ops: setOrRemove(pointer, next ?? undefined) })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    return r.ok
  }

  const choose = async (v: string): Promise<void> => {
    const next = v === CLI_DEFAULT ? undefined : v
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
          ? `${view.displayName} uses the CLI's default model`
          : `${view.displayName} default model: ${next}`,
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
    <Select value={value} onValueChange={(v) => void choose(v)} disabled={busy}>
      <SelectTrigger
        id={triggerId}
        size="sm"
        className="w-64 max-w-full"
        data-testid={`vendor-default-model-${view.vendor}`}
        aria-label={`${view.displayName} default model`}
        title={chosenText}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLI_DEFAULT}>{cliDefaultText(cliDefault)}</SelectItem>
        {rows.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {modelText(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
