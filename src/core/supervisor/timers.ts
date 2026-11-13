// Inactivity timers, as pure functions over a StepState.
//
//   stallAt = idleBase + (inFlightTool ? toolStallMs : stallMs)
//   hardAt  = idleBase + hardKillMs + (inFlightTool ? toolStallMs : 0)
//   idleBase = max(lastEventAt, keepWaitingAt ?? 0)
//
// The timer rule reads `stallAt = lastEventAt + …`; "Keep waiting sets keepWaitingAt = now, which re-arms both
// timers" only
// holds if the stall deadline also counts from keepWaitingAt (otherwise it would fire again at once), so both
// deadlines share idleBase. Both are suspended while any ask of the step is pending (a pending deny included).
import type { Timeouts } from '../../shared/config-schema.ts'
import type { AnswerVia, StepKey } from '../../shared/run.ts'
import type { StepState } from './types.ts'

/** P9b/P10/P14/P18/P26: interrupt or cancel first, hard-kill after this. */
export const KILL_GRACE_MS = 3_000
/** After `done` the CLI should exit on its own; kill it if it lingers. */
export const EXIT_GRACE_MS = 5_000
/** Deny undo grace from the app (P9); notifications and the CLI use 0. */
export const DENY_GRACE_APP_MS = 3_000

export function defaultDenyGraceMs(via: AnswerVia): number {
  return via === 'app' ? DENY_GRACE_APP_MS : 0
}

/** `wait`: an armed wait_until retry of a failed pass. */
export type TimerKind = 'stall' | 'hard' | 'ask' | 'deny' | 'kill' | 'launch' | 'wait'

export interface ParsedTimer {
  kind: TimerKind
  step: StepKey
  /** ask / deny: the request id; kill: the spawnNo. */
  arg?: string
}

const SEP = '|'

export const timerId = {
  stall: (step: StepKey): string => `stall${SEP}${step}`,
  hard: (step: StepKey): string => `hard${SEP}${step}`,
  ask: (step: StepKey, requestId: string): string => `ask${SEP}${step}${SEP}${requestId}`,
  deny: (step: StepKey, requestId: string): string => `deny${SEP}${step}${SEP}${requestId}`,
  kill: (step: StepKey, spawnNo: number): string => `kill${SEP}${step}${SEP}${spawnNo}`,
  launch: (step: StepKey): string => `launch${SEP}${step}`,
  wait: (step: StepKey): string => `wait${SEP}${step}`,
}

const KINDS: readonly TimerKind[] = ['stall', 'hard', 'ask', 'deny', 'kill', 'launch', 'wait']

export function parseTimerId(id: string): ParsedTimer | null {
  const parts = id.split(SEP)
  const kind = parts[0] as TimerKind | undefined
  const step = parts[1] as StepKey | undefined
  if (kind === undefined || !KINDS.includes(kind) || step === undefined) return null
  const arg = parts.length > 2 ? parts.slice(2).join(SEP) : undefined
  return arg === undefined ? { kind, step } : { kind, step, arg }
}

type TimerInput = Pick<StepState, 'lastEventAt' | 'keepWaitingAt' | 'inFlightTools'>

/** max(lastEventAt, keepWaitingAt); undefined before the first spawn. */
export function idleBase(st: TimerInput): number | undefined {
  if (st.lastEventAt === undefined) return st.keepWaitingAt
  return Math.max(st.lastEventAt, st.keepWaitingAt ?? Number.NEGATIVE_INFINITY)
}

export function stallDeadline(st: TimerInput, t: Timeouts): number | undefined {
  const base = idleBase(st)
  if (base === undefined) return undefined
  return base + (st.inFlightTools.length > 0 ? t.toolStallMs : t.stallMs)
}

export function hardDeadline(st: TimerInput, t: Timeouts): number | undefined {
  const base = idleBase(st)
  if (base === undefined) return undefined
  return base + t.hardKillMs + (st.inFlightTools.length > 0 ? t.toolStallMs : 0)
}

/** Stall/hard timers are suspended while an ask is pending or a deny grace is open. */
export function timersSuspended(st: Pick<StepState, 'asks'>): boolean {
  return st.asks.length > 0
}

/** Whether the step should have stall/hard timers armed right now. */
export function inactivityTimersWanted(
  st: StepState,
  suspendedForPower: boolean,
): {
  stall: boolean
  hard: boolean
} {
  const procOk = st.proc !== undefined && st.proc.live && !st.proc.terminal
  const base = procOk && !suspendedForPower && !timersSuspended(st)
  return {
    stall: base && st.status === 'running',
    hard: base && (st.status === 'running' || st.status === 'stalled'),
  }
}

/** "5m", "90s", "1h 5m". */
export function formatIdle(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}
