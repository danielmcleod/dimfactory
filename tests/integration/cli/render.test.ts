// The CLI's copy, pure: the footer headline with the app's outcome strings, the cost line (reported /
// estimated / API-equivalent), the hint for a card the CLI did not answer, the gate checklist's toggles and the
// command name the hints print.
import { describe, expect, it } from 'vitest'
import { gateFindings, parseToggles } from '../../../src/cli/cards.ts'
import { stoppedCardHint } from '../../../src/cli/drive.ts'
import { snapshotLines } from '../../../src/cli/commands/show.ts'
import { costLine, footer, headline } from '../../../src/cli/render.ts'
import { cliName } from '../../../src/cli/session.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import {
  beforeFixGateCard,
  emptyFindingsCard,
  afterPlanGateCard,
  stallCard,
} from '../../../src/core/supervisor/cards.ts'
import { toRunSnapshot } from '../../../src/core/supervisor/derive.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { NO_RUN_COST } from '../../../src/shared/cost-text.ts'
import type { Finding } from '../../../src/shared/findings.ts'

const T0 = 1_000_000

function run(over: (s: RunState) => void = () => undefined): RunState {
  const s = initRunState({
    runId: '20261005T000000Z-abcd',
    displayNo: 7,
    folder: 'C:/work/ts-small',
    folderKey: 'k',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: T0,
    config: runConfigFromResolved(resolveBuiltinConfig({ profile: 'claude-only' })),
  })
  s.started = true
  over(s)
  return s
}

const finding = (n: number, severity: 'must' | 'should', title = `t${n}`): Finding => ({
  id: `id${n}`,
  n,
  severity,
  source: 'review',
  title,
  body: '',
  flags: [],
  round: 1,
})

function withFindings(s: RunState, list: Finding[], selected = list.map((f) => f.id)): void {
  s.findings = { sources: {}, list, selected, notes: [] }
}

describe('footer headline (the outcome strings)', () => {
  const done = (
    outcome: NonNullable<RunState['outcome']>,
    more: (s: RunState) => void = () => undefined,
  ): RunState =>
    run((s) => {
      s.status = 'completed'
      s.phase = 'done'
      s.outcome = outcome
      s.endedAt = T0 + 125_000
      more(s)
    })

  it('Fixed · 2 must · 1 should', () => {
    const s = done('fixed', (x) =>
      withFindings(x, [finding(1, 'must'), finding(2, 'must'), finding(3, 'should')]),
    )
    expect(headline(s, 0)).toBe('Run #7 completed (Fixed) in 2m 05s · 2 must · 1 should')
  })

  it('Clean: no findings · No changes made · Completed with failures', () => {
    expect(headline(done('clean'), 0)).toBe('Run #7 completed (Clean) in 2m 05s · no findings')
    expect(headline(done('no-changes'), 0)).toBe('Run #7 completed (No changes made) in 2m 05s')
    expect(headline(done('verify-failed'), 0)).toBe('Run #7 completed (Completed with failures) in 2m 05s')
  })

  it('findings open says why Fix did not run', () => {
    const s = done('findings-open', (x) => {
      withFindings(x, [finding(1, 'should')], [])
      x.steps.fix.status = 'skipped'
      x.steps.fix.reason = 'no findings selected'
    })
    expect(headline(s, 0)).toBe(
      'Run #7 completed (Findings open) in 2m 05s · 0 must · 1 should · no findings were selected',
    )
  })

  it('Failed at <step> · <category title with the vendor name>; Cancelled at <step>', () => {
    const failed = run((s) => {
      s.status = 'failed'
      s.steps.critic.status = 'failed'
      s.steps.critic.vendor = 'claude'
      s.failure = { step: 'critic', category: 'auth_required' }
    })
    expect(headline(failed, T0 + 61_000)).toBe(
      'Run #7 failed in 1m 01s · Failed at Critic · Claude Code needs you to log in',
    )
    const cancelled = run((s) => {
      s.status = 'cancelled'
      s.stop = { at: T0, by: 'stop', snapshot: 'done' }
      s.endedAt = T0 + 3_000
      s.steps.review.status = 'cancelled'
      s.steps.review.attempt = 1
      s.steps.fix.status = 'cancelled'
    })
    expect(headline(cancelled, 0)).toBe('Run #7 cancelled in 3s · Cancelled at Review')
  })

  it('waiting / paused runs say so', () => {
    const waiting = run((s) => {
      s.status = 'waiting'
    })
    expect(headline(waiting, T0 + 9_000)).toBe('Run #7 waiting for you after 9s')
  })
})

describe('cost line', () => {
  const priced = (cost: NonNullable<RunState['steps']['plan']['cost']>, usd = 0.5): RunState =>
    run((s) => {
      s.steps.plan.usage = { input: 10, output: 5, costUsd: usd }
      s.steps.plan.cost = cost
    })

  it('vendor-reported, under a subscription', () => {
    expect(costLine(priced({ usd: 0.5, basis: 'vendor', apiEquivalent: true }))).toBe(
      'Cost: $0.50 (reported by the CLI; what the tokens would cost on the API, your subscription covers it)',
    )
    expect(costLine(priced({ usd: 0.5, basis: 'vendor', apiEquivalent: false }))).toBe(
      'Cost: $0.50 (reported by the CLI)',
    )
  })

  it('estimated from the price list (~), mixed, and none', () => {
    expect(costLine(priced({ usd: 0.123, basis: 'catalog', apiEquivalent: false }))).toBe(
      'Cost: ~$0.12 (estimated from the price list)',
    )
    const mixed = priced({ usd: 0.5, basis: 'vendor', apiEquivalent: false })
    mixed.steps.implement.usage = { input: 1, output: 1 }
    mixed.steps.implement.cost = { usd: 0.25, basis: 'catalog', apiEquivalent: false }
    expect(costLine(mixed)).toBe(
      'Cost: ~$0.75 (part reported by the CLI, part estimated from the price list)',
    )
    expect(costLine(priced({ usd: null, basis: 'none', apiEquivalent: false }))).toBe(
      'Cost: No price (the CLI reported none, and the models used are not in the price list)',
    )
  })

  it('without a figure, uses the app’s words for why (shared/cost-text.ts)', () => {
    // Usage reported but unpriced; nothing reported yet while the run goes on; nothing reported by its end.
    const unpriced = priced({ usd: null, basis: 'none', apiEquivalent: false })
    expect(costLine(unpriced)).toMatch(new RegExp(`^Cost: ${NO_RUN_COST.unpriced} \\(`))
    expect(costLine(run((s) => void (s.status = 'running')))).toBe(`Cost: ${NO_RUN_COST.pending}`)
    expect(costLine(run((s) => void (s.status = 'failed')))).toBe(`Cost: ${NO_RUN_COST.unreported}`)
    expect(NO_RUN_COST).toEqual({
      pending: 'No cost yet',
      unreported: 'No cost reported',
      unpriced: 'No price',
    })
  })

  it('`dimf show` words a run cost without a figure as the app does', () => {
    const progress = (s: RunState): string | undefined =>
      snapshotLines(toRunSnapshot(s, 0, T0), 'C:/runs/x').find((l) => l.startsWith('  Progress: '))
    expect(progress(run((s) => void (s.status = 'running')))).toBe(
      '  Progress: 0 tokens · No cost yet · 0 files changed',
    )
    expect(progress(run((s) => void (s.status = 'cancelled')))).toBe(
      '  Progress: 0 tokens · No cost reported · 0 files changed',
    )
    const unpriced = priced({ usd: null, basis: 'none', apiEquivalent: false })
    expect(progress(unpriced)).toBe('  Progress: 15 tokens · No price · 0 files changed')
    expect(progress(priced({ usd: 0.5, basis: 'vendor', apiEquivalent: false }))).toBe(
      '  Progress: 15 tokens · $0.50 · 0 files changed',
    )
  })

  it('the footer rows show reviewer reports and the Fix session line', () => {
    const s = run((x) => {
      x.status = 'completed'
      x.outcome = 'fixed'
      x.endedAt = T0 + 1000
      for (const k of ['review', 'critic', 'fix'] as const) {
        x.steps[k].status = 'done'
        x.steps[k].attempt = 1
        x.steps[k].vendor = 'claude'
        x.steps[k].model = k === 'fix' ? null : 'sonnet'
        x.steps[k].mode = k === 'fix' ? 'autoedit' : 'readonly'
      }
      x.steps.fix.sessionNote = 'reused the Implement session'
      x.steps.fix.result = 'F1 fixed\nF2 disputed: not a bug'
      withFindings(x, [finding(1, 'must'), finding(2, 'should')])
      if (x.findings !== undefined) {
        x.findings.sources = {
          review: { status: 'ok', attempt: 1, findings: [finding(1, 'must'), finding(2, 'should')] },
          critic: { status: 'none', attempt: 1, findings: [] },
        }
      }
    })
    const lines = footer(s, { runDir: 'C:/home/runs/x', now: T0 + 1000, lastSeq: 9 })
    expect(lines[0]).toBe('Run #7 completed (Fixed) in 1s · 1 must · 1 should')
    expect(lines).toContain('  Review     done      claude · sonnet · read-only · 0s · 1 must · 1 should')
    expect(lines).toContain('  Critic     done      claude · sonnet · read-only · 0s · no findings')
    expect(lines).toContain(
      '  Fix        done      claude · default model · edits files · 0s · reused the Implement session',
    )
    expect(lines).toContain('  Findings: 1 must · 1 should · Fix got 2 of 2 (F1 fixed · F2 disputed)')
  })
})

describe('cards the CLI did not answer', () => {
  it('says which flag answers them', () => {
    const id = 'r1'
    expect(stoppedCardHint(afterPlanGateCard('c1', 'plan'), id, 'pnpm cli')).toBe(
      'Waiting on "Review the plan". Approve it with: pnpm cli resume r1 --gates approve (or run that in a terminal to read, edit or cancel).',
    )
    expect(stoppedCardHint(beforeFixGateCard('c2', [finding(1, 'must')], ['id1']), id, 'dimf')).toBe(
      'Waiting on "1 finding before Fix: 1 must, 0 should". Let Fix address every finding with: dimf resume r1 --gates approve (or run that in a terminal to choose which).',
    )
    expect(stoppedCardHint(emptyFindingsCard('c3', 'critic'), id, 'dimf')).toBe(
      'Waiting on "Critic returned nothing". Choose "Treat as no findings" with: dimf resume r1 --cards default (or run that in a terminal to pick another choice).',
    )
    const noDefault = { ...stallCard('c4', 'implement', 300_000), blocking: true }
    expect(stoppedCardHint(noDefault, id, 'dimf')).toBe(
      'Waiting on "No output for 5m". Run dimf resume r1 in a terminal to choose.',
    )
  })

  it('the gate checklist reads the card payload and parses toggles', () => {
    const card = beforeFixGateCard(
      'c',
      [finding(1, 'must'), finding(2, 'should')],
      ['id1'],
      ['User edited x'],
    )
    expect(gateFindings(card)).toEqual({
      findings: [finding(1, 'must'), finding(2, 'should')],
      selected: ['id1'],
      notes: ['User edited x'],
    })
    expect(parseToggles('2 3')).toEqual([2, 3])
    expect(parseToggles('F2,f3')).toEqual([2, 3])
    expect(parseToggles('1-3')).toEqual([1, 2, 3])
    expect(parseToggles('x')).toBeNull()
    expect(parseToggles('1-9999')).toBeNull()
  })
})

describe('cliName', () => {
  it('names the command a user can paste', () => {
    expect(cliName({ env: { npm_lifecycle_event: 'cli' }, cwd: 'C:/repo' }, 'C:/repo/src/cli/dimf.ts')).toBe(
      'pnpm cli',
    )
    expect(cliName({ env: {}, cwd: '/repo' }, '/repo/src/cli/dimf.ts')).toBe(
      `node ${['src', 'cli', 'dimf.ts'].join(process.platform === 'win32' ? '\\' : '/')}`,
    )
    expect(cliName({ env: {}, cwd: '/repo' }, '/usr/lib/vitest.mjs')).toBe('dimf')
  })
})
