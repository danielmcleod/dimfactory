// Helpers shared by the recovery E2E specs (the executors and self-heal, failure categories auth_required /
// flag_drift / rate_limited / unknown, the snag specs on Claude): failing passes the recordings do not cover (a
// CLI that rejects a managed flag, a rate limit with its reset time, a failure nothing classifies), the fake Claude
// answering a self-heal prompt (matched by the healer's own argv), and what the fake was asked.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { buildArgv } from '../../src/core/adapters/claude/launch.ts'
import type { Scenario } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'

export const PLAN_MATCH = { argvIncludes: ['-p', 'plan'] }

/**
 * The healer's spawn and nothing else: its `--disallowedTools` list (the read-only pass flags plus Bash, PowerShell, WebFetch and
 * WebSearch) is its own. Review and Critic share the read-only route, but not that list.
 */
export function healMatch(): { argvIncludes: string[] } {
  const argv = buildArgv({ route: 'readonly', mode: 'readonly', step: 'heal' })
  const tools = argv[argv.indexOf('--disallowedTools') + 1]
  if (tools === undefined || !tools.includes('WebSearch')) throw new Error('no heal --disallowedTools list')
  return { argvIncludes: ['-p', '--disallowedTools', tools] }
}

type Op = Record<string, unknown> & { op: string }

/** Put scripts first in the scenario for their argv matches (each runs once, in order). */
export function prependScripts(
  sc: Scenario,
  entries: readonly { name: string; match: { argvIncludes: string[] }; ops: readonly Op[] }[],
): void {
  const file = join(sc.dir, 'scenario.json')
  const existing = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
  const first = entries.map((e) => {
    const script = join(sc.dir, `${e.name}.script.jsonl`)
    writeFileSync(script, `${e.ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
    return { match: e.match, script }
  })
  writeFileSync(file, JSON.stringify([...first, ...existing], null, 2))
}

const INITIALIZE: Op = {
  op: 'expectStdin',
  match: { type: 'control_request', request: { subtype: 'initialize' } },
  capture: { rid: 'request_id' },
}
const INITIALIZED: Op = {
  op: 'stdout',
  json: { type: 'control_response', response: { subtype: 'success', request_id: '$rid', response: {} } },
}

/** The initialize handshake and the prompt, then the session's init frame. */
function handshake(sessionId: string): Op[] {
  return [
    INITIALIZE,
    INITIALIZED,
    { op: 'expectStdin', match: { type: 'user', message: '$_' } },
    {
      op: 'stdout',
      json: { type: 'system', subtype: 'init', session_id: sessionId, cwd: '$FAKE_CWD' },
    },
  ]
}

/**
 * A CLI that no longer knows a flag Dim Factory passes (the C11a recording, with a managed flag): it reads the
 * initialize request, then rejects its argv on stderr and exits 1. Failure category flag_drift (C `unknown option`).
 */
export function flagRejectedScript(flag: string): Op[] {
  return [INITIALIZE, { op: 'stderr', line: `error: unknown option '${flag}'` }, { op: 'exit', code: 1 }]
}

/**
 * A pass rejected by a rate limit (not a usage window) that resets at `resetsAtMs`: failure category rate_limited. Past
 * 120 s away, Dim Factory does not retry on its own; the snag's wait_until is armed instead.
 */
export function rateLimitedScript(resetsAtMs: number): Op[] {
  return [
    ...handshake('rate-0001'),
    {
      op: 'stdout',
      json: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'opus',
          resetsAt: Math.floor(resetsAtMs / 1000),
        },
      },
    },
    {
      op: 'stdout',
      json: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'rate-0001',
        errors: ['Request rejected (429)'],
      },
    },
    { op: 'exit', code: 1 },
  ]
}

/** Stderr no rule knows: failure category `unknown`, classified by the heuristic stage. */
export const UNKNOWN_STDERR = 'zork: the frobnicator is out of phase'

/** A CLI that fails in a way nothing classifies (stderr only, no result). */
export function unknownFailureScript(): Op[] {
  return [...handshake('unknown-0001'), { op: 'stderr', line: UNKNOWN_STDERR }, { op: 'exit', code: 3 }]
}

/** What the fake healer answers (the internal/heal.md prompt: one fenced JSON block). */
export interface HealAnswer {
  diagnosis: string
  confidence: 'low' | 'medium' | 'high'
  category?: string
  actions: Record<string, unknown>[]
}

/**
 * The fake Claude answering a self-heal prompt: the read-only pass flags are required, the prompt arrives as the first
 * user message, and the answer is prose around one fenced JSON block in the result.
 */
export function healAnswerScript(answer: HealAnswer): Op[] {
  const text = `I read the evidence.\n\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\n`
  return [
    {
      op: 'expectArgs',
      includes: ['--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence'],
      excludes: ['--permission-prompt-tool', '--session-id*', '--resume*'],
    },
    ...handshake('heal-0001'),
    {
      op: 'stdout',
      json: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: text,
        session_id: 'heal-0001',
        total_cost_usd: 0.01,
        usage: { input_tokens: 900, output_tokens: 120 },
      },
    },
    { op: 'exit', code: 0 },
  ]
}

/** argv of every Plan spawn the fake started, in order. */
export function planArgvs(e2e: E2EHarness): string[][] {
  return e2e
    .fakeLog()
    .filter((e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('plan'))
    .map((e) => e['argv'] as string[])
}

/** The fake processes started for a self-heal (their argv is the healer's). */
export function healStarts(e2e: E2EHarness): { pid: number; argv: string[]; cwd: string }[] {
  const tools = healMatch().argvIncludes[2] ?? ''
  return e2e
    .fakeLog()
    .filter((e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes(tools))
    .map((e) => ({
      pid: e.pid,
      argv: e['argv'] as string[],
      cwd: typeof e['cwd'] === 'string' ? e['cwd'] : '',
    }))
}

/** The prompt a fake process was sent (its first user message's text). */
export function promptOf(e2e: E2EHarness, pid: number): string {
  for (const e of e2e.fakeLog()) {
    if (e.pid !== pid || e.kind !== 'stdin' || typeof e['line'] !== 'string') continue
    const f = JSON.parse(e['line']) as {
      type?: string
      message?: { content?: { type?: string; text?: string }[] | string }
    }
    if (f.type !== 'user') continue
    const c = f.message?.content
    return typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n')
  }
  return ''
}

/** A run's snag card for a step. */
export function snagCard(page: Page, step: string): ReturnType<Page['getByTestId']> {
  return page.getByTestId(`snag-${step}`)
}

// ---- nothing moves on its own (UI standards, ui-layout.spec.ts's CLS rule) ----------------------------------

interface ShiftRecord {
  value: number
  input: boolean
  sources: string[]
}
type ShiftWindow = Window & { __m10Shifts?: ShiftRecord[] }

/** Start recording layout shifts (the browser's layout-shift entries) in the page. */
export async function watchShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as ShiftWindow
    w.__m10Shifts = []
    const name = (n: Node | null | undefined): string => {
      const el = n instanceof Element ? n : (n?.parentElement ?? null)
      if (el === null) return 'a node'
      const id = el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
      return `${el.tagName.toLowerCase()} in [${id}]`
    }
    interface LayoutShiftEntry extends PerformanceEntry {
      value: number
      hadRecentInput: boolean
      sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[]
    }
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LayoutShiftEntry[])
        w.__m10Shifts?.push({
          value: e.value,
          input: e.hadRecentInput,
          sources: (e.sources ?? []).map(
            (s) =>
              `${name(s.node)} y ${Math.round(s.previousRect.y)} → ${Math.round(s.currentRect.y)}, h ${Math.round(s.previousRect.height)} → ${Math.round(s.currentRect.height)}`,
          ),
        })
    }).observe({ type: 'layout-shift' })
  })
}

/** The layout shifts without recent input since watchShifts: their sum (CLS) and what moved. */
export async function unpromptedShifts(page: Page): Promise<{ cls: number; moved: string[] }> {
  const all = await page.evaluate(() => (window as ShiftWindow).__m10Shifts ?? [])
  const shifts = all.filter((s) => !s.input)
  return {
    cls: shifts.reduce((n, s) => n + s.value, 0),
    moved: shifts.map((s) => `${s.value.toFixed(4)}: ${s.sources.join('; ')}`),
  }
}
