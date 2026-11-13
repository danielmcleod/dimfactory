// Classifier precedence: app-initiated → errno → structured → exit code → regex
// (LC_ALL=C) → heuristic → unknown. Each ladder carries evidence for every stage and removes them from the top,
// one at a time, so each stage is shown to beat every stage below it, for Claude, Codex and Gemini tables.
// Codex and Gemini frames are SYNTHESIZED.
import { describe, expect, it } from 'vitest'
import { classify, classifyDetailed } from '@core/heal/classify.ts'
import type { ClassifyInput } from '@core/heal/classify.ts'
import { sanitizeEnv } from '@core/proc/env.ts'
import type { ClassifiedBy, FailureCategory } from '@shared/failure.ts'
import { CLASSIFIED_BY } from '@shared/failure.ts'
import { apiRetry, assistantError, errorText } from '../heal/claude-frames.ts'
import { acpStop, claude, codex, codexTurnFailed, app, gemini, recorded } from './inputs.ts'

const OOM = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
const NOTHING = 'the frobnicator jammed'

interface Rung {
  /** What this rung adds to the input (the stages below stay present). */
  add: Partial<ClassifyInput>
  by: ClassifiedBy
  category: FailureCategory
}

/**
 * `rungs[0]` is the lowest stage (unknown). Rung i's input is the base plus every rung's `add` from 1 to i; its
 * expected result is rung i's. Later rungs override earlier keys (exitCode, stderrTail).
 */
function climb(base: ClassifyInput, rungs: readonly Rung[]): void {
  let input: ClassifyInput = { ...base }
  for (const [i, r] of rungs.entries()) {
    input = { ...input, ...r.add }
    const f = classify(input)
    expect(f, `rung ${i} (${r.by})`).not.toBeNull()
    expect({ by: f!.classifiedBy, category: f!.category }, `rung ${i}`).toEqual({
      by: r.by,
      category: r.category,
    })
  }
}

describe('precedence ladders', () => {
  it('Claude', () => {
    climb(claude(), [
      { add: { exitCode: 1, stderrTail: NOTHING }, by: 'heuristic', category: 'unknown' },
      { add: { stderrTail: [NOTHING, OOM] }, by: 'heuristic', category: 'process_crash' },
      {
        add: { stderrTail: [NOTHING, OOM, 'Not logged in · Please run /login'] },
        by: 'regex',
        category: 'auth_required',
      },
      { add: { exitCode: 3221225477 }, by: 'exit', category: 'process_crash' },
      {
        add: { structured: [assistantError('billing_error', 'Billing problem')] },
        by: 'structured',
        category: 'billing',
      },
      { add: { errno: 'ENOENT' }, by: 'errno', category: 'cli_missing' },
      {
        add: { appDetected: { check: 'unsupported' } },
        by: 'app',
        category: 'capability_missing',
      },
      { add: { appInitiated: { kind: 'stop' } }, by: 'app', category: 'user_cancelled' },
    ])
  })

  it('Codex (synthesized)', () => {
    climb(codex(), [
      { add: { exitCode: 1, stderrTail: NOTHING }, by: 'heuristic', category: 'unknown' },
      { add: { stderrTail: [NOTHING, OOM] }, by: 'heuristic', category: 'process_crash' },
      {
        add: { stderrTail: [NOTHING, OOM, "error: unexpected argument '--yolo' found"] },
        by: 'regex',
        category: 'flag_drift',
      },
      { add: { exitCode: 137 }, by: 'exit', category: 'process_crash' },
      {
        add: { structured: [codexTurnFailed('usageLimitExceeded', "You've hit your usage limit.")] },
        by: 'structured',
        category: 'quota_exceeded',
      },
      { add: { errno: 'ECONNRESET' }, by: 'errno', category: 'network' },
      { add: { appInitiated: { kind: 'ask' } }, by: 'app', category: 'ask_timeout' },
    ])
  })

  it('Gemini (synthesized)', () => {
    climb(gemini(), [
      { add: { exitCode: 1, stderrTail: NOTHING }, by: 'heuristic', category: 'unknown' },
      { add: { stderrTail: [NOTHING, OOM] }, by: 'heuristic', category: 'process_crash' },
      {
        add: {
          stderrTail: [
            NOTHING,
            OOM,
            'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).',
          ],
        },
        by: 'regex',
        category: 'context_exceeded',
      },
      { add: { exitCode: 53 }, by: 'exit', category: 'turn_limit' },
      { add: { structured: [acpStop('refusal')] }, by: 'structured', category: 'content_policy' },
      { add: { errno: 'ENOSPC' }, by: 'errno', category: 'disk_full' },
      { add: { appInitiated: { kind: 'hard' } }, by: 'app', category: 'timeout_hard' },
    ])
  })

  it('CLASSIFIED_BY lists the stages in precedence order', () => {
    expect(CLASSIFIED_BY).toEqual(['app', 'errno', 'structured', 'exit', 'regex', 'heuristic'])
  })
})

describe('1. Dim Factory-initiated and Dim Factory-detected', () => {
  it('a kill beats a detected failure', () => {
    const f = classify(
      claude({ appInitiated: { kind: 'stop' }, appDetected: { check: 'verify' }, exitCode: 1 }),
    )!
    expect(f).toMatchObject({ category: 'user_cancelled', classifiedBy: 'app' })
  })

  it('a quit is never a failure, even with a detected failure', () => {
    expect(classify(claude({ appInitiated: { kind: 'quit' }, appDetected: { check: 'config' } }))).toBeNull()
  })

  it('the check gives errno its meaning: ENOENT from verify is deps_missing, not cli_missing', () => {
    expect(classify(app('verify', { errno: 'ENOENT' }))!.category).toBe('cli_missing')
    expect(classify(app('verify', { errno: 'ENOENT', appDetected: { check: 'verify' } }))!.category).toBe(
      'deps_missing',
    )
  })

  it("the failed command's own evidence refines a command check (ENOSPC → disk_full)", () => {
    const r = classifyDetailed(
      app('git', {
        appDetected: { check: 'worktree' },
        exitCode: 128,
        stderrTail: "fatal: detected dubious ownership in repository at 'C:/r'",
      }),
    )!
    expect(r.failure.category).toBe('git_state')
    expect(r.hints).toEqual(['git-dubious'])
    const lock = classifyDetailed(
      app('git', {
        appDetected: { check: 'worktree' },
        exitCode: 128,
        stderrTail: "fatal: Unable to create 'C:/r/.git/index.lock': File exists.",
      }),
    )!
    expect(lock.failure.category).toBe('git_state')
    expect(lock.hints).toEqual(['git-lock'])
  })

  it('non-command checks ignore command evidence', () => {
    const f = classify(
      app('app', {
        appDetected: { check: 'folder-guard' },
        errno: 'ENOSPC',
        stderrTail: 'No space left on device',
      }),
    )!
    expect(f).toMatchObject({ category: 'folder_guard', classifiedBy: 'app' })
  })

  it('a detected failure keeps its own raw (redacted)', () => {
    const f = classify(
      app('verify', {
        appDetected: {
          check: 'verify',
          raw: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA leaked into the log',
        },
        exitCode: 1,
      }),
    )!
    expect(f.raw).not.toContain('sk-ant-')
    expect(f.raw).toContain('leaked into the log')
  })
})

describe('3. inside the structured stage', () => {
  it('a protocol violation beats an RPC error and vendor frames', () => {
    const f = classify(
      codex({
        protocol: { malformedLines: 3 },
        rpcError: { code: -32601, method: 'model/list', required: false },
        structured: [codexTurnFailed('usageLimitExceeded', 'x')],
      }),
    )!
    expect(f.category).toBe('stream_malformed')
  })

  it("the vendor's RPC reading beats the generic table", () => {
    // Generic: -32602 on an optional method is capability_missing; ACP session/load says the session is gone.
    const e = {
      code: -32602,
      message: 'Invalid session identifier format.',
      method: 'session/load',
      required: false,
    }
    expect(classify(gemini({ rpcError: e }))!.category).toBe('resume_failed')
    expect(classify({ vendor: 'grok', rpcError: e })!.category).toBe('capability_missing')
  })

  it('an RPC error beats vendor frames', () => {
    const f = classify(
      gemini({
        rpcError: { code: -32000, message: 'Authentication required' },
        structured: [acpStop('refusal')],
      }),
    )!
    expect(f.category).toBe('auth_required')
  })
})

describe('retry frames sit between regex and heuristics', () => {
  it('a retry hint beats a heuristic', () => {
    const r = classifyDetailed(
      claude({ exitCode: 1, structured: [apiRetry('overloaded', 529)], stderrTail: OOM }),
    )!
    expect(r.failure).toMatchObject({ category: 'vendor_internal', classifiedBy: 'structured' })
    expect(r.rule).toBe('claude.api_retry.overloaded')
  })

  it('a regex beats a retry hint', () => {
    const f = classify(
      claude({ exitCode: 1, structured: [apiRetry('overloaded', 529)], stderrTail: 'Not logged in' }),
    )!
    expect(f).toMatchObject({ category: 'auth_required', classifiedBy: 'regex' })
  })

  it('Codex willRetry frames are never the failure: the later failed turn decides', () => {
    const f = classify(
      codex({
        structured: [
          {
            method: 'error',
            params: { error: { message: 'Reconnecting... 1/5', codexErrorInfo: 'other' }, willRetry: true },
          },
          codexTurnFailed('contextWindowExceeded', 'Context window exceeded'),
        ],
      }),
    )!
    expect(f.category).toBe('context_exceeded')
  })
})

describe('4. exit codes beat regex', () => {
  it('Gemini exit 41 beats an unrelated text', () => {
    expect(classify(gemini({ exitCode: 41, stderrTail: 'Invalid session identifier "x"' }))!.category).toBe(
      'auth_required',
    )
  })

  it('vendor exit codes never apply to another vendor', () => {
    const f = classify(claude({ exitCode: 41, stderrTail: NOTHING }))!
    expect(f).toMatchObject({ category: 'unknown', classifiedBy: 'heuristic' })
  })
})

describe('5. regex (LC_ALL=C)', () => {
  it('Dim Factory runs git with LC_ALL=C, so git speaks the English the regexes match', () => {
    const env = sanitizeEnv(
      { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
      { purpose: 'git', platform: 'linux' },
    )
    expect(env['LC_ALL']).toBe('C')
  })

  it('the C-locale message matches; a localized one would fall through to unknown', () => {
    const english = classify(
      app('git', {
        exitCode: 128,
        stderrTail: "fatal: detected dubious ownership in repository at '/r'",
      }),
    )!
    expect(english).toMatchObject({ category: 'git_state', classifiedBy: 'regex' })
    const german = classify(
      app('git', {
        exitCode: 128,
        stderrTail: "fatal: Unsicherer Besitz des Repositorys in '/r' festgestellt",
      }),
    )!
    expect(german).toMatchObject({ category: 'unknown', classifiedBy: 'heuristic' })
  })

  it('a vendor table regex beats the generic table', () => {
    const r = classifyDetailed(
      codex({
        exitCode: 1,
        stderrTail: ["error: unexpected argument '--x' found", 'getaddrinfo ENOTFOUND x'],
      }),
    )!
    expect(r.rule).toBe('codex.regex.unexpected-argument')
  })

  it('context-gated rules apply only in their context', () => {
    const readOnly = { exitCode: 1, stderrTail: 'sandbox: read-only' }
    expect(classify(codex({ ...readOnly, mode: 'autoedit' }))!.category).toBe('sandbox_unavailable')
    expect(classify(codex({ ...readOnly, mode: 'readonly' }))!.category).toBe('unknown')
    const model = { exitCode: 1, stderrTail: 'model "qwen3:32b" not found' }
    expect(classify(codex(model))!.category).toBe('model_unavailable')
    expect(classify({ ...codex(model), loopback: true })!.category).toBe('local_server')
    expect(classify(codex({ ...model, vendor: 'local-lmstudio' }))!.category).toBe('local_server')
  })
})

describe('6–7. heuristic, then unknown', () => {
  it('a heuristic is only reached when nothing specific matched', () => {
    expect(classify(claude({ exitCode: 1, stderrTail: OOM }))).toMatchObject({
      category: 'process_crash',
      classifiedBy: 'heuristic',
    })
    expect(classify(claude({ exitCode: 1, stderrTail: `${OOM}\nNot logged in` }))!.classifiedBy).toBe('regex')
  })

  it('unknown is classifiedBy heuristic (it triggers self-heal) and keeps the first line', () => {
    const r = classifyDetailed(claude({ exitCode: 1, stderrTail: [NOTHING, 'second line'] }))!
    expect(r.failure).toMatchObject({ category: 'unknown', classifiedBy: 'heuristic', message: NOTHING })
    expect(r.rule).toBe('unknown')
  })

  it('an unparsed is_error result with exit 0 is unknown, not null', () => {
    expect(
      classify(claude({ exitCode: 0, structured: [errorText('A brand new failure mode')] }))!.category,
    ).toBe('unknown')
  })

  it('recorded: C08e has no specific rule and lands on unknown', () => {
    expect(classifyDetailed(recorded('C08e-session-id-with-resume'))).toMatchObject({
      rule: 'unknown',
      failure: { category: 'unknown', classifiedBy: 'heuristic' },
    })
  })
})
