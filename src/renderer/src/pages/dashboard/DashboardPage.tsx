// Dashboard (home): the quick composer on top, then needs-you, active runs and
// recent runs, with the setup card, today's tiles, spend and vendor health in a right rail that stacks below on
// narrow windows. Run cards follow the bridge's live summaries; totals and vendor health come from dashboard.get.
//
// One scroll region per screen (UI standard): the page scrolls in <main> only, the
// composer included (it no longer scrolls inside itself), and the compact Run bar it hangs at the page's top keeps
// the task and Run reachable once it is scrolled past. Sections that core fills in later keep their place: Needs you
// and Active runs are always there (an empty line when there is nothing), and the rail appears whole. The run cards
// keep their places for the visit: a run that ends while the Dashboard is open keeps its card in Active runs (saying
// how it ended) and joins Recent runs on the next visit, and a run that starts goes after the cards already shown.
import { useState } from 'react'
import { useRunIds } from '../../state/selectors.ts'
import { ActiveRunCard } from './ActiveRunCard.tsx'
import { NeedsYouStrip } from './NeedsYouStrip.tsx'
import { QuickComposer } from './QuickComposer.tsx'
import { QueueCard } from './QueueCard.tsx'
import { RecentRuns } from './RecentRuns.tsx'
import { RightRail } from './RightRail.tsx'
import { useDashboardData } from './rail/dashboardData.ts'
import { WelcomeCard } from '../easy/WelcomeCard.tsx'
import { useEasyState } from '../../state/experience.ts'

/**
 * The Active runs cards for this visit, in the order they first showed: the active runs, plus those that have ended
 * since the Dashboard opened (their cards stay until the next visit, so nothing below them moves up on its own).
 */
function useVisitActiveRuns(): { cards: readonly string[]; live: number } {
  const active = useRunIds('active')
  const [cards, setCards] = useState<readonly string[]>(active)
  const fresh = active.filter((id) => !cards.includes(id))
  const next = fresh.length > 0 ? [...cards, ...fresh] : cards
  if (next !== cards) setCards(next)
  return { cards: next, live: active.length }
}

function ActiveRuns({ ids, live }: { ids: readonly string[]; live: number }): React.JSX.Element {
  return (
    <section aria-labelledby="active-heading" data-testid="active-runs" className="flex flex-col gap-2">
      <h2 id="active-heading" className="text-sm font-semibold">
        Active runs{' '}
        {live > 0 && <span className="font-normal text-muted-foreground tabular-nums">{live}</span>}
      </h2>
      {ids.length > 0 ? (
        <div className="flex flex-col gap-2">
          {ids.map((id) => (
            <ActiveRunCard key={id} runId={id} />
          ))}
        </div>
      ) : (
        <p data-testid="active-runs-none" className="text-sm text-muted-foreground">
          No active runs.
        </p>
      )}
    </section>
  )
}

export function DashboardPage(): React.JSX.Element {
  const dashboard = useDashboardData()
  const active = useVisitActiveRuns()
  // A new user is asked once how to use the app, in the composer's place (core decides who is new).
  const ask = useEasyState()?.askWelcome === true
  return (
    <div className="flex min-h-full flex-col">
      <h1 className="sr-only">Dashboard</h1>
      {ask ? <WelcomeCard /> : <QuickComposer />}
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <NeedsYouStrip />
          <ActiveRuns ids={active.cards} live={active.live} />
          <QueueCard />
          <RecentRuns exclude={active.cards} />
        </div>
        <RightRail dashboard={dashboard} />
      </div>
    </div>
  )
}
