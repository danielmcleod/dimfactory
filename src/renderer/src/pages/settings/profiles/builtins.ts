// The built-in profiles and per-pass base values (core's
// src/core/config/defaults.ts BUILTIN_PROFILES / PASS_BASE). Mirrored here because the renderer never imports core;
// tests/renderer/settings/mirrors.test.ts keeps them equal. Settings → Profiles shows a built-in profile from this
// table (read-only) and copies it on Duplicate.
import type {
  FixConfig,
  ImplementConfig,
  PassConfig,
  PlanConfig,
  ProfileConfig,
  ReviewConfig,
  SecurityConfig,
} from '@shared/config-schema.ts'
import type { PassName } from '@shared/run.ts'
import { FIX_ROUNDS_MAX } from '@shared/run.ts'

export const BUILTIN_PROFILE_NAMES = ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough'] as const
export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number]

export function isBuiltinProfile(name: string): name is BuiltinProfileName {
  return (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name)
}

const ro = (vendor: string, model: string | null = null, enabled = true): PassConfig => ({
  vendor,
  model,
  mode: 'readonly',
  enabled,
})
const edit = (vendor: string, model: string | null = null): PassConfig => ({
  vendor,
  model,
  mode: 'autoedit',
  enabled: true,
})
const inheritFix = (reuseSession: boolean): FixConfig => ({
  inherit: 'implement',
  reuseSession,
  enabled: true,
})

export const BUILTIN_PROFILES: Readonly<Record<BuiltinProfileName, ProfileConfig>> = {
  balanced: {
    plan: ro('claude', 'opus'),
    implement: edit('codex'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  'claude-only': {
    plan: ro('claude', 'opus'),
    implement: edit('claude'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  'codex-only': {
    plan: ro('codex'),
    implement: edit('codex'),
    review: ro('codex'),
    critic: ro('codex'),
    security: ro('codex', null, false),
    fix: inheritFix(true),
  },
  fast: {
    plan: ro('claude', 'sonnet', false),
    implement: edit('codex'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', null, false),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  thorough: {
    plan: { ...ro('claude', 'opus'), clarify: true, research: true },
    implement: edit('codex'),
    review: { ...ro('claude', 'opus'), acceptance: true },
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus'),
    fix: { ...inheritFix(false), rounds: FIX_ROUNDS_MAX },
  },
}

/** Per-pass base values under every profile (a profile that omits a key gets these). */
export const PASS_BASE: Readonly<
  Record<PassName, PassConfig & FixConfig & SecurityConfig & PlanConfig & ImplementConfig & ReviewConfig>
> = {
  plan: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
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
    model: null,
    effort: null,
    mode: 'autoedit',
    enabled: true,
    promptTemplate: null,
    extensions: 'passthrough',
    deploy: false,
    deployTarget: null,
  },
  review: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
    extensions: 'none',
    acceptance: false,
  },
  critic: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
    extensions: 'none',
  },
  security: {
    vendor: 'claude',
    model: 'opus',
    effort: null,
    mode: 'readonly',
    enabled: false,
    promptTemplate: null,
    extensions: 'none',
    recheck: true,
    review: 'always',
  },
  fix: {
    model: null,
    effort: null,
    extensions: 'passthrough',
    mode: 'autoedit',
    enabled: true,
    promptTemplate: null,
    inherit: 'implement',
    reuseSession: true,
    rounds: 1,
    recheck: true,
    maxCostUsd: null,
    maxMinutes: null,
  },
}
