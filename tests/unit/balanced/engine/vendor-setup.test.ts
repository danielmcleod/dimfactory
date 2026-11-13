// vendor_setup executor ("Calls Codex windowsSandbox/setupStart, waits for setupCompleted,
// then re-probes"; vendor_setup "runs on click"; sandbox_unavailable; the sandbox
// procedure X11b): only the unelevated setup runs, one per vendor at a time, the vendor is probed again whatever the
// setup answered, and a failed pass retries only once the sandbox reads ready (no budget: a click).
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction, RecoveryActionOf } from '@shared/failure.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { StepKey } from '@shared/run.ts'
import type { ProbeResult } from '@shared/vendors.ts'
import { unsupportedCapabilities } from '@core/adapters/registry.ts'
import { DimFactoryError } from '@core/errors.ts'
import { LATER_KINDS, executeAction } from '@core/recovery/dispatcher.ts'
import type { ExecuteDeps, FoundAction, RunCommandDeps } from '@core/recovery/dispatcher.ts'
import {
  UNELEVATED,
  checkSetupRequest,
  hasVendorSetup,
  runVendorSetup,
  sandboxCheckOf,
  setupMessage,
} from '@core/recovery/vendor-setup.ts'
import type { SetupVendor, VendorSetupHost, VendorSetupResult } from '@core/recovery/vendor-setup.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { makeConfig } from '../../supervisor/helpers.ts'

const RUN = '20261009T120000Z-m8vs'
const EM_DASH = '\u2014'

const setupAction = (
  o: Partial<RecoveryActionOf<'vendor_setup'>> = {},
): RecoveryActionOf<'vendor_setup'> => ({
  id: 'implement:sandbox-setup',
  label: 'Set up the sandbox',
  kind: 'vendor_setup',
  vendor: 'codex',
  call: 'windowsSandbox/setupStart',
  params: { mode: 'unelevated' },
  ...o,
})

function sandboxCheck(status: CheckResult['status'], detail = ''): CheckResult {
  return {
    id: 'vendor.codex.winSandbox',
    scope: 'vendor',
    status,
    blocking: false,
    title: status === 'pass' ? 'Windows sandbox ready' : 'Windows sandbox not set up',
    detail,
    recovery: [],
    at: 1,
    ttlMs: 60_000,
  }
}

function probe(sandbox: CheckResult['status'] | null, detail = 'readiness: notConfigured'): ProbeResult {
  return {
    vendor: 'codex',
    at: 2,
    ok: true,
    route: 'app-server',
    transport: 'codex-app-server',
    checks: sandbox === null ? [] : [sandboxCheck(sandbox, detail)],
    capabilities: unsupportedCapabilities({ status: 'supported', copy: 'ok' }),
    models: [],
  }
}

interface World {
  host: VendorSetupHost
  setup: ReturnType<typeof vi.fn<NonNullable<SetupVendor['setup']>>>
  reprobe: ReturnType<typeof vi.fn<VendorSetupHost['reprobe']>>
  order: string[]
}

function world(
  o: {
    answer?: VendorSetupResult | Error | (() => Promise<VendorSetupResult>)
    after?: ProbeResult | Error
    vendor?: Partial<SetupVendor> | null
    timeoutMs?: number
  } = {},
): World {
  const order: string[] = []
  const setup = vi.fn<NonNullable<SetupVendor['setup']>>((call, params) => {
    order.push(`setup ${call} ${JSON.stringify(params)}`)
    const a = o.answer ?? { ok: true, detail: 'Sandbox set up.' }
    if (a instanceof Error) return Promise.reject(a)
    if (typeof a === 'function') return a()
    return Promise.resolve(a)
  })
  const reprobe = vi.fn<VendorSetupHost['reprobe']>((vendor) => {
    order.push(`reprobe ${vendor}`)
    const p = o.after ?? probe('pass')
    return p instanceof Error ? Promise.reject(p) : Promise.resolve(p)
  })
  const host: VendorSetupHost = {
    vendor: (id) =>
      o.vendor === null
        ? undefined
        : {
            id: id.startsWith('local-') ? 'codex' : id,
            displayName: 'Codex',
            built: true,
            setup,
            ...o.vendor,
          },
    reprobe,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  }
  return { host, setup, reprobe, order }
}

function failedState(step: StepKey): RunState {
  const steps: Record<string, unknown> = {}
  for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'fix'] as const) {
    steps[k] = { snagOpen: k === step, status: k === step ? 'failed' : 'done' }
  }
  return { runId: RUN, folder: 'C:\\work', steps, cards: [], config: makeConfig() } as unknown as RunState
}

function deps(w: World): {
  deps: ExecuteDeps
  retryPass: ReturnType<typeof vi.fn<RunCommandDeps['retryPass']>>
} {
  const retryPass = vi.fn<RunCommandDeps['retryPass']>(() => Promise.resolve())
  return {
    retryPass,
    deps: {
      run: {
        retryPass,
        skipPass: () => Promise.resolve(),
        closeRun: () => Promise.resolve(),
        resumeRun: () => Promise.resolve(),
      },
      vendorSetup: { host: w.host, inflight: new Map() },
    },
  }
}

const snag = (a: RecoveryAction, step: StepKey = 'implement'): FoundAction => ({
  action: a,
  source: { kind: 'snag', runId: RUN, step },
  state: failedState(step),
})

async function err(p: Promise<unknown>): Promise<DimFactoryError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  if (!(e instanceof DimFactoryError)) throw new Error(`expected a DimFactoryError, got ${String(e)}`)
  return e
}

describe('vendor_setup: what runs', () => {
  it('is no longer a later kind (it is built)', () => {
    expect(LATER_KINDS).not.toContain('vendor_setup')
  })

  it('runs only windowsSandbox/setupStart with {mode: unelevated}; the elevated setup is never run', () => {
    expect(checkSetupRequest(setupAction())).toEqual({
      call: 'windowsSandbox/setupStart',
      params: { mode: UNELEVATED },
    })
    // A core-built action from before vendor_setup was built carried empty params: the unelevated default.
    expect(checkSetupRequest(setupAction({ params: {} })).params).toEqual({ mode: 'unelevated' })
    for (const params of [{ mode: 'elevated' }, { mode: 'unelevated', cwd: 'C:\\' }, { mode: 1 }]) {
      expect(() => checkSetupRequest(setupAction({ params }))).toThrow(/administrator rights/)
    }
    expect(() =>
      checkSetupRequest(setupAction({ call: 'windowsSandbox/elevate' as 'windowsSandbox/setupStart' })),
    ).toThrow(DimFactoryError)
  })

  it('sends the checked params to the adapter, then re-probes the vendor (in that order)', async () => {
    const w = world()
    const out = await runVendorSetup(setupAction(), w.host, new Map())
    expect(w.order).toEqual(['setup windowsSandbox/setupStart {"mode":"unelevated"}', 'reprobe codex'])
    expect(w.setup.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    expect(out).toEqual({ vendor: 'codex', ok: true, ready: true, detail: 'Sandbox set up.', probed: true })
  })

  it('re-probes even when the setup failed or threw, and reports the sandbox as the probe reads it', async () => {
    const failed = world({
      answer: { ok: false, detail: 'CreateRestrictedToken failed' },
      after: probe('fail'),
    })
    const a = await runVendorSetup(setupAction(), failed.host, new Map())
    expect(failed.reprobe).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ ok: false, ready: false, detail: 'CreateRestrictedToken failed' })

    const threw = world({ answer: new Error('app-server exited'), after: probe('fail') })
    const b = await runVendorSetup(setupAction(), threw.host, new Map())
    expect(threw.reprobe).toHaveBeenCalledTimes(1)
    expect(b).toMatchObject({ ok: false, ready: false, detail: 'app-server exited' })
  })

  it('a setup that says ok while the probe still reads not ready is not ready, with the probe’s words', async () => {
    const w = world({ after: probe('fail', 'readiness: updateRequired') })
    const out = await runVendorSetup(setupAction(), w.host, new Map())
    expect(out).toMatchObject({ ok: true, ready: false, stillNotReady: 'readiness: updateRequired' })
    expect(setupMessage(out, 'Codex')).toBe(
      'The setup finished, but Codex still reports the sandbox is not ready. readiness: updateRequired. ' +
        'Try the elevated setup command.',
    )
  })

  it('a probe without a sandbox check (not Windows) follows the setup’s answer; a failed re-probe is never ready', async () => {
    expect(sandboxCheckOf(probe(null), 'codex')).toBeUndefined()
    const off = world({ after: probe(null) })
    expect((await runVendorSetup(setupAction(), off.host, new Map())).ready).toBe(true)
    const broken = world({ after: new Error('spawn failed') })
    expect(await runVendorSetup(setupAction(), broken.host, new Map())).toMatchObject({
      ok: true,
      ready: false,
      probed: false,
    })
  })

  it('gives up after the timeout with plain words (the signal is aborted)', async () => {
    let seen: AbortSignal | undefined
    const w = world({
      timeoutMs: 20,
      answer: () =>
        new Promise((_resolve, reject) => {
          const s = w.setup.mock.calls[0]?.[2]
          seen = s
          s?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      after: probe('fail'),
    })
    const out = await runVendorSetup(setupAction(), w.host, new Map())
    expect(seen?.aborted).toBe(true)
    expect(out.ok).toBe(false)
    expect(out.detail).toMatch(/^The setup took longer than \d+ minutes, so Dim Factory stopped it\.$/)
  })
})

describe('vendor_setup: refusals', () => {
  it('one setup per vendor at a time (CONFLICT), the next one runs once it ended', async () => {
    let release: (r: VendorSetupResult) => void = () => undefined
    const w = world({ answer: () => new Promise((r) => (release = r)) })
    const inflight = new Map<string, Promise<unknown>>()
    const first = runVendorSetup(setupAction(), w.host, inflight)
    await vi.waitFor(() => expect(w.setup).toHaveBeenCalledTimes(1))
    const second = await err(
      runVendorSetup(setupAction({ id: 'vendor.codex.winSandbox.setup' }), w.host, inflight),
    )
    expect(second.code).toBe('CONFLICT')
    expect(second.message).toBe('The Codex sandbox setup is already running.')
    release({ ok: true, detail: '' })
    await first
    expect(inflight.size).toBe(0)
    await runVendorSetup(setupAction(), world().host, inflight)
  })

  it('a disabled action, an unknown or unbuilt vendor, or an adapter without a setup is refused before anything runs', async () => {
    const w = world()
    expect(
      (
        await err(
          runVendorSetup(setupAction({ disabledReason: 'Codex is not installed.' }), w.host, new Map()),
        )
      ).message,
    ).toBe('Codex is not installed.')
    expect((await err(runVendorSetup(setupAction(), world({ vendor: null }).host, new Map()))).code).toBe(
      'NOT_FOUND',
    )
    expect(
      (await err(runVendorSetup(setupAction(), world({ vendor: { built: false } }).host, new Map()))).code,
    ).toBe('UNSUPPORTED')
    const host: VendorSetupHost = {
      ...w.host,
      vendor: () => ({ id: 'codex', displayName: 'Codex', built: true }),
    }
    expect((await err(runVendorSetup(setupAction(), host, new Map()))).message).toBe(
      'Codex cannot set up its sandbox from Dim Factory.',
    )
    expect(w.setup).not.toHaveBeenCalled()
    expect(w.reprobe).not.toHaveBeenCalled()
  })

  it('hasVendorSetup recognizes an adapter that offers one', () => {
    expect(hasVendorSetup({ vendorSetup: () => Promise.resolve({ ok: true, detail: '' }) })).toBe(true)
    expect(hasVendorSetup({ id: 'claude' })).toBe(false)
    expect(hasVendorSetup(null)).toBe(false)
  })
})

describe('vendor_setup through recovery.execute', () => {
  it('a failed pass retries once the sandbox reads ready (strategy auto, a click: no budget)', async () => {
    const w = world()
    const d = deps(w)
    const r = await executeAction(snag(setupAction()), d.deps)
    expect(r).toMatchObject({ kind: 'vendor_setup', setup: { ok: true, ready: true } })
    expect(r.message).toBe('The Codex sandbox is set up. Retrying Implement.')
    expect(d.retryPass).toHaveBeenCalledWith(RUN, 'implement', 'auto')
  })

  it('no retry while the sandbox is not ready; the message names the elevated command as the next step', async () => {
    const w = world({ answer: { ok: false, detail: 'setup refresh had errors' }, after: probe('fail') })
    const d = deps(w)
    const r = await executeAction(snag(setupAction()), d.deps)
    expect(d.retryPass).not.toHaveBeenCalled()
    expect(r.message).toBe(
      'The Codex sandbox setup failed. setup refresh had errors. Try the elevated setup command.',
    )
    expect(r.message).not.toContain(EM_DASH)
  })

  it('outside a run (the vendor check, the composer chip): set up and re-probed, nothing retried', async () => {
    const w = world()
    const d = deps(w)
    const found: FoundAction = {
      action: setupAction({ id: 'vendor.codex.winSandbox.setup' }),
      source: { kind: 'vendor', vendor: 'codex', checkId: 'vendor.codex.winSandbox' },
    }
    const r = await executeAction(found, d.deps)
    expect(r.message).toBe('The Codex sandbox is set up.')
    expect(w.reprobe).toHaveBeenCalledWith('codex')
    expect(d.retryPass).not.toHaveBeenCalled()
  })

  it('a local preset’s snag sets up Codex (the adapter it runs on)', async () => {
    const w = world()
    await executeAction(snag(setupAction({ vendor: 'local-ollama' })), deps(w).deps)
    expect(w.reprobe).toHaveBeenCalledWith('codex')
  })

  it('a core without the executor answers UNSUPPORTED', async () => {
    const w = world()
    const d = deps(w)
    const { vendorSetup: _vs, ...rest } = d.deps
    expect((await err(executeAction(snag(setupAction()), rest))).code).toBe('UNSUPPORTED')
    expect(w.setup).not.toHaveBeenCalled()
  })
})
