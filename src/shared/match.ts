// A match: two sides built from one starting point and one task, so their results can be compared. Head to head
// starts both sides now, each as an ordinary run in its own copy of the folder as it is at that moment. A rematch
// takes one side from a run that already finished. A side differs only in who builds: the vendor, model and effort of
// the building steps (Plan, Implement, Fix); everything else in the run is the same for both. Core keeps the record
// (`<home>/matches/<matchId>/match.json`) and each run records the match it belongs to (`matchOf`).
//
// What the person is asked once: Clarify's questions and Research's notes. Side A asks and researches; side B starts
// when that is over, from the same answers and the same notes.
import type { FileChange } from './ipc.ts'
import type { MatchResult } from './scoreboard.ts'

export const MATCH_KINDS = ['headToHead', 'rematch'] as const
export type MatchKind = (typeof MATCH_KINDS)[number]

export const MATCH_SIDES = ['a', 'b'] as const
export type MatchSide = (typeof MATCH_SIDES)[number]

/** The names the sides are shown by. */
export const MATCH_SIDE_LABEL: Readonly<Record<MatchSide, string>> = { a: 'Side A', b: 'Side B' }

/** The names the sides are shown by while the builders' names are hidden, in the order they are shown. */
export const MATCH_BLIND_LABEL: readonly [string, string] = ['First result', 'Second result']

/** The steps a side's builder runs: the rest of the run is the same on both sides. */
export const MATCH_BUILD_PASSES = ['plan', 'implement', 'fix'] as const

/** A run's place in a match (RunSummary.matchOf, resolved.json `matchOf`). */
export interface MatchRef {
  matchId: string
  side: MatchSide
  /**
   * The run is a rematch's side built now from an old starting point: its result is never applied to the folder (the
   * folder has moved on since), only read, previewed and saved as a patch.
   */
  rematch?: true
}

/** Who builds a side: the vendor, and its model and effort (absent or null: the vendor's own default). */
export interface MatchContestant {
  vendor: string
  model?: string | null
  effort?: string
}

/** One side as the record keeps it. */
export interface MatchSideRecord {
  side: MatchSide
  contestant: MatchContestant
  /** The side's run. Absent while the side waits for the questions and research the other side does for both. */
  runId?: string
  displayNo?: number
  /** UI copy: why the side never got a run (the other side stopped first, or it could not start when its turn came). */
  notStarted?: string
  /** A rematch's side A when it is the original run as it was recorded, not a run made for the match. */
  recorded?: true
}

/** What the person chose at the end of a match. */
export type MatchPickSide = MatchSide | 'none'

export interface MatchPick {
  side: MatchPickSide
  at: number
  /** Undoes the kept side's apply (worktree.undoApply). Absent for "neither". */
  undoToken?: string
  /** When the copies of the sides that were not kept were removed (7 days after the pick). */
  copiesRemovedAt?: number
}

/** Names hidden until the pick: which result is shown first, and when the names came back. */
export interface MatchBlind {
  /** Side B is shown first. */
  swap: boolean
  /** The names are shown again (a pick, or the switch turned off). Absent while they are hidden. */
  revealedAt?: number
}

/** `<home>/matches/<matchId>/match.json`. */
export interface MatchRecord {
  schemaVersion: 1
  matchId: string
  kind: MatchKind
  /** The folder the match is about (the sides work in copies of it, never in it). */
  folder: string
  /** The folder's shadow key: the starting point's snapshot is there, held by a ref named for the match. */
  folderKey: string
  task: string
  createdAt: number
  /** The starting point both sides were copied from: the folder as it was when the match began. */
  start: { tree: string; commit: string }
  sides: [MatchSideRecord, MatchSideRecord]
  /**
   * Side B has no run yet: this is what it will be started with (what `runs.start` takes, the same as side A got),
   * once side A's questions are answered and its research is chosen.
   */
  pending?: {
    request: Record<string, unknown>
    /** What the start knew about the task beyond its words (how deep to go), so side B is shaped as side A was. */
    hints?: Record<string, unknown>
  }
  /** Side A asked the questions or did the research for both sides. */
  shared?: boolean
  /** A rematch: the run that is replayed. */
  source?: { runId: string; displayNo: number }
  /** A rematch of a task the prompt check has a hint for: the results differ partly by guesswork. */
  openTask?: boolean
  blind?: MatchBlind
  pick?: MatchPick
  /** How the match ended (each side's checks, cost and time), kept for the scoreboard once both sides have ended. */
  result?: MatchResult
  /**
   * When the starting point's ref was dropped: both sides had made their copies (or ended), so nothing needs it any
   * more. Absent while it is held.
   */
  cleanedAt?: number
}

/** What a side built, for the comparison (`matches.get` only). */
export interface MatchSideDetail {
  /** The run's last word to the person (Fix's summary, else Implement's closing reply). */
  closing?: string
  /** Lines added and removed against the start. */
  lines?: { added: number; deleted: number }
  /** The last Verify round's commands. */
  checks?: { passed: number; failed: number }
  /** Grounding checks that found something. */
  grounding?: number
  /** Time the building steps (Plan, Implement, Fix) were at work. */
  buildMs?: number
  /** What Clarify and Research cost on this side (they ran here for both sides). Absent when they did not run here. */
  sharedCostUsd?: number | null
  /** Who reviewed the side: the vendors of Review and Critic that ran. */
  reviewers?: string[]
  /** One of the reviewers is the side's own builder. */
  selfReviewed?: boolean
  /** The page-load check's small screenshot (a data: URL), when the run made one. */
  thumbnail?: string
}

/** How a side's run stands, for a match's view. */
export interface MatchSideView extends MatchSideRecord {
  /** The run's status and outcome as its summary has them (absent: the run is not here any more, or not started). */
  status?: string
  outcome?: string
  endedAt?: number
  /** Tokens, cost and files changed so far. */
  tokens?: number
  costUsd?: number | null
  filesChanged?: number
  findings?: { must: number; should: number }
  /**
   * Where the side's copy stands (RunSummary.worktree): being prepared, being worked in, waiting to be applied or
   * discarded, applied, discarded. Absent once the run has no copy.
   */
  copyState?: string
  /** The copy holds changes that are not in the folder. */
  notApplied?: boolean
  detail?: MatchSideDetail
}

/** `matches.get` and `matches.list`: the record with each side's run as it stands. */
export interface MatchView extends Omit<MatchRecord, 'sides' | 'pending'> {
  sides: [MatchSideView, MatchSideView]
  /** Side B waits for side A's questions and research. */
  waiting: boolean
  /** Both sides have built: each is waiting to be applied or discarded, has ended, or is gone. */
  ready: boolean
  /** Both runs have ended (or are gone). */
  ended: boolean
  /** The later of the two runs' ends; absent while one is still going. */
  endedAt?: number
  /** The side whose result is in the folder (its copy was applied). */
  kept?: MatchSide
}

export interface MatchStarted {
  matchId: string
  sides: [
    { side: MatchSide; runId: string; displayNo: number },
    { side: MatchSide; runId?: string; displayNo?: number },
  ]
}

/** `matches.rematch`: replay a finished run against another builder. */
export interface MatchRematchRequest {
  /** The run to replay. */
  runId: string
  /** Who builds the other side. */
  challenger: MatchContestant
  /** Build the original's side again too, now (twice the cost), so both sides' numbers are from today. */
  fresh?: boolean
  blind?: boolean
  /** The person agreed to send this project to a vendor that has not run in it before. */
  confirmNewVendor?: boolean
}

/** `matches.rematchCheck`: whether a run can be replayed, and what a rematch of it would start from. */
export interface RematchCheck {
  /** UI copy: why not. Absent: it can. */
  blocked?: string
  /** Who built the original. */
  original?: MatchContestant
  displayNo?: number
  task?: string
  /** Vendors that have run in this project before (any other is asked about once). */
  knownVendors?: string[]
}

/** A batch of rematches replays at most this many past runs. */
export const BATCH_MAX = 5
/** A model the catalog got is offered for a batch this long after it was added. */
export const NEW_MODEL_OFFER_DAYS = 30

/** One past run a batch would replay. */
export interface BatchPlanItem {
  runId: string
  displayNo: number
  title: string
  folder: string
  /** The kind of task (the Brief's category). */
  category: string
  /** What the run cost: the batch's estimate for replaying it. */
  costUsd: number | null
}

/** `matches.batchPlan`: which past runs a batch against `challenger` would replay, cheapest first, and the total. */
export interface BatchPlan {
  challenger: MatchContestant
  items: BatchPlanItem[]
  /** What the originals cost together; null when none was priced. */
  totalUsd: number | null
  /** Runs left out because their project has never been sent to the challenger's vendor (a rematch there asks first). */
  newVendorLeftOut: number
}

/** `matches.batchAdd`: how many rematches were put in the queue, and how many could not be any more. */
export interface BatchAdded {
  added: number
  skipped: number
}

/** `matches.offers`: a model the catalog got lately that no match has tried yet, with the batch that would try it. */
export interface NewModelOffer {
  vendor: string
  model: string
  /** When the catalog got it. */
  at: number
  plan: BatchPlan
}

/** `matches.savePatch`: where a side's changes were saved as one patch file. */
export interface MatchPatchSaved {
  path: string
  bytes: number
}

/** `matches.pick`: the match as it stands now, and the files the folder holds differently (left for the person). */
export interface MatchPickResult {
  match: MatchView
  /** Paths the kept side changed that the folder changed too since the match began. Empty: everything was written. */
  conflicts: string[]
}

/** One path either side changed, for "Where they differ". */
export interface MatchCompareFile {
  path: string
  /** Side A's change against the start; absent when side A left the file alone. */
  a?: FileChange
  b?: FileChange
  /** Both sides changed it and ended with the same content. */
  same?: boolean
}

/** `matches.compare`: what each side changed against the start, path by path. */
export interface MatchCompare {
  files: MatchCompareFile[]
  /** Whether each side's changes could be read, and whether the two results can be put against each other. */
  available: { a: boolean; b: boolean; between: boolean }
}

/** Copies of the sides that were not kept are removed this long after the pick (the record and the diffs stay). */
export const MATCH_COPY_KEEP_DAYS = 7

export const MATCH_TEXT = {
  sameSides: 'Both sides are the same vendor and model: this match shows how much two tries differ.',
  noFolder: 'A match needs a folder.',
  noTask: 'A match needs a task.',
  twoSides: 'A match has exactly two sides.',
  unknownVendor: (side: string, vendor: string): string =>
    `${side}: ${vendor} is not a vendor Dim Factory knows.`,
  blocked: (side: string, why: string): string => `${side} cannot start. ${why}`,
  notFound: 'That match is not here any more.',
  copyDetail: 'Making the copy from the folder as it was when the match began.',
  copyRow: 'A copy of the folder as it was when the match began.',
  sharedStep: 'Shared from side A',
  sharedNote:
    'Side A asked the questions and did the research. This side starts from the same answers and notes.',
  waitingForA: 'Starts when side A has its answers and its research.',
  aStoppedFirst: 'Side A stopped before its questions and research were done, so this side was not started.',
  lateStart: (why: string): string => `This side could not start when its turn came. ${why}`,
  notReady: 'Both sides have to finish building before one is kept.',
  alreadyPicked: 'This match already has a pick. Undo it first.',
  nothingToKeep: (side: string): string => `${side} has no changes to keep.`,
  noPick: 'This match has no pick to undo.',
  blindAfterPick: 'Names cannot be hidden once a result is picked.',
  openTask: 'With a task this open, the two results will differ mostly by guesswork.',
  twoBuilds: 'A Head to head runs the task twice, so it costs about twice the estimate.',
  rematchNote:
    'The original run’s answers and research are carried over, so this side starts from the same inputs.',
  notApplied:
    'A rematch’s result is not applied: the folder has moved on since the original run. Save it as a patch instead.',
  newVendor: (vendor: string): string =>
    `${vendor} has not run in this project before. A rematch sends the project’s files to it.`,
  openTaskMark: 'Open task: the prompt check has a hint for it, so the results differ partly by guesswork.',
  thenAndNow: 'Side A’s numbers are from when it ran. Side B’s are from now.',
  noPatch: 'This side’s changes cannot be read any more, so no patch could be saved.',
  loserKept: `The other copy is kept for ${MATCH_COPY_KEEP_DAYS} days, then removed. Its changes stay readable.`,
} as const

export function isMatchSide(v: unknown): v is MatchSide {
  return v === 'a' || v === 'b'
}

export function otherSide(side: MatchSide): MatchSide {
  return side === 'a' ? 'b' : 'a'
}

/** Two contestants that build the same way (the same vendor, model and effort). */
export function sameContestant(a: MatchContestant, b: MatchContestant): boolean {
  return (
    a.vendor === b.vendor && (a.model ?? null) === (b.model ?? null) && (a.effort ?? '') === (b.effort ?? '')
  )
}

/** The names are hidden right now. */
export function blindNow(m: Pick<MatchRecord, 'blind'>): boolean {
  return m.blind !== undefined && m.blind.revealedAt === undefined
}

/**
 * The sides in the order the page shows them. A match whose names were hidden may show side B first, and keeps that
 * order once the names are back, so nothing swaps places at the reveal.
 */
export function shownOrder(m: Pick<MatchRecord, 'blind'>): readonly [MatchSide, MatchSide] {
  return m.blind?.swap === true ? ['b', 'a'] : ['a', 'b']
}

/**
 * Sort a match's changed paths into what only one side touched and what both did (`same`: the two ended alike).
 * A rename counts under its new path.
 */
export function splitCompare(files: readonly MatchCompareFile[]): {
  onlyA: MatchCompareFile[]
  onlyB: MatchCompareFile[]
  both: MatchCompareFile[]
  same: MatchCompareFile[]
} {
  const out = {
    onlyA: [] as MatchCompareFile[],
    onlyB: [] as MatchCompareFile[],
    both: [] as MatchCompareFile[],
    same: [] as MatchCompareFile[],
  }
  for (const f of files) {
    if (f.a !== undefined && f.b !== undefined) (f.same === true ? out.same : out.both).push(f)
    else if (f.a !== undefined) out.onlyA.push(f)
    else if (f.b !== undefined) out.onlyB.push(f)
  }
  return out
}
