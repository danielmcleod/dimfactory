// The live balanced run's findings, unit level:
//   - Claude's tool lines read a file inside the pass folder relative to it (the live Plan, Review and Critic cards
//     showed "Read C:\Users\…\scratchpad\balanced\…", the file name cut off); an ask's detail keeps the path
//   - the shell-off warning names its pass (the composer's strip listed "Shell is disabled for this read-only pass"
//     three times)
//   - the mode copy follows the shell check: a read-only pass with shell off no longer says "read-only commands"; a
//     pass that has started says what it ran with (its argv), not what the folder's settings say now
//   - Plan's plan-end guard counts as Plan running: the run is running/planning, never queued, until the gate opens
//   - the completed notification says "est." when part of its cost is a catalog estimate, as the Run view does
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askDetail, summarizeTool } from '@core/adapters/claude/asks.ts'
import {
  MODE_COPY,
  PLAN_NATIVE_COPY,
  PLAN_NATIVE_NO_SHELL_COPY,
  READONLY_NO_SHELL_COPY,
} from '@core/adapters/claude/capabilities.ts'
import { createClaudeAdapter } from '@core/adapters/claude/index.ts'
import { applyFlagMap, argvDisallowsShell, buildArgv } from '@core/adapters/claude/launch.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { ClaudeNormalizer } from '@core/adapters/claude/normalize.ts'
import { relativeTo } from '@core/adapters/paths.ts'
import type { CoreNotification } from '@core/app-core.ts'
import { derivePhase, deriveStatus } from '@core/supervisor/derive.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { factsOf } from '../../../src/main/core-host.ts'
import { notificationText } from '../../../src/main/notifications-model.ts'
import { fakeRegistry, healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'
import { makeRun } from '../supervisor/helpers.ts'

const WIN_CWD = 'C:\\Users\\me\\scratch\\ts-small'

describe('Claude tool lines: paths inside the pass folder read relative', () => {
  it('summarizeTool with the pass folder', () => {
    expect(summarizeTool('Read', { file_path: `${WIN_CWD}\\src\\cli.ts` }, WIN_CWD)).toBe('src/cli.ts')
    // Windows compares the drive folder case-insensitively.
    expect(summarizeTool('Edit', { file_path: 'c:\\users\\me\\scratch\\ts-small\\src\\a.ts' }, WIN_CWD)).toBe(
      'src/a.ts',
    )
    expect(summarizeTool('Write', { file_path: '/home/me/proj/notes.md' }, '/home/me/proj')).toBe('notes.md')
    expect(summarizeTool('Grep', { pattern: 'greet', path: `${WIN_CWD}\\src` }, WIN_CWD)).toBe('greet in src')
    // Outside the folder (Claude's own plan file), a sibling with the same prefix, the folder itself: as given.
    const plan = 'C:\\Users\\me\\.claude\\plans\\wise-cascade.md'
    expect(summarizeTool('Write', { file_path: plan }, WIN_CWD)).toBe(plan)
    expect(summarizeTool('Read', { file_path: `${WIN_CWD}-old\\a.ts` }, WIN_CWD)).toBe(`${WIN_CWD}-old\\a.ts`)
    expect(summarizeTool('Glob', { pattern: '**/*', path: WIN_CWD }, WIN_CWD)).toBe(`**/* in ${WIN_CWD}`)
    // A command is never rewritten; no folder, no change (the ask detail's call).
    expect(summarizeTool('Bash', { command: `type ${WIN_CWD}\\a.ts` }, WIN_CWD)).toBe(`type ${WIN_CWD}\\a.ts`)
    expect(summarizeTool('Read', { file_path: `${WIN_CWD}\\src\\cli.ts` })).toBe(`${WIN_CWD}\\src\\cli.ts`)
    expect(relativeTo(`${WIN_CWD}\\src\\cli.ts`, WIN_CWD)).toBe('src/cli.ts')
  })

  it('the normalizer’s tool events use the pass folder; an ask keeps the full path', () => {
    const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000, now: () => 0, cwd: WIN_CWD })
    const step = n.line(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${WIN_CWD}\\src\\a.ts` } },
          ],
        },
      }),
    )
    expect(step.events).toMatchObject([{ type: 'tool', name: 'Read', summary: 'src/a.ts', phase: 'start' }])
    const detail = askDetail({
      subtype: 'can_use_tool',
      tool_name: 'Edit',
      input: { file_path: `${WIN_CWD}\\src\\a.ts` },
      tool_use_id: 'toolu_2',
    })
    expect(detail).toContain(`${WIN_CWD}\\src\\a.ts`)
  })
})

describe('the shell-off warning names its pass', () => {
  it('Plan, Review and Critic each say which pass they are; no em dash', async () => {
    const home = mkdtempSync(join(tmpdir(), 'live-bal-'))
    const cwd = mkdtempSync(join(tmpdir(), 'live-bal-cwd-'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm:*)'] } }),
    )
    const a = createClaudeAdapter({ env: {}, home })
    const titles: string[] = []
    for (const [pass, planNative] of [
      ['plan', true],
      ['review', false],
      ['critic', false],
    ] as const) {
      const checks = await a.readiness(cwd, { pass, mode: 'readonly', planNative, trustFolder: false })
      const warn = checks.find((c) => c.id === `pass.${pass}.readiness.claude-allow-rules`)
      expect(warn?.status).toBe('warn')
      titles.push(warn?.title ?? '')
    }
    expect(titles).toEqual([
      'Shell is disabled for Plan (read-only)',
      'Shell is disabled for Review (read-only)',
      'Shell is disabled for Critic (read-only)',
    ])
    expect(titles.join('')).not.toContain('—')
  })
})

describe('the mode copy follows the shell check (read-only tool cut)', () => {
  /** A Claude home whose settings allow a shell command that can change files (or none), and a folder. */
  const world = (rules: string[]): { home: string; cwd: string } => {
    const home = mkdtempSync(join(tmpdir(), 'live-bal-copy-'))
    const cwd = mkdtempSync(join(tmpdir(), 'live-bal-copy-cwd-'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: rules } }))
    return { home, cwd }
  }
  const need = (pass: 'plan' | 'review' | 'critic' | 'implement', cwd?: string) => ({
    pass,
    mode: pass === 'implement' ? ('autoedit' as const) : ('readonly' as const),
    planNative: pass === 'plan',
    trustFolder: false,
    ...(cwd !== undefined ? { cwd } : {}),
  })

  it('support(): shell off says "reads only" (and native Plan says so too); edits and no rules keep their copy', () => {
    const { home, cwd } = world(['Bash(npm:*)'])
    const a = createClaudeAdapter({ env: {}, home })
    expect(a.support(need('review', cwd))).toEqual({ status: 'supported', copy: READONLY_NO_SHELL_COPY })
    expect(a.support(need('critic', cwd)).copy).toBe(READONLY_NO_SHELL_COPY)
    expect(a.support(need('plan', cwd)).copy).toBe(PLAN_NATIVE_NO_SHELL_COPY)
    // An edit pass keeps its shell (the tool cut is for read-only passes); without a folder the copy cannot know.
    expect(a.support(need('implement', cwd)).copy).not.toContain('shell commands are off')
    expect(a.support(need('review')).copy).toBe(MODE_COPY.readonly)
    // A read-only pass of an edit step (readonly mode) is read-only too.
    expect(a.support({ ...need('implement', cwd), mode: 'readonly' }).copy).toBe(READONLY_NO_SHELL_COPY)
    // Only read-only rules: the commands stay, and so does the copy.
    const clean = world(['Bash(git status)'])
    const b = createClaudeAdapter({ env: {}, home: clean.home })
    expect(b.support(need('review', clean.cwd)).copy).toBe(MODE_COPY.readonly)
    expect(b.support(need('plan', clean.cwd)).copy).toBe(PLAN_NATIVE_COPY)
    // The folder's own settings count as well (settings.local.json in the project).
    mkdirSync(join(clean.cwd, '.claude'))
    writeFileSync(
      join(clean.cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['PowerShell'] } }),
    )
    expect(b.support(need('review', clean.cwd)).copy).toBe(READONLY_NO_SHELL_COPY)
    for (const copy of [READONLY_NO_SHELL_COPY, PLAN_NATIVE_NO_SHELL_COPY]) expect(copy).not.toContain('—')
  })

  it('a started pass says what it ran with (its argv), whatever the folder’s settings say now', () => {
    const argv = (route: 'plan' | 'readonly', disallowShell: boolean, flagMap?: Record<string, string>) => [
      'claude.exe',
      ...buildArgv({
        route,
        mode: 'readonly',
        step: route === 'plan' ? 'plan' : 'review',
        disallowShell,
        ...(flagMap !== undefined ? { flagMap } : {}),
      }),
    ]
    // The folder allows a shell command that can change files now; the pass ran with its shell on.
    const rules = world(['Bash(npm:*)'])
    const a = createClaudeAdapter({ env: {}, home: rules.home })
    expect(a.support({ ...need('review', rules.cwd), argv: argv('readonly', false) }).copy).toBe(
      MODE_COPY.readonly,
    )
    expect(a.support({ ...need('plan', rules.cwd), argv: argv('plan', false) }).copy).toBe(PLAN_NATIVE_COPY)
    // The folder has no such rule now; the pass ran with its shell off.
    const clean = world([])
    const b = createClaudeAdapter({ env: {}, home: clean.home })
    expect(b.support({ ...need('critic', clean.cwd), argv: argv('readonly', true) }).copy).toBe(
      READONLY_NO_SHELL_COPY,
    )
    expect(b.support({ ...need('plan'), argv: argv('plan', true) }).copy).toBe(PLAN_NATIVE_NO_SHELL_COPY)
    // An edit pass's copy never depends on it; the user's flagMap spelling of the flag is read too.
    expect(b.support({ ...need('implement'), argv: argv('readonly', true) }).copy).not.toContain(
      'shell commands',
    )
    const respelled = { '--disallowedTools': '--disallowed-tools' }
    const c = createClaudeAdapter({ env: {}, home: clean.home, flagMap: respelled })
    expect(c.support({ ...need('review'), argv: argv('readonly', true, respelled) }).copy).toBe(
      READONLY_NO_SHELL_COPY,
    )
  })

  it('argvDisallowsShell: Bash and PowerShell in --disallowedTools, in any spelling or form', () => {
    expect(argvDisallowsShell(['-p', '--disallowedTools', 'Edit,Write,Bash,PowerShell'])).toBe(true)
    expect(argvDisallowsShell(['--disallowedTools=AskUserQuestion,Bash,PowerShell'])).toBe(true)
    expect(argvDisallowsShell(['--disallowed-tools', 'Bash, PowerShell'])).toBe(true)
    expect(argvDisallowsShell(['--disallowedTools', 'Edit,Write,AskUserQuestion'])).toBe(false)
    expect(argvDisallowsShell(['--allowedTools', 'Bash,PowerShell'])).toBe(false)
    expect(argvDisallowsShell(['--disallowedTools'])).toBe(false)
    const mapped = applyFlagMap(['--disallowedTools', 'Bash,PowerShell'], {
      '--disallowedTools': '--deny-tools',
    })
    expect(argvDisallowsShell(mapped)).toBe(false)
    expect(argvDisallowsShell(mapped, { '--disallowedTools': '--deny-tools' })).toBe(true)
  })

  it('readiness() and the composer’s pass.<p>.mode check read the folder', async () => {
    const { home, cwd } = world(['Bash(npm:*)'])
    const claude = createClaudeAdapter({ env: { PATH: '' }, home })
    const checks = await claude.readiness(cwd, need('review'))
    expect(checks.find((c) => c.id === 'pass.review.readiness.mode')?.detail).toBe(READONLY_NO_SHELL_COPY)
    const engine = createPreflightEngine(healthyDeps({ home, adapters: fakeRegistry(claude) }))
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    const r = await engine.run('live', {
      folder: cwd,
      config: resolveBuiltinConfig({ profile: 'claude-only' }),
    })
    const all = [...r.blocking, ...r.warnings, ...r.info]
    expect(all.find((c) => c.id === 'pass.review.mode')).toMatchObject({
      status: 'pass',
      detail: READONLY_NO_SHELL_COPY,
    })
    expect(all.find((c) => c.id === 'pass.critic.mode')?.detail).toBe(READONLY_NO_SHELL_COPY)
    expect(all.find((c) => c.id === 'pass.plan.mode')?.detail).toBe(PLAN_NATIVE_NO_SHELL_COPY)
    expect(all.find((c) => c.id === 'pass.implement.mode')?.detail).not.toContain('shell commands are off')
  })
})

describe('the plan-end guard counts as Plan running', () => {
  const afterPlan = (planEnd: NonNullable<RunState['flow']['planEnd']>): RunState => {
    const s = makeRun()
    s.started = true
    s.steps.preflight.status = 'done'
    s.steps.plan.status = 'done'
    s.flow.planEnd = planEnd
    return s
  }

  it.each(['wait', 'requested', 'reverting'] as const)('%s → running / planning', (p) => {
    const s = afterPlan(p)
    expect(deriveStatus(s)).toBe('running')
    expect(derivePhase(s)).toBe('planning')
  })

  it('done or a planMutated card: as before (queued without a card; the card needs attention)', () => {
    expect(deriveStatus(afterPlan('done'))).toBe('queued')
    expect(derivePhase(afterPlan('done'))).toBe('queued')
    const card = afterPlan('card')
    expect(deriveStatus(card)).toBe('queued')
  })
})

describe('the completed notification words an estimated cost as the Run view does', () => {
  it('"$0.41 est." when costEstimated; "$0.41" otherwise', () => {
    const base = { kind: 'completed' as const, runId: 'r', folder: 'ts-small', title: 'add a --version flag' }
    const o = { now: 0, actions: true }
    expect(
      notificationText(
        { ...base, outcome: 'fixed', durationMs: 168_800, costUsd: 0.4075, costEstimated: true },
        o,
      ).title,
    ).toBe('Completed · Fixed · 3 min · $0.41 est.')
    expect(
      notificationText({ ...base, outcome: 'fixed', durationMs: 168_800, costUsd: 0.4075 }, o).title,
    ).toBe('Completed · Fixed · 3 min · $0.41')
  })

  it('main carries core’s costEstimated', () => {
    const run = { runId: 'r', displayNo: 1, title: 't', folder: 'C:\\src\\ts-small', auto: false }
    const n = (costEstimated?: boolean): CoreNotification => ({
      runId: 'r',
      kind: 'completed',
      state: {} as RunState,
      run,
      completed: {
        outcome: 'fixed',
        durationMs: 1000,
        costUsd: 0.41,
        ...(costEstimated !== undefined ? { costEstimated } : {}),
      },
    })
    expect(factsOf(n(true))).toMatchObject({ kind: 'completed', costEstimated: true })
    expect(factsOf(n())).not.toHaveProperty('costEstimated')
  })
})
