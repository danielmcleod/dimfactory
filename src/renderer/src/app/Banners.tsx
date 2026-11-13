// App-level banners (the heartbeat, quit and crash recovery): lost contact with main, a quit request
// while runs are active, and runs paused because Dim Factory closed. They are drawn over the top of the page (Shell's
// banner layer), never in its flow (UI standard: one scroll region per screen, and nothing moves on its own): one
// arriving or going moves nothing on the page.
import { AlertTriangle, PauseCircle, Power, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../components/ui/Button.tsx'
import { DisabledHint } from '../components/ui/DisabledHint.tsx'
import { invoke } from '../ipc/client.ts'
import { cn } from '../lib/cn.ts'
import { navigate } from '../lib/router.ts'
import { dismissNotice, setQuitRequested } from '../state/actions.ts'
import { useBridgeState, useLostContact, useNotices, useQuitRequested } from '../state/selectors.ts'
import type { RecoveredNotice } from '../state/store.ts'
import { toast } from '../state/toasts.ts'

export function Banner({
  tone,
  icon: Icon,
  children,
  actions,
  role = 'status',
  testId,
}: {
  tone: 'warn' | 'info' | 'error'
  icon: typeof AlertTriangle
  children: React.ReactNode
  actions?: React.ReactNode
  role?: 'status' | 'alert'
  testId: string
}): React.JSX.Element {
  return (
    <div
      role={role}
      data-testid={testId}
      // An opaque card over the page: the tone is its border and icon, so the page never shows through.
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-lg border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg',
        tone === 'error' && 'border-destructive/50',
        tone === 'warn' && 'border-warning/50',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          tone === 'error' && 'text-destructive',
          tone === 'warn' && 'text-warning',
          tone === 'info' && 'text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1">{children}</div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function LostContactBanner(): React.JSX.Element | null {
  const lost = useLostContact()
  const bridge = useBridgeState()
  if (!lost) return null
  const detail =
    bridge === 'unavailable'
      ? 'This window could not connect to it. Reload the window, or restart Dim Factory.'
      : 'Runs keep going in the background. This message goes away as soon as it responds again.'
  return (
    <Banner
      tone="error"
      icon={Unplug}
      role="alert"
      testId="lost-contact"
      actions={
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload window
        </Button>
      }
    >
      <span className="font-medium">Lost contact with Dim Factory&apos;s main process.</span> {detail}
    </Banner>
  )
}

export function QuitRequestedBanner(): React.JSX.Element | null {
  const q = useQuitRequested()
  const [busy, setBusy] = useState(false)
  if (q === null) return null
  const n = q.activeRuns
  const quit = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('app.quit', { confirm: true })
    setBusy(false)
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    else if (!r.value.quitting) setQuitRequested(null)
  }
  return (
    <Banner
      tone="warn"
      icon={AlertTriangle}
      role="alert"
      testId="quit-requested"
      actions={
        <>
          <Button
            size="sm"
            variant="destructive"
            icon={<Power aria-hidden />}
            loading={busy}
            onClick={() => void quit()}
          >
            Quit
          </Button>
          <Button size="sm" variant="outline" onClick={() => setQuitRequested(null)}>
            Keep running
          </Button>
        </>
      }
    >
      {n === 1 ? '1 run is active.' : `${n} runs are active.`} Quit anyway? Active runs are paused and can be
      resumed the next time Dim Factory starts.
    </Banner>
  )
}

function RecoveredBanner({ notice }: { notice: RecoveredNotice }): React.JSX.Element {
  const n = notice.runIds.length
  const first = notice.runIds[0]
  return (
    <Banner
      tone="info"
      icon={PauseCircle}
      testId="recovered-notice"
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={first === undefined}
            onClick={() => {
              if (first !== undefined) navigate({ name: 'run', runId: first })
              dismissNotice(notice.id)
            }}
          >
            Open
          </Button>
          <DisabledHint>
            <Button size="sm" variant="outline" disabled>
              Cancel all
            </Button>
          </DisabledHint>
          <Button size="sm" variant="ghost" onClick={() => dismissNotice(notice.id)}>
            Dismiss
          </Button>
        </>
      }
    >
      {n === 1
        ? '1 run was paused because Dim Factory closed.'
        : `${n} runs were paused because Dim Factory closed.`}{' '}
      Nothing resumes on its own; open a run to resume it.
    </Banner>
  )
}

export function NoticeBanners(): React.JSX.Element {
  const notices = useNotices()
  return (
    <>
      {notices.map((n) => (
        <RecoveredBanner key={n.id} notice={n} />
      ))}
    </>
  )
}
