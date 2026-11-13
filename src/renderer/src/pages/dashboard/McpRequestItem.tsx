// A run an outside agent asked for, in the Needs you strip: who asked, the task, the folder and profile, and
// [Approve] / [Decline]. Approve starts the run as the composer's Run would (core's runs.start with its authoritative
// preflight: a blocked start says why and the request keeps waiting) and opens it; Decline drops the request. The row
// has the strip's fixed height and never wraps: the text gives way to the buttons, and the whole request (with the
// agent's notes) is in its tooltip. Like an ask that moves up the strip, [Approve] and [Decline] take clicks only
// ASK_ARM_MS after the row appears or moves, so the second click of a double click on the row that was there before
// (an ask's Allow) never approves a run the user has not read.
import { Bot, Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ASK_ARM_MS } from '../../components/attention/AskCard.tsx'
import type { McpRunRequest } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { navigate } from '../../lib/router.ts'
import { dropMcpRequest } from '../../state/mcpRequests.ts'
import { toast } from '../../state/toasts.ts'

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? ''

const timeOfDay = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The request in words, for the row's tooltip and its accessible description. */
export function requestDetails(r: McpRunRequest): string {
  return [
    `${r.requestedBy} asks Dim Factory to run:`,
    r.task,
    `Folder: ${r.folder}`,
    `Profile: ${r.profile ?? 'the folder default'}`,
    ...(r.notes !== undefined ? [`Notes from the agent: ${r.notes}`] : []),
    `Requested at ${timeOfDay(r.requestedAt)}; it expires after a day.`,
  ].join('\n')
}

/**
 * True once the row has stayed at `position` for `delayMs`: false again, in the same render, whenever it moves (a click
 * can arrive before any effect runs).
 */
export function useArmedAt(position: number, delayMs: number): boolean {
  const [state, setState] = useState({ position, armed: delayMs <= 0 })
  const moved = state.position !== position
  if (moved) setState({ position, armed: delayMs <= 0 })
  useEffect(() => {
    if (state.armed) return
    const t = setTimeout(
      () => setState((s) => (s.position === position ? { position, armed: true } : s)),
      delayMs,
    )
    return () => clearTimeout(t)
  }, [state.armed, position, delayMs])
  return !moved && state.armed
}

export function McpRequestItem({
  request: r,
  position,
  className,
}: {
  request: McpRunRequest
  /** The row's place in the Needs you strip (it arms again whenever this changes). */
  position: number
  className?: string
}): React.JSX.Element {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const armed = useArmedAt(position, ASK_ARM_MS)
  const details = requestDetails(r)
  const approve = async (): Promise<void> => {
    if (!armed) return
    setBusy('approve')
    const res = await invoke('mcp.requests.approve', { id: r.id })
    setBusy(null)
    if (!res.ok) {
      toast({ level: 'error', message: `The run did not start: ${res.error.message}` })
      return
    }
    dropMcpRequest(r.id)
    navigate({ name: 'run', runId: res.value.runId })
  }
  const decline = async (): Promise<void> => {
    if (!armed) return
    setBusy('decline')
    const res = await invoke('mcp.requests.decline', { id: r.id })
    setBusy(null)
    if (!res.ok) {
      toast({ level: 'error', message: res.error.message })
      return
    }
    dropMcpRequest(r.id)
    toast({ level: 'info', message: `Declined the request from ${r.requestedBy}.` })
  }
  return (
    <li
      data-testid={`needs-you-request-${r.id}`}
      data-kind="request"
      data-armed={armed || undefined}
      title={details}
      className={cn('flex items-center gap-3 rounded-lg border bg-card px-3', className)}
    >
      <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" data-testid="request-task">
          <span className="text-muted-foreground">{r.requestedBy} asks to run:</span> {firstLine(r.task)}
        </p>
        <p className="truncate text-xs text-muted-foreground" data-testid="request-where">
          {r.folder} · {r.profile !== undefined ? `profile ${r.profile}` : 'default profile'} · requested{' '}
          {timeOfDay(r.requestedAt)}
        </p>
        <span className="sr-only">{details}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          icon={<Check aria-hidden />}
          data-testid="request-approve"
          loading={busy === 'approve'}
          disabled={!armed || busy !== null}
          onClick={() => void approve()}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={<X aria-hidden />}
          data-testid="request-decline"
          loading={busy === 'decline'}
          disabled={!armed || busy !== null}
          onClick={() => void decline()}
        >
          Decline
        </Button>
      </div>
    </li>
  )
}
