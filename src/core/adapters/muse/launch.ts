// Muse argv, prompt file and env (`muse exec --json --prompt-file <runs/id/prompts/x.md>
// [--trust-workspace with grant] --disable-approval|--yolo`). The prompt is a file Dim Factory writes before the spawn,
// never argv; extraArgs go at the end and are validated against the managed and forbidden flags.
import { join } from 'node:path'
import { fileSafe } from '../../../shared/ids.ts'
import type { Mode } from '../../../shared/run.ts'
import { homePaths } from '../../home.ts'
import type { EnvInput } from '../../proc/env.ts'
import { sanitizeEnv } from '../../proc/env.ts'
import { acpExtraArgsProblem, acpFlagMapProblem, applyAcpFlagMap } from '../acp-base/launch.ts'
import type { StartOptions, StartStep } from '../types.ts'
import {
  MUSE_AUTOEDIT_NETWORK,
  MUSE_CLI_FLAGS,
  MUSE_FORBIDDEN_FLAGS,
  MUSE_MANAGED_FLAGS,
  museEffectiveMode,
} from './capabilities.ts'
import { MUSE_DISPLAY_NAME, MUSE_VENDOR } from './cli-spec.ts'

const FLAG_RULES = {
  displayName: MUSE_DISPLAY_NAME,
  managedFlags: MUSE_MANAGED_FLAGS,
  forbiddenFlags: MUSE_FORBIDDEN_FLAGS,
  cliFlags: MUSE_CLI_FLAGS,
}

/** The user's `vendors.muse.extraArgs`: flags only, never a managed or a widening one (undefined: fine). */
export function museExtraArgsProblem(extraArgs: readonly string[] | undefined): string | undefined {
  return acpExtraArgsProblem(FLAG_RULES, extraArgs)
}

/** `vendors.muse.flagMap` may rename a managed flag to a long flag Muse does not already use. */
export function museFlagMapProblem(
  flagMap: Readonly<Record<string, string>> | undefined,
): string | undefined {
  return acpFlagMapProblem(FLAG_RULES, flagMap)
}

/** A model name Dim Factory passes in argv: no leading dash (it would read as a flag), no spaces or control chars. */
export const MUSE_MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/

export interface MuseArgvInput {
  /** Absolute path of the prompt file Dim Factory wrote. */
  promptFile: string
  step: StartStep
  mode: Mode
  model?: string | null | undefined
  /** The folder's vendorFolder grant (StartOptions.trustFolder): `--trust-workspace`. */
  trust: boolean
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
}

/**
 * `exec --json --prompt-file <file> [--model m] [--trust-workspace] --disable-approval --sandbox-network restricted |
 * --yolo [extraArgs]`. Throws for a read-only step (Muse has no read-only mode: the caller refuses those before it gets
 * here).
 */
export function museArgv(i: MuseArgvInput): string[] {
  const mode = museEffectiveMode(i.step, i.mode)
  if (mode === 'readonly') throw new Error('Muse has no read-only mode')
  const argv = ['exec', '--json', '--prompt-file', i.promptFile]
  if (i.model !== undefined && i.model !== null && i.model !== '') argv.push('--model', i.model)
  if (i.trust) argv.push('--trust-workspace')
  // Full mode (Auto only) is --yolo; anything else that edits is --disable-approval, never a mode
  // that could stop for an approval exec cannot relay.
  // The sandbox keeps the network off on autoedit (by construction, not by Muse's default proxy review,
  // which --disable-approval skips with an undocumented answer).
  if (mode === 'full') argv.push('--yolo')
  else argv.push('--disable-approval', '--sandbox-network', MUSE_AUTOEDIT_NETWORK)
  return [...applyAcpFlagMap({ managedFlags: MUSE_MANAGED_FLAGS }, argv, i.flagMap), ...(i.extraArgs ?? [])]
}

/** Muse has no system-prompt channel on exec: the extra context leads the prompt (as on Codex's exec route). */
export function musePromptText(o: Pick<StartOptions, 'prompt' | 'systemAppend'>): string {
  const append = o.systemAppend?.trim()
  const text = append !== undefined && append !== '' ? `${append}\n\n${o.prompt}` : o.prompt
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * `<DIM_FACTORY_HOME>/runs/<runId>/prompts/<step>-muse-<n>.md`. The
 * engine keeps the rendered prompt as `<step>-<attempt>.md` beside it; this one is what Muse reads (the extra context
 * included), one file per process so a retry never rewrites what an earlier process may still be reading.
 */
export function musePromptFile(dimFactoryHome: string, runId: string, step: StartStep, n: number): string {
  return join(homePaths(dimFactoryHome).run(runId).promptsDir, `${fileSafe(step)}-muse-${Math.trunc(n)}.md`)
}

/** The child env: sanitized, the resolved PATH, `vendors.muse.env` and StartOptions.env on top. */
export function museEnv(
  base: EnvInput,
  o: {
    path: string | undefined
    pathPrepend?: readonly string[] | undefined
    vendorEnv?: EnvInput | undefined
    platform?: NodeJS.Platform | undefined
  },
): Record<string, string> {
  return sanitizeEnv(base, {
    purpose: 'vendor',
    vendor: MUSE_VENDOR,
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.pathPrepend !== undefined && o.pathPrepend.length > 0 ? { pathPrepend: o.pathPrepend } : {}),
    ...(o.vendorEnv !== undefined ? { vendorEnv: o.vendorEnv } : {}),
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
  })
}
