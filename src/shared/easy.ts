// Easy mode ("Make something"): a second front end over the same runs. An idea becomes a new project folder, a
// template, an Easy recipe and a run-overrides layer (decided locally, no tokens), and the run is an ordinary run that
// the Full Run view can open at any time. These are the contracts core answers with and the renderer formats; the
// words the user reads live in the renderer's Easy text module.
import type { EasySettings, Experience, RunLimits } from './config-schema.ts'
import type { Percentiles } from './estimates.ts'
import type { QueueTaskStatus } from './factory.ts'
import type { RunOutcome, RunStatus, StepKey } from './run.ts'
import type { DepthDecision, DepthSetting } from './depth.ts'

// ---- kinds ----------------------------------------------------------------------------------------------------

/** What the user wants made, as Easy names it. */
export const EASY_KINDS = ['app', 'website', 'document', 'data', 'research', 'checklist', 'game'] as const
export type EasyKind = (typeof EASY_KINDS)[number]

export function isEasyKind(v: unknown): v is EasyKind {
  return typeof v === 'string' && (EASY_KINDS as readonly string[]).includes(v)
}

/** The Brief category (pack) each kind belongs to. */
export const EASY_KIND_PACK: Readonly<Record<EasyKind, string>> = {
  app: 'software',
  website: 'design',
  document: 'documents',
  data: 'data',
  research: 'research-writing',
  checklist: 'operations',
  game: 'games',
}

/** The built-in recipe each kind runs with (inspectable in Settings, Recipes). */
export const EASY_KIND_RECIPE: Readonly<Record<EasyKind, string>> = {
  app: 'easy-software',
  website: 'easy-design',
  document: 'easy-documents',
  data: 'easy-data',
  research: 'easy-research',
  checklist: 'easy-operations',
  game: 'easy-game',
}

/** The recipe of a follow-up run in a project ("Make a change", "Continue with more"). */
export const EASY_CHANGE_RECIPE = 'easy-change'

/**
 * The recipe of a run in a folder Easy did not make ("Work on something I already have"). It is not one of
 * EASY_RECIPES: the project permission never covers a run with it, whatever grant the folder holds.
 */
export const EASY_EXISTING_RECIPE = 'easy-existing'

/** Every built-in Easy recipe: a run with one of them is an Easy run (the project permission is for those alone). */
export const EASY_RECIPES: readonly string[] = [...Object.values(EASY_KIND_RECIPE), EASY_CHANGE_RECIPE]

/** Kinds whose result is not a program: Explain says "How to open it" instead of "How to run it". */
export const EASY_NON_CODE_KINDS: readonly EasyKind[] = ['document', 'data', 'research', 'checklist']

/** Kinds whose result is read as a document (Open it shows the rendered document, with Save as PDF). */
export const EASY_DOCUMENT_KINDS: readonly EasyKind[] = ['document', 'research', 'checklist']

/** Kinds whose runs research before Plan (three lenses). */
export const EASY_RESEARCH_KINDS: readonly EasyKind[] = ['app', 'website', 'research', 'game']

/** Kinds whose Done screen says Play it (a game): How to play, the controls, and sharing it to play. */
export const EASY_PLAY_KINDS: readonly EasyKind[] = ['game']

/**
 * How people play together in an Easy game instead of online (online multiplayer needs a server you host, which Easy
 * never makes): taking turns on one device, or sending the game's state in a link.
 */
export const EASY_MULTIPLAYER = ['pass-and-play', 'play-by-link'] as const
export type EasyMultiplayer = (typeof EASY_MULTIPLAYER)[number]

/** The longest idea, and the longest change request. */
export const EASY_IDEA_MAX = 4000
export const EASY_CHANGE_MAX = 2000
/** The longest project folder name Easy makes from an idea. */
export const EASY_SLUG_MAX = 40

// ---- state and settings ---------------------------------------------------------------------------------------

/** `easy.state`: how the app is used, whether to ask a new user once, and Easy's settings as they apply now. */
export interface EasyState {
  experience: Experience | null
  /** A new user who has not chosen yet: the welcome card asks once. Existing users never see it. */
  askWelcome: boolean
  /** Easy's settings over their defaults (`projectsDir` null: the default folder). */
  settings: EasySettings
  /** Where new projects go now. */
  projectsDir: string
  /** The default projects folder (the Documents folder's "Dim Factory Projects", or the user folder's: see below). */
  defaultProjectsDir: string
  /**
   * Why the default is not in Documents: `onedrive`, the Documents folder is synced by OneDrive (which fights the many
   * small files an app project holds), so it is in the user folder instead. Absent: it is in Documents.
   */
  defaultProjectsReason?: 'onedrive'
}

// ---- resolving an idea ------------------------------------------------------------------------------------------

/** What is installed that a template may need (found on PATH; only `node --version` is run). */
export interface EasyToolchain {
  /** Node.js is ready for the templates that need it: on PATH, and new enough for Vite (or its version unread). */
  node: boolean
  python: boolean
  /** Node.js as found on PATH: its version (null: not found, or none could be read). Absent: not looked at. */
  nodeVersion?: string | null
  /** Node.js is on PATH but older than Vite needs (NODE_MIN_TEXT): the React templates are not offered. */
  nodeOld?: boolean
}

/** The oldest Node.js the React templates build with (Vite's own minimum), and the one to install. */
export const NODE_MIN_TEXT = '20.19'
export const NODE_RECOMMENDED_TEXT = '22'

/** Kinds made as a web page or app: React by default when Node.js is ready, plain HTML on request (or without it). */
export const EASY_WEB_KINDS: readonly EasyKind[] = ['app', 'website']

/** How a website or app is built: React (with a build step) or plain HTML (no build step). */
export const EASY_STACKS = ['react', 'html'] as const
export type EasyStack = (typeof EASY_STACKS)[number]

// ---- what a website or app needs beyond its pages ---------------------------------------------------------------

/**
 * What an idea may need beyond pages in a browser, found in its words (no tokens): an AI or paid API (a key that must
 * stay secret), taking payments, sign-in, a form that saves or sends, data stored online, a blog to post to. In the
 * order the one question is asked about.
 */
export const EASY_NEEDS = ['ai', 'payments', 'login', 'forms', 'data', 'blog'] as const
export type EasyNeed = (typeof EASY_NEEDS)[number]

/** The ways each need can be met, the recommended one first (what each means is the renderer's Easy text). */
export const EASY_NEED_CHOICES: Readonly<Record<EasyNeed, readonly string[]>> = {
  ai: ['proxy', 'keyless', 'none'],
  payments: ['links', 'contact'],
  login: ['hosted', 'none'],
  forms: ['email', 'list', 'none'],
  data: ['device', 'online'],
  blog: ['files', 'cms'],
}

export function isEasyNeed(v: unknown): v is EasyNeed {
  return typeof v === 'string' && (EASY_NEEDS as readonly string[]).includes(v)
}

/** One need an idea has, as the confirm screen asks about it. `signup`: the form is a sign-up (its question says so). */
export interface EasyNeedView {
  need: EasyNeed
  choices: string[]
  recommended: string
  signup?: true
}

/** The choice the user made for each need (absent: the recommended one). */
export type EasyNeedAnswers = Partial<Record<EasyNeed, string>>

export interface EasyResolveRequest {
  idea: string
  /** The kind the user chose on the confirm screen (absent: detected from the idea). */
  kind?: EasyKind
  /** A website or app: React or plain HTML, as the user chose (absent: React when Node.js is ready). */
  stack?: EasyStack
  /** Read Node.js's version afresh ("Check again" after installing it). */
  recheck?: boolean
  /** Quick or Thorough as the user forced it on the confirm screen (absent or auto: Dim Factory decides). */
  depth?: DepthSetting
}

/**
 * Who could help choose between the kinds of a vague idea (one cheap read-only model call, only when the user asks):
 * the vendor and model, and about what one call costs (null: no price known). Absent: nobody can (`reason` says why).
 */
export interface EasyIntentHelper {
  vendor: string
  model: string | null
  usd: number | null
}

/**
 * The idea could mean more than one kind (Easy's words named several, or none at all): the kinds to ask about, in
 * order, and who could help choose. The kind shown meanwhile is the local guess (one of them).
 */
export interface EasyAmbiguity {
  candidates: EasyKind[]
  helper: EasyIntentHelper | null
  /** Why nobody can help choose (UI copy), when `helper` is null. */
  helperReason?: string
}

/** `easy.intent`: what the model suggests for a vague idea (one of the candidates), and why in one line. */
export interface EasyIntentAnswer {
  kind: EasyKind
  reason: string
  vendor: string
}

/** The longest reason the model may give for its suggestion. */
export const EASY_INTENT_REASON_MAX = 200

/** `easy.resolve`: what Easy would make, decided locally (no tokens), for the confirm screen. */
export interface EasyResolved {
  idea: string
  kind: EasyKind
  /** `chosen`: the user picked it; `words`: the idea names it; `default`: nothing pointed anywhere. */
  kindSource: 'chosen' | 'words' | 'default'
  /** The idea could mean several kinds and the user has not chosen yet: ask "Did you mean ...?". */
  ambiguous?: EasyAmbiguity
  template: { id: string; label: string }
  /**
   * The idea asked for a template that needs something not installed, so Easy picked one that needs nothing: what it
   * wanted and what was missing.
   */
  fallback?: { wanted: { id: string; label: string }; needs: 'node' | 'python' }
  /**
   * Libraries the template's project installs into itself with npm (never bundled with Dim Factory; they need
   * Node.js), by the names people know them by ("three.js"). Absent: none.
   */
  installs?: string[]
  recipe: string
  /**
   * The idea asks for online multiplayer, which Easy does not make (it needs a server you host): the game is made for
   * `instead` (the user may pick the other way on the confirm screen).
   */
  online?: { instead: EasyMultiplayer }
  /** The new project's folder (not created yet), its name, and the folder it goes in. */
  folder: string
  folderName: string
  projectsDir: string
  /** The run researches before Plan (three lenses). */
  research: boolean
  /** The estimate for a run like this (null: none yet). Waits on the user are not counted. */
  estimate: { durationMs: Percentiles; costUsd: Percentiles | null } | null
  /** The limits a new project starts with (Easy settings; null: no limit). */
  limits: RunLimits
  /** Who does the work, picked by readiness. `ready` false: nobody can start it yet. */
  vendors: { claude: boolean; codex: boolean; ready: boolean }
  toolchain: EasyToolchain
  /**
   * A website or app: how it is built (`chosen`), and whether React can be (`react`: Node.js is ready). Without
   * Node.js, or with one too old, it is plain HTML and the screen says why and how to install Node.js.
   */
  stack?: { chosen: EasyStack; react: boolean }
  /** What the idea needs beyond pages in a browser (the first is asked about), in EASY_NEEDS order. */
  needs?: EasyNeedView[]
  /** The checks the project will run before it is called ready (the template's, as Verify names them). */
  checks?: string[]
  /** Quick or Thorough, and why (adaptive depth, as the run will start; absent: unknown, nobody is ready). */
  depth?: DepthDecision
}

/** `easy.create`: make the folder from the template and start the run. */
export interface EasyCreateRequest {
  idea: string
  kind: EasyKind
  folder: string
  limits: RunLimits
  /**
   * The project permission on the confirm screen ("Allow these for this project"): given to the new folder only
   * (trust.json `easyProject`), revocable, every use logged.
   */
  consent: boolean
  /** Files the user added on Easy's home (absolute paths), copied into the new project's data/ or assets/. */
  attachments?: string[]
  /** A game whose idea asked for online play: how people play together instead (default: the resolver's pick). */
  multiplayer?: EasyMultiplayer
  /** A website or app: React or plain HTML (absent: React when Node.js is ready). */
  stack?: EasyStack
  /** The user's choice for each need the idea has (absent: the recommended one). */
  needs?: EasyNeedAnswers
  /** Quick or Thorough as the user forced it on the confirm screen (absent or auto: Dim Factory decides). */
  depth?: DepthSetting
  /**
   * "Make two and pick": the idea is built twice, each version in its own copy of the new folder, and the user keeps
   * one (a match with the builders' names hidden). The plan check is skipped; each version has the run's own limits.
   */
  two?: boolean
}

/** Who builds the two versions: one each when two vendors are ready (`pair`), else the same one twice (`twice`). */
export type EasyTwoHow = 'pair' | 'twice'

/** How "Make two and pick" would build with these vendors ready; null when nobody is. */
export function easyTwoHow(ready: { claude: boolean; codex: boolean }): EasyTwoHow | null {
  if (ready.claude && ready.codex) return 'pair'
  return ready.claude || ready.codex ? 'twice' : null
}

// ---- attachments ------------------------------------------------------------------------------------------------

/** The most files one project starts with, the largest one, and all of them together. */
export const EASY_ATTACH_MAX_FILES = 10
export const EASY_ATTACH_MAX_BYTES = 25 * 1024 * 1024
export const EASY_ATTACH_TOTAL_MAX_BYTES = 100 * 1024 * 1024
/** A folder is copied only when it is this small and plain (files only, no links, nothing hidden). */
export const EASY_ATTACH_FOLDER_MAX_FILES = 50
export const EASY_ATTACH_FOLDER_MAX_DEPTH = 2

/** An image file (a photo for a memory game or a birthday quiz): Easy says where photos go when one is added. */
export function isEasyPhotoName(name: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|heic)$/i.test(name)
}

/** Where an attached file goes in the new project: data/ (tables, data) or assets/ (images, documents, the rest). */
export type EasyAttachDest = 'data' | 'assets'

/** `easy.attachCheck`: each added file as it would be copied, or why it cannot be. */
export interface EasyAttachment {
  path: string
  name: string
  /** Bytes (a folder: all its files). */
  bytes: number
  folder: boolean
  dest: EasyAttachDest
  /** Why it is refused (UI copy); absent when it can be copied. */
  error?: string
  /**
   * Something to know about a file that is added (absent: nothing): `converted`, a spreadsheet whose first sheet is also
   * copied as a CSV file the report reads; `unreadable`, a spreadsheet kind that cannot be read here (save it as CSV);
   * `large`, too large for the AI to read in full (it reads the start; the report's code reads all of it).
   */
  note?: EasyAttachNote
}

export const EASY_ATTACH_NOTES = ['converted', 'unreadable', 'large'] as const
export type EasyAttachNote = (typeof EASY_ATTACH_NOTES)[number]

/** A data file larger than this is more than the AI reads in full (it reads its first rows). */
export const EASY_ATTACH_READ_MAX_BYTES = 2 * 1024 * 1024

// ---- project permission -----------------------------------------------------------------------------------------

/** A folder with Easy's project permission, and how often it has been used. */
export interface EasyPermissionView {
  folder: string
  at: number
  uses: number
}

/** `easy.permission`: the permission as a project (and one of its runs) reads it. */
export interface EasyPermissionState extends EasyPermissionView {
  granted: boolean
  /** Uses during the given run. */
  runUses: number
}

export interface EasyStarted {
  runId: string
  displayNo: number
  folder: string
  /** "Make two and pick": the match the two versions belong to (`runId` is its first version's run). */
  matchId?: string
}

/**
 * `easy.change`: a follow-up run in a project folder. `change`: what to change ("Make a change"); with `continueRunId`
 * instead, carry on with that run's task after it stopped at a limit ("Continue with more").
 */
export interface EasyChangeRequest {
  folder: string
  change?: string
  /** "It's not working": `change` is what the person sees going wrong, so the run finds the cause before fixing it. */
  notWorking?: boolean
  continueRunId?: string
  limits: RunLimits
  /** Files the user added to the change (a project Easy made only): copied into its data/ or assets/ first. */
  attachments?: string[]
  /** Quick or Thorough as the user forced it (absent or auto: Dim Factory decides). */
  depth?: DepthSetting
  /**
   * "Make two and pick" for a change: it is made twice, each version in its own copy of the folder as it is now, and
   * the user keeps one. Not with `continueRunId`.
   */
  two?: boolean
}

/** `easy.changeEstimate`: what a change would cost and take, and how it would run (no tokens). */
export interface EasyChangeEstimate {
  /** The estimate (null: none yet). */
  estimate: { durationMs: Percentiles; costUsd: Percentiles | null } | null
  /** A small change: lighter models and no Critic (easy/change.ts). */
  small: boolean
  /** `full`: the full security review runs; `scan`: the secret scan, and the review only if the changes need it. */
  security: 'full' | 'scan'
  /** Quick or Thorough, and why (adaptive depth, as the change will start; absent: unknown). */
  depth?: DepthDecision
}

// ---- projects ---------------------------------------------------------------------------------------------------

/** One project in Easy's list: a folder with runs (Easy's or Full's), its newest run first. */
export interface EasyProjectView {
  folder: string
  name: string
  /** A short title from the idea ("Help guide for my knitting shop"); absent for a folder Easy did not make. */
  title?: string
  /** What Easy made it as (absent: a folder Easy did not make). */
  kind?: EasyKind
  idea?: string
  /** A game made with the user's own photos (its Brief's look is "My photos"): sharing it shares them. */
  photos?: boolean
  lastRunId: string
  lastDisplayNo: number
  lastStatus: RunStatus
  lastOutcome?: RunOutcome
  updatedAt: number
  runs: number
}

// ---- a folder Easy did not make ---------------------------------------------------------------------------------

/**
 * How a run works in a folder the user already has. `isolated`: a git repository with commits, so the run works in an
 * isolated copy and the user keeps or throws away its changes at the end. `inPlace`: a git repository with no commits
 * yet, so the run works in the folder and Undo everything puts it back. `needsUndo`: not a git repository; the run
 * works in place once the user turns on undo for the folder (git init, no commit).
 */
export const EASY_FOLDER_MODES = ['isolated', 'inPlace', 'needsUndo'] as const
export type EasyFolderMode = (typeof EASY_FOLDER_MODES)[number]

/** `easy.inspectFolder`: a folder the user picked, as Easy would work on it (read only; nothing is changed). */
export interface EasyFolderView {
  /** The folder, made absolute. */
  folder: string
  name: string
  /** Why Easy cannot work there (UI copy): a drive root, the home folder, a system folder, a file and so on. */
  problem?: string
  /** How the run would work there (absent with a problem). */
  mode?: EasyFolderMode
  /**
   * `isolated` only: how many files have changes git has not saved yet. The copy starts from the last commit, so it
   * would not have them: the user saves them first (one commit) or has it work right in the folder. Absent: none.
   */
  uncommitted?: number
  /** Easy made this folder (a project of its own): a change there is a change to that project. */
  made: boolean
  /** Who does the work, picked by readiness. `ready` false: nobody can start it yet. */
  vendors: { claude: boolean; codex: boolean; ready: boolean }
}

/** What existing.ts decides about a folder (the service adds `made` and `vendors`). */
export type EasyFolderFacts = Omit<EasyFolderView, 'made' | 'vendors'>

/** `easy.work`: a run in a folder the user already has ("Work on something I already have"). */
export interface EasyWorkRequest {
  folder: string
  /** What to do there. */
  change: string
  /** "Turn on undo for this folder": git init (no commit) before the run. Needed for a folder that is no repository. */
  turnOnUndo?: boolean
  /**
   * A repository with changes git has not saved yet (EasyFolderView.uncommitted): `saveFirst` commits them, then the
   * run works in a copy; `inPlace` works right in the folder (Undo everything puts it back). Absent: a copy of the
   * last commit, as for a folder with nothing unsaved.
   */
  how?: EasyWorkHow
  limits: RunLimits
}

export const EASY_WORK_HOWS = ['saveFirst', 'inPlace'] as const
export type EasyWorkHow = (typeof EASY_WORK_HOWS)[number]

// ---- looking at the page ------------------------------------------------------------------------------------------

/** Kinds whose Done screen offers to look at a picture of the page (a website, an app, a game). */
export const EASY_VISUAL_KINDS: readonly EasyKind[] = ['website', 'app', 'game']

/** The most findings one look at the page adds. */
export const EASY_VISUAL_FINDINGS_MAX = 8

/**
 * `easy.visual`: whether a run's page can be looked at (no tokens): who would look (a ready vendor that takes
 * pictures), or why nobody can; and whether a picture of the page is there yet (the smoke check takes it).
 */
export interface EasyVisualState {
  /** A game: it is looked at in two pictures (its title screen and a moment of play). */
  game?: true
  /** A ready vendor that takes pictures (null: none). */
  vendor: string | null
  /** Why it is off (UI copy) when `vendor` is null. */
  reason?: string
  /** About what one look costs (null: no price known). */
  usd: number | null
  /** The run's page has a picture (runs/<id>/preview/smoke.png). */
  picture: boolean
  /** The findings a look already added (the latest look's). */
  findings: EasyVisualFinding[]
}

/** One thing that may look wrong on the page, as a `[should]` finding of the run's preview check. */
export interface EasyVisualFinding {
  id: string
  title: string
  detail: string
}

/** `easy.visualReview`: what one look at the page found (added to the run's preview check as `[should]` findings). */
export interface EasyVisualResult {
  vendor: string
  findings: EasyVisualFinding[]
}

// ---- beginner helpers -------------------------------------------------------------------------------------------

/** The helpers that ask a model, each only on the user's click: Help me think it through, and Ask about it. */
export const EASY_HELPERS = ['think', 'ask'] as const
export type EasyHelper = (typeof EASY_HELPERS)[number]

/**
 * `easy.helperCost`: who would answer a helper and about what one call costs (null: no price known), or why nobody can
 * (`helper` null, `reason` says why). For Help me think it through the price is one round's.
 */
export interface EasyHelperCost {
  helper: EasyIntentHelper | null
  reason?: string
}

/** The most rounds of questions Help me think it through asks before it writes the brief. */
export const EASY_THINK_ROUNDS = 4
/** The most directions one round offers. */
export const EASY_THINK_OPTIONS = 3
/** The longest brief it writes (it fills the idea box). */
export const EASY_THINK_BRIEF_MAX = 1200
/** The longest answer the person gives in one round (a picked direction, or their own words). */
export const EASY_THINK_ANSWER_MAX = 500
/** The longest question and direction a round sends back (Clarify keeps 300 and 120, plus its ellipsis). */
export const EASY_THINK_QUESTION_MAX = 320
export const EASY_THINK_OPTION_MAX = 140

/** One round of Help me think it through: the question, the directions it offered, and what the person said. */
export interface EasyThinkTurn {
  question: string
  options: string[]
  answer: string
}

/** `easy.think`: the idea and the rounds so far; `finish` asks for the brief now. */
export interface EasyThinkRequest {
  idea: string
  turns: EasyThinkTurn[]
  finish?: boolean
}

/** `easy.think`: the next question with its directions, or the brief (with the kind it reads as, when it said one). */
export type EasyThinkAnswer =
  | { step: 'ask'; question: string; options: string[]; vendor: string }
  | { step: 'brief'; brief: string; kind?: EasyKind; vendor: string }

/** The longest question Ask about it takes. */
export const EASY_ASK_MAX = 500
/** The longest answer it shows. */
export const EASY_ASK_ANSWER_MAX = 4000

/** `easy.ask`: the answer in plain words, and who gave it. */
export interface EasyAskAnswer {
  answer: string
  vendor: string
  model: string | null
}

// ---- several ideas, one after another ---------------------------------------------------------------------------

/** The most ideas one overnight list holds. */
export const EASY_QUEUE_MAX = 10

/** One idea to make overnight: it becomes a new project (its own folder and queue) when it is added. */
export interface EasyQueueIdea {
  idea: string
  kind: EasyKind
  /** The project permission for this new folder ("Allow these for this project"), as on the confirm screen. */
  consent: boolean
  /** The kind was decided from the words ("Decide from my words"), not picked: a vague idea is warned about. */
  guessed?: boolean
}

/**
 * Something to know about an idea on the overnight list (the words are the renderer's): `exampleData`, a report from
 * data with no data file (it uses made-up numbers); `noResearch`, a game made without looking at similar games first
 * (that needs someone there); `vague`, the words could mean several kinds (`candidates`) and it is made as the first.
 */
export type EasyQueueWarning =
  { kind: 'exampleData' } | { kind: 'noResearch' } | { kind: 'vague'; candidates: EasyKind[] }

export interface EasyQueueAddRequest {
  ideas: EasyQueueIdea[]
  limits: RunLimits
}

/** `easy.queueStart`: now (`at` absent), or every day at `at` (`HH:MM`, the factory's schedule). */
export interface EasyQueueStartRequest {
  at?: string
}

/** One idea on the overnight list, as the queue sees it. */
export interface EasyQueueItem {
  folder: string
  title: string
  kind?: EasyKind
  status: QueueTaskStatus
  runId?: string
  /** Why it waits, failed or stopped (the queue's words). */
  reason?: string
  /** About what it costs and takes, as estimated when it was added (absent: no estimate). */
  estimate?: { durationMs: Percentiles; costUsd: Percentiles | null }
  /** What to know about it before it is made (absent: nothing). */
  warnings?: EasyQueueWarning[]
}

/** `easy.queue`: the overnight list (Easy's queued projects), whether it runs, and when it starts by itself. */
export interface EasyQueueView {
  items: EasyQueueItem[]
  /** `idle`: not started; `running`: makes the next one when it can; `paused`: waits for you (`pause` says why). */
  state: 'idle' | 'running' | 'paused'
  pause?: string
  /** The factory's schedule, when it is on: it starts the list at `start` (`HH:MM`). */
  schedule: { enabled: boolean; start: string }
  /** A launch notice that waits for you (a due schedule is never resumed silently). */
  notice?: { id: string; text: string }
}

// ---- run limits -------------------------------------------------------------------------------------------------

/** Why a run's own limit stopped it. `workedMs`: its working time then (time waiting for you left out). */
export interface LimitStop {
  kind: 'cost' | 'time'
  /** The limit (USD for cost, minutes for time). */
  limit: number
  costUsd: number | null
  workedMs: number
  at: number
}

/** `runs.limits`: a run's own limits, and the stop one of them caused. */
export interface RunLimitsView {
  limits: RunLimits
  stop?: LimitStop
}

// ---- milestones -------------------------------------------------------------------------------------------------

/** The five milestones Easy shows a run as. */
export const MILESTONES = ['understand', 'build', 'check', 'fix', 'wrap'] as const
export type Milestone = (typeof MILESTONES)[number]

/** Every step of a run belongs to exactly one milestone. */
export const STEP_MILESTONE: Readonly<Record<StepKey, Milestone>> = {
  preflight: 'understand',
  prepare: 'understand',
  'verify:0': 'understand',
  clarify: 'understand',
  research: 'understand',
  plan: 'understand',
  tests: 'build',
  'verify:red': 'build',
  implement: 'build',
  'verify:1': 'check',
  scan: 'check',
  acceptance: 'check',
  review: 'check',
  critic: 'check',
  security: 'check',
  fix: 'fix',
  'verify:2': 'fix',
  recheck: 'fix',
  deploy: 'wrap',
  explain: 'wrap',
  finalize: 'wrap',
}
