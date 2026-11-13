// The live balanced run, what it found, at the engine level: a real core, the fake Claude (C06's native plan writes its plan file with
// Write, as the live Claude 2.1.289 did) and an in-process Codex for Implement and Fix.
//   - the run never reads `queued` between Plan's end and the next step: the plan-end guard counts as Plan running
//   - Fix's live files-changed count is the run's (from S0): it read "0 files" while Fix ran, until Fix's first edit
//   - the Implement segment marks a file Fix changed later "changed by Fix", not "edited after the run"; a hand edit
//     after the run is still "edited after the run"; a file Implement deleted and Fix wrote again is "changed by Fix"
//   - the completed notification says its cost is an estimate when a Codex pass was priced from the catalog
//   - with shell allow-rules in the folder's Claude settings, the Plan, Review and Critic cards' mode copy says shell
//     commands are off (the live run's cards said "Reads and read-only commands" while the strip warned); a pass that
//     has started says what it ran with (its argv), whatever the folder's settings say later; one not started yet
//     follows the folder
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MODE_COPY,
  PLAN_NATIVE_COPY,
  PLAN_NATIVE_NO_SHELL_COPY,
  READONLY_NO_SHELL_COPY,
} from '../../../../src/core/adapters/claude/capabilities.ts'
import type { CoreNotification } from '../../../../src/core/app-core.ts'
import type { Usage } from '../../../../src/shared/events.ts'
import type { FileChange } from '../../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../../src/shared/run.ts'
import { REVIEW_WITH_FINDINGS } from '../../run/scenario.ts'
import { ScriptedCodex, World, settled, value } from './helpers.ts'
import type { CodexScript } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const SPEC = {
  plan: { recording: 'C06-plan-native-host' },
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}
const OVERRIDES = { profile: 'balanced', gates: { afterPlan: false } }
const IMPL_TOTAL: Usage = { input: 12_000, output: 1_500, cacheRead: 30_000 }
const FIX_TOTAL: Usage = { input: 19_000, output: 2_100, cacheRead: 52_000 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Implement writes src/version.ts; Fix waits (the live count polls meanwhile), then rewrites src/version.ts and adds
 * src/version.test.ts, and waits again before it ends.
 */
function codexScript(): CodexScript {
  return (h, o) => {
    void (async () => {
      const thread = o.resume?.sessionId ?? 'thr_live_balanced'
      h.thread = thread
      await o.onSession?.(thread)
      h.events.emit({ type: 'session', id: thread })
      if (o.step === 'implement') {
        writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
        await sleep(300)
      } else {
        await sleep(600)
        writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version: string = "0.1.0"\n')
        writeFileSync(join(o.cwd, 'src', 'version.test.ts'), 'import "./version.ts"\n')
        await sleep(600)
      }
      const total = o.step === 'implement' ? IMPL_TOTAL : FIX_TOTAL
      const prior = o.resume?.priorUsage
      h.total = total
      h.events.emit({
        type: 'done',
        result: o.step === 'implement' ? 'Added --version.' : 'Done.\n\nF1 fixed\nF2 fixed',
        usage:
          prior !== undefined
            ? {
                input: total.input - prior.input,
                output: total.output - prior.output,
                cacheRead: (total.cacheRead ?? 0) - (prior.cacheRead ?? 0),
              }
            : total,
      })
      h.exit(0)
    })()
  }
}

const bodiesOf = <T extends string>(events: readonly RunEnvelope[], t: T) =>
  events
    .filter((e) => e.body.t === t)
    .map((e) => ({ seq: e.seq, body: e.body as Extract<RunEnvelope['body'], { t: T }> }))

describe('the live balanced run’s findings (engine)', () => {
  it('no queued blip after Plan, the run’s files counted live during Fix, Changed by Fix, an estimated cost, shell-off copy', async () => {
    const notes: CoreNotification[] = []
    const codex = new ScriptedCodex(codexScript())
    const t = await w.boot(SPEC, codex, {
      core: {
        host: { kind: 'app', notify: (n) => notes.push(n) },
        livePollMs: { fast: 40, slow: 40 },
      },
    })
    // The folder's own Claude settings allow a shell command that can change files (shell is off for read-only passes).
    mkdirSync(join(t.folder, '.claude'))
    writeFileSync(
      join(t.folder, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm:*)'] } }),
    )
    const { runId, c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status, JSON.stringify(done.steps.fix.failure ?? done.failure ?? null)).toBe('completed')
    expect(done.steps.fix).toMatchObject({ status: 'done', vendor: 'codex', sessionId: 'thr_live_balanced' })
    const mine = t.events.filter((e) => e.runId === runId)

    // ---- the plan-end guard ran (C06's Write) and the run read planning, never queued, until it ended ----
    expect(done.steps.plan.writes?.length ?? 0).toBeGreaterThan(0)
    expect(done.snapshots['plan-end']).toBeDefined()
    const statuses = bodiesOf(mine, 'run-status').map((b) => `${b.body.status}/${b.body.phase}`)
    const firstRunning = statuses.findIndex((s) => s.startsWith('running/'))
    expect(firstRunning).toBeGreaterThanOrEqual(0)
    expect(
      statuses.slice(firstRunning).filter((s) => s.startsWith('queued/')),
      statuses.join(' '),
    ).toEqual([])

    // ---- the live count while Fix ran is the run's files (src/version.ts from Implement, then the test file) ----
    const fixStart = bodiesOf(mine, 'step-status').find(
      (b) => b.body.step === 'fix' && b.body.status === 'running',
    )?.seq
    const fixEnd = bodiesOf(mine, 'step-status').find(
      (b) => b.body.step === 'fix' && b.body.status === 'done',
    )?.seq
    expect(fixStart).toBeDefined()
    expect(fixEnd).toBeDefined()
    const stats = bodiesOf(mine, 'diff-stats')
    const duringFix = stats.filter((b) => b.seq > (fixStart ?? 0) && b.seq < (fixEnd ?? 0))
    expect(
      duringFix.map((b) => b.body.files),
      JSON.stringify(stats),
    ).not.toContain(0)
    expect(duringFix.filter((b) => b.body.live).map((b) => b.body.files)).toContain(2)
    const s1 = stats.filter((b) => b.seq < (fixStart ?? 0) && !b.body.live).at(-1)?.body
    expect(s1).toMatchObject({ files: 1, live: false })
    expect(stats.at(-1)?.body).toMatchObject({ files: 2, live: false })

    // ---- the Implement segment: Fix changed src/version.ts later in the run ----
    const implement = value(await t.core.invoke('diff.files', { runId, seg: 'implement' }))
    const row = (files: readonly FileChange[], p: string): FileChange | undefined =>
      files.find((f) => f.path === p)
    expect(row(implement.files, 'src/version.ts')).toMatchObject({
      editedAfterRun: false,
      changedByFix: true,
    })
    const fixSeg = value(await t.core.invoke('diff.files', { runId, seg: 'fix' }))
    expect(row(fixSeg.files, 'src/version.ts')?.changedByFix).toBeUndefined()
    expect(row(fixSeg.files, 'src/version.ts')?.editedAfterRun).toBe(false)
    // A hand edit after the run: edited after the run, and no longer what Fix left.
    writeFileSync(join(t.folder, 'src', 'version.ts'), 'export const version = "9.9.9"\n')
    const edited = value(await t.core.invoke('diff.files', { runId, seg: 'implement' }))
    expect(row(edited.files, 'src/version.ts')?.editedAfterRun).toBe(true)
    expect(row(edited.files, 'src/version.ts')?.changedByFix).toBeUndefined()
    expect(readFileSync(join(t.folder, 'src', 'version.ts'), 'utf8')).toContain('9.9.9')

    // ---- the cards' mode copy follows the shell check (the run's folder's settings), as the strip's warning does ----
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.review.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    expect(snap.steps.critic.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    expect(snap.steps.plan.modeCopy?.copy).toBe(PLAN_NATIVE_NO_SHELL_COPY)
    // The passes ran with the shell off: taking the rule out of the folder afterwards changes nothing on their cards.
    rmSync(join(t.folder, '.claude'), { recursive: true, force: true })
    const later = value(await t.core.invoke('runs.get', { runId }))
    expect(later.steps.review.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    expect(later.steps.plan.modeCopy?.copy).toBe(PLAN_NATIVE_NO_SHELL_COPY)

    // ---- the completed notification: Codex's catalog price makes the total an estimate ----
    const completed = notes.find((n) => n.kind === 'completed' && n.runId === runId)
    expect(completed?.completed).toMatchObject({ outcome: 'fixed', costEstimated: true })
    expect(completed?.completed?.costUsd ?? 0).toBeGreaterThan(0)
  }, 180_000)

  it('a started pass’s mode copy is what it ran with; a pass not started yet follows the folder’s settings', async () => {
    const t = await w.boot(SPEC, new ScriptedCodex(codexScript()))
    const { runId, c } = await w.start(t, { ...OVERRIDES, gates: { afterPlan: true } })
    const gated = await c.waitFor((s) => s.cards.some((k) => k.view.kind === 'gate:afterPlan'), 90_000)
    expect(gated.steps.plan.argv?.length ?? 0).toBeGreaterThan(0)
    // At the plan gate the folder gains a rule that allows a shell command that can change files (shell goes off).
    mkdirSync(join(t.folder, '.claude'))
    writeFileSync(
      join(t.folder, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm:*)'] } }),
    )
    const atGate = value(await t.core.invoke('runs.get', { runId }))
    // Plan ran with its shell: its card keeps saying so. Review has not started: it reads the folder as it is now.
    expect(atGate.steps.plan.modeCopy?.copy).toBe(PLAN_NATIVE_COPY)
    expect(atGate.steps.review.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    const gate = atGate.cards.find((k) => k.kind === 'gate:afterPlan')
    if (gate?.defaultChoice === undefined) throw new Error('no plan gate')
    value(await t.core.invoke('cards.resolve', { runId, cardId: gate.id, choiceId: gate.defaultChoice }))
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status, JSON.stringify(done.failure ?? null)).toBe('completed')
    // Review and Critic spawned with the shell off; the rule is then taken out again: the cards say what ran.
    rmSync(join(t.folder, '.claude'), { recursive: true, force: true })
    const after = value(await t.core.invoke('runs.get', { runId }))
    expect(after.steps.review.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    expect(after.steps.critic.modeCopy?.copy).toBe(READONLY_NO_SHELL_COPY)
    expect(after.steps.plan.modeCopy?.copy).toBe(PLAN_NATIVE_COPY)
    expect(MODE_COPY.readonly).not.toBe(READONLY_NO_SHELL_COPY)
  }, 180_000)

  it('a file Implement deleted and Fix wrote again reads "changed by Fix", not "edited after the run"', async () => {
    // Implement deletes src/index.test.ts (the sandbox's own file) and writes src/version.ts; Fix writes the test file
    // again with new content. Implement's row is a deletion; the folder holds Fix's file, so the row is Fix's doing.
    const TEST_FILE = 'src/index.test.ts'
    const script: CodexScript = (h, o) => {
      void (async () => {
        const thread = o.resume?.sessionId ?? 'thr_delete_readd'
        h.thread = thread
        await o.onSession?.(thread)
        h.events.emit({ type: 'session', id: thread })
        if (o.step === 'implement') {
          rmSync(join(o.cwd, ...TEST_FILE.split('/')))
          writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
        } else {
          writeFileSync(join(o.cwd, ...TEST_FILE.split('/')), 'import "./version.ts"\n// rewritten by Fix\n')
        }
        h.events.emit({ type: 'done', result: o.step === 'implement' ? 'Added --version.' : 'Done.' })
        h.exit(0)
      })()
    }
    // Deleting a test is the point of this script, not a rule it is meant to run into.
    const t = await w.boot(SPEC, new ScriptedCodex(script), { user: { guardrails: { preset: 'off' } } })
    const { runId, c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status, JSON.stringify(done.steps.fix.failure ?? done.failure ?? null)).toBe('completed')
    expect(existsSync(join(t.folder, ...TEST_FILE.split('/')))).toBe(true)

    const row = (files: readonly FileChange[], p: string): FileChange | undefined =>
      files.find((f) => f.path === p)
    const implement = value(await t.core.invoke('diff.files', { runId, seg: 'implement' }))
    expect(row(implement.files, TEST_FILE)).toMatchObject({
      status: 'D',
      editedAfterRun: false,
      changedByFix: true,
    })
    const fixSeg = value(await t.core.invoke('diff.files', { runId, seg: 'fix' }))
    expect(row(fixSeg.files, TEST_FILE)).toMatchObject({ status: 'A', editedAfterRun: false })
    // A hand edit after the run still reads as one.
    writeFileSync(join(t.folder, ...TEST_FILE.split('/')), '// edited by hand\n')
    const edited = value(await t.core.invoke('diff.files', { runId, seg: 'implement' }))
    expect(row(edited.files, TEST_FILE)?.editedAfterRun).toBe(true)
    expect(row(edited.files, TEST_FILE)?.changedByFix).toBeUndefined()
  }, 180_000)
})
