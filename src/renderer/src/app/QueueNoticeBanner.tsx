// The factory's launch notice: a schedule that was due while Dim Factory was closed. Without "resume automatically"
// nothing runs until the user starts it here ([Start queue]: queue.start with the notice's folders, which also
// dismisses it); with it, the notice says the queue went on by itself. Drawn in the banner layer like the other app
// banners, so it moves nothing on the page. Mounting it reads the queues once (queue.get); the `queue` event keeps
// them current for the whole app.
import { CalendarClock } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../components/ui/Button.tsx'
import { invoke } from '../ipc/client.ts'
import { navigate } from '../lib/router.ts'
import { setQueueView, useQueueView } from '../state/queue.ts'
import { toast } from '../state/toasts.ts'
import { Banner } from './Banners.tsx'

export const START_QUEUE_LABEL = 'Start queue'
export const OPEN_QUEUE_LABEL = 'Open Queue'

export function QueueNoticeBanner(): React.JSX.Element | null {
  const view = useQueueView()
  const [busy, setBusy] = useState<'start' | 'dismiss' | null>(null)
  const notice = view?.notice
  if (notice === undefined) return null
  const act = async (what: 'start' | 'dismiss'): Promise<void> => {
    setBusy(what)
    const r =
      what === 'start'
        ? await invoke('queue.start', { folders: notice.folders, noticeId: notice.id })
        : await invoke('queue.dismissNotice', { id: notice.id })
    setBusy(null)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    setQueueView(r.value)
    if (what === 'start') navigate({ name: 'queue' })
  }
  return (
    <Banner
      tone="info"
      icon={CalendarClock}
      testId="queue-notice"
      actions={
        <>
          {notice.kind === 'schedule-due' ? (
            <Button
              size="sm"
              data-testid="queue-notice-start"
              loading={busy === 'start'}
              disabled={busy !== null && busy !== 'start'}
              onClick={() => void act('start')}
            >
              {START_QUEUE_LABEL}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-testid="queue-notice-open"
              onClick={() => navigate({ name: 'queue' })}
            >
              {OPEN_QUEUE_LABEL}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid="queue-notice-dismiss"
            loading={busy === 'dismiss'}
            disabled={busy !== null && busy !== 'dismiss'}
            onClick={() => void act('dismiss')}
          >
            Dismiss
          </Button>
        </>
      }
    >
      <span data-testid="queue-notice-text">{notice.text}</span>
    </Banner>
  )
}
