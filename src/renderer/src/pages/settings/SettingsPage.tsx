// Settings (performance.spec.ts: a section switch renders in < 200 ms). Section list
// on the left, deep-linked as `#/settings/<section>[/<sub>][?field=…]`. Vendors, Appearance, Notifications,
// Self-heal, General, Profiles, Prompts, Diagnostics, Config file, Catalog and Isolation & Verify are live.
// A switch renders before anything is fetched: Vendors reads the probes already in the store (and the user's settings
// only when it has a vendor card); the other live sections read their data once they have been open a moment
// (sectionData.ts), with room kept so nothing moves when it arrives.
//
// One scroll region per screen (UI standard): the section flows in the page, which
// scrolls in <main> only, and the section list stays in view beside it (sticky in that scroller, never a scroller of
// its own). Where the page is narrow (under 600 CSS px: a small window at a large page zoom), the list is a row of
// links above the section instead, wrapping onto more lines, so the section keeps the width it needs and nothing
// scrolls sideways. The page is a size container: this follows the page's own width, whatever the window and zoom.
import { FileQuestion } from 'lucide-react'
import { Button } from '../../components/ui/Button.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { cn } from '../../lib/cn.ts'
import { href } from '../../lib/router.ts'
import { AppearanceSection } from './AppearanceSection.tsx'
import { CatalogSection } from './CatalogSection.tsx'
import { ConfigFileSection } from './ConfigFileSection.tsx'
import { DiagnosticsSection } from './DiagnosticsSection.tsx'
import { ExtensionsSection } from './ExtensionsSection.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { IsolationSection } from './IsolationSection.tsx'
import { LaterSection } from './LaterSections.tsx'
import { NotificationsSection } from './NotificationsSection.tsx'
import { OutsideAgentsSection } from './OutsideAgentsSection.tsx'
import { ProfilesSection } from './ProfilesSection.tsx'
import { PreviewSection } from './PreviewSection.tsx'
import { DeploySection } from './DeploySection.tsx'
import { FactorySection } from './FactorySection.tsx'
import { PromptsSection } from './PromptsSection.tsx'
import { RecipesSection } from './RecipesSection.tsx'
import { findSection, SETTINGS_SECTIONS } from './sections.ts'
import type { SettingsSection } from './sections.ts'
import { GuardrailsSection } from './GuardrailsSection.tsx'
import { SelfHealSection } from './SelfHealSection.tsx'
import { VendorsSection } from './VendorsSection.tsx'

function SectionBody({ section }: { section: SettingsSection }): React.JSX.Element {
  switch (section.id) {
    case 'general':
      return <GeneralSection />
    case 'profiles':
      return <ProfilesSection />
    case 'prompts':
      return <PromptsSection />
    case 'extensions':
      return <ExtensionsSection />
    case 'appearance':
      return <AppearanceSection />
    case 'vendors':
      return <VendorsSection />
    case 'notifications':
      return <NotificationsSection />
    case 'guardrails':
      return <GuardrailsSection />
    case 'self-heal':
      return <SelfHealSection />
    case 'catalog':
      return <CatalogSection />
    case 'isolation':
      return <IsolationSection />
    case 'preview':
      return <PreviewSection />
    case 'deploy':
      return <DeploySection />
    case 'factory':
      return <FactorySection />
    case 'recipes':
      return <RecipesSection />
    case 'outside-agents':
      return <OutsideAgentsSection />
    case 'diagnostics':
      return <DiagnosticsSection />
    case 'config':
      return <ConfigFileSection />
    default:
      return (
        <div className="flex flex-col gap-6">
          <LaterSection section={section} />
        </div>
      )
  }
}

export function SettingsPage({ section }: { section?: string }): React.JSX.Element {
  const current = findSection(section)
  // The section list: a row above the section on a narrow page, a column beside it from 600 px, a wider one from
  // 800 px (a 1024 px window at 100%).
  return (
    <div className="@container">
      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-6 gap-y-3 px-6 py-5 @min-[37.5rem]:grid-cols-[10rem_minmax(0,1fr)] @min-[50rem]:grid-cols-[12rem_minmax(0,1fr)]">
        <SettingsBody section={section} current={current} />
      </div>
    </div>
  )
}

function SettingsBody({
  section,
  current,
}: {
  section: string | undefined
  current: SettingsSection | undefined
}): React.JSX.Element {
  return (
    <>
      {/* On a narrow page the list is a row above the section: its links' text lines up with the section's. */}
      <h1 className="text-lg font-semibold @min-[37.5rem]:col-span-2 @min-[37.5rem]:px-2">Settings</h1>
      <nav
        aria-label="Settings sections"
        data-testid="settings-nav"
        className="-mx-2 @min-[37.5rem]:sticky @min-[37.5rem]:top-4 @min-[37.5rem]:mx-0 @min-[37.5rem]:self-start"
      >
        <ul className="flex flex-wrap gap-1 @min-[37.5rem]:flex-col @min-[37.5rem]:flex-nowrap @min-[37.5rem]:gap-px">
          {SETTINGS_SECTIONS.map((s) => {
            const active = current?.id === s.id
            return (
              <li key={s.id}>
                <a
                  href={href({ name: 'settings', section: s.id })}
                  data-testid={`settings-section-${s.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
                  )}
                >
                  {s.title}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
      <section
        data-testid="settings-content"
        data-section={current?.id ?? ''}
        // Accessibility: the app's toasts are the region "Notifications"; this section's region is told apart from it
        // (aria-labelledby would win over aria-label, so it is one or the other).
        {...(current?.id === 'notifications'
          ? { 'aria-label': 'Notification settings' }
          : { 'aria-labelledby': 'settings-section-title' })}
        className="flex min-w-0 flex-col gap-4"
      >
        {current !== undefined ? (
          <>
            <h2 id="settings-section-title" className="text-base font-semibold">
              {current.title}
            </h2>
            <SectionBody section={current} />
          </>
        ) : (
          <>
            <h2 id="settings-section-title" className="sr-only">
              Unknown section
            </h2>
            <EmptyState
              icon={FileQuestion}
              title="This settings section does not exist"
              description={`There is no section called "${section ?? ''}".`}
              action={
                <Button asChild variant="outline">
                  <a href={href({ name: 'settings' })}>Open Settings</a>
                </Button>
              }
            />
          </>
        )}
      </section>
    </>
  )
}
