// Extensions through a real core: Settings writes (config.patch) a pass level and a vendor allow list to the project
// file, which the resolver reads back with provenance; a project file is refused a read-only pass's Pass through (the
// user file takes it); "Save to project" of a run override writes the level; extensions.discover reads names only,
// with each vendor's env (here temp CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME, never the real homes).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import { tempDir } from '../adapters/helpers.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  for (let attempt = 0; ; attempt++) {
    try {
      cleanup(...dirs.splice(0))
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 60 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw err
      await delay(250)
    }
  }
})

async function setUp(vendorEnv: Record<string, string> = {}) {
  const sc = await makeScenario({})
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  if (Object.keys(vendorEnv).length > 0) {
    const userFile = join(home, 'dimfactory.json')
    const user = JSON.parse(readFileSync(userFile, 'utf8')) as { vendors: Record<string, { env?: object }> }
    user.vendors['claude'] = {
      ...user.vendors['claude'],
      env: { ...user.vendors['claude']?.env, ...vendorEnv },
    }
    writeFileSync(userFile, JSON.stringify(user, null, 2))
  }
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return { core, home, folder, projectFile: join(folder, '.dimfactory', 'dimfactory.json') }
}

describe('Settings writes', () => {
  it('a level and an allow list go to the project file and resolve back with their provenance', async () => {
    const { core, folder, projectFile } = await setUp()
    const w = await core.invoke('config.patch', {
      scope: 'project',
      folder,
      ops: [
        { op: 'add', path: '/passes/review/extensions', value: 'allowed' },
        { op: 'add', path: '/extensions/allowed/claude/mcp', value: ['github'] },
      ],
    })
    if (!w.ok) throw new Error(w.error.message)
    expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual({
      passes: { review: { extensions: 'allowed' } },
      extensions: { allowed: { claude: { mcp: ['github'] } } },
    })
    const r = await core.invoke('config.resolve', { folder })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.config.passes.review.extensions).toBe('allowed')
    expect(r.value.config.extensions.allowed['claude']).toEqual({
      mcp: ['github'],
      skills: [],
      mcpWithoutAsking: [],
    })
    expect(r.value.provenance['/passes/review/extensions']?.source).toBe('project')
    expect(r.value.provenance['/extensions/allowed/claude/mcp']?.source).toBe('project')
  }, 60_000)

  it("a project file is refused a read-only pass's Pass through; the user file takes it", async () => {
    const { core, folder, home, projectFile } = await setUp()
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    writeFileSync(projectFile, '{}\n')
    const refused = await core.invoke('config.patch', {
      scope: 'project',
      folder,
      ops: [{ op: 'add', path: '/passes/review/extensions', value: 'passthrough' }],
    })
    expect(refused.ok).toBe(false)
    expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual({})
    const user = await core.invoke('config.patch', {
      scope: 'user',
      ops: [{ op: 'add', path: '/passes/review/extensions', value: 'passthrough' }],
    })
    if (!user.ok) throw new Error(user.error.message)
    const saved = JSON.parse(readFileSync(join(home, 'dimfactory.json'), 'utf8')) as {
      passes: { review: { extensions: string } }
    }
    expect(saved.passes.review.extensions).toBe('passthrough')
    const r = await core.invoke('config.resolve', { folder })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.config.passes.review.extensions).toBe('passthrough')
    expect(r.value.provenance['/passes/review/extensions']?.source).toBe('user')
  }, 60_000)

  it('"Save to project" writes a run override level', async () => {
    const { core, folder, projectFile } = await setUp()
    const r = await core.invoke('config.save', {
      scope: 'project',
      folder,
      mode: 'row',
      pass: 'critic',
      overrides: { passes: { critic: { extensions: 'allowed' } } },
    })
    if (!r.ok) throw new Error(r.error.message)
    expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual({
      passes: { critic: { extensions: 'allowed' } },
    })
  }, 60_000)
})

describe('extensions.discover', () => {
  it("reads each vendor's own settings with its env: names and scopes only", async () => {
    const claudeDir = tempDir('discover-claude-')
    writeFileSync(
      join(claudeDir, '.claude.json'),
      JSON.stringify({
        primaryApiKey: 'sk-ant-api03-NOTREAD',
        mcpServers: { github: { command: 'gh', env: { T: 'secret' } } },
      }),
    )
    const { core, folder } = await setUp({ CLAUDE_CONFIG_DIR: claudeDir })
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: { url: 'https://t.example' } } }),
    )
    const r = await core.invoke('extensions.discover', { folder })
    if (!r.ok) throw new Error(r.error.message)
    const claude = r.value.vendors.find((v) => v.vendor === 'claude')
    expect(claude?.mcp).toEqual([
      { name: 'team', scope: 'project', allowable: true },
      { name: 'github', scope: 'user', allowable: true },
    ])
    expect(JSON.stringify(r.value)).not.toMatch(/secret|NOTREAD|https:\/\/t\.example|"gh"/)
    expect(r.value.vendors.map((v) => v.vendor)).toEqual(['claude', 'codex', 'gemini'])
  }, 60_000)
})
