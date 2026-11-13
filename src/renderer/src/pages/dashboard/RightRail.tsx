// Dashboard right rail: the setup card while vendors need setting up,
// today's tiles and 7-day spend from dashboard.get, vendor health with Re-probe, and last the catalog consent card
// when a price refresh is due or runs. Every figure is core's; the renderer adds up no costs or counts. The
// consent card comes last because core's scheduler can raise it at any time and a job changes it: there, its coming,
// going and changing height move nothing else.
//
// Nothing moves on its own (UI standard): which cards the rail holds and how long the
// spend list is depend on state.json and dashboard.get, which answer after the first paint. So the rail keeps its
// place but stays invisible until both have answered (or RAIL_WAIT_MS passed), then appears whole, instead of
// growing card by card. It is a column of its own (or the last thing on a narrow page), so its appearing moves
// nothing else. When the setup card will show (state.json's setupDismissed is false), the rail also waits
// for Claude's and Codex's first probe answers (at most RAIL_PROBE_WAIT_MS): a vendor row that said "Checking Codex…"
// grew to Codex's install fixes when the answer landed seconds after the rail showed, and pushed the git row, the
// profile line, the sandbox chip and every card below them down (ui-layout.spec.ts "the Dashboard as it loaded", CLS 0.03).
// Whether the setup card shows is still decided when state.json and dashboard.get have answered (or RAIL_WAIT_MS
// passed): on a launch whose probes are still running the card shows (it streams them and names the
// profile first launch chose, first-launch.spec.ts), even when both vendors then answer ready. Only its showing waits.
import { useEffect, useState } from 'react'
import { reloadDashboard } from './rail/dashboardData.ts'
import type { DashboardState } from './rail/dashboardData.ts'
import { CatalogCard } from './rail/CatalogCard.tsx'
import { NewModelCard } from './rail/NewModelCard.tsx'
import { SetupCard, primaryProbePending, useSetupDismissed, useSetupKnown } from './rail/SetupCard.tsx'
import { SummaryTiles } from './rail/SummaryTiles.tsx'
import { VendorHealthList } from './rail/VendorHealthList.tsx'
import { useProbes } from '../../state/selectors.ts'

/** The longest the rail waits for dashboard.get before it shows what it has (state.json answered). */
export const RAIL_WAIT_MS = 1500
/**
 * The longest it waits for state.json, and for Claude's and Codex's first probe answers while the setup card may show
 * (the first results are expected within 10 s).
 */
export const RAIL_PROBE_WAIT_MS = 10_000

export function RightRail({ dashboard }: { dashboard: DashboardState }): React.JSX.Element {
  const setupKnown = useSetupKnown()
  const setupDismissed = useSetupDismissed()
  const probesPending = primaryProbePending(useProbes())
  const [waited, setWaited] = useState(false)
  const [probeWaited, setProbeWaited] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), RAIL_WAIT_MS)
    const p = setTimeout(() => setProbeWaited(true), RAIL_PROBE_WAIT_MS)
    return () => {
      clearTimeout(t)
      clearTimeout(p)
    }
  }, [])
  // Shown once, and then kept: a later re-probe never hides the rail again. Until then it waits for state.json
  // (whether the setup card shows at all; a card that came after the rail pushed every card down), for dashboard.get
  // at most RAIL_WAIT_MS, and, while the card may show, for Claude's and Codex's first probe answers (their rows grow
  // when they land); never longer than RAIL_PROBE_WAIT_MS.
  const [shown, setShown] = useState(false)
  const cardHidden = setupKnown && setupDismissed !== false
  const whole =
    probeWaited ||
    (setupKnown && (waited || dashboard.status !== 'loading') && (cardHidden || !probesPending))
  if (whole && !shown) setShown(true)
  const ready = shown || whole
  // The setup card's decision (and its optional rows) is taken at the moment the rail would show without that wait (state.json and
  // dashboard.get answered, or RAIL_WAIT_MS passed), not when the rail turns visible: a first launch whose probes all
  // answer ready while the rail waits still shows the card with the profile it chose (first-launch.spec.ts).
  const decide = ready || waited || (setupKnown && dashboard.status !== 'loading')
  return (
    <aside
      aria-label="Summary and vendors"
      data-testid="right-rail"
      data-ready={ready || undefined}
      aria-busy={!ready || undefined}
      // Invisible (and so out of the accessibility tree and the tab order) until it is whole; its children mount
      // meanwhile, so they ask core at once.
      style={ready ? undefined : { visibility: 'hidden' }}
      className="flex min-w-0 flex-col gap-6"
    >
      <SetupCard appChecks={dashboard.data?.appChecks} onRecheckApp={reloadDashboard} settled={decide} />
      <SummaryTiles dashboard={dashboard} />
      <VendorHealthList />
      <CatalogCard />
      {/* After the catalog's own card: a model it added, offered for a batch of rematches. */}
      <NewModelCard />
    </aside>
  )
}
