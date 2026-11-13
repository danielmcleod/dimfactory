// Settings sections and their deep-link ids (`#/settings/<section>`). Ids match the
// `settings/<id>` routes core puts in settings_link recovery actions; two older route names map onto a section.
export interface SettingsSection {
  id: string
  title: string
  /** What the section will hold, shown while it is not built yet. */
  about: string
  /** Built in this version. */
  live: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'general',
    title: 'General',
    about:
      'Default profile, timeouts, whether a denied request pauses the run, close to tray and run retention.',
    live: true,
  },
  {
    id: 'vendors',
    title: 'Vendors',
    about:
      'Each vendor CLI: where it was found, its version and the checks Dim Factory runs before using it.',
    live: true,
  },
  {
    id: 'profiles',
    title: 'Profiles',
    about: 'Built-in and your own profiles: which vendor and model run each pass.',
    live: true,
  },
  {
    id: 'extensions',
    title: 'Extensions',
    about: 'Which of your MCP servers, skills, plugins and hooks each pass may use.',
    live: true,
  },
  {
    id: 'prompts',
    title: 'Prompts',
    about: 'The prompt template of each pass, for you or for one project.',
    live: true,
  },
  {
    id: 'recipes',
    title: 'Recipes',
    about:
      "Saved pipelines plus briefs (built in, yours and a project's), what each turns on, and where their files live.",
    live: true,
  },
  {
    id: 'guardrails',
    title: 'Guardrails',
    about: 'Rules a run must keep, what each can and cannot stop, and a free way to test them.',
    live: true,
  },
  {
    id: 'self-heal',
    title: 'Self-heal',
    about: 'Whether Dim Factory may ask a model to diagnose a failure, and which one.',
    live: true,
  },
  {
    id: 'catalog',
    title: 'Catalog',
    about: 'Models and prices used for cost estimates, and how they are refreshed.',
    live: true,
  },
  {
    id: 'isolation',
    title: 'Isolation & Verify',
    about:
      'Running in place or in an isolated worktree, the commands that verify a change, the security review, Clarify before Plan and Fix until green.',
    live: true,
  },
  {
    id: 'preview',
    title: 'Preview',
    about: 'Where Run it opens a preview: in Dim Factory, in your browser, or ask each time.',
    live: true,
  },
  {
    id: 'deploy',
    title: 'Deploy',
    about:
      'The Deploy step that writes deploy config at the end of a run, its target, and commit and pull request for a project.',
    live: true,
  },
  {
    id: 'factory',
    title: 'Factory',
    about:
      'How queued tasks run: Auto, budgets and stop rules, the schedule, fallback on a rate limit, model routing, project memory and quality gates.',
    live: true,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    about: 'Theme, accent colour and the size of vendor output.',
    live: true,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    about: 'Which events notify you, and a test notification.',
    live: true,
  },
  {
    id: 'outside-agents',
    title: 'Outside agents',
    about: 'Let an agent you run read your runs and ask for new ones, which you approve here.',
    live: true,
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    about: 'Versions, paths, storage use, clearing snapshots and copying diagnostics.',
    live: true,
  },
  {
    id: 'config',
    title: 'Config file',
    about: 'Your dimfactory.json as Dim Factory reads it, with any errors marked, and the last good copy.',
    live: true,
  },
]

/** Route names core also links to: `settings/storage` (Clear snapshots), `settings/passes` (pass rows). */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {
  storage: 'diagnostics',
  passes: 'profiles',
}

/** `#/settings` with no section opens the first section built in this version. */
export const DEFAULT_SECTION = 'vendors'

export function findSection(id: string | undefined): SettingsSection | undefined {
  const key = id === undefined || id === '' ? DEFAULT_SECTION : (SECTION_ALIASES[id] ?? id)
  return SETTINGS_SECTIONS.find((s) => s.id === key)
}
