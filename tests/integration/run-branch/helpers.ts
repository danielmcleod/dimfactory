// Git run drivers (reconciliation, branch prep, revert to S0): a real core with the fake Claude
// (the session suite's World), plus git and card helpers. Every repo is a temp copy of the ts-small sandbox.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect } from 'vitest'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { CardView, RunSnapshot } from '../../../src/shared/run.ts'
import { stdinByScript } from '../run/scenario.ts'
import type { Started } from '../sessions/helpers.ts'
import { value } from '../sessions/helpers.ts'

export { World, settled, value, versionWrite, fixWrite } from '../sessions/helpers.ts'
export type { Started } from '../sessions/helpers.ts'

/** git in `cwd` with a fixed identity and no hooks; `ok: false` instead of a throw. */
export function gitTry(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  )
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export function gitOut(cwd: string, ...args: string[]): string {
  const r = gitTry(cwd, ...args)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.err}`)
  return r.out.trim()
}

export const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Every ask on any step is allowed, as a user would (C03's PowerShell ask). */
export function allowAsks(t: Pick<Started, 'c' | 'core'>): void {
  t.c.subscribe((s) => {
    for (const st of Object.values(s.steps)) {
      for (const a of st.asks) {
        void t.core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    }
  })
}

export function openCard(s: RunState, kind: CardView['kind']): CardView | undefined {
  return s.cards.find((c) => c.view.kind === kind)?.view
}

const finished = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

/** Wait for an open card of `kind` (fails fast when the run ends without one). */
export async function waitCard(c: RunController, kind: CardView['kind'], ms = 90_000): Promise<CardView> {
  const s = await c.waitFor((x) => openCard(x, kind) !== undefined || finished(x), ms)
  const card = openCard(s, kind)
  expect(card, `open ${kind} card (run is ${s.status}, notes: ${s.notes.join(' | ')})`).toBeDefined()
  return card as CardView
}

export async function choose(
  t: Pick<Started, 'core' | 'runId'>,
  card: CardView,
  choiceId: string,
  input?: string | string[],
): Promise<void> {
  value(
    await t.core.invoke('cards.resolve', {
      runId: t.runId,
      cardId: card.id,
      choiceId,
      ...(input !== undefined ? { input } : {}),
    }),
  )
}

export async function snapshotOf(t: Pick<Started, 'core' | 'runId'>): Promise<RunSnapshot> {
  return value(await t.core.invoke('runs.get', { runId: t.runId }))
}

/** The user message a fake script received (its first non-empty text). */
export function userMessage(t: Pick<Started, 'sc'>, script: string): string {
  const text = (line: string): string => {
    const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
    return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
  }
  return (stdinByScript(t.sc.entries()).get(script) ?? []).map(text).find((x) => x !== '') ?? ''
}

export const readText = (folder: string, rel: string): string => readFileSync(join(folder, rel), 'utf8')
