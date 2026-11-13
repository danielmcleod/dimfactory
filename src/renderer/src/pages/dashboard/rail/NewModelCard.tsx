// The Dashboard's new-model card: when a catalog update added a model that no match has tried yet, offer to try it on
// a few past tasks. Core chooses them (matches.offers: up to five finished runs another builder made, cheapest first)
// and says about what they cost; "Add to the queue" puts them in the queue as rematches with the names hidden, where
// the budgets, the schedule and the stop rules apply as they do to tasks. Nothing is applied to a folder. "Not now"
// sets the model aside for good. The card is the rail's last, so its coming and going moves nothing else, and its
// lines and buttons keep their sizes.
import { Swords } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { NewModelOffer } from '@shared/match.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { invoke } from '../../../ipc/client.ts'
import { formatUsd, vendorName } from '../../../lib/format.ts'
import { navigate } from '../../../lib/router.ts'
import { useCatalogEpoch } from '../../../state/catalog.ts'
import { toast } from '../../../state/toasts.ts'

export const NEW_MODEL_ADD = 'Add to the queue'
export const NEW_MODEL_LATER = 'Not now'
export const NEW_MODEL_NOTE =
  'They go into the queue as rematches with the names hidden. Nothing is applied to your folders.'

/** `New model: Codex (gpt-x)`. */
export function newModelTitle(o: Pick<NewModelOffer, 'vendor' | 'model'>): string {
  return `New model: ${vendorName(o.vendor)} (${o.model})`
}

/** `Try it on 4 of your past tasks, about $3.20.` */
export function newModelLine(o: Pick<NewModelOffer, 'plan'>): string {
  const n = o.plan.items.length
  const cost = o.plan.totalUsd !== null ? `, about ${formatUsd(o.plan.totalUsd)}` : ''
  return `Try it on ${n} of your past ${n === 1 ? 'task' : 'tasks'}${cost}.`
}

export function NewModelCard(): React.JSX.Element | null {
  const [offers, setOffers] = useState<NewModelOffer[]>([])
  const [busy, setBusy] = useState<'add' | 'later' | null>(null)
  const epoch = useCatalogEpoch()
  const load = useCallback(async (): Promise<void> => {
    const r = await invoke('matches.offers')
    if (r.ok) setOffers(r.value)
  }, [])
  // On the Dashboard's first paint and after every catalog change.
  useEffect(() => {
    void load()
  }, [load, epoch])

  const offer = offers[0]
  if (offer === undefined) return null
  const challenger = { vendor: offer.vendor, model: offer.model }
  const add = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('add')
    const r = await invoke('matches.batchAdd', { challenger, runIds: offer.plan.items.map((i) => i.runId) })
    if (!r.ok) {
      setBusy(null)
      toast({ level: 'error', message: r.error.message })
      return
    }
    // Asked once: the model is not offered again.
    await invoke('matches.dismissOffer', challenger)
    setBusy(null)
    toast({
      level: 'info',
      message:
        r.value.added === 1 ? '1 rematch is in the queue.' : `${r.value.added} rematches are in the queue.`,
    })
    navigate({ name: 'queue' })
  }
  const later = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('later')
    await invoke('matches.dismissOffer', challenger)
    setBusy(null)
    await load()
  }
  const title = newModelTitle(offer)
  const line = newModelLine(offer)
  return (
    <section
      data-testid="new-model-card"
      aria-labelledby="new-model-title"
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <h2 id="new-model-title" className="flex h-5 min-w-0 items-center gap-2 text-sm font-medium">
        <Swords aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate" title={title}>
          {title}
        </span>
      </h2>
      <p data-testid="new-model-line" className="min-h-4 text-xs" title={line}>
        {line}
      </p>
      <p className="min-h-4 text-xs text-muted-foreground" title={NEW_MODEL_NOTE}>
        {NEW_MODEL_NOTE}
      </p>
      <div className="flex h-7 items-center gap-2">
        <Button
          data-testid="new-model-add"
          size="sm"
          disabled={busy !== null}
          loading={busy === 'add'}
          onClick={() => void add()}
        >
          {NEW_MODEL_ADD}
        </Button>
        <Button
          data-testid="new-model-later"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          loading={busy === 'later'}
          onClick={() => void later()}
        >
          {NEW_MODEL_LATER}
        </Button>
      </div>
    </section>
  )
}
