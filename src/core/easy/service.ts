// Easy mode's core side: how the app is used (`ui.experience`, and whether a new user is asked once), Easy's settings,
// resolving an idea into what would be made (local detection only: no tokens, no network), making the project folder
// from its template and starting the run (an ordinary run: Easy recipe plus an overrides layer), follow-up runs in a
// project ("Make a change", "Continue with more"), and the project list (every folder with runs, Easy's or Full's).
// Easy writes only `ui.experience` to the user file (and the Easy settings the user changes); everything a run needs
// travels with the run. What Easy made, and the choice the user made on the confirm screen, are kept in
// `<home>/easy/projects.json`; the project permission itself is a trust.json grant on the new folder (permission.ts),
// given right after the folder is made and before the run starts. Files the user added are checked before anything is
// made and copied into the new folder (attach.ts).
// Also: a run in a folder the user already has (existing.ts decides how: an isolated copy, or in place with undo; never
// the project permission), the kinds a vague idea could mean (asked on the confirm screen; a model only helps choose
// when the user asks), and the overnight list (several new projects, each a task on the factory's queue, made one
// after another or on the factory's schedule; the user file's `factory.schedule` is written only when the user picks
// a time).
// A change (Make a change, a folder the user already has, carrying on) runs with the folder's saved Brief, the secret
// scan every time (the full security review when the change names keys or people's data, or its diff touches such
// code), lighter models and no Critic when it is small (change.ts), and its estimate can be asked for before it starts.
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Pack } from '../../shared/brief.ts'
import type {
  EasySettings,
  Experience,
  RunLimits,
  RunOverrides,
  SecurityReview,
  VerifyCommandConfig,
} from '../../shared/config-schema.ts'
import { EASY_DEFAULTS, EXPERIENCES } from '../../shared/config-schema.ts'
import {
  EASY_ATTACH_MAX_FILES,
  EASY_CHANGE_MAX,
  EASY_CHANGE_RECIPE,
  EASY_EXISTING_RECIPE,
  EASY_IDEA_MAX,
  EASY_KIND_RECIPE,
  EASY_NON_CODE_KINDS,
  EASY_QUEUE_MAX,
  EASY_RESEARCH_KINDS,
  EASY_WEB_KINDS,
  isEasyKind,
} from '../../shared/easy.ts'
import type {
  EasyAttachment,
  EasyChangeEstimate,
  EasyChangeRequest,
  EasyCreateRequest,
  EasyFolderFacts,
  EasyFolderMode,
  EasyFolderView,
  EasyIntentHelper,
  EasyKind,
  EasyMultiplayer,
  EasyNeedAnswers,
  EasyNeedView,
  EasyProjectView,
  EasyQueueAddRequest,
  EasyQueueItem,
  EasyQueueStartRequest,
  EasyQueueView,
  EasyQueueWarning,
  EasyResolveRequest,
  EasyResolved,
  EasyStarted,
  EasyState,
  EasyToolchain,
  EasyWorkRequest,
} from '../../shared/easy.ts'
import { CLOCK_TIME } from '../../shared/factory.ts'
import type { QueueEasyRun, QueueView } from '../../shared/factory.ts'
import type { Percentiles, RunEstimate } from '../../shared/estimates.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import type { RunStartRequest, RunStarted } from '../../shared/ipc.ts'
import type { MatchContestant } from '../../shared/match.ts'
import type { RunSummary } from '../../shared/run.ts'
import type { BriefInput } from '../../shared/brief.ts'
import type { Template, TemplatesList, TemplateView } from '../../shared/templates.ts'
import type { DepthDecision, DepthSetting } from '../../shared/depth.ts'
import type { BuiltinProfileName } from '../config/defaults.ts'
import { BRAND } from '../../shared/brand.ts'
import { DimFactoryError } from '../errors.ts'
import type { MemorySeed } from '../factory/memory.ts'
import type { Logger } from '../log.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { isPlainObject, readVersionedJson } from '../store/versions.ts'
import { readBuiltinRecipes } from '../recipes/load.ts'
import { changeTouchesSensitive, isSmallChange, notWorkingTask } from './change.ts'
import { detectNeeds, needsNote } from './needs.ts'
import { easyOverrides } from './overrides.ts'
import { PROJECTS_FOLDER_NAME, defaultProjectsDir } from './projects-dir.ts'
import {
  ambiguousKinds,
  attachmentsNote,
  briefUsesPhotos,
  changeTask,
  asksOnlinePlay,
  chooseStack,
  chooseTemplate,
  continueTask,
  detectKind,
  easyTask,
  freeFolder,
  ideaBrief,
  onlineInstead,
  slugOf,
  titleOf,
  withEasyLook,
} from './resolve.ts'
import { INTENT_NO_VENDOR } from './intent.ts'
import { twoErrorText, twoSides } from './two.ts'

export { PROJECTS_FOLDER_NAME }

/** The most projects `easy/projects.json` remembers (the oldest are forgotten). */
const PROJECTS_MAX = 500

/** A run in a folder that is no git repository needs undo turned on first (git init). */
export const TURN_ON_UNDO_FIRST = 'Turn on undo for this folder first, so everything it does can be undone.'

export interface EasyReadiness {
  claude: boolean
  codex: boolean
  /** The profile for the vendors that are ready (balanced, claude-only or codex-only). */
  profile: BuiltinProfileName
  /** Some vendor can run it. */
  runnable: boolean
}

export interface EasyDeps {
  home: string
  /** The user's Documents folder (the default projects folder is inside it, unless OneDrive syncs it). */
  documentsDir: string
  /**
   * The user's own folder (%USERPROFILE%, the home folder): the default projects folder is there when OneDrive syncs
   * Documents (projects-dir.ts). Absent: always in Documents.
   */
  userDir?: string
  /** The environment OneDrive's variables are read from (default: none). */
  env?: Readonly<Record<string, string | undefined>>
  /** No runs, no finished first launch and no user settings file when this process started: a new user. */
  newHome: boolean
  log: Logger
  now: () => number
  /** The user dimfactory.json as parsed (null: none or unreadable). */
  readUser(): Promise<unknown>
  /** A JSON Patch to the user dimfactory.json (validated like Settings' writes). */
  patchUser(ops: JsonPatchOp[]): Promise<void>
  packs(): Promise<Pack[]>
  templates(): Promise<TemplatesList>
  readiness(): EasyReadiness
  /** What is installed (`fresh`: read Node.js's version again, after the user installed it). */
  toolchain(o?: { fresh?: boolean }): Promise<EasyToolchain>
  /** The estimate for a run as runs.start would run it, its depth decided the same way (null: none). */
  estimate(req: RunStartRequest, hints?: EasyDepthHints): Promise<RunEstimate | null>
  /** Quick or Thorough for a run, as runs.start will decide it (null: the config does not resolve). Absent: unknown. */
  depth?: (req: RunStartRequest, hints: EasyDepthHints) => Promise<DepthDecision | null>
  /** Check, create and git-init a new project folder (New project's rules); answers the absolute folder. */
  prepareFolder(folder: string): Promise<string>
  saveBrief(folder: string, brief: BriefInput): Promise<void>
  /** The folder's saved Brief (null: none); a change runs with it, so its look and choices carry on. */
  readBrief?: (folder: string) => Promise<BriefInput | null>
  /**
   * Copy the template's bundled files (a game's starter engine) into the folder just made (templates/files.ts): the
   * project-relative paths written. Absent: nothing is copied.
   */
  copyTemplateFiles?: (view: TemplateView, folder: string) => Promise<string[]>
  startRun(req: RunStartRequest, hints?: EasyDepthHints): Promise<RunStarted>
  /**
   * "Make two and pick": the run started twice as a match, each version in its own copy of the folder, the builders'
   * names hidden until one is kept. Answers the match and its first version's run. Absent: not available here.
   */
  startTwo?: (
    req: RunStartRequest,
    sides: readonly [MatchContestant, MatchContestant],
    hints?: EasyDepthHints,
  ) => Promise<RunStarted & { matchId: string }>
  summaries(): RunSummary[]
  /**
   * Close a failed run (its open failure card goes; it lets go of its folder), so Carry on's new run can start there.
   * Absent: nothing is closed.
   */
  closeRun?: (runId: string) => Promise<void>
  /** A run's task (its run.json), for "Continue with more"; null when the run is unknown. */
  runTask(runId: string): Promise<{ task: string; folder: string } | null>
  exists(path: string): boolean
  /** Give the project permission to a folder Easy just made (permission.ts); absent: it is only recorded. */
  grantPermission?: (folder: string) => Promise<void>
  /** Check added files (attach.ts checkAttachments). */
  checkAttachments?: (paths: readonly string[]) => Promise<EasyAttachment[]>
  /** Copy added files into the new project (attach.ts copyAttachments): the project-relative paths written. */
  copyAttachments?: (paths: readonly string[], project: string) => Promise<string[]>
  /** The checks the folder has of its own (verify detection, no model): a change run checks with them. */
  checks?: (folder: string) => Promise<VerifyCommandConfig[]>
  /** A folder the user already has, as a run would work there (existing.ts; read only). */
  inspectFolder?: (folder: string) => Promise<EasyFolderFacts>
  /** "Turn on undo for this folder": git init, no commit (the recovery executor's own code). */
  turnOnUndo?: (folder: string) => Promise<void>
  /** "Save my changes first": one commit of everything in the folder's repository (save-first.ts). */
  saveFirst?: (folder: string) => Promise<void>
  /** Who could help choose a vague idea's kind, and about what it costs (no tokens; null: nobody is ready). */
  intentHelper?: () => Promise<EasyIntentHelper | null>
  /** The factory's queue, for the overnight list. */
  queue?: EasyQueueDeps
}

/**
 * What adaptive depth should know about an Easy run beyond its task: it is a beginner's, a new project from an idea,
 * what the idea needs, and the user's own words (an Easy task also carries Easy's notes).
 */
export interface EasyDepthHints {
  easy: true
  newProject?: boolean
  needs?: readonly string[]
  words?: string
}

/** What the overnight list needs of the factory (core/factory/service.ts). */
export interface EasyQueueDeps {
  add(folder: string, task: { task: string; recipe: string; easy: QueueEasyRun }): Promise<void>
  view(): QueueView
  start(folders: string[], noticeId?: string): Promise<void>
  pause(folders: string[]): Promise<void>
  remove(folder: string, id: string): Promise<void>
  /** Turn the factory's schedule on at `at` (`HH:MM`, every day, no end): the user file's `factory.schedule`. */
  schedule(at: string): Promise<void>
}

interface EasyProjectRecord {
  folder: string
  idea: string
  kind: EasyKind
  templateId: string
  createdAt: number
  consent: boolean
  /** A game made with the user's own photos (its Brief's look). */
  photos?: boolean
  /** Overnight: the kind was decided from the words, not picked (a vague idea is warned about). */
  guessed?: boolean
  /** Overnight: the estimate when it was added (absent: none). */
  estimate?: { durationMs: Percentiles; costUsd: Percentiles | null }
}

/** Adaptive depth's hints for a new project made from an idea: always a beginner's new project. */
function newProjectHints(idea: string, needs: readonly EasyNeedView[]): EasyDepthHints {
  return { easy: true, newProject: true, words: idea, needs: needs.map((n) => n.need) }
}

/** Adaptive depth's hints for a change: the user's own words and what they need. */
function changeHints(words: string, kind: EasyKind | undefined): EasyDepthHints {
  const needs = detectNeeds(words, kind ?? 'website').map((n) => n.need)
  return { easy: true, words, ...(needs.length > 0 ? { needs } : {}) }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

/** `ui.experience` and the `easy` section of a parsed user file, defensively (a hand-edited file may hold anything). */
export function readEasyUser(raw: unknown): { experience: Experience | null; settings: EasySettings } {
  const root = isPlainObject(raw) ? raw : {}
  const ui = isPlainObject(root['ui']) ? root['ui'] : {}
  const e = isPlainObject(root['easy']) ? root['easy'] : {}
  const exp = ui['experience']
  const minutes = num(e['maxMinutes'])
  return {
    experience: (EXPERIENCES as readonly unknown[]).includes(exp) ? (exp as Experience) : null,
    settings: {
      projectsDir: str(e['projectsDir']),
      maxCostUsd: num(e['maxCostUsd']),
      changeMaxCostUsd: num(e['changeMaxCostUsd']),
      maxMinutes: minutes !== null ? Math.round(minutes) : null,
      skipPlanCheck: e['skipPlanCheck'] === true,
    },
  }
}

/** Added files, as the request gave them (none: an empty list). */
function attachmentsOf(req: EasyCreateRequest): string[] {
  const list = req.attachments ?? []
  if (list.length > EASY_ATTACH_MAX_FILES) {
    throw new DimFactoryError('VALIDATION', `Add up to ${EASY_ATTACH_MAX_FILES} files.`)
  }
  return list
}

export class EasyService {
  readonly #d: EasyDeps
  #chain: Promise<void> = Promise.resolve()

  constructor(d: EasyDeps) {
    this.#d = d
  }

  /** The default projects folder: in Documents, or in the user's own folder when OneDrive syncs Documents. */
  get #defaultDir(): { dir: string; reason?: 'onedrive' } {
    if (this.#d.userDir === undefined) return { dir: join(this.#d.documentsDir, PROJECTS_FOLDER_NAME) }
    return defaultProjectsDir({
      documentsDir: this.#d.documentsDir,
      homeDir: this.#d.userDir,
      env: this.#d.env ?? {},
    })
  }

  get defaultProjectsDir(): string {
    return this.#defaultDir.dir
  }

  async #user(): Promise<{ experience: Experience | null; settings: EasySettings }> {
    return readEasyUser(await this.#d.readUser().catch(() => null))
  }

  async state(): Promise<EasyState> {
    const { experience, settings } = await this.#user()
    const hasRuns = this.#d.summaries().length > 0
    const def = this.#defaultDir
    return {
      experience,
      askWelcome: experience === null && this.#d.newHome && !hasRuns,
      settings: { ...EASY_DEFAULTS, ...settings },
      projectsDir: settings.projectsDir ?? def.dir,
      defaultProjectsDir: def.dir,
      ...(def.reason !== undefined ? { defaultProjectsReason: def.reason } : {}),
    }
  }

  /** Easy or Full control, from the welcome card, the sidebar switch or the palette. Switching never touches a run. */
  async setExperience(experience: Experience): Promise<EasyState> {
    await this.#d.patchUser([{ op: 'add', path: '/ui/experience', value: experience }])
    return this.state()
  }

  // ---- resolving --------------------------------------------------------------------------------------------------

  async resolve(req: EasyResolveRequest): Promise<EasyResolved> {
    const idea = cleanIdea(req.idea)
    const [packs, list, toolchain, user] = await Promise.all([
      this.#d.packs(),
      this.#d.templates(),
      this.#d.toolchain(req.recheck === true ? { fresh: true } : {}),
      this.#user(),
    ])
    const guess =
      req.kind !== undefined ? { kind: req.kind, source: 'chosen' as const } : detectKind(idea, packs)
    const choice = chooseTemplate(guess.kind, idea, toolchain, req.stack)
    const stack = chooseStack(guess.kind, idea, toolchain, req.stack)
    const template = templateOf(list, choice.templateId)
    const needs = detectNeeds(idea, guess.kind)
    const checks = templateChecks(template, toolchain)
    const projectsDir = user.settings.projectsDir ?? this.defaultProjectsDir
    const { folder, name } = freeFolder(projectsDir, slugOf(idea), (p) => this.#d.exists(p))
    const ready = this.#d.readiness()
    const limits: RunLimits = { maxCostUsd: user.settings.maxCostUsd, maxMinutes: user.settings.maxMinutes }
    const recipe = EASY_KIND_RECIPE[guess.kind]
    const startReq = this.#startRequest(
      {
        folder,
        idea,
        template,
        brief: easyBrief(guess.kind, template, idea, packs),
        recipe,
        profile: ready.profile,
        limits,
        kind: guess.kind,
        checks,
        needs,
        ...(req.depth !== undefined ? { depth: req.depth } : {}),
      },
      user,
    )
    const hints = newProjectHints(idea, needs)
    const est = ready.runnable
      ? await this.#d.estimate(startReq, hints).catch((err: unknown) => {
          this.#d.log.info('no estimate for an Easy idea', { err })
          return null
        })
      : null
    // Quick or Thorough, and why: the confirm screen shows it and lets the user force either.
    const depth =
      ready.runnable && this.#d.depth !== undefined
        ? await this.#d.depth(startReq, hints).catch((err: unknown) => {
            this.#d.log.info('no depth for an Easy idea', { err })
            return null
          })
        : null
    const wanted =
      choice.fallback !== undefined
        ? list.templates.find((v) => v.template.id === choice.fallback?.wanted)
        : undefined
    // A vague idea (and no kind chosen yet): the confirm screen asks which the user meant; who could help choose is
    // only found out here (no model call: a call happens only when the user asks for it).
    const candidates = req.kind === undefined ? ambiguousKinds(idea, packs) : []
    // Online play is never made in Easy: a game whose idea asks for it is made for one of the ways that need no server.
    const online =
      guess.kind === 'game' && asksOnlinePlay(idea) ? { instead: onlineInstead(idea) } : undefined
    let ambiguous: EasyResolved['ambiguous']
    if (candidates.length > 1) {
      const helper = (await this.#d.intentHelper?.().catch(() => null)) ?? null
      ambiguous = {
        candidates,
        helper,
        ...(helper === null ? { helperReason: INTENT_NO_VENDOR } : {}),
      }
    }
    return {
      idea,
      kind: guess.kind,
      kindSource: guess.source,
      ...(ambiguous !== undefined ? { ambiguous } : {}),
      template: { id: template.id, label: template.label },
      ...(choice.fallback !== undefined
        ? {
            fallback: {
              wanted: { id: choice.fallback.wanted, label: wanted?.template.label ?? choice.fallback.wanted },
              needs: choice.fallback.needs,
            },
          }
        : {}),
      ...(template.installs !== undefined && template.installs.length > 0
        ? { installs: template.installs.map((i) => i.name) }
        : {}),
      recipe,
      ...(online !== undefined ? { online } : {}),
      folder,
      folderName: name,
      projectsDir,
      research: EASY_RESEARCH_KINDS.includes(guess.kind),
      estimate: est !== null ? { durationMs: est.total.durationMs, costUsd: est.total.costUsd } : null,
      limits,
      vendors: { claude: ready.claude, codex: ready.codex, ready: ready.runnable },
      toolchain,
      ...(stack !== undefined ? { stack } : {}),
      ...(needs.length > 0 ? { needs } : {}),
      ...(checks.length > 0 ? { checks: checks.map((c) => c.name) } : {}),
      ...(depth !== null ? { depth } : {}),
    }
  }

  #startRequest(
    o: {
      folder: string
      idea: string
      template: Template
      /** The project's Brief (the template's, refined by a game's idea). */
      brief: BriefInput
      recipe: string
      profile: BuiltinProfileName
      limits: RunLimits
      kind: EasyKind
      /** The files the user added, as copied into the project. */
      attached?: readonly string[]
      /** A game whose idea asked for online play: how people play together instead. */
      multiplayer?: EasyMultiplayer
      /** The checks the project runs before it is called ready (the template's, for what is installed). */
      checks?: readonly VerifyCommandConfig[]
      /** What the idea needs beyond pages in a browser, and the user's choices. */
      needs?: readonly EasyNeedView[]
      answers?: EasyNeedAnswers
      unattended?: boolean
      /** Quick or Thorough as the user forced it (absent or auto: decided when the run starts). */
      depth?: DepthSetting
      /** One of two versions: no plan check (the user compares what was made, not two plans). */
      two?: boolean
    },
    user: { settings: EasySettings },
  ): RunStartRequest & { overrides: RunOverrides } {
    const notes = [
      easyTask(o.template, o.idea, o.kind === 'game' ? o.multiplayer : undefined),
      ...(o.needs !== undefined && o.needs.length > 0 ? [needsNote(o.needs, o.answers)] : []),
      ...(o.attached !== undefined && o.attached.length > 0 ? [attachmentsNote(o.attached)] : []),
    ]
    return {
      folder: o.folder,
      task: notes.join('\n\n'),
      brief: o.brief,
      recipe: o.recipe,
      overrides: easyOverrides({
        profile: o.profile,
        skipPlanCheck: o.unattended === true || o.two === true ? true : user.settings.skipPlanCheck,
        limits: o.limits,
        nonCode: EASY_NON_CODE_KINDS.includes(o.kind),
        ...(o.checks !== undefined ? { checks: o.checks } : {}),
        ...(o.unattended === true ? { unattended: true } : {}),
        ...(o.depth !== undefined ? { depth: o.depth } : {}),
      }),
    }
  }

  /** The template's bundled files into the folder just made; a failure stops here (a packaging problem). */
  async #copyTemplateFiles(view: TemplateView, folder: string): Promise<void> {
    const copy = this.#d.copyTemplateFiles
    if (copy === undefined) return
    try {
      const written = await copy(view, folder)
      if (written.length > 0) this.#d.log.info('template files copied', { folder, files: written.length })
    } catch (err) {
      throw new DimFactoryError(
        'VALIDATION',
        `The starter files could not be copied into the project: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** `easy.attachCheck`: each added file as it would be copied, or why it cannot be. */
  async checkAttachments(paths: readonly string[]): Promise<EasyAttachment[]> {
    if (paths.length > EASY_ATTACH_MAX_FILES) {
      throw new DimFactoryError('VALIDATION', `Add up to ${EASY_ATTACH_MAX_FILES} files.`)
    }
    const check = this.#d.checkAttachments
    if (check === undefined) throw new DimFactoryError('UNSUPPORTED', 'Adding files is not available here.')
    return check(paths)
  }

  // ---- making -----------------------------------------------------------------------------------------------------

  /** Make the project folder from its template (New project's folder rules), then start the run. */
  async create(req: EasyCreateRequest): Promise<EasyStarted> {
    const idea = cleanIdea(req.idea)
    if (!isEasyKind(req.kind)) throw new DimFactoryError('VALIDATION', 'Choose what to make.')
    const ready = this.#d.readiness()
    if (!ready.runnable) {
      throw new DimFactoryError('VALIDATION', 'Sign in to Claude or Codex first, then start again.')
    }
    // Two versions: who builds them is settled before anything is made.
    const two = req.two === true ? this.#twoSides(ready) : null
    const [list, toolchain, user, packs] = await Promise.all([
      this.#d.templates(),
      this.#d.toolchain(),
      this.#user(),
      this.#d.packs(),
    ])
    const view = templateViewOf(list, chooseTemplate(req.kind, idea, toolchain, req.stack).templateId)
    const template = view.template
    // Added files are checked before anything is made: a refused one stops here, with nothing created.
    const attachments = attachmentsOf(req)
    if (attachments.length > 0) {
      const checked = await this.checkAttachments(attachments)
      const bad = checked.find((a) => a.error !== undefined)
      if (bad !== undefined) throw new DimFactoryError('VALIDATION', `${bad.name}: ${bad.error ?? ''}`)
    }
    const folder = await this.#d.prepareFolder(req.folder)
    await this.#copyTemplateFiles(view, folder)
    let attached: string[] = []
    if (attachments.length > 0) {
      const copy = this.#d.copyAttachments
      if (copy === undefined) throw new DimFactoryError('UNSUPPORTED', 'Adding files is not available here.')
      try {
        attached = await copy(attachments, folder)
      } catch (err) {
        throw new DimFactoryError(
          'VALIDATION',
          `The files could not be copied into the project: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    const brief = easyBrief(req.kind, template, idea, packs, attached, req.multiplayer)
    const startReq = this.#startRequest(
      {
        folder,
        idea,
        template,
        brief,
        recipe: EASY_KIND_RECIPE[req.kind],
        profile: ready.profile,
        limits: req.limits,
        kind: req.kind,
        attached,
        ...(req.multiplayer !== undefined ? { multiplayer: req.multiplayer } : {}),
        checks: templateChecks(template, toolchain),
        needs: detectNeeds(idea, req.kind),
        ...(req.needs !== undefined ? { answers: req.needs } : {}),
        ...(req.depth !== undefined ? { depth: req.depth } : {}),
        ...(two !== null ? { two: true } : {}),
      },
      user,
    )
    // Saved as the folder's brief, so the Full composer shows the template's choices for it like any saved brief.
    await this.#d.saveBrief(folder, brief)
    await this.#remember({
      folder,
      idea,
      kind: req.kind,
      templateId: template.id,
      createdAt: this.#d.now(),
      consent: req.consent,
      ...(briefUsesPhotos(brief) ? { photos: true } : {}),
    })
    // The project permission: for this new folder only, before its run can ask anything.
    if (req.consent && this.#d.grantPermission !== undefined) {
      await this.#d.grantPermission(folder).catch((err: unknown) => {
        // Without it every ask is asked, as without the permission: safe, so the run still starts.
        this.#d.log.warn('the project permission could not be saved; the run asks each time', { err })
      })
    }
    const hints = newProjectHints(idea, detectNeeds(idea, req.kind))
    if (two !== null) {
      // Each version works in its own copy: the project permission (this folder's) covers what comes after the pick.
      const made = await this.#startTwo(startReq, two, hints)
      return { runId: made.runId, displayNo: made.displayNo, folder, matchId: made.matchId }
    }
    const started = await this.#d.startRun(startReq, hints)
    return { runId: started.runId, displayNo: started.displayNo, folder }
  }

  /**
   * A follow-up run in a project: a change, or carrying on after a run stopped at its limit. In a folder Easy did not
   * make it runs as "Work on something I already have" does (an isolated copy when the folder has commits; never the
   * project permission).
   */
  async change(req: EasyChangeRequest): Promise<EasyStarted> {
    const ready = this.#d.readiness()
    if (!ready.runnable) {
      throw new DimFactoryError('VALIDATION', 'Sign in to Claude or Codex first, then start again.')
    }
    const rec = await this.project(req.folder)
    // Two versions of a change, never to carry a stopped run on; settled before anything is copied or started.
    let two: readonly [MatchContestant, MatchContestant] | null = null
    if (req.two === true) {
      if (req.continueRunId !== undefined) {
        throw new DimFactoryError('VALIDATION', 'Carrying on makes one version.')
      }
      two = this.#twoSides(ready)
    }
    const attachments = req.attachments ?? []
    if (attachments.length > EASY_ATTACH_MAX_FILES) {
      throw new DimFactoryError('VALIDATION', `Add up to ${EASY_ATTACH_MAX_FILES} files.`)
    }
    if (attachments.length > 0 && (rec === undefined || req.continueRunId !== undefined)) {
      throw new DimFactoryError('VALIDATION', 'Files can be added to a change of a project made here.')
    }
    let task: string
    let plan: ChangePlan
    // Adaptive depth reads the user's own words (the task also carries Easy's notes).
    let words: string
    if (req.continueRunId !== undefined) {
      const src = await this.#d.runTask(req.continueRunId)
      if (src === null) throw new DimFactoryError('NOT_FOUND', 'That run is no longer there.')
      task = continueTask(src.task)
      words = src.task
      plan = { small: false, review: 'sensitive' }
      // A failed run still holds its folder (its failure waits for an answer): Carry on closes it first.
      const was = this.#d.summaries().find((r) => r.runId === req.continueRunId)
      if (was?.status === 'failed' && this.#d.closeRun !== undefined) {
        await this.#d.closeRun(req.continueRunId).catch((err: unknown) => {
          this.#d.log.info('the failed run could not be closed before Carry on', { err })
        })
      }
    } else {
      const change = cleanChange(req.change)
      // Added files are checked before anything is copied: a refused one stops here, with nothing changed.
      let attached: string[] = []
      if (attachments.length > 0) {
        const checked = await this.checkAttachments(attachments)
        const bad = checked.find((a) => a.error !== undefined)
        if (bad !== undefined) throw new DimFactoryError('VALIDATION', `${bad.name}: ${bad.error ?? ''}`)
        attached = await this.#copyInto(attachments, req.folder)
      }
      task = changeTask(req.notWorking === true ? notWorkingTask(change) : change, {
        kind: rec?.kind,
        attached,
      })
      words = change
      // A fault can be anywhere, so it never counts as a small tweak.
      plan =
        req.notWorking === true
          ? { small: false, review: 'sensitive' }
          : changePlan(change, rec?.kind, attached.length)
    }
    const hints = changeHints(words, rec?.kind)
    const [user, checks, brief] = await Promise.all([
      this.#user(),
      (this.#d.checks?.(req.folder) ?? Promise.resolve([])).catch((): VerifyCommandConfig[] => []),
      this.#savedBrief(req.folder),
    ])
    if (rec === undefined && this.#d.inspectFolder !== undefined) {
      const v = await this.#existing(req.folder)
      if (v.mode === 'needsUndo') throw new DimFactoryError('VALIDATION', TURN_ON_UNDO_FIRST)
      return this.#startExisting(v.folder, v.mode === 'isolated', task, req.limits, plan, {
        hints,
        ...(req.depth !== undefined ? { depth: req.depth } : {}),
        ...(two !== null ? { two } : {}),
      })
    }
    const started = await this.#startWithBrief(
      {
        folder: req.folder,
        task,
        recipe: EASY_CHANGE_RECIPE,
        overrides: easyOverrides({
          profile: ready.profile,
          // Two versions: the user compares what was made, not two plans.
          skipPlanCheck: two !== null ? true : user.settings.skipPlanCheck,
          limits: req.limits,
          nonCode: rec !== undefined && EASY_NON_CODE_KINDS.includes(rec.kind),
          checks: rec !== undefined ? await this.#withTemplateChecks(rec.templateId, checks) : checks,
          change: plan,
          ...(req.depth !== undefined ? { depth: req.depth } : {}),
        }),
      },
      brief,
      hints,
      two !== null ? (r, h) => this.#startTwo(r, two, h) : undefined,
    )
    return {
      runId: started.runId,
      displayNo: started.displayNo,
      folder: req.folder,
      ...(started.matchId !== undefined ? { matchId: started.matchId } : {}),
    }
  }

  /** Who builds two versions now; refused where two cannot be started. */
  #twoSides(ready: EasyReadiness): readonly [MatchContestant, MatchContestant] {
    const sides = twoSides(ready)
    if (sides === null || this.#d.startTwo === undefined) {
      throw new DimFactoryError('UNSUPPORTED', 'Making two versions is not available here.')
    }
    return sides
  }

  /** Start two versions; a reason they cannot start is said in Easy's words (versions, not sides). */
  async #startTwo(
    req: RunStartRequest,
    sides: readonly [MatchContestant, MatchContestant],
    hints?: EasyDepthHints,
  ): Promise<RunStarted & { matchId: string }> {
    const start = this.#d.startTwo
    if (start === undefined) {
      throw new DimFactoryError('UNSUPPORTED', 'Making two versions is not available here.')
    }
    try {
      return await start(req, sides, hints)
    } catch (err) {
      if (!(err instanceof DimFactoryError)) throw err
      throw new DimFactoryError(err.code, twoErrorText(err.message), {
        ...(err.details !== undefined ? { details: err.details } : {}),
        cause: err,
      })
    }
  }

  /**
   * `easy.changeEstimate`: what a change would cost and take (the estimate for the run `change` would start, no tokens),
   * and how it would run: small (lighter models, no Critic), and the full security review or the secret scan.
   */
  async changeEstimate(req: {
    folder: string
    change: string
    depth?: DepthSetting
  }): Promise<EasyChangeEstimate> {
    const change = cleanChange(req.change)
    const ready = this.#d.readiness()
    const [user, rec, brief] = await Promise.all([
      this.#user(),
      this.project(req.folder),
      this.#savedBrief(req.folder),
    ])
    const plan = changePlan(change, rec?.kind, 0)
    const security = plan.review === 'always' ? 'full' : 'scan'
    if (!ready.runnable) return { estimate: null, small: plan.small, security }
    const startReq: RunStartRequest = {
      folder: req.folder,
      task: changeTask(change, { kind: rec?.kind }),
      recipe: rec !== undefined ? EASY_CHANGE_RECIPE : EASY_EXISTING_RECIPE,
      ...(brief !== null ? { brief } : {}),
      overrides: easyOverrides({
        profile: ready.profile,
        skipPlanCheck: user.settings.skipPlanCheck,
        limits: { maxCostUsd: user.settings.changeMaxCostUsd, maxMinutes: user.settings.maxMinutes },
        nonCode: rec !== undefined && EASY_NON_CODE_KINDS.includes(rec.kind),
        change: plan,
        ...(req.depth !== undefined ? { depth: req.depth } : {}),
      }),
    }
    const hints = changeHints(change, rec?.kind)
    const est = await this.#d.estimate(startReq, hints).catch((err: unknown) => {
      this.#d.log.info('no estimate for an Easy change', { err })
      return null
    })
    const depth =
      this.#d.depth !== undefined
        ? await this.#d.depth(startReq, hints).catch((err: unknown) => {
            this.#d.log.info('no depth for an Easy change', { err })
            return null
          })
        : null
    return {
      estimate: est !== null ? { durationMs: est.total.durationMs, costUsd: est.total.costUsd } : null,
      small: plan.small,
      security,
      ...(depth !== null ? { depth } : {}),
    }
  }

  /** The folder's saved Brief, or null (none, or it cannot be read: the change runs without one). */
  async #savedBrief(folder: string): Promise<BriefInput | null> {
    const read = this.#d.readBrief
    if (read === undefined) return null
    return read(folder).catch((err: unknown) => {
      this.#d.log.info('the saved brief could not be read; the change runs without it', { err })
      return null
    })
  }

  /**
   * Start a follow-up run with the folder's saved Brief, so its look and choices carry on. A Brief that no longer fits
   * its category (the folder changed since) is left out rather than stopping the change.
   */
  async #startWithBrief(
    req: RunStartRequest,
    brief: BriefInput | null,
    hints?: EasyDepthHints,
    /** How it is started (default: one run; "Make two and pick": two versions). */
    start: (req: RunStartRequest, hints?: EasyDepthHints) => Promise<RunStarted & { matchId?: string }> = (
      r,
      h,
    ) => this.#d.startRun(r, h),
  ): Promise<RunStarted & { matchId?: string }> {
    if (brief === null) return start(req, hints)
    try {
      return await start({ ...req, brief }, hints)
    } catch (err) {
      if (!(err instanceof DimFactoryError) || err.code !== 'VALIDATION' || !/brief/i.test(err.message))
        throw err
      this.#d.log.warn('the saved brief no longer fits; the change runs without it', { err })
      return start(req, hints)
    }
  }

  /** Copy added files into a project folder (data/ or assets/); a failure stops the change. */
  async #copyInto(paths: readonly string[], folder: string): Promise<string[]> {
    const copy = this.#d.copyAttachments
    if (copy === undefined) throw new DimFactoryError('UNSUPPORTED', 'Adding files is not available here.')
    try {
      return await copy(paths, folder)
    } catch (err) {
      throw new DimFactoryError(
        'VALIDATION',
        `The files could not be copied into the project: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * A change to a project Easy made checks it as its first run did: the template's checks (its tests, its build, its
   * page loading, for what is installed now) first, then the folder's own the detection found that are not among them.
   */
  async #withTemplateChecks(
    templateId: string,
    found: readonly VerifyCommandConfig[],
  ): Promise<VerifyCommandConfig[]> {
    const [list, toolchain] = await Promise.all([this.#d.templates(), this.#d.toolchain()]).catch(
      () => [null, null] as const,
    )
    const t = list?.templates.find((v) => v.template.id === templateId)?.template
    if (t === undefined || toolchain === null) return [...found]
    const own = templateChecks(t, toolchain)
    const key = (c: VerifyCommandConfig): string => JSON.stringify(c.run)
    const have = new Set(own.map(key))
    return [...own, ...found.filter((c) => !have.has(key(c)))]
  }

  // ---- a folder the user already has ------------------------------------------------------------------------------

  /** `easy.inspectFolder`: how a run would work in the folder (read only), and whether Easy made it. */
  async inspectFolder(folder: string): Promise<EasyFolderView> {
    const inspect = this.#d.inspectFolder
    if (inspect === undefined) throw new DimFactoryError('UNSUPPORTED', 'This is not available here.')
    const v = await inspect(folder)
    const made = v.problem === undefined && (await this.project(v.folder)) !== undefined
    const ready = this.#d.readiness()
    return { ...v, made, vendors: { claude: ready.claude, codex: ready.codex, ready: ready.runnable } }
  }

  /** The folder as a run would use it; a folder it may not use is refused with the reason. */
  async #existing(folder: string): Promise<EasyFolderFacts & { mode: EasyFolderMode }> {
    const inspect = this.#d.inspectFolder
    if (inspect === undefined) throw new DimFactoryError('UNSUPPORTED', 'This is not available here.')
    const v = await inspect(folder)
    if (v.problem !== undefined) throw new DimFactoryError('VALIDATION', v.problem)
    if (v.mode === undefined) throw new DimFactoryError('VALIDATION', 'This folder cannot be used.')
    return { ...v, mode: v.mode }
  }

  /**
   * `easy.work`: a run in a folder the user already has. A repository with commits: an isolated copy (the user keeps or
   * throws away the changes at the end). Otherwise in place, after "Turn on undo for this folder" (git init) when it
   * is no repository yet. The project permission is never given here: every install, script and check asks.
   */
  async work(req: EasyWorkRequest): Promise<EasyStarted> {
    const ready = this.#d.readiness()
    if (!ready.runnable) {
      throw new DimFactoryError('VALIDATION', 'Sign in to Claude or Codex first, then start again.')
    }
    const change = (req.change ?? '').trim()
    if (change === '') throw new DimFactoryError('VALIDATION', 'Say what to do in this folder.')
    if (change.length > EASY_CHANGE_MAX) {
      throw new DimFactoryError('VALIDATION', `Keep it under ${EASY_CHANGE_MAX} characters.`)
    }
    const v = await this.#existing(req.folder)
    if (v.mode === 'needsUndo') {
      if (req.turnOnUndo !== true) throw new DimFactoryError('VALIDATION', TURN_ON_UNDO_FIRST)
      const init = this.#d.turnOnUndo
      if (init === undefined) throw new DimFactoryError('UNSUPPORTED', 'This is not available here.')
      await init(v.folder)
      this.#d.log.info('undo turned on for a folder (git init)', { folder: v.folder })
    }
    let isolated = v.mode === 'isolated'
    // Changes git has not saved yet would not be in the copy: saved first (one commit), or worked on in place.
    if (isolated && (v.uncommitted ?? 0) > 0 && req.how !== undefined) {
      if (req.how === 'inPlace') isolated = false
      else {
        const save = this.#d.saveFirst
        if (save === undefined) throw new DimFactoryError('UNSUPPORTED', 'This is not available here.')
        try {
          await save(v.folder)
        } catch (err) {
          throw new DimFactoryError(
            'GIT',
            `Your changes could not be saved first: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        this.#d.log.info('changes saved before a run in a copy (one commit)', { folder: v.folder })
      }
    }
    return this.#startExisting(
      v.folder,
      isolated,
      changeTask(change),
      req.limits,
      changePlan(change, undefined, 0),
      { hints: changeHints(change, undefined) },
    )
  }

  /** A run with the recipe the project permission never covers, in an isolated copy or in place. */
  async #startExisting(
    folder: string,
    isolated: boolean,
    task: string,
    limits: RunLimits,
    plan: ChangePlan,
    o: {
      hints?: EasyDepthHints
      depth?: DepthSetting
      /** "Make two and pick": who builds the two versions (each in its own copy, whatever `isolated` says). */
      two?: readonly [MatchContestant, MatchContestant]
    } = {},
  ): Promise<EasyStarted> {
    const ready = this.#d.readiness()
    const two = o.two
    const [user, checks, brief] = await Promise.all([
      this.#user(),
      (this.#d.checks?.(folder) ?? Promise.resolve([])).catch((): VerifyCommandConfig[] => []),
      this.#savedBrief(folder),
    ])
    const overrides: RunOverrides = {
      ...easyOverrides({
        profile: ready.profile,
        skipPlanCheck: o.two !== undefined ? true : user.settings.skipPlanCheck,
        limits,
        checks,
        change: plan,
        ...(o.depth !== undefined ? { depth: o.depth } : {}),
      }),
      // Said outright, so a user setting cannot turn it around: an isolated copy needs a commit to start from.
      isolation: { mode: isolated ? 'worktree' : 'inPlace' },
    }
    const started = await this.#startWithBrief(
      { folder, task, recipe: EASY_EXISTING_RECIPE, overrides },
      brief,
      o.hints ?? { easy: true, words: task },
      two !== undefined ? (r, h) => this.#startTwo(r, two, h) : undefined,
    )
    return {
      runId: started.runId,
      displayNo: started.displayNo,
      folder,
      ...(started.matchId !== undefined ? { matchId: started.matchId } : {}),
    }
  }

  // ---- the overnight list ------------------------------------------------------------------------------------------

  #queue(): EasyQueueDeps {
    const q = this.#d.queue
    if (q === undefined) throw new DimFactoryError('UNSUPPORTED', 'The overnight list is not available here.')
    return q
  }

  /**
   * `easy.queueAdd`: each idea becomes a new project now (its folder from its template, its Brief, the project
   * permission when the user ticked it for that idea) and one task on its own queue, which runs with Easy's layer for
   * nobody watching (no questions, no plan check, no look at similar things). Nothing starts here.
   */
  async queueAdd(req: EasyQueueAddRequest): Promise<EasyQueueView> {
    const q = this.#queue()
    if (req.ideas.length === 0) throw new DimFactoryError('VALIDATION', 'Add at least one idea.')
    if (req.ideas.length > EASY_QUEUE_MAX)
      throw new DimFactoryError('VALIDATION', `Add up to ${EASY_QUEUE_MAX} ideas at a time.`)
    const ready = this.#d.readiness()
    if (!ready.runnable) {
      throw new DimFactoryError('VALIDATION', 'Sign in to Claude or Codex first, then add them again.')
    }
    const ideas = req.ideas.map((i) => {
      if (!isEasyKind(i.kind)) throw new DimFactoryError('VALIDATION', 'Choose what to make.')
      return { ...i, idea: cleanIdea(i.idea) }
    })
    const [list, toolchain, user, packs] = await Promise.all([
      this.#d.templates(),
      this.#d.toolchain(),
      this.#user(),
      this.#d.packs(),
    ])
    const projectsDir = user.settings.projectsDir ?? this.defaultProjectsDir
    for (const i of ideas) {
      const view = templateViewOf(list, chooseTemplate(i.kind, i.idea, toolchain).templateId)
      const template = view.template
      const brief = easyBrief(i.kind, template, i.idea, packs)
      const { folder: wanted } = freeFolder(projectsDir, slugOf(i.idea), (p) => this.#d.exists(p))
      const folder = await this.#d.prepareFolder(wanted)
      await this.#copyTemplateFiles(view, folder)
      await this.#d.saveBrief(folder, brief)
      await this.#remember({
        folder,
        idea: i.idea,
        kind: i.kind,
        templateId: template.id,
        createdAt: this.#d.now(),
        consent: i.consent,
        ...(briefUsesPhotos(brief) ? { photos: true } : {}),
      })
      if (i.consent && this.#d.grantPermission !== undefined) {
        await this.#d.grantPermission(folder).catch((err: unknown) => {
          this.#d.log.warn('the project permission could not be saved; the run asks each time', { err })
        })
      }
      const start = this.#startRequest(
        {
          folder,
          idea: i.idea,
          template,
          brief,
          recipe: EASY_KIND_RECIPE[i.kind],
          profile: ready.profile,
          limits: req.limits,
          kind: i.kind,
          checks: templateChecks(template, toolchain),
          // Nobody answers overnight: each need is met the recommended way.
          needs: detectNeeds(i.idea, i.kind),
          unattended: true,
        },
        user,
      )
      // About what it costs and takes, shown on the list (no tokens).
      const est = await this.#d.estimate(start).catch((err: unknown) => {
        this.#d.log.info('no estimate for an overnight idea', { err })
        return null
      })
      if (est !== null || i.guessed === true) {
        await this.#remember({
          folder,
          idea: i.idea,
          kind: i.kind,
          templateId: template.id,
          createdAt: this.#d.now(),
          consent: i.consent,
          ...(briefUsesPhotos(brief) ? { photos: true } : {}),
          ...(i.guessed === true ? { guessed: true } : {}),
          ...(est !== null
            ? { estimate: { durationMs: est.total.durationMs, costUsd: est.total.costUsd } }
            : {}),
        })
      }
      await q.add(folder, {
        task: start.task,
        recipe: EASY_KIND_RECIPE[i.kind],
        easy: { overrides: start.overrides, ...(start.brief !== undefined ? { brief: start.brief } : {}) },
      })
    }
    return this.queueView()
  }

  /** `easy.queue`: the overnight list as the factory's queues have it, in the order the ideas were added. */
  async queueView(): Promise<EasyQueueView> {
    const v = this.#queue().view()
    const [records, packs] = await Promise.all([this.#records(), this.#d.packs().catch(() => [] as Pack[])])
    const items: (EasyQueueItem & { addedAt: number })[] = []
    const easyFolders = new Set<string>()
    let running = false
    let pause: string | undefined
    for (const f of v.folders) {
      const tasks = f.tasks.filter((t) => t.easy !== undefined)
      if (tasks.length === 0) continue
      easyFolders.add(folderKey(f.folder))
      const rec = records.find((r) => folderKey(r.folder) === folderKey(f.folder))
      if (f.state === 'running') running = true
      if (f.state === 'paused' && f.pause !== undefined && pause === undefined) pause = f.pause.text
      const warnings = rec !== undefined ? queueWarnings(rec, packs) : []
      for (const t of tasks)
        items.push({
          folder: f.folder,
          title: rec !== undefined ? titleOf(rec.idea) : basename(f.folder) || f.folder,
          ...(rec !== undefined ? { kind: rec.kind } : {}),
          status: t.status,
          ...(t.runId !== undefined ? { runId: t.runId } : {}),
          ...(t.reason !== undefined ? { reason: t.reason } : {}),
          ...(rec?.estimate !== undefined ? { estimate: rec.estimate } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          addedAt: t.addedAt,
        })
    }
    items.sort((a, b) => a.addedAt - b.addedAt)
    const notice = v.notice
    const ours = notice !== undefined && notice.folders.some((f) => easyFolders.has(folderKey(f)))
    const pending = items.some((i) => i.status === 'pending')
    return {
      items: items.map(({ addedAt: _a, ...i }) => i),
      state: running ? 'running' : pause !== undefined && pending ? 'paused' : 'idle',
      ...(pause !== undefined && pending && !running ? { pause } : {}),
      schedule: { enabled: v.schedule.enabled, start: v.schedule.start },
      ...(ours && notice !== undefined ? { notice: { id: notice.id, text: notice.text } } : {}),
    }
  }

  /** The folders of the overnight list that still have an idea to make. */
  #pendingFolders(): string[] {
    return this.#queue()
      .view()
      .folders.filter((f) => f.tasks.some((t) => t.easy !== undefined && t.status === 'pending'))
      .map((f) => f.folder)
  }

  /**
   * `easy.queueStart`: now (one after another), or every day at `at` (the factory's schedule, which never resumes on
   * its own after Dim Factory was closed: it asks). Answering a launch notice starts it too.
   */
  async queueStart(req: EasyQueueStartRequest & { noticeId?: string }): Promise<EasyQueueView> {
    const q = this.#queue()
    if (req.at !== undefined) {
      if (!CLOCK_TIME.test(req.at)) throw new DimFactoryError('VALIDATION', 'A time looks like 22:00.')
      await q.schedule(req.at)
      return this.queueView()
    }
    const folders = this.#pendingFolders()
    if (folders.length === 0) throw new DimFactoryError('VALIDATION', 'There is nothing on the list to make.')
    await q.start(folders, req.noticeId)
    return this.queueView()
  }

  /** `easy.queuePause`: nothing new starts; a project being made goes on. */
  async queuePause(): Promise<EasyQueueView> {
    const q = this.#queue()
    const folders = q
      .view()
      .folders.filter((f) => f.state === 'running' && f.tasks.some((t) => t.easy !== undefined))
      .map((f) => f.folder)
    if (folders.length > 0) await q.pause(folders)
    return this.queueView()
  }

  /** `easy.queueRemove`: take an idea that has not started off the list (its new, empty folder stays). */
  async queueRemove(folder: string): Promise<EasyQueueView> {
    const q = this.#queue()
    const f = q.view().folders.find((x) => folderKey(x.folder) === folderKey(folder))
    const t = f?.tasks.find((x) => x.easy !== undefined && x.status !== 'running' && x.status !== 'waiting')
    if (f === undefined || t === undefined)
      throw new DimFactoryError('NOT_FOUND', 'That idea is not on the list, or it is being made now.')
    await q.remove(f.folder, t.id)
    return this.queueView()
  }

  // ---- projects ---------------------------------------------------------------------------------------------------

  /** Every folder with runs, newest first, with what Easy made it as when it did. */
  async projects(): Promise<EasyProjectView[]> {
    const records = await this.#records()
    const byKey = new Map<string, EasyProjectView>()
    const sorted = [...this.#d.summaries()].sort((a, b) => b.createdAt - a.createdAt)
    for (const s of sorted) {
      const key = folderKey(s.folder)
      const cur = byKey.get(key)
      if (cur !== undefined) {
        cur.runs++
        continue
      }
      const rec = records.find((r) => folderKey(r.folder) === key)
      byKey.set(key, {
        folder: s.folder,
        name: basename(s.folder) || s.folder,
        ...(rec !== undefined ? { kind: rec.kind, idea: rec.idea, title: titleOf(rec.idea) } : {}),
        ...(rec?.photos === true ? { photos: true } : {}),
        lastRunId: s.runId,
        lastDisplayNo: s.displayNo,
        lastStatus: s.status,
        ...(s.outcome !== undefined ? { lastOutcome: s.outcome } : {}),
        updatedAt: s.endedAt ?? s.createdAt,
        runs: 1,
      })
    }
    return [...byKey.values()]
  }

  /**
   * What a project Easy made puts at the top of its first memory file (proposed after its first run, written only when
   * the user approves): what it is, what it was made from and the rules its changes keep. Null for any other folder.
   */
  async memorySeed(folder: string): Promise<MemorySeed | null> {
    const rec = await this.project(folder)
    if (rec === undefined) return null
    const list = await this.#d.templates().catch(() => null)
    const label =
      list?.templates.find((v) => v.template.id === rec.templateId)?.template.label ?? rec.templateId
    const conventions = [
      `What it is: ${titleOf(rec.idea)} (${KIND_MEMORY[rec.kind]}), made by ${BRAND.displayName} from its "${label}" template.`,
      'Its look and choices are in the saved Brief: every change keeps to them unless the change says otherwise.',
      'Facts only the owner knows (prices, hours, addresses, policies, testimonials) stay as marked [Fill in: ...] slots until the owner gives them; never make them up.',
      ...(rec.kind === 'data'
        ? [
            'The report keeps a copy of its data in js/data.js: write it again whenever data/ changes, and show totals, never personal columns.',
          ]
        : []),
      ...(rec.kind === 'document' || rec.kind === 'checklist'
        ? ['The words are kept twice (Markdown and the HTML page): change both together.']
        : []),
    ]
    const decisions = [`It was asked for as: "${rec.idea.replace(/\s+/g, ' ').trim().slice(0, 300)}"`]
    return { conventions, decisions }
  }

  /** The record of a folder Easy made (absent: Easy did not make it). */
  async project(folder: string): Promise<EasyProjectRecord | undefined> {
    return (await this.#records()).find((r) => folderKey(r.folder) === folderKey(folder))
  }

  #file(): string {
    return join(this.#d.home, 'easy', 'projects.json')
  }

  async #records(): Promise<EasyProjectRecord[]> {
    const r = await readVersionedJson<Record<string, unknown>>(this.#file())
    if (r.kind !== 'ok') return []
    const list = r.value['projects']
    return Array.isArray(list) ? list.filter(isRecord) : []
  }

  #remember(rec: EasyProjectRecord): Promise<void> {
    const run = this.#chain.then(async () => {
      const rest = (await this.#records()).filter((r) => folderKey(r.folder) !== folderKey(rec.folder))
      const projects = [rec, ...rest].slice(0, PROJECTS_MAX)
      await writeFileAtomic(this.#file(), `${JSON.stringify({ schemaVersion: 1, projects }, null, 2)}\n`, {
        mode: 0o600,
      })
    })
    this.#chain = run.catch((err: unknown) => this.#d.log.warn('easy projects could not be saved', { err }))
    return this.#chain
  }
}

/**
 * Whether this home looks like a new user's when the process starts (before first launch writes anything): no
 * finished first launch and no user settings file. Runs are checked when asked (a user with runs is never new).
 */
export async function homeLooksNew(paths: { state: string; userConfig: string }): Promise<boolean> {
  const state = await readVersionedJson<Record<string, unknown>>(paths.state)
  if (state.kind === 'ok' && typeof state.value['firstLaunchCompletedAt'] === 'number') return false
  if (state.kind === 'ok' && state.readOnly) return false
  const user = await stat(paths.userConfig).catch(() => null)
  return user === null
}

function isRecord(v: unknown): v is EasyProjectRecord {
  return (
    isPlainObject(v) &&
    typeof v['folder'] === 'string' &&
    typeof v['idea'] === 'string' &&
    isEasyKind(v['kind']) &&
    typeof v['templateId'] === 'string' &&
    typeof v['createdAt'] === 'number' &&
    typeof v['consent'] === 'boolean' &&
    (v['photos'] === undefined || typeof v['photos'] === 'boolean') &&
    (v['guessed'] === undefined || typeof v['guessed'] === 'boolean') &&
    (v['estimate'] === undefined || isPlainObject(v['estimate']))
  )
}

/** Folders compare without case on Windows and macOS, and without a trailing separator. */
function folderKey(folder: string): string {
  const f = folder.replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? f.toLowerCase() : f
}

/** Each kind as the memory file names it. */
const KIND_MEMORY: Readonly<Record<EasyKind, string>> = {
  app: 'an app',
  website: 'a website',
  document: 'a guide or document',
  data: 'a report from data',
  research: 'a research memo',
  checklist: 'a checklist',
  game: 'a game',
}

/** How a change runs: small (lighter models, no Critic), and when its security reviewer runs (the scan always does). */
export interface ChangePlan {
  small: boolean
  review: SecurityReview
}

/**
 * A change's plan from its words (easy/change.ts): small or not, and the full security review when it names keys or
 * people's data (or a data report gets new files); otherwise the reviewer runs only when the diff needs it.
 */
export function changePlan(change: string, kind: EasyKind | undefined, attached: number): ChangePlan {
  return {
    small: attached === 0 && isSmallChange(change),
    review: changeTouchesSensitive(change, { kind, attached }) ? 'always' : 'sensitive',
  }
}

function cleanChange(change: string | undefined): string {
  const t = (change ?? '').trim()
  if (t === '') throw new DimFactoryError('VALIDATION', 'Say what to change.')
  if (t.length > EASY_CHANGE_MAX) {
    throw new DimFactoryError('VALIDATION', `Keep the change under ${EASY_CHANGE_MAX} characters.`)
  }
  return t
}

/**
 * What to know about an overnight idea: a report from data has no data file (none can be added to the list), a game
 * is made without looking at similar games (that needs someone there), and a vague idea whose kind was guessed.
 */
export function queueWarnings(
  rec: Pick<EasyProjectRecord, 'idea' | 'kind' | 'guessed'>,
  packs: readonly Pack[],
): EasyQueueWarning[] {
  const out: EasyQueueWarning[] = []
  if (rec.guessed === true) {
    const candidates = ambiguousKinds(rec.idea, packs)
    if (candidates.length > 1) out.push({ kind: 'vague', candidates })
  }
  if (rec.kind === 'data') out.push({ kind: 'exampleData' })
  if (rec.kind === 'game') out.push({ kind: 'noResearch' })
  return out
}

function cleanIdea(idea: string): string {
  const t = typeof idea === 'string' ? idea.trim() : ''
  if (t === '') throw new DimFactoryError('VALIDATION', 'Say what you want to make.')
  if (t.length > EASY_IDEA_MAX) {
    throw new DimFactoryError('VALIDATION', `Keep the idea under ${EASY_IDEA_MAX} characters.`)
  }
  return t
}

function templateOf(list: TemplatesList, id: string): Template {
  return templateViewOf(list, id).template
}

function templateViewOf(list: TemplatesList, id: string): TemplateView {
  const hit = list.templates.find((v) => v.template.id === id)
  // A Full-mode-only template (an online game needs a server you host) never starts an Easy project.
  if (hit?.template.fullOnly === true) {
    throw new DimFactoryError(
      'VALIDATION',
      `"${hit.template.label}" is for Full mode only: Easy does not make projects that need a server you host.`,
    )
  }
  if (hit === undefined) {
    throw new DimFactoryError(
      'VALIDATION',
      `The "${id}" template is not available (a user template file may have replaced it with one that does not fit).`,
    )
  }
  return hit
}

/**
 * The checks a project made from `template` runs before it is called ready (its tests, its build, its page loading),
 * as Verify commands: the template's, less those that need Node.js when it is not ready.
 */
export function templateChecks(template: Template, toolchain: EasyToolchain): VerifyCommandConfig[] {
  return (template.checks ?? [])
    .filter((c) => c.needs !== 'node' || toolchain.node)
    .map((c) => ({ name: c.name, run: [...c.run] }))
}

/** The Easy recipe whose Brief holds each pack's look and quality choices for a website or app. */
const LOOK_RECIPE: Readonly<Record<string, string>> = { software: 'easy-software', design: 'easy-design' }

/**
 * A new project's Brief: the template's (refined by a game's idea, ideaBrief), and for a website or app the look and
 * quality choices of the Easy recipe for the template's pack (withEasyLook).
 */
export function easyBrief(
  kind: EasyKind,
  template: Template,
  idea: string,
  packs: readonly Pack[],
  attached: readonly string[] = [],
  multiplayer?: EasyMultiplayer,
): BriefInput {
  const brief = ideaBrief(kind, template, idea, packs, attached, multiplayer)
  if (!EASY_WEB_KINDS.includes(kind)) return brief
  const recipeId = LOOK_RECIPE[template.pack]
  const recipe =
    recipeId !== undefined ? readBuiltinRecipes().find((v) => v.recipe.id === recipeId)?.recipe : undefined
  return withEasyLook(brief, recipe?.brief, packs)
}
