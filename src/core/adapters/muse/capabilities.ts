// Muse on its exec route: modes, honest copy and capabilities (the "Muse exec" mode row: readonly
// unsupported; autoedit `--disable-approval` "sandbox-gated, never prompts; escalations fail" (degraded); full `--yolo`;
// plan emulated; no relay, Experimental). support() is the ONLY source of Muse's mode copy.
import type { Mode } from '../../../shared/run.ts'
import type { Capabilities, ReadinessNeed, Support } from '../../../shared/vendors.ts'
import type { StartStep } from '../types.ts'

/** Steps that may never change files: Muse has no read-only mode for them. */
const READ_ONLY_STEPS: ReadonlySet<StartStep> = new Set([
  'plan',
  'review',
  'critic',
  'heal',
  'catalog',
  'research',
])

/** The mode a step really runs in (a read-only step is readonly whatever its config says). */
export function museEffectiveMode(step: StartStep | ReadinessNeed['pass'], mode: Mode): Mode {
  return READ_ONLY_STEPS.has(step) || mode === 'readonly' ? 'readonly' : mode
}

/**
 * No relay: what the PassCard says on every Muse pass. Muse exec has nobody to answer an approval, so
 * Dim Factory never runs it where one could be asked, and the stall timer is what ends a pass that waits anyway.
 */
export const MUSE_NO_RELAY_NOTE =
  "Muse cannot ask you anything here: questions are not relayed. If it stops producing output, Dim Factory's stall timer stops the pass."

export const MUSE_READONLY_COPY =
  'Muse cannot run read-only: its exec mode has no read-only option, so Dim Factory never uses Muse for Plan, Review or Critic. Choose another vendor for this pass.'

/**
 * What the docs establish (dev.meta.ai/docs/muse-code/permissions, 2026-10-11): the sandbox writes only
 * in the folder and a temp folder and lets reads through anywhere; Dim Factory turns the network off itself
 * (`--sandbox-network restricted`); and whether a remembered Muse permission profile (Unrestricted) outranks the flags
 * is not documented, so the copy says so until a live M02 settles it.
 */
export const MUSE_AUTOEDIT_COPY = `Sandbox-gated, never prompts; escalations fail. Edits and commands run in Muse's sandbox without asking: they can write only in the folder (reading files outside it is possible) and have no network, which Dim Factory turns off. Anything that needs more fails instead of asking you. If your own Muse settings start sessions Unrestricted, Muse may run without its sandbox: Dim Factory cannot check that yet. ${MUSE_NO_RELAY_NOTE}`

export const MUSE_FULL_COPY = `Everything runs automatically: no sandbox and no prompts, and Muse trusts the folder for the run (Auto only). ${MUSE_NO_RELAY_NOTE}`

/** A run-less step (heal, price refresh) never runs on Muse: both are read-only. */
const MUSE_RUNLESS_COPY =
  'Muse cannot run read-only, so it does not diagnose failures or refresh prices. Claude or Codex does that instead.'

/** The mode table, Muse exec row. */
export function museSupport(need: { pass: StartStep | ReadinessNeed['pass']; mode: Mode }): Support {
  if (need.pass === 'heal' || need.pass === 'catalog') {
    return { status: 'unsupported', copy: MUSE_RUNLESS_COPY }
  }
  const mode = museEffectiveMode(need.pass, need.mode)
  if (mode === 'readonly') return { status: 'unsupported', copy: MUSE_READONLY_COPY }
  if (mode === 'autoedit') return { status: 'degraded', copy: MUSE_AUTOEDIT_COPY }
  return { status: 'supported', copy: MUSE_FULL_COPY }
}

/**
 * What Muse can do through Dim Factory. `resume: 'none'`: exec can continue a session (`--session-id`), but nothing has
 * recorded how it answers a missing or moved session, so Fix always starts fresh (a follow-up with a live fixture).
 */
export function museCapabilities(): Capabilities {
  const pass = (mode: Mode): Support => museSupport({ pass: 'implement', mode })
  return {
    planMode: 'emulated',
    askRelay: false,
    resume: 'none',
    preassignSessionId: false,
    modelList: 'static',
    usageCumulative: false,
    allowSession: 'app',
    web: false,
    resumeModelSwitch: false,
    resumeModeSwitch: false,
    // No effort setting: a pass's effort is left out of the launch.
    effort: false,
    reasoningIncludedInOutput: true,
    modes: { readonly: pass('readonly'), autoedit: pass('autoedit'), full: pass('full') },
  }
}

// ---- flags ------------------------------------------------------------------------------------------------------

/** Flags Dim Factory sets on every pass (extraArgs may not repeat them; flagMap may only rename them). */
export const MUSE_MANAGED_FLAGS: readonly string[] = [
  '--json',
  '--prompt-file',
  '--model',
  '--trust-workspace',
  '--disable-approval',
  // Autoedit passes `--sandbox-network restricted` (no network), so the copy's "no network" is true by
  // construction. Managed, so extraArgs may never set it (it was forbidden for the same reason before).
  '--sandbox-network',
  '--yolo',
  '--session-id',
]

/** The sandbox's network setting on autoedit (permissions page: `restricted` is "no network access"). */
export const MUSE_AUTOEDIT_NETWORK = 'restricted'

/**
 * Flags the user's extraArgs may never add: each one would let a pass do more than its mode says, or make exec wait
 * for an approval nobody can give (`--approval-mode on-request`: exec hangs on approvals).
 */
export const MUSE_FORBIDDEN_FLAGS: readonly string[] = [
  '--approval-mode',
  '--approval-judge',
  '--disable-sandbox',
  '--allow-workspace-switch',
]

/** Every exec flag the docs name (a flagMap rename may not target one). */
export const MUSE_CLI_FLAGS: readonly string[] = [
  ...MUSE_MANAGED_FLAGS,
  ...MUSE_FORBIDDEN_FLAGS,
  '--max-model-steps',
  '--output-schema',
  '--reasoning-effort',
  '--no-session-log',
  '--max-tool-output-bytes',
  '--provider',
  '--worktree',
  '--resume',
]

/** The exec flags a pass needs: the probe fails when `muse exec --help` lacks one (flag_drift). */
export const MUSE_REQUIRED_EXEC_FLAGS: readonly string[] = [
  '--json',
  '--prompt-file',
  '--disable-approval',
  '--sandbox-network',
  '--yolo',
  '--trust-workspace',
]

/** Static model list until a session protocol client asks Muse (`model/list`); the docs name the default only. */
export const MUSE_DEFAULT_MODEL = 'muse-spark-1.2'

// ---- timing -----------------------------------------------------------------------------------------------------

export interface MuseTiming {
  /** After the terminal record the process should exit; it is stopped if it lingers (1.4.2: cleanup can stall). */
  exitAfterTerminalMs: number
  /** Stop: how long to wait after closing stdin before the tree is killed (exec has no graceful step). */
  stopStdinMs: number
}

export const DEFAULT_MUSE_TIMING: MuseTiming = { exitAfterTerminalMs: 10_000, stopStdinMs: 1_000 }
