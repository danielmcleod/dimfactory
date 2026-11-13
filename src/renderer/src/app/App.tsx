// Root component (the Shell): providers, toasts, the shell with the routed page and the app banners
// (drawn over the page's top, never pushing it), the `?` keyboard sheet, the ⌘/Ctrl+K command palette, the New
// project dialog and the
// focus that Settings deep links (`?field=`) give their row. The bridge starts in an effect (StrictMode-safe). Pages
// load eagerly: few, small, and the first paint matters.
import { FileQuestion } from 'lucide-react'
import { useEffect } from 'react'
import { loadExperience, useExperience } from '../state/experience.ts'
import { useConfigEpoch } from '../state/selectors.ts'
import { EasyHomePage, EasyProjectsPage } from '../pages/easy/EasyHome.tsx'
import { EasyNewPage } from '../pages/easy/EasyNew.tsx'
import { EasyRunPage } from '../pages/easy/EasyRun.tsx'
import { EasyTwoPage } from '../pages/easy/EasyTwo.tsx'
import { EasyExistingPage } from '../pages/easy/EasyExisting.tsx'
import { EasyOvernightPage } from '../pages/easy/EasyOvernight.tsx'
import { EasySettingsPage } from '../pages/easy/EasySettings.tsx'
import { KeyboardSheet } from '../components/attention/KeyboardSheet.tsx'
import { NewProjectDialog } from '../components/newproject/NewProjectDialog.tsx'
import { CommandPalette } from '../components/palette/CommandPalette.tsx'
import { SettingsFieldFocus } from '../components/palette/SettingsFieldFocus.tsx'
import { Shell } from '../components/shell/Shell.tsx'
import { Button } from '../components/ui/Button.tsx'
import { EmptyState } from '../components/ui/EmptyState.tsx'
import { Toaster } from '../components/ui/Toaster.tsx'
import { TooltipProvider } from '../components/ui/Tooltip.tsx'
import { startBridge } from '../ipc/bridge.ts'
import { KEYS, useShortcut } from '../lib/keys.ts'
import { href, navigate, useRoute } from '../lib/router.ts'
import type { Route } from '../lib/router.ts'
import { DashboardPage } from '../pages/dashboard/DashboardPage.tsx'
import { PlopsPage } from '../pages/plops/PlopsPage.tsx'
import { MatchPage } from '../pages/match/MatchPage.tsx'
import { RematchPage } from '../pages/match/RematchPage.tsx'
import { PreviewPage } from '../pages/preview/PreviewPage.tsx'
import { DeployPage } from '../pages/deploy/DeployPage.tsx'
import { QueuePage } from '../pages/queue/QueuePage.tsx'
import { RunPage } from '../pages/run/RunPage.tsx'
import { RunsPage } from '../pages/runs/RunsPage.tsx'
import { SettingsPage } from '../pages/settings/SettingsPage.tsx'
import { LostContactBanner, NoticeBanners, QuitRequestedBanner } from './Banners.tsx'
import { QueueNoticeBanner } from './QueueNoticeBanner.tsx'

export function RoutedPage({ route }: { route: Route }): React.JSX.Element {
  switch (route.name) {
    case 'dashboard':
      return <DashboardPage />
    case 'runs':
      return <RunsPage />
    case 'run':
      return <RunPage key={route.runId} runId={route.runId} tab={route.tab} />
    case 'match':
      return <MatchPage key={route.matchId} matchId={route.matchId} />
    case 'rematch':
      return <RematchPage key={route.runId} runId={route.runId} />
    case 'plops':
      return <PlopsPage />
    case 'settings':
      return route.section !== undefined ? <SettingsPage section={route.section} /> : <SettingsPage />
    case 'preview':
      return <PreviewPage folder={route.query['folder'] ?? null} />
    case 'deploy':
      return <DeployPage folder={route.query['folder'] ?? null} />
    case 'queue':
      return <QueuePage />
    case 'easy':
      return route.page === 'new' ? (
        <EasyNewPage />
      ) : route.page === 'existing' ? (
        <EasyExistingPage folder={route.query['folder'] ?? null} />
      ) : route.page === 'overnight' ? (
        <EasyOvernightPage />
      ) : route.page === 'projects' ? (
        <EasyProjectsPage />
      ) : route.page === 'settings' ? (
        <EasySettingsPage />
      ) : (
        <EasyHomePage />
      )
    case 'easyRun':
      return <EasyRunPage key={route.runId} runId={route.runId} />
    case 'easyTwo':
      return <EasyTwoPage key={route.matchId} matchId={route.matchId} />
    case 'notFound':
      return (
        <EmptyState
          icon={FileQuestion}
          title="This page does not exist"
          description={`Nothing is shown at "${route.path}".`}
          action={
            <Button asChild variant="outline">
              <a href={href({ name: 'dashboard' })}>Go to the Dashboard</a>
            </Button>
          }
        />
      )
  }
}

/**
 * Easy mode: its home stands in for the Dashboard (the Full Run view and every other page stay reachable), and core's
 * Easy state is read again after each config change (a switch made elsewhere, Easy settings).
 */
function EasyRouting({ route }: { route: Route }): null {
  const mode = useExperience()
  const epoch = useConfigEpoch()
  useEffect(() => {
    if (epoch > 0) void loadExperience()
  }, [epoch])
  useEffect(() => {
    if (mode === 'easy' && route.name === 'dashboard') navigate({ name: 'easy' }, { replace: true })
  }, [mode, route.name])
  return null
}

function GlobalShortcuts(): null {
  useShortcut(KEYS.dashboard, () => navigate({ name: 'dashboard' }), { description: 'Dashboard' })
  useShortcut(KEYS.runs, () => navigate({ name: 'runs' }), { description: 'Runs' })
  useShortcut(KEYS.settings, () => navigate({ name: 'settings' }), { description: 'Settings' })
  return null
}

export function App(): React.JSX.Element {
  const route = useRoute()
  useEffect(() => startBridge(), [])
  return (
    <TooltipProvider>
      <Shell
        banners={
          <>
            <LostContactBanner />
            <QuitRequestedBanner />
            <NoticeBanners />
            <QueueNoticeBanner />
          </>
        }
      >
        <RoutedPage route={route} />
      </Shell>
      <GlobalShortcuts />
      <EasyRouting route={route} />
      <KeyboardSheet />
      <CommandPalette />
      <NewProjectDialog />
      <SettingsFieldFocus />
      <Toaster />
    </TooltipProvider>
  )
}
