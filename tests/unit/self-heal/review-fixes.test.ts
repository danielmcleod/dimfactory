// Self-heal review fixes (executors config_patch / wait_until, self-heal, rate_limited and
// context_exceeded): the healer's own flagMap, run-less diagnosis ids, recovery patches replayed
// on load for a vendor the config did not list, combined short flags at load, long waits and waits across sleep, and
// the trimmed diff of a retry after context_exceeded.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Failure, RecoveryAction } from '@shared/failure.ts'
import { ResolvedConfigZ, validateSemantics } from '@shared/config-schema.ts'
import { MANAGED_FLAGS } from '@core/adapters/claude/capabilities.ts'
import { shortFlagCluster } from '@core/adapters/claude/launch.ts'
import { resolvedConfigWithPatches } from '@core/app-core.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { healerFlagMap } from '@core/heal/healer.ts'
import { patchResolved, replayRecoveryPatch } from '@core/recovery/config-patch.ts'
import { healViewOf } from '@core/recovery/heal-api.ts'
import type { HealOutcome } from '@core/recovery/heal-api.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import { PROMPT_DIFF_MIN_BYTES, promptDiffCap } from '@core/supervisor/controller.ts'
import { MAX_TIMER_DELAY_MS, scaledClock, systemClock } from '@core/supervisor/effects.ts'
import { DEFAULT_CONTEXT } from '@core/supervisor/machine.ts'
import type { ReducerContext } from '@core/supervisor/types.ts'
import { Harness, T0, makeConfig } from '../supervisor/helpers.ts'

const managedFlags = { claude: MANAGED_FLAGS as readonly string[] }

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the healer's own spawn keeps its read-only flags (finding 3)", () => {
  it('drops renames of the read-only tool cut, MCP, hooks and prompt flags; keeps the others', () => {
    expect(
      healerFlagMap({
        '--disallowedTools': '--fallback-model',
        '--disallowed-tools': '--deny',
        '--strict-mcp-config': '--debug',
        '--settings': '--betas',
        '--permission-prompts': '--prompts',
        '--permission-mode': '--mode',
        '--output-format': '--format',
      }),
    ).toEqual({ '--permission-mode': '--mode', '--output-format': '--format' })
    expect(healerFlagMap({ '--disallowedTools': '--x' })).toBeUndefined()
    expect(healerFlagMap(undefined)).toBeUndefined()
  })
})

describe('run-less diagnoses never share action ids (finding 5)', () => {
  const outcome = (actions: RecoveryAction[]): HealOutcome => ({
    status: 'ok',
    diagnosis: 'd',
    confidence: 'high',
    actions,
    hidden: 0,
    at: T0,
  })
  const login: RecoveryAction = {
    id: 'x-1',
    label: 'Copy',
    kind: 'shell_copy',
    command: 'claude auth login',
    shell: 'sh',
    reason: 'r',
    recheck: 'vendor.claude.auth',
  }
  const saveFix: RecoveryAction = {
    id: 'x-1',
    label: 'Rename',
    kind: 'config_patch',
    target: 'runOverrides',
    ops: [{ op: 'add', path: '/vendors/claude/flagMap/--model', value: '--model-name' }],
    preview: '',
    persist: { scope: 'user' },
  }

  it('each diagnosis outside a run namespaces its ids with its own nonce', () => {
    const a = healViewOf(outcome([login]), 'user', { step: 'probe', nonce: 'heal-aaaa' })
    const b = healViewOf(outcome([saveFix]), 'user', { step: 'probe', nonce: 'heal-bbbb', managedFlags })
    expect(a.actions.map((x) => x.id)).toEqual(['probe:heal-aaaa-1'])
    expect(b.actions.map((x) => x.id)).toEqual(['probe:heal-bbbb-1'])
  })

  it('the store never lets a later diagnosis take over an id a button still shows', () => {
    const store = new RecoveryActionStore()
    const from = { checkId: 'vendor.claude.auth', scope: 'vendor' as const }
    expect(store.addSuggested(undefined, from, [{ ...login, id: 'probe:heal-1' }])).toEqual([])
    expect(store.addSuggested(undefined, from, [{ ...saveFix, id: 'probe:heal-1' }])).toEqual([
      'probe:heal-1',
    ])
    expect(store.global('probe:heal-1')?.action.kind).toBe('shell_copy')
  })
})

describe('recovery patches survive a reload for a vendor the config did not list (finding 8)', () => {
  it('replays resolved.json patches[] as they were applied (vendor entry created first)', () => {
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    expect(Object.keys(config.vendors)).toEqual([])
    const ops = [{ op: 'add' as const, path: '/vendors/claude/flagMap/--permission-mode', value: '--mode' }]
    const live = patchResolved(config, ops, { managedFlags }).config
    expect(live.vendors['claude']?.flagMap).toEqual({ '--permission-mode': '--mode' })
    const skipped: number[] = []
    const reloaded = ResolvedConfigZ.parse(
      resolvedConfigWithPatches({ config, patches: [{ ops }] }, (i) => skipped.push(i)),
    )
    expect(skipped).toEqual([])
    expect(reloaded.vendors['claude']?.flagMap).toEqual({ '--permission-mode': '--mode' })
    expect(reloaded).toEqual(live)
  })

  it('reports a patch that no longer applies instead of dropping it silently', () => {
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const skipped: { index: number; error: string }[] = []
    const out = resolvedConfigWithPatches(
      {
        config,
        patches: [
          { ops: [{ op: 'test', path: '/passes/plan/model', value: 'something-else' }] },
          'not a patch',
          { ops: [{ op: 'replace', path: '/passes/plan/model', value: null }] },
        ],
      },
      (index, error) => skipped.push({ index, error }),
    )
    expect(skipped.map((s) => s.index)).toEqual([0, 1])
    expect(skipped[0]?.error).toMatch(/no longer matches/)
    expect(ResolvedConfigZ.parse(out).passes.plan.model).toBeNull()
    // A vendor id that is not one is never created.
    expect(() =>
      replayRecoveryPatch(config, [{ op: 'add', path: '/vendors/__proto__/flagMap/--x', value: '--y' }]),
    ).toThrow()
  })
})

describe('combined short flags at load (finding 2)', () => {
  it('a config whose extraArgs combine a managed short flag is invalid with its location', () => {
    const issues = validateSemantics(
      { vendors: { claude: { extraArgs: ['--max-turns', '40', '-pc'] } } },
      { scope: 'user', managedFlags },
    )
    expect(issues).toEqual([
      expect.objectContaining({
        pointer: '/vendors/claude/extraArgs/2',
        code: 'managed-flag',
        message: '-pc combines -p with other short flags; Dim Factory manages -p',
      }),
    ])
    expect(
      validateSemantics({ vendors: { claude: { extraArgs: ['-dv'] } } }, { scope: 'user', managedFlags }),
    ).toEqual([])
  })

  it('shortFlagCluster reads an argument as the CLI parser does', () => {
    expect(shortFlagCluster('-pc')).toEqual(['-p', '-c'])
    expect(shortFlagCluster('-r1a')).toEqual(['-r', '-1', '-a'])
    expect(shortFlagCluster('-p')).toBeNull()
    expect(shortFlagCluster('--print')).toBeNull()
    expect(shortFlagCluster('value')).toBeNull()
  })
})

describe('long waits and waits across sleep (finding 10)', () => {
  it('the clocks never hand a platform timer more than 2^31 - 1 ms', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const fn = (): void => undefined
    const sys = systemClock()
    const h = sys.setTimer(fn, Date.now() + 30 * 86_400_000)
    expect(spy.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS)
    sys.clearTimer(h)
    const scaled = scaledClock(2)
    const h2 = scaled.setTimer(fn, scaled.now() + 200 * 86_400_000)
    expect(spy.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS)
    scaled.clearTimer(h2)
  })

  const ctx: ReducerContext = {
    ...DEFAULT_CONTEXT,
    recoveryActions: (step, failure, info) =>
      snagActions({
        step,
        failure,
        hasSession: info.hasSession,
        hints: info.hints,
        at: info.at ?? 0,
        vendor: 'claude',
        vendorName: 'Claude',
        platform: 'win32',
        clockText: () => '14:05',
      }),
  }
  const rateLimited = (resetsAt: number): Failure => ({
    category: 'rate_limited',
    message: '429',
    raw: '',
    classifiedBy: 'structured',
    resetsAt,
  })

  it('a wait armed before a sleep is armed again on resume, at its own time', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    const reset = h.now + 3_600_000
    h.exit('implement', { code: 1, failure: rateLimited(reset) })
    expect(h.timerDue('wait|implement')).toBe(reset)
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    const resumed = h.tick(600_000).send({ t: 'power', state: 'resume' })
    expect(resumed.effects).toContainEqual({ t: 'timer', id: 'wait|implement', at: reset })
    expect(h.step('implement').wait).toMatchObject({ armed: true, until: reset })
  })

  it('a reset that passed while asleep fires as soon as the machine wakes', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    const reset = h.now + 3_600_000
    h.exit('implement', { code: 1, failure: rateLimited(reset) })
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    const resumed = h.tick(2 * 3_600_000).send({ t: 'power', state: 'resume' })
    // Armed at its (past) time: the platform timer fires at once.
    expect(resumed.effects).toContainEqual({ t: 'timer', id: 'wait|implement', at: reset })
    h.fire('wait|implement')
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
  })

  it('a wait timer that fires early (a long wait in steps) is armed again and does not retry', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    const reset = h.now + 30 * 86_400_000
    h.exit('implement', { code: 1, failure: rateLimited(reset) })
    // The quota-length wait is offered for the user to arm (the rate-limit rule arms it; here it is armed).
    expect(h.step('implement').wait).toMatchObject({ armed: true, until: reset })
    const early = h.send({ t: 'timer', id: 'wait|implement', due: reset }, h.now + MAX_TIMER_DELAY_MS)
    expect(early.effects).toContainEqual({ t: 'timer', id: 'wait|implement', at: reset })
    expect(h.step('implement')).toMatchObject({ status: 'failed', attempt: 1 })
    h.fire('wait|implement', reset)
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
  })
})

describe('context_exceeded: the retry trims the diff (finding 11)', () => {
  it('each fresh retry after context_exceeded halves the diff budget once more (LaunchPlan.diffTrim)', () => {
    const h = new Harness(makeConfig()).toImplementRunning()
    const tooLong: Failure = {
      category: 'context_exceeded',
      message: 'Prompt is too long',
      raw: '',
      classifiedBy: 'regex',
    }
    h.exit('implement', { code: 1, failure: tooLong })
    h.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
    h.snapshot('pre-retry', 'tree-changed')
    h.passPreflight('implement')
    expect(h.fx('spawn').at(-1)?.launch).toMatchObject({ diffTrim: 1 })
    h.exit('implement', { code: 1, failure: tooLong })
    h.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
    h.snapshot('pre-retry', 'tree-changed-2')
    h.passPreflight('implement')
    expect(h.fx('spawn').at(-1)?.launch).toMatchObject({ diffTrim: 2 })
  })

  it('the controller halves the prompt diff budget per trim, never below 2 KB', () => {
    const full = promptDiffCap(200_000, 10_000)
    expect(full).toBeGreaterThan(100_000)
    expect(promptDiffCap(200_000, 10_000, 1)).toBe(Math.floor(full / 2))
    expect(promptDiffCap(200_000, 10_000, 2)).toBe(Math.floor(full / 4))
    expect(promptDiffCap(200_000, 10_000, 40)).toBe(PROMPT_DIFF_MIN_BYTES)
    expect(promptDiffCap(200_000, 10_000, -3)).toBe(full)
  })

  it('other failures leave the budget whole', () => {
    const h = new Harness(makeConfig()).toImplementRunning()
    h.exit('implement', {
      code: 1,
      failure: { category: 'auth_required', message: 'Not logged in', raw: '', classifiedBy: 'regex' },
    })
    h.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
    h.snapshot('pre-retry', 'tree-changed')
    h.passPreflight('implement')
    expect(h.fx('spawn').at(-1)?.launch).not.toHaveProperty('diffTrim')
  })
})
