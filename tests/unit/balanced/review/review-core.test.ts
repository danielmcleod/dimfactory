// Review fixes in core outside the Codex adapter:
//   - switch_vendor outside a run becomes the composer's run overrides (never an error toast naming a kind id), and is
//     refused in plain words where there is no composer (the setup card, Settings → Vendors);
//   - the engine shows a native plan that ran emulated as a fallback, and the "final message as the plan" warning;
//   - a local preset pass runs (and is checked for) the model the pass names.
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import { DimFactoryError } from '@core/errors.ts'
import { META_PLAN_FALLBACK, META_PLAN_SOURCE } from '@core/adapters/types.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { readinessNeedFor } from '@core/preflight/checks/pass.ts'
import { executeAction, findAction } from '@core/recovery/dispatcher.ts'
import type { ExecuteDeps, FoundAction } from '@core/recovery/dispatcher.ts'
import { RecoveryActionStore, folderPassesOf } from '@core/recovery/store.ts'
import type { VendorReadiness } from '@core/recovery/switch-vendor.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import { Harness, makeConfig } from '../../supervisor/helpers.ts'

const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

async function err(p: Promise<unknown>): Promise<DimFactoryError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  if (!(e instanceof DimFactoryError)) throw new Error(`expected a DimFactoryError, got ${String(e)}`)
  return e
}

describe('switch_vendor outside a run', () => {
  const useClaude: RecoveryAction = {
    id: 'codex.switch-vendor',
    label: 'Use Claude instead',
    kind: 'switch_vendor',
    pass: 'all',
    to: 'claude',
    model: null,
  }
  const config = resolveBuiltinConfig({ profile: 'balanced' })
  const readyFor = vi.fn<VendorReadiness['readyFor']>(() => ({ ok: true }))
  const deps = (): ExecuteDeps => ({
    run: {
      retryPass: () => Promise.resolve(),
      skipPass: () => Promise.resolve(),
      closeRun: () => Promise.resolve(),
      resumeRun: () => Promise.resolve(),
    },
    vendors: {
      vendors: () => [
        { id: 'claude', displayName: 'Claude', built: true },
        { id: 'codex', displayName: 'Codex', built: true },
      ],
      readyFor,
    },
  })
  const report: PreflightReport = {
    mode: 'live',
    ok: false,
    blocking: [
      {
        id: 'pass.implement.mode',
        scope: 'pass',
        status: 'fail',
        blocking: true,
        title: 'Codex cannot run Implement in autoedit mode',
        detail: '',
        recovery: [useClaude],
        at: 1,
        ttlMs: 0,
      },
    ],
    warnings: [],
    info: [],
  }

  it('in the composer: run overrides for every enabled pass not on Claude (Claude passes keep their model)', async () => {
    const store = new RecoveryActionStore()
    store.record(FOLDER, report, folderPassesOf(config))
    const found = await findAction(
      { actionId: useClaude.id, folder: FOLDER },
      {
        runState: () => Promise.resolve(null),
        snagActions: () => Promise.resolve(new Map()),
        store,
        vendorChecks: () => [],
      },
    )
    expect(found.source).toMatchObject({ kind: 'folder' })
    const r = await executeAction(found, deps())
    const moved = (['plan', 'implement', 'review', 'critic', 'fix'] as const).filter(
      (p) => config.passes[p].enabled && config.passes[p].vendor !== 'claude',
    )
    expect(moved.length).toBeGreaterThan(0)
    expect(r.kind).toBe('switch_vendor')
    expect(r.overrides).toEqual(
      moved.flatMap((p) => [
        { op: 'add', path: `/passes/${p}/vendor`, value: 'claude' },
        { op: 'add', path: `/passes/${p}/model`, value: null },
        { op: 'add', path: `/passes/${p}/effort`, value: null },
      ]),
    )
    expect(r.message).toMatch(/ now uses? Claude for this run\.$/)
    for (const p of moved) expect(readyFor).toHaveBeenCalledWith('claude', p, config.passes[p].mode)
    // Forgetting the folder forgets its passes too.
    store.forget(FOLDER)
    expect(store.passes(FOLDER)).toBeUndefined()
  })

  it('where no composer can take it (a vendor check): refused in plain words, never a kind id', async () => {
    const found: FoundAction = {
      action: useClaude,
      source: { kind: 'vendor', vendor: 'codex', checkId: 'vendor.codex.winSandbox' },
    }
    const e = await err(executeAction(found, deps()))
    expect(e.code).toBe('VALIDATION')
    expect(e.message).toBe('Choose Claude for each pass in the composer; there is no run here to switch.')
    expect(e.message).not.toMatch(/switch_vendor/)
    // The run-only kinds say so in words too.
    const wait: FoundAction = {
      action: { id: 'w', label: 'Wait', kind: 'wait_until', until: 0, armed: false },
      source: { kind: 'folder', folder: FOLDER, checkId: 'x' },
    }
    const w = await err(executeAction(wait, deps()))
    expect(w.message).toBe('This fix belongs to a run; open the run to use it.')
  })
})

describe('the engine reads the plan signals', () => {
  it('a native plan the vendor ran emulated reads as a fallback on the Plan card', () => {
    const h = new Harness(makeConfig({ planMode: 'native' }))
    h.toPlanRunning()
    expect(h.step('plan').planMode).toBe('native')
    h.signal('plan', {
      type: 'meta',
      key: META_PLAN_FALLBACK,
      value: { reason: 'Codex refused its plan mode', detail: 'Invalid params: collaborationMode' },
    })
    expect(h.step('plan')).toMatchObject({
      planMode: 'emulated',
      planFallbackReason: 'Codex refused its plan mode',
    })
    expect(h.bodies('step-status').at(-1)).toMatchObject({
      step: 'plan',
      planMode: 'emulated',
      planFallbackReason: 'Codex refused its plan mode',
    })
  })

  it('a plan taken from the final message leaves its warning as a run note', () => {
    const h = new Harness(makeConfig({ planMode: 'native' }))
    h.toPlanRunning()
    const warning =
      'Codex finished without a proposed plan, so Dim Factory used its final message as the plan.'
    h.signal('plan', { type: 'meta', key: META_PLAN_SOURCE, value: { source: 'final-message', warning } })
    expect(h.state.notes).toContain(warning)
    h.signal('plan', { type: 'meta', key: META_PLAN_SOURCE, value: { source: 'final-message', warning } })
    expect(h.state.notes.filter((n) => n === warning)).toHaveLength(1)
    h.signal('plan', { type: 'meta', key: META_PLAN_SOURCE, value: { source: 'proposed_plan' } })
    expect(h.state.notes.filter((n) => n === warning)).toHaveLength(1)
  })
})

describe('a local preset pass runs the model it names', () => {
  const PRESET = {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3-coder:30b',
    contextWindow: 8192,
  }

  it('readiness checks the pass model; StartOptions carry it; no model keeps the preset’s', () => {
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    config.local.presets = [PRESET]
    config.passes.implement.vendor = 'local-ollama'
    config.passes.implement.model = 'llama3.3:70b'
    const need = readinessNeedFor(config, 'implement', undefined)
    expect(need.local).toEqual({
      id: 'ollama',
      label: 'Ollama',
      baseUrl: PRESET.baseUrl,
      model: 'llama3.3:70b',
    })

    const h = new Harness(makeConfig())
    h.toImplementRunning({ session: false })
    const spawn = h.log.filter((e) => e.t === 'spawn' && e.step === 'implement').at(-1)
    if (spawn === undefined || spawn.t !== 'spawn') throw new Error('no implement spawn')
    const o = startOptionsFor({
      runId: 'r',
      cwd: FOLDER,
      config,
      state: h.state,
      spawn: { ...spawn, vendor: 'local-ollama', model: 'llama3.3:70b' },
      prompt: 'p',
    })
    expect(o.model).toBe('llama3.3:70b')
    expect(o.local).toMatchObject({ model: 'llama3.3:70b' })
    expect(o.local).not.toHaveProperty('contextWindow')

    config.passes.implement.model = null
    expect(readinessNeedFor(config, 'implement', undefined).local).toEqual(PRESET)
    const kept = startOptionsFor({
      runId: 'r',
      cwd: FOLDER,
      config,
      state: h.state,
      spawn: { ...spawn, vendor: 'local-ollama', model: null },
      prompt: 'p',
    })
    expect(kept.local).toEqual(PRESET)
  })
})
