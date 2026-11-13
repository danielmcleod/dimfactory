// The Dashboard's Queue card: the factory at a glance (whether a queue runs or is paused and why, the tasks pending,
// working, needing you, done and failed over every queue, today's spending against the daily budget) and a link to
// the Queue page. It is there from the first paint with lines of fixed height, so core's answer fills them in place
// and nothing below moves. Core's figures only (the `queue` event and queue.get).
import { Factory } from 'lucide-react'
import type { QueueView } from '@shared/factory.ts'
import { formatUsd } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { useQueueStore } from '../../state/queue.ts'

/** "2 queues running, 1 paused" / "No queue is running" / "No queues yet". */
export function queueStateLine(v: QueueView): string {
  if (v.folders.length === 0) return 'No queues yet. Queue tasks to run one after another.'
  const running = v.folders.filter((f) => f.state === 'running').length
  const paused = v.folders.filter((f) => f.state === 'paused')
  if (paused.length > 0) {
    const first = paused[0]?.pause?.text
    return `${paused.length === 1 ? 'A queue is' : `${paused.length} queues are`} paused${first !== undefined ? `: ${first}` : '.'}`
  }
  if (running > 0) return running === 1 ? 'A queue is running.' : `${running} queues are running.`
  return 'No queue is running.'
}

export function queueCountsLine(v: QueueView): string {
  let pending = 0
  let running = 0
  let waiting = 0
  let done = 0
  let failed = 0
  for (const f of v.folders) {
    pending += f.counts.pending
    running += f.counts.running
    waiting += f.counts.waiting
    done += f.counts.done
    failed += f.counts.failed + f.counts.stopped
  }
  return `${pending} pending, ${running} running, ${waiting} need you, ${done} done, ${failed} failed or stopped.`
}

export function spendLine(v: QueueView): string {
  const cap = v.limits.maxCostPerDayUsd
  return `Today ${formatUsd(v.today.spentUsd)}${cap !== null ? ` of ${formatUsd(cap)}` : ' (no daily budget)'}.`
}

export function QueueCard(): React.JSX.Element {
  const view = useQueueStore((s) => s.view)
  return (
    <section
      aria-labelledby="queue-card-heading"
      data-testid="queue-card"
      className="flex flex-col gap-1 rounded-lg border p-3"
    >
      <div className="flex items-center gap-2">
        <Factory aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 id="queue-card-heading" className="min-w-0 flex-1 text-sm font-semibold">
          Queue
        </h2>
        <a
          href={href({ name: 'queue' })}
          data-testid="queue-card-open"
          className="text-xs underline underline-offset-2"
        >
          Open Queue
        </a>
      </div>
      <p
        data-testid="queue-card-state"
        className="min-h-5 truncate text-sm"
        title={view !== null ? queueStateLine(view) : undefined}
      >
        {view !== null ? queueStateLine(view) : ''}
      </p>
      <p data-testid="queue-card-counts" className="min-h-4 text-xs text-muted-foreground">
        {view !== null && view.folders.length > 0 ? queueCountsLine(view) : ''}
      </p>
      <p data-testid="queue-card-spend" className="min-h-4 text-xs text-muted-foreground">
        {view !== null ? spendLine(view) : ''}
      </p>
    </section>
  )
}
