// Run view test helpers: snapshots with chosen step states, a runs.events double over an in-memory log (same paging
// as core's bus.replay), and a render wrapper with the providers the Run view needs.
import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Req, Res } from '@shared/ipc.ts'
import type { RunEnvelope, RunSnapshot, RunSummary, StepKey, StepView } from '@shared/run.ts'
import { Toaster } from '@renderer/components/ui/Toaster.tsx'
import { TooltipProvider } from '@renderer/components/ui/Tooltip.tsx'
import { makeSnapshot } from '../helpers/fixtures.ts'

export const RUN = 'run-1'

export interface SnapOptions {
  summary?: Partial<RunSummary>
  steps?: Partial<Record<StepKey, Partial<StepView>>>
  lastSeq?: number
  extra?: Partial<Omit<RunSnapshot, 'summary' | 'steps'>>
}

export function snapWith(o: SnapOptions = {}): RunSnapshot {
  const base = makeSnapshot({ runId: RUN, ...o.summary }, o.lastSeq ?? 0)
  const steps = { ...base.steps }
  for (const [k, v] of Object.entries(o.steps ?? {}) as [StepKey, Partial<StepView>][]) {
    steps[k] = { ...steps[k], ...v, key: k }
  }
  return { ...base, ...o.extra, steps }
}

/** runs.events over `log()`: envelopes with seq > sinceSeq, at most `limit`, like core's bus.replay. */
export function eventsHandler(log: () => RunEnvelope[]) {
  return (req: Req<'runs.events'>): Res<'runs.events'> => {
    const all = log()
    const lastSeq = all.at(-1)?.seq ?? 0
    const limit = req.limit ?? 2000
    const events = all.filter((e) => e.seq > req.sinceSeq).slice(0, limit)
    const last = events.at(-1)?.seq ?? req.sinceSeq
    return { events, lastSeq, more: last < lastSeq }
  }
}

export function renderUi(ui: ReactNode): RenderResult {
  return render(
    <TooltipProvider>
      {ui}
      <Toaster />
    </TooltipProvider>,
  )
}

/** Let pending promises (mocked IPC replies) settle. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

export function stubClipboard(): { writes: string[] } {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (t: string) => {
        writes.push(t)
        return Promise.resolve()
      },
    },
  })
  return { writes }
}
