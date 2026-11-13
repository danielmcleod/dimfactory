// Effect executor helpers: the injectable clock, prompt rendering
// through prompts/template.ts (every pass: `{{diff}}` from the controller, `{{findings}}` through
// findings/render.ts, `{{verify}}` through src/core/verify), StartOptions for `adapter.start`, the redacted raw
// tee, snapshot failures, git facts for preflight `folder.git`, and the default snag buttons. The controller
// (controller.ts) sequences them.
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ResolvedConfig, ResolvedTemplate } from '../../shared/config-schema.ts'
import type { Failure, RecoveryAction } from '../../shared/failure.ts'
import { GAMES_CATEGORY } from '../../shared/brief.ts'
import { newUuid } from '../../shared/ids.ts'
import { redactLine } from '../../shared/redact.ts'
import type { AgentStep, StepKey } from '../../shared/run.ts'
import { isAgentStep } from '../../shared/run.ts'
import type { StepPromptName } from '../../shared/prompt-names.ts'
import { isKnownVendor, supportsEffort } from '../../shared/vendors.ts'
import {
  allowedFor,
  defaultExtensionLevel,
  passExtensionsPlan,
  runToolsNote,
} from '../../shared/extensions.ts'
import type { StartOptions, TapDir } from '../adapters/types.ts'

import { localPresetFor, presetForModel } from '../config/local-presets.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import { GitError, isDubiousOwnership, tryGit } from '../git/exec.ts'
import { detectRepo } from '../git/repo.ts'
import { VENDOR_DISPLAY_NAMES } from '../adapters/registry.ts'
import { LOGIN_REASON, fillTemplate } from '../heal/categories.ts'
import { commandFor, osFamily } from '../heal/commands.ts'
import type { FolderGitFacts, GitOperation } from '../preflight/checks/folder.ts'
import { renderFindings } from '../findings/render.ts'
import { CLARIFY_SCHEMA } from '../clarify/parse.ts'
import { renderAccess, renderLenses } from '../research/lenses.ts'
import { RESEARCH_SCHEMA } from '../research/parse.ts'
import { researchForPlan } from '../research/render.ts'
import { ACCEPTANCE_SCHEMA, renderCriteria } from '../acceptance/parse.ts'
import { renderChecklist } from '../explain/context.ts'
import type { ExplainInputs } from '../explain/context.ts'
import { acceptanceView } from './acceptance-view.ts'
import { builtinTemplatePath, renderPassPrompt } from '../prompts/resolve.ts'
import { renderVerifySection } from '../verify/index.ts'
import { displayArgv, tokenizeCommandLine } from '../verify/argv.ts'
import { defaultSnagActions } from './cards.ts'
import { closingMessage, selectedFindings } from './derive.ts'
import {
  CONTINUATION,
  configPassOf,
  isMutatingStep,
  recheckTargets,
  runBaseSnap,
  testFirstOn,
  verifyResultOf,
  verifyResultsFor,
} from './machine.ts'
import type { EffectOf, RunState, SnagInfo, SnapshotRef } from './types.ts'
import { envName } from '../../shared/brand.ts'
import { stateNote } from '../context/summary.ts'

// ---- clock ----------------------------------------------------------------------------------------------------

export type TimerHandle = ReturnType<typeof setTimeout>

/**
 * Time for the controller, the adapters and the bus. `setTimer(fn, at)` fires at clock time `at`. The reducer
 * never reads it: every event carries its own `at`.
 */
export interface Clock {
  now: () => number
  setTimer: (fn: () => void, at: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
  /** Real milliseconds per clock millisecond (1 normally; 1/scale under DIM_FACTORY_E2E_TIME_SCALE). */
  readonly scale: number
  /**
   * E2E only (`DIM_FACTORY_E2E=1`, `e2e.clock`): move the clock forward by `ms`. The timers then due fire in
   * order of their due time before it returns; the rest are re-armed against the new time. Returns the new now().
   */
  advance?: (ms: number) => number
}

/**
 * The longest delay a platform timer takes (2^31 − 1 ms, about 24.8 days); Node fires a longer one at once. A timer
 * due later fires early at this bound and its handler arms it again (a `wait_until` for a quota that resets in
 * 30 days; the reducer re-arms a wait that is not yet due).
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const timerDelay = (ms: number): number => Math.min(MAX_TIMER_DELAY_MS, Math.max(0, ms))

export function systemClock(): Clock {
  return {
    now: Date.now,
    setTimer: (fn, at) => setTimeout(fn, timerDelay(at - Date.now())),
    clearTimer: (h) => clearTimeout(h),
    scale: 1,
  }
}

/**
 * Compressed time for E2E and integration tests (DIM_FACTORY_E2E_TIME_SCALE): clock time runs
 * `scale` × faster than wall time, so a 10-minute ask timer fires after 6 s at scale 100. Schema minimums stay.
 */
export function scaledClock(scale: number, base: number = Date.now()): Clock {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const now = (): number => base + Math.round((Date.now() - base) * s)
  return {
    now,
    setTimer: (fn, at) => setTimeout(fn, timerDelay((at - now()) / s)),
    clearTimer: (h) => clearTimeout(h),
    scale: s,
  }
}

interface ClockEntry {
  fn: () => void
  at: number
  order: number
  /** The underlying timer; replaced when `advance` re-arms the entry. */
  inner: TimerHandle
}

const hasRef = (h: TimerHandle): boolean => (h as unknown as { hasRef?: () => boolean }).hasRef?.() ?? true

/**
 * A clock E2E tests can move forward (DIM_FACTORY_E2E_TIME_SCALE + e2e.clock compress time): `base`
 * plus an offset that only `advance` grows. A timer's handle stays valid across re-arms (clearTimer finds it).
 */
export function controllableClock(base: Clock = systemClock()): Clock & { advance: (ms: number) => number } {
  let offset = 0
  let order = 0
  const entries = new Map<TimerHandle, ClockEntry>()
  const now = (): number => base.now() + offset
  const fire = (key: TimerHandle): void => {
    const e = entries.get(key)
    if (e === undefined) return
    entries.delete(key)
    e.fn()
  }
  const setTimer = (fn: () => void, at: number): TimerHandle => {
    const key: TimerHandle = base.setTimer(() => fire(key), at - offset)
    entries.set(key, { fn, at, order: order++, inner: key })
    return key
  }
  const clearTimer = (h: TimerHandle): void => {
    const e = entries.get(h)
    entries.delete(h)
    base.clearTimer(e?.inner ?? h)
  }
  const advance = (ms: number): number => {
    if (Number.isFinite(ms) && ms > 0) offset += Math.round(ms)
    const t = now()
    const due: [TimerHandle, ClockEntry][] = []
    for (const [key, e] of [...entries]) {
      base.clearTimer(e.inner)
      if (e.at <= t) {
        due.push([key, e])
        continue
      }
      // An earlier due time against the moved clock; an unref'd timer stays unref'd.
      const inner = base.setTimer(() => fire(key), e.at - offset)
      if (!hasRef(key)) (inner as unknown as { unref?: () => void }).unref?.()
      e.inner = inner
    }
    due.sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)
    for (const [key] of due) fire(key)
    return t
  }
  return { now, setTimer, clearTimer, advance, scale: base.scale }
}

/**
 * `DIM_FACTORY_E2E_TIME_SCALE` is honoured only together with `DIM_FACTORY_E2E=1`, and only then can the clock be moved
 * (`advance`, the `e2e.clock` command).
 */
export function clockFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Clock {
  if (env[envName('E2E')] !== '1') return systemClock()
  const raw = env[envName('E2E_TIME_SCALE')]
  const n = raw === undefined || raw.trim() === '' ? 1 : Number(raw)
  return controllableClock(Number.isFinite(n) && n > 0 && n !== 1 ? scaledClock(n) : systemClock())
}

// ---- prompts ----------------------------------------------------------------------------------------------------

export interface BuiltPrompt {
  text: string
  /** Template warnings (missing required section appended, truncated value). */
  warnings: string[]
}

/** Values a prompt needs that come from I/O (the controller fetches them before `buildPrompt`). */
export interface PromptInputs {
  /**
   * `{{diff}}`: the prompt patch: S0..S1 for Review/Critic, S0..F0 ("changes made so far") for a
   * fresh Fix. Absent → the section renders empty.
   */
  diff?: string
  /** Test-first: the Tests step's template as resolved for the run's folder (default: the builtin tests.md). */
  testsTemplate?: Pick<ResolvedTemplate, 'path'>
  /**
   * The optional steps' templates as resolved for the run's folder when it was made (project → yours → built-in; a
   * template with errors resolved to the built-in): Clarify, Research, the acceptance review, Explain, Deploy and the
   * plain-words twins. A step without one renders its built-in template.
   */
  stepTemplates?: Partial<Record<StepPromptName, Pick<ResolvedTemplate, 'path'>>>
  /** Implement and Fix: `{{run}}`, the RUN.md request when the folder shows no way to run it (preview/run-hint.ts). */
  runHint?: string | null
  /** Explain: the files the run changed and how to run the result (explain/context.ts gatherExplainInputs). */
  explain?: ExplainInputs
  /** A fresh restart after compactions (LaunchPlan.restart): the paths the run changed so far, for `{{state}}`. */
  changedFiles?: string[]
}

/** `{{checks}}` (the Tests step): the enabled verify commands, one per line. */
export function checksText(config: ResolvedConfig): string {
  return config.verify.commands
    .filter((c) => c.enabled ?? true)
    .map((c) => {
      const parsed = Array.isArray(c.run) ? undefined : tokenizeCommandLine(c.run)
      const argv = Array.isArray(c.run) ? c.run : parsed?.ok === true ? parsed.argv : [c.run]
      return `- ${c.name}: \`${displayArgv(argv)}\`${c.cwd !== undefined ? ` (in ${c.cwd})` : ''}`
    })
    .join('\n')
}

/**
 * `{{tests}}` (Test-first; Implement, Review, Critic, Fix): the files the Tests step wrote, how the checks went before
 * Implement (the red check), and for the readers and Fix, Dim Factory's check that Implement left them whole. Empty
 * without Test-first or when the Tests step did not run.
 */
export function testsSection(state: RunState, step: AgentStep): string {
  if (!testFirstOn(state) || state.steps.tests.status !== 'done') return ''
  const files = state.testFirst?.files ?? []
  const lines: string[] = []
  lines.push(files.length > 0 ? 'Test files:' : 'The Tests step reported no changed files.')
  for (const f of files.slice(0, 50)) lines.push(`- ${f}`)
  if (files.length > 50) lines.push(`- and ${files.length - 50} more`)
  const red = (state.steps['verify:red'].verify?.commands ?? [])
    .map(verifyResultOf)
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
  const redText = renderVerifySection(red)
  if (redText !== '') lines.push('', 'The checks before Implement (the new tests should fail here):', redText)
  if (step !== 'implement') {
    const g = state.testFirst?.guard
    if (g === 'ok')
      lines.push('', 'Dim Factory compared the test files before and after Implement: none was weakened.')
    else if (g === 'weakened') {
      lines.push('', 'Dim Factory found test files weakened after Implement (each is a [must] finding):')
      for (const f of state.testFirst?.findings ?? []) lines.push(`- ${f.title}`)
    } else if (g === 'failed')
      lines.push('', 'Dim Factory could not compare the test files before and after Implement.')
  }
  return lines.join('\n')
}

/**
 * `{{scan}}` (the Security pass): what the security advisor's own scanners found, with every secret masked: the
 * secret scanner's hits, each audit's result, the advisories for dependencies the run added or changed, and how many
 * advisories were already there. Empty when the scan did not run.
 */
export function scanSection(state: RunState): string {
  const sc = state.security?.scan
  if (sc?.phase !== 'done') return ''
  const lines: string[] = []
  if (sc.secrets.length === 0) lines.push('Secret scanner: nothing found in the added lines.')
  else {
    lines.push('Secret scanner (values masked):')
    for (const h of sc.secrets.slice(0, 50))
      lines.push(`- [security:${h.level}] \`${h.file}:${h.line}\`: ${h.label} (${h.masked})`)
  }
  if (sc.audits.length === 0)
    lines.push('Dependency audits: none applied (the run changed no dependency files).')
  for (const a of sc.audits) {
    const what =
      a.status === 'done'
        ? `${a.introduced ?? 0} advisories for dependencies this run added or changed, ${a.existing ?? 0} already there`
        : `${a.status === 'env' ? 'could not run' : a.status === 'unreadable' ? 'output unreadable' : 'not run'}${a.reason !== undefined ? `: ${a.reason}` : ''}`
    lines.push(`- ${a.name}: ${what}`)
  }
  for (const v of sc.advisories.slice(0, 50)) {
    const at = v.version !== undefined ? `@${v.version}` : ''
    const fix = v.fixedIn !== undefined ? ` (fixed in ${v.fixedIn})` : ''
    lines.push(`- [security:${v.level}] ${v.package}${at}: ${v.id} ${v.title}${fix}`)
  }
  for (const n of sc.notes) lines.push(`Note: ${n}`)
  return lines.join('\n')
}

/** `{{security}}` (Fix): a line naming the security findings among those Fix was given; empty when there is none. */
export function securityFixLine(findings: readonly { source: string; level?: string }[]): string {
  const n = findings.filter(
    (f) => f.source === 'security' || f.source === 'scan' || f.level !== undefined,
  ).length
  return n === 0 ? '' : `${n === 1 ? 'one finding below is' : `${n} findings below are`} about security.`
}

/** Fix continues Implement's session (R10 decideSession): fix.md with `task`/`plan`/`diff` empty. */
export function fixReusesSession(spawn: Pick<EffectOf<'spawn'>, 'step' | 'launch'>): boolean {
  const { step, launch } = spawn
  return (
    step === 'fix' &&
    launch.session?.reuse === true &&
    launch.resume !== undefined &&
    launch.continuation === undefined
  )
}

/**
 * Continuity: Implement continues Plan's session. Its prompt is implement.md (or direct.md) rendered in full: the plan
 * as the gate decided it (the user may have edited it) and what Implement needs that Plan never saw.
 */
export function implementContinuesPlan(spawn: Pick<EffectOf<'spawn'>, 'step' | 'launch'>): boolean {
  const { step, launch } = spawn
  return (
    step === 'implement' &&
    launch.session?.reuse === true &&
    launch.resume !== undefined &&
    launch.continuation === undefined
  )
}

/** The range of `{{diff}}` for a spawn, or undefined when its prompt has no diff. */
export function promptDiffRange(
  state: RunState,
  spawn: Pick<EffectOf<'spawn'>, 'step' | 'launch'>,
): { from: SnapshotRef | undefined; to: SnapshotRef | undefined; label: string } | undefined {
  const { step, launch } = spawn
  if (launch.resume !== undefined) return undefined
  // The run's base: Implement's start, or the Tests step's (Test-first: the reviewers and Fix see the tests too).
  const s0 = runBaseSnap(state)
  // The acceptance review reads what the reviewers read: the run's changes up to Implement's end.
  if (step === 'review' || step === 'critic' || step === 'security' || step === 'acceptance') {
    return { from: s0, to: state.steps.implement.endSnap ?? state.snapshots.S1, label: 'S0..S1' }
  }
  // The security re-check reads what Fix changed.
  if (step === 'recheck') {
    return {
      from: state.steps.fix.startSnap ?? state.snapshots['fix-start'],
      to: state.steps.fix.endSnap ?? state.snapshots.S2,
      label: 'F0..S2',
    }
  }
  if (step === 'fix') {
    return { from: s0, to: state.steps.fix.startSnap ?? state.snapshots['fix-start'], label: 'S0..F0' }
  }
  return undefined
}

/**
 * The range Explain's `{{files}}` lists: the run's base to its latest end snapshot (the Deploy step's, Fix's or
 * Implement's), or undefined when either is missing.
 */
export function explainChangeRange(state: RunState): { from: string; to: string } | undefined {
  const from = runBaseSnap(state)
  const st = state.steps
  const to =
    st.deploy.endSnap ?? st.fix.endSnap ?? state.snapshots.S2 ?? st.implement.endSnap ?? state.snapshots.S1
  return from === undefined || to === undefined ? undefined : { from: from.commit, to: to.commit }
}

/** `{{diff}}` when a snapshot of the range is missing (its snapshot failed). */
export function missingDiffText(label: string): string {
  return (
    `(Dim Factory could not record the ${label} changes. Inspect the working tree yourself, e.g. with ` +
    '`git status` and `git diff`.)'
  )
}

/**
 * The built-in template Clarify renders when the run asks for plain questions (`passes.plan.clarifyPlain`): about the
 * outcome, in everyday words, never the technology. Same placeholders and answer shape as clarify.md.
 */
export const CLARIFY_PLAIN_TEMPLATE = 'clarify-easy' satisfies StepPromptName

/**
 * The built-in template Explain renders for a result that is not a program (`passes.plan.explainPlain`): "How to open
 * it" instead of "How to run it". Same placeholders as explain.md.
 */
export const EXPLAIN_PLAIN_TEMPLATE = 'explain-easy' satisfies StepPromptName

/** Implement's and Fix's note when the person who asked does not write code (a run that asks for plain words). */
export const PLAIN_PERSON_NOTE =
  'The person who asked does not write code. When it meets the need, prefer a result they can open without ' +
  'installing anything. Say plainly when something needs a server, an account or other setup, and write your ' +
  'closing summary for them in plain words.'

/**
 * Implement's and Fix's closing note, on every run and whatever the template: try the result where that is cheap and
 * safe, then end with a message about the whole job. That message is the run's last word to the person
 * (derive.ts closingMessage), so it says what a person needs to act on, not only what the last pass did.
 */
export const CLOSING_NOTE = [
  'Before you finish, try the result the way the person will use it, when that is cheap and safe: run it, or start ' +
    "it and request its pages, without opening windows or apps on the person's screen, and stop anything you " +
    'started. Make one real call when a key or account is already set up (never print a secret), and check data for ' +
    'outliers that would change the answer. Report what happened honestly, failures included.',
  '',
  'Your closing message is what the person reads. Write it in plain words about the whole job, not only your last change:',
  '- What you made or changed. For a bug: what was wrong and why, with before and after numbers when they matter.',
  '- How to open or run it, step by step.',
  '- What you checked and how, and what you could not check.',
  '- Anything surprising, and what it means for them (who was affected, what to check before relying on it).',
  '- What is left for them to do or decide. Never say nothing is left when something is.',
  'Name files by their path in the project (like `src/app.js`), never by an absolute path.',
].join('\n')

/** The run asks for plain words (Easy: `passes.plan.clarifyPlain`; read defensively, a hand-made config may lack it). */
function plainWordsRun(config: ResolvedConfig): boolean {
  const plan = (config.passes as Partial<ResolvedConfig['passes']> | undefined)?.plan as
    Partial<ResolvedConfig['passes']['plan']> | undefined
  return plan?.clarifyPlain === true
}

/** The template an optional step renders: its plain-words twin when the run asks for plain words. */
function stepPromptOf(
  step: 'clarify' | 'research' | 'deploy' | 'acceptance' | 'explain',
  state: RunState,
): StepPromptName {
  if (step === 'clarify' && state.config.clarify?.plain === true) return CLARIFY_PLAIN_TEMPLATE
  if (step === 'explain' && state.config.explainPlain === true) return EXPLAIN_PLAIN_TEMPLATE
  return step
}

/** The run's resolved template for an optional step (its override, when the run was made with one), else the built-in. */
function stepTemplate(name: StepPromptName, inputs: PromptInputs): Pick<ResolvedTemplate, 'path'> {
  return inputs.stepTemplates?.[name] ?? { path: builtinTemplatePath(name) }
}

/**
 * The stdin prompt for a spawn. A resumed session gets only the continuation (P19, a resume retry). A fresh pass renders
 * its resolved template: Plan gets `{{task}}`, Implement `{{task}}` + `{{plan}}` (the approved, possibly edited
 * plan; none when Plan was skipped or the user proceeded without one), Review/Critic `{{task}}`, `{{plan}}` and
 * `{{diff}}` (S0..S1), Fix `{{findings}}` (the selected findings, must first, after the `Notes:` list) plus
 * `{{task}}`, `{{plan}}` and `{{diff}}` when it starts fresh. Fix continuing Implement's session renders fix.md
 * with those three empty (the session already has them). Review, Critic and Fix get `{{verify}}`, verify:1's
 * results, whenever that round ran.
 */
export function buildPrompt(
  state: RunState,
  config: ResolvedConfig,
  spawn: Pick<EffectOf<'spawn'>, 'step' | 'launch'>,
  inputs: PromptInputs = {},
): BuiltPrompt {
  const { step, launch } = spawn
  const reuse = fixReusesSession(spawn)
  if (launch.resume !== undefined && !reuse && !implementContinuesPlan(spawn)) {
    return { text: launch.continuation ?? CONTINUATION.interrupted, warnings: [] }
  }
  // Every pass gets the project memory as the run read it (`{{memory}}`; none: the section drops out).
  const values: Record<string, string | null> = {
    task: state.task,
    brief: state.brief ?? null,
    memory: (state as Partial<RunState>).memory ?? null,
  }
  if (step !== 'plan') values['plan'] = state.plan.text
  if (step === 'tests') {
    const checks = checksText(config)
    values['checks'] = checks === '' ? null : checks
  } else if (step !== 'plan') {
    const tests = testsSection(state, step)
    values['tests'] = tests === '' ? null : tests
  }
  if (step === 'recheck') {
    values['diff'] = inputs.diff ?? null
    values['findings'] = renderFindings(recheckTargets(state))
    // The project's checks after this Fix (Fix until green's round, when verify ran).
    const verify = renderVerifySection(verifyResultsFor(state, step), state.isolation?.baseline)
    values['verify'] = verify === '' ? null : verify
    delete values['plan']
    delete values['brief']
    delete values['tests']
  }
  if (step === 'clarify') {
    values['questions'] = String(state.config.clarify?.questions ?? 1)
    delete values['plan']
    delete values['tests']
  }
  if (step === 'research') {
    const cfg = state.config.research
    values['lenses'] = renderLenses(cfg?.lenses ?? [])
    values['access'] = renderAccess(cfg?.web === true)
    delete values['plan']
    delete values['tests']
  }
  if (step === 'deploy') Object.assign(values, deployValues(state))
  // The plan's acceptance criteria: the Tests step maps tests to them, Implement builds to meet them, Fix sees them,
  // and the acceptance review checks them (with the tests mapped to each).
  if (step === 'tests' || step === 'implement' || step === 'fix' || step === 'acceptance')
    values['acceptance'] = criteriaText(state)
  if (step === 'acceptance') {
    values['diff'] = inputs.diff ?? null
    const verify = renderVerifySection(verifyResultsFor(state, step), state.isolation?.baseline)
    values['verify'] = verify === '' ? null : verify
  }
  if (step === 'explain') Object.assign(values, explainValues(state, inputs.explain))
  // Plan reads the research the user kept at the research card (none: the section drops out).
  if (step === 'plan') values['research'] = planResearchText(state)
  if (step === 'security') {
    const scan = scanSection(state)
    values['scan'] = scan === '' ? null : scan
  }
  // The Brief's pack's security focus (Games: no eval, kid-safe rules, no gambling...); none: the section drops out.
  if (step === 'security' || step === 'critic') {
    const focus = (state as Partial<RunState>).securityFocus
    values['focus'] = focus !== undefined && focus !== '' ? focus : null
  }
  if (step === 'review' || step === 'critic' || step === 'security' || step === 'fix') {
    values['diff'] = inputs.diff ?? null
    // The template rendering rules: the latest verify round before this pass (verify:1); empty without one, so
    // the template's {{#verify}} section drops out.
    // An isolated run's baseline marks a command that also failed before the run ("already failing
    // before this run").
    const verify = renderVerifySection(verifyResultsFor(state, step), state.isolation?.baseline)
    // What a guardrail refused rides with the checks Dim Factory ran, so a reviewer does not ask for it again.
    const refused = guardrailSection(state)
    const both = [verify, refused].filter((x) => x !== '').join('\n\n')
    values['verify'] = both === '' ? null : both
  }
  if (step === 'implement' || step === 'fix') {
    values['run'] = inputs.runHint ?? null
    // Context health's fresh restart after compactions: where the work stands (none: the section drops out).
    values['state'] =
      launch.restart !== undefined ? restartStateNote(state, step, launch.restart, inputs) : null
  }
  if (step === 'fix') {
    const selected = selectedFindings(state)
    const notes = [...(launch.notes ?? [])]
    for (const line of (state as Partial<RunState>).guardrails?.refused ?? [])
      if (!notes.includes(line)) notes.push(line)
    values['findings'] = renderFindings(selected, { notes })
    const security = securityFixLine(selected)
    values['security'] = security === '' ? null : security
    // What the person was told so far (Implement's closing words, or the last Fix round's summary): Fix's own summary
    // replaces it, so it covers the whole job and not only these fixes. A resumed session already has it.
    values['summary'] = closingMessage(state) ?? null
  }
  const planEnabled = state.plan.text !== null && state.plan.text.trim() !== ''
  const template =
    step === 'tests'
      ? (inputs.testsTemplate ?? { path: builtinTemplatePath('tests') })
      : step === 'recheck'
        ? { path: builtinTemplatePath(step) }
        : step === 'clarify' ||
            step === 'research' ||
            step === 'deploy' ||
            step === 'acceptance' ||
            step === 'explain'
          ? stepTemplate(stepPromptOf(step, state), inputs)
          : config.passes[step].promptTemplate
  const r = renderPassPrompt(step, template, values, {
    ...(step === 'implement' || step === 'tests' ? { planEnabled } : {}),
    ...(reuse ? { resumed: true } : {}),
  })
  let text = r.text
  // A template without `{{state}}` (a user's own) still gets the restart note, at its end.
  const stateValue = values['state']
  if (
    typeof stateValue === 'string' &&
    stateValue !== '' &&
    !text.includes(stateValue.split('\n')[0] ?? stateValue)
  )
    text = `${text.replace(/\n+$/, '')}\n\n${stateValue}\n`
  // The run's own Tools: a short note on the passes that have them (what they are, and never send secrets).
  const note = toolsNoteFor(state, config, step)
  if (note !== '') text = `${text.replace(/\n+$/, '')}\n\n${note}\n`
  // The passes that build end with a closing message about the whole job (the run's last word to the person).
  if (step === 'implement' || step === 'fix') text = `${text.replace(/\n+$/, '')}\n\n${CLOSING_NOTE}\n`
  // A run for someone who does not write code (Easy's plain words): the passes that build fit the result to them.
  if ((step === 'implement' || step === 'fix') && plainWordsRun(config))
    text = `${text.replace(/\n+$/, '')}\n\n${PLAIN_PERSON_NOTE}\n`
  if (launch.continuation !== undefined && launch.continuation !== '') {
    text = `${text.replace(/\n+$/, '')}\n\n${launch.continuation}\n`
  }
  return { text, warnings: r.warnings.map((w) => w.message) }
}

/** `{{state}}` for a fresh restart after compactions: the plan, the criteria, the files so far, Fix's findings. */
export function restartStateNote(
  state: RunState,
  step: 'implement' | 'fix',
  restart: { compactions: number },
  inputs: Pick<PromptInputs, 'changedFiles'>,
): string {
  const criteria = (state as Partial<RunState>).acceptance?.criteria ?? []
  return stateNote({
    step,
    why: 'restart',
    compactions: restart.compactions,
    plan: state.plan.text,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text })),
    files: inputs.changedFiles ?? [],
    ...(step === 'fix' ? { findings: selectedFindings(state).map((f) => `F${f.n} ${f.title}`) } : {}),
  })
}

/**
 * The prompt note for a step's run picks (Tools and Use skill), or '' when it has none: only the steps of the passes
 * that change files (Implement and Fix, and the Tests step on Implement's pass), at the level and vendor they run with.
 */
export function toolsNoteFor(
  state: RunState,
  config: ResolvedConfig,
  step: EffectOf<'spawn'>['step'],
): string {
  const tools = (config as Partial<ResolvedConfig>).tools
  if (tools === undefined) return ''
  if (step !== 'implement' && step !== 'fix' && step !== 'tests') return ''
  const pass = configPassOf(step, passesOf(state))
  const p = (config.passes as Partial<ResolvedConfig['passes']> | undefined)?.[pass]
  if (p === undefined) return ''
  return runToolsNote(
    passExtensionsPlan({
      pass,
      vendor: p.vendor,
      level: p.extensions ?? defaultExtensionLevel(pass),
      allowed: allowedFor(config.extensions, p.vendor),
      tools,
    }),
  )
}

/** `{{verify}}`'s guardrail part for the readers: what a guardrail refused or put back in this run, or '' for nothing. */
export function guardrailSection(state: RunState): string {
  const refused = (state as Partial<RunState>).guardrails?.refused ?? []
  return refused.length === 0 ? '' : ['Guardrails:', ...refused.map((l) => `- ${l}`)].join('\n')
}

/**
 * The Deploy step's values: `{{target}}`, `{{deliverable}}`, `{{files}}` (one line per file with what it is for) and
 * `{{env}}` (the variables the code reads), from its plan.
 */
export function deployValues(state: RunState): Record<string, string | null> {
  const p = (state as Partial<RunState>).deploy?.plan
  if (p === undefined) return { target: null, deliverable: null, files: null, env: null }
  return {
    target: p.target !== null ? `${p.target.label} (${p.target.id})` : null,
    deliverable: p.cls.label,
    files: p.files.map((f) => `- ${f.path}: ${f.purpose}`).join('\n'),
    env: p.env.length > 0 ? p.env.map((n) => `- ${n}`).join('\n') : null,
  }
}

/** `{{acceptance}}`: the decided plan's criteria (`- AC1: text`, with the tests mapped to each), or null without any. */
export function criteriaText(state: RunState): string | null {
  const a = (state as Partial<RunState>).acceptance
  if (a === undefined || a.criteria.length === 0) return null
  return renderCriteria(a.criteria, a.tests ?? {})
}

/**
 * Explain's values: `{{files}}` and `{{run}}` (gathered by the controller), `{{verify}}` (the run's last round),
 * `{{acceptance}}` (the checklist), `{{deploy}}` (the Deploy step's target and the files it wrote) and `{{play}}` (set for a game). The diff and the
 * Test-first section are left out: Explain speaks to someone who does not read code.
 */
export function explainValues(
  state: RunState,
  inputs: ExplainInputs | undefined,
): Record<string, string | null> {
  const verify = renderVerifySection(verifyResultsFor(state, 'explain'), state.isolation?.baseline)
  return {
    files: inputs?.files ?? null,
    run: inputs?.run ?? null,
    verify: verify === '' ? null : verify,
    acceptance: renderChecklist(acceptanceView(state)),
    deploy: deployTargetText(state),
    tests: null,
    // A game (the Brief's Games category): the summary also says how to play it.
    play: (state as Partial<RunState>).category === GAMES_CATEGORY ? 'yes' : null,
  }
}

/** `{{deploy}}` for Explain: the Deploy step's target and the config files it wrote, or null when it planned none. */
export function deployTargetText(state: RunState): string | null {
  const d = (state as Partial<RunState>).deploy
  const t = d?.plan?.target
  if (t === undefined || t === null) return null
  const written = d?.written ?? []
  return written.length > 0
    ? `${t.label}: Dim Factory wrote ${written.join(', ')} for it. Nothing was deployed.`
    : `${t.label}. Nothing was deployed.`
}

/** `{{research}}` for the Plan prompt: what was kept at the research card, or null without it. */
export function planResearchText(state: RunState): string | null {
  const r = (state as Partial<RunState>).research
  if (r?.status !== 'chosen' || r.result === undefined) return null
  const text = researchForPlan(r.result, r.chosen ?? [], r.answers ?? {})
  return text === '' ? null : text
}

export interface StartInput {
  runId: string
  cwd: string
  config: ResolvedConfig
  state: RunState
  spawn: EffectOf<'spawn'>
  prompt: string
  tap?: (dir: TapDir, line: string) => void
  /**
   * The vendor takes a session id from Dim Factory (`capabilities.preassignSessionId`: Claude `--session-id`).
   * false: the vendor assigns it (Codex thread/start, ACP session/new) and the adapter reports it through
   * `onSession` before the first turn, so no id is made up here. Default true.
   */
  preassignSessionId?: boolean
  /** `StartOptions.onSession` (the controller records the id and writes run.json, then answers whether it did). */
  onSession?: StartOptions['onSession']
  /**
   * Gemini launch: the user trusted the run's folder for this vendor (a trust.json `vendorFolder`
   * grant), so a vendor that asks for folder trust may skip its own (Gemini `--skip-trust`). Default false.
   */
  trustFolder?: boolean
  /** The run's private scratch folder (StartOptions.extensions.scratchDir: Claude's allowed MCP servers file). */
  scratchDir?: string
}

/**
 * StartOptions for `adapter.start`. Fresh mutating sessions get a pre-assigned id when the vendor
 * takes one (otherwise the adapter reports the vendor's id through `onSession`).
 */
/** The run's passes, read defensively (a hand-made state may leave its config out). */
function passesOf(state: RunState): RunState['config']['passes'] | undefined {
  return (state as Partial<RunState>).config?.passes
}

export function startOptionsFor(i: StartInput): StartOptions {
  const { spawn: e, config, state } = i
  const vendorCfg = config.vendors[e.vendor]
  const o: StartOptions = {
    runId: i.runId,
    // The Tests step runs exactly as Implement does (a mutating pass on Implement's config); Clarify as a read-only
    // Plan (never native); the re-check as the pass whose config it runs on.
    // Research is its own confined step (no edits, shell or agents; web search when the run may use it).
    step: e.step === 'research' ? 'research' : configPassOf(e.step, passesOf(state)),
    cwd: i.cwd,
    prompt: i.prompt,
    model: e.model,
    mode: e.mode,
    planNative: e.step === 'plan' && e.launch.planMode === 'native',
    allowRules: state.allowRules,
    trustFolder: i.trustFolder === true,
    askTimeoutMs: config.timeouts.askMs,
  }
  // Continuity: Plan keeps its session for Implement (a pre-assigned id where the vendor takes one, as an edit pass).
  const keep = e.step === 'plan' && e.launch.keepSession === true
  if (keep) o.keepSession = true
  if (e.launch.resume !== undefined) o.resume = e.launch.resume
  else if ((isMutatingStep(e.step) || keep) && i.preassignSessionId !== false) o.sessionId = newUuid()
  // Clarify answers in JSON: the vendor's structured output where its adapter has one (others ignore it, and the
  // answer's fenced JSON block is read instead).
  if (e.step === 'clarify') o.outputSchema = structuredClone(CLARIFY_SCHEMA)
  if (e.step === 'acceptance') o.outputSchema = structuredClone(ACCEPTANCE_SCHEMA)
  if (e.step === 'research') {
    o.outputSchema = structuredClone(RESEARCH_SCHEMA)
    // Web search on purpose (any host: research reads what it finds), or none: the repository lens only.
    o.web = (state as Partial<RunState>).config?.research?.web === true
  }
  // Only a vendor with an effort setting gets one (the others have none; preflight says so).
  if (e.effort !== undefined && supportsEffort(e.vendor)) {
    o.effort = e.effort
  }
  // The pass's Extensions level, and the vendor's allow list for the Allowed list level.
  // (Read defensively: a hand-made config may leave the pass or the section out.)
  const pass = configPassOf(e.step, passesOf(state))
  // Research is confined like the catalog refresh: none of the user's extensions, whatever the Plan pass allows. So are
  // the acceptance review and Explain (read-only, Extensions none).
  const level =
    e.step === 'research' || e.step === 'acceptance' || e.step === 'explain'
      ? 'none'
      : ((config.passes as Partial<ResolvedConfig['passes']> | undefined)?.[pass]?.extensions ??
        defaultExtensionLevel(pass))
  // The run's own Tools (the composer's picker and Use skill) on top of the Allowed list: added only to passes that
  // change files, never to a read-only one, and never a change of level (shared passExtensionsPlan).
  const plan = passExtensionsPlan({
    pass,
    vendor: e.vendor,
    level,
    allowed: allowedFor(config.extensions, e.vendor),
    tools: (config as Partial<ResolvedConfig>).tools,
  })
  o.extensions = {
    level: plan.level,
    mcp: plan.mcp,
    skills: plan.skills,
    ...(plan.mcpWithoutAsking.length > 0 ? { mcpWithoutAsking: plan.mcpWithoutAsking } : {}),
    ...(i.scratchDir !== undefined ? { scratchDir: i.scratchDir } : {}),
  }
  if (vendorCfg !== undefined) {
    if (vendorCfg.extraArgs.length > 0) o.extraArgs = [...vendorCfg.extraArgs]
    if (Object.keys(vendorCfg.flagMap).length > 0) o.flagMap = { ...vendorCfg.flagMap }
  }
  // A model the pass names is the one that runs (and the one readiness checked), not the preset's own.
  const local = localPresetFor(config, e.vendor)
  if (local !== undefined) o.local = presetForModel(local, e.model)
  if (i.tap !== undefined) o.tap = i.tap
  if (i.onSession !== undefined) o.onSession = i.onSession
  return o
}

/** The session id a spawn starts with (persisted before the first stdin write). */
export function presetSessionId(o: StartOptions): string | undefined {
  return o.resume?.sessionId ?? o.sessionId
}

// ---- raw tee ----------------------------------------------------------------------------------------------------

/**
 * `runs/<id>/raw/<step>-<spawnNo>.ndjson`: every vendor line, redacted (diagnostics mode: tokens, emails, home),
 * as `{t, dir, line}` with `t` = ms since the spawn. Writes are batched; failures are dropped (logs only).
 */
export class RawLog {
  readonly file: string
  readonly #start: number
  readonly #home: string
  #buf: string[] = []
  #timer: TimerHandle | undefined
  #chain: Promise<void>
  #closed = false

  constructor(file: string, start: number = Date.now(), home: string = homedir()) {
    this.file = file
    this.#start = start
    this.#home = home
    this.#chain = mkdir(dirname(file), { recursive: true }).then(
      () => undefined,
      () => undefined,
    )
  }

  write(dir: TapDir, line: string): void {
    if (this.#closed) return
    const redacted = redactLine(line, { mode: 'diagnostics', home: this.#home }).text
    this.#buf.push(`${JSON.stringify({ t: Date.now() - this.#start, dir, line: redacted })}\n`)
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        void this.flush()
      }, 100)
      this.#timer.unref()
    }
  }

  flush(): Promise<void> {
    if (this.#buf.length === 0) return this.#chain
    const data = this.#buf.join('')
    this.#buf = []
    this.#chain = this.#chain.then(() => appendFile(this.file, data).catch(() => undefined))
    return this.#chain
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    await this.flush()
    this.#closed = true
  }
}

/**
 * Write a rendered prompt next to the run (prompts/<step>-<spawnNo>.md), or a segment's patch (diffs/<seg>.patch).
 * Through a temp file and a rename, so a full drive or a kill part way never leaves half a patch for the
 * Diff tab to read once the snapshots are gone (no fsync: they are re-derivable while the shadow holds the commits).
 */
export async function writePromptFile(file: string, text: string): Promise<void> {
  await writeFileAtomic(file, text, { mode: 0o600, fsync: false })
}

// ---- failures -----------------------------------------------------------------------------------------------

export function snapshotFailure(err: unknown, step?: StepKey): Failure {
  const f: Failure =
    err instanceof GitError
      ? {
          category: err.category === 'unknown' ? 'snapshot_failed' : err.category,
          message: err.message,
          raw: err.stderr.slice(0, 4000),
          classifiedBy: 'app',
        }
      : {
          category: 'snapshot_failed',
          message: err instanceof Error ? err.message : String(err),
          raw: '',
          classifiedBy: 'app',
        }
  if (step !== undefined) f.step = step
  return f
}

/**
 * Default snag buttons: the default set (Resume · Retry · Continue without · Close run) plus the login
 * and "unset ANTHROPIC_API_KEY" commands for auth failures (the adapter's `failureHints` meta). heal/recovery.ts
 * replaces this with the category's own list.
 */
export function defaultRecoveryActions(
  vendorOf: (step: StepKey) => string | undefined,
  platform: NodeJS.Platform = process.platform,
): (step: StepKey, failure: Failure, info: SnagInfo) => RecoveryAction[] {
  return (step, failure, info) => {
    const base = defaultSnagActions(step, failure, info)
    const vendor = vendorOf(step)
    if (vendor === undefined || !isAgentStep(step)) return base
    const os = osFamily(platform)
    const extra: RecoveryAction[] = []
    const copy = (id: string, label: string, kind: 'login' | 'unsetApiKey', reason: string): void => {
      const cmd = commandFor(kind, vendor, os)
      if (cmd === null) return
      extra.push({
        id: `${step}:${id}`,
        label,
        kind: 'shell_copy',
        command: cmd.command,
        shell: cmd.shell,
        reason,
        recheck: `vendor.${vendor}.auth`,
        ...(cmd.elevated === true ? { elevated: true } : {}),
      })
    }
    if (failure.category === 'auth_required' || failure.category === 'auth_expired') {
      const name = isKnownVendor(vendor) ? VENDOR_DISPLAY_NAMES[vendor] : vendor
      copy('login', 'Copy login command', 'login', fillTemplate(LOGIN_REASON, { vendor: name }))
    }
    if (info.hints.includes('claude-env-key')) {
      copy(
        'unset-api-key',
        'Copy command to unset ANTHROPIC_API_KEY',
        'unsetApiKey',
        'An API key in the environment overrides your subscription in headless runs.',
      )
    }
    return [...extra, ...base]
  }
}

// ---- git facts (preflight folder.git) -------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Operation markers in `git status` order (as git/branch.ts reads them); `sequencer` names its first command. */
const OPERATION_MARKERS: readonly [string, GitOperation | 'sequencer'][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply/applying', 'am'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['sequencer/todo', 'sequencer'],
  ['BISECT_LOG', 'bisect'],
]

/**
 * `FolderGitFacts` for preflight `folder.git`: repo detection (repo.ts), then reads only (`--no-optional-locks`):
 * HEAD (unborn / detached / branch) and unmerged paths, three git processes at once (live preflight keeps its spawns
 * ≤ 4), then the operation markers (a multi-commit cherry-pick or revert between stops too) and index.lock in
 * the worktree's own git dir.
 */
export async function gitFactsFor(folder: string, o: { timeoutMs?: number } = {}): Promise<FolderGitFacts> {
  const repo = await detectRepo(folder)
  if (!repo.isRepo) return { isRepo: false }
  if (repo.dubiousOwnership) return { isRepo: true, dubiousOwnership: true }
  const cwd = repo.toplevel ?? repo.realFolder
  const common = {
    cwd,
    noOptionalLocks: true,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  }
  const [head, sym, unmerged] = await Promise.all([
    tryGit(['rev-parse', '--verify', '-q', 'HEAD'], common),
    tryGit(['symbolic-ref', '-q', '--short', 'HEAD'], common),
    tryGit(['ls-files', '-u', '-z'], common),
  ])
  const facts: FolderGitFacts = { isRepo: true }
  const stderr = [head, sym, unmerged].map((r) => (r.ok ? r.result.stderr : r.error.stderr)).join('\n')
  if (isDubiousOwnership(stderr)) return { isRepo: true, dubiousOwnership: true }
  facts.unbornHead = !head.ok
  facts.detachedHead = head.ok && !sym.ok
  facts.branch = sym.ok ? sym.result.stdout.trim() || null : null
  facts.unmergedPaths = unmerged.ok && unmerged.result.stdout.length > 0
  // `--absolute-git-dir` is the worktree's own git dir, where git keeps these per-worktree markers (what
  // `rev-parse --git-path` would name); no extra process, so the live check stays within its 2 s.
  const gitDir = repo.gitDir
  if (gitDir === undefined) return facts
  facts.indexLock = await exists(join(gitDir, 'index.lock'))
  facts.operation = null
  let bisect = false
  for (const marker of OPERATION_MARKERS) {
    const p = join(gitDir, marker[0])
    if (!(await exists(p))) continue
    const op = marker[1]
    if (op === 'bisect') {
      bisect = true
      continue
    }
    if (op === 'sequencer') {
      const todo = await readFile(p, 'utf8').catch(() => '')
      const first = todo.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#')) ?? ''
      facts.operation = /^\s*(?:revert|r)\s/.test(first) ? 'revert' : 'cherry-pick'
    } else facts.operation = op
    break
  }
  if (facts.operation === null && bisect) facts.operation = 'bisect'
  return facts
}

/** Narrow a step key to a step a vendor CLI runs (spawn effects only ever carry these). */
export function passOf(step: StepKey): AgentStep | undefined {
  return isAgentStep(step) ? step : undefined
}
