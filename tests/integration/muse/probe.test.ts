// probe() of the Muse adapter through the real resolver and the fake CLI (the Muse probe checks:
// bin resolve; version record; auth META_API_KEY; protocol "schema hash vs pinned (warn)"; plan emulated). Token-free:
// `--version`, `exec --help` and the schema command, nothing else; Muse's own files are never read.
import { describe, expect, it } from 'vitest'
import { MUSE_PIN, schemaHash } from '../../../src/core/adapters/muse/protocol.ts'
import { createMuseAdapter } from '../../../src/core/adapters/muse/index.ts'
import type { CheckResult } from '../../../src/shared/preflight.ts'
import type { ScenarioEntry } from './helpers.ts'
import {
  EXEC_HELP,
  HELP_ENTRY,
  SCHEMA_ENTRY,
  SCHEMA_JSON,
  fakeMuse,
  fakeSetup,
  hermeticEnv,
  scenario,
  tempDir,
} from './helpers.ts'

const byId = (checks: readonly CheckResult[], id: string): CheckResult | undefined =>
  checks.find((c) => c.id === id)

describe('Muse probe', () => {
  it('resolves the fake, records its version, warns on the unpinned schema and on a missing META_API_KEY', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([HELP_ENTRY, SCHEMA_ENTRY]))
    const r = await fake.adapter.probe()
    expect(r).toMatchObject({
      vendor: 'muse',
      route: 'exec',
      transport: 'muse-exec',
      ok: true,
      version: '1.4.2-R4102.1',
    })
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['vendor.muse.bin', 'pass'],
      ['vendor.muse.version', 'pass'],
      ['vendor.muse.auth', 'warn'],
      ['vendor.muse.protocol', 'warn'],
      ['vendor.muse.plan', 'skip'],
    ])
    const protocol = byId(r.checks, 'vendor.muse.protocol')!
    expect(protocol.title).toBe("Muse's event shapes are not pinned yet")
    expect(protocol.detail).toContain(`sha256 ${schemaHash(SCHEMA_JSON).slice(0, 12)}`)
    expect(protocol.detail).toContain('No tokens spent.')
    expect(protocol.blocking).toBe(false)
    expect(byId(r.checks, 'vendor.muse.auth')?.recovery.map((a) => a.id)).toEqual([
      'muse.login',
      'muse.switch-vendor',
    ])
    // Static models, Experimental capabilities: no relay, emulated plan, readonly unsupported, Fix fresh.
    expect(r.models).toEqual([
      { id: 'muse-spark-1.2', label: 'Muse Spark 1.2', isDefault: true, source: 'static' },
    ])
    expect(r.capabilities).toMatchObject({ planMode: 'emulated', askRelay: false, resume: 'none' })
    expect(r.capabilities.modes.readonly.status).toBe('unsupported')
    expect(r.capabilities.modes.autoedit.status).toBe('degraded')
    expect(r.capabilities.modes.full.status).toBe('supported')
    expect(r.account).toBeUndefined()
    // Only the token-free commands ran: --version (the resolver), exec --help and one schema command.
    const runs = fake.starts()
    expect(runs.every((a) => a.includes('--version') || a.includes('--help') || a[0] === 'schema')).toBe(true)
    expect(runs.some((a) => a.includes('--json'))).toBe(false)
  })

  it('META_API_KEY in the env signs Muse in (method api-key, the value never read into the result)', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([HELP_ENTRY, SCHEMA_ENTRY]), {
      env: { META_API_KEY: 'mk-test-123' },
    })
    const r = await fake.adapter.probe()
    expect(byId(r.checks, 'vendor.muse.auth')).toMatchObject({ status: 'pass', title: 'Signed in' })
    expect(r.account).toEqual({ method: 'api-key' })
    expect(JSON.stringify(r)).not.toContain('mk-test-123')
  })

  it('a pinned live schema that matches passes the protocol check', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([HELP_ENTRY, SCHEMA_ENTRY]), {
      adapter: { pin: { ...MUSE_PIN, synthesized: false, liveSchemaSha256: schemaHash(SCHEMA_JSON) } },
    })
    const r = await fake.adapter.probe()
    expect(byId(r.checks, 'vendor.muse.protocol')).toMatchObject({ status: 'pass' })
  })

  it('falls back to `muse schema` when `schema generate-json-schema` is a usage error', async () => {
    const setup = await fakeSetup()
    const entries: ScenarioEntry[] = [
      HELP_ENTRY,
      {
        match: { argvIncludes: ['generate-json-schema'] },
        script: [
          { op: 'stderr', line: "error: unrecognized subcommand 'generate-json-schema'" },
          { op: 'exit', code: 2 },
        ],
        repeat: true,
      },
      SCHEMA_ENTRY,
    ]
    const fake = fakeMuse(setup, scenario(entries))
    const r = await fake.adapter.probe()
    expect(byId(r.checks, 'vendor.muse.protocol')?.detail).toContain('`muse schema` (sha256')
  })

  it('an exec without --prompt-file fails the protocol check (flag_drift, blocking): every pass would be refused', async () => {
    const setup = await fakeSetup()
    const help: ScenarioEntry = {
      match: { argvIncludes: ['exec', '--help'] },
      script: [
        ...EXEC_HELP.split('\n')
          .filter((l) => !l.includes('--prompt-file'))
          .map((line) => ({ op: 'stdout', line })),
        { op: 'exit', code: 0 },
      ],
      repeat: true,
    }
    const fake = fakeMuse(setup, scenario([help, SCHEMA_ENTRY]))
    const r = await fake.adapter.probe()
    expect(r.ok).toBe(false)
    expect(byId(r.checks, 'vendor.muse.protocol')).toMatchObject({
      status: 'fail',
      blocking: true,
      category: 'flag_drift',
    })
    expect(byId(r.checks, 'vendor.muse.protocol')?.detail).toContain('--prompt-file')
  })

  it('no schema at all is a warning, never a block', async () => {
    const setup = await fakeSetup()
    const noSchema: ScenarioEntry = {
      match: { argvIncludes: ['schema'] },
      script: [
        { op: 'stderr', line: 'error: unknown command' },
        { op: 'exit', code: 2 },
      ],
      repeat: true,
    }
    const fake = fakeMuse(setup, scenario([HELP_ENTRY, noSchema]))
    const r = await fake.adapter.probe()
    expect(r.ok).toBe(true)
    expect(byId(r.checks, 'vendor.muse.protocol')).toMatchObject({
      status: 'warn',
      title: 'Muse: could not read its schema',
    })
  })

  it('refused extraArgs fail the protocol check with a settings link (config_invalid)', async () => {
    const setup = await fakeSetup()
    const fake = fakeMuse(setup, scenario([HELP_ENTRY, SCHEMA_ENTRY]), {
      adapter: { extraArgs: ['--approval-mode', 'on-request'] },
    })
    const r = await fake.adapter.probe()
    expect(byId(r.checks, 'vendor.muse.protocol')).toMatchObject({
      status: 'fail',
      category: 'config_invalid',
    })
    expect(byId(r.checks, 'vendor.muse.protocol')?.recovery.map((a) => a.kind)).toEqual(['settings_link'])
  })

  it('a configured path that is missing is "not installed" with the install command; nothing else is searched', async () => {
    const adapter = createMuseAdapter({
      configuredPath: `${tempDir('muse-none-')}/muse.exe`,
      search: 'configured',
      env: hermeticEnv(),
      home: tempDir('muse-userhome-'),
      dimFactoryHome: tempDir('muse-home-'),
      probeCwd: tempDir('muse-probe-'),
      pathEnv: '',
    })
    const r = await adapter.probe()
    expect(r.ok).toBe(false)
    expect(r.checks.map((c) => c.id)).toEqual(['vendor.muse.bin'])
    expect(r.checks[0]).toMatchObject({ status: 'fail', category: 'cli_missing' })
    expect(r.checks[0]?.recovery.map((a) => a.id)).toEqual([
      'muse.install',
      'muse.set-path',
      'muse.switch-vendor',
      'muse.docs',
    ])
  })
})
