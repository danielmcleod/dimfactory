// Fixtures for the Quick composer tests: a complete config.resolve answer
// with provenance, a small fake resolver that applies run overrides the way core does (run provenance, Auto → full
// mode and gates off), probe views with readiness, preflight reports and estimates.
import { render } from '@testing-library/react'
import type { GenericLenses } from '@shared/research.ts'
import type { Provenance, ProvenanceMap, ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import { CONTEXT_HEALTH_DEFAULTS, FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { Estimate, RunEstimate, StepEstimate } from '@shared/estimates.ts'
import type { ComposerSuggestions, ResolvedWithProvenance } from '@shared/ipc.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { Mode, PassName, StepKey } from '@shared/run.ts'
import type { Capabilities, ModelInfo, ProbeView, VendorHealth } from '@shared/vendors.ts'
import { QuickComposer } from '@renderer/pages/dashboard/QuickComposer.tsx'
import { LAST_FOLDER_KEY } from '@renderer/pages/dashboard/composer-model.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, settle } from '../dashboard/setup.tsx'

export const FOLDER = 'C:\\work\\repo'
export const PROJECT_FILE = 'C:\\work\\repo\\.dimfactory\\dimfactory.json'
export const USER_FILE = 'C:\\home\\dimfactory.json'

const PASSES: readonly PassName[] = ['plan', 'implement', 'review', 'critic', 'security', 'fix']

const tpl = (name: string) => ({
  name,
  path: `builtin/${name}.md`,
  layer: 'builtin' as const,
  sha256: '0'.repeat(64),
})

/** The claude-only profile as core resolves it, with every section present. */
export function baseConfig(): ResolvedConfig {
  return {
    profile: 'claude-only',
    auto: false,
    passes: {
      plan: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('plan'),
        extensions: 'none',
        clarify: false,
        clarifyQuestions: 4,
        clarifyInAuto: false,
        clarifyPlain: false,
        research: false,
        researchLenses: [],
        explain: false,
        explainPlain: false,
      },
      implement: {
        vendor: 'claude',
        model: null,
        effort: null,
        mode: 'autoedit',
        enabled: true,
        promptTemplate: tpl('implement'),
        extensions: 'passthrough',
        deploy: false,
        deployTarget: null,
      },
      review: {
        vendor: 'claude',
        model: 'sonnet',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('review'),
        extensions: 'none',
        acceptance: false,
      },
      critic: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('critic'),
        extensions: 'none',
      },
      security: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: false,
        promptTemplate: tpl('security'),
        extensions: 'none',
        recheck: true,
      },
      fix: {
        vendor: 'claude',
        model: null,
        effort: null,
        mode: 'autoedit',
        enabled: true,
        promptTemplate: tpl('fix'),
        extensions: 'passthrough',
        inherit: 'implement',
        reuseSession: true,
        rounds: 1,
        recheck: true,
        maxCostUsd: null,
        maxMinutes: null,
      },
    },
    planning: { native: 'auto' },
    gates: { afterPlan: true, beforeFix: false },
    ask: { denyPauses: false },
    timeouts: { stallMs: 300_000, hardKillMs: 1_200_000, toolStallMs: 900_000, askMs: 600_000 },
    isolation: {
      mode: 'inPlace',
      branch: 'none',
      branchPrefix: 'dim/',
      worktree: { copy: [], install: 'ask', installCommand: null, autoApply: false },
    },
    verify: {
      enabled: false,
      commands: [],
      runAfter: ['implement', 'fix'],
      failFast: false,
      baseline: false,
    },
    extensions: { allowed: {} },
    tools: { on: {}, off: {}, skill: null },
    selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
    ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13, experience: null },
    notifications: {
      desktop: true,
      sound: false,
      onlyWhenUnfocused: true,
      events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
    },
    vendors: {},
    catalog: { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' } },
    storage: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
    local: { presets: [] },
    preview: { openIn: 'ask' },
    git: { commit: false, pullRequest: false, remote: 'origin' },
    factory: structuredClone(FACTORY_DEFAULTS),
    fallback: { enabled: false, vendors: [] },
    quality: { enabled: false, verify: [], security: false, acceptance: false },
    memory: { enabled: true, propose: true, autoApply: false, maxBytes: 16_000 },
    routing: {},
    limits: { maxCostUsd: null, maxMinutes: null },
    guardrails: { preset: 'recommended', rules: [] },
    easy: {
      projectsDir: null,
      maxCostUsd: null,
      changeMaxCostUsd: null,
      maxMinutes: null,
      skipPlanCheck: false,
    },
    contextHealth: { ...CONTEXT_HEALTH_DEFAULTS },
  }
}

/** Provenance as core records it for the claude-only profile, Plan's vendor from the user file, Review's model from the project. */
export function baseProvenance(): ProvenanceMap {
  const map: ProvenanceMap = {}
  for (const p of PASSES) {
    for (const k of ['vendor', 'model', 'mode', 'enabled'])
      map[`/passes/${p}/${k}`] = { source: 'default', via: 'profile:claude-only' }
  }
  map['/passes/implement/model'] = { source: 'cli' }
  map['/passes/fix/vendor'] = { source: 'inherit', via: 'inherit:implement' }
  map['/passes/fix/model'] = { source: 'cli', via: 'inherit:implement' }
  map['/passes/fix/mode'] = { source: 'inherit', via: 'inherit:implement' }
  map['/passes/plan/vendor'] = { source: 'user', file: USER_FILE, line: 4, via: 'passes' }
  map['/passes/review/model'] = { source: 'project', file: PROJECT_FILE, line: 7, via: 'passes' }
  map['/gates/afterPlan'] = { source: 'default' }
  map['/gates/beforeFix'] = { source: 'default' }
  map['/profile'] = { source: 'user', file: USER_FILE, line: 2 }
  map['/auto'] = { source: 'default' }
  return map
}

export interface FakeResolveOptions {
  config?: (c: ResolvedConfig) => void
  scopeRoot?: string | null
  profiles?: string[]
}

const RUN: Provenance = { source: 'run' }
const AUTO: Provenance = { source: 'auto' }

/** A config.resolve handler that applies run overrides the way core does (enough for the composer). */
export function fakeResolve(o: FakeResolveOptions = {}) {
  return (req: { folder?: string; overrides?: RunOverrides }): ResolvedWithProvenance => {
    const config = baseConfig()
    o.config?.(config)
    const provenance = baseProvenance()
    const ov = req.overrides ?? {}
    if (ov.profile !== undefined) {
      config.profile = ov.profile
      provenance['/profile'] = RUN
    }
    for (const p of PASSES) {
      const row = (ov.passes?.[p] ?? {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(row)) {
        ;(config.passes[p] as Record<string, unknown>)[k] = v
        provenance[`/passes/${p}/${k}`] = RUN
      }
    }
    for (const [k, v] of Object.entries(ov.gates ?? {})) {
      if (typeof v === 'boolean') config.gates[k as 'afterPlan' | 'beforeFix'] = v
      provenance[`/gates/${k}`] = RUN
    }
    if (ov.isolation?.mode !== undefined) config.isolation.mode = ov.isolation.mode
    if (ov.auto !== undefined) {
      config.auto = ov.auto
      provenance['/auto'] = RUN
    }
    if (config.auto) {
      config.passes.implement.mode = 'full'
      config.passes.fix.mode = 'full'
      config.gates = { afterPlan: false, beforeFix: false }
      for (const ptr of [
        '/passes/implement/mode',
        '/passes/fix/mode',
        '/gates/afterPlan',
        '/gates/beforeFix',
      ])
        provenance[ptr] = AUTO
    }
    return {
      config,
      provenance,
      issues: [],
      layers: {
        user: { scope: 'user', path: USER_FILE, exists: true, sha256: null, valid: true },
        project: { scope: 'project', path: PROJECT_FILE, exists: true, sha256: null, valid: true },
      },
      scopeRoot: o.scopeRoot !== undefined ? o.scopeRoot : (req.folder ?? null),
      folderKey: 'repo-key',
      profiles: o.profiles ?? ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough'],
      suggestions: coreSuggestions(config),
    }
  }
}

/**
 * What core's config.resolve suggests for a config (src/core/config/suggestions.ts; its own tests are
 * tests/unit/config/suggestions.test.ts), played here over the probe views the store holds: ready = built with a
 * passing probe, Claude and Codex first; a local preset runs on Codex; the Fix session is decideSession's answer.
 */
export function coreSuggestions(config: ResolvedConfig): ComposerSuggestions {
  const s = useStore.getState().probes
  const views = s.order.map((v) => s.byVendor[v]).filter((v): v is ProbeView => v !== undefined)
  const rank = (id: string): number => (id === 'claude' ? 0 : id === 'codex' ? 1 : 2)
  const ready = views
    .filter((v) => v.built && v.probe?.ok === true)
    .sort((a, b) => rank(a.vendor) - rank(b.vendor))
  const can = (v: ProbeView, mode: Mode): boolean =>
    v.probe?.capabilities.modes[mode].status !== 'unsupported'
  const adapter = (id: string): string => (id.startsWith('local-') ? 'codex' : id)
  const { implement, critic, fix } = config.passes
  const own = adapter(implement.vendor)
  const swap =
    critic.enabled && implement.enabled && adapter(critic.vendor) === own
      ? ready.find((v) => can(v, 'readonly') && adapter(v.vendor) !== own)
      : undefined
  const other = ready.find((v) => adapter(v.vendor) !== own && can(v, fix.mode))
  const differs = fix.vendor !== implement.vendor
  const fixSession: ComposerSuggestions['fixSession'] = !fix.reuseSession
    ? { choice: differs ? 'fresh-other' : 'fresh', reason: 'override-fresh' }
    : differs
      ? { choice: 'fresh-other', reason: 'vendor-differs' }
      : { choice: 'reuse' }
  return {
    criticSwap: swap !== undefined ? { to: swap.vendor } : null,
    fixSession,
    otherFixVendor: other?.vendor ?? null,
  }
}

// ---- probes -------------------------------------------------------------------------------------------------------

function capabilities(over: Partial<Capabilities['modes']> = {}): Capabilities {
  return {
    planMode: 'native',
    askRelay: true,
    resume: 'id',
    preassignSessionId: true,
    modelList: 'cli',
    usageCumulative: false,
    allowSession: 'native',
    web: true,
    resumeModelSwitch: true,
    reasoningIncludedInOutput: false,
    modes: {
      readonly: { status: 'supported', copy: 'Reads only.' },
      autoedit: { status: 'supported', copy: 'Edits in the folder.' },
      full: { status: 'supported', copy: 'Everything.' },
      ...over,
    },
  }
}

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' }

/** A probed vendor view: `ready` has a passing probe; `not-installed` has a failing bin check with an install command. */
export function probe(
  vendor: string,
  health: VendorHealth,
  over: { built?: boolean; models?: ModelInfo[]; modes?: Partial<Capabilities['modes']> } = {},
): ProbeView {
  const built = over.built ?? true
  const at = 0
  const checks: CheckResult[] =
    health === 'not-installed'
      ? [
          {
            id: `vendor.${vendor}.bin`,
            scope: 'vendor',
            status: 'fail',
            blocking: true,
            category: 'cli_missing',
            title: `${NAMES[vendor] ?? vendor} CLI not found`,
            detail: '',
            recovery: [
              {
                id: `vendor.${vendor}.bin.install`,
                label: `Copy the ${vendor} install command`,
                kind: 'shell_copy',
                command: `npm install -g ${vendor}-cli`,
                shell: 'powershell',
                reason: 'Install it, then check again.',
                recheck: `vendor.${vendor}.bin`,
              },
            ],
            at,
            ttlMs: 0,
          },
        ]
      : []
  return {
    vendor,
    displayName: NAMES[vendor] ?? vendor,
    built,
    experimental: false,
    health: built ? health : 'not-built',
    healthDetail:
      health === 'ready' ? 'Ready · 2.1.288' : health === 'not-installed' ? 'Not installed' : 'Login needed',
    checking: false,
    versionFloor: '2.0.0',
    versionRecommended: null,
    testedUpTo: '2.3.0',
    probe:
      built && health !== 'checking'
        ? {
            vendor,
            at,
            ok: health === 'ready' || health === 'warning',
            ...(health !== 'not-installed' ? { version: '2.1.288' } : {}),
            checks,
            capabilities: capabilities(over.modes),
            models: over.models ?? [],
          }
        : null,
    candidates: [],
  }
}

// ---- preflight ----------------------------------------------------------------------------------------------------

export function check(id: string, over: Partial<CheckResult> = {}): CheckResult {
  const status = over.status ?? 'pass'
  return {
    id,
    scope: (id.split('.')[0] ?? 'app') as CheckResult['scope'],
    status,
    blocking: over.blocking ?? status === 'fail',
    title: id,
    detail: '',
    recovery: [],
    at: 0,
    ttlMs: 0,
    ...over,
  }
}

export function report(over: Partial<PreflightReport> = {}): PreflightReport {
  const blocking = over.blocking ?? []
  return {
    mode: 'live',
    ok: blocking.length === 0,
    blocking,
    warnings: over.warnings ?? [],
    info: over.info ?? [
      check('app.git', { title: 'Git 2.47.1' }),
      check('folder.exists', { title: 'Folder exists' }),
      check('folder.lock', { title: 'Folder availability', detail: 'No other run is using this folder.' }),
      check('folder.git', { title: 'Git repository' }),
      check('pass.plan.native', { title: 'Native plan mode (Claude)', detail: "Claude's own plan mode." }),
    ],
  }
}

export const authBlocker = check('vendor.claude.auth', {
  status: 'fail',
  category: 'auth_required',
  title: 'Claude needs you to log in',
  detail: 'claude auth status exited with code 1.',
  recovery: [
    {
      id: 'vendor.claude.auth.login',
      kind: 'shell_copy',
      label: 'Copy the login command',
      command: 'claude auth login',
      shell: 'powershell',
      reason: 'Run this in a terminal, then check again.',
      recheck: 'vendor.claude.auth',
    },
    {
      id: 'vendor.claude.auth.settings',
      kind: 'settings_link',
      label: 'Open Claude settings',
      route: 'settings/vendors/claude',
      pointer: '/vendors/claude/path',
    },
  ],
})

// ---- estimates ----------------------------------------------------------------------------------------------------

const MIN = 60_000

export function stepEstimate(
  p50Min: number,
  p80Min: number,
  cost: [number, number] | null,
  over: Partial<StepEstimate> = {},
): StepEstimate {
  return {
    level: 'model',
    durationMs: { p50: p50Min * MIN, p80: p80Min * MIN },
    costUsd: cost === null ? null : { p50: cost[0], p80: cost[1] },
    samples: 12,
    basis: 'from 12 runs (claude · opus)',
    missingPricing: [],
    ...over,
  }
}

export function runEstimate(
  total: Partial<Estimate> = {},
  steps?: Partial<Record<StepKey, StepEstimate>>,
): RunEstimate {
  return {
    total: {
      durationMs: { p50: 9 * MIN, p80: 14 * MIN },
      costUsd: { p50: 0.4, p80: 0.85 },
      samples: 12,
      basis: 'from 12 runs',
      missingPricing: [],
      ...total,
    },
    steps: steps ?? {
      plan: stepEstimate(1, 2, [0.05, 0.08]),
      implement: stepEstimate(5, 8, [0.2, 0.4]),
      review: stepEstimate(1.5, 2, [0.05, 0.1]),
      critic: stepEstimate(1.5, 2.5, [0.06, 0.12]),
      fix: stepEstimate(3, 4, [0.1, 0.2]),
    },
    pFix: { value: 0.6, basis: 'prior' },
  }
}

// ---- mounting -----------------------------------------------------------------------------------------------------

/** Render the composer with `folder` already chosen (the last folder is remembered per viewer). */
export async function mountComposer(folder: string | null = FOLDER): Promise<void> {
  if (folder !== null) window.localStorage.setItem(LAST_FOLDER_KEY, folder)
  render(
    <Providers>
      <QuickComposer />
    </Providers>,
  )
  await settle()
}

/** Research's generic lenses as brief.detect sends them (BriefContext.research). */
export const GENERIC_LENSES: GenericLenses = {
  version: 1,
  lenses: [
    { id: 'comparable', label: 'Comparable products', ask: 'What do similar products offer?', web: true },
    { id: 'standards', label: 'Industry standards', ask: 'Which standards apply?', web: true },
    { id: 'pitfalls', label: 'Pitfalls', ask: 'What commonly goes wrong?', web: true },
    { id: 'repository', label: 'This repository', ask: 'What exists here already?', web: false },
  ],
  defaults: ['comparable', 'standards', 'repository'],
}
