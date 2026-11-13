// The command palette's results (Actions, Needs you, Runs, Folders, Settings index). Each builder turns what the store already holds (core's attention items, run
// summaries, probes, the theme) into palette items; nothing here derives a status, cost or finding, it only picks and
// words core's views. An item's `run` is what choosing it does, called once the palette has closed and handed the
// focus back (CommandPalette.tsx), so whatever it focuses keeps the focus.
import {
  Activity,
  Bell,
  CircleStop,
  ClipboardCopy,
  Factory,
  FileDiff,
  Folder,
  FolderPlus,
  History,
  LayoutDashboard,
  ListChecks,
  Moon,
  Play,
  Rocket,
  Plus,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sprout,
  Sun,
  WandSparkles,
} from 'lucide-react'
import type { Experience } from '@shared/config-schema.ts'
import { switchExperience } from '../shell/ExperienceSwitch.tsx'
import {
  PALETTE_TO_EASY,
  PALETTE_TO_FULL,
  SWITCH_EASY_HINT,
  SWITCH_FULL_HINT,
} from '../../pages/easy/text.ts'
import type { LucideIcon } from 'lucide-react'
import type { AttentionItem } from '@shared/estimates.ts'
import type { AskKind } from '@shared/events.ts'
import type { ThemeState } from '@shared/ipc.ts'
import type { RunSummary } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../ipc/client.ts'
import {
  categoryTitle,
  PAUSE_REASON_LABEL,
  RUN_STATUS_LABEL,
  stepLabel,
  vendorName,
} from '../../lib/format.ts'
import { KEYS } from '../../lib/keys.ts'
import { currentHash, href, navigate } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { applyTheme } from '../../lib/theme.ts'
import { folderBaseName } from '../../pages/dashboard/composer-model.ts'
import { SETTINGS_FIELDS, sectionTitle, settingsFieldHref } from '../../pages/settings/index.ts'
import type { SettingsField } from '../../pages/settings/index.ts'
import { SETTINGS_SECTIONS } from '../../pages/settings/sections.ts'
import { setThemeState, upsertProbes } from '../../state/actions.ts'
import { isActiveStatus } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { stopRun } from '../run/stop.ts'
import { openNewProject } from '../newproject/open.ts'
import { requestComposer } from './composerIntent.ts'
import { focusInRun, followUp, locateSettingsField } from './followUp.ts'

export const PALETTE_GROUPS = [
  { id: 'actions', heading: 'Actions' },
  { id: 'needs-you', heading: 'Needs you' },
  { id: 'runs', heading: 'Runs' },
  { id: 'folders', heading: 'Folders' },
  { id: 'settings', heading: 'Settings' },
] as const

export type PaletteGroupId = (typeof PALETTE_GROUPS)[number]['id']

export interface PaletteItem {
  /** Unique across the palette (cmdk's value): `action:new-run`, `run:<id>`, `field:<section>:<sub>:<id>`. */
  id: string
  group: PaletteGroupId
  label: string
  /** Context beside the label: a run's status and folder, a row's section and group. */
  hint?: string
  /** What the fuzzy search reads besides the label. */
  keywords: readonly string[]
  icon: LucideIcon
  /** The item's own shortcut, shown beside it. */
  combo?: string
  /** Shown, but not chosen, with this reason. */
  disabled?: string
  run: () => void
}

/** Runs listed at most (the active ones first, then the most recent). */
export const RUNS_MAX = 50
/** Recent folders listed at most. */
export const FOLDERS_MAX = 8

export interface PaletteFolder {
  folder: string
  exists: boolean
}

export interface PaletteContext {
  route: Route
  summaries: readonly RunSummary[]
  attention: readonly AttentionItem[]
  probes: readonly ProbeView[]
  folders: readonly PaletteFolder[]
  theme: ThemeState
  /** Easy or Full control (absent: Full). */
  experience?: Experience
}

// ---- Actions --------------------------------------------------------------------------------------------------------

/** ui.setTheme, applied at once (main's `theme` event brings the same state). */
async function setTheme(req: { theme: ThemeState['theme'] }): Promise<ThemeState | null> {
  const r = await invoke('ui.setTheme', req)
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return null
  }
  applyTheme(r.value)
  setThemeState(r.value)
  return r.value
}

const THEME_WORD: Readonly<Record<ThemeState['resolved'], string>> = { light: 'Light', dark: 'Dark' }

/** Light ↔ dark from what shows now; Undo puts back the setting it replaced (System included). */
export async function toggleTheme(now: ThemeState): Promise<void> {
  const next = now.resolved === 'dark' ? 'light' : 'dark'
  const set = await setTheme({ theme: next })
  if (set === null) return
  toast({
    id: 'palette-theme',
    level: 'info',
    message: `Theme: ${THEME_WORD[set.resolved]}`,
    action: { label: 'Undo', onClick: () => setTheme({ theme: now.theme }) },
  })
}

/** A forced probe of every built vendor, then one line saying how each is now (core's words). */
export async function reprobeVendors(probes: readonly ProbeView[]): Promise<void> {
  const built = probes.filter((p) => p.built)
  if (built.length === 0) {
    toast({ level: 'info', message: 'No vendors to check yet.' })
    return
  }
  const results = await Promise.all(
    built.map((p) => invoke('vendors.probe', { vendor: p.vendor, force: true })),
  )
  const views: ProbeView[] = []
  const errors: string[] = []
  for (const r of results) {
    if (r.ok) views.push(...r.value)
    else errors.push(r.error.message)
  }
  if (views.length > 0) upsertProbes(views)
  if (errors.length > 0) toast({ level: 'error', message: errors.join(' · ') })
  const said = views.filter((v) => built.some((b) => b.vendor === v.vendor))
  if (said.length > 0)
    toast({
      id: 'palette-reprobe',
      level: 'info',
      message: said.map((v) => `${v.displayName}: ${v.healthDetail}`).join(' · '),
    })
}

/** Core's redacted diagnostics on the clipboard (diagnostics.copy). */
export async function copyDiagnostics(): Promise<void> {
  const r = await invoke('diagnostics.copy', {})
  if (r.ok) toast({ id: 'palette-diagnostics', level: 'info', message: 'Diagnostics copied' })
  else toast({ level: 'error', message: r.error.message })
}

export function actionItems(ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      id: 'action:new-run',
      group: 'actions',
      label: 'New run',
      hint: 'Write the task in the composer',
      keywords: ['start', 'task', 'composer', 'create'],
      icon: Plus,
      run: () => {
        requestComposer()
        navigate({ name: 'dashboard' })
      },
    },
    {
      id: 'action:dashboard',
      group: 'actions',
      label: 'Open Dashboard',
      keywords: ['home', 'go to'],
      icon: LayoutDashboard,
      combo: KEYS.dashboard,
      run: () => navigate({ name: 'dashboard' }),
    },
    {
      id: 'action:runs',
      group: 'actions',
      label: 'Open Runs',
      keywords: ['history', 'go to'],
      icon: ListChecks,
      combo: KEYS.runs,
      run: () => navigate({ name: 'runs' }),
    },
    {
      id: 'action:plops',
      group: 'actions',
      label: 'Open Plops',
      hint: 'AI usage by vendor and model',
      keywords: ['usage', 'tokens', 'cost', 'spend', 'models', 'vendors', 'go to'],
      icon: Sprout,
      run: () => navigate({ name: 'plops' }),
    },
    {
      id: 'action:queue',
      group: 'actions',
      label: 'Open Queue',
      hint: 'Queued tasks and the daily report',
      keywords: ['backlog', 'factory'],
      icon: Factory,
      run: () => navigate({ name: 'queue' }),
    },
    {
      id: 'action:preview',
      group: 'actions',
      label: 'Run it',
      hint: 'Start a folder and preview it',
      keywords: ['preview', 'run', 'start', 'dev server', 'serve', 'open in browser'],
      icon: Play,
      run: () => navigate({ name: 'preview' }),
    },
    {
      id: 'action:deploy',
      group: 'actions',
      label: 'Deploy',
      hint: 'Where a folder could go, what to check, and the commands to copy',
      keywords: [
        'deploy',
        'hosting',
        'publish',
        'ship',
        'release',
        'checklist',
        'netlify',
        'vercel',
        'docker',
      ],
      icon: Rocket,
      run: () => navigate({ name: 'deploy' }),
    },
    {
      id: 'action:new-project',
      group: 'actions',
      label: 'New project',
      hint: 'Start from a template in a new folder',
      keywords: ['create', 'template', 'scaffold', 'starter', 'folder', 'init', 'vite', 'react', 'next.js'],
      icon: FolderPlus,
      run: () => openNewProject(),
    },
    {
      id: 'action:settings',
      group: 'actions',
      label: 'Open Settings',
      keywords: ['preferences', 'options', 'go to'],
      icon: Settings,
      combo: KEYS.settings,
      run: () => navigate({ name: 'settings' }),
    },
  ]
  const route = ctx.route
  if (route.name === 'run') {
    const runId = route.runId
    const summary = ctx.summaries.find((s) => s.runId === runId)
    const stoppable = summary !== undefined && isActiveStatus(summary.status)
    items.push(
      {
        id: 'action:stop',
        group: 'actions',
        label: 'Stop the open run',
        ...(summary !== undefined ? { hint: `#${summary.displayNo} ${summary.title}` } : {}),
        keywords: ['cancel', 'halt'],
        icon: CircleStop,
        combo: KEYS.stop,
        ...(stoppable ? {} : { disabled: summary === undefined ? 'Not loaded yet' : 'This run has ended' }),
        run: () => void stopRun(runId),
      },
      {
        id: 'action:diff',
        group: 'actions',
        label: 'Open diff',
        ...(summary !== undefined ? { hint: `#${summary.displayNo} ${summary.title}` } : {}),
        keywords: ['changes', 'files', 'review'],
        icon: FileDiff,
        combo: KEYS.openDiff,
        run: () => navigate({ name: 'run', runId, tab: 'diff' }),
      },
    )
  }
  const theme = ctx.theme
  items.push(
    {
      id: 'action:theme',
      group: 'actions',
      label: 'Toggle theme',
      hint: theme.resolved === 'dark' ? 'Switch to light' : 'Switch to dark',
      keywords: ['dark', 'light', 'appearance', 'mode'],
      icon: theme.resolved === 'dark' ? Sun : Moon,
      run: () => void toggleTheme(theme),
    },
    {
      id: 'action:experience',
      group: 'actions',
      label: ctx.experience === 'easy' ? PALETTE_TO_FULL : PALETTE_TO_EASY,
      hint: ctx.experience === 'easy' ? SWITCH_FULL_HINT : SWITCH_EASY_HINT,
      keywords: ['easy', 'full', 'simple', 'mode', 'beginner', 'make something'],
      icon: ctx.experience === 'easy' ? SlidersHorizontal : WandSparkles,
      run: () => void switchExperience(ctx.experience === 'easy' ? 'full' : 'easy', ctx.route),
    },
    {
      id: 'action:reprobe',
      group: 'actions',
      label: 'Re-probe vendors',
      hint: 'Check every vendor CLI again',
      keywords: ['vendors', 'check', 'health', 'probe', 'claude'],
      icon: RefreshCw,
      run: () => void reprobeVendors(ctx.probes),
    },
    {
      id: 'action:diagnostics',
      group: 'actions',
      label: 'Copy diagnostics',
      hint: 'Redacted, for a bug report',
      keywords: ['bug report', 'clipboard', 'support'],
      icon: ClipboardCopy,
      run: () => void copyDiagnostics(),
    },
  )
  return items
}

// ---- Needs you ------------------------------------------------------------------------------------------------------

const ASK_KIND_LABEL: Readonly<Record<AskKind, string>> = {
  edit: 'wants to edit',
  shell: 'wants to run',
  network: 'wants network access',
  other: 'asks permission',
}

/** One line for an attention item, in core's words. */
export function attentionLine(item: AttentionItem, summaries: readonly RunSummary[]): string {
  switch (item.kind) {
    case 'ask':
      return `${vendorName(item.ask.vendor)} ${ASK_KIND_LABEL[item.ask.kind]}: ${item.ask.detail}`
    case 'card':
      return item.cardTitle
    case 'stalled':
      return `${stepLabel(item.step)} has had no output for a while`
    case 'paused':
      return `Paused at ${stepLabel(item.step)} · ${PAUSE_REASON_LABEL[item.pause]}`
    case 'failed': {
      const steps = summaries.find((s) => s.runId === item.runId)?.steps
      const vendor = steps?.find((st) => st.key === item.step)?.vendor
      return `Failed at ${stepLabel(item.step)} · ${categoryTitle(item.category, vendor)}`
    }
  }
}

/** Where in the Run view an item is answered (the ask panel, the card), most specific first. */
export function attentionSelectors(item: AttentionItem): string[] {
  switch (item.kind) {
    case 'ask':
      return [
        `[data-testid="ask-panel"][data-request-id="${CSS.escape(item.ask.requestId)}"]`,
        '[data-testid="ask-panel"]',
      ]
    case 'card':
      return [`section[data-card-id="${CSS.escape(item.cardId)}"]`]
    case 'stalled':
    case 'paused':
    case 'failed':
      return []
  }
}

/** Open the run at the item: its Flow tab, then the ask or card under the header with the focus. */
export function openAttention(item: AttentionItem): void {
  navigate({ name: 'run', runId: item.runId })
  const selectors = attentionSelectors(item)
  if (selectors.length > 0) focusInRun(item.runId, selectors)
}

export function needsYouItems(ctx: PaletteContext): PaletteItem[] {
  return ctx.attention.map((item) => ({
    id: `needs:${item.id}`,
    group: 'needs-you',
    label: `#${item.displayNo} ${item.title}`,
    hint: attentionLine(item, ctx.summaries),
    keywords: [item.title, item.folder, `#${item.displayNo}`, attentionLine(item, ctx.summaries)],
    icon: Bell,
    run: () => openAttention(item),
  }))
}

// ---- Runs -----------------------------------------------------------------------------------------------------------

/** Active runs first (newest first), then the most recent others, RUNS_MAX at most. */
export function paletteRuns(summaries: readonly RunSummary[]): RunSummary[] {
  const active = summaries.filter((s) => isActiveStatus(s.status))
  const rest = summaries.filter((s) => !isActiveStatus(s.status))
  return [...active, ...rest].slice(0, RUNS_MAX)
}

export function runItems(ctx: PaletteContext): PaletteItem[] {
  return paletteRuns(ctx.summaries).map((s) => ({
    id: `run:${s.runId}`,
    group: 'runs',
    label: `#${s.displayNo} ${s.title}`,
    hint: `${RUN_STATUS_LABEL[s.status]} · ${folderBaseName(s.folder)}`,
    keywords: [s.title, s.folder, `#${s.displayNo}`, String(s.displayNo), RUN_STATUS_LABEL[s.status]],
    icon: isActiveStatus(s.status) ? Activity : History,
    run: () => navigate({ name: 'run', runId: s.runId }),
  }))
}

// ---- Folders --------------------------------------------------------------------------------------------------------

export function folderItems(ctx: PaletteContext): PaletteItem[] {
  return ctx.folders.slice(0, FOLDERS_MAX).map(({ folder, exists }) => ({
    id: `folder:${folder}`,
    group: 'folders',
    label: folderBaseName(folder),
    hint: exists ? folder : `${folder} · no longer exists`,
    keywords: [folder, 'folder', 'new run'],
    icon: Folder,
    run: () => {
      requestComposer({ folder })
      navigate({ name: 'dashboard' })
    },
  }))
}

// ---- Settings index -------------------------------------------------------------------------------------------------

/**
 * Open a Settings row: follow its link, whose `field` the deep-link focus picks up (SettingsFieldFocus, or VendorCard
 * for a vendor's field). Already on that link, the hash does not change, so the focus is asked for here.
 */
export function openSettingsRow(link: string, field: string, entry: SettingsField): void {
  if (currentHash() !== link) {
    navigate(link)
    return
  }
  followUp(() => locateSettingsField(field, entry))
}

/** The vendor fields VendorCard focuses (vendors/deepLink.ts), per built vendor. */
function vendorFieldItems(probes: readonly ProbeView[]): PaletteItem[] {
  const vendors = sectionTitle('vendors')
  return probes
    .filter((p) => p.built)
    .flatMap((p) =>
      (
        [
          ['path', `${p.displayName} executable path`, ['path', 'executable', 'binary', 'cli']],
          ['defaultModel', `${p.displayName} default model`, ['model', 'default']],
        ] as const
      ).map(([field, label, words]): PaletteItem => {
        const link = href({ name: 'settings', section: 'vendors', subpath: [p.vendor], query: { field } })
        return {
          id: `field:vendors:${p.vendor}:${field}`,
          group: 'settings',
          label,
          hint: `${vendors} · ${p.displayName}`,
          keywords: [vendors, p.displayName, ...words],
          icon: SlidersHorizontal,
          run: () => openSettingsRow(link, field, { section: 'vendors', id: field, label }),
        }
      }),
    )
}

export function settingsItems(ctx: PaletteContext): PaletteItem[] {
  const sections = SETTINGS_SECTIONS.map((s): PaletteItem => ({
    id: `section:${s.id}`,
    group: 'settings',
    label: s.title,
    hint: 'Settings section',
    keywords: ['settings', s.about],
    icon: Settings,
    run: () => navigate({ name: 'settings', section: s.id }),
  }))
  const rows = SETTINGS_FIELDS.map((f): PaletteItem => {
    const section = sectionTitle(f.section)
    return {
      id: `field:${f.section}:${f.sub ?? ''}:${f.id}`,
      group: 'settings',
      label: f.label,
      hint: f.group !== undefined && f.group !== f.label ? `${section} · ${f.group}` : section,
      keywords: [
        section,
        ...(f.group !== undefined ? [f.group] : []),
        ...(f.control !== undefined ? [f.control] : []),
        ...(f.keywords ?? []),
      ],
      icon: SlidersHorizontal,
      run: () => openSettingsRow(settingsFieldHref(f), f.id, f),
    }
  })
  return [...sections, ...vendorFieldItems(ctx.probes), ...rows]
}

/** Every item, by group, in the palette's order. */
export function paletteItems(ctx: PaletteContext): Record<PaletteGroupId, PaletteItem[]> {
  return {
    actions: actionItems(ctx),
    'needs-you': needsYouItems(ctx),
    runs: runItems(ctx),
    folders: folderItems(ctx),
    settings: settingsItems(ctx),
  }
}
