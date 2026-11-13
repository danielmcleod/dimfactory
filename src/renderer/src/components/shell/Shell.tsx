// App shell: the sidebar (Dashboard with the needs-you badge, Runs with the active count, Queue, Run it, then up to
// five active runs; in Easy mode Home and Projects instead, and Easy settings at the foot; the Easy | Full switch first in the foot;
// at its foot Plops (AI usage) and Settings, the latter with a dot while a vendor is not ready or a price update
// is due, above the vendor health dots and the version), and the routed page in <main>. App binds ⌘/Ctrl+1/2/3; the sidebar shows them.
//
// One scroll region per screen (UI standard): the shell is locked to the window and
// <main> is the page's only scroller (given to pages through mainScroll.ts). It carries no data-scroll-region: that
// marks the allowed inner regions (a stream, the log, a menu), each with a fixed maximum height, inside it. It is
// positioned, so nothing absolutely positioned inside a page (a screen-reader-only span) can reach past it and make
// the document scroll, and its scrollbar's room is kept from the start, so content never reflows when the bar
// appears. Its scroll padding (the `page-scroller` utility) keeps the browser's own scrolling for the user (focus, the
// text cursor) clear of a page's sticky bars. The sidebar never scrolls: the active runs sit below Runs and Settings is
// held at the foot (above the footer, outside the part that clips), so no nav target moves when a run starts or ends. App banners (lost contact, quit, recovered runs) overlay the top of the page instead of pushing it
// down. A new screen starts at its top: following a link is the user's action.
// Page zoom: below 768 CSS px of window (a 1280 px window from 175% up) the sidebar is an
// icon rail, its labels kept for screen readers and as tooltips, so the page keeps the width it needs. A count or dot
// then sits off the icon's top-right corner, smaller, never over the icon itself.
import {
  Factory,
  FolderKanban,
  House,
  LayoutDashboard,
  ListChecks,
  MoonStar,
  Play,
  Settings,
  Sprout,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../../state/store.ts'
import { useActiveRunCount, useAppInfo, useNeedsYou, useProbes, useRunIds } from '../../state/selectors.ts'
import { cn } from '../../lib/cn.ts'
import { ariaKeyShortcuts, KEYS } from '../../lib/keys.ts'
import { href, useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { Kbd } from '../ui/Kbd.tsx'
import { StatusDot } from '../ui/StatusDot.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { useCatalogDue } from '../../pages/dashboard/rail/dashboardData.ts'
import { MainScrollContext } from './mainScroll.ts'
import { useQueueStore } from '../../state/queue.ts'
import { HealthDot, vendorHealthText, vendorNotReady } from './VendorHealth.tsx'
import { ExperienceSwitch } from './ExperienceSwitch.tsx'
import { useExperience } from '../../state/experience.ts'
import { NAV_HOME, NAV_OVERNIGHT, NAV_PROJECTS, NAV_SETTINGS } from '../../pages/easy/text.ts'

const MINI_LIST_MAX = 5

/** The Run it page's entry (Run & Preview for a folder, outside a run). */
export const RUN_IT_NAV = 'Run it'

function NavItem({
  to,
  label,
  icon: Icon,
  combo,
  active,
  testId,
  extra,
}: {
  to: string
  label: string
  icon: LucideIcon
  /** Its keyboard shortcut, when it has one. */
  combo?: string
  active: boolean
  testId: string
  extra?: ReactNode
}): React.JSX.Element {
  return (
    <a
      href={to}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      aria-keyshortcuts={combo !== undefined ? ariaKeyShortcuts(combo) : undefined}
      title={label}
      className={cn(
        'group relative flex h-8 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:justify-center max-md:px-0',
        active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate max-md:sr-only">{label}</span>
      {/* On the rail the count or dot hangs off the icon's top-right corner: the icon is centred in the item, so its
          right edge is at 50% + 8 px (its glyph ends 1.3 px inside); the badge starts there and rises above it. */}
      <span className="flex empty:hidden max-md:absolute max-md:top-0 max-md:left-[calc(50%+7px)]">
        {extra}
      </span>
      {combo !== undefined && (
        <span className="contents max-md:hidden">
          <Kbd combo={combo} className="hidden group-hover:inline-flex group-focus-visible:inline-flex" />
        </span>
      )}
    </a>
  )
}

function CountBadge({
  n,
  label,
  tone,
}: {
  n: number
  label: string
  tone: 'attention' | 'muted'
}): ReactNode {
  if (n === 0) return null
  return (
    <span
      aria-label={label}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
        // Smaller on the rail, beside the icon's corner.
        'max-md:h-4 max-md:min-w-4 max-md:px-1 max-md:text-[10px] max-md:leading-none',
        tone === 'attention' ? 'bg-st-waiting text-background' : 'bg-muted text-muted-foreground',
      )}
    >
      {n}
    </span>
  )
}

function ActiveRunLink({ runId, route }: { runId: string; route: Route }): React.JSX.Element | null {
  const summary = useStore((s) => s.summaries.byId[runId])
  if (summary === undefined) return null
  const current = route.name === 'run' && route.runId === runId
  return (
    <li>
      <a
        href={href({ name: 'run', runId })}
        aria-current={current ? 'page' : undefined}
        title={summary.title}
        className={cn(
          'flex h-7 items-center gap-2 rounded-md pr-2 pl-4 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:justify-center max-md:px-0',
          current ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
        )}
      >
        <StatusDot status={summary.status} />
        <span className="min-w-0 flex-1 truncate max-md:sr-only">{summary.title}</span>
      </a>
    </li>
  )
}

function ActiveRunsMiniList({ route }: { route: Route }): React.JSX.Element | null {
  const ids = useRunIds('active', MINI_LIST_MAX)
  if (ids.length === 0) return null
  return (
    <ul aria-label="Active runs" data-testid="nav-active-runs" className="mt-1 flex flex-col gap-px">
      {ids.map((id) => (
        <ActiveRunLink key={id} runId={id} route={route} />
      ))}
    </ul>
  )
}

/**
 * Queue: the factory's task queues. Its count is the queued tasks that need you; a dot says a queue is paused (from the
 * `queue` event; nothing here asks core).
 */
function QueueNavItem({ active }: { active: boolean }): React.JSX.Element {
  const view = useQueueStore((s) => s.view)
  let waiting = 0
  let paused = false
  for (const f of view?.folders ?? []) {
    waiting += f.counts.waiting
    if (f.state === 'paused') paused = true
  }
  return (
    <NavItem
      to={href({ name: 'queue' })}
      label="Queue"
      icon={Factory}
      active={active}
      testId="nav-queue"
      extra={
        waiting > 0 ? (
          <CountBadge
            n={waiting}
            tone="attention"
            label={waiting === 1 ? '1 queued task needs you' : `${waiting} queued tasks need you`}
          />
        ) : paused ? (
          <span
            role="img"
            aria-label="A queue is paused"
            data-testid="queue-paused-dot"
            className="size-2 rounded-full bg-st-paused"
          />
        ) : null
      }
    />
  )
}

function SidebarFooter(): React.JSX.Element {
  const probes = useProbes().filter((p) => p.built)
  const info = useAppInfo()
  return (
    <div className="flex items-center gap-2 border-t px-3 py-2.5 text-xs text-muted-foreground max-md:flex-col max-md:px-1">
      {/* The dots' height from the start: the footer no longer grows when vendors.list answers. */}
      <ul aria-label="Vendor health" className="flex min-h-5 items-center gap-1 max-md:flex-col">
        {probes.map((p) => (
          <li key={p.vendor} className="flex">
            <Tooltip content={vendorHealthText(p)} side="top">
              <a
                href={href({ name: 'settings', section: 'vendors', subpath: [p.vendor] })}
                aria-label={vendorHealthText(p)}
                data-testid={`vendor-dot-${p.vendor}`}
                className="flex size-5 items-center justify-center rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HealthDot health={p.health} />
              </a>
            </Tooltip>
          </li>
        ))}
      </ul>
      <span className="ml-auto tabular-nums max-md:hidden" data-testid="app-version">
        {info !== null ? `v${info.version}` : ''}
      </span>
    </div>
  )
}

/** What makes a new screen (it starts at its top): a run's tabs and a query string stay on the same screen. */
export function screenKey(route: Route): string {
  switch (route.name) {
    case 'run':
      return `run/${route.runId}`
    case 'match':
      return `match/${route.matchId}`
    case 'rematch':
      return `rematch/${route.runId}`
    case 'settings':
      return ['settings', route.section ?? '', ...route.subpath].join('/')
    case 'notFound':
      return `notFound/${route.path}`
    case 'easy':
      return `easy/${route.page}`
    case 'easyRun':
      return `easyRun/${route.runId}`
    case 'easyTwo':
      return `easyTwo/${route.matchId}`
    case 'dashboard':
    case 'runs':
    case 'plops':
    case 'preview':
    case 'deploy':
    case 'queue':
      return route.name
  }
}

export function Shell({
  children,
  banners,
}: {
  children: React.ReactNode
  /** App banners: drawn over the top of the page, never in its flow. */
  banners?: ReactNode
}): React.JSX.Element {
  const route = useRoute()
  const [main, setMain] = useState<HTMLElement | null>(null)
  const screen = screenKey(route)
  useLayoutEffect(() => {
    if (main !== null) main.scrollTop = 0
  }, [main, screen])
  const needsYou = useNeedsYou()
  const activeCount = useActiveRunCount()
  const vendorAttention = useProbes().some(vendorNotReady)
  const catalogDue = useCatalogDue()
  const easy = useExperience() === 'easy'
  return (
    <div className="flex h-full min-h-0">
      {/* Named (accessibility): the Dashboard has a second complementary landmark, "Summary and vendors". */}
      <aside aria-label="Sidebar" className="flex w-52 shrink-0 flex-col border-r bg-muted/40 max-md:w-14">
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
          {/* The top of the list; it clips (never scrolls) when the window is short, so Settings below keeps its place. */}
          <div data-testid="nav-top" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
            {easy ? (
              <>
                <NavItem
                  to={href({ name: 'easy' })}
                  label={NAV_HOME}
                  icon={House}
                  active={
                    (route.name === 'easy' &&
                      route.page !== 'projects' &&
                      route.page !== 'settings' &&
                      route.page !== 'overnight') ||
                    route.name === 'easyRun' ||
                    route.name === 'easyTwo'
                  }
                  testId="nav-easy-home"
                  extra={
                    <CountBadge
                      n={needsYou}
                      tone="attention"
                      label={needsYou === 1 ? '1 item needs you' : `${needsYou} items need you`}
                    />
                  }
                />
                <NavItem
                  to={href({ name: 'easy', page: 'projects' })}
                  label={NAV_PROJECTS}
                  icon={FolderKanban}
                  active={route.name === 'easy' && route.page === 'projects'}
                  testId="nav-easy-projects"
                />
                <NavItem
                  to={href({ name: 'easy', page: 'overnight' })}
                  label={NAV_OVERNIGHT}
                  icon={MoonStar}
                  active={route.name === 'easy' && route.page === 'overnight'}
                  testId="nav-easy-overnight"
                />
              </>
            ) : (
              <>
                <NavItem
                  to={href({ name: 'dashboard' })}
                  label="Dashboard"
                  icon={LayoutDashboard}
                  combo={KEYS.dashboard}
                  active={route.name === 'dashboard'}
                  testId="nav-dashboard"
                  extra={
                    <CountBadge
                      n={needsYou}
                      tone="attention"
                      label={needsYou === 1 ? '1 item needs you' : `${needsYou} items need you`}
                    />
                  }
                />
                <NavItem
                  to={href({ name: 'runs' })}
                  label="Runs"
                  icon={ListChecks}
                  combo={KEYS.runs}
                  active={route.name === 'runs'}
                  testId="nav-runs"
                  extra={
                    <CountBadge
                      n={activeCount}
                      tone="muted"
                      label={activeCount === 1 ? '1 active run' : `${activeCount} active runs`}
                    />
                  }
                />
                <QueueNavItem active={route.name === 'queue'} />
                {/* Run it (Run & Preview for a folder): a place of its own, like Queue; the active runs follow. */}
                <NavItem
                  to={href({ name: 'preview' })}
                  label={RUN_IT_NAV}
                  icon={Play}
                  active={route.name === 'preview'}
                  testId="nav-run-it"
                />
                <ActiveRunsMiniList route={route} />
              </>
            )}
          </div>
          {/* At the foot of the sidebar, above the vendor health dots and the version: Plops, then Settings last.
              Both sit below the part that clips, so neither moves when a run starts or ends. */}
          <div data-testid="nav-bottom" className="flex shrink-0 flex-col gap-0.5 pt-0.5">
            {/* Easy | Full: first in the foot, below the part that clips, so it never moves; Settings stays last. */}
            <div data-testid="nav-experience" className="pb-1.5">
              <ExperienceSwitch />
            </div>
            {easy ? (
              <NavItem
                to={href({ name: 'easy', page: 'settings' })}
                label={NAV_SETTINGS}
                icon={Settings}
                active={(route.name === 'easy' && route.page === 'settings') || route.name === 'settings'}
                testId="nav-easy-settings"
              />
            ) : (
              <>
                <NavItem
                  to={href({ name: 'plops' })}
                  label="Plops"
                  icon={Sprout}
                  active={route.name === 'plops'}
                  testId="nav-plops"
                />
                <NavItem
                  to={href({ name: 'settings' })}
                  label="Settings"
                  icon={Settings}
                  combo={KEYS.settings}
                  active={route.name === 'settings'}
                  testId="nav-settings"
                  extra={
                    vendorAttention ? (
                      <span
                        role="img"
                        aria-label="A vendor needs setup"
                        data-testid="settings-attention-dot"
                        className="size-2 rounded-full bg-st-failed"
                      />
                    ) : catalogDue ? (
                      <span
                        role="img"
                        aria-label="Model prices may be out of date"
                        data-testid="settings-attention-dot"
                        className="size-2 rounded-full bg-st-paused"
                      />
                    ) : null
                  }
                />
              </>
            )}
          </div>
        </nav>
        <SidebarFooter />
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <main
          ref={setMain}
          data-testid="main"
          className="page-scroller relative min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <MainScrollContext value={main}>{children}</MainScrollContext>
        </main>
        {/* Over the page's top, clear of main's scrollbar; only the banners themselves take pointer events. */}
        <div
          data-testid="banner-layer"
          className="pointer-events-none absolute inset-x-0 top-0 z-40 flex flex-col gap-2 px-4 pt-3 empty:hidden *:pointer-events-auto"
        >
          {banners}
        </div>
      </div>
    </div>
  )
}
