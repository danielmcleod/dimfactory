// Following a live run from the CLI: card and ask policy, Ctrl+C (graceful stop, then a hard kill within 2 s),
// the exit code once the run settles, and the end-of-run footer with the run's closing summary.
import { readFileSync } from 'node:fs'
import type { ResultError } from '../shared/ipc.ts'
import type { PreflightReport } from '../shared/preflight.ts'
import { AGENT_STEPS } from '../shared/run.ts'
import type { CardView } from '../shared/run.ts'
import type { Core } from '../core/app-core.ts'
import { stepLabel } from '../core/supervisor/cards.ts'
import { anyLiveProc, closingMessage } from '../core/supervisor/derive.ts'
import type { CardState, RunState } from '../core/supervisor/types.ts'
import type { RunPolicy } from './args.ts'
import type { Interaction } from './cards.ts'
import { recoveryLine } from './hints.ts'
import type { HintContext } from './hints.ts'
import type { CliIo } from './io.ts'
import type { RunPrinter } from './render.ts'
import { footer } from './render.ts'
import { EXIT, cliName } from './session.ts'

/** `hints`: how to run the recovery actions from this terminal (config restore / trust, `--set`, file positions). */
export function printBlocked(io: CliIo, err: ResultError, hints?: HintContext): void {
  const report = err.details as PreflightReport | undefined
  io.err('Preflight blocked the run (nothing was started):')
  for (const c of report?.blocking ?? []) {
    io.err(`  x ${c.title}`)
    for (const d of c.detail.split('\n').filter((l) => l.trim() !== '')) io.err(`      ${d}`)
    for (const a of c.recovery) io.err(`      ${recoveryLine(a, hints)}`)
  }
  for (const c of report?.warnings ?? []) io.err(`  ! ${c.title}`)
  if (report === undefined) io.err(`  ${err.message}`)
}

/**
 * What to run to get past a card this CLI did not answer (non-TTY, --gates stop, --cards stop): the flag that
 * answers it, or a terminal to choose in.
 */
export function stoppedCardHint(card: CardView, runId: string, cli: string): string {
  const resume = `${cli} resume ${runId}`
  const head = `Waiting on "${card.title}".`
  if (card.kind === 'gate:afterPlan') {
    return `${head} Approve it with: ${resume} --gates approve (or run that in a terminal to read, edit or cancel).`
  }
  if (card.kind === 'gate:beforeFix') {
    return `${head} Let Fix address every finding with: ${resume} --gates approve (or run that in a terminal to choose which).`
  }
  const def =
    card.defaultChoice !== undefined ? card.choices.find((c) => c.id === card.defaultChoice) : undefined
  if (def !== undefined) {
    return `${head} Choose "${def.label}" with: ${resume} --cards default (or run that in a terminal to pick another choice).`
  }
  return `${head} Run ${resume} in a terminal to choose.`
}

/** Exit code for a settled run; undefined while the CLI should keep following it. */
function exitFor(
  core: Core,
  s: RunState,
  live: boolean,
  stoppedCards: ReadonlyMap<string, string>,
  hard: boolean,
  cli: string,
): { code: number; why?: string } | undefined {
  if (live) return undefined
  switch (s.status) {
    case 'completed':
      return { code: EXIT.completed }
    case 'cancelled':
      return { code: hard ? EXIT.hardInterrupt : EXIT.cancelled }
    case 'failed':
      return { code: EXIT.failed }
    case 'paused': {
      const timedOut = AGENT_STEPS.find(
        (p) => s.steps[p].status === 'paused' && s.steps[p].pause === 'ask-timeout',
      )
      return timedOut === undefined
        ? { code: EXIT.paused }
        : {
            code: EXIT.paused,
            why:
              `A question timed out. Continue with: ${cli} resume ${s.runId} ` +
              '(add --allow-timed-out to allow it first).',
          }
    }
    case 'waiting': {
      const card = s.cards.find((c) => stoppedCards.has(c.view.id))
      return card !== undefined
        ? { code: EXIT.paused, why: stoppedCards.get(card.view.id) ?? card.view.title }
        : undefined
    }
    case 'queued': {
      const b = core.scheduler.blockedBy(s.runId)
      if (b === undefined) return undefined
      const other = core.controller(b.runId)
      if (other !== undefined && (other.state.status === 'running' || other.state.status === 'queued'))
        return undefined
      const no = core.summary(b.runId)?.displayNo
      return {
        code: EXIT.paused,
        why:
          `Queued behind run ${no !== undefined ? `#${no} ` : ''}${b.runId}, which is not running in this process. ` +
          `Continue or cancel that run first (${cli} resume ${b.runId}).`,
      }
    }
    case 'running':
      return undefined
  }
}

/**
 * Ctrl+C presses caught before driveRun follows the run (while runs.start, first-launch setup or a resume is still in
 * flight). Without it a press in that window was lost (in-process) or killed the CLI outright (a process with no SIGINT
 * listener), leaving the run going. driveRun replays them, with when they happened, so the 2 s rule still holds.
 */
export class EarlyInterrupts {
  readonly #times: number[] = []
  readonly #off: () => void
  #taken = false

  constructor(io: CliIo, now: () => number = Date.now) {
    this.#off = io.onInterrupt(() => {
      this.#times.push(now())
    })
  }

  /** Stop catching presses; the ones caught so far, oldest first. */
  take(): number[] {
    if (!this.#taken) {
      this.#taken = true
      this.#off()
    }
    return this.#times.splice(0)
  }
}

/** Follow a live run until it settles; answers cards and asks per policy. Resolves with the exit code. */
export function driveRun(
  core: Core,
  runId: string,
  policy: RunPolicy,
  io: CliIo,
  printer: RunPrinter,
  interaction: Interaction,
  early?: EarlyInterrupts,
): Promise<number> {
  const c = core.controller(runId)
  if (c === undefined) return Promise.resolve(EXIT.failed)
  const cli = cliName(io)
  return new Promise<number>((done) => {
    let finished = false
    let hard = false
    let lastInterrupt = 0
    const handled = new Set<string>()
    const stoppedCards = new Map<string, string>()
    const aborts = new Map<string, AbortController>()

    const finish = (code: number, why?: string): void => {
      if (finished) return
      finished = true
      offInterrupt()
      unsubscribe()
      for (const ac of aborts.values()) ac.abort()
      printer.endLine()
      if (why !== undefined) printer.line(why)
      done(code)
    }

    const onPress = (now: number): void => {
      if (finished) return
      if (lastInterrupt > 0 && now - lastInterrupt <= 2000) {
        hard = true
        printer.line('Killing all vendor processes…')
        void core.killAll().finally(() => finish(EXIT.hardInterrupt))
        return
      }
      lastInterrupt = now
      printer.line('Stopping the run (press Ctrl+C again within 2 s to kill it)…')
      void core.invoke('runs.stop', { runId }).then((r) => {
        if (!r.ok) printer.line(`  ${r.error.message}`)
      })
    }
    const offInterrupt = io.onInterrupt(() => onPress(Date.now()))
    // Presses from before this point (the handler above is in place first, so none falls between the two).
    for (const at of early?.take() ?? []) onPress(at)

    const handleCard = (card: CardState): void => {
      const key = `card:${card.view.id}`
      handled.add(key)
      const ac = new AbortController()
      aborts.set(key, ac)
      void interaction.decideCard(card.view, ac.signal).then(async (o) => {
        aborts.delete(key)
        if (finished) return
        if (o.kind === 'stop') {
          stoppedCards.set(card.view.id, stoppedCardHint(card.view, runId, cli))
          check(c.state)
          return
        }
        if (o.kind !== 'choose') return
        const r = await core.invoke('cards.resolve', {
          runId,
          cardId: card.view.id,
          choiceId: o.choiceId,
          ...(o.input !== undefined ? { input: o.input } : {}),
        })
        if (!r.ok) printer.line(`  ${card.view.title}: ${r.error.message}`)
      })
    }

    const handleAsk = (step: string, requestId: string): void => {
      const key = `ask:${requestId}`
      handled.add(key)
      const ask = Object.values(c.state.steps)
        .flatMap((st) => st.asks)
        .find((a) => a.requestId === requestId)
      if (ask === undefined) return
      const ac = new AbortController()
      aborts.set(key, ac)
      void interaction.decideAsk(step, ask, core.clock.now, ac.signal).then(async (o) => {
        aborts.delete(key)
        if (finished || o.kind !== 'answer') return
        const r = await core.invoke('asks.answer', { runId, requestId, decision: o.decision })
        if (!r.ok) printer.line(`  ${r.error.message}`)
      })
    }

    const check = (s: RunState): void => {
      if (finished) return
      for (const [key, ac] of aborts) {
        const [kind, id] = key.split(/:(.*)/s)
        const open =
          kind === 'card'
            ? s.cards.some((x) => x.view.id === id)
            : AGENT_STEPS.some((p) =>
                s.steps[p].asks.some((a) => a.requestId === id && a.pendingDeny === undefined),
              )
        if (!open) {
          ac.abort()
          aborts.delete(key)
        }
      }
      for (const card of s.cards) if (!handled.has(`card:${card.view.id}`)) handleCard(card)
      for (const p of AGENT_STEPS) {
        for (const a of s.steps[p].asks) {
          if (a.pendingDeny === undefined && !handled.has(`ask:${a.requestId}`))
            handleAsk(stepLabel(p), a.requestId)
        }
      }
      const live = anyLiveProc(s) || c.liveProcs().length > 0
      const r = exitFor(core, s, live, stoppedCards, hard, cli)
      if (r !== undefined) finish(r.code, r.why)
    }

    const unsubscribe = c.subscribe((s) => check(s))
    check(c.state)
  })
}

export function printFooter(core: Core, runId: string, printer: RunPrinter, code?: number): void {
  const c = core.controller(runId)
  if (c === undefined) return
  printer.endLine()
  for (const l of footer(c.state, {
    runDir: core.paths.run(runId).dir,
    now: core.clock.now(),
    lastSeq: core.bus.lastSeq(runId) ?? 0,
  })) {
    printer.line(l)
  }
  // Explain it to me: the run's plain-language summary, printed whole at the end.
  const explain =
    c.state.outputs.explain !== undefined ? readExplain(core.paths.run(runId).output('explain')) : null
  if (explain !== null) {
    printer.line('')
    printer.line('Explain it to me (explain.md):')
    for (const l of explain.split('\n')) printer.line(`  ${l}`)
  } else if (c.state.status === 'completed') {
    // Without Explain, a completed run still ends with what the builder wrote for the person, never Fix's report lines.
    const said = closingMessage(c.state)
    if (said !== undefined) {
      printer.line('')
      printer.line('Summary:')
      for (const l of said.replace(/\r\n?/g, '\n').split('\n')) printer.line(`  ${l}`)
    }
  }
  // `pnpm cli` reports any non-zero exit as "Command failed"; 5 is not a failure.
  if (code === EXIT.paused) printer.line('Exit code 5: the run is waiting for you; nothing failed.')
}

/** explain.md's text (trimmed), or null when it cannot be read. */
function readExplain(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').trim()
    return t === '' ? null : t
  } catch {
    return null
  }
}
