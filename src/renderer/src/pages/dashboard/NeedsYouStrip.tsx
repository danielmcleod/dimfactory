// Needs-you strip: core's attention items with their inline actions.
// Asks get Allow / Deny with a countdown (Deny waits 3 s for Undo), gates open the run to review, paused runs resume,
// everything else opens the run.
//
// Items come and go on core's schedule, so the strip never changes height on its own (UI
// standard: nothing moves on its own): it is always there with one slot of a fixed height, which holds the first
// item (one line that never wraps: the text gives way to the actions) or "Nothing needs you". The rest are behind
// "Show N more", which the user opens; the count is in the heading and on the sidebar's Dashboard badge.
//
// Run requests from outside agents (McpRequestItem.tsx) come after core's items, in the same slots: nothing starts until
// the user approves one here.
//
// Double-click guard: an ask that moves up the list (the one before it was answered or left)
// takes clicks only after ASK_ARM_MS, as the Run view's AskCard does, so the second click of a double click on Allow
// or Deny never answers the ask that has just taken the clicked row's place, one the user has not read.
import { Bell, Check, ChevronDown, Play, X } from 'lucide-react'
import { useState } from 'react'
import type { AttentionItem } from '@shared/estimates.ts'
import type { AskKind } from '@shared/events.ts'
import type { Result } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { CountdownRing } from '../../components/ui/CountdownRing.tsx'
import { ASK_ARM_MS, useArmed } from '../../components/attention/AskCard.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { categoryTitle, PAUSE_REASON_LABEL, stepLabel } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { useAttention } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { useMcpRequests } from '../../state/mcpRequests.ts'
import type { McpRunRequest } from '@shared/ipc.ts'
import { McpRequestItem } from './McpRequestItem.tsx'

/** Deny is held this long so the Undo toast can take it back (asks.answer graceMs). */
export const DENY_GRACE_MS = 3000

/** Deny reads Denied while core holds the deny for Undo: both widths reserved, so the button never resizes. */
const DENY_LABELS: readonly string[] = ['Deny', 'Denied']

/** The "more" toggle keeps one width for any count up to 99. */
const MORE_LABELS: readonly string[] = ['Show 00 more', 'Show less']

/** Every item row, and the empty slot, has this height. */
const SLOT = 'h-14'

const ASK_KIND_LABEL: Readonly<Record<AskKind, string>> = {
  edit: 'Wants to edit',
  shell: 'Wants to run',
  network: 'Wants network access',
  other: 'Asks permission',
}

function describe(item: AttentionItem, vendorOf: (step: string) => string | undefined): string {
  switch (item.kind) {
    case 'ask':
      return `${ASK_KIND_LABEL[item.ask.kind]}: ${item.ask.detail}`
    case 'card':
      return item.cardTitle
    case 'stalled':
      return `${stepLabel(item.step)} has had no output for a while`
    case 'paused':
      return `Paused at ${stepLabel(item.step)} · ${PAUSE_REASON_LABEL[item.pause]}`
    case 'failed':
      return `Failed at ${stepLabel(item.step)} · ${categoryTitle(item.category, vendorOf(item.step))}`
  }
}

async function run(p: Promise<Result<unknown>>): Promise<boolean> {
  const r = await p
  if (!r.ok) toast({ level: 'error', message: r.error.message })
  return r.ok
}

function AskActions({
  item,
  armDelayMs,
}: {
  item: Extract<AttentionItem, { kind: 'ask' }>
  /** Clicks answer only after this long (an ask that moved up the list); 0 = at once. */
  armDelayMs: number
}): React.JSX.Element {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const armed = useArmed(armDelayMs)
  const { runId } = item
  const { requestId, expiresAt, pendingDenyUntil } = item.ask
  const allow = async (): Promise<void> => {
    if (!armed) return
    setBusy('allow')
    await run(invoke('asks.answer', { runId, requestId, decision: 'allow' }))
    setBusy(null)
  }
  const deny = async (): Promise<void> => {
    if (!armed) return
    setBusy('deny')
    const ok = await run(
      invoke('asks.answer', { runId, requestId, decision: 'deny', graceMs: DENY_GRACE_MS }),
    )
    setBusy(null)
    if (!ok) return
    toast({
      id: `deny:${runId}:${requestId}`,
      level: 'info',
      message: 'Denied · Undo (3 s)',
      durationMs: DENY_GRACE_MS,
      action: { label: 'Undo', call: { cmd: 'asks.undo', req: { runId, requestId } } },
    })
  }
  const denied = pendingDenyUntil !== undefined
  return (
    <>
      <CountdownRing expiresAt={expiresAt} totalMs={Math.max(1, expiresAt - item.since)} showLabel />
      <Button
        size="sm"
        icon={<Check aria-hidden />}
        loading={busy === 'allow'}
        disabled={!armed || busy !== null || denied}
        onClick={() => void allow()}
      >
        Allow
      </Button>
      <Button
        size="sm"
        variant="outline"
        icon={<X aria-hidden />}
        labels={DENY_LABELS}
        loading={busy === 'deny'}
        disabled={!armed || busy !== null || denied}
        onClick={() => void deny()}
      >
        {denied ? 'Denied' : 'Deny'}
      </Button>
    </>
  )
}

function ResumeButton({ runId }: { runId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      icon={<Play aria-hidden />}
      loading={busy}
      onClick={() => {
        setBusy(true)
        void run(invoke('runs.resume', { runId })).finally(() => setBusy(false))
      }}
    >
      Resume
    </Button>
  )
}

function OpenButton({ runId, label = 'Open' }: { runId: string; label?: string }): React.JSX.Element {
  return (
    <Button size="sm" variant={label === 'Open' ? 'outline' : 'default'} asChild>
      <a href={href({ name: 'run', runId })}>{label}</a>
    </Button>
  )
}

function Actions({ item, moves }: { item: AttentionItem; moves: number }): React.JSX.Element {
  switch (item.kind) {
    case 'ask':
      // A new key per move: the row arms again each time it moves up (its first render counts from 0).
      return <AskActions key={moves} item={item} armDelayMs={moves > 0 ? ASK_ARM_MS : 0} />
    case 'card':
      if (item.cardKind === 'gate:afterPlan') return <OpenButton runId={item.runId} label="Review plan" />
      if (item.cardKind === 'gate:beforeFix') return <OpenButton runId={item.runId} label="Review findings" />
      // Clarify's questions are answered in the Run view, where the card shows each question and its options.
      if (item.cardKind === 'clarify') return <OpenButton runId={item.runId} label="Answer questions" />
      // Research's findings are reviewed in the Run view, where the card lists each item with its sources.
      if (item.cardKind === 'research') return <OpenButton runId={item.runId} label="Review research" />
      return <OpenButton runId={item.runId} />
    case 'paused':
      return (
        <>
          <ResumeButton runId={item.runId} />
          <OpenButton runId={item.runId} />
        </>
      )
    case 'failed':
    case 'stalled':
      return <OpenButton runId={item.runId} />
  }
}

function Item({ item, moves = 0 }: { item: AttentionItem; moves?: number }): React.JSX.Element {
  const steps = useStore((s) => s.summaries.byId[item.runId]?.steps)
  const vendorOf = (step: string): string | undefined => steps?.find((st) => st.key === step)?.vendor
  return (
    <li
      data-testid={`needs-you-${item.id}`}
      data-kind={item.kind}
      data-moved={moves > 0 || undefined}
      className={cn('flex items-center gap-3 rounded-lg border bg-card px-3', SLOT)}
    >
      <div className="min-w-0 flex-1">
        <a
          href={href({ name: 'run', runId: item.runId })}
          title={`#${item.displayNo} ${item.title}`}
          className="block truncate text-sm font-medium hover:underline"
        >
          <span className="text-muted-foreground tabular-nums">#{item.displayNo}</span> {item.title}
        </a>
        <p className="truncate text-xs text-muted-foreground" title={describe(item, vendorOf)}>
          {describe(item, vendorOf)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Actions item={item} moves={moves} />
      </div>
    </li>
  )
}

/**
 * How many times each ask has moved up the list (one ahead of it left), computed from the previous render's list so a
 * row mounts with it: a click can arrive before any effect runs. An ask that never moved is absent.
 */
function useMoves(items: readonly AttentionItem[]): ReadonlyMap<string, number> {
  const [seen, setSeen] = useState<{ items: readonly AttentionItem[]; moves: ReadonlyMap<string, number> }>(
    () => ({ items, moves: new Map() }),
  )
  if (seen.items === items) return seen.moves
  const before = new Map(seen.items.map((it, i) => [it.id, i] as const))
  const moves = new Map<string, number>()
  items.forEach((it, i) => {
    const prev = seen.moves.get(it.id) ?? 0
    const was = before.get(it.id)
    const up = it.kind === 'ask' && was !== undefined && was > i
    if (up || prev > 0) moves.set(it.id, prev + (up ? 1 : 0))
  })
  setSeen({ items, moves })
  return moves
}

type Entry = { kind: 'item'; item: AttentionItem } | { kind: 'request'; request: McpRunRequest }

function EntryRow({
  entry,
  moves,
  position,
}: {
  entry: Entry
  moves: ReadonlyMap<string, number>
  /** The row's place in the strip (a request row arms again whenever it changes). */
  position: number
}): React.JSX.Element {
  if (entry.kind === 'request')
    return <McpRequestItem request={entry.request} position={position} className={SLOT} />
  return <Item item={entry.item} moves={moves.get(entry.item.id) ?? 0} />
}

const entryKey = (e: Entry): string => (e.kind === 'item' ? e.item.id : `request:${e.request.id}`)

export function NeedsYouStrip(): React.JSX.Element {
  const { needsYou: attentionCount, items } = useAttention()
  const requests = useMcpRequests()
  const moves = useMoves(items)
  const [more, setMore] = useState(false)
  const entries: Entry[] = [
    ...items.map((item): Entry => ({ kind: 'item', item })),
    ...requests.map((request): Entry => ({ kind: 'request', request })),
  ]
  const needsYou = attentionCount + requests.length
  const lead = entries[0]
  const rest = entries.slice(1)
  // Nothing more to show closes the list, so the next item to arrive waits behind "Show N more" again.
  if (more && rest.length === 0) setMore(false)
  const open = more && rest.length > 0
  return (
    <section
      aria-labelledby="needs-you-heading"
      data-testid="needs-you"
      data-count={attentionCount}
      data-requests={requests.length}
      className="flex flex-col gap-2"
    >
      <div className="flex h-6 items-center gap-2">
        <h2 id="needs-you-heading" className="flex items-center gap-2 text-sm font-semibold">
          <Bell
            aria-hidden
            className={cn('size-4', needsYou > 0 ? 'text-st-waiting' : 'text-muted-foreground')}
          />
          Needs you
          {needsYou > 0 && (
            <span className="rounded-full bg-st-waiting px-1.5 text-[11px] text-background tabular-nums">
              {needsYou}
            </span>
          )}
        </h2>
        {rest.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="needs-you-more"
            aria-expanded={open}
            icon={<ChevronDown aria-hidden className={cn('transition-transform', open && 'rotate-180')} />}
            labels={MORE_LABELS}
            onClick={() => setMore((v) => !v)}
            className="ml-auto h-6 text-xs tabular-nums"
          >
            {open ? 'Show less' : `Show ${rest.length} more`}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {lead !== undefined ? (
          <EntryRow key={entryKey(lead)} entry={lead} moves={moves} position={0} />
        ) : (
          <li
            data-testid="needs-you-none"
            className={cn(
              'flex items-center rounded-lg border border-dashed px-3 text-sm text-muted-foreground',
              SLOT,
            )}
          >
            Nothing needs you right now.
          </li>
        )}
        {open && rest.map((e, i) => <EntryRow key={entryKey(e)} entry={e} moves={moves} position={i + 1} />)}
      </ul>
    </section>
  )
}
