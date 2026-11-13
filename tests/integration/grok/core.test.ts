// The Grok adapter in a real core (an ACP adapter; the "More" list is every vendor whose resolve
// + `--version` succeeded; config only, no UI change): app-core registers Grok from the user file's vendors.grok in
// place of its registry stub, under "More" and not Experimental, re-creates it when that section changes, and
// vendors.setPath examines a picked grok. The binary is the fake at vendors.grok.path; nothing else is searched for.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { eof, exitFrame, fakeSetup, inReq, outRes, recording } from '../acp/adapter/helpers.ts'
import { hermeticEnv } from '../run/scenario.ts'
import { grokScenario, stdioScenario } from './helpers.ts'

const INITIALIZE = inReq(1, 'initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dim-factory', title: 'Dim Factory', version: '0.1.0' },
})
const initializeOnly = (): string =>
  recording({ scenario: 'grok-core', vendor: 'grok' }, [
    INITIALIZE,
    outRes(1, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
    eof(),
    exitFrame(0),
  ])

/** A CLI named grok that prints a bare version (a community Grok CLI): not Grok Build. */
const grokScenarioBareVersion = (): string => grokScenario([], { version: ['0.0.34'] })

const cores: Core[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
})

async function boot(grok: Record<string, unknown> | undefined): Promise<{ core: Core; home: string }> {
  const home = join(mkdtempSync(join(tmpdir(), 'grok-core-')), 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'dimfactory.json'),
    JSON.stringify({ vendors: grok !== undefined ? { grok } : {} }, null, 2),
  )
  const core = await createCore({
    home,
    host: { kind: 'cli' },
    env: hermeticEnv({ DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured' }),
  })
  cores.push(core)
  return { core, home }
}

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}

describe('Grok in a real core', () => {
  it('replaces its registry stub: built, under "More", not Experimental', async () => {
    const { core } = await boot(undefined)
    const entry = core.adapters.list().find((e) => e.id === 'grok')
    expect(entry).toMatchObject({ built: true, section: 'more', experimental: false })
    expect(core.adapters.primary().map((e) => e.id)).toEqual(['claude', 'codex'])
    // No path and only configured paths searched: Grok reads "Not installed", with (the commands table's Grok row)
    // its official install command to copy and its docs.
    const [view] = value(await core.invoke('vendors.probe', { vendor: 'grok' }))
    expect(view).toMatchObject({ vendor: 'grok', built: true, health: 'not-installed' })
    const bin = view?.probe?.checks.find((c) => c.id === 'vendor.grok.bin')
    expect(bin?.recovery.find((a) => a.id === 'grok.install')).toMatchObject({ kind: 'shell_copy' })
    expect(JSON.stringify(bin?.recovery)).toContain('https://github.com/xai-org/grok-build')
  })

  it('with vendors.grok.path at a working grok: listed with its version, ready with a key', async () => {
    const setup = await fakeSetup()
    const { core } = await boot({
      path: setup.launcher,
      env: { FAKE_CLI_SCRIPT: stdioScenario(initializeOnly()), XAI_API_KEY: 'xai-not-real' },
    })
    const [view] = value(await core.invoke('vendors.probe', { vendor: 'grok' }))
    expect(view).toMatchObject({
      vendor: 'grok',
      displayName: 'Grok',
      built: true,
      experimental: false,
      health: 'ready',
      healthDetail: 'Ready · 1.0.50',
    })
    expect(view?.probe?.capabilities.modes.autoedit.status).toBe('unsupported')
    const listed = value(await core.invoke('vendors.list')).find((v) => v.vendor === 'grok')
    expect(listed?.probe?.version).toBe('1.0.50')
  })

  it('vendors.setPath examines the picked file as Grok, saves it, re-creates the adapter and runs the Test probe', async () => {
    const setup = await fakeSetup()
    // The Test probe after a path is set starts a session (GR01's shape, signed in without a key).
    const forced = recording({ scenario: 'grok-core-test', vendor: 'grok' }, [
      INITIALIZE,
      outRes(1, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      outRes(2, { sessionId: '0199d2a4-7c1e-7a3b-9f20-3c4d5e6f7201' }),
      eof(),
      exitFrame(0),
    ])
    const { core } = await boot({ env: { FAKE_CLI_SCRIPT: stdioScenario(forced) } })
    const view = value(await core.invoke('vendors.setPath', { vendor: 'grok', path: setup.launcher }))
    expect(view).toMatchObject({ vendor: 'grok', health: 'ready' })
    expect(view.candidates).toEqual([setup.launcher])
    expect(view.probe?.checks.find((c) => c.id === 'vendor.grok.auth')?.detail).toMatch(/started a session/)

    // Another CLI named grok (a bare version) is refused and nothing is saved.
    const other = grokScenarioBareVersion()
    const second = await boot({ env: { FAKE_CLI_SCRIPT: other } })
    const refused = await second.core.invoke('vendors.setPath', { vendor: 'grok', path: setup.launcher })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toMatch(/VALIDATION/)
  })

  it('no sign-in Dim Factory can see: a warning until Test, still found, so "More" lists it', async () => {
    const setup = await fakeSetup()
    const { core } = await boot({
      path: setup.launcher,
      env: { FAKE_CLI_SCRIPT: stdioScenario(initializeOnly()) },
    })
    const [view] = value(await core.invoke('vendors.probe', { vendor: 'grok' }))
    expect(view).toMatchObject({ health: 'warning', healthDetail: 'Grok sign-in not checked' })
    expect(view?.probe?.version).toBe('1.0.50')
  })
})
