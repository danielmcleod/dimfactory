// The ask being answered (AttentionPanel; state rows P8/P9/P9u): title, monospace detail, reason,
// a countdown ring to core's expiresAt (on core's clock) and the queue position. [Allow once A] [Allow for this run
// ⇧A] (absent, with a note, when the vendor cannot allow it for the run) [Deny D] (primary when the vendor defaults
// to no). Labels never change, and a busy answer's spinner covers its key chip, so no button changes size. A/⇧A/D
// work only while focus is inside the card, never while typing. [Switch to Auto ▾] (offerAuto) switches the run to
// Auto, which also approves this ask (AutoSwitch.tsx). Deny starts core's 3 s undo grace; the toast and the
// card both offer Undo. A stale answer (already answered or expired) is reported to the panel, which shows core's
// text in place of a generic error. An ask that moved up from the queue takes answers only after `armDelayMs`, so a
// second press or click meant for the ask before it cannot answer one the user has not seen.
import { MessageCircleQuestion, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ResultError } from '@shared/ipc.ts'
import type { AskView } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { coreNow, coreRemainingMs, useCoreNow } from '../../lib/coreClock.ts'
import { ariaKeyShortcuts, KEYS, useShortcut } from '../../lib/keys.ts'
import { useStream } from '../../lib/streamBuffer.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { cn } from '../../lib/cn.ts'
import { AutoSwitchMenu } from '../run/AutoSwitch.tsx'
import { useBusy } from '../run/commands.ts'
import { JUMP_MARGIN, REGION } from '../run/follow.tsx'
import { Button } from '../ui/Button.tsx'
import { CountdownRing } from '../ui/CountdownRing.tsx'
import { askHeading } from './askText.ts'

/** The undo grace a Deny from the app gets (P9: 3 s app / 0 notification and CLI). */
export const DENY_GRACE_MS = 3000

/** How long an ask that moved up from the queue ignores answers (longer than a double press or double click). */
export const ASK_ARM_MS = 500

export const NO_SESSION_NOTE = 'This tool cannot be allowed for the whole run'

/** Core's answer to an ask that is no longer pending (already answered elsewhere, timed out, withdrawn). */
export function isStaleAnswer(e: ResultError): boolean {
  return e.code === 'NOT_FOUND' || e.code === 'CONFLICT'
}

export type AskDecisionInput = 'allow' | 'allow-session' | 'deny'

/**
 * Asks whose first sight this window remembers, the oldest forgotten past this (otherwise the map would hold every
 * ask the session ever showed). Far more than can be pending at once, so a pending ask's countdown keeps its start.
 */
export const FIRST_SEEN_MAX = 200

/** First sight of an ask (core time), by run and request: request ids are the vendor's and may repeat across runs. */
const firstSeen = new Map<string, number>()

/** When this window first showed the ask: `start` the first time, the remembered time after that. */
export function firstSeenAt(runId: string, requestId: string, start: number): number {
  const key = `${runId}\n${requestId}`
  const seen = firstSeen.get(key)
  if (seen !== undefined) return seen
  firstSeen.set(key, start)
  if (firstSeen.size > FIRST_SEEN_MAX) {
    const oldest = firstSeen.keys().next()
    if (oldest.done !== true) firstSeen.delete(oldest.value)
  }
  return start
}

/** Tests: how many asks' first sights are remembered. */
export function firstSeenCount(): number {
  return firstSeen.size
}

/** The countdown's full length: from the ask's stream marker (core time) when loaded, else from first sight here. */
function useAskTotal(ask: AskView): number {
  const s = useStream(ask.runId, ask.step, ask.attempt)
  const block = s.blocks.find((b) => b.kind === 'ask' && b.requestId === ask.requestId)
  const start =
    block?.ts ?? firstSeenAt(ask.runId, ask.requestId, ask.expiresAt - coreRemainingMs(ask.expiresAt))
  return Math.max(1000, ask.expiresAt - start)
}

export interface AskCardProps {
  ask: AskView
  /** Pending asks of other steps of this run. */
  more: number
  /** Core said the ask is no longer pending; `message` is core's text. */
  onStale: (requestId: string, message: string) => void
  /** Keys and buttons answer only after this long (an ask that moved up from the queue); 0 = at once. */
  armDelayMs?: number
  /** Offer [Switch to Auto ▾] beside the answers (an Implement or Fix ask in a run outside Auto). */
  offerAuto?: boolean
}

/** False for `delayMs` after mount, then true (the Dashboard's needs-you strip arms a row that moved up the same way). */
export function useArmed(delayMs: number): boolean {
  const [armed, setArmed] = useState(delayMs <= 0)
  useEffect(() => {
    if (armed) return
    const t = setTimeout(() => setArmed(true), delayMs)
    return () => clearTimeout(t)
  }, [armed, delayMs])
  return armed
}

export function AskCard({
  ask,
  more,
  onStale,
  armDelayMs = 0,
  offerAuto = false,
}: AskCardProps): React.JSX.Element {
  const total = useAskTotal(ask)
  const armed = useArmed(armDelayMs)
  // Re-render with the shared ticker, but read core's clock now: the grace is seconds long.
  useCoreNow()
  const now = coreNow()
  const pendingDeny = ask.pendingDenyUntil !== undefined && ask.pendingDenyUntil > now
  const [busy, run] = useBusy()
  const { runId, requestId } = ask

  const send = async (cmd: 'asks.answer' | 'asks.undo', decision?: AskDecisionInput): Promise<boolean> => {
    const r =
      cmd === 'asks.undo'
        ? await invoke('asks.undo', { runId, requestId })
        : await invoke('asks.answer', {
            runId,
            requestId,
            decision: decision ?? 'allow',
            ...(decision === 'deny' ? { graceMs: DENY_GRACE_MS } : {}),
          })
    void fetchSnapshot(runId)
    if (r.ok) return true
    if (isStaleAnswer(r.error)) onStale(requestId, r.error.message)
    else toast({ level: 'error', message: r.error.message })
    return false
  }

  const answer = (decision: AskDecisionInput): void => {
    if (pendingDeny || !armed) return
    run(decision, async () => {
      const ok = await send('asks.answer', decision)
      if (ok && decision === 'deny') {
        toast({
          id: `deny:${requestId}`,
          level: 'info',
          message: 'Denied · Undo',
          durationMs: DENY_GRACE_MS,
          action: { label: 'Undo', call: { cmd: 'asks.undo', req: { runId, requestId } } },
        })
      }
    })
  }
  const undo = (): void => run('undo', () => send('asks.undo'))

  useShortcut(KEYS.allowOnce, () => answer('allow'), { scope: 'ask', description: 'Allow once' })
  useShortcut(KEYS.allowForRun, () => answer('allow-session'), {
    scope: 'ask',
    description: 'Allow for this run',
    enabled: ask.allowSession,
  })
  useShortcut(KEYS.deny, () => answer('deny'), { scope: 'ask', description: 'Deny' })

  const denyFirst = ask.defaultToNo === true
  const disabled = (tag: string): boolean => !armed || pendingDeny || (busy !== null && busy !== tag)
  const heading = askHeading(ask)
  const detailId = `ask-detail-${requestId}`
  return (
    <section
      data-testid="ask-panel"
      data-key-scope="ask"
      data-request-id={requestId}
      data-armed={armed}
      tabIndex={-1}
      aria-label={heading}
      aria-describedby={detailId}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-st-waiting/50 bg-st-waiting/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        JUMP_MARGIN,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <MessageCircleQuestion aria-hidden className="size-4 text-st-waiting" />
        <h3 className="text-sm font-semibold">{heading}</h3>
        <span className="ml-auto text-xs text-muted-foreground" data-testid="ask-queue">
          {ask.queue.index} of {ask.queue.total}
          {more > 0 ? ` · ${more} more waiting in other steps` : ''}
        </span>
      </header>
      {/* A long command is code: an inner region with a fixed maximum height, so Allow and Deny stay beside it. */}
      <pre
        id={detailId}
        data-testid="ask-detail"
        data-scroll-region="ask-detail"
        className={cn(
          'stream-text max-h-[min(12rem,var(--run-region-max,50vh))] rounded-md bg-muted px-2.5 py-1.5 break-words whitespace-pre-wrap',
          REGION,
        )}
      >
        {ask.detail}
      </pre>
      {ask.reason !== undefined && ask.reason !== '' && (
        <p className="text-sm text-muted-foreground">{ask.reason}</p>
      )}
      {pendingDeny ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="ask-pending-deny">
          {/* One digit (the grace is 3 s) in tabular figures, so the ticking count never moves Undo. */}
          <span className="tabular-nums">
            Denied · sent in {Math.max(0, Math.ceil(((ask.pendingDenyUntil ?? now) - now) / 1000))} s
          </span>
          <Button
            size="sm"
            variant="outline"
            loading={busy === 'undo'}
            icon={<Undo2 aria-hidden />}
            onClick={undo}
            data-testid="ask-undo"
          >
            Undo
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={denyFirst ? 'outline' : 'default'}
            data-testid="ask-allow"
            aria-keyshortcuts={ariaKeyShortcuts(KEYS.allowOnce)}
            loading={busy === 'allow'}
            disabled={disabled('allow')}
            kbd={KEYS.allowOnce}
            onClick={() => answer('allow')}
          >
            Allow once
          </Button>
          {ask.allowSession ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="ask-allow-session"
              aria-keyshortcuts={ariaKeyShortcuts(KEYS.allowForRun)}
              loading={busy === 'allow-session'}
              disabled={disabled('allow-session')}
              kbd={KEYS.allowForRun}
              onClick={() => answer('allow-session')}
            >
              Allow for this run
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={denyFirst ? 'default' : 'outline'}
            data-testid="ask-deny"
            aria-keyshortcuts={ariaKeyShortcuts(KEYS.deny)}
            loading={busy === 'deny'}
            disabled={disabled('deny')}
            kbd={KEYS.deny}
            onClick={() => answer('deny')}
          >
            Deny
          </Button>
          {!ask.allowSession && (
            <span className="text-xs text-muted-foreground" data-testid="ask-no-session">
              {NO_SESSION_NOTE}
            </span>
          )}
          {offerAuto && <AutoSwitchMenu runId={runId} form="ask" />}
          <span className="ml-auto" data-testid="ask-countdown" data-expires-at={ask.expiresAt}>
            <CountdownRing expiresAt={ask.expiresAt} totalMs={total} showLabel />
          </span>
        </div>
      )}
    </section>
  )
}
