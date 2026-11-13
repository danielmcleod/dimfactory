// vendors.setPath / vendors.models with the real core, the real resolver and the fake `claude` (Settings → Vendors
// "path (Change / Auto-detect / candidates)", `vendors.<id>.path`, "a vendor path change"
// drops the vendor's cached results): a path the resolver accepts as Claude is saved to the user file (a minimal
// diff with a backup), the adapter is re-created from it and probed with force; a path it rejects is VALIDATION with
// the resolver's reason and nothing is saved. Only the picked file is examined: no other candidate is searched or
// started. vendors.models lists the probe's models (initialize-only, no tokens) with the catalog's pricing flags.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { claudeCliSpec } from '../../../src/core/adapters/claude/cli-spec.ts'
import { homePaths } from '../../../src/core/home.ts'
import { validateCliPath } from '../../../src/core/recovery/vendor-path.ts'
import { resolvePathEnv } from '../../../src/core/proc/path-env.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanup, fakeClaudePath, hermeticEnv, makeHome, makeScenario, passArgvs } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

/** A home whose dimfactory.json configures vendors.claude.env (the fake's scenario) but no path. */
async function homeWithoutPath() {
  const sc = await makeScenario({})
  const { home, claudeConfigDir } = await makeHome(sc)
  const file = join(home, 'dimfactory.json')
  const text = `{\n  // vendors.claude.env points the fake at its scenario\n  "vendors": {\n    "claude": {\n      "env": ${JSON.stringify(
    { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
  )}\n    }\n  }\n}\n`
  writeFileSync(file, text)
  dirs.push(home, sc.dir)
  return { sc, home, file, text }
}

describe('vendors.setPath', () => {
  it('saves a path the resolver accepts as Claude, re-creates the adapter and probes it with force', async () => {
    const { sc, home, file, text } = await homeWithoutPath()
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const fake = await fakeClaudePath()

    const view = value(await core.invoke('vendors.setPath', { vendor: 'claude', path: fake }))
    expect(view).toMatchObject({ vendor: 'claude', health: 'ready', checking: false })
    expect(view.probe?.binary?.path.toLowerCase()).toBe(fake.toLowerCase())
    expect(view.probe?.binary?.source).toBe('config')
    // Saved as a minimal edit: the comment and the env stay, the path is added; a backup was written.
    const saved = readFileSync(file, 'utf8')
    expect(saved).toContain('// vendors.claude.env points the fake at its scenario')
    const parsed = JSON.parse(saved.replace(/^\s*\/\/.*$/m, '')) as {
      vendors: { claude: Record<string, unknown> }
    }
    expect(parsed.vendors.claude['path']).toBe(fake)
    const before = JSON.parse(text.replace(/^\s*\/\/.*$/m, '')) as typeof parsed
    expect(parsed.vendors.claude['env']).toEqual(before.vendors.claude['env'])
    expect(readdirSync(homePaths(home).backupsDir, { recursive: true }).length).toBeGreaterThan(0)
    // The probe store has it (vendor health follows), and the configured binary is what runs now.
    expect(core.preflight.cache.vendor('claude')?.stale).toBe(false)
    expect(core.settings.vendors['claude']?.path).toBe(fake)
    // Probes only: --version (validation and probe), auth status, the initialize-only handshake; no pass.
    expect(passArgvs(sc.entries())).toEqual([])
    const listed = value(await core.invoke('vendors.list'))
    expect(listed.find((v) => v.vendor === 'claude')?.health).toBe('ready')
  }, 120_000)

  it("refuses a relative, missing or non-Claude path with the resolver's reason and saves nothing", async () => {
    const { sc, home, file, text } = await homeWithoutPath()
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const notes = join(home, 'tools')
    mkdirSync(notes)
    const txt = join(notes, process.platform === 'win32' ? 'claude.exe' : 'claude')
    writeFileSync(txt, 'not a program\n')
    const cases: [string, RegExp][] = [
      ['claude', /is not an absolute path/],
      [join(home, 'no-such-claude'), /does not exist/],
      [notes, /is not a file/],
      [txt, /.+/],
    ]
    for (const [path, reason] of cases) {
      const r = await core.invoke('vendors.setPath', { vendor: 'claude', path })
      expect(r.ok, path).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('VALIDATION')
      expect(r.error.message).toMatch(reason)
    }
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(core.preflight.cache.probe('claude')).toBeUndefined()
    // Nothing was started for these: the fake never ran.
    expect(sc.entries().filter((e) => e.kind === 'start')).toEqual([])
  }, 120_000)

  it('validates only the picked file (configured candidate), never another install', async () => {
    const fake = await fakeClaudePath()
    const env = hermeticEnv()
    const pe = await resolvePathEnv({ env })
    const ran: string[] = []
    const ok = await validateCliPath(claudeCliSpec, fake, {
      env,
      pathEnv: pe.path,
      run: (command, args) => {
        ran.push([command, ...args].join(' '))
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: '2.1.289 (Claude Code)\n',
          stderr: '',
          timedOut: false,
          ms: 1,
        })
      },
    })
    expect(ok).toMatchObject({ ok: true, version: '2.1.289' })
    expect(ran).toHaveLength(1)
    const bad = await validateCliPath(claudeCliSpec, fake, {
      env,
      pathEnv: pe.path,
      run: () =>
        Promise.resolve({ code: 0, signal: null, stdout: '1.0.0\n', stderr: '', timedOut: false, ms: 1 }),
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toMatch(/not claude/)
  }, 60_000)
})

describe('vendors.models', () => {
  it("lists the initialize handshake's models with the default marked and pricing flags, spending no tokens", async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const models = value(await core.invoke('vendors.models', { vendor: 'claude' }))
    expect(models.length).toBeGreaterThan(0)
    const cli = models.filter((m) => m.source === 'cli')
    expect(cli.length).toBeGreaterThan(0)
    expect(models.filter((m) => m.isDefault === true)).toHaveLength(1)
    expect(models.find((m) => m.isDefault === true)?.source).toBe('cli')
    // The seeded catalog prices the built-in profile models (opus, sonnet).
    expect(models.find((m) => m.id === 'opus')?.hasPricing).toBe(true)
    expect(models.every((m) => typeof m.hasPricing === 'boolean')).toBe(true)
    // The probe was stored: a second call does not start the CLI again; force does.
    const starts = (): number => sc.entries().filter((e) => e.kind === 'start').length
    const before = starts()
    value(await core.invoke('vendors.models', { vendor: 'claude' }))
    expect(starts()).toBe(before)
    value(await core.invoke('vendors.models', { vendor: 'claude', force: true }))
    expect(starts()).toBeGreaterThan(before)
    expect(passArgvs(sc.entries())).toEqual([])
  }, 120_000)
})
