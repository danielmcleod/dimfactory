// IPC request validation: one zod.strictObject per command, checked against `Commands` in both directions at compile
// time. Main runs every `dimf:cmd` request through `parseRequest` before the core sees it, with the prompt
// caps. Structural checks only; the core still owns the semantic ones.
import { z } from 'zod'
import { DEPTH_SETTINGS } from './depth.ts'
import { BriefInputZ } from './brief.ts'
import {
  ACCENTS,
  CONFIG_SCOPES,
  EXPERIENCES,
  EffortZ,
  ModelIdZ,
  RunLimitsZ,
  RunOverridesZ,
  THEMES,
  VendorIdZ,
} from './config-schema.ts'
import {
  EASY_ASK_MAX,
  EASY_ATTACH_FOLDER_MAX_FILES,
  EASY_ATTACH_MAX_FILES,
  EASY_CHANGE_MAX,
  EASY_HELPERS,
  EASY_IDEA_MAX,
  EASY_KINDS,
  EASY_MULTIPLAYER,
  EASY_NEEDS,
  EASY_NEED_CHOICES,
  EASY_QUEUE_MAX,
  EASY_STACKS,
  EASY_THINK_ANSWER_MAX,
  EASY_THINK_OPTION_MAX,
  EASY_THINK_QUESTION_MAX,
  EASY_THINK_ROUNDS,
  EASY_WORK_HOWS,
} from './easy.ts'
import { STATS_RANGES } from './estimates.ts'
import { USAGE_RANGES } from './usage.ts'
import { STEP_PROMPT_NAMES } from './prompt-names.ts'
import { ASK_DECISIONS } from './events.ts'
import { RETRY_STRATEGIES } from './failure.ts'
import { PROVE_KINDS } from './guardrails.ts'
import type { JsonPatchOp, JSON_PATCH_OPS } from './failure.ts'
import { DIFF_SEGMENTS, RUN_EVENTS_MAX_LIMIT } from './ipc.ts'
import { RESEARCH_ANSWER_MAX, RESEARCH_INPUT_MAX } from './research.ts'
import { COMMIT_MESSAGE_MAX, DEPLOY_CLASSES } from './deploy.ts'
import { RECIPE_ID_PATTERN } from './recipes.ts'
import { PROJECT_GOAL_MAX, TEMPLATE_ID_PATTERN } from './templates.ts'
import { CLOCK_TIME, QUEUE_TASKS_MAX, QUEUE_TASK_ID, QUEUE_TASK_TEXT_MAX } from './factory.ts'
import type { Cmd, Req, Result } from './ipc.ts'
import {
  AGENT_STEPS,
  CLARIFY_ANSWER_MAX,
  CLARIFY_MAX_OPTIONS,
  CLARIFY_MAX_QUESTIONS,
  PASS_NAMES,
  RUN_OUTPUT_FILES,
  RUN_STATUSES,
  STEP_KEYS,
} from './run.ts'

// ---- bounds ---------------------------------------------------------------------------------------------------

const KB = 1024

export const ID_MAX = 128
export const PATH_MAX = 4096
export const UNDO_TOKEN_MAX = 4096
/** The task is capped at 100 KB (UTF-8) before it reaches a prompt. */
export const TASK_MAX_BYTES = 100 * KB
/** The whole prompt is capped at 400 KB, so no card input or prompt template can be larger. */
export const TEXT_INPUT_MAX_BYTES = 400 * KB
export const RUN_IDS_MAX = 500
/** Files in one diff/worktree request (paths lists). */
export const PATHS_MAX = 10_000
/** `runs.list` page size; the core clamps to the same value. */
export const RUNS_LIST_MAX_LIMIT = 1000
export const GRACE_MS_MAX = 10_000
export const LOG_MSG_MAX = 16 * KB
/** Outside agents' fixed port: an unprivileged one. */
export const MCP_PORT_MIN = 1024
export const MCP_PORT_MAX = 65535

/** UTF-8 length without allocating; a lone surrogate counts as U+FFFD (3 bytes), as TextEncoder encodes it. */
export function utf8ByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function fitsUtf8(s: string, maxBytes: number): boolean {
  if (s.length > maxBytes) return false
  return s.length * 3 <= maxBytes || utf8ByteLength(s) <= maxBytes
}

const textUpTo = (maxBytes: number): z.ZodString =>
  z.string().refine((s) => fitsUtf8(s, maxBytes), {
    message: `Too big: expected at most ${maxBytes / KB} KB of UTF-8 text`,
  })

/** Nesting a JSON patch value may have. */
export const JSON_VALUE_MAX_DEPTH = 64
/**
 * Nodes a JSON patch value may have, counted as JSON would write it out (a value reached twice counts twice).
 * IPC's structured clone keeps shared references, so a message under 1 KB (a chain of objects that each name
 * the same child twice) is a value of 2^levels nodes as JSON; checked without a bound it held main's event loop for
 * seconds at 24 levels and doubled with each one. No setting dimfactory.json holds comes near this.
 */
export const JSON_VALUE_MAX_NODES = 100_000

/** JSON-representable (what dimfactory.json can hold); a patch value of `undefined` would delete the key. */
function isJsonValue(root: unknown): boolean {
  let budget = JSON_VALUE_MAX_NODES
  const visit = (v: unknown, depth: number): boolean => {
    if (depth > JSON_VALUE_MAX_DEPTH || --budget < 0) return false
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (Array.isArray(v)) return v.every((x) => visit(x, depth + 1))
    if (typeof v !== 'object') return false
    const proto = Object.getPrototypeOf(v) as unknown
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(v).every((x) => visit(x, depth + 1))
  }
  return visit(root, 0)
}

// ---- leaves -------------------------------------------------------------------------------------------------

/** Run, card, request, finding, job and backup ids: opaque, short, printable. */
const IdZ = z
  .string()
  .min(1)
  .max(ID_MAX)
  .regex(/^\P{Cc}*$/u, 'Expected an id without control characters')
const RunIdZ = IdZ
const UndoTokenZ = z.string().min(1).max(UNDO_TOKEN_MAX)
const PathZ = z
  .string()
  .min(1)
  .max(PATH_MAX)
  .refine((s) => !s.includes('\u0000'), 'A path cannot contain a NUL character')
const FolderZ = PathZ.refine((s) => s.trim() !== '', 'folder must not be blank')
const HttpsUrlZ = z.url({ protocol: /^https$/, message: 'Expected an https URL' }).max(2048)
/** Epoch milliseconds. */
const TimestampZ = z.number().min(0)
const Sha256Z = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a sha256 hex digest')
/** `folderKey = sha256(lockKey(scopeRoot)).slice(0,16)` (as trust.json keys it). */
const FolderKeyZ = z.string().regex(/^[0-9a-f]{16}$/, 'Expected a 16-character folder key')
const ModelNameZ = ModelIdZ.unwrap()

const PassNameZ = z.enum(PASS_NAMES)
/** A step a vendor CLI runs (a pass, or Test-first's `tests` step): Retry, Continue without, Keep waiting. */
const AgentStepZ = z.enum(AGENT_STEPS)
const StepKeyZ = z.enum(STEP_KEYS)
const DiffSegmentZ = z.enum(DIFF_SEGMENTS)
const ConfigScopeZ = z.enum(CONFIG_SCOPES)
const RelPathsZ = z.array(PathZ).min(1).max(PATHS_MAX)
const optional = <T extends z.ZodType>(t: T): z.ZodExactOptional<T> => t.exactOptional()

/** RFC 6902 subset (mirrors core/config/patch.ts `isJsonPatchOp`); the allowlist and routing stay in the core. */
const JsonPointerZ = z
  .string()
  .max(1024)
  .regex(/^(\/([^~/]|~[01])*)+$/, 'Expected a JSON pointer such as /timeouts/stallMs')
const JsonValueZ = z.unknown().refine((v) => isJsonValue(v), 'Expected a JSON value')
export const JsonPatchOpZ = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: JsonPointerZ, value: JsonValueZ }),
  z.strictObject({ op: z.literal('replace'), path: JsonPointerZ, value: JsonValueZ }),
  z.strictObject({ op: z.literal('remove'), path: JsonPointerZ }),
  z.strictObject({ op: z.literal('test'), path: JsonPointerZ, value: JsonValueZ }),
]) satisfies z.ZodType<JsonPatchOp>

// JSON_PATCH_OPS is the runtime list; the union above must name exactly those ops.
type _PatchOpsCovered = AssertNever<
  Exclude<(typeof JSON_PATCH_OPS)[number], z.output<typeof JsonPatchOpZ>['op']>
>

// ---- request shapes ---------------------------------------------------------------------------------------------

const VoidZ = z.undefined()
const RunOnlyZ = z.strictObject({ runId: RunIdZ })
const DiagnosticsZ = z.strictObject({ runId: optional(RunIdZ), includeRaw: optional(z.boolean()) })
const RunPassZ = z.strictObject({ runId: RunIdZ, pass: AgentStepZ })
const UndoZ = z.strictObject({ runId: RunIdZ, undoToken: UndoTokenZ })
const FolderOnlyZ = z.strictObject({ folder: FolderZ })
const QueueTaskIdZ = z.string().regex(QUEUE_TASK_ID, 'Not a queue task id')
/** A memory proposal's id (the run's id). */
const MemoryProposalIdZ = z.string().regex(/^[A-Za-z0-9-]{1,80}$/, 'Not a memory update id')
/** A recipe id (recipes.list); core answers VALIDATION with a did-you-mean for one that does not exist. */
const RecipeIdZ = z.string().regex(RECIPE_ID_PATTERN, 'Not a recipe id')
/** The live checks and the estimate: folder, run overrides and the Brief. */
/** Who builds a match's side: a vendor, and its model and effort (absent or null: the vendor's default). */
const MatchContestantZ = z.strictObject({
  vendor: VendorIdZ,
  model: optional(ModelIdZ),
  effort: optional(EffortZ.unwrap()),
})
const MatchStartZ = z.strictObject({
  folder: FolderZ,
  task: textUpTo(TASK_MAX_BYTES).refine((s) => s.trim() !== '', 'task must not be blank'),
  overrides: optional(RunOverridesZ),
  brief: optional(BriefInputZ),
  recipe: optional(RecipeIdZ),
  sides: z.tuple([MatchContestantZ, MatchContestantZ]),
  blind: optional(z.boolean()),
})
const TaskCheckZ = z.strictObject({
  folder: FolderZ,
  task: textUpTo(TASK_MAX_BYTES),
  recipe: optional(RecipeIdZ),
})
const FolderChecksZ = z.strictObject({
  folder: FolderZ,
  overrides: optional(RunOverridesZ),
  brief: optional(BriefInputZ),
  recipe: optional(RecipeIdZ),
})

const ShellOpenZ = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.enum(['runFolder', 'worktree', 'rawLog']),
    runId: RunIdZ,
    step: optional(StepKeyZ),
  }),
  z.strictObject({ target: z.literal('folder'), path: PathZ }),
  z.strictObject({ target: z.enum(['logs', 'home']) }),
  z.strictObject({ target: z.literal('url'), url: HttpsUrlZ }),
  z.strictObject({ target: z.literal('configFile'), scope: ConfigScopeZ, folder: optional(FolderZ) }),
  z.strictObject({ target: z.literal('uploadFile'), path: PathZ }),
])

const configSaveBase = { scope: ConfigScopeZ, folder: optional(FolderZ), overrides: RunOverridesZ }
const ConfigSaveZ = z.discriminatedUnion('mode', [
  z.strictObject({ ...configSaveBase, mode: z.literal('row'), pass: PassNameZ }),
  z.strictObject({ ...configSaveBase, mode: z.literal('projectDefault') }),
])

const TrustGrantInputZ = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('vendorFolder'), vendor: VendorIdZ }),
  z.strictObject({ kind: z.literal('largeFolder') }),
  z.strictObject({ kind: z.literal('projectAuto'), projectSha: optional(Sha256Z) }),
  z.strictObject({ kind: z.literal('recipeAuto'), recipeId: RecipeIdZ, recipeSha: optional(Sha256Z) }),
  z.strictObject({
    kind: z.literal('command'),
    command: z.strictObject({
      kind: z.enum(['verify', 'deps', 'preview']),
      argv: z.array(z.string().max(PATH_MAX)).min(1).max(64),
      cwdRel: z.string().max(PATH_MAX),
      hash: optional(Sha256Z),
    }),
  }),
])

/** A preview command's target: a folder on demand, or a run (at least one). */
const previewTargetFields = { folder: optional(FolderZ), runId: optional(RunIdZ) }
const hasPreviewTarget = (r: { folder?: string; runId?: string }): boolean =>
  r.folder !== undefined || r.runId !== undefined
const PREVIEW_TARGET_MESSAGE = 'folder or runId is required'

/** Easy's answers for an idea's needs: each a choice that need has. */
const EasyNeedAnswersZ = z
  .partialRecord(z.enum(EASY_NEEDS), z.string().max(40))
  .refine(
    (r) =>
      Object.entries(r).every(
        ([need, choice]) =>
          choice === undefined || EASY_NEED_CHOICES[need as (typeof EASY_NEEDS)[number]].includes(choice),
      ),
    'Not a choice that need has',
  )

const PriceZ = z.number().min(0).max(100_000)
const PriceEditZ = z.strictObject({
  vendor: VendorIdZ,
  model: ModelNameZ,
  inputPerMTok: PriceZ,
  outputPerMTok: PriceZ,
  cacheReadPerMTok: PriceZ.nullable(),
  cacheWritePerMTok: PriceZ.nullable(),
  aliases: optional(z.array(ModelNameZ).max(32)),
  sourceUrl: optional(z.string().max(2048)),
})

const DaysZ = z.number().int().min(1).max(365)

// ---- the table ------------------------------------------------------------------------------------------------

type RequestSchemaMap = { readonly [C in Cmd]: z.ZodType<Req<C>> }

/**
 * Every command's request schema. `satisfies` makes a missing command, or a schema whose output does not fit
 * `Req<C>`, a compile error; `_EveryRequestCovered` below checks the reverse (a dropped variant or enum member).
 */
export const REQUEST_SCHEMAS = {
  // app / shell
  'app.info': VoidZ,
  'app.ready': z.strictObject({ route: optional(z.string().max(2048)) }),
  'app.quit': z.strictObject({ confirm: z.boolean() }),
  'dialog.pickFolder': z.strictObject({ defaultPath: optional(PathZ) }),
  'dialog.pickFiles': z.strictObject({ defaultPath: optional(PathZ) }),
  'shell.open': ShellOpenZ,
  'log.write': z.strictObject({
    level: z.enum(['info', 'warn', 'error']),
    msg: z.string().max(LOG_MSG_MAX),
    data: optional(z.unknown()),
  }),
  'diagnostics.build': DiagnosticsZ,
  'diagnostics.copy': DiagnosticsZ,
  'diagnostics.save': DiagnosticsZ,
  'events.focus': z.strictObject({ runIds: z.array(RunIdZ).max(RUN_IDS_MAX) }),
  'state.get': VoidZ,
  'state.set': z.strictObject({
    setupDismissed: optional(z.boolean()),
    notificationsPausedUntil: optional(TimestampZ.nullable()),
  }),
  // runs
  'runs.start': z.strictObject({
    folder: FolderZ,
    task: textUpTo(TASK_MAX_BYTES).refine((s) => s.trim() !== '', 'task must not be blank'),
    overrides: optional(RunOverridesZ),
    brief: optional(BriefInputZ),
    recipe: optional(RecipeIdZ),
  }),
  'runs.list': z.strictObject({
    folder: optional(FolderZ),
    status: optional(z.array(z.enum(RUN_STATUSES)).max(RUN_STATUSES.length)),
    vendor: optional(VendorIdZ),
    text: optional(z.string().max(1000)),
    from: optional(TimestampZ),
    to: optional(TimestampZ),
    cursor: optional(z.string().max(ID_MAX)),
    limit: optional(z.number().int().min(1).max(RUNS_LIST_MAX_LIMIT)),
  }),
  'runs.get': RunOnlyZ,
  'runs.events': z.strictObject({
    runId: RunIdZ,
    sinceSeq: z.number().int().min(0),
    limit: optional(z.number().int().min(1).max(RUN_EVENTS_MAX_LIMIT)),
    condensed: optional(z.boolean()),
  }),
  'runs.output': z.strictObject({ runId: RunIdZ, file: z.enum(RUN_OUTPUT_FILES) }),
  'runs.stop': RunOnlyZ,
  'runs.close': RunOnlyZ,
  'runs.resume': z.strictObject({ runId: RunIdZ, allowTimedOutAsk: optional(z.boolean()) }),
  'runs.retryPass': z.strictObject({
    runId: RunIdZ,
    pass: AgentStepZ,
    strategy: optional(z.enum(RETRY_STRATEGIES)),
  }),
  'runs.skipPass': RunPassZ,
  'runs.keepWaiting': RunPassZ,
  'runs.switchToAuto': RunOnlyZ,
  'runs.rerun': z.strictObject({
    runId: RunIdZ,
    from: z.enum(['start', 'fix']),
    findingIds: optional(z.array(IdZ).max(PATHS_MAX)),
  }),
  'runs.pin': z.strictObject({ runId: RunIdZ, pinned: z.boolean() }),
  'runs.remove': z.strictObject({ runIds: z.array(RunIdZ).min(1).max(RUN_IDS_MAX) }),
  'runs.undoRemove': z.strictObject({ undoToken: UndoTokenZ }),
  'runs.branch': z.strictObject({ runId: RunIdZ, action: z.enum(['return', 'delete']) }),
  'runs.limits': RunOnlyZ,
  // asks / cards / recovery
  'asks.answer': z.strictObject({
    runId: RunIdZ,
    requestId: IdZ,
    decision: z.enum(ASK_DECISIONS).exclude(['cancel']),
    graceMs: optional(z.number().int().min(0).max(GRACE_MS_MAX)),
  }),
  'asks.undo': z.strictObject({ runId: RunIdZ, requestId: IdZ }),
  'cards.resolve': z.strictObject({
    runId: RunIdZ,
    cardId: IdZ,
    choiceId: IdZ,
    // Text, finding ids or paths, the Clarify card's answers (one per question, '' for one left unanswered), or the
    // research card's kept item ids and `q<n>=<answer>` entries.
    input: optional(
      z.union([
        textUpTo(TEXT_INPUT_MAX_BYTES),
        z.array(IdZ).max(PATHS_MAX),
        z.array(z.string().max(CLARIFY_ANSWER_MAX)).max(CLARIFY_MAX_QUESTIONS),
        z.array(z.string().max(RESEARCH_ANSWER_MAX + 8)).max(RESEARCH_INPUT_MAX),
      ]),
    ),
  }),
  'recovery.execute': z.strictObject({
    actionId: IdZ,
    runId: optional(RunIdZ),
    folder: optional(FolderZ),
  }),
  'heal.diagnose': z.strictObject({ runId: RunIdZ, step: StepKeyZ }),
  // diff / worktree
  'diff.files': z.strictObject({ runId: RunIdZ, seg: DiffSegmentZ }),
  'diff.file': z.strictObject({
    runId: RunIdZ,
    seg: DiffSegmentZ,
    path: PathZ,
    ignoreEol: optional(z.boolean()),
  }),
  'diff.blob': z.strictObject({
    runId: RunIdZ,
    seg: DiffSegmentZ,
    side: z.enum(['old', 'new']),
    path: PathZ,
  }),
  'diff.revert': z.strictObject({
    runId: RunIdZ,
    seg: optional(DiffSegmentZ),
    paths: z.union([RelPathsZ, z.literal('all')]),
  }),
  'diff.undoRevert': UndoZ,
  'diff.markReviewed': z.strictObject({
    runId: RunIdZ,
    paths: RelPathsZ,
    reviewed: z.boolean(),
    seg: optional(DiffSegmentZ),
  }),
  'worktree.preview': RunOnlyZ,
  'worktree.apply': z.strictObject({
    runId: RunIdZ,
    paths: optional(RelPathsZ),
    resolutions: optional(z.record(PathZ, z.enum(['mine', 'theirs']))),
    reviewedOnly: optional(z.boolean()),
  }),
  'worktree.undoApply': UndoZ,
  'worktree.discard': RunOnlyZ,
  'worktree.undoDiscard': UndoZ,
  // preflight / vendors
  'preflight.run': FolderChecksZ,
  'depth.decide': FolderChecksZ.extend({ task: textUpTo(TASK_MAX_BYTES) }),
  'matches.start': MatchStartZ,
  'matches.get': z.strictObject({ matchId: RunIdZ }),
  'matches.list': VoidZ,
  'matches.rematch': z.strictObject({
    runId: RunIdZ,
    challenger: MatchContestantZ,
    fresh: optional(z.boolean()),
    blind: optional(z.boolean()),
    confirmNewVendor: optional(z.boolean()),
  }),
  'matches.rematchCheck': z.strictObject({ runId: RunIdZ }),
  'matches.savePatch': z.strictObject({ matchId: RunIdZ, side: z.enum(['a', 'b']) }),
  'matches.scoreboard': VoidZ,
  'matches.batchPlan': z.strictObject({ challenger: MatchContestantZ }),
  'matches.batchAdd': z.strictObject({ challenger: MatchContestantZ, runIds: z.array(RunIdZ).min(1).max(5) }),
  'matches.offers': VoidZ,
  'matches.dismissOffer': z.strictObject({ vendor: VendorIdZ, model: ModelIdZ.unwrap() }),
  'matches.pick': z.strictObject({ matchId: RunIdZ, side: z.enum(['a', 'b', 'none']) }),
  'matches.undoPick': z.strictObject({ matchId: RunIdZ }),
  'matches.blind': z.strictObject({ matchId: RunIdZ, on: z.boolean() }),
  'matches.compare': z.strictObject({ matchId: RunIdZ }),
  'matches.compareFile': z.strictObject({ matchId: RunIdZ, path: PathZ, ignoreEol: optional(z.boolean()) }),
  'task.check': TaskCheckZ,
  'task.sharpen': TaskCheckZ,
  'vendors.list': VoidZ,
  'vendors.probe': z.strictObject({ vendor: optional(VendorIdZ), force: optional(z.boolean()) }),
  'vendors.setPath': z.strictObject({ vendor: VendorIdZ, path: PathZ.nullable() }),
  'vendors.models': z.strictObject({ vendor: VendorIdZ, force: optional(z.boolean()) }),
  // config / prompts / ui / folders / git / trust / verify
  'config.resolve': z.strictObject({
    folder: optional(FolderZ),
    overrides: optional(RunOverridesZ),
    recipe: optional(RecipeIdZ),
  }),
  'extensions.discover': z.strictObject({ folder: optional(FolderZ) }),
  'extensions.claudeConnectors': z.strictObject({ force: optional(z.boolean()) }),
  'config.read': z.strictObject({ scope: ConfigScopeZ, folder: optional(FolderZ) }),
  'config.save': ConfigSaveZ,
  'config.patch': z.strictObject({
    scope: ConfigScopeZ,
    folder: optional(FolderZ),
    ops: z.array(JsonPatchOpZ).max(200),
  }),
  'config.restoreBackup': z.strictObject({ scope: ConfigScopeZ, folder: optional(FolderZ), backupId: IdZ }),
  'prompts.get': z.strictObject({
    name: z.enum([...PASS_NAMES, 'tests', ...STEP_PROMPT_NAMES, 'heal', 'catalog']),
    folder: optional(FolderZ),
  }),
  'prompts.save': z.strictObject({
    name: z.enum([...PASS_NAMES, ...STEP_PROMPT_NAMES]),
    scope: ConfigScopeZ,
    folder: optional(FolderZ),
    text: textUpTo(TEXT_INPUT_MAX_BYTES).nullable(),
  }),
  'ui.setTheme': z.strictObject({ theme: optional(z.enum(THEMES)), accent: optional(z.enum(ACCENTS)) }),
  'folders.recent': VoidZ,
  'git.init': FolderOnlyZ,
  'guardrails.suggest': FolderOnlyZ,
  'guardrails.state': VoidZ,
  'guardrails.prove': z.strictObject({ kind: z.enum(PROVE_KINDS) }),
  'trust.get': FolderOnlyZ,
  'trust.set': z.strictObject({ folder: FolderZ, grant: TrustGrantInputZ, trusted: z.boolean() }),
  'verify.detect': FolderOnlyZ,
  // dashboard / stats / estimates
  'dashboard.get': VoidZ,
  'stats.get': z.strictObject({ range: z.enum(STATS_RANGES) }),
  'usage.get': z.strictObject({ range: z.enum(USAGE_RANGES) }),
  'context.report': z.strictObject({ folder: z.string().min(1).max(4096) }),
  'estimates.get': FolderChecksZ,
  'brief.detect': z.strictObject({
    folder: optional(FolderZ),
    task: optional(textUpTo(TASK_MAX_BYTES)),
  }),
  'brief.save': z.strictObject({ folder: FolderZ, brief: BriefInputZ.nullable() }),
  'recipes.list': z.strictObject({ folder: optional(FolderZ) }),
  'brief.suggest': z.strictObject({
    folder: FolderZ,
    task: textUpTo(TASK_MAX_BYTES).refine((s) => s.trim() !== '', 'task must not be blank'),
    brief: BriefInputZ,
    overrides: optional(RunOverridesZ),
  }),
  // catalog
  'catalog.get': VoidZ,
  'catalog.refreshPlan': VoidZ,
  'catalog.refresh': z.strictObject({
    consent: z.literal(true),
    vendor: optional(VendorIdZ),
    model: optional(ModelIdZ),
  }),
  'catalog.cancel': z.strictObject({ jobId: IdZ }),
  'catalog.apply': z.strictObject({ jobId: IdZ, rowIds: z.array(IdZ).max(PATHS_MAX) }),
  'catalog.undo': VoidZ,
  'catalog.savePrice': z.strictObject({ entry: PriceEditZ }),
  'catalog.setSchedule': z.strictObject({
    enabled: optional(z.boolean()),
    intervalDays: optional(DaysZ),
    snoozeDays: optional(DaysZ),
  }),
  // storage / notifications
  'storage.usage': VoidZ,
  'storage.clearShadow': z.strictObject({ folderKey: FolderKeyZ }),
  'notifications.test': VoidZ,
  'notifications.repairShortcut': VoidZ,
  // E2E only
  'e2e.state': VoidZ,
  'e2e.power': z.strictObject({ event: z.enum(['suspend', 'resume']) }),
  'e2e.clock': z.strictObject({
    advanceMs: z
      .number()
      .min(0)
      .max(366 * 24 * 3_600_000),
  }),
  // outside agents (MCP)
  'mcp.external.get': VoidZ,
  'mcp.external.set': z.strictObject({
    enabled: optional(z.boolean()),
    port: optional(z.number().int().min(MCP_PORT_MIN).max(MCP_PORT_MAX)),
    regenerate: optional(z.boolean()),
  }),
  'mcp.external.codexPlugin': z.strictObject({ install: z.boolean() }),
  'mcp.external.claudePlugin': z.strictObject({ install: z.boolean() }),
  'mcp.addToEditor': z.strictObject({ editor: z.enum(['vscode', 'cursor']) }),
  'mcp.requests.list': VoidZ,
  'mcp.requests.approve': z.strictObject({ id: IdZ }),
  'mcp.requests.decline': z.strictObject({ id: IdZ }),
  // Run & Preview
  'preview.detect': z.strictObject(previewTargetFields).refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'preview.start': z
    .strictObject({ ...previewTargetFields, commandId: IdZ })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'preview.trust': z
    .strictObject({ ...previewTargetFields, commandId: IdZ, hash: optional(Sha256Z), trusted: z.boolean() })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'preview.stop': z.strictObject({ sessionId: IdZ, containers: optional(z.literal(true)) }),
  'preview.list': VoidZ,
  'preview.open': z.strictObject({ sessionId: IdZ, target: z.enum(['app', 'browser']) }),
  'preview.openPair': z.strictObject({
    sessionIds: z.tuple([IdZ, IdZ]),
    labels: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80)]),
  }),
  'preview.smoke': z.strictObject({ sessionId: IdZ }),
  'preview.savePdf': z.strictObject({ sessionId: IdZ }),
  'preview.playtest': z.strictObject({ sessionId: IdZ }),
  'preview.tryIt': z.strictObject({ sessionId: IdZ }),
  'preview.shareCheck': z.strictObject({ sessionId: IdZ }),
  'preview.network': z.strictObject({ sessionId: IdZ, internet: z.boolean() }),
  'preview.phone': z.strictObject({ sessionId: IdZ, phone: z.boolean() }),
  // Deploy helper
  'deploy.inspect': z
    .strictObject({ ...previewTargetFields, cls: optional(z.enum(DEPLOY_CLASSES)) })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'deploy.tick': z
    .strictObject({
      ...previewTargetFields,
      item: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'Not a checklist item id'),
      ticked: z.boolean(),
    })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'deploy.uploadFile': z
    .strictObject({
      ...previewTargetFields,
      cls: optional(z.enum(DEPLOY_CLASSES)),
      includeData: optional(z.boolean()),
    })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'deploy.build': z
    .strictObject({
      ...previewTargetFields,
      trustHash: optional(z.string().regex(/^[0-9a-f]{64}$/, 'Not a sha256 in lower-case hex')),
    })
    .refine(hasPreviewTarget, PREVIEW_TARGET_MESSAGE),
  'git.commitPreview': RunOnlyZ,
  'git.commit': z.strictObject({
    runId: RunIdZ,
    message: optional(
      z
        .string()
        .max(COMMIT_MESSAGE_MAX)
        .refine((m) => m.trim() !== '', 'The commit message is empty')
        .refine(
          (m) => !m.includes(String.fromCharCode(0)),
          'The commit message may not hold a NUL character',
        ),
    ),
  }),
  'git.prPreview': RunOnlyZ,
  'git.prCreate': z.strictObject({
    runId: RunIdZ,
    confirm: z.strictObject({
      remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Not a git remote name'),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, 'Not an owner/name repository'),
      branch: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'Not a branch name'),
    }),
  }),
  // New project
  'templates.list': VoidZ,
  'project.create': z.strictObject({
    folder: FolderZ,
    templateId: z.string().regex(TEMPLATE_ID_PATTERN, 'Not a template id'),
    goal: optional(z.string().max(PROJECT_GOAL_MAX)),
  }),
  // The factory
  'queue.get': VoidZ,
  'queue.add': z.strictObject({
    folder: FolderZ,
    tasks: z
      .array(
        z.strictObject({
          task: z.string().min(1).max(QUEUE_TASK_TEXT_MAX),
          recipe: optional(z.string().regex(RECIPE_ID_PATTERN, 'Not a recipe id')),
        }),
      )
      .min(1)
      .max(QUEUE_TASKS_MAX),
  }),
  'queue.remove': z.strictObject({ folder: FolderZ, id: QueueTaskIdZ }),
  'queue.move': z.strictObject({
    folder: FolderZ,
    id: QueueTaskIdZ,
    to: z.number().int().min(0).max(QUEUE_TASKS_MAX),
  }),
  'queue.retry': z.strictObject({ folder: FolderZ, id: QueueTaskIdZ }),
  'queue.clear': FolderOnlyZ,
  'queue.importTodo': z.strictObject({ folder: FolderZ, file: optional(PathZ) }),
  'queue.githubCheck': FolderOnlyZ,
  'queue.importGithub': FolderOnlyZ,
  'queue.start': z.strictObject({
    folders: optional(z.array(FolderZ).min(1).max(QUEUE_TASKS_MAX)),
    noticeId: optional(IdZ),
  }),
  'queue.pause': z.strictObject({ folders: optional(z.array(FolderZ).min(1).max(QUEUE_TASKS_MAX)) }),
  'queue.dismissNotice': z.strictObject({ id: IdZ }),
  'queue.report': z.strictObject({
    date: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date looks like 2026-10-24')),
  }),
  'memory.get': FolderOnlyZ,
  'memory.apply': z.strictObject({ folder: FolderZ, id: MemoryProposalIdZ }),
  'memory.dismiss': z.strictObject({ folder: FolderZ, id: MemoryProposalIdZ }),
  // Easy mode
  'easy.state': VoidZ,
  'easy.projects': VoidZ,
  'easy.setExperience': z.strictObject({ experience: z.enum(EXPERIENCES) }),
  'easy.resolve': z.strictObject({
    idea: z.string().max(EASY_IDEA_MAX),
    kind: optional(z.enum(EASY_KINDS)),
    stack: optional(z.enum(EASY_STACKS)),
    recheck: optional(z.boolean()),
    depth: optional(z.enum(DEPTH_SETTINGS)),
  }),
  'easy.create': z.strictObject({
    idea: z.string().max(EASY_IDEA_MAX),
    kind: z.enum(EASY_KINDS),
    folder: FolderZ,
    limits: RunLimitsZ,
    consent: z.boolean(),
    attachments: optional(z.array(FolderZ).max(EASY_ATTACH_MAX_FILES)),
    multiplayer: optional(z.enum(EASY_MULTIPLAYER)),
    stack: optional(z.enum(EASY_STACKS)),
    needs: optional(EasyNeedAnswersZ),
    depth: optional(z.enum(DEPTH_SETTINGS)),
    two: optional(z.boolean()),
  }),
  'easy.attachCheck': z.strictObject({
    paths: z.array(FolderZ).max(EASY_ATTACH_MAX_FILES + EASY_ATTACH_FOLDER_MAX_FILES),
  }),
  'easy.permissions': VoidZ,
  'easy.permission': z.strictObject({ folder: FolderZ, runId: optional(RunIdZ) }),
  'easy.revokePermission': z.strictObject({ folder: FolderZ }),
  'easy.change': z
    .strictObject({
      folder: FolderZ,
      change: optional(z.string().max(EASY_CHANGE_MAX)),
      notWorking: optional(z.boolean()),
      continueRunId: optional(RunIdZ),
      limits: RunLimitsZ,
      attachments: optional(z.array(FolderZ).max(EASY_ATTACH_MAX_FILES)),
      depth: optional(z.enum(DEPTH_SETTINGS)),
      two: optional(z.boolean()),
    })
    .refine(
      (r) => (r.change !== undefined) !== (r.continueRunId !== undefined),
      'change or continueRunId is required',
    ),
  'easy.changeEstimate': z.strictObject({
    folder: FolderZ,
    change: z.string().max(EASY_CHANGE_MAX),
    depth: optional(z.enum(DEPTH_SETTINGS)),
  }),
  'easy.inspectFolder': z.strictObject({ folder: FolderZ }),
  'easy.work': z.strictObject({
    folder: FolderZ,
    change: z.string().max(EASY_CHANGE_MAX),
    turnOnUndo: optional(z.boolean()),
    how: optional(z.enum(EASY_WORK_HOWS)),
    limits: RunLimitsZ,
  }),
  'easy.intent': z.strictObject({
    idea: z.string().max(EASY_IDEA_MAX),
    candidates: z.array(z.enum(EASY_KINDS)).min(2).max(EASY_KINDS.length),
  }),
  'easy.visual': z.strictObject({ runId: RunIdZ }),
  'easy.visualReview': z.strictObject({ runId: RunIdZ }),
  'easy.helperCost': z.strictObject({ helper: z.enum(EASY_HELPERS), runId: optional(RunIdZ) }),
  'easy.think': z.strictObject({
    idea: z.string().trim().min(1).max(EASY_IDEA_MAX),
    turns: z
      .array(
        z.strictObject({
          question: z.string().max(EASY_THINK_QUESTION_MAX),
          options: z.array(z.string().max(EASY_THINK_OPTION_MAX)).max(CLARIFY_MAX_OPTIONS),
          answer: z.string().trim().min(1).max(EASY_THINK_ANSWER_MAX),
        }),
      )
      .max(EASY_THINK_ROUNDS),
    finish: optional(z.boolean()),
  }),
  'easy.shareFiles': z.strictObject({ runId: RunIdZ }),
  'easy.ask': z.strictObject({ runId: RunIdZ, question: z.string().trim().min(1).max(EASY_ASK_MAX) }),
  'easy.queue': VoidZ,
  'easy.queueAdd': z.strictObject({
    ideas: z
      .array(
        z.strictObject({
          idea: z.string().max(EASY_IDEA_MAX),
          kind: z.enum(EASY_KINDS),
          consent: z.boolean(),
          guessed: optional(z.boolean()),
        }),
      )
      .min(1)
      .max(EASY_QUEUE_MAX),
    limits: RunLimitsZ,
  }),
  'easy.queueStart': z.strictObject({
    at: optional(z.string().regex(CLOCK_TIME, 'A time looks like 22:00')),
    noticeId: optional(IdZ),
  }),
  'easy.queuePause': VoidZ,
  'easy.queueRemove': z.strictObject({ folder: FolderZ }),
} satisfies RequestSchemaMap

// ---- compile-time checks ------------------------------------------------------------------------------------------

type AssertNever<T extends never> = T

/** Commands whose `Req<C>` does not fit the schema's output (void requests must parse to `undefined`). */
type Uncovered = {
  [C in Cmd]: [Req<C>] extends [void]
    ? [z.output<(typeof REQUEST_SCHEMAS)[C]>] extends [undefined]
      ? never
      : C
    : [Req<C>] extends [z.output<(typeof REQUEST_SCHEMAS)[C]>]
      ? never
      : C
}[Cmd]
type _EveryRequestCovered = AssertNever<Uncovered>

// ---- parse ----------------------------------------------------------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'request'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out === '' ? String(seg) : `.${String(seg)}`
  }
  return out
}

/**
 * Validate one request. Unknown commands (any string at runtime) answer UNKNOWN_COMMAND, like the core's dispatch;
 * a mismatch answers VALIDATION with `<path>: <issue>` for the first issue and every zod issue in `details`.
 */
export function parseRequest<C extends Cmd>(cmd: C, raw: unknown): Result<Req<C>> {
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, cmd)) {
    const name = String(cmd).slice(0, ID_MAX)
    return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${name}".` } }
  }
  const schema = REQUEST_SCHEMAS[cmd] as z.ZodType<Req<C>>
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, value: r.data }
  const issues = r.error.issues
  const first = issues[0]
  const head = first !== undefined ? `${formatPath(first.path)}: ${first.message}` : 'request: Invalid input'
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''
  return { ok: false, error: { code: 'VALIDATION', message: head + more, details: issues } }
}
