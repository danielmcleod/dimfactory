// Recovery fixtures shaped as core builds them (recovery actions, the failure categories, self-heal):
// executor actions of every kind, a HealView per state, and a failed step with its `snag` event.
import type { Failure, HealView, RecoveryAction } from '@shared/failure.ts'
import type { RunEnvelope, StepView, WaitView } from '@shared/run.ts'
import { env } from '../helpers/fixtures.ts'
import { RUN, snapWith } from '../run/helpers.tsx'

export const T0 = new Date(2026, 9, 6, 15, 0, 0).getTime()

export const modelPatch: RecoveryAction = {
  id: 'implement.model-null',
  label: "Use Claude's default model",
  kind: 'config_patch',
  target: 'runOverrides',
  ops: [{ op: 'replace', path: '/passes/implement/model', value: null }],
  preview: '- "model": "opus-9"\n+ "model": null',
}
export const modelPatchSave: RecoveryAction = {
  ...modelPatch,
  id: 'implement.model-null.save',
  persist: { scope: 'project' },
}
export const flagPatch: RecoveryAction = {
  id: 'heal.flagmap',
  label: 'Map --output-format to --format',
  kind: 'config_patch',
  target: 'resolved',
  ops: [{ op: 'add', path: '/vendors/claude/flagMap/--output-format', value: '--format' }],
  preview: '',
}
export const flagPatchSave: RecoveryAction = {
  ...flagPatch,
  id: 'heal.flagmap.save',
  persist: { scope: 'user' },
}

export function waitAction(
  over: Partial<{ until: number; armed: boolean; id: string }> = {},
): RecoveryAction {
  return {
    id: over.id ?? 'implement.wait',
    label: 'Retry at 15:04',
    kind: 'wait_until',
    until: over.until ?? T0 + 4 * 60_000,
    armed: over.armed ?? true,
  }
}

export const switchCodex: RecoveryAction = {
  id: 'implement.switch',
  label: 'Use another vendor',
  kind: 'switch_vendor',
  pass: 'implement',
  to: 'codex',
  model: null,
}
export const grantCommand: RecoveryAction = {
  id: 'verify.trust',
  label: 'Trust this command',
  kind: 'grant',
  grant: 'command',
  detail: 'Runs the tests after Implement and Fix.',
  command: { kind: 'verify', argv: ['pnpm', 'test'], cwdRel: 'packages/app' },
}
export const grantLarge: RecoveryAction = {
  id: 'folder.large',
  label: 'Allow this large folder',
  kind: 'grant',
  grant: 'largeFolder',
  detail: '48,210 files (2.1 GB)',
}
export const grantVendorFolder: RecoveryAction = {
  id: 'gemini.trust',
  label: 'Trust this folder for Gemini',
  kind: 'grant',
  grant: 'vendorFolder',
  vendor: 'gemini',
  detail: 'Gemini runs here without asking about the folder.',
}
export const healAction: RecoveryAction = { id: 'implement.heal', label: 'Diagnose with AI', kind: 'heal' }
export const retryAction: RecoveryAction = { id: 'implement:retry', label: 'Retry', kind: 'retry' }
export const docsAction: RecoveryAction = {
  id: 'implement.docs',
  label: 'Claude docs',
  kind: 'open_docs',
  url: 'https://code.claude.com/docs/en/setup',
}
export const closeAction: RecoveryAction = { id: 'run:close', label: 'Close run', kind: 'close_run' }
export const loginAction: RecoveryAction = {
  id: 'implement.login',
  label: 'Copy login command',
  kind: 'shell_copy',
  command: 'claude auth login',
  shell: 'powershell',
  reason: 'Sign in to Claude in a terminal, then re-check.',
  recheck: 'vendor.claude.auth',
}

/** A HealView; `drop` leaves keys out (a failed or turned-off heal has no diagnosis). */
type OptionalHealKey = 'diagnosis' | 'confidence' | 'category' | 'error' | 'autoApplied'

export function heal(over: Partial<HealView> = {}, drop: readonly OptionalHealKey[] = []): HealView {
  const h: HealView = {
    status: 'ok',
    trigger: 'user',
    at: T0,
    diagnosis: 'The CLI renamed --output-format to --format in 2.4.',
    confidence: 'medium',
    category: 'flag_drift',
    actions: [flagPatch, flagPatchSave],
    hidden: 0,
    ...over,
  }
  for (const k of drop) delete h[k]
  return h
}

export function failure(over: Partial<Failure> = {}): Failure {
  return {
    category: 'unknown',
    message: 'Claude exited with code 3',
    raw: 'error: unexpected token in frame 12\n    at parse (cli.js:1:2)',
    classifiedBy: 'heuristic',
    step: 'implement',
    ...over,
  }
}

/** A failed Implement step as the snapshot has it. */
export function failedImplement(f: Failure, extra: { heal?: HealView; wait?: WaitView } = {}): StepView {
  const snap = snapWith({
    steps: {
      implement: {
        status: 'failed',
        attempt: 1,
        vendor: 'claude',
        model: 'opus',
        failure: f,
        reason: f.category,
        ...extra,
      },
    },
  })
  return snap.steps.implement
}

/** The step's `snag` event (core's recovery list). */
export function snagEvent(f: Failure, actions: RecoveryAction[], seq = 1): RunEnvelope {
  return env(RUN, seq, { t: 'snag', step: 'implement', failure: f, actions })
}
