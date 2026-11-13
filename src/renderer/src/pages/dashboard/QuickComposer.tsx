// Quick composer: folder (chips, picker, path, scope-root note,
// non-git banner), the task box (draft per folder), profile and Auto, the pass rows with provenance, the live
// preflight strip and the estimate line, and Run (⌘/Ctrl+Enter) → runs.start → the Run view. Every value shown is
// core's (config.resolve, preflight.run, estimates.get, brief.detect); the composer holds only the user's pending run
// overrides and Brief choices. The Brief (composer/BriefPanel.tsx, under the task box, collapsed by default) is sent
// to runs.start and the live checks only when it says something, so a run without one is unaffected. The Recipe row
// (composer/RecipeRow.tsx, recipes.list) sends the chosen recipe's id with every request: core resolves it as a config
// layer below the composer's own overrides, and its brief defaults fill the Brief's unset groups.
// The Run button never changes size (UI control standard; composer/RunControl.tsx): its label
// is Run, or Queue while core's folder.lock says another run holds the folder (both widths reserved), and its icon
// slot shows the spinner while starting. The state is text BESIDE it (left of the button, in a row that never wraps,
// cut with an ellipsis when the window is narrow), so Run keeps its place at the row's end; the button names it with
// aria-describedby: Starting… / Fix N issues to run (disabled, ≤ 3 reasons in the tooltip; N counts problems, as the
// strip's chips do) / a failed start's error (also a toast) / Checking… (a live check slower than 300 ms; Run still
// starts, core re-checks authoritatively) / Folder busy. A polite live region says what the checks now mean for Run.
//
// One scroll region per screen, and nothing moves on its own (UI standards): the composer sits in the page's flow at one
// height. It never scrolls inside itself and never shrinks when the page scrolls; once its Run row is scrolled past,
// the compact bar (composer/CompactRunBar.tsx) shows the task and Run over the top of the page. Everything core
// answers after the first paint fills a place kept for it: the chips row and the note line (FolderPicker), the pass
// rows (PassRowsPending), the strip's summary row (its chips open on request) and the estimate line. The task box
// grows only as the user types, up to a fixed height.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Platform, ResolvedWithProvenance, ResultError } from '@shared/ipc.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { RunSummary } from '@shared/run.ts'
import { useComposerIntent } from '../../components/palette/composerIntent.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { Tooltip } from '../../components/ui/Tooltip.tsx'
import { getDimFactory, invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { KEYS, useShortcut } from '../../lib/keys.ts'
import { navigate } from '../../lib/router.ts'
import { useCatalogEpoch } from '../../state/catalog.ts'
import { useAppInfo, useConfigEpoch, useProbes } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { setComposerFolder, useTrustEpoch } from '../../state/trust.ts'
import {
  blockingChecks,
  holdsFolderLock,
  isAbsoluteFolder,
  loadDraft,
  loadLastFolder,
  saveDraft,
  saveLastFolder,
  wouldQueue,
} from './composer-model.ts'
import { useComposerActions } from './composer/actions.ts'
import { CompactRunBar } from './composer/CompactRunBar.tsx'
import { EstimateLine, EstimatePending } from './composer/EstimateLine.tsx'
import { FolderPicker, useRecentFolders } from './composer/FolderPicker.tsx'
import {
  blockedLabel,
  blockedReason,
  checksAnnouncement,
  gatesOf,
  notGitRepo,
  queueCheck,
  scopeRootNote,
  SECURITY_COST_NOTE,
  securityOnOf,
  CLARIFY_NOTE,
  clarifyOnOf,
  deployOnOf,
  DEPLOY_NOTE,
  acceptanceOnOf,
  ACCEPTANCE_NOTE,
  explainOnOf,
  EXPLAIN_NOTE,
  looksLikeNewWork,
  passOf,
  researchCostText,
  researchLensesOf,
  researchNote,
  researchOnOf,
  toggleLens,
  FIX_UNTIL_GREEN_NOTE,
  fixRoundsFor,
  fixRoundsOf,
  localPresetVendors,
} from './composer/model.ts'
import {
  applyOverrideOps,
  overridesForRequest,
  setAuto,
  setDepth,
  setPassValues,
  setProfile,
} from './composer/overrides.ts'
import { PassRows, PassRowsPending } from './composer/PassRows.tsx'
import { PreflightStrip } from './composer/PreflightStrip.tsx'
import { QUEUE_LABEL, RUN_LABEL, RunControl } from './composer/RunControl.tsx'
import type { RunState } from './composer/RunControl.tsx'
import { BriefPanel } from './composer/BriefPanel.tsx'
import { ToolsRow } from './composer/ToolsRow.tsx'
import { ResearchRow } from './composer/ResearchRow.tsx'
import { ProvenanceBadge } from './composer/ProvenanceBadge.tsx'
import { GATE_PROVENANCE_LABELS } from './composer/GatesLine.tsx'
import type { Provenance } from '@shared/config-schema.ts'
import { lensOptions } from '@shared/research.ts'
import {
  useBriefHeight,
  useBriefOpen,
  useOverrides,
  usePassesHeight,
  usePassesOpen,
} from './composer/state.ts'
import { useBrief } from './composer/useBrief.ts'
import { RecipeRow } from './composer/RecipeRow.tsx'
import { DepthRow } from './composer/DepthRow.tsx'
import { HEAD_TO_HEAD_STATUS, HeadToHeadRow, defaultSides } from './composer/HeadToHeadRow.tsx'
import type { HeadToHeadValue } from './composer/HeadToHeadRow.tsx'
import { useDepth, withDecidedDepth } from './composer/useDepth.ts'
import { PromptCheckRow } from './composer/PromptCheckRow.tsx'
import { usePromptCheck } from './composer/usePromptCheck.ts'
import { recipeOf, taskPlaceholder, useRecipeIntent, useRecipes } from './composer/recipes.ts'
import { useLiveChecks, valueFor } from './composer/useLiveChecks.ts'
import { useVendorModels } from './composer/useVendorModels.ts'

/** Typing in the path box settles this long before the folder's config and draft load. */
export const FOLDER_SETTLE_MS = 400

export { QUEUE_LABEL, RUN_LABEL } from './composer/RunControl.tsx'
export const FOLDER_BUSY_STATUS = 'Folder busy'
const RUN_STATUS_ID = 'composer-run-status'

interface Resolved {
  /** The last good answer (kept while a later request fails, so the rows can still be reset). */
  value: ResolvedWithProvenance | null
  /** The committed folder `value` answers for ('' without one). */
  folder: string
  error: string | null
  /** The error came from the run overrides (not the files). */
  fromOverrides: boolean
}

function usePlatform(): Platform {
  const info = useAppInfo()
  return info?.platform ?? getDimFactory()?.platform ?? 'linux'
}

/** core rejected the profile override (it does not exist for this folder). */
function unknownProfile(error: ResultError): boolean {
  if (error.code !== 'VALIDATION') return false
  const code = (error.details as { code?: unknown } | undefined)?.code
  return code === undefined || code === 'unknown-profile'
}

/** runs.start's PREFLIGHT_BLOCKED report (blocking checks only, as older builds read them). */
function startReport(error: ResultError): PreflightReport | null {
  const blocking = blockingChecks(error)
  if (blocking === null || blocking.length === 0) return null
  return { mode: 'authoritative', ok: false, blocking, warnings: [], info: [] }
}

/**
 * A run option's switch on its own line, with a constant note beside it: toggling it moves nothing. With `badge`, the
 * value's source (core's provenance) sits after the label, its room reserved so its arrival moves nothing either.
 */
function OptionRow({
  id,
  label,
  note,
  checked,
  disabled,
  onChange,
  badge,
}: {
  id: string
  label: string
  note: string
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
  badge?: { provenance: Provenance | undefined }
}): React.JSX.Element {
  return (
    <div data-testid={`${id}-row`} className="flex min-h-6 min-w-0 items-center gap-2">
      <label className="flex shrink-0 cursor-pointer items-center gap-2">
        <Switch
          data-testid={id}
          aria-label={label}
          aria-describedby={`${id}-note`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </label>
      {badge !== undefined && (
        // A fixed slot: the badge's source (and its colour) changing never moves the note after it.
        <span className="inline-flex w-16 shrink-0" data-testid={`${id}-provenance-slot`}>
          <ProvenanceBadge
            provenance={badge.provenance}
            testId={`${id}-provenance`}
            reserve={GATE_PROVENANCE_LABELS}
          />
        </span>
      )}
      <p
        id={`${id}-note`}
        data-testid={`${id}-note`}
        title={note}
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >
        {note}
      </p>
    </div>
  )
}

export function QuickComposer(): React.JSX.Element {
  const platform = usePlatform()
  const epoch = useConfigEpoch()
  // Core picks the default profile from vendor readiness, so a new probe result can change it.
  const probesById = useStore((s) => s.probes.byVendor)
  const probes = useProbes()
  const chips = useRecentFolders(platform)
  const lockRuns = useStore(
    useShallow((s) =>
      s.summaries.order
        .map((id) => s.summaries.byId[id])
        .filter((x): x is RunSummary => x !== undefined && holdsFolderLock(x)),
    ),
  )

  const [folder, setFolder] = useState(loadLastFolder)
  const [committed, setCommitted] = useState(() => folder.trim())
  const committedRef = useRef(committed)
  const [task, setTask] = useState(() => loadDraft(folder) ?? '')
  const [overrides, update, latestOverrides] = useOverrides()
  const [resolved, setResolved] = useState<Resolved>({
    value: null,
    folder: '',
    error: null,
    fromOverrides: false,
  })
  const [starting, setStarting] = useState(false)
  const [blocked, setBlocked] = useState<{ folder: string; report: PreflightReport } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gitNonce, setGitNonce] = useState(0)
  const [initializing, setInitializing] = useState(false)
  const [passesOpen, setPassesOpen] = usePassesOpen()
  const [briefOpen, setBriefOpen] = useBriefOpen()
  const [briefPx, measureBrief] = useBriefHeight()
  const models = useVendorModels(probes)
  // Head to head: off until switched on; the sides are filled in the first time it is, and kept after that.
  const [h2h, setH2h] = useState<HeadToHeadValue>({
    on: false,
    sides: [{ vendor: 'claude' }, { vendor: 'claude' }],
    blind: false,
  })
  const h2hFilled = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A run starting, waiting or ending changes core's folder.lock answer (Queue · Folder busy) and the estimate's
  // history, so the live check runs again on every run status change and whenever a run's folder lock changes
  // (core publishes the release: a stopped run is cancelled before it lets the folder go).
  const runStatuses = useStore((s) =>
    s.summaries.order
      .map((id) => {
        const r = s.summaries.byId[id]
        return `${id}:${r?.status ?? ''}:${r?.lock ?? ''}`
      })
      .join(' '),
  )

  // Estimates use new prices at once: an applied price update, its Undo or a price edit asks again.
  const catalogEpoch = useCatalogEpoch()
  // A folder trusted for a vendor (here, in the setup card or in Settings) asks again; the setup card's trust chip
  // names the folder the composer checks.
  const trustEpoch = useTrustEpoch()
  const liveFolder = isAbsoluteFolder(committed) ? committed : null
  useEffect(() => setComposerFolder(liveFolder), [liveFolder])
  const brief = useBrief({ folder: liveFolder, task, overrides, open: briefOpen })
  // The Recipe (not remembered: a fresh composer starts with None). Its id goes with every request below, so core
  // resolves it as the recipe layer; its brief defaults fill the Brief once core has answered for the folder.
  const [recipeId, setRecipeId] = useState<string | null>(null)
  const recipes = useRecipes(liveFolder, epoch)
  const recipe = recipeOf(recipes.list, recipeId)
  const sentRecipe = recipe?.recipe.id
  // Adaptive depth: core's Quick or Thorough for the task as typed; the checks below are asked with it, so the pass
  // rows, the strip and the estimate show the passes the run will have.
  const depth = useDepth({
    folder: liveFolder,
    task,
    overrides,
    brief: brief.input,
    recipe: sentRecipe,
    configEpoch: epoch,
  })
  const decision = depth.folder === liveFolder ? depth.decision : null
  // The prompt check: what the task as typed might leave out (core's answer, no model call).
  const promptCheck = usePromptCheck({ folder: liveFolder, task, recipe: sentRecipe })
  const checkOverrides = useMemo(() => withDecidedDepth(overrides, decision), [overrides, decision])
  const live = useLiveChecks({
    folder: liveFolder,
    overrides: checkOverrides,
    recipe: sentRecipe,
    brief: brief.input,
    configEpoch: epoch,
    catalogEpoch,
    trustEpoch,
    probes: probesById,
    nonce: gitNonce,
    runs: runStatuses,
  })

  /** The folder the user settled on: load its draft (when it has one) and its config; old blockers go. */
  const commitFolder = useCallback((next: string): void => {
    const f = next.trim()
    if (f === committedRef.current) return
    committedRef.current = f
    setCommitted(f)
    setBlocked(null)
    setError(null)
    const draft = loadDraft(f)
    if (draft !== null) setTask(draft)
    if (isAbsoluteFolder(f)) saveLastFolder(f)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => commitFolder(folder), FOLDER_SETTLE_MS)
    return () => clearTimeout(t)
  }, [folder, commitFolder])

  useEffect(() => {
    let live = true
    const sent = overridesForRequest(checkOverrides)
    const req = {
      ...(isAbsoluteFolder(committed) ? { folder: committed } : {}),
      ...(sent !== undefined ? { overrides: sent } : {}),
      ...(sentRecipe !== undefined ? { recipe: sentRecipe } : {}),
    }
    void invoke('config.resolve', req).then((r) => {
      if (!live) return
      if (r.ok) {
        setResolved({ value: r.value, folder: committed, error: null, fromOverrides: false })
        return
      }
      // A profile picked for another folder may not exist here: fall back to this folder's default.
      if (overrides.profile !== undefined && unknownProfile(r.error)) {
        update((o) => setProfile(o, null))
        return
      }
      setResolved((prev) => ({
        value: prev.folder === committed ? prev.value : null,
        folder: committed,
        error: r.error.message,
        fromOverrides: sent !== undefined,
      }))
    })
    return () => {
      live = false
    }
  }, [committed, overrides, checkOverrides, sentRecipe, epoch, probesById, gitNonce, update])

  // A recipe this folder does not have (a project recipe of the folder before) is no longer chosen.
  useEffect(() => {
    if (recipeId !== null && recipes.list !== null && recipe === undefined) setRecipeId(null)
  }, [recipeId, recipes.list, recipe])
  // The recipe's brief defaults, once per folder and recipe, as soon as core has answered for the folder. A New project
  // template's own Brief came with its recipe: the template's choices stand and the recipe adds none (as core does for
  // a run that sends a brief), so a FastAPI or landing-page template never gains a web app's defaults.
  const recipeApplied = useRef('')
  const recipeBriefGiven = useRef<{ folder: string; id: string } | null>(null)
  const applyRecipe = brief.applyRecipe
  useEffect(() => {
    if (recipe === undefined) {
      recipeApplied.current = ''
      return
    }
    const key = `${liveFolder ?? ''}|${recipe.recipe.id}|${recipe.sha256}`
    if (recipeApplied.current === key) return
    const given = recipeBriefGiven.current
    if (given !== null && given.id === recipe.recipe.id && given.folder === (liveFolder ?? '').trim()) {
      recipeApplied.current = key
      return
    }
    if (applyRecipe(recipe.recipe)) recipeApplied.current = key
  }, [recipe, liveFolder, applyRecipe])
  // The palette or a New project template chose a recipe (by id).
  useRecipeIntent((id) => setRecipeId(id))

  const pickFolder = (f: string): void => {
    setFolder(f)
    commitFolder(f)
  }

  const chooseFolder = async (): Promise<void> => {
    const cur = folder.trim()
    const r = await invoke('dialog.pickFolder', isAbsoluteFolder(cur) ? { defaultPath: cur } : {})
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    if (r.value !== null && mounted.current) pickFolder(r.value)
  }

  const onTask = (text: string): void => {
    setTask(text)
    saveDraft(folder, text)
  }

  const value = resolved.value
  const config = value?.config ?? null
  const profiles = value !== null ? (value.profiles ?? [value.config.profile]) : []
  // The switch shows the user's own pending choice at once; everything Auto changes comes from core's resolve.
  const auto = overrides.auto ?? config?.auto ?? false
  // The security advisor (opt-in): the run's choice, else the profile's or the project's.
  const security = securityOnOf(config, overrides)
  // Clarify before Plan and Fix until green: the run's choice, else the profile's or the project's.
  const clarify = clarifyOnOf(config, overrides)
  const deploy = deployOnOf(config, overrides)
  const acceptance = acceptanceOnOf(config, overrides)
  const explain = explainOnOf(config, overrides)
  // Research before Plan: the run's choice, else the profile's or the project's, else the brief pack's default.
  const researchPack = brief.pack?.pack
  // Core turns a pack's default on only for a run that sends a brief of that category.
  const packResearch =
    brief.input !== undefined &&
    researchPack?.id === brief.input.category &&
    researchPack.research?.on === true
  const research = researchOnOf(config, overrides, packResearch)
  const lensChoices = brief.ctx !== null ? lensOptions(brief.ctx.research, researchPack) : []
  const lenses = researchLensesOf(config, overrides, brief.ctx?.research, researchPack)
  const planVendor =
    overrides.passes?.plan?.vendor ?? (config !== null ? passOf(config, 'plan').vendor : null)
  const planProbeVendor = planVendor?.startsWith('local-') === true ? 'codex' : planVendor
  const researchWeb = probes.find((p) => p.vendor === planProbeVendor)?.probe?.capabilities.web
  const fixLoop = fixRoundsOf(config, overrides) > 1
  const folderText = folder.trim()
  const settled = folderText === committed
  // Core's answers for exactly the folder in the box.
  const report = settled ? valueFor(live.preflight, liveFolder) : null
  const estimate = settled ? valueFor(live.estimate, liveFolder) : null
  const shownBlocked = blocked !== null && settled && blocked.folder === committed ? blocked.report : null
  const stripReport = shownBlocked ?? report
  const blocking = stripReport?.blocking ?? []
  const folderKey = value !== null && resolved.folder === folderText ? value.folderKey : null
  // Queue ("Folder busy") is core's folder.lock answer: until core has answered for this folder, Run reads plain Run
  // (Checking… when slow). Only a core not known to answer preflight.run (an older one: UNSUPPORTED; or before its
  // first answer this session) has the older reading of core's run statuses and folderKey stand in.
  const busy = live.coreChecks
    ? queueCheck(report) !== null
    : wouldQueue(folderText, folderKey, lockRuns, platform)
  const busyTitle = queueCheck(report)?.title ?? null
  const disabledReason =
    folderText === ''
      ? 'Choose a folder first'
      : !isAbsoluteFolder(folderText)
        ? 'Enter the full path of the folder'
        : task.trim() === ''
          ? 'Describe the task first'
          : blocking.length > 0
            ? blockedReason(blocking)
            : null
  const canRun = disabledReason === null && !starting

  const start = async (): Promise<void> => {
    if (!canRun) return
    // The overrides as updated so far (a field committing as ⌘/Ctrl+Enter was pressed is not rendered yet).
    const sent = overridesForRequest(latestOverrides())
    setStarting(true)
    setBlocked(null)
    setError(null)
    const sentBrief = brief.input
    const request = {
      folder: folderText,
      task: task.trim(),
      ...(sent !== undefined ? { overrides: sent } : {}),
      ...(sentBrief !== undefined ? { brief: sentBrief } : {}),
      ...(sentRecipe !== undefined ? { recipe: sentRecipe } : {}),
    }
    // Head to head: the same request for both sides, and who builds each.
    const r = h2h.on
      ? await invoke('matches.start', { ...request, sides: h2h.sides, ...(h2h.blind ? { blind: true } : {}) })
      : await invoke('runs.start', request)
    if (!mounted.current) return
    setStarting(false)
    if (r.ok) {
      saveDraft(folderText, '')
      saveLastFolder(folderText)
      setTask('')
      navigate(
        'matchId' in r.value
          ? { name: 'match', matchId: r.value.matchId }
          : { name: 'run', runId: r.value.runId },
      )
      return
    }
    const checks = blockingChecks(r.error)
    const rep = startReport(r.error)
    if (rep !== null) {
      // Core's authoritative answer replaces whatever live check was still in flight.
      live.invalidate()
      setBlocked({ folder: folderText, report: rep })
      return
    }
    setError(r.error.message)
    if (checks === null) toast({ level: 'error', message: r.error.message })
  }

  useShortcut(KEYS.runOrApprove, () => void start(), { description: 'Run' })

  const liveRecheck = live.recheck
  const recheck = useCallback(async (): Promise<void> => {
    setBlocked(null)
    await liveRecheck()
  }, [liveRecheck])
  // runs.start's report stands until what it answered for changes (or Check again): the live check cannot replace
  // it on its own, since only the authoritative one re-runs the vendor's login status.
  useEffect(() => setBlocked(null), [overrides, sentRecipe, epoch, probesById])

  const initGit = async (): Promise<void> => {
    if (liveFolder === null) return
    setInitializing(true)
    const r = await invoke('git.init', { folder: liveFolder })
    if (!mounted.current) return
    setInitializing(false)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    toast({
      level: 'info',
      message: `Initialized a git repository in ${liveFolder}. Dim Factory made no commit; delete the .git folder to undo it.`,
    })
    // The scope root, the git checks and the estimate all change: resolve and check again now.
    setBlocked(null)
    setGitNonce((n) => n + 1)
  }

  const actions = useComposerActions(liveFolder, overrides, update)
  const [passesPx, measurePasses] = usePassesHeight()

  const section = useRef<HTMLElement>(null)
  const runRow = useRef<HTMLDivElement>(null)
  const taskBox = useRef<HTMLTextAreaElement>(null)
  // The palette's New run and Folders (components/palette): choose the folder as its chip would, then the task box.
  // New project: the folder, its task and its template's Brief, then Run (the user reads the checks and presses it).
  // The intent's recipe is chosen in the Recipe menu (its brief defaults then fill only the groups the template left
  // unset).
  const [focusRun, setFocusRun] = useState(0)
  useComposerIntent((intent) => {
    if (intent.folder !== undefined) pickFolder(intent.folder)
    const f = intent.folder?.trim() ?? committedRef.current
    if (intent.brief !== undefined && isAbsoluteFolder(f)) brief.preset(f, intent.brief)
    if (intent.recipe !== undefined) {
      recipeBriefGiven.current = intent.brief !== undefined ? { folder: f, id: intent.recipe } : null
      setRecipeId(intent.recipe)
    }
    if (intent.task !== undefined) {
      setTask(intent.task)
      saveDraft(f, intent.task)
      setFocusRun((n) => n + 1)
      return
    }
    taskBox.current?.focus()
  })
  // After the render that shows the task: Run takes the focus (its wrapper, which names why, while it is disabled).
  useEffect(() => {
    if (focusRun === 0) return
    const button = section.current?.querySelector<HTMLButtonElement>('[data-testid="composer-run"]')
    if (button === null || button === undefined) return
    const target = button.disabled ? button.parentElement : button
    target?.focus({ preventScroll: true })
  }, [focusRun])

  const checkingLabel = live.slow && settled && liveFolder !== null
  const blockedNow = !starting && blocking.length > 0 && !checkingLabel
  // What Run would do now, beside it (the label is one of RUN_LABELS, so Run keeps one width whatever this says).
  const runStatusText = starting
    ? 'Starting…'
    : blockedNow
      ? blockedLabel(blocking)
      : error !== null
        ? error
        : checkingLabel
          ? 'Checking…'
          : // A match's sides work in their own copies, so a run going in the folder does not hold them up.
            busy && !h2h.on
            ? FOLDER_BUSY_STATUS
            : h2h.on
              ? HEAD_TO_HEAD_STATUS
              : ''
  const runState = (alert: boolean): RunState => ({
    label: busy && !h2h.on ? QUEUE_LABEL : RUN_LABEL,
    // A failed start is an alert, once: in the composer's row, not again in the compact bar.
    status:
      alert && !starting && !blockedNow && error !== null ? (
        <span role="alert" data-testid="composer-error">
          {error}
        </span>
      ) : (
        runStatusText
      ),
    statusText: runStatusText,
    statusBlocked: blockedNow || (!starting && error !== null && runStatusText === error),
    disabledReason,
    starting,
    busyTooltip:
      busy && !h2h.on
        ? `${busyTitle ?? 'A run in this folder is still going'}. This one waits for it, then starts.`
        : null,
    canRun,
    onRun: () => void start(),
  })

  const gates = config !== null ? gatesOf(config) : null
  // The plan gate waits for you only when Plan runs (a Quick run has none).
  const planRuns = config === null || config.passes.plan.enabled
  const gateOn = gates !== null && ((gates.afterPlan && planRuns) || gates.beforeFix)
  const scopeNote =
    value !== null && resolved.folder === committed && settled
      ? scopeRootNote(committed, value.scopeRoot, platform)
      : null
  const notGit = settled && notGitRepo(report)
  const liveError =
    live.preflight.status === 'error' && live.preflight.folder === liveFolder ? live.preflight.message : null
  // A polite live region (accessibility): what core's live checks now say about Run. runs.start's blocked
  // report has its own alert, so only live answers are announced here.
  const announcement =
    liveFolder !== null && settled && shownBlocked === null ? checksAnnouncement(report, liveError, busy) : ''
  const configError =
    resolved.error === null
      ? null
      : resolved.fromOverrides
        ? `Could not apply your changes: ${resolved.error}`
        : `Could not read the configuration: ${resolved.error} Runs use the default profile.`
  const checked = liveFolder !== null && settled
  const stripShown = checked && (live.preflight.status !== 'unavailable' || shownBlocked !== null)
  const estimateError = live.estimate.status === 'error' && live.estimate.folder === liveFolder

  return (
    <>
      <CompactRunBar
        watch={runRow}
        composer={section}
        taskBox={taskBox}
        folder={folderText}
        task={task}
        run={runState(false)}
      />
      {/* In the page's flow at one height: what core answers fills places kept for it, and only the user opens more. */}
      <section ref={section} aria-label="New run" data-testid="composer" className="border-b px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-2.5">
          <FolderPicker
            platform={platform}
            folder={folder}
            chips={chips}
            onChange={setFolder}
            onCommit={() => commitFolder(folder)}
            onPick={pickFolder}
            onChoose={() => void chooseFolder()}
            scopeNote={scopeNote}
            notGit={notGit}
            initializing={initializing}
            onInitGit={() => void initGit()}
          />
          <RecipeRow list={recipes.list} selected={recipe} error={recipes.error} onChange={setRecipeId} />
          {/* Grows with what is typed (the user's action), up to a fixed height; past it, it scrolls inside. */}
          <Textarea
            ref={taskBox}
            data-testid="composer-task"
            data-scroll-region="task-input"
            aria-label="Task"
            value={task}
            rows={3}
            placeholder={taskPlaceholder(recipe?.recipe)}
            onChange={(e) => onTask(e.target.value)}
            className="field-sizing-content max-h-60 min-h-20 resize-none scroll-region"
          />
          {/* What the task might leave out: one line that is always there, so its answer moves nothing. */}
          <PromptCheckRow
            view={promptCheck.folder === liveFolder ? promptCheck.view : null}
            folder={liveFolder}
            task={task}
            recipe={sentRecipe}
            onUse={onTask}
          />
          <BriefPanel
            brief={brief}
            open={briefOpen}
            onOpen={setBriefOpen}
            hasFolder={liveFolder !== null}
            reservedPx={briefPx}
            onMeasure={measureBrief}
          />
          {/* One line that never wraps: Run stays at the row's right end whatever the status beside it says. */}
          <div ref={runRow} data-testid="composer-run-row" className="flex items-center gap-x-4">
            <div className="flex shrink-0 items-center gap-2">
              <span id="composer-profile-label" className="text-xs font-medium text-muted-foreground">
                Profile
              </span>
              <Select
                value={config?.profile ?? ''}
                onValueChange={(v) => update((o) => setProfile(o, v))}
                disabled={profiles.length === 0}
              >
                <SelectTrigger
                  size="sm"
                  data-testid="composer-profile"
                  aria-labelledby="composer-profile-label"
                  // Narrower in a small window, so the status beside Run ("Fix 12 issues to run") still fits.
                  className="w-36 lg:w-44"
                >
                  <SelectValue placeholder="Default profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Tooltip content="Auto mode: Implement and Fix approve everything, both gates are off, and every tool call is still logged">
              <label className="flex shrink-0 cursor-pointer items-center gap-2">
                <Switch
                  tone="auto"
                  data-testid="composer-auto"
                  aria-label="Auto mode"
                  checked={auto}
                  onCheckedChange={(v) => update((o) => setAuto(o, v))}
                />
                <span
                  className={cn(
                    'text-xs font-semibold tracking-wide',
                    auto ? 'text-auto' : 'text-muted-foreground',
                  )}
                >
                  AUTO
                </span>
              </label>
            </Tooltip>
            {/* The rest of the row, right-aligned: the status takes what room is left (cut with an ellipsis, read in
                full through Run's aria-describedby and its title), so it can neither push Run along nor wrap it. */}
            <RunControl
              run={runState(true)}
              buttonTestId="composer-run"
              statusId={RUN_STATUS_ID}
              statusTestId="composer-run-status"
            />
          </div>
          {/* Quick or Thorough: the choice and core's decision on one line of one height. */}
          <DepthRow
            value={overrides.depth}
            decision={decision}
            hasFolder={liveFolder !== null}
            onChange={(v) => update((o) => setDepth(o, v))}
          />
          {/* Head to head: one line that is always there; the two sides open under it on the switch. */}
          <HeadToHeadRow
            value={h2h}
            onChange={setH2h}
            onToggle={(on) => {
              const fill = on && !h2hFilled.current && config !== null
              if (fill) h2hFilled.current = true
              setH2h((cur) => ({
                ...cur,
                on,
                ...(fill
                  ? { sides: defaultSides(passOf(config, 'implement'), probes, localPresetVendors(config)) }
                  : {}),
              }))
            }}
            probes={probes}
            presets={config !== null ? localPresetVendors(config) : []}
            models={models.options}
            onWantModels={models.want}
            openTask={promptCheck.folder === liveFolder && (promptCheck.view?.hints.length ?? 0) > 0}
          />
          {/* The security advisor's switch, always on its own line with a constant note: toggling it moves nothing. */}
          <div data-testid="composer-security-row" className="flex min-h-6 min-w-0 items-center gap-2">
            <label className="flex shrink-0 cursor-pointer items-center gap-2">
              <Switch
                data-testid="composer-security"
                aria-label="Security review"
                aria-describedby="composer-security-note"
                checked={security}
                disabled={config === null}
                onCheckedChange={(v) => update((o) => setPassValues(o, 'security', { enabled: v }))}
              />
              <span className="text-xs font-medium text-muted-foreground">Security review</span>
            </label>
            <p
              id="composer-security-note"
              data-testid="composer-security-note"
              title={SECURITY_COST_NOTE}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {SECURITY_COST_NOTE}
            </p>
          </div>
          {/* Clarify before Plan and Fix until green: the same kind of row as the security switch (constant notes). */}
          <OptionRow
            id="composer-clarify"
            label="Clarify first"
            note={CLARIFY_NOTE}
            checked={clarify}
            disabled={config === null}
            onChange={(v) => update((o) => setPassValues(o, 'plan', { clarify: v }))}
          />
          <ResearchRow
            checked={research}
            disabled={config === null}
            note={researchNote({
              on: research,
              cost: research ? researchCostText(estimate) : null,
              suggest: looksLikeNewWork(task),
              web: researchWeb,
            })}
            options={lensChoices}
            ticked={lenses}
            web={researchWeb}
            onChange={(v) => update((o) => setPassValues(o, 'plan', { research: v }))}
            onLens={(id, on) =>
              update((o) =>
                setPassValues(o, 'plan', {
                  researchLenses: toggleLens(
                    lenses,
                    id,
                    on,
                    lensChoices.map((l) => l.id),
                  ),
                }),
              )
            }
          />
          <OptionRow
            id="composer-acceptance"
            label="Acceptance review"
            note={ACCEPTANCE_NOTE}
            checked={acceptance}
            disabled={config === null}
            badge={{ provenance: value?.provenance['/passes/review/acceptance'] }}
            onChange={(v) => update((o) => setPassValues(o, 'review', { acceptance: v }))}
          />
          <OptionRow
            id="composer-explain"
            label="Explain it to me"
            note={EXPLAIN_NOTE}
            checked={explain}
            disabled={config === null}
            badge={{ provenance: value?.provenance['/passes/plan/explain'] }}
            onChange={(v) => update((o) => setPassValues(o, 'plan', { explain: v }))}
          />
          <OptionRow
            id="composer-fix-loop"
            label="Fix until green"
            note={FIX_UNTIL_GREEN_NOTE}
            checked={fixLoop}
            disabled={config === null}
            onChange={(v) => update((o) => setPassValues(o, 'fix', { rounds: fixRoundsFor(v, config, o) }))}
          />
          <OptionRow
            id="composer-deploy"
            label="Deploy config"
            note={DEPLOY_NOTE}
            checked={deploy}
            disabled={config === null}
            onChange={(v) => update((o) => setPassValues(o, 'implement', { deploy: v }))}
          />
          {config !== null && value !== null ? (
            <PassRows
              config={config}
              provenance={value.provenance}
              probes={probes}
              report={report}
              estimate={estimate}
              overrides={overrides}
              update={update}
              actions={actions}
              models={models}
              folder={liveFolder}
              open={passesOpen}
              onOpen={setPassesOpen}
              suggestions={value.suggestions}
              error={configError}
              onMeasure={measurePasses}
            />
          ) : (
            <PassRowsPending
              open={passesOpen}
              onOpen={setPassesOpen}
              reservedPx={passesPx}
              error={configError}
            />
          )}
          {/* Tools and Use skill for this run, after the pass rows they act on: one row at one height. */}
          <ToolsRow config={config} folder={liveFolder} task={task} overrides={overrides} update={update} />
          {/* The strip's summary row is always here (a hint before there is a folder to check). */}
          <div data-testid="preflight-slot" className="min-h-7">
            {stripShown ? (
              <PreflightStrip
                report={stripReport}
                source={shownBlocked !== null ? 'start' : 'live'}
                folder={liveFolder}
                checking={live.checking}
                error={liveError}
                onRecheck={recheck}
                onOverrides={(ops) => update((o) => applyOverrideOps(o, ops))}
              />
            ) : (
              live.preflight.status !== 'unavailable' && (
                <p
                  data-testid="preflight-hint"
                  className="flex h-7 items-center text-xs text-muted-foreground"
                >
                  The folder and the vendors are checked once you choose a folder.
                </p>
              )
            )}
          </div>
          <div data-testid="estimate-slot" className="h-5 min-w-0">
            {estimate !== null ? (
              <EstimateLine estimate={estimate} gateOn={gateOn} />
            ) : (
              live.estimate.status !== 'unavailable' && (
                <EstimatePending
                  text={
                    !checked
                      ? 'The estimate follows once you choose a folder.'
                      : estimateError
                        ? 'No estimate for this folder.'
                        : 'Estimating…'
                  }
                />
              )
            )}
          </div>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="composer-checks-status"
          >
            {announcement}
          </p>
        </div>
      </section>
    </>
  )
}
