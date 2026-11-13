// The Settings index (searched by the ⌘/Ctrl+K palette): every setting
// row by its label, with the field id its deep link carries (`#/settings/<section>[/<sub>]?field=<id>`). One list for
// the palette's Settings group and the rows themselves, so a palette result and the row it opens never disagree.
//
// Field ids:
//   - A row backed by a config key uses that key's JSON pointer (`/notifications/sound`, `/timeouts/stallMs`): the same
//     pointer core puts in a settings_link recovery action (`#/settings/<section>?field=<pointer>`), so core's links
//     land on the same control. A link to a pointer below a row (`/passes/implement/model`) lands on the nearest row
//     above it (`/passes`).
//   - Any other row (an action, a table, a status) uses a short camelCase word (`pause`, `clearSnapshots`).
//   - Ids are unique within a section page (the section and its `sub`); both are part of the link.
//   - Core pointers that name no row here (`/storage/shadow`, `/backups/last-good`, a config error's pointer, a pass's
//     `promptTemplate`) are the section's own to focus (sectionData.ts useLinkFocus); the index finds nothing for them,
//     so the generic deep-link focus (components/palette/SettingsFieldFocus.tsx) leaves them alone.
//
// Adding a row:
//   1. Add an entry below, in the section's order on the page: `{ section, id, label, group?, keywords? }`. `label` is
//      the row's label as the row shows it; `control` is the control's accessible name when that differs (a row
//      labelled "Vendor" whose dropdown is named "Self-heal vendor"); `keywords` are other words people search with.
//   2. Mark the row: `<SettingRow field={id} …>` (kit.tsx), or spread `settingFieldProps(id)` on the element that holds
//      the control when the row is not a SettingRow (a fieldset, a card). The deep link focuses the first enabled
//      control inside it, and waits while the control is still disabled because its value is loading.
//   3. Nothing else: the palette lists it, and `tests/renderer/palette/settingsIndex.test.ts` checks that the section
//      exists, the id is unique and the text has no em dash.
// A row that is not marked yet is still found by its label (`control`, then `label`), so a new entry works at once.
//
// Vendor cards are listed per vendor by the palette from the probes (`#/settings/vendors/<id>?field=path`); their
// focus is VendorCard's (vendors/deepLink.ts), so they are not in this list.
import { href } from '../../lib/router.ts'
import { SETTINGS_SECTIONS } from './sections.ts'
import { BRAND } from '@shared/brand.ts'

export interface SettingsField {
  /** A SETTINGS_SECTIONS id. */
  section: string
  /** The `field` query value (see the header). */
  id: string
  /** The row's label, as the row shows it. */
  label: string
  /** The control's accessible name, when it differs from the label. */
  control?: string
  /** The Group the row sits in (context beside the label in the palette). */
  group?: string
  /** A route segment after the section (`#/settings/prompts/plan`), when the row lives on a sub page. */
  sub?: string
  /** Other words people search with. */
  keywords?: readonly string[]
}

/** The attribute that marks a row (or the element holding its control) with its field id. */
export const SETTING_FIELD_ATTR = 'data-setting-field'

/** Spread on the element that holds a row's control when the row is not a SettingRow. */
export function settingFieldProps(id: string): { 'data-setting-field': string } {
  return { [SETTING_FIELD_ATTR]: id }
}

const PROMPT_TEMPLATES = [
  ['plan', 'Plan'],
  ['implement', 'Implement'],
  ['review', 'Review'],
  ['critic', 'Critic'],
  ['fix', 'Fix'],
  // The optional steps' templates (Settings › Prompts, a row of their own).
  ['clarify', 'Clarify'],
  ['clarify-easy', 'Clarify (plain words)'],
  ['research', 'Research'],
  ['acceptance', 'Acceptance review'],
  ['explain', 'Explain'],
  ['explain-easy', 'Explain (plain words)'],
  ['deploy', 'Deploy'],
  ['direct', 'Implement (Quick runs)'],
] as const

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  // ---- General ----
  { section: 'general', id: '/profile', label: 'Default profile', group: 'Runs', keywords: ['profile'] },
  {
    section: 'general',
    id: '/ask/denyPauses',
    label: 'A denied request pauses the run',
    group: 'Runs',
    keywords: ['deny', 'ask', 'pause'],
  },
  {
    section: 'general',
    id: '/ui/closeToTray',
    label: 'Closing the window',
    group: 'Runs',
    keywords: ['close to tray', 'tray', 'quit'],
  },
  {
    section: 'general',
    id: '/ui/experience',
    label: 'Easy or Full control',
    group: 'Runs',
    keywords: ['easy', 'full', 'mode', 'simple', 'make something'],
  },
  {
    section: 'general',
    id: '/timeouts/stallMs',
    label: 'Warn when a pass is silent for',
    control: 'Stall warning',
    group: 'Timeouts',
    keywords: ['stall', 'timeout', 'silent'],
  },
  {
    section: 'general',
    id: '/timeouts/hardKillMs',
    label: 'Stop a pass that is silent for',
    control: 'Hard stop',
    group: 'Timeouts',
    keywords: ['hard stop', 'kill', 'timeout'],
  },
  {
    section: 'general',
    id: '/timeouts/toolStallMs',
    label: 'Allow a running tool to be silent for',
    control: 'Tool stall',
    group: 'Timeouts',
    keywords: ['tool', 'stall', 'timeout'],
  },
  {
    section: 'general',
    id: '/timeouts/askMs',
    label: 'Wait for an answer to a request for',
    control: 'Request timeout',
    group: 'Timeouts',
    keywords: ['ask', 'approval', 'timeout'],
  },
  {
    section: 'general',
    id: '/storage/keepRuns',
    label: 'Keep at most',
    control: 'Runs kept',
    group: 'Run history',
    keywords: ['retention', 'runs kept', 'storage'],
  },
  {
    section: 'general',
    id: '/storage/keepDays',
    label: 'Remove runs older than',
    control: 'Days kept',
    group: 'Run history',
    keywords: ['retention', 'days', 'storage'],
  },
  {
    section: 'general',
    id: '/storage/rawLogDays',
    label: 'Keep raw vendor logs for',
    control: 'Raw log days',
    group: 'Run history',
    keywords: ['logs', 'retention', 'storage'],
  },

  // ---- Vendors (the cards are per vendor: see the header) ----
  {
    section: 'vendors',
    id: '/local/presets',
    label: 'Add a local model',
    group: 'Local models',
    keywords: ['local', 'preset', 'openai compatible', 'ollama'],
  },

  // ---- Profiles ----
  {
    section: 'profiles',
    id: 'list',
    label: 'Profile list',
    keywords: ['duplicate', 'rename', 'delete', 'set as default'],
  },
  {
    section: 'profiles',
    id: '/profile',
    label: 'Set as default',
    keywords: ['default profile'],
  },
  {
    section: 'profiles',
    id: '/passes',
    label: 'Passes',
    keywords: ['pass rows', 'vendor', 'model', 'mode'],
  },
  {
    section: 'profiles',
    id: '/steps',
    label: 'Steps',
    keywords: [
      'clarify',
      'questions',
      'research',
      'acceptance',
      'explain',
      'fix until green',
      'rounds',
      'deploy',
      'security re-check',
    ],
  },

  // ---- Extensions ----
  {
    section: 'extensions',
    id: 'passes',
    label: 'Passes',
    control: 'Plan extensions',
    keywords: ['extensions', 'mcp', 'skills', 'plugins', 'hooks', 'pass through', 'allowed list'],
  },
  {
    section: 'extensions',
    id: '/extensions/allowed',
    label: 'Allowed MCP servers and skills',
    keywords: ['mcp servers', 'skills', 'allow list', 'extensions'],
  },
  {
    section: 'extensions',
    id: '/contextHealth/grounding',
    label: 'Grounding checks',
    group: 'Context',
    keywords: ['hallucination', 'claims', 'grounding', 'made up', 'invented'],
  },
  {
    section: 'extensions',
    id: '/contextHealth/registryCheck',
    label: 'Check new packages online',
    group: 'Context',
    keywords: ['registry', 'npm', 'pypi', 'crates', 'packages', 'network', 'hallucination'],
  },
  {
    section: 'extensions',
    id: '/contextHealth/aiJudge',
    label: 'AI judge',
    group: 'Context',
    keywords: ['judge', 'claims', 'hallucination', 'ai-judged'],
  },
  {
    section: 'extensions',
    id: '/contextHealth/compactionReminder',
    label: 'Reminder after a summary',
    group: 'Context',
    keywords: ['compaction', 'summary', 'reminder', 'context', 'memory'],
  },
  {
    section: 'extensions',
    id: 'contextReport',
    label: 'Project report',
    group: 'Context',
    keywords: ['context', 'tokens', 'report', 'skills', 'mcp', 'claude.md', 'failures'],
  },

  // ---- Prompts ----
  ...PROMPT_TEMPLATES.map(([sub, name]): SettingsField => ({
    section: 'prompts',
    id: 'template',
    sub,
    label: `${name} prompt`,
    group: 'Prompt templates',
    keywords: ['template', name.toLowerCase()],
  })),
  {
    section: 'prompts',
    id: 'scope',
    label: 'Applies to',
    control: 'Prompt scope',
    group: 'Prompt templates',
    keywords: ['project', 'override', 'user'],
  },
  {
    section: 'prompts',
    id: 'diff',
    label: 'Show changes from the default',
    group: 'Prompt templates',
    keywords: ['diff', 'compare'],
  },
  {
    section: 'prompts',
    id: 'reset',
    label: 'Reset to the default',
    group: 'Prompt templates',
    keywords: ['restore', 'default prompt'],
  },

  // ---- Recipes ----
  {
    section: 'recipes',
    id: 'recipes',
    label: 'Your recipes and the built-in ones',
    keywords: ['recipe', 'preset', 'pipeline', 'template', 'bug fix', 'new web app', 'refactor', 'docs'],
  },
  {
    section: 'recipes',
    id: 'recipeFiles',
    label: 'Recipe files',
    keywords: ['recipe', 'file', 'json', 'share', 'project'],
  },

  // ---- Guardrails ----
  {
    section: 'guardrails',
    id: '/guardrails/preset',
    label: 'Preset',
    control: 'Guardrails preset',
    keywords: ['guardrails', 'rules', 'recommended', 'strict'],
  },
  {
    section: 'guardrails',
    id: '/guardrails/rules',
    label: 'Your rules',
    keywords: [
      'guardrails',
      'protected files',
      'forbidden command',
      'private files',
      'secrets',
      'network',
      'outside the folder',
      'prove it',
    ],
  },

  // ---- Self-heal ----
  {
    section: 'self-heal',
    id: '/selfHeal/enabled',
    label: 'Diagnose unknown failures automatically',
    keywords: ['self-heal', 'diagnose', 'heal'],
  },
  { section: 'self-heal', id: '/selfHeal/vendor', label: 'Vendor', control: 'Self-heal vendor' },
  { section: 'self-heal', id: '/selfHeal/model', label: 'Model', control: 'Self-heal model' },
  {
    section: 'self-heal',
    id: '/selfHeal/autoApplyConfigPatches',
    label: 'Apply safe config fixes without asking',
    keywords: ['auto apply', 'config patch'],
  },
  {
    section: 'self-heal',
    id: 'history',
    label: 'Last 10 diagnoses',
    keywords: ['history', 'heals'],
  },

  // ---- Catalog (refresh, review, editing and history) ----
  {
    section: 'catalog',
    id: '/catalog/refresh/intervalDays',
    label: 'Check prices every',
    control: 'Refresh interval',
    group: 'Update prices with AI',
    keywords: ['refresh', 'schedule', 'catalog'],
  },
  {
    section: 'catalog',
    id: '/catalog/refresh/vendor',
    label: 'Vendor that reads the price pages',
    control: 'Refresh vendor',
    group: 'Update prices with AI',
    keywords: ['refresh', 'ai vendor'],
  },
  {
    section: 'catalog',
    id: '/catalog/refresh/model',
    label: 'Model',
    control: 'Refresh model',
    group: 'Update prices with AI',
    keywords: ['refresh', 'ai model', 'prices'],
  },
  {
    section: 'catalog',
    id: 'update',
    label: 'Update now',
    group: 'Update prices with AI',
    keywords: ['refresh prices', 'catalog'],
  },
  {
    section: 'catalog',
    id: 'review',
    label: 'Review the update',
    keywords: ['diff', 'apply prices', 'price changes'],
  },
  {
    section: 'catalog',
    id: 'prices',
    label: 'Prices',
    keywords: ['pricing', 'models', 'cost', 'per million tokens', 'edit a price'],
  },
  {
    section: 'catalog',
    id: 'addPrice',
    label: 'Add a price',
    group: 'Prices',
    keywords: ['new model price', 'pricing'],
  },
  {
    section: 'catalog',
    id: 'history',
    label: 'Update history',
    keywords: ['history', 'price changes'],
  },
  {
    section: 'catalog',
    id: 'undoUpdate',
    label: 'Undo the last change',
    group: 'Update history',
    keywords: ['history', 'revert prices', 'restore'],
  },

  // ---- Isolation & Verify (the Verify and Isolation halves) ----
  {
    section: 'isolation',
    id: '/isolation/mode',
    label: 'Where runs make changes',
    control: 'Run location',
    group: 'Isolation',
    keywords: ['in place', 'isolated', 'worktree'],
  },
  {
    section: 'isolation',
    id: '/isolation/branch',
    label: 'Start each run on a new branch',
    control: 'New run branch',
    group: 'Isolation',
    keywords: ['branch', 'git'],
  },
  {
    section: 'isolation',
    id: '/isolation/worktree/install',
    label: 'Install dependencies in an isolated copy',
    control: 'Install dependencies',
    group: 'Isolation',
    keywords: ['dependencies', 'npm install', 'worktree'],
  },
  {
    section: 'isolation',
    id: '/isolation/worktree/copy',
    label: 'Files to copy into an isolated copy',
    group: 'Isolation',
    keywords: ['copy', '.env', 'untracked', 'ignored', 'worktree'],
  },
  {
    section: 'isolation',
    id: '/isolation/worktree/installCommand',
    label: 'Install command',
    group: 'Isolation',
    keywords: ['dependencies', 'install', 'command', 'pnpm', 'npm', 'worktree'],
  },
  {
    section: 'isolation',
    id: '/isolation/worktree/autoApply',
    label: 'Apply automatically in Auto',
    control: 'Apply automatically',
    group: 'Isolation',
    keywords: ['apply', 'auto', 'isolated', 'worktree'],
  },
  {
    section: 'isolation',
    id: '/passes/security/enabled',
    label: 'Security review',
    group: 'Security review',
    keywords: ['security', 'secrets', 'audit', 'owasp', 'vulnerabilities'],
  },
  {
    section: 'isolation',
    id: '/passes/security/recheck',
    label: 'Re-check after Fix',
    group: 'Security review',
    keywords: ['security', 're-check', 'recheck'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/clarify',
    label: 'Clarify before Plan',
    group: 'Clarify before Plan',
    keywords: ['clarify', 'questions', 'ask', 'brief', 'plan'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/clarifyQuestions',
    label: 'Most questions',
    group: 'Clarify before Plan',
    keywords: ['clarify', 'questions', 'how many'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/clarifyInAuto',
    label: 'Ask in Auto',
    group: 'Clarify before Plan',
    keywords: ['clarify', 'auto', 'questions'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/research',
    label: 'Research before Plan',
    group: 'Research before Plan',
    keywords: ['research', 'web', 'search', 'sources', 'lenses', 'competitors', 'standards', 'plan'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/researchLenses',
    label: 'Lenses',
    group: 'Research before Plan',
    keywords: ['research', 'lenses', 'comparable products', 'standards', 'pitfalls', 'mvp'],
  },
  {
    section: 'isolation',
    id: '/passes/review/acceptance',
    label: 'Acceptance review',
    group: 'Checking and explaining the result',
    keywords: ['acceptance', 'criteria', 'checklist', 'done', 'met', 'requirements'],
  },
  {
    section: 'isolation',
    id: '/passes/plan/explain',
    label: 'Explain it to me',
    group: 'Checking and explaining the result',
    keywords: ['explain', 'summary', 'plain language', 'how to run', 'beginner', 'explain.md'],
  },
  {
    section: 'isolation',
    id: '/passes/fix/rounds',
    label: 'Fix rounds',
    group: 'Fix until green',
    keywords: ['fix until green', 'rounds', 'loop', 'retry', 'fix again'],
  },
  {
    section: 'isolation',
    id: '/passes/fix/recheck',
    label: 'Re-check each round',
    group: 'Fix until green',
    keywords: ['fix until green', 're-check', 'recheck', 'must'],
  },
  {
    section: 'isolation',
    id: '/passes/fix/maxCostUsd',
    label: 'Max cost per run (USD)',
    group: 'Fix until green',
    keywords: ['fix until green', 'budget', 'cost', 'limit', 'usd'],
  },
  {
    section: 'isolation',
    id: '/passes/fix/maxMinutes',
    label: 'Max working time per run (minutes)',
    group: 'Fix until green',
    keywords: ['fix until green', 'budget', 'time', 'minutes', 'limit'],
  },
  {
    section: 'isolation',
    id: '/verify/enabled',
    label: 'Verify changes',
    group: 'Verify',
    keywords: ['verify', 'tests', 'checks', 'on', 'off'],
  },
  {
    section: 'isolation',
    id: '/verify/runAfter',
    label: 'When to verify',
    group: 'Verify',
    keywords: ['verify', 'after implement', 'after fix'],
  },
  {
    section: 'isolation',
    id: '/verify/failFast',
    label: 'Stop at the first failure',
    group: 'Verify',
    keywords: ['verify', 'fail fast'],
  },
  {
    section: 'isolation',
    id: '/verify/baseline',
    label: 'Check the commands before the run starts',
    control: 'Baseline check',
    group: 'Verify',
    keywords: ['verify', 'baseline', 'isolated'],
  },
  {
    section: 'isolation',
    id: '/verify/commands',
    label: 'Verify commands',
    group: 'Verify commands',
    keywords: ['verify', 'test', 'lint', 'trusted', 'trust', 'untrust', 'add a command'],
  },
  {
    section: 'isolation',
    id: 'detect',
    label: 'Detect commands',
    group: 'Verify commands',
    keywords: ['verify', 'detect'],
  },

  // ---- Preview ----
  {
    section: 'preview',
    id: '/preview/openIn',
    label: 'Open a preview',
    keywords: ['run it', 'preview', 'browser', 'window', 'dev server'],
  },

  // ---- Deploy ----
  {
    section: 'deploy',
    id: '/passes/implement/deploy',
    label: 'Write deploy config',
    group: 'Deploy step',
    keywords: ['deploy', 'dockerfile', 'netlify', 'vercel', 'fly', 'hosting'],
  },
  {
    section: 'deploy',
    id: '/passes/implement/deployTarget',
    label: 'Deploy target',
    group: 'Deploy step',
    keywords: ['deploy', 'hosting', 'provider', 'target'],
  },
  {
    section: 'deploy',
    id: '/git/commit',
    label: 'Offer Commit to run branch',
    group: 'Commit and pull request',
    keywords: ['commit', 'git', 'branch'],
  },
  {
    section: 'deploy',
    id: '/git/pullRequest',
    label: 'Offer Create PR',
    group: 'Commit and pull request',
    keywords: ['pull request', 'pr', 'github', 'gh', 'push'],
  },

  // ---- Factory ----
  {
    section: 'factory',
    id: '/factory/auto',
    label: 'Run queued tasks in Auto',
    group: 'Queued tasks',
    keywords: ['queue', 'auto', 'unattended'],
  },
  {
    section: 'factory',
    id: '/factory/skipBlocked',
    label: 'Skip blocked tasks',
    group: 'Queued tasks',
    keywords: ['queue', 'blocked', 'card', 'skip'],
  },
  {
    section: 'factory',
    id: '/factory/isolate',
    label: 'Run each task in an isolated copy',
    group: 'Queued tasks',
    keywords: ['queue', 'worktree', 'parallel'],
  },
  {
    section: 'factory',
    id: '/factory/maxParallel',
    label: 'Queued runs at once',
    group: 'Queued tasks',
    keywords: ['queue', 'parallel', 'concurrency'],
  },
  {
    section: 'factory',
    id: '/factory/maxCostPerRunUsd',
    label: 'Most cost per run',
    group: 'Budgets and stop rules',
    keywords: ['budget', 'cost', 'limit', 'money'],
  },
  {
    section: 'factory',
    id: '/factory/maxCostPerDayUsd',
    label: 'Most cost per day',
    group: 'Budgets and stop rules',
    keywords: ['budget', 'daily', 'cost', 'limit'],
  },
  {
    section: 'factory',
    id: '/factory/maxMinutesPerRun',
    label: 'Most time per run',
    group: 'Budgets and stop rules',
    keywords: ['time', 'limit', 'minutes'],
  },
  {
    section: 'factory',
    id: '/factory/maxFixRounds',
    label: 'Most Fix rounds',
    group: 'Budgets and stop rules',
    keywords: ['fix', 'rounds', 'limit'],
  },
  {
    section: 'factory',
    id: '/factory/stopAfterFailures',
    label: 'Pause after failures in a row',
    group: 'Budgets and stop rules',
    keywords: ['failures', 'stop', 'pause'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/enabled',
    label: 'Run the queues on a schedule',
    group: 'Schedule',
    keywords: ['schedule', 'overnight', 'night', 'cron'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/start',
    label: 'Starts at',
    group: 'Schedule',
    keywords: ['schedule', 'time', 'window'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/end',
    label: 'Ends at',
    group: 'Schedule',
    keywords: ['schedule', 'time', 'window'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/days',
    label: 'Days',
    group: 'Schedule',
    keywords: ['schedule', 'weekdays'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/resumeAutomatically',
    label: 'Resume automatically',
    group: 'Schedule',
    keywords: ['resume', 'reboot', 'launch'],
  },
  {
    section: 'factory',
    id: '/factory/schedule/onBattery',
    label: 'Start on battery',
    group: 'Schedule',
    keywords: ['battery', 'power', 'laptop'],
  },
  {
    section: 'factory',
    id: '/fallback/enabled',
    label: 'Fall back to another vendor',
    group: 'Fallback on a rate limit',
    keywords: ['fallback', 'rate limit', 'quota', 'switch vendor'],
  },
  {
    section: 'factory',
    id: '/fallback/vendors',
    label: 'Vendors to try, in order',
    group: 'Fallback on a rate limit',
    keywords: ['fallback', 'vendor order'],
  },
  {
    section: 'factory',
    id: '/memory/enabled',
    label: 'Give passes the project memory',
    group: 'Project memory',
    keywords: ['memory', 'conventions', 'decisions', 'notes'],
  },
  {
    section: 'factory',
    id: '/memory/propose',
    label: 'Propose an update after each run',
    group: 'Project memory',
    keywords: ['memory', 'update', 'proposal'],
  },
  {
    section: 'factory',
    id: '/memory/autoApply',
    label: 'Auto runs write it without asking',
    group: 'Project memory',
    keywords: ['memory', 'auto'],
  },
  {
    section: 'factory',
    id: '/quality/enabled',
    label: 'Require quality gates',
    group: 'Quality gates',
    keywords: ['quality', 'gates', 'done', 'required checks'],
  },
  {
    section: 'factory',
    id: '/quality/verify',
    label: 'Verify commands that must pass',
    group: 'Quality gates',
    keywords: ['tests', 'lint', 'coverage'],
  },
  {
    section: 'factory',
    id: '/quality/security',
    label: 'Security review must pass',
    group: 'Quality gates',
    keywords: ['security', 'gate'],
  },
  {
    section: 'factory',
    id: '/quality/acceptance',
    label: 'Every acceptance criterion must be met',
    group: 'Quality gates',
    keywords: ['acceptance', 'criteria', 'gate'],
  },

  // ---- Appearance ----
  {
    section: 'appearance',
    id: '/ui/theme',
    label: 'Theme',
    keywords: ['dark', 'light', 'system', 'mode'],
  },
  {
    section: 'appearance',
    id: '/ui/accent',
    label: 'Accent',
    keywords: ['colour', 'color', 'slate', 'blue', 'green', 'amber', 'rose', 'violet'],
  },
  {
    section: 'appearance',
    id: '/ui/streamFontSize',
    label: 'Stream font size',
    keywords: ['font', 'text size', 'output'],
  },

  // ---- Notifications ----
  {
    section: 'notifications',
    id: '/notifications/desktop',
    label: 'Show desktop notifications',
    group: 'Desktop notifications',
    keywords: ['notify', 'toast'],
  },
  {
    section: 'notifications',
    id: '/notifications/onlyWhenUnfocused',
    label: 'Only while Dim Factory is in the background',
    group: 'Desktop notifications',
    keywords: ['focus', 'background'],
  },
  {
    section: 'notifications',
    id: '/notifications/sound',
    label: 'Play a sound',
    group: 'Desktop notifications',
    keywords: ['sound', 'audio'],
  },
  {
    section: 'notifications',
    id: '/notifications/events/ask',
    label: 'A vendor asks for approval',
    group: 'Notify me when',
    keywords: ['ask', 'approval'],
  },
  {
    section: 'notifications',
    id: '/notifications/events/gate',
    label: 'A plan or findings are ready for review',
    group: 'Notify me when',
    keywords: ['gate', 'plan', 'findings'],
  },
  {
    section: 'notifications',
    id: '/notifications/events/completed',
    label: 'A run completed',
    group: 'Notify me when',
    keywords: ['completed', 'done'],
  },
  {
    section: 'notifications',
    id: '/notifications/events/failed',
    label: 'A run failed',
    group: 'Notify me when',
    keywords: ['failed', 'error'],
  },
  {
    section: 'notifications',
    id: '/notifications/events/catalog',
    label: 'Model prices may be out of date',
    group: 'Notify me when',
    keywords: ['catalog', 'prices'],
  },
  {
    section: 'notifications',
    id: 'pause',
    label: 'Pause for 1 hour',
    group: 'Notify me when',
    keywords: ['pause', 'mute', 'do not disturb'],
  },
  {
    section: 'notifications',
    id: 'test',
    label: 'Send a test notification',
    group: 'Notify me when',
    keywords: ['test'],
  },
  {
    section: 'notifications',
    id: 'repair',
    label: 'Repair',
    group: 'Windows notification setup',
    keywords: ['aumid', 'clsid', 'shortcut', 'windows'],
  },

  // ---- Outside agents ----
  {
    section: 'outside-agents',
    id: 'enabled',
    label: 'Let outside agents connect',
    keywords: ['mcp', 'agent', 'claude code', 'codex', 'api'],
  },
  { section: 'outside-agents', id: 'port', label: 'Port', keywords: ['mcp', 'port'] },
  {
    section: 'outside-agents',
    id: 'token',
    label: 'Token',
    keywords: ['mcp', 'token', 'bearer', 'new token'],
  },

  // ---- Diagnostics ----
  {
    section: 'diagnostics',
    id: 'versions',
    label: 'Versions and paths',
    keywords: ['version', 'electron', 'node', 'git', 'data folder', 'logs'],
  },
  {
    section: 'diagnostics',
    id: 'storage',
    label: 'Storage',
    keywords: ['disk', 'size', 'snapshots'],
  },
  {
    section: 'diagnostics',
    id: 'clearSnapshots',
    label: 'Clear snapshots',
    group: 'Storage',
    keywords: ['disk space', 'shadow', 'storage'],
  },
  {
    section: 'diagnostics',
    id: 'copy',
    label: 'Copy diagnostics',
    group: 'Diagnostics for a bug report',
    keywords: ['bug report', 'clipboard'],
  },
  {
    section: 'diagnostics',
    id: 'save',
    label: 'Save diagnostics',
    group: 'Diagnostics for a bug report',
    keywords: ['bug report', 'file'],
  },

  // ---- Config file ----
  {
    section: 'config',
    id: 'file',
    label: BRAND.configFileName,
    keywords: ['config file', 'json', 'errors'],
  },
  {
    section: 'config',
    id: 'restore',
    label: 'Restore the last good copy',
    keywords: ['backup', 'restore', 'last good'],
  },
]

/** The deep link of a row: `#/settings/<section>[/<sub>]?field=<id>`. */
export function settingsFieldHref(f: Pick<SettingsField, 'section' | 'id' | 'sub'>): string {
  return href({
    name: 'settings',
    section: f.section,
    ...(f.sub !== undefined ? { subpath: [f.sub] } : {}),
    query: { field: f.id },
  })
}

/** A pointer id and the pointers above it, nearest first (`/a/b/c` → `/a/b/c`, `/a/b`, `/a`); a word is itself. */
export function fieldIdCandidates(id: string): string[] {
  if (!id.startsWith('/')) return [id]
  const segs = id.split('/').slice(1)
  const out: string[] = []
  for (let n = segs.length; n > 0; n--) out.push(`/${segs.slice(0, n).join('/')}`)
  return out
}

/** The index entry a section's `field` names (the nearest pointer above it for a deeper pointer), if any. */
export function findSettingsField(section: string, id: string, sub?: string): SettingsField | undefined {
  const rows = SETTINGS_FIELDS.filter((f) => f.section === section)
  for (const c of fieldIdCandidates(id)) {
    const hits = rows.filter((f) => f.id === c)
    const exact = hits.find((f) => f.sub === sub) ?? hits[0]
    if (exact !== undefined) return exact
  }
  return undefined
}

/** The section's title (for the palette's context line), or the id. */
export function sectionTitle(section: string): string {
  return SETTINGS_SECTIONS.find((s) => s.id === section)?.title ?? section
}
