// Random-but-plausible event streams for the supervisor reducer (used by the fast-check invariants).
// Abstract actions are interpreted against the current state (pick the n-th live step, armed timer, outstanding
// request, open card …), so every generated stream is meaningful and shrinks well.
import fc from 'fast-check'
import { PASS_NAMES, STEP_KEYS } from '@shared/run.ts'
import type { AgentStep, AnswerVia } from '@shared/run.ts'
import type { FailureCategory, RetryStrategy } from '@shared/failure.ts'
import { initRunState, reduce } from '@core/supervisor/machine.ts'
import type {
  EngineEvent,
  EngineEventBody,
  PendingRequest,
  Reduction,
  RunConfig,
  RunState,
} from '@core/supervisor/types.ts'
import { PLAN_TEXT, T0, blockedReport, makeConfig, okReport } from './helpers.ts'

export type EvKind =
  | 'text'
  | 'toolStart'
  | 'toolEnd'
  | 'session'
  | 'ask'
  | 'done'
  | 'doneEmpty'
  | 'doneInsufficient'
  | 'fatalRetry'
  | 'fatalHard'
  | 'fatalUnknown'
  | 'fatalResume'
  | 'nonFatal'
export type SigKind = 'liveness' | 'withdraw' | 'allowRule' | 'autoAnswered' | 'planCaptured' | 'meta'

export type Act =
  /** Make progress like a well-behaved controller and user would (keeps streams reaching late states). */
  | { k: 'go'; alt: boolean }
  | { k: 'lock' }
  | { k: 'req'; i: number; ok: boolean; alt: boolean }
  | { k: 'timer'; i: number }
  | { k: 'ev'; i: number; e: EvKind; n: number; stale: boolean }
  | { k: 'sig'; i: number; s: SigKind; n: number }
  | { k: 'exit'; i: number; code: 0 | 1; classified: boolean }
  | { k: 'answer'; i: number; d: 'allow' | 'allow-session' | 'deny'; via: AnswerVia }
  | { k: 'undo'; i: number }
  | { k: 'card'; i: number; c: number; input: boolean }
  | { k: 'keep'; i: number }
  | { k: 'stop' }
  | { k: 'close' }
  | { k: 'resume'; late: boolean }
  | { k: 'retry'; i: number; s: number }
  | { k: 'skip'; i: number }
  | { k: 'power'; s: 'suspend' | 'resume' }
  | { k: 'relaunch' }
  | { k: 'quit' }
  | { k: 'tick'; ms: number }

const nat = fc.nat({ max: 7 })
export const act: fc.Arbitrary<Act> = fc.oneof(
  { weight: 25, arbitrary: fc.record({ k: fc.constant('go' as const), alt: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant<Act>({ k: 'lock' }) },
  {
    weight: 10,
    arbitrary: fc.record({ k: fc.constant('req' as const), i: nat, ok: fc.boolean(), alt: fc.boolean() }),
  },
  { weight: 6, arbitrary: fc.record({ k: fc.constant('timer' as const), i: nat }) },
  {
    weight: 12,
    arbitrary: fc.record({
      k: fc.constant('ev' as const),
      i: nat,
      e: fc.constantFrom<EvKind>(
        'text',
        'toolStart',
        'toolEnd',
        'session',
        'ask',
        'ask',
        'done',
        'done',
        'doneEmpty',
        'doneInsufficient',
        'fatalRetry',
        'fatalHard',
        'fatalUnknown',
        'fatalResume',
        'nonFatal',
      ),
      n: nat,
      stale: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('sig' as const),
      i: nat,
      s: fc.constantFrom<SigKind>(
        'liveness',
        'withdraw',
        'allowRule',
        'autoAnswered',
        'planCaptured',
        'meta',
      ),
      n: nat,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('exit' as const),
      i: nat,
      code: fc.constantFrom<0 | 1>(0, 1),
      classified: fc.boolean(),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant('answer' as const),
      i: nat,
      d: fc.constantFrom('allow' as const, 'allow-session' as const, 'deny' as const),
      via: fc.constantFrom<AnswerVia>('app', 'notification', 'cli'),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('undo' as const), i: nat }) },
  {
    weight: 5,
    arbitrary: fc.record({ k: fc.constant('card' as const), i: nat, c: nat, input: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('keep' as const), i: nat }) },
  { weight: 1, arbitrary: fc.constant<Act>({ k: 'stop' }) },
  { weight: 1, arbitrary: fc.constant<Act>({ k: 'close' }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('resume' as const), late: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('retry' as const), i: nat, s: nat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('skip' as const), i: nat }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('power' as const),
      s: fc.constantFrom('suspend' as const, 'resume' as const),
    }),
  },
  { weight: 1, arbitrary: fc.constant<Act>({ k: 'relaunch' }) },
  { weight: 1, arbitrary: fc.constant<Act>({ k: 'quit' }) },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('tick' as const),
      ms: fc.constantFrom(10, 1000, 3000, 60_000, 400_000),
    }),
  },
)

export const configArb: fc.Arbitrary<RunConfig> = fc
  .record({
    auto: fc.boolean(),
    afterPlan: fc.boolean(),
    denyPauses: fc.boolean(),
    native: fc.boolean(),
    planOff: fc.constantFrom(false, false, false, true),
    // Clarify before Plan (off, on, on and asking in Auto).
    clarify: fc.constantFrom<'off' | 'on' | 'inAuto'>('off', 'off', 'on', 'inAuto'),
  })
  .map(({ auto, afterPlan, denyPauses, native, planOff, clarify }) => {
    const c = makeConfig({
      auto,
      gates: { afterPlan: auto ? false : afterPlan, beforeFix: false },
      denyPauses,
      planMode: native ? 'native' : 'emulated',
    })
    c.passes.plan.enabled = !planOff
    if (clarify !== 'off') c.clarify = { questions: 3, inAuto: clarify === 'inAuto' }
    return c
  })

const FATAL: Record<'fatalRetry' | 'fatalHard' | 'fatalResume', FailureCategory> = {
  fatalRetry: 'network',
  fatalHard: 'auth_required',
  fatalResume: 'resume_failed',
}
const STRATEGIES: RetryStrategy[] = ['auto', 'resume', 'fresh', 'keep-changes', 'revert-then-fresh']

/**
 * The security scan's answers (a run whose config turns the advisor on): its check finds no audit, the scan nothing
 * (or, not `ok`, could not run: a note), a grant is written.
 */
export function scanAnswer(
  id: string,
  kind: 'scan-check' | 'scan' | 'scan-grant',
  ok: boolean,
): EngineEventBody {
  if (kind === 'scan-grant') return { t: 'trust-grant-result', req: id, ok }
  if (kind === 'scan-check') return { t: 'scan-check-result', req: id, audits: [], notes: [] }
  return {
    t: 'scan-result',
    req: id,
    secrets: [],
    audits: [],
    advisories: [],
    existing: 0,
    notes: [],
    findings: [],
    ...(ok ? {} : { failure: { category: 'unknown', message: 'x', raw: '', classifiedBy: 'app' } }),
  }
}

/** A findings-parse answer (the reviewers); `ok` carries one must finding. */
export function findingsResult(
  req: string,
  status: 'none' | 'ok' | 'empty' | 'failed',
): Extract<EngineEventBody, { t: 'findings-result' }> {
  const findings =
    status === 'ok' ? [{ id: `f-${req}`, severity: 'must' as const, title: 'A bug', body: 'details' }] : []
  return { t: 'findings-result', req, status, findings }
}

/**
 * Run-branch / revert requests (none of the generated streams makes one: branch prep is off and no revert is
 * asked for; answered for completeness): made / reverted nothing, or a git failure.
 */
function gitResult(req: string, kind: 'branch' | 'revert', ok: boolean): EngineEventBody {
  const failure = {
    category: 'git_state' as const,
    message: 'x',
    raw: '',
    classifiedBy: 'app' as const,
  }
  if (kind === 'branch') {
    return ok
      ? {
          t: 'branch-result',
          req,
          branch: { name: 'dim/20261005-task', base: 'c0', previous: 'refs/heads/main' },
        }
      : { t: 'branch-result', req, failure }
  }
  return ok
    ? { t: 'revert-result', req, outcome: { preRevert: `c${req}`, restored: [], deleted: [], skipped: [] } }
    : { t: 'revert-result', req, failure }
}

/**
 * Verify requests (the builds without verify keep Verify off, so their streams make none; the verify property test
 * turns it on): the trust check finds one command, trusted (or not: `alt`); a grant is written (or not); the round
 * passes, fails (a [must]) or could not run (`alt`: the environment).
 */
/**
 * Isolated runs' requests (the depsConsent grant, finalize's preview / apply / undo / remove). The property streams
 * run in place, so none is ever made; the driver still answers each shape (the switches stay exhaustive).
 */
export function isolationAnswer(
  req: string,
  r: Extract<PendingRequest, { kind: 'deps-grant' | 'finalize' }>,
  ok: boolean,
): EngineEventBody {
  if (r.kind === 'deps-grant') return { t: 'trust-grant-result', req, ok }
  switch (r.op) {
    case 'preview':
      return { t: 'finalize-preview', req, files: 0, conflicts: [] }
    case 'apply':
      return { t: 'apply-result', req, applied: [], conflicts: [] }
    case 'undo':
      return { t: 'undo-apply-result', req, ok }
    case 'remove':
      return { t: 'remove-result', req, ok }
  }
}

export function verifyAnswer(
  req: string,
  kind: 'verify-check' | 'trust-grant' | 'verify',
  ok: boolean,
  alt: boolean,
): EngineEventBody {
  switch (kind) {
    case 'verify-check':
      return {
        t: 'verify-check-result',
        req,
        commands: [
          {
            name: 'test',
            argv: ['npm', 'test'],
            cwdRel: '.',
            body: 'vitest',
            trust: alt ? 'untrusted' : 'trusted',
          },
        ],
      }
    case 'trust-grant':
      return { t: 'trust-grant-result', req, ok }
    case 'verify': {
      const status = ok ? 'pass' : alt ? 'env' : 'fail'
      return {
        t: 'verify-result',
        req,
        results: [
          {
            name: 'test',
            argv: ['npm', 'test'],
            status,
            exitCode: status === 'pass' ? 0 : status === 'env' ? 127 : 1,
            durationMs: 1000,
            excerpt: status === 'pass' ? '' : 'FAIL',
            logPath: '',
          },
        ],
        findings:
          status === 'fail'
            ? [{ id: `v-${req}`, severity: 'must', title: '`npm test` failed (exit 1, 1s)', body: 'FAIL' }]
            : [],
      }
    }
  }
}

const pick = <T>(xs: readonly T[], i: number): T | undefined =>
  xs.length === 0 ? undefined : xs[i % xs.length]

/** Turn an abstract action into a concrete engine event for the current state (or null when it does not apply). */
/** The steps the driver plays a vendor for: the configured passes, Clarify and the Deploy step. */
const DRIVEN: readonly AgentStep[] = [...PASS_NAMES, 'clarify', 'deploy']

/**
 * The Deploy step's planning answer (only a run whose config turns the step on asks): one file to write, nothing to
 * write (`alt`), or (not `ok`) a folder it could not read.
 */
export function deployPlanAnswer(req: string, ok: boolean, alt: boolean): EngineEventBody {
  if (!ok)
    return {
      t: 'deploy-plan-result',
      req,
      failure: { category: 'unknown', message: 'x', raw: '', classifiedBy: 'app' },
    }
  return {
    t: 'deploy-plan-result',
    req,
    plan: {
      cls: { id: 'server-app', label: 'Server app', confidence: 'high' },
      target: { id: 'fly', label: 'Fly.io' },
      files: alt ? [] : [{ kind: 'dockerfile', path: 'Dockerfile', purpose: 'builds an image' }],
      present: [],
      env: [],
      notes: [],
    },
  }
}

/** Clarify's answer with two questions (the driver's `alt` answers with none). */
const CLARIFY_QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Which one?', options: ['A', 'B'] },
    { question: 'How many?', options: ['One', 'Two'] },
  ],
})

export function interpret(
  s: RunState,
  now: number,
  a: Act,
): { body: EngineEventBody; at: number } | 'tick' | null {
  const live = DRIVEN.filter((k) => s.steps[k].proc?.live === true)
  const withProc = DRIVEN.filter((k) => s.steps[k].proc !== undefined)
  const asks = DRIVEN.flatMap((k) => s.steps[k].asks.map((q) => q.requestId))
  const at = now
  switch (a.k) {
    case 'go': {
      if (s.lock === 'requested') return { body: { t: 'lock-acquired' }, at }
      const id = Object.keys(s.requests).sort()[0]
      const r = id === undefined ? undefined : s.requests[id]
      if (id !== undefined && r !== undefined) {
        switch (r.kind) {
          case 'snapshot': {
            const tree = r.label === 'S1' && a.alt ? 'tree-b' : 'tree-a'
            return { body: { t: 'snapshot-done', req: id, commit: `c${id}`, tree }, at }
          }
          case 'preflight':
            return { body: { t: 'preflight-result', req: id, report: { ...okReport(), mode: r.mode } }, at }
          case 'reconcile':
            return { body: { t: 'reconcile-result', req: id, result: { verdict: 'clean' } }, at }
          case 'prepare':
            return { body: { t: 'prepare-result', req: id, ok: true }, at }
          case 'findings':
            return { body: findingsResult(id, a.alt ? 'none' : 'ok'), at }
          case 'branch':
          case 'revert':
            return { body: gitResult(id, r.kind, true), at }
          case 'verify-check':
          case 'trust-grant':
          case 'verify':
            return { body: verifyAnswer(id, r.kind, true, a.alt), at }
          case 'deps-grant':
          case 'finalize':
            return { body: isolationAnswer(id, r, true), at }
          case 'tests-check':
            return { body: { t: 'tests-check-result', req: id, findings: [] }, at }
          case 'grounding':
            return { body: { t: 'grounding-result', req: id, findings: [], notes: [] }, at }
          case 'scan-check':
          case 'scan':
          case 'scan-grant':
            return { body: scanAnswer(id, r.kind, true), at }
          case 'deploy-plan':
            return { body: deployPlanAnswer(id, true, a.alt), at }
        }
      }
      const card = s.cards[0]
      // Clarify's card: answer the first question (the second left to Plan), or skip them all.
      if (card?.view.kind === 'clarify') {
        const cmd: Extract<EngineEventBody, { t: 'user' }>['cmd'] = a.alt
          ? { kind: 'card', cardId: card.view.id, choiceId: 'skip' }
          : { kind: 'card', cardId: card.view.id, choiceId: 'answer', input: ['A', ''] }
        return { body: { t: 'user', cmd }, at }
      }
      if (card !== undefined) {
        const choice = card.view.choices.find((c) => c.primary) ?? card.view.choices[0]
        if (choice !== undefined) {
          return { body: { t: 'user', cmd: { kind: 'card', cardId: card.view.id, choiceId: choice.id } }, at }
        }
      }
      const askStep = DRIVEN.find((k) => s.steps[k].asks.length > 0)
      const ask = askStep === undefined ? undefined : s.steps[askStep].asks[0]
      if (askStep !== undefined && ask !== undefined) {
        if (ask.pendingDeny) {
          const id = `deny|${askStep}|${ask.requestId}`
          const due = s.timers[id]
          return due === undefined ? null : { body: { t: 'timer', id, due }, at: Math.max(now, due) }
        }
        return {
          body: {
            t: 'user',
            cmd: {
              kind: 'answer',
              requestId: ask.requestId,
              decision: a.alt ? 'deny' : 'allow',
              via: a.alt ? 'app' : 'cli',
            },
          },
          at,
        }
      }
      const step = DRIVEN.find((k) => s.steps[k].proc?.live === true)
      if (step !== undefined) {
        const p = s.steps[step].proc
        if (p === undefined) return null
        if (!p.terminal && s.steps[step].sessionId === undefined) {
          // Vendors report their session first.
          const ev = { type: 'session' as const, id: `sess-${step}-${p.spawnNo}` }
          return { body: { t: 'adapter', step, spawnNo: p.spawnNo, ev }, at }
        }
        if (!p.terminal) {
          const result = step === 'clarify' ? (a.alt ? '{"questions": []}' : CLARIFY_QUESTIONS) : PLAN_TEXT
          return { body: { t: 'adapter', step, spawnNo: p.spawnNo, ev: { type: 'done', result } }, at }
        }
        return { body: { t: 'exit', step, spawnNo: p.spawnNo, code: 0, signal: null, ranMs: 1000 }, at }
      }
      if (STEP_KEYS.some((k) => s.steps[k].status === 'paused')) {
        return { body: { t: 'user', cmd: { kind: 'resume' } }, at }
      }
      const failed = DRIVEN.find((k) => s.steps[k].status === 'failed')
      if (failed !== undefined) return { body: { t: 'user', cmd: { kind: 'retry', step: failed } }, at }
      return null
    }
    case 'lock':
      // Also stray grants (a grant racing an unlock) when the run is not queued.
      return { body: { t: 'lock-acquired' }, at }
    case 'req': {
      const ids = Object.keys(s.requests).sort()
      const id = pick(ids, a.i)
      if (id === undefined) return null
      const r = s.requests[id]
      if (r === undefined) return null
      switch (r.kind) {
        case 'snapshot':
          return a.ok
            ? {
                body: { t: 'snapshot-done', req: id, commit: `c${id}`, tree: a.alt ? 'tree-b' : 'tree-a' },
                at,
              }
            : {
                body: {
                  t: 'snapshot-failed',
                  req: id,
                  failure: { category: 'snapshot_failed', message: 'x', raw: '', classifiedBy: 'exit' },
                },
                at,
              }
        case 'preflight':
          return {
            body: {
              t: 'preflight-result',
              req: id,
              report:
                a.ok || a.alt ? { ...okReport(), mode: r.mode } : blockedReport({ category: 'git_missing' }),
            },
            at,
          }
        case 'reconcile':
          return {
            body: {
              t: 'reconcile-result',
              req: id,
              result: a.alt ? { verdict: 'info', notes: ['n'] } : { verdict: 'clean' },
            },
            at,
          }
        case 'prepare':
          return { body: { t: 'prepare-result', req: id, ok: a.ok }, at }
        case 'findings':
          return { body: findingsResult(id, a.ok ? (a.alt ? 'ok' : 'none') : a.alt ? 'empty' : 'failed'), at }
        case 'branch':
        case 'revert':
          return { body: gitResult(id, r.kind, a.ok), at }
        case 'verify-check':
        case 'trust-grant':
        case 'verify':
          return { body: verifyAnswer(id, r.kind, a.ok, a.alt), at }
        case 'deps-grant':
        case 'finalize':
          return { body: isolationAnswer(id, r, a.ok), at }
        case 'tests-check':
          return { body: { t: 'tests-check-result', req: id, findings: [] }, at }
        case 'grounding':
          return {
            body: a.ok
              ? { t: 'grounding-result', req: id, findings: [], notes: [] }
              : {
                  t: 'grounding-result',
                  req: id,
                  findings: [],
                  notes: [],
                  failure: { category: 'snapshot_failed', message: 'x', raw: '', classifiedBy: 'app' },
                },
            at,
          }
        case 'scan-check':
        case 'scan':
        case 'scan-grant':
          return { body: scanAnswer(id, r.kind, a.ok), at }
        case 'deploy-plan':
          return { body: deployPlanAnswer(id, a.ok, a.alt), at }
      }
      return null
    }
    case 'timer': {
      const ids = Object.keys(s.timers).sort()
      const id = pick(ids, a.i)
      if (id === undefined) return null
      const due = s.timers[id] as number
      return { body: { t: 'timer', id, due }, at: Math.max(now, due) }
    }
    case 'ev': {
      // Mostly the working process; `stale` also hits finished, exited and superseded ones.
      const working = live.filter((k) => s.steps[k].proc?.terminal === false)
      const step = pick(a.stale ? withProc : working, a.i)
      if (step === undefined) return null
      const p = s.steps[step].proc
      if (p === undefined) return null
      const spawnNo = a.stale ? Math.max(0, p.spawnNo - 1) : p.spawnNo
      const ev = ((): Extract<EngineEventBody, { t: 'adapter' }>['ev'] => {
        switch (a.e) {
          case 'text':
            return { type: 'text', delta: 'x' }
          case 'toolStart':
            return { type: 'tool', id: `t${a.n}`, name: 'Bash', summary: 's', phase: 'start' }
          case 'toolEnd':
            return { type: 'tool', id: `t${a.n}`, name: 'Bash', summary: 's', phase: 'end' }
          case 'session':
            return { type: 'session', id: `sess-${step}-${a.n}` }
          case 'ask':
            return {
              type: 'ask',
              requestId: `q${a.n}-${now}`,
              kind: 'shell',
              detail: 'cmd',
              expiresAt: now + 600_000,
              allowSession: a.n % 2 === 0,
            }
          case 'done':
            return { type: 'done', result: PLAN_TEXT, usage: { input: 1, output: 1 } }
          case 'doneEmpty':
            return { type: 'done', result: '' }
          case 'doneInsufficient':
            return { type: 'done', result: 'INSUFFICIENT_CONTEXT: more' }
          case 'fatalRetry':
          case 'fatalHard':
          case 'fatalResume':
            return { type: 'error', message: a.e, raw: '', fatal: true, category: FATAL[a.e] }
          case 'fatalUnknown':
            return { type: 'error', message: 'u', raw: '', fatal: true }
          case 'nonFatal':
            return { type: 'error', message: 'retrying', raw: '', fatal: false }
        }
      })()
      return { body: { t: 'adapter', step, spawnNo, ev }, at }
    }
    case 'sig': {
      const step = pick(live, a.i)
      if (step === undefined) return null
      const spawnNo = s.steps[step].proc?.spawnNo ?? 0
      const signal = ((): Extract<EngineEventBody, { t: 'signal' }>['signal'] => {
        switch (a.s) {
          case 'liveness':
            return { type: 'liveness' }
          case 'withdraw':
            return { type: 'ask-withdrawn', requestId: pick(s.steps[step].asks, a.n)?.requestId ?? 'none' }
          case 'allowRule':
            return {
              type: 'allow-rule',
              rule: {
                vendor: 'claude',
                kind: 'shell',
                tool: 'Bash',
                match: { argv: [`a${a.n}`] },
                source: 'exact',
              },
            }
          case 'autoAnswered':
            return {
              type: 'auto-answered',
              requestId: `x${a.n}`,
              decision: 'allow',
              tool: 'Read',
              why: 'readonly',
            }
          case 'planCaptured':
            return { type: 'plan-captured', markdown: a.n % 3 === 0 ? '' : PLAN_TEXT, source: 'exitPlanMode' }
          case 'meta':
            return { type: 'meta', key: a.n % 2 === 0 ? 'usageApprox' : 'resumeIgnored', value: true }
        }
      })()
      return { body: { t: 'signal', step, spawnNo, signal }, at }
    }
    case 'exit': {
      const step = pick(live, a.i)
      if (step === undefined) return null
      const p = s.steps[step].proc
      if (p === undefined) return null
      const body: Extract<EngineEventBody, { t: 'exit' }> = {
        t: 'exit',
        step,
        spawnNo: p.spawnNo,
        code: a.code,
        signal: null,
        ranMs: now - p.spawnedAt,
        cumulative: { input: 5, output: 5 },
      }
      if (a.classified)
        body.failure = { category: 'process_crash', message: 'c', raw: '', classifiedBy: 'exit' }
      return { body, at }
    }
    case 'answer': {
      const id = pick(asks, a.i)
      return id === undefined
        ? null
        : { body: { t: 'user', cmd: { kind: 'answer', requestId: id, decision: a.d, via: a.via } }, at }
    }
    case 'undo': {
      const id = pick(asks, a.i)
      return id === undefined ? null : { body: { t: 'user', cmd: { kind: 'undo-deny', requestId: id } }, at }
    }
    case 'card': {
      const c = pick(s.cards, a.i)
      if (c === undefined) return null
      const choice = pick(c.view.choices, a.c)
      if (choice === undefined) return null
      const cmd: Extract<EngineEventBody, { t: 'user' }>['cmd'] = {
        kind: 'card',
        cardId: c.view.id,
        choiceId: choice.id,
      }
      if (a.input && choice.input !== undefined) cmd.input = `${PLAN_TEXT}\nedited ${a.c}`
      return { body: { t: 'user', cmd }, at }
    }
    case 'keep': {
      const step = pick(DRIVEN, a.i) as AgentStep
      return { body: { t: 'user', cmd: { kind: 'keep-waiting', step } }, at }
    }
    case 'stop':
    case 'close':
      return { body: { t: 'user', cmd: { kind: a.k } }, at }
    case 'resume':
      return { body: { t: 'user', cmd: { kind: 'resume', allowTimedOutAsk: a.late } }, at }
    case 'retry': {
      const step = pick(DRIVEN, a.i) as AgentStep
      const strategy = pick(STRATEGIES, a.s) as RetryStrategy
      return { body: { t: 'user', cmd: { kind: 'retry', step, strategy } }, at }
    }
    case 'skip': {
      const step = pick(DRIVEN, a.i) as AgentStep
      return { body: { t: 'user', cmd: { kind: 'skip', step } }, at }
    }
    case 'power':
      return { body: { t: 'power', state: a.s }, at }
    case 'relaunch':
      return { body: { t: 'relaunch' }, at }
    case 'quit':
      return { body: { t: 'quit' }, at }
    case 'tick':
      return 'tick'
  }
}

export function newState(config: RunConfig): RunState {
  return initRunState({
    runId: 'r',
    displayNo: 1,
    folder: 'f',
    folderKey: 'k',
    task: 'task',
    profile: 'p',
    createdAt: T0,
    config,
  })
}

export interface Trace {
  events: EngineEvent[]
  final: RunState
  effects: unknown[]
}

export function drive(
  config: RunConfig,
  acts: readonly Act[],
  onStep?: (prev: RunState, e: EngineEvent, r: Reduction) => void,
): Trace {
  let s = newState(config)
  let now = T0
  const events: EngineEvent[] = []
  const effects: unknown[] = []
  const step = (e: EngineEvent): void => {
    const r = reduce(s, e)
    onStep?.(s, e, r)
    events.push(e)
    effects.push(...r.effects)
    s = r.state
  }
  step({ t: 'created', at: now })
  for (const a of acts) {
    const x = interpret(s, now, a)
    if (x === null) continue
    if (x === 'tick') {
      now += a.k === 'tick' ? a.ms : 0
      continue
    }
    now = x.at
    step({ ...x.body, at: x.at })
  }
  return { events, final: s, effects }
}
