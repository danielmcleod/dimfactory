// Wire-up through a real core (the E2E layer's fake CLIs via `vendors.<id>.path`; the local preset's models
// from `GET {baseUrl}/models`, loopback only):
//   - the E2E-only hook DIM_FACTORY_E2E_VENDOR_SEARCH=configured (with DIM_FACTORY_E2E=1): vendor CLIs are looked up only
//     at their configured paths, so an E2E app never finds, probes or runs a real install (Codex without a path reads
//     "not installed", with a Codex on PATH)
//   - vendors.models for `local-<id>` lists the preset's own server (source local-server), never Codex's models
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { readFakeLog } from '../../../fake-cli/harness.ts'
import { cleanup, hermeticEnv } from '../../run/scenario.ts'

const cores: Core[] = []
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  cleanup(...dirs.splice(0))
})

function home(config: object): string {
  const root = mkdtempSync(join(tmpdir(), 'dim-run-wire-'))
  dirs.push(root)
  const h = join(root, 'home')
  mkdirSync(h, { recursive: true })
  writeFileSync(join(h, 'dimfactory.json'), JSON.stringify(config, null, 2))
  return h
}

async function boot(h: string, env: Record<string, string>): Promise<Core> {
  const core = await createCore({ home: h, host: { kind: 'app' }, env: hermeticEnv(env) })
  cores.push(core)
  return core
}

describe('DIM_FACTORY_E2E_VENDOR_SEARCH=configured', () => {
  it('finds a vendor only at its configured path: a Codex on PATH is never run', async () => {
    const build = await buildFakeCli()
    const launcher = process.platform === 'win32' ? build.launchers.cmd?.codex : build.launchers.sh?.codex
    if (launcher === undefined) throw new Error('no fake codex launcher')
    const h = home({ profile: 'claude-only' })
    const log = join(dirname(h), 'codex.log.jsonl')
    // The fake codex is first on PATH, and would log if anything started it.
    const env = {
      PATH: [build.dir, dirname(process.execPath), process.env['PATH'] ?? ''].join(delimiter),
      FAKE_CLI_LOG: log,
      DIM_FACTORY_E2E: '1',
      DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured',
    }
    const core = await boot(h, env)
    const probe = await core.adapters.get('codex')?.probe({ force: true })
    expect(probe?.ok).toBe(false)
    expect(probe?.checks[0]).toMatchObject({
      id: 'vendor.codex.bin',
      status: 'fail',
      category: 'cli_missing',
      detail: 'No Codex CLI was found on this computer.',
    })
    expect(readFakeLog(log)).toEqual([])
    const probed = await core.invoke('vendors.probe', { vendor: 'codex', force: true })
    expect(probed.ok && probed.value.find((v) => v.vendor === 'codex')?.health).toBe('not-installed')
    expect(readFakeLog(log)).toEqual([])
  }, 60_000)
})

describe('vendors.models for a local preset', () => {
  it("lists the preset's own server (loopback), never Codex's models; an unknown preset is NOT_FOUND", async () => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder' }, { id: 'llama3.3' }] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const h = home({
      profile: 'claude-only',
      local: {
        presets: [
          { id: 'ollama', label: 'Ollama', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen3-coder' },
        ],
      },
    })
    const core = await boot(h, { DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured' })
    const r = await core.invoke('vendors.models', { vendor: 'local-ollama' })
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
    expect(r.value.map((m) => [m.id, m.source, m.isDefault === true])).toEqual([
      ['qwen3-coder', 'local-server', true],
      ['llama3.3', 'local-server', false],
    ])
    const unknown = await core.invoke('vendors.models', { vendor: 'local-nope' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
  }, 60_000)
})
