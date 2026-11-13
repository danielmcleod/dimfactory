// Integration wire-up between the builders (the mode row "Codex, Windows sandbox not ready":
// autoedit unsupported, "fix: vendor_setup unelevated → elevated shell_copy"; sandbox_unavailable;
// pass.<p>.mode; codex-sandbox.spec.ts "Codex Windows sandbox chip clears the block"). The blocking mode check of a pass Codex
// cannot run without its sandbox offers the vendor's own sandbox fixes (as its probe offers them on
// vendor.codex.winSandbox) before "Use Claude", so the composer's blocking chip is the sandbox chip; and a JSON-RPC
// -32601 on a method the Codex route requires is flag drift.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { isRequiredMethod } from '@core/adapters/codex/appserver.ts'
import { createCodexAdapter } from '@core/adapters/codex/index.ts'
import { CodexNormalizer } from '@core/adapters/codex/normalize.ts'
import { planImplementOverrides, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import {
  check,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../../preflight/helpers.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wireup-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const all = (r: PreflightReport): CheckResult[] => [...r.blocking, ...r.warnings, ...r.info]
const byId = (r: PreflightReport, id: string): CheckResult | undefined => all(r).find((x) => x.id === id)

const SETUP: RecoveryAction = {
  id: 'codex.sandbox-setup',
  label: 'Set up the Codex sandbox',
  kind: 'vendor_setup',
  vendor: 'codex',
  call: 'windowsSandbox/setupStart',
  params: { mode: 'unelevated' },
}
const ELEVATED: RecoveryAction = {
  id: 'codex.sandbox-elevated',
  label: 'Copy the elevated setup command',
  kind: 'shell_copy',
  command: 'codex sandbox setup --elevated --current-user',
  shell: 'powershell',
  reason: 'If the setup above does not work, run this in a terminal.',
  recheck: 'vendor.codex.winSandbox',
  elevated: true,
}

const SWITCH: RecoveryAction = {
  id: 'codex.switch-vendor',
  label: 'Use Claude instead',
  kind: 'switch_vendor',
  pass: 'all',
  to: 'claude',
  model: null,
}

/** Balanced (Implement on Codex autoedit) with Codex probed: its sandbox check failing (not blocking) or passing. */
async function balanced(
  sandbox: 'notConfigured' | 'ready',
  fixes: RecoveryAction[] = [SETUP, ELEVATED],
): Promise<PreflightReport> {
  const reason = sandbox === 'ready' ? undefined : `winSandbox-${sandbox}`
  const winSandbox =
    sandbox === 'ready'
      ? check('vendor.codex.winSandbox', 'pass')
      : check('vendor.codex.winSandbox', 'fail', {
          blocking: false,
          category: 'sandbox_unavailable',
          title: 'Codex Windows sandbox not set up',
          recovery: fixes,
        })
  const codex = fakeAdapter('codex', {
    probe: probeResult('codex', 1_000_000, [...healthyChecks('codex', 1_000_000), winSandbox]),
    support: (need) =>
      reason !== undefined && need.mode === 'autoedit'
        ? { status: 'unsupported', copy: 'Needs the Codex Windows sandbox, which is not set up.', reason }
        : { status: 'supported', copy: 'ok' },
  })
  const engine = createPreflightEngine(
    healthyDeps({ home: join(root, 'home'), adapters: fakeRegistry(fakeAdapter('claude'), codex) }),
  )
  engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
  engine.recordProbe(await codex.probe())
  const config = resolveBuiltinConfig({ profile: 'balanced', overrides: planImplementOverrides() })
  return engine.run('live', { folder: root, config })
}

describe('pass.<p>.mode with the Codex Windows sandbox not set up', () => {
  it('blocks as sandbox_unavailable with the setup, then the elevated command, then switching vendors', async () => {
    const r = await balanced('notConfigured')
    const mode = byId(r, 'pass.implement.mode')
    expect(mode).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'sandbox_unavailable',
      // The copy, without the internal reason code.
      detail: 'Needs the Codex Windows sandbox, which is not set up.',
    })
    expect(mode?.recovery.map((a) => a.kind)).toEqual(['vendor_setup', 'shell_copy', 'switch_vendor'])
    expect(mode?.recovery[0]).toEqual(SETUP)
    expect(mode?.recovery[1]).toEqual(ELEVATED)
    expect(mode?.recovery[2]).toMatchObject({ kind: 'switch_vendor', pass: 'implement', to: 'claude' })
    expect(r.ok).toBe(false)
  })

  it("with the vendor's own switch (the real probe's actions), a blocked pass carries exactly its fixes", async () => {
    const r = await balanced('notConfigured', [SETUP, ELEVATED, SWITCH])
    const ids = (id: string): string[] => byId(r, id)?.recovery.map((a) => a.id) ?? []
    const vendorFixes = ['codex.sandbox-setup', 'codex.sandbox-elevated', 'codex.switch-vendor']
    expect(ids('pass.implement.mode')).toEqual(vendorFixes)
    // The same fixes as the vendor's own check: the composer groups them into one chip.
    expect(ids('vendor.codex.winSandbox')).toEqual(vendorFixes)
    expect(byId(r, 'pass.implement.mode')).toMatchObject({ status: 'fail', category: 'sandbox_unavailable' })
  })

  it('a pass Codex cannot run for another reason keeps capability_missing and only the switch', async () => {
    const codex = fakeAdapter('codex', {
      support: (need) =>
        need.pass === 'implement'
          ? { status: 'unsupported', copy: 'Not here', reason: 'no-relay' }
          : { status: 'supported', copy: 'ok' },
    })
    const engine = createPreflightEngine(
      healthyDeps({ home: join(root, 'home'), adapters: fakeRegistry(fakeAdapter('claude'), codex) }),
    )
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    engine.recordProbe(await codex.probe())
    const config = resolveBuiltinConfig({ profile: 'balanced', overrides: planImplementOverrides() })
    const r = await engine.run('live', { folder: root, config })
    const mode = byId(r, 'pass.implement.mode')
    expect(mode).toMatchObject({ status: 'fail', category: 'capability_missing' })
    expect(mode?.recovery.map((a) => a.kind)).toEqual(['switch_vendor'])
  })

  it('once the sandbox is ready the mode passes and nothing blocks Implement', async () => {
    const r = await balanced('ready')
    expect(byId(r, 'pass.implement.mode')?.status).toBe('pass')
    expect(r.blocking.filter((c) => c.id.startsWith('pass.implement'))).toEqual([])
  })
})

// The failure table: flag_drift "ACP -32601 on a required method", capability_missing "X -32601/-32602 on an optional
// method". The app-server run marks the methods the probe lists as required, so a CLI that no longer knows
// turn/start (a renamed method) is flag drift, healed through flagMap/an update, not "use another vendor".
describe('a JSON-RPC -32601 from Codex', () => {
  const normalizer = (): CodexNormalizer =>
    new CodexNormalizer({
      step: 'implement',
      mode: 'autoedit',
      cwd: '/w',
      planNative: false,
      resumed: false,
      askTimeoutMs: 600_000,
      allowRules: [],
      structured: false,
      loopback: false,
      now: () => 1000,
    })
  const errorOf = (method: string): NormalizedEvent | undefined =>
    normalizer()
      .failNow({
        rpcError: { method, code: -32601, message: 'Method not found', required: isRequiredMethod(method) },
        stderrTail: [],
      })
      .events.find((e) => e.type === 'error')

  it('on a required method (turn/start) is flag_drift', () => {
    expect(isRequiredMethod('turn/start')).toBe(true)
    expect(isRequiredMethod('thread/start')).toBe(true)
    expect(errorOf('turn/start')).toMatchObject({ type: 'error', fatal: true, category: 'flag_drift' })
  })

  it('on an optional one (model/list) is capability_missing', () => {
    expect(isRequiredMethod('model/list')).toBe(false)
    expect(errorOf('model/list')).toMatchObject({ type: 'error', category: 'capability_missing' })
  })
})

// The adapter's readiness `mode` check, like Claude's: it fails only for a mode the vendor cannot run; a degraded mode
// passes there, since core's pass.<p>.mode (and pass.<p>.relay) already warn with the same copy. The composer showed
// each degraded Codex pass three times before.
describe("the Codex adapter's readiness mode check", () => {
  const need = (pass: 'implement' | 'review', mode: 'autoedit' | 'readonly') =>
    ({ pass, mode, planNative: false, trustFolder: false }) as const

  it('passes a degraded mode (exec: no relay; no sandbox: reviews from the diff)', async () => {
    const exec = createCodexAdapter({
      env: {},
      home: tmpdir(),
      platform: 'linux',
      initialFacts: { route: 'exec' },
    })
    expect(exec.support(need('implement', 'autoedit')).status).toBe('degraded')
    expect(await exec.readiness('/w', need('implement', 'autoedit'))).toEqual([
      expect.objectContaining({ id: 'pass.implement.readiness.mode', status: 'pass', blocking: false }),
    ])
    const noSandbox = createCodexAdapter({
      env: {},
      home: tmpdir(),
      platform: 'win32',
      initialFacts: { winSandbox: 'notConfigured' },
    })
    expect(noSandbox.support(need('review', 'readonly')).status).toBe('degraded')
    expect((await noSandbox.readiness('/w', need('review', 'readonly')))[0]).toMatchObject({ status: 'pass' })
  })

  it('fails a mode Codex cannot run, as sandbox_unavailable when the sandbox is the reason', async () => {
    const noSandbox = createCodexAdapter({
      env: {},
      home: tmpdir(),
      platform: 'win32',
      initialFacts: { winSandbox: 'notConfigured' },
    })
    expect((await noSandbox.readiness('/w', need('implement', 'autoedit')))[0]).toMatchObject({
      id: 'pass.implement.readiness.mode',
      status: 'fail',
      blocking: true,
      category: 'sandbox_unavailable',
    })
  })
})
