// The recovery and vendor commands through the handler table (src/core/handlers-recovery.ts): recovery.execute
// reaches the run commands for a run's snag (read from the run's event log), marks a copied fix's check for a
// re-check, and answers UNSUPPORTED without a recovery host; vendors.setPath validates before it saves anything,
// re-creates the adapter from the saved file and probes it with force; vendors.models merges the probe's models
// with the catalog; git.init and setPath refuse on a read-only core.
import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { ProbeResult } from '@shared/vendors.ts'
import type { CatalogData } from '@core/catalog/store.ts'
import { DASHBOARD_COMMANDS, createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import { RECOVERY_COMMANDS } from '@core/handlers-recovery.ts'
import type { RecoveryHost } from '@core/handlers-recovery.ts'
import { homePaths } from '@core/home.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { mergeModelOptions } from '@core/recovery/models.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import type { RunDoc } from '@core/supervisor/controller.ts'
import type { UserCommand } from '@core/supervisor/types.ts'
import {
  check,
  fakeAdapter,
  fakeRegistry,
  healthyChecks,
  healthyDeps,
  probeResult,
} from '../preflight/helpers.ts'

const RUN = '20261006T120000Z-ab12'
const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

const login: RecoveryAction = {
  id: 'plan:login',
  label: 'Copy login command',
  kind: 'shell_copy',
  command: 'claude auth login',
  shell: 'powershell',
  reason: 'Sign in to Claude in a terminal, then re-check.',
  recheck: 'vendor.claude.auth',
}
const snagActions: RecoveryAction[] = [
  login,
  { id: 'plan:retry', label: 'Retry', kind: 'retry', strategy: 'auto' },
  { id: 'plan:skip', label: 'Continue without Plan', kind: 'skip_pass', pass: 'plan' },
  { id: 'run:close', label: 'Close run', kind: 'close_run' },
]

interface Setup {
  ctx: HandlerContext
  commands: UserCommand[]
  patch: ReturnType<typeof vi.fn>
  sync: ReturnType<typeof vi.fn>
  claude: ReturnType<typeof fakeAdapter>
  host: RecoveryHost
}

function setup(
  o: { readOnly?: boolean; host?: boolean; snagOpen?: boolean; catalog?: CatalogData } = {},
): Setup {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  const claude = fakeAdapter('claude')
  const adapters = fakeRegistry(claude)
  const engine = createPreflightEngine(healthyDeps({ adapters }))
  const commands: UserCommand[] = []
  const steps: Record<string, unknown> = {}
  for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'fix']) {
    steps[k] = { snagOpen: k === 'plan' && o.snagOpen !== false, status: k === 'plan' ? 'failed' : 'queued' }
  }
  const doc = { runId: RUN, state: { runId: RUN, steps, cards: [] }, lastSeq: 1 } as unknown as RunDoc
  const patch = vi.fn(() => Promise.resolve({ path: 'x', changed: true, diff: '', backupId: null }))
  const sync = vi.fn(() => Promise.resolve())
  const host: RecoveryHost = {
    actions: new RecoveryActionStore(),
    validateVendorPath: (vendor, path) =>
      vendor === 'claude'
        ? Promise.resolve(
            path.endsWith('claude.exe') || path.endsWith('claude')
              ? { ok: true as const, path, version: '2.1.289' }
              : { ok: false as const, reason: `${path} answered "hello" (exit 0); not claude` },
          )
        : null,
    syncUserVendors: sync,
    catalog: () => o.catalog,
    forgetFolder: vi.fn(),
    env: {},
  }
  const ctx = {
    kind: 'app',
    readOnly: o.readOnly === true,
    paths,
    bus: { isOpen: () => false, sync: () => Promise.resolve() },
    adapters,
    preflight: engine,
    now: () => 5_000,
    liveController: () => undefined,
    readDoc: (runId: string) => Promise.resolve(runId === RUN ? doc : null),
    controller: () =>
      Promise.resolve({
        state: doc.state,
        command: (cmd: UserCommand) => {
          commands.push(cmd)
          return Promise.resolve({ ok: true })
        },
      }),
    config: { patch },
    ...(o.host !== false ? { recovery: host } : {}),
  } as unknown as HandlerContext
  return { ctx, commands, patch, sync, claude, host }
}

async function writeSnag(actions: RecoveryAction[]): Promise<void> {
  const paths = homePaths(process.env['DIM_FACTORY_HOME'] ?? '')
  const run = paths.run(RUN)
  await mkdir(run.dir, { recursive: true })
  const failure = { category: 'auth_required', message: 'Not logged in', raw: '', classifiedBy: 'regex' }
  const lines = [
    { seq: 1, ts: 1, body: { t: 'snag', step: 'plan', failure, actions: actions.slice(0, 1) } },
    // The latest snag of a step wins (a retry that failed again).
    { seq: 2, ts: 2, body: { t: 'snag', step: 'plan', failure, actions } },
  ]
  await writeFile(run.eventsJsonl, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

describe('recovery.execute', () => {
  it("runs a snag's retry and close through the run commands", async () => {
    await writeSnag(snagActions)
    const { ctx, commands } = setup()
    const h = createHandlers(ctx)
    const retry = await dispatch(h, 'recovery.execute', { actionId: 'plan:retry', runId: RUN })
    expect(retry).toEqual({ ok: true, value: { kind: 'retry', message: 'Retrying Plan.' } })
    const skip = await dispatch(h, 'recovery.execute', { actionId: 'plan:skip', runId: RUN })
    expect(skip.ok).toBe(true)
    const close = await dispatch(h, 'recovery.execute', { actionId: 'run:close', runId: RUN })
    expect(close.ok).toBe(true)
    expect(commands).toEqual([
      { kind: 'retry', step: 'plan', strategy: 'auto' },
      { kind: 'skip', step: 'plan' },
      { kind: 'close' },
    ])
  })

  it("copies a snag's login command and marks vendor.claude.auth for a re-check", async () => {
    await writeSnag(snagActions)
    const { ctx, commands } = setup()
    ctx.preflight.recordProbe(probeResult('claude', 1, healthyChecks('claude', 1)))
    const r = await dispatch(createHandlers(ctx), 'recovery.execute', { actionId: 'plan:login', runId: RUN })
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'shell_copy',
        copied: 'claude auth login',
        message: 'Copied. Run it in a terminal, then re-check.',
      },
    })
    expect(commands).toEqual([])
    expect(ctx.preflight.cache.pendingRechecks).toEqual(['vendor.claude.auth'])
    expect(ctx.preflight.cache.isStale('claude')).toBe(true)
  })

  it('a resolved snag, an unknown id or an unknown run: NOT_FOUND', async () => {
    await writeSnag(snagActions)
    const h = createHandlers(setup({ snagOpen: false }).ctx)
    expect(await dispatch(h, 'recovery.execute', { actionId: 'plan:retry', runId: RUN })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This fix is no longer available; re-check.' },
    })
    const open = createHandlers(setup().ctx)
    const unknown = await dispatch(open, 'recovery.execute', { actionId: 'plan:nope', runId: RUN })
    expect(unknown.ok === false && unknown.error.code).toBe('NOT_FOUND')
    const noRun = await dispatch(open, 'recovery.execute', { actionId: 'plan:retry', runId: 'other-run' })
    expect(noRun).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Run other-run not found.' },
    })
  })

  it("finds a composer action in the folder's latest live report", async () => {
    const { ctx, host } = setup()
    const report: PreflightReport = {
      mode: 'live',
      ok: false,
      blocking: [check('vendor.claude.auth', 'fail', { recovery: [{ ...login, id: 'claude.login' }] })],
      warnings: [],
      info: [],
    }
    host.actions.record(FOLDER, report)
    const r = await dispatch(createHandlers(ctx), 'recovery.execute', {
      actionId: 'claude.login',
      folder: FOLDER,
    })
    expect(r.ok && r.value).toMatchObject({ kind: 'shell_copy', copied: 'claude auth login' })
  })

  it('answers UNSUPPORTED on a core without a recovery host', async () => {
    const r = await dispatch(createHandlers(setup({ host: false }).ctx), 'recovery.execute', {
      actionId: 'x',
    })
    expect(r).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Recovery actions are not available here.' },
    })
  })
})

describe('vendors.setPath', () => {
  const exe = process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/opt/tools/claude'

  it('saves a valid path to the user file, re-creates the adapter, probes with force and answers the view', async () => {
    const { ctx, patch, sync, claude } = setup()
    const r = await dispatch(createHandlers(ctx), 'vendors.setPath', { vendor: 'claude', path: exe })
    if (!r.ok) throw new Error(r.error.message)
    expect(patch).toHaveBeenCalledWith({
      scope: 'user',
      ops: [{ op: 'replace', path: '/vendors/claude/path', value: exe }],
    })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.invocationCallOrder[0]).toBeGreaterThan(patch.mock.invocationCallOrder[0] ?? Infinity)
    expect(claude.probeCalls).toEqual([{ force: true }])
    expect(r.value).toMatchObject({ vendor: 'claude', health: 'ready' })
    expect(ctx.preflight.cache.vendor('claude')?.stale).toBe(false)
  })

  it('null removes the path (auto-detect)', async () => {
    const { ctx, patch } = setup()
    const r = await dispatch(createHandlers(ctx), 'vendors.setPath', { vendor: 'claude', path: null })
    expect(r.ok).toBe(true)
    expect(patch).toHaveBeenCalledWith({
      scope: 'user',
      ops: [{ op: 'remove', path: '/vendors/claude/path' }],
    })
  })

  it("a path the resolver rejects is VALIDATION with the resolver's reason, and nothing is saved or probed", async () => {
    const { ctx, patch, sync, claude } = setup()
    const r = await dispatch(createHandlers(ctx), 'vendors.setPath', {
      vendor: 'claude',
      path: 'C:\\tools\\hello.cmd',
    })
    expect(r).toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'C:\\tools\\hello.cmd answered "hello" (exit 0); not claude' },
    })
    expect(patch).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(claude.probeCalls).toEqual([])
  })

  it('an unbuilt vendor is UNSUPPORTED, an unknown one NOT_FOUND, a read-only core FORBIDDEN', async () => {
    const h = createHandlers(setup().ctx)
    const codex = await dispatch(h, 'vendors.setPath', { vendor: 'codex', path: exe })
    expect(codex).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Codex is not available in this build.' },
    })
    const nope = await dispatch(h, 'vendors.setPath', { vendor: 'nope', path: exe })
    expect(nope.ok === false && nope.error.code).toBe('NOT_FOUND')
    const ro = await dispatch(createHandlers(setup({ readOnly: true }).ctx), 'vendors.setPath', {
      vendor: 'claude',
      path: exe,
    })
    expect(ro.ok === false && ro.error.code).toBe('FORBIDDEN')
  })
})

describe('vendors.models', () => {
  const models: ProbeResult['models'] = [
    {
      id: 'default',
      label: 'Default (recommended)',
      isDefault: true,
      aliases: ['claude-sonnet-4-5'],
      source: 'cli',
    },
    { id: 'opus', label: 'Opus', aliases: ['claude-opus-4-1'], source: 'cli' },
    { id: 'haiku', label: 'Haiku', source: 'cli' },
  ]
  const price = (model: string, aliases: string[]) => ({
    vendor: 'claude',
    model,
    aliases,
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 6,
    sourceUrl: 'https://www.anthropic.com/pricing',
    fetchedAt: 0,
    confidence: 'unverified' as const,
  })
  const catalog: CatalogData = {
    models: {
      schemaVersion: 1,
      updatedAt: 0,
      vendors: {
        claude: {
          source: 'cli',
          fetchedAt: 0,
          models: [
            { id: 'claude-3-old', deprecated: true, source: 'cli', fetchedAt: 0 },
            { id: 'secret', hidden: true, source: 'cli', fetchedAt: 0 },
          ],
        },
      },
    },
    pricing: {
      schemaVersion: 1,
      updatedAt: 0,
      entries: [
        price('claude-sonnet-4-5', ['sonnet']),
        price('claude-opus-4-1', ['opus']),
        price('claude-x', []),
      ],
    },
  }

  it("the probe's models first (default marked), then the catalog's, each with its pricing flag", () => {
    const out = mergeModelOptions('claude', models, catalog)
    expect(out.map((m) => [m.id, m.source, m.hasPricing, m.isDefault === true])).toEqual([
      ['default', 'cli', true, true],
      ['opus', 'cli', true, false],
      ['haiku', 'cli', false, false],
      ['claude-3-old', 'catalog', false, false],
      ['claude-x', 'catalog', true, false],
    ])
    expect(out.find((m) => m.id === 'claude-3-old')?.deprecated).toBe(true)
    // `claude-sonnet-4-5` and `claude-opus-4-1` are the CLI's own aliases: not listed twice.
    expect(out.some((m) => m.id === 'claude-opus-4-1' || m.id === 'claude-sonnet-4-5')).toBe(false)
    // No catalog (a read-only core): every option says it has no price.
    expect(mergeModelOptions('claude', models, undefined).every((m) => !m.hasPricing)).toBe(true)
  })

  it('reads the stored probe; force probes again and stores it', async () => {
    const { ctx, claude } = setup({ catalog })
    ctx.preflight.recordProbe({ ...probeResult('claude', 1, healthyChecks('claude', 1)), models })
    const h = createHandlers(ctx)
    const r = await dispatch(h, 'vendors.models', { vendor: 'claude' })
    expect(r.ok && r.value.map((m) => m.id)).toEqual(['default', 'opus', 'haiku', 'claude-3-old', 'claude-x'])
    expect(claude.probeCalls).toEqual([])
    claude.setProbe({ ...probeResult('claude', 2, healthyChecks('claude', 2)), models: models.slice(0, 1) })
    const forced = await dispatch(h, 'vendors.models', { vendor: 'claude', force: true })
    expect(forced.ok && forced.value[0]?.id).toBe('default')
    expect(claude.probeCalls).toEqual([{ force: true }])
    expect(ctx.preflight.cache.probe('claude')?.at).toBe(2)
    const unknown = await dispatch(h, 'vendors.models', { vendor: 'nope' })
    expect(unknown.ok === false && unknown.error.code).toBe('NOT_FOUND')
  })
})

describe('git.init', () => {
  it('is refused on a read-only core', async () => {
    const r = await dispatch(createHandlers(setup({ readOnly: true }).ctx), 'git.init', { folder: FOLDER })
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN')
  })
})

describe('wiring', () => {
  it('the table answers every recovery command, all listed among the core commands', () => {
    const h = createHandlers(setup().ctx)
    for (const c of RECOVERY_COMMANDS) {
      expect(h[c], c).toBeTypeOf('function')
      expect(DASHBOARD_COMMANDS as readonly string[]).toContain(c)
    }
  })
})
