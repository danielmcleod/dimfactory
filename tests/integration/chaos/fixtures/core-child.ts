// Chaos (kill at each effect boundary): the Dim Factory process the chaos suite kills. A
// real core (app host) on the given temp home starts one run on the fake Claude and drives it through the plan file's
// actions (cards, asks, Stop, recovery, diff.revert, the E2E clock), as a user would from the window. The suite sets
// DIM_FACTORY_E2E=1 and DIM_FACTORY_E2E_CHAOS_KILL=<point>[#n], so the core kills itself at that point (src/core/chaos.ts);
// a plan that never reaches it ends with DONE. Lines on stdout: `RUN <runId>`, `ACT <i> <what>`, `DONE`, `ERROR <why>`.
import { readFileSync } from 'node:fs'
import { createCore } from '../../../../src/core/app-core.ts'
import type { Core } from '../../../../src/core/app-core.ts'
import type { RunController } from '../../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import type { Cmd, Result } from '../../../../src/shared/ipc.ts'
import type { CardKind } from '../../../../src/shared/run.ts'

/** One step of the child's script. */
export type ChildAction =
  /** Wait for an open card of `card`'s kind, then resolve it with `choice` (and `input`). */
  | { card: CardKind; choice: string; input?: string | string[] }
  /** Wait for a pending ask, then answer the first one (asks.answer, as the window's Allow / Deny buttons do). */
  | { answer: 'allow' | 'allow-session' | 'deny' }
  /**
   * Wait until the run is `settled` (completed, cancelled, failed), a step failed with its snag, a card opens, or a pass
   * asks the user something (`ask`).
   */
  | { until: 'settled' | 'ask' | `failed:${string}` | `card:${CardKind}` }
  /** The machine goes to sleep or wakes (core.power, as main's powerMonitor drives it). */
  | { power: 'suspend' | 'resume' }
  /** core.invoke(cmd, {runId, ...req}). */
  | { invoke: Cmd; req?: Record<string, unknown> }
  /** recovery.execute for this run. */
  | { recovery: string }
  /** worktree.undoApply with the token of the run's last apply (StepView.finalize.undoToken). */
  | { undoApply: true }
  /** Move the E2E clock forward (DIM_FACTORY_E2E=1). */
  | { advance: number }
  | { sleep: number }

export interface ChildPlan {
  home: string
  folder: string
  task: string
  overrides: Record<string, unknown>
  actions: ChildAction[]
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

const WAIT_MS = 120_000

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

function value<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error.code} ${r.error.message}`)
  return r.value
}

async function invoke(core: Core, cmd: Cmd, req: unknown): Promise<unknown> {
  // A command named by the plan file: its request is checked by core's own schema.
  const r: Result<unknown> = await core.invoke(cmd as 'runs.get', req as never)
  return value(r, cmd)
}

async function act(core: Core, c: RunController, runId: string, a: ChildAction): Promise<string> {
  if ('card' in a) {
    const s = await c.waitFor((x) => x.cards.some((k) => k.view.kind === a.card) || settled(x), WAIT_MS)
    const card = s.cards.find((k) => k.view.kind === a.card)?.view
    if (card === undefined) throw new Error(`no ${a.card} card (run ${s.status})`)
    await invoke(core, 'cards.resolve', {
      runId,
      cardId: card.id,
      choiceId: a.choice,
      ...(a.input !== undefined ? { input: a.input } : {}),
    })
    return `${a.card} ${a.choice}`
  }
  if ('answer' in a) {
    const pending = (x: RunState) => Object.values(x.steps).flatMap((st) => st.asks)
    const s = await c.waitFor((x) => pending(x).length > 0 || settled(x), WAIT_MS)
    const ask = pending(s)[0]
    if (ask === undefined) throw new Error(`no ask (run ${s.status})`)
    await invoke(core, 'asks.answer', { runId, requestId: ask.requestId, decision: a.answer })
    return `answer ${a.answer}`
  }
  if ('until' in a) {
    const u = a.until
    let pred: (s: RunState) => boolean = settled
    if (u.startsWith('failed:')) {
      const step = u.slice('failed:'.length) as keyof RunState['steps']
      pred = (s) => (s.steps[step].status === 'failed' && s.steps[step].snagOpen) || settled(s)
    } else if (u === 'ask') {
      pred = (s) => Object.values(s.steps).some((st) => st.asks.length > 0) || settled(s)
    } else if (u.startsWith('card:')) {
      const kind = u.slice('card:'.length)
      pred = (s) => s.cards.some((k) => k.view.kind === kind) || settled(s)
    }
    const s = await c.waitFor(pred, WAIT_MS)
    // A pass asking is still running (its exit is in flight): only the other waits let the effects finish first.
    if (u !== 'ask') await c.settle(30_000)
    return `${u} (${s.status})`
  }
  if ('invoke' in a) {
    await invoke(core, a.invoke, { runId, ...a.req })
    return a.invoke
  }
  if ('recovery' in a) {
    await invoke(core, 'recovery.execute', { actionId: a.recovery, runId })
    return `recovery ${a.recovery}`
  }
  if ('undoApply' in a) {
    const snap = (await invoke(core, 'runs.get', { runId })) as {
      steps: Record<string, { finalize?: { undoToken?: string } }>
    }
    const undoToken = snap.steps['finalize']?.finalize?.undoToken
    if (undoToken === undefined) throw new Error('no apply to undo')
    await invoke(core, 'worktree.undoApply', { runId, undoToken })
    return 'undoApply'
  }
  if ('power' in a) {
    await core.power(a.power)
    return `power ${a.power}`
  }
  if ('advance' in a) {
    value(await core.advanceClock(a.advance), 'advanceClock')
    return `advance ${a.advance}`
  }
  await new Promise((r) => setTimeout(r, a.sleep))
  return `sleep ${a.sleep}`
}

async function main(): Promise<void> {
  const file = process.argv[2]
  if (file === undefined) throw new Error('usage: core-child <plan.json>')
  const plan = JSON.parse(readFileSync(file, 'utf8')) as ChildPlan
  const core = await createCore({ home: plan.home, host: { kind: 'app' }, env: process.env })
  const started = value(
    await core.invoke('runs.start', { folder: plan.folder, task: plan.task, overrides: plan.overrides }),
    'runs.start',
  )
  say(`RUN ${started.runId}`)
  const c = core.controller(started.runId)
  if (c === undefined) throw new Error('no controller')
  for (const [i, a] of plan.actions.entries()) say(`ACT ${i} ${await act(core, c, started.runId, a)}`)
  await c.settle(30_000)
  await core.shutdown()
  say('DONE')
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    say(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`.replace(/\n/g, ' | '))
    process.exit(2)
  },
)
