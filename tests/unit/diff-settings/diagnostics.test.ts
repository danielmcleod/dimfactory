// Diagnostics (Settings → Diagnostics, Copy diagnostics with raw lines opt-in; IPC
// diagnostics.build / copy / save): src/main/diagnostics.ts builds a redacted plain-text bundle (versions, paths,
// platform, vendor summaries, config validity, storage, recent runs, recent log lines), counts each redaction rule,
// never prints credentials, account details or environment values, adds raw vendor lines only on request, copies
// through the injected clipboard and saves through the dialog (or the E2E path).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { createMemoryLogger } from '../../../src/core/log.ts'
import { createMainHandlers } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import {
  createDiagnostics,
  buildDiagnostics,
  formatBytes,
  redactDiagnosticLine,
} from '../../../src/main/diagnostics.ts'
import type { DiagnosticsSources } from '../../../src/main/diagnostics.ts'
import type { AppInfo, ConfigReadResult, Result, StorageUsage } from '../../../src/shared/ipc.ts'
import type { RunSummary } from '../../../src/shared/run.ts'
import type { ProbeView } from '../../../src/shared/vendors.ts'

const RUN = '20261008T120000Z-diag'
const OS_HOME = 'C:\\Users\\alice'
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

const INFO: AppInfo = {
  name: 'Dim Factory',
  version: '1.0.0',
  platform: 'win32',
  arch: 'x64',
  versions: { electron: '44.5.1', chrome: '140.0', node: '24.1.0' },
  home: `${OS_HOME}\\.dimfactory`,
  logsDir: `${OS_HOME}\\.dimfactory\\logs`,
  packaged: false,
  e2e: false,
  ipcProtocol: 1,
  git: { path: 'git', version: '2.55.0' },
  notifications: { aumid: true, clsid: false },
}

const VENDORS = [
  {
    vendor: 'claude',
    displayName: 'Claude',
    built: true,
    experimental: false,
    health: 'ready',
    healthDetail: 'Ready · 2.1.288',
    checking: false,
    versionFloor: '2.1.0',
    versionRecommended: null,
    testedUpTo: '2.1.290',
    candidates: [],
    probe: {
      vendor: 'claude',
      at: 1,
      ok: true,
      route: 'native',
      version: '2.1.288',
      checks: [{ id: 'vendor.claude.auth', status: 'pass', title: 'Signed in', detail: 'alice@example.com' }],
      capabilities: {},
      models: [],
      account: { email: 'alice@example.com' },
    },
  },
] as unknown as ProbeView[]

const CONFIG: ConfigReadResult = {
  path: `${OS_HOME}\\.dimfactory\\dimfactory.json`,
  exists: true,
  text: `{ "vendors": { "claude": { "env": { "ANTHROPIC_API_KEY": "${SECRET}" } } } }`,
  value: null,
  issues: [
    {
      file: `${OS_HOME}\\.dimfactory\\dimfactory.json`,
      pointer: '/gates/afterPlan',
      line: 3,
      col: 17,
      endLine: 3,
      endCol: 22,
      code: 'invalid_type',
      message: 'Expected boolean',
      severity: 'error',
    },
  ],
  version: 1,
  backups: [],
}

const USAGE: StorageUsage = {
  home: `${OS_HOME}\\.dimfactory`,
  totalBytes: 5 * 1024 * 1024,
  freeBytes: 20 * 1024 * 1024 * 1024,
  runs: { count: 1, bytes: 1024 },
  shadows: [{ folderKey: '0123456789abcdef', path: `${OS_HOME}\\proj`, bytes: 4096 }],
  worktrees: { count: 0, bytes: 0 },
  catalogBytes: 10,
  logsBytes: 20,
}

const SUMMARY = {
  runId: RUN,
  displayNo: 7,
  folder: `${OS_HOME}\\proj`,
  folderKey: '0123456789abcdef',
  title: 'secret task text',
  status: 'failed',
  phase: 'needs-attention',
  failure: { step: 'implement', category: 'auth_expired' },
  profile: 'claude-only',
  auto: false,
  steps: [{ key: 'implement', status: 'failed', activeMs: 1, failureCategory: 'auth_expired' }],
} as unknown as RunSummary

function sources(): DiagnosticsSources & { calls: string[] } {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  const calls: string[] = []
  const answers: Record<string, unknown> = {
    'vendors.list': VENDORS,
    'config.read': CONFIG,
    'storage.usage': USAGE,
    'runs.list': { items: [SUMMARY], nextCursor: null },
    'runs.get': { summary: SUMMARY, notes: ['Implement failed: login expired'] },
  }
  const invoke = (cmd: string): Promise<Result<unknown>> => {
    calls.push(cmd)
    return Promise.resolve(
      cmd in answers
        ? { ok: true, value: answers[cmd] }
        : { ok: false, error: { code: 'UNSUPPORTED', message: `${cmd} is not available` } },
    )
  }
  return {
    core: { paths, invoke } as unknown as DiagnosticsSources['core'],
    appInfo: () => Promise.resolve(INFO),
    now: () => Date.UTC(2026, 9, 8, 12, 0, 0),
    redact: { home: OS_HOME, username: 'alice', hostname: 'ALICE-PC' },
    calls,
  }
}

function writeLogs(): void {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  mkdirSync(paths.logsDir, { recursive: true })
  const lines = [
    JSON.stringify({ ts: 1, level: 'info', msg: 'boot', part: 'main', home: `${OS_HOME}\\.dimfactory` }),
    JSON.stringify({ ts: 2, level: 'warn', msg: 'spawn', env: { PATH: 'C:\\secret-path', FOO: 'bar' } }),
    JSON.stringify({ ts: 3, level: 'error', msg: `auth failed for alice@example.com with ${SECRET}` }),
    'not json: Bearer abcdefghijklmnop on ALICE-PC',
  ]
  writeFileSync(paths.log('main'), `${lines.join('\n')}\n`)
  const raw = join(paths.run(RUN).dir, 'raw')
  mkdirSync(raw, { recursive: true })
  writeFileSync(
    join(raw, 'implement-1.ndjson'),
    `${JSON.stringify({ t: 1, dir: 'out', line: JSON.stringify({ type: 'system', apiKey: 'xyz-123-secret', cwd: `${OS_HOME}\\proj` }) })}\n`,
  )
}

describe('diagnostics bundle', () => {
  it('has versions, paths, vendors, config issues, storage, runs and log lines, all redacted', async () => {
    writeLogs()
    const b = await buildDiagnostics(sources())
    const t = b.text
    expect(t).toContain('Dim Factory 1.0.0 · packaged: no')
    expect(t).toContain('Electron 44.5.1 · Chrome 140.0 · Node 24.1.0')
    expect(t).toContain('git 2.55.0 (git)')
    expect(t).toContain('Platform win32 x64')
    expect(t).toContain('AUMID set · CLSID missing')
    expect(t).toContain('Home: ~\\.dimfactory')
    expect(t).toContain('claude (Claude): ready · Ready · 2.1.288 · version 2.1.288 · route native')
    expect(t).toContain('pass vendor.claude.auth: Signed in')
    expect(t).toContain('User file ~\\.dimfactory\\dimfactory.json: 1 error')
    expect(t).toContain('error ~\\.dimfactory\\dimfactory.json:3:17 Expected boolean')
    expect(t).toContain('Total 5.0 MB · free on disk 20.0 GB')
    expect(t).toContain('Snapshots 0123456789abcdef: ~\\proj (4.0 KB)')
    expect(t).toContain(
      '#7 20261008T120000Z-diag · failed · needs-attention · failed at implement: auth_expired',
    )
    expect(t).toContain('[env omitted]')
    // Never: credentials, account details, env values, the config text, the task, machine names.
    for (const secret of [
      SECRET,
      'alice@example.com',
      'C:\\secret-path',
      'ANTHROPIC_API_KEY',
      'secret task text',
    ]) {
      expect(t).not.toContain(secret)
    }
    expect(t).not.toMatch(/alice|ALICE-PC/i)
    expect(t).not.toContain('—')
    expect(b.redactions).toMatchObject({ 'anthropic-key': 1, email: 1, env: 1, bearer: 1, hostname: 1 })
    expect(b.redactions['home']).toBeGreaterThan(0)
    // Raw vendor lines only on request.
    expect(t).not.toContain('Raw vendor lines')
    expect(t).not.toContain('xyz-123-secret')
  })

  it('adds the run and its raw vendor lines (redacted) when asked', async () => {
    writeLogs()
    const src = sources()
    const b = await buildDiagnostics(src, { runId: RUN, includeRaw: true })
    expect(b.text).toContain(`Run ${RUN}`)
    expect(b.text).toContain('Note: Implement failed: login expired')
    expect(b.text).toContain('Raw vendor lines (included on request)')
    expect(b.text).toContain('implement-1.ndjson')
    expect(b.text).toContain('out {"type":"system","apiKey":"[REDACTED]","cwd":"~\\\\proj"}')
    expect(b.text).not.toContain('xyz-123-secret')
    expect(b.redactions['secret-key']).toBeGreaterThanOrEqual(1)
    expect(src.calls).toContain('runs.get')
    // The run's project file is read too.
    expect(src.calls.filter((c) => c === 'config.read')).toHaveLength(2)
  })

  it('without a run it reads raw lines from the most recent one, and says when there are none', async () => {
    const b = await buildDiagnostics(sources(), { includeRaw: true })
    expect(b.text).toContain(`Run ${RUN}`)
    expect(b.text).toContain('No raw vendor lines were recorded for this run.')
    expect(b.text).toContain('Recent log lines (main.log, last 100)\n  None')
  })

  it('a command that fails becomes a line, not a failed bundle', async () => {
    const src = sources()
    const invoke = src.core.invoke
    src.core = {
      ...src.core,
      invoke: ((cmd: string, ...rest: unknown[]) =>
        cmd === 'storage.usage'
          ? Promise.resolve({ ok: false, error: { code: 'STORAGE', message: 'disk gone' } })
          : (invoke as (c: string, ...r: unknown[]) => Promise<unknown>)(cmd, ...rest)) as never,
    }
    const b = await buildDiagnostics(src)
    expect(b.text).toContain('unavailable (STORAGE: disk gone)')
  })

  it('copy writes the clipboard; save writes the chosen file, the E2E path, or nothing when cancelled', async () => {
    writeLogs()
    const writeClipboard = vi.fn()
    const choose = vi.fn((_name: string) => Promise.resolve<string | null>(null))
    const d = createDiagnostics({ ...sources(), writeClipboard, chooseSavePath: choose })
    await d.copy({})
    expect(writeClipboard).toHaveBeenCalledTimes(1)
    expect(String(writeClipboard.mock.calls[0]?.[0])).toContain('Dim Factory diagnostics')
    expect(await d.save({})).toBeNull()
    expect(choose.mock.calls[0]?.[0]).toMatch(/^dim-factory-diagnostics-2026-10-08T12-00-00-000Z\.txt$/)
    const target = join(process.env['DIM_FACTORY_HOME'] ?? '', 'saved.txt')
    choose.mockResolvedValueOnce(target)
    expect(await d.save({})).toEqual({ path: target })
    expect(readFileSync(target, 'utf8')).toContain('Dim Factory diagnostics')
    const e2ePath = join(process.env['DIM_FACTORY_HOME'] ?? '', 'e2e.txt')
    const e2e = createDiagnostics({
      ...sources(),
      writeClipboard,
      chooseSavePath: choose,
      e2eSavePath: e2ePath,
    })
    expect(await e2e.save({ includeRaw: false })).toEqual({ path: e2ePath })
    expect(choose).toHaveBeenCalledTimes(2)
  })
})

describe('helpers', () => {
  it('formatBytes', () => {
    expect(formatBytes(null)).toBe('unknown')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })

  it('redactDiagnosticLine counts what it replaced', () => {
    const counts: Record<string, number> = {}
    const out = redactDiagnosticLine(
      JSON.stringify({ msg: 'x', token: 'abc', env: { A: '1' }, nested: { environment: { B: '2' } } }),
      {},
      counts,
    )
    expect(JSON.parse(out)).toEqual({
      msg: 'x',
      token: '[REDACTED]',
      env: '[env omitted]',
      nested: { environment: '[env omitted]' },
    })
    expect(counts).toEqual({ env: 2, 'secret-key': 1 })
  })
})

describe('main wiring', () => {
  it('createMainHandlers serves diagnostics.* through the given Diagnostics (none without it)', async () => {
    const d = {
      build: vi.fn(() => Promise.resolve({ text: 'bundle', redactions: {} })),
      copy: vi.fn(() => Promise.resolve()),
      save: vi.fn(() => Promise.resolve({ path: '/tmp/out.txt' })),
    }
    const base = {
      core: { paths: homePaths(process.env['DIM_FACTORY_HOME'] ?? ''), log: createMemoryLogger() },
    }
    const h = createMainHandlers({ ...base, diagnostics: d } as unknown as MainHandlerDeps)
    expect(await h['diagnostics.build']?.({ includeRaw: true })).toEqual({ text: 'bundle', redactions: {} })
    expect(d.build).toHaveBeenCalledWith({ includeRaw: true })
    await h['diagnostics.copy']?.({ runId: RUN })
    expect(d.copy).toHaveBeenCalledWith({ runId: RUN })
    expect(await h['diagnostics.save']?.({})).toEqual({ path: '/tmp/out.txt' })
    const without = createMainHandlers(base as unknown as MainHandlerDeps)
    expect(without['diagnostics.build']).toBeUndefined()
  })
})
