// "Fake `auth status` exit 1 → Run disabled → copy → Re-check enables Run", with the
// real core, the real Claude adapter and the fake `claude` whose `auth status` answers "not logged in" (exit 1) until
// its scenario file is swapped (the user ran `claude auth login`):
//   preflight.run blocks with vendor.claude.auth and a shell_copy login action → recovery.execute copies it (through
//   main's recovery host, into a fake clipboard) → swap → Re-check = vendors.probe{force} → preflight.run is ok.
// The run's own path: runs.start re-checks a failed login in the authoritative preflight, so it starts once the user
// has logged in, without a forced probe first.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { runButtonReasons } from '../../../src/core/preflight/engine.ts'
import { withRecoveryHost } from '../../../src/main/recovery-host.ts'
import type { Cmd, Result } from '../../../src/shared/ipc.ts'
import type { PreflightReport } from '../../../src/shared/preflight.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario, passArgvs } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const LOGGED_OUT = [
  { op: 'stdout', line: '{' },
  { op: 'stdout', line: '  "loggedIn": false,' },
  { op: 'stdout', line: '  "authMethod": "none",' },
  { op: 'stdout', line: '  "apiProvider": "firstParty"' },
  { op: 'stdout', line: '}' },
  { op: 'exit', code: 1 },
]

interface Entry {
  match: { argvIncludes?: string[] }
  script: string
  repeat?: boolean
}

/** A scenario whose `auth status` fails; `login()` swaps it back to the recorded logged-in answer. */
async function loggedOutScenario(spec: Parameters<typeof makeScenario>[0] = {}) {
  const sc = await makeScenario(spec)
  const file = join(sc.dir, 'scenario.json')
  const original = readFileSync(file, 'utf8')
  const entries = JSON.parse(original) as Entry[]
  const auth = entries.find((e) => e.match.argvIncludes?.join(' ') === 'auth status')
  if (auth === undefined) throw new Error('scenario has no auth status entry')
  const failing = join(sc.dir, 'auth-logged-out.script.jsonl')
  writeFileSync(failing, `${LOGGED_OUT.map((o) => JSON.stringify(o)).join('\n')}\n`)
  auth.script = failing
  writeFileSync(file, JSON.stringify(entries, null, 2))
  return { sc, login: () => writeFileSync(file, original) }
}

async function boot(home: string): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return core
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

const CLAUDE_ONLY = { profile: 'claude-only' }

describe('copy the login command → Re-check enables Run', () => {
  it('preflight blocks on vendor.claude.auth, the copy lands on the clipboard, Re-check clears it', async () => {
    const { sc, login } = await loggedOutScenario()
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await boot(home)

    // The launch probe (app start): Claude needs a login.
    const probed = value(await core.invoke('vendors.probe', { vendor: 'claude' }))
    expect(probed[0]).toMatchObject({ vendor: 'claude', health: 'login-needed' })

    // The composer's live preflight: Run disabled, the login first among the reasons.
    const blocked: PreflightReport = value(
      await core.invoke('preflight.run', { folder, overrides: CLAUDE_ONLY }),
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.blocking[0]).toMatchObject({ id: 'vendor.claude.auth', category: 'auth_required' })
    expect(runButtonReasons(blocked).length).toBeGreaterThan(0)
    expect(runButtonReasons(blocked).length).toBeLessThanOrEqual(3)
    const action = blocked.blocking[0]?.recovery.find((a) => a.kind === 'shell_copy')
    expect(action).toMatchObject({
      id: 'claude.login',
      kind: 'shell_copy',
      command: 'claude auth login',
      recheck: 'vendor.claude.auth',
    })

    // Copy: core answers the command, main writes it to the clipboard (a fake Electron clipboard here).
    const clipboard: string[] = []
    const invoke = withRecoveryHost(
      (cmd: Cmd, req: unknown) =>
        (core.invoke as (c: Cmd, r: unknown) => Promise<Result<unknown>>).call(core, cmd, req),
      { writeClipboard: (t) => void clipboard.push(t), openExternal: () => Promise.resolve() },
    )
    const copied = await invoke('recovery.execute', { actionId: 'claude.login', folder })
    expect(copied).toEqual({
      ok: true,
      value: {
        kind: 'shell_copy',
        copied: 'claude auth login',
        message: 'Copied. Run it in a terminal, then re-check.',
      },
    })
    expect(clipboard).toEqual(['claude auth login'])
    expect(core.preflight.cache.pendingRechecks).toEqual(['vendor.claude.auth'])

    // Re-check before the user ran it: still blocked.
    value(await core.invoke('vendors.probe', { vendor: 'claude', force: true }))
    const still: PreflightReport = value(
      await core.invoke('preflight.run', { folder, overrides: CLAUDE_ONLY }),
    )
    expect(still.blocking[0]?.id).toBe('vendor.claude.auth')

    // The user ran `claude auth login`; "I ran it → Re-check" = forced token-free probe, then preflight.run.
    login()
    const rechecked = value(await core.invoke('vendors.probe', { vendor: 'claude', force: true }))
    expect(rechecked[0]).toMatchObject({ vendor: 'claude', health: 'ready' })
    const ok: PreflightReport = value(await core.invoke('preflight.run', { folder, overrides: CLAUDE_ONLY }))
    expect(ok.blocking).toEqual([])
    expect(ok.ok).toBe(true)
    expect(core.preflight.cache.pendingRechecks).toEqual([])
    // The copied action is gone from the new report: executing it again is stale.
    const stale = await core.invoke('recovery.execute', { actionId: 'claude.login', folder })
    expect(stale.ok === false && stale.error.code).toBe('NOT_FOUND')
    // No pass ever ran (probes and auth checks only).
    expect(passArgvs(sc.entries())).toEqual([])
  }, 120_000)

  it("runs.start re-checks a failed login itself: the run's Recheck works without a forced probe", async () => {
    const { sc, login } = await loggedOutScenario({ plan: { recording: 'C06-plan-native-host' } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await boot(home)
    value(await core.invoke('vendors.probe', { vendor: 'claude' }))

    const refused = await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: CLAUDE_ONLY,
    })
    expect(refused.ok === false && refused.error.code).toBe('PREFLIGHT_BLOCKED')
    // The blocked report's fixes are executable from the composer.
    const copied = await core.invoke('recovery.execute', { actionId: 'claude.login', folder })
    expect(copied.ok && copied.value.copied).toBe('claude auth login')

    const pushed: string[] = []
    core.bus.attach({
      name: 't',
      global: (ev) => {
        if (ev.kind === 'probe' && ev.vendor === 'claude') pushed.push(ev.view.health)
      },
    })
    login()
    const started = value(
      await core.invoke('runs.start', { folder, task: 'add a --version flag', overrides: CLAUDE_ONLY }),
    )
    expect(started.runId).toMatch(/./)
    // The run's re-check of the login is what vendor health shows now (not the launch probe's failure), and it
    // was pushed: the setup card, the vendor rows and Settings → Vendors say Claude is ready.
    const claude = value(await core.invoke('vendors.list')).find((v) => v.vendor === 'claude')
    expect(claude?.health).toBe('ready')
    expect(claude?.probe?.ok).toBe(true)
    const dash = value(await core.invoke('dashboard.get'))
    expect(dash.vendorHealth.find((v) => v.vendor === 'claude')?.health).toBe('ready')
    expect(pushed).toContain('ready')
    value(await core.invoke('runs.stop', { runId: started.runId }))
  }, 120_000)
})
