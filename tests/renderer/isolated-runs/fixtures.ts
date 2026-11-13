// Isolated-run renderer fixtures (Cards): an isolated run's snapshot with core's
// prepare and finalize views (src/shared/run.ts PrepareView / FinalizeView), and the depsConsent, depsFailed,
// finalize, finalizeConflicts and interruptedApply cards as core builds them (src/core/supervisor/cards.ts).
import type {
  CardView,
  FinalizeView,
  PrepareStepView,
  PrepareView,
  RunSnapshot,
  RunSummary,
  StepKey,
  StepView,
} from '@shared/run.ts'
import { snapWith } from '../run/helpers.tsx'

export const FOLDER = 'C:\\work\\repo'

/** Core's five prepare rows, all queued (planned from the run's start). */
export function prepareRows(over: Partial<Record<PrepareStepView['id'], Partial<PrepareStepView>>> = {}) {
  const ids: PrepareStepView['id'][] = ['worktree', 'copy', 'deps', 'baseline', 'ready']
  return ids.map((id): PrepareStepView => ({ id, status: 'queued', ...over[id] }))
}

export function prepareView(over: Partial<PrepareView> = {}): PrepareView {
  return { steps: prepareRows(), ...over }
}

/** An isolated run's snapshot: summary isolation worktree, prepare with core's rows, the rest as given. */
export function isolatedSnap(
  o: {
    prepare?: Partial<StepView>
    finalize?: Partial<StepView>
    steps?: Partial<Record<StepKey, Partial<StepView>>>
    summary?: Partial<RunSummary>
    extra?: Partial<Omit<RunSnapshot, 'summary' | 'steps'>>
  } = {},
): RunSnapshot {
  return snapWith({
    summary: { isolation: 'worktree', folder: FOLDER, ...o.summary },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      prepare: { status: 'running', attempt: 1, prepare: prepareView(), ...o.prepare },
      ...(o.finalize !== undefined ? { finalize: o.finalize } : {}),
      ...o.steps,
    },
    ...(o.extra !== undefined ? { extra: o.extra } : {}),
  })
}

export function finalizeStep(view: FinalizeView, over: Partial<StepView> = {}): Partial<StepView> {
  return { status: 'waiting', attempt: 1, finalize: view, ...over }
}

// ---- cards (core supervisor/cards.ts) ------------------------------------------------------------------------------

export function depsConsentCard(over: { source?: 'detected' | 'config' | 'edited' } = {}): CardView {
  return {
    id: 'deps-1',
    kind: 'depsConsent',
    title: 'Install dependencies in the isolated copy?',
    body: 'The isolated copy starts without your installed dependencies. Dim Factory wants to run `pnpm install --frozen-lockfile` in the isolated copy (from pnpm-lock.yaml).\n\nInstall trusts it for this project and runs it. Skip install goes on without dependencies (checks that need them may not run).',
    payload: {
      step: 'prepare',
      command: 'pnpm install --frozen-lockfile',
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      manager: 'pnpm',
      cwdRel: '.',
      source: over.source ?? 'detected',
      configured: over.source === 'config',
      lockfile: 'pnpm-lock.yaml',
      trust: 'untrusted',
    },
    blocking: true,
    defaultChoice: 'skip-install',
    choices: [
      { id: 'install', label: 'Install', primary: true },
      { id: 'edit-command', label: 'Edit command', input: 'command' },
      { id: 'skip-install', label: 'Skip install' },
    ],
  }
}

export function depsFailedCard(over: { timedOut?: boolean; reason?: string } = {}): CardView {
  const payload: Record<string, unknown> = {
    step: 'prepare',
    command: 'pnpm install --frozen-lockfile',
    argv: ['pnpm', 'install', '--frozen-lockfile'],
    manager: 'pnpm',
    cwdRel: '.',
    source: 'detected',
    configured: false,
    lockfile: 'pnpm-lock.yaml',
    exitCode: over.timedOut === true ? null : 1,
    excerpt: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
  }
  if (over.timedOut === true) payload['timedOut'] = true
  if (over.reason !== undefined) payload['reason'] = over.reason
  const reasonPara = over.reason !== undefined ? `\n\n${over.reason}` : ''
  return {
    id: 'deps-2',
    kind: 'depsFailed',
    title: 'Installing dependencies failed',
    body: `Installing dependencies in the isolated copy failed (exit 1): \`pnpm install --frozen-lockfile\`.${reasonPara}\n\nRetry it, edit the command, or skip install to go on without dependencies (checks that need them may not run).`,
    payload,
    blocking: true,
    defaultChoice: 'skip-install',
    choices: [
      { id: 'retry', label: 'Retry', primary: true },
      { id: 'edit-command', label: 'Edit command', input: 'command' },
      { id: 'skip-install', label: 'Skip install' },
      { id: 'cancel', label: 'Cancel run', danger: true },
    ],
  }
}

export function finalizeCard(conflicts: { path: string; reason?: string }[] = []): CardView {
  const lines = [
    'The run worked in an isolated copy (branch dim/run-1) and changed 3 files there. They are not in your folder yet.',
  ]
  if (conflicts.length > 0)
    lines.push(
      '',
      `${conflicts.length} file also changed in your folder since the run started (${conflicts.map((c) => c.path).join(', ')}). Apply leaves it as it is and asks you about it.`,
    )
  lines.push(
    '',
    `Apply to folder copies the changes into ${FOLDER} (you can undo it). Keep for later leaves the isolated copy as it is. Discard deletes it in 10 seconds (you can undo that).`,
  )
  return {
    id: 'fin-1',
    kind: 'finalize',
    title: 'Apply the run to your folder?',
    body: lines.join('\n'),
    payload: { step: 'finalize', folder: FOLDER, conflicts, files: 3, branch: 'dim/run-1' },
    blocking: true,
    defaultChoice: 'keep',
    choices: [
      { id: 'apply', label: 'Apply to folder', primary: true },
      { id: 'keep', label: 'Keep for later' },
      { id: 'discard', label: 'Discard', danger: true },
    ],
  }
}

export function conflictsCard(files: { path: string; reason?: string }[]): CardView {
  const n = files.length
  return {
    id: 'conf-1',
    kind: 'finalizeConflicts',
    title:
      n === 1
        ? `${files[0]?.path ?? ''} changed in your folder too`
        : `${n} files changed in your folder too`,
    body: [
      `${n === 1 ? 'This file' : 'These files'} changed in your folder since the run started, so Apply left ${n === 1 ? 'it' : 'them'} as ${n === 1 ? 'it is' : 'they are'}:`,
      ...files.map((f) => `- ${f.path}${f.reason !== undefined ? ` (${f.reason})` : ''}`),
      '',
      "Keep mine leaves your version. Take run's writes the run's version over it (Undo of the apply puts yours back).",
    ].join('\n'),
    payload: { step: 'finalize', files, conflicts: files },
    blocking: true,
    choices: [
      { id: 'keep-mine', label: 'Keep mine', primary: true, input: 'paths' },
      { id: 'take-theirs', label: "Take run's", input: 'paths' },
    ],
  }
}

export function interruptedCard(): CardView {
  return {
    id: 'int-1',
    kind: 'interruptedApply',
    title: 'Finish applying the run',
    body: 'Dim Factory closed while it was applying the run to your folder, so some files may be written and others not yet.\n\nFinish apply carries on where it stopped (files already written are not written again). After it you can still undo the apply.',
    payload: { step: 'finalize', applied: 2, files: 5, remaining: 3 },
    blocking: true,
    choices: [{ id: 'finish-apply', label: 'Finish apply', primary: true }],
  }
}
