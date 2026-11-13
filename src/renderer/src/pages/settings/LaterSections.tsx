// The Settings sections that arrive in later versions: each shows its real
// structure with every control disabled ("Available in a later version"), so the shape of Settings is visible now;
// nothing here calls core. Diagnostics, Config file and Catalog have their own live sections, as do Isolation
// & Verify (IsolationSection.tsx) and General, Profiles and Prompts
// (GeneralSection.tsx, ProfilesSection.tsx, PromptsSection.tsx). A section still listed as not live gets its notice.
import { LaterNotice } from './kit.tsx'
import type { SettingsSection } from './sections.ts'

/** The body of a section that is not built yet, by section id. */
export function LaterSection({ section }: { section: SettingsSection }): React.JSX.Element {
  return <LaterNotice about={section.about} />
}
