// The failure table as data: per failure category, its retry policy, ordered recovery templates and UI title.
// Templates are materialized into RecoveryAction[] by heal/recovery.ts; `{{name}}` placeholders are
// filled from the failure context (vendor display name, reset time, pass, command, …).
import type {
  Failure,
  FailureCategory,
  GrantKind,
  RecoveryActionKind,
  RetryStrategy,
} from '../../shared/failure.ts'
import { FAILURE_CATEGORIES } from '../../shared/failure.ts'
import { LAST_GOOD_POINTER } from '../recovery/routes.ts'
import type { CommandKind, GitCommandKind } from './commands.ts'

/** When a template applies; recovery.ts evaluates these against the failure context. */
export type RecoveryCondition =
  | 'session-exists'
  | 'claude-env-key'
  | 'size-guard'
  | 'git-lock'
  | 'git-dubious'
  | 'git-op'
  | 'win32'
  | 'pass-optional'
  | 'tested-up-to'
  | 'limit-in-extra-args'

export type RecoveryTemplate = {
  kind: RecoveryActionKind
  /** UI label; may contain `{{placeholders}}`. */
  label: string
  when?: RecoveryCondition
} & (
  | { kind: 'retry'; strategy?: RetryStrategy }
  | { kind: 'resume'; continuation: string }
  | {
      kind: 'config_patch'
      patch: 'model-null' | 'pass-disabled' | 'drop-limit-flags' | 'install-never' | 'larger-model'
    }
  | { kind: 'settings_link'; route: string; pointer: string }
  | {
      kind: 'shell_copy'
      command: CommandKind | GitCommandKind | 'gitInstall'
      reason: string
      elevated?: boolean
    }
  | { kind: 'vendor_setup' }
  | { kind: 'switch_vendor' }
  | { kind: 'grant'; grant: GrantKind }
  | { kind: 'wait_until'; armed: boolean }
  | { kind: 'skip_pass' }
  | { kind: 'close_run' }
  | { kind: 'open_docs'; doc: 'install' | 'billing' | 'limits' | 'proxy' }
  | { kind: 'heal' }
)

export type RetryAuto = boolean | 'conditional'

export interface RetryRule {
  auto: RetryAuto
  delayMs?: number
  /** Human-readable condition for `conditional` (when the auto-retry applies). */
  condition?: string
  strategy?: RetryStrategy
  /** False for fallbacks that do not spend the pass's one automatic retry. Default true. */
  consumesBudget?: boolean
}

export interface CategoryInfo {
  category: FailureCategory
  /** UI title; `{{vendor}}` is the vendor display name. */
  title: string
  retry: RetryRule
  recovery: readonly RecoveryTemplate[]
  /** Produces a snag card (false: user_cancelled, verify_failed → findings, timeout_stall → stall card). */
  snag: boolean
  /** Tied to one vendor: invalidates its probe cache and lets parallel Review/Critic share one card. */
  vendorScoped: boolean
  /** Self-heal: `auto` runs when enabled, `offer` shows "Diagnose with AI", `never` hides it. */
  heal: 'auto' | 'offer' | 'never'
}

const SWITCH: RecoveryTemplate = { kind: 'switch_vendor', label: 'Use another vendor' }
const RETRY: RecoveryTemplate = { kind: 'retry', label: 'Retry' }
const HEAL: RecoveryTemplate = { kind: 'heal', label: 'Diagnose with AI' }
const RETRY_FRESH: RecoveryTemplate = { kind: 'retry', label: 'Retry in a fresh session', strategy: 'fresh' }
const CLEAR_SNAPSHOTS: RecoveryTemplate = {
  kind: 'settings_link',
  label: 'Clear snapshots',
  route: 'settings/storage',
  pointer: '/storage/shadow',
}
/** The login command's reason; `{{vendor}}` is the vendor display name. */
export const LOGIN_REASON = 'Sign in to {{vendor}} in a terminal, then re-check.'
const LOGIN = (label: string): RecoveryTemplate => ({
  kind: 'shell_copy',
  label,
  command: 'login',
  reason: LOGIN_REASON,
})

type Row = Omit<CategoryInfo, 'category' | 'snag' | 'vendorScoped' | 'heal'> &
  Partial<Pick<CategoryInfo, 'snag' | 'vendorScoped' | 'heal'>>

const ROWS: Record<FailureCategory, Row> = {
  cli_missing: {
    title: '{{vendor}} CLI not found',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      {
        kind: 'shell_copy',
        label: 'Copy install command',
        command: 'install',
        reason: 'Install {{vendor}}.',
      },
      {
        kind: 'settings_link',
        label: 'Set the CLI path',
        route: 'settings/vendors',
        pointer: '/vendors/{{vendorId}}/path',
      },
      SWITCH,
      { kind: 'open_docs', label: 'Install docs', doc: 'install' },
    ],
  },
  cli_version: {
    title: '{{vendor}} CLI is too old',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      { kind: 'shell_copy', label: 'Copy update command', command: 'update', reason: 'Update {{vendor}}.' },
      SWITCH,
    ],
  },
  flag_drift: {
    title: '{{vendor}} CLI rejected a flag',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      { kind: 'heal', label: 'Find the renamed flag' },
      { kind: 'shell_copy', label: 'Copy update command', command: 'update', reason: 'Update {{vendor}}.' },
      {
        kind: 'shell_copy',
        label: 'Install the tested version ({{testedUpTo}})',
        command: 'pin',
        reason: 'Install the version Dim Factory was tested with.',
        when: 'tested-up-to',
      },
    ],
  },
  auth_required: {
    title: '{{vendor}} needs you to log in',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      LOGIN('Copy login command'),
      {
        kind: 'shell_copy',
        label: 'Copy command to unset ANTHROPIC_API_KEY',
        command: 'unsetApiKey',
        reason: 'An API key in the environment overrides your subscription in headless runs.',
        when: 'claude-env-key',
      },
      SWITCH,
    ],
  },
  auth_expired: {
    title: '{{vendor}} login expired',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [LOGIN('Copy login command'), SWITCH],
  },
  rate_limited: {
    title: '{{vendor}} rate limit hit',
    retry: { auto: 'conditional', condition: 'retry-after ≤ 120 s' },
    vendorScoped: true,
    recovery: [{ kind: 'wait_until', label: 'Retry at {{resetsAt}}', armed: true }, SWITCH],
  },
  quota_exceeded: {
    title: '{{vendor}} usage limit reached',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      { kind: 'wait_until', label: 'Retry when the limit resets ({{resetsAt}})', armed: false },
      SWITCH,
      { kind: 'open_docs', label: 'About usage limits', doc: 'limits' },
    ],
  },
  billing: {
    title: '{{vendor}} billing problem',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [{ kind: 'open_docs', label: 'Open billing', doc: 'billing' }, SWITCH],
  },
  model_unavailable: {
    title: 'Model not available',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      { kind: 'config_patch', label: "Use {{vendor}}'s default model", patch: 'model-null' },
      {
        kind: 'settings_link',
        label: 'Choose a default model',
        route: 'settings/vendors',
        pointer: '/vendors/{{vendorId}}/defaultModel',
      },
      SWITCH,
    ],
  },
  network: {
    title: 'Network problem',
    retry: { auto: true, delayMs: 5_000 },
    recovery: [RETRY, { kind: 'open_docs', label: 'Proxy settings', doc: 'proxy' }],
  },
  sandbox_unavailable: {
    title: '{{vendor}} sandbox not set up',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      { kind: 'vendor_setup', label: 'Set up the sandbox' },
      {
        kind: 'shell_copy',
        label: 'Copy elevated setup command',
        command: 'sandboxSetup',
        reason: 'Run in an administrator terminal, then re-check.',
        elevated: true,
        when: 'win32',
      },
      SWITCH,
    ],
  },
  trust_required: {
    title: 'Folder not trusted for {{vendor}}',
    retry: { auto: false },
    vendorScoped: true,
    recovery: [{ kind: 'grant', label: 'Trust this folder for {{vendor}}', grant: 'vendorFolder' }],
  },
  capability_missing: {
    title: "{{vendor}} can't do this here",
    retry: { auto: false },
    vendorScoped: true,
    recovery: [
      SWITCH,
      { kind: 'config_patch', label: 'Turn off {{pass}}', patch: 'pass-disabled', when: 'pass-optional' },
      { kind: 'shell_copy', label: 'Copy update command', command: 'update', reason: 'Update {{vendor}}.' },
    ],
  },
  resume_failed: {
    title: 'Could not resume the session',
    retry: { auto: true, strategy: 'fresh', consumesBudget: false },
    recovery: [RETRY_FRESH],
  },
  stream_malformed: {
    title: 'Unreadable output from {{vendor}}',
    retry: { auto: true },
    recovery: [RETRY, HEAL],
  },
  config_invalid: {
    title: 'Configuration error',
    retry: { auto: false },
    recovery: [
      {
        kind: 'settings_link',
        label: 'Open the config at {{location}}',
        route: 'settings/config',
        pointer: '{{pointer}}',
      },
      {
        kind: 'settings_link',
        label: 'Restore last good config',
        route: 'settings/config',
        pointer: LAST_GOOD_POINTER,
      },
    ],
  },
  git_missing: {
    title: 'Git not found',
    retry: { auto: false },
    recovery: [
      {
        kind: 'shell_copy',
        label: 'Copy git install command',
        command: 'gitInstall',
        reason: 'Install git.',
      },
    ],
  },
  git_state: {
    title: 'Repository needs attention',
    retry: { auto: 'conditional', delayMs: 2_000, condition: 'index lock: re-check once after 2 s' },
    recovery: [
      {
        kind: 'shell_copy',
        label: 'Copy safe.directory command',
        command: 'safeDirectory',
        reason: 'Git does not trust this folder owner.',
        when: 'git-dubious',
      },
      {
        kind: 'shell_copy',
        label: 'Copy git {{op}} --abort',
        command: 'abort',
        reason: 'Finish or abort the operation in progress.',
        when: 'git-op',
      },
      {
        kind: 'settings_link',
        label: 'Isolation settings',
        route: 'settings/isolation',
        pointer: '/isolation',
      },
    ],
  },
  folder_guard: {
    title: "Folder can't be used",
    retry: { auto: false },
    recovery: [
      { kind: 'grant', label: 'Allow this large folder', grant: 'largeFolder', when: 'size-guard' },
      { kind: 'settings_link', label: 'Choose another folder', route: 'composer', pointer: '/folder' },
    ],
  },
  snapshot_failed: {
    title: 'Snapshot failed',
    retry: { auto: true, delayMs: 2_000 },
    recovery: [
      RETRY,
      { kind: 'grant', label: 'Allow this large folder', grant: 'largeFolder', when: 'size-guard' },
      CLEAR_SNAPSHOTS,
    ],
  },
  worktree_failed: {
    title: 'Isolated worktree failed',
    retry: { auto: false },
    recovery: [
      RETRY,
      {
        kind: 'settings_link',
        label: 'Run in place instead',
        route: 'settings/isolation',
        pointer: '/isolation/mode',
      },
      {
        kind: 'shell_copy',
        label: 'Copy git worktree prune',
        command: 'worktreePrune',
        reason: 'Clean stale worktrees.',
      },
      {
        kind: 'shell_copy',
        label: 'Enable long paths',
        command: 'longPaths',
        reason: 'Windows path length limit.',
      },
      {
        kind: 'shell_copy',
        label: 'Copy git lfs install',
        command: 'lfsInstall',
        reason: 'Git LFS is not set up.',
      },
    ],
  },
  deps_missing: {
    title: 'Dependencies missing',
    retry: { auto: false },
    recovery: [
      {
        kind: 'shell_copy',
        label: 'Copy install command for {{tool}}',
        command: 'install',
        reason: 'Install {{tool}}.',
      },
      {
        kind: 'settings_link',
        label: 'Set the install command',
        route: 'settings/isolation',
        pointer: '/isolation/worktree/installCommand',
      },
      { kind: 'config_patch', label: 'Skip dependency install', patch: 'install-never' },
    ],
  },
  local_server: {
    title: 'Local model server not reachable',
    retry: { auto: false },
    recovery: [
      {
        kind: 'shell_copy',
        label: 'Copy ollama serve',
        command: 'ollamaServe',
        reason: 'Start the local server.',
      },
      { kind: 'settings_link', label: 'Local presets', route: 'settings/vendors', pointer: '/local/presets' },
      SWITCH,
    ],
  },
  verify_failed: {
    title: 'Verify failed',
    retry: { auto: false },
    snag: false,
    heal: 'never',
    recovery: [],
  },
  verify_untrusted: {
    title: 'Verify command not trusted',
    retry: { auto: false },
    recovery: [{ kind: 'grant', label: 'Trust this command', grant: 'command' }],
  },
  timeout_stall: {
    title: 'No output for a while',
    retry: { auto: false },
    snag: false,
    heal: 'never',
    recovery: [],
  },
  timeout_hard: {
    title: 'Stopped after too long without output',
    retry: { auto: false },
    recovery: [{ kind: 'resume', label: 'Resume', continuation: 'continue', when: 'session-exists' }, RETRY],
  },
  ask_timeout: {
    title: 'Question timed out',
    retry: { auto: false },
    heal: 'never',
    recovery: [{ kind: 'resume', label: 'Resume', continuation: 'continue' }],
  },
  permission_denied: {
    title: 'Permission denied',
    retry: { auto: false },
    heal: 'never',
    recovery: [
      {
        kind: 'resume',
        label: 'Resume without it',
        continuation: 'The user denied {{denied}}; do not retry it. Continue.',
      },
    ],
  },
  turn_limit: {
    title: 'Turn or budget limit reached',
    retry: { auto: false },
    recovery: [
      { kind: 'resume', label: 'Continue', continuation: 'continue' },
      {
        kind: 'config_patch',
        label: 'Remove the limit',
        patch: 'drop-limit-flags',
        when: 'limit-in-extra-args',
      },
    ],
  },
  context_exceeded: {
    title: 'Too much input for the model',
    retry: { auto: false },
    recovery: [
      { kind: 'retry', label: 'Retry fresh with a trimmed diff', strategy: 'fresh' },
      { kind: 'config_patch', label: 'Use a larger-context model', patch: 'larger-model' },
      SWITCH,
    ],
  },
  runaway_loop: {
    title: 'The AI kept repeating the same step',
    // Normal mode asks first (the loop card); Auto's one fresh retry is the engine's (machine.ts loop stop).
    retry: { auto: false },
    heal: 'never',
    recovery: [RETRY_FRESH],
  },
  content_policy: {
    title: 'Request refused by {{vendor}}',
    retry: { auto: false },
    vendorScoped: true,
    heal: 'never',
    recovery: [SWITCH],
  },
  vendor_internal: {
    title: '{{vendor}} service error',
    retry: { auto: true, delayMs: 15_000 },
    vendorScoped: true,
    recovery: [RETRY, SWITCH],
  },
  process_crash: {
    title: '{{vendor}} crashed',
    retry: { auto: 'conditional', condition: 'ran > 3 s' },
    recovery: [RETRY, HEAL],
  },
  disk_full: {
    title: 'Disk full',
    retry: { auto: false },
    recovery: [CLEAR_SNAPSHOTS, RETRY],
  },
  user_cancelled: {
    title: 'Stopped',
    retry: { auto: false },
    snag: false,
    heal: 'never',
    recovery: [],
  },
  unknown: {
    title: 'Something went wrong',
    retry: { auto: false },
    heal: 'auto',
    recovery: [HEAL, RETRY, { kind: 'open_docs', label: '{{vendor}} docs', doc: 'install' }],
  },
}

export const CATEGORY_INFO: Readonly<Record<FailureCategory, CategoryInfo>> = Object.fromEntries(
  FAILURE_CATEGORIES.map((c) => {
    const r = ROWS[c]
    const info: CategoryInfo = {
      category: c,
      title: r.title,
      retry: r.retry,
      recovery: r.recovery,
      snag: r.snag ?? true,
      vendorScoped: r.vendorScoped ?? false,
      heal: r.heal ?? 'offer',
    }
    return [c, info]
  }),
) as Record<FailureCategory, CategoryInfo>

export function categoryInfo(c: FailureCategory): CategoryInfo {
  return CATEGORY_INFO[c]
}

/** Replace `{{name}}` placeholders; unknown names become ''. */
export function fillTemplate(text: string, vars: Readonly<Record<string, string | undefined>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '')
}

export function categoryTitle(
  c: FailureCategory,
  vars: Readonly<Record<string, string | undefined>> = {},
): string {
  return fillTemplate(CATEGORY_INFO[c].title, { vendor: 'The vendor', ...vars })
}

// ---- retry policy -----------------------------------------------------------------------------------------

export const RATE_LIMIT_AUTO_MAX_MS = 120_000
export const CRASH_MIN_RUN_MS = 3_000

export interface RetryContext {
  /** How long the process ran (ExitInfo.ranMs). */
  ranMs?: number
  now?: number
}

export interface RetryDecision {
  auto: boolean
  delayMs: number
  strategy?: RetryStrategy
  consumesBudget: boolean
}

const GIT_LOCK = /index\.lock|\.lock'?:? File exists|Unable to create '[^']*\.lock'/i

/** The auto-retry policy for one failure. The engine still checks the pass's one-retry budget. */
export function retryPolicy(
  category: FailureCategory,
  failure?: Pick<Failure, 'message' | 'raw' | 'resetsAt' | 'retryAfterMs'>,
  ctx: RetryContext = {},
): RetryDecision {
  const rule = CATEGORY_INFO[category].retry
  const consumesBudget = rule.consumesBudget ?? true
  const base = (auto: boolean, delayMs = rule.delayMs ?? 0): RetryDecision => ({
    auto,
    delayMs: auto ? Math.max(0, delayMs) : 0,
    consumesBudget,
    ...(auto && rule.strategy ? { strategy: rule.strategy } : {}),
  })
  if (rule.auto === true) return base(true)
  if (rule.auto === false) return base(false)
  if (category === 'rate_limited') {
    const now = ctx.now ?? Date.now()
    const wait =
      failure?.retryAfterMs ?? (failure?.resetsAt !== undefined ? failure.resetsAt - now : undefined)
    return wait !== undefined && wait <= RATE_LIMIT_AUTO_MAX_MS ? base(true, wait) : base(false)
  }
  if (category === 'process_crash') return base(ctx.ranMs !== undefined && ctx.ranMs > CRASH_MIN_RUN_MS)
  if (category === 'git_state') return base(GIT_LOCK.test(`${failure?.message ?? ''}\n${failure?.raw ?? ''}`))
  return base(false)
}
