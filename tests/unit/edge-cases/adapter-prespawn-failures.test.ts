// Coverage: a pass that ends before its CLI runs (adapter contract: exactly one terminal event, then
// `exited`, never a hang; no binary is cli_missing, a missing pass folder folder_guard; a stop that
// lands while the binary is being resolved ends the attempt user_cancelled without spawning). The same matrix for the
// adapters whose launch is their own (Codex exec, Muse exec, the ACP base through Gemini); the binary lookup is the
// adapters' test seam, and nothing is ever spawned.
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCodexAdapter } from '../../../src/core/adapters/codex/index.ts'
import { createGeminiAdapter } from '../../../src/core/adapters/gemini/index.ts'
import { createMuseAdapter } from '../../../src/core/adapters/muse/index.ts'
import type { ExitInfo, RunHandle, StartOptions, StopReason } from '../../../src/core/adapters/types.ts'
import { META_RESUME_IGNORED } from '../../../src/core/adapters/types.ts'
import type { ResolveResult, ResolvedCli } from '../../../src/core/proc/resolve-cli.ts'
import type { AdapterSignal, NormalizedEvent } from '../../../src/shared/events.ts'
import type { VendorId } from '../../../src/shared/vendors.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

type Resolver = (force: boolean) => Promise<ResolveResult>

interface Subject {
  start(o: StartOptions): RunHandle
  stop(h: RunHandle, reason: StopReason): Promise<void>
}

interface Made {
  adapter: Subject
  onSpawn: ReturnType<typeof vi.fn>
}

const cliAt = (vendor: VendorId, command: string): ResolvedCli => ({
  vendor,
  command,
  prefixArgs: [],
  kind: 'native',
  version: '1.0.0',
  source: 'config',
  pathPrepend: [],
  warnings: [],
  path: command,
  target: command,
  mtimeMs: 0,
  size: 0,
})

const found =
  (vendor: VendorId, command: string): Resolver =>
  () =>
    Promise.resolve({ ok: true, cli: cliAt(vendor, command), rejected: [], candidates: [command] })

const nothing: Resolver = () =>
  Promise.resolve({
    ok: false,
    rejected: [
      { path: 'C:\\nowhere\\cli.exe', source: 'config', reason: 'not-found', detail: 'no such file' },
    ],
    candidates: [],
  })

interface Spec {
  name: string
  vendor: VendorId
  make(resolve: Resolver, o?: { tmpDir?: string; dimFactoryHome?: string }): Made
}

const SPECS: Spec[] = [
  {
    name: 'Codex exec',
    vendor: 'codex',
    make: (resolve, o = {}) => {
      const onSpawn = vi.fn()
      const adapter = createCodexAdapter({
        env: {},
        home: home(),
        platform: 'linux',
        resolve,
        pathEnv: '',
        tmpDir: o.tmpDir ?? join(home(), 'tmp'),
        initialFacts: { route: 'exec' },
        onSpawn,
      })
      return { adapter, onSpawn }
    },
  },
  {
    name: 'Muse exec',
    vendor: 'muse',
    make: (resolve, o = {}) => {
      const onSpawn = vi.fn()
      const adapter = createMuseAdapter({
        env: {},
        home: home(),
        dimFactoryHome: o.dimFactoryHome ?? home(),
        search: 'configured',
        resolve,
        pathEnv: '',
        onSpawn,
      })
      return { adapter, onSpawn }
    },
  },
  {
    name: 'ACP (Gemini)',
    vendor: 'gemini',
    make: (resolve) => {
      const onSpawn = vi.fn()
      const adapter = createGeminiAdapter({
        env: {},
        home: home(),
        dimFactoryHome: home(),
        search: 'configured',
        resolve,
        pathEnv: '',
        onSpawn,
      })
      return { adapter, onSpawn }
    },
  },
]

/** The pass folder, and the temp root Codex exec makes its folder in. */
async function passFolder(): Promise<string> {
  const cwd = join(home(), 'work')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(home(), 'tmp'), { recursive: true })
  return cwd
}

const startOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: '20261012T120000Z-pre1',
  step: 'implement',
  cwd,
  prompt: 'Add a --version flag.',
  mode: 'full',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: true,
  ...o,
})

interface Ended {
  events: NormalizedEvent[]
  signals: AdapterSignal[]
  exit: ExitInfo
  handle: RunHandle
}

async function run(a: Subject, o: StartOptions, before?: (h: RunHandle) => void): Promise<Ended> {
  const handle = a.start(o)
  const events: NormalizedEvent[] = []
  const signals: AdapterSignal[] = []
  handle.onEvent((e) => events.push(e))
  handle.onSignal((s) => signals.push(s))
  before?.(handle)
  const exit = await handle.exited
  // Buffered events reach a subscriber on a microtask.
  await new Promise((r) => setTimeout(r, 0))
  return { events, signals, exit, handle }
}

/** One fatal error, last; nothing ran (no pid, no exit code). */
function expectEndedBeforeSpawn(d: Ended, category: string): Extract<NormalizedEvent, { type: 'error' }> {
  const terminal = d.events.filter((e) => e.type === 'done' || (e.type === 'error' && e.fatal))
  expect(terminal).toHaveLength(1)
  const last = d.events.at(-1)
  expect(last).toMatchObject({ type: 'error', fatal: true, category })
  expect(d.exit).toMatchObject({ code: null, signal: null, sawTerminal: true })
  expect(d.handle.pid).toBeUndefined()
  return last as Extract<NormalizedEvent, { type: 'error' }>
}

describe.each(SPECS)('$name: a pass that ends before its CLI runs', (spec) => {
  it('no binary: cli_missing, the lookup’s rejections as evidence', async () => {
    const { adapter, onSpawn } = spec.make(nothing)
    const d = await run(adapter, startOptions(await passFolder()))
    const err = expectEndedBeforeSpawn(d, 'cli_missing')
    expect(err.message).toMatch(/not installed|could not be started/)
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('a lookup that throws an unexpected error is still cli_missing, with its text', async () => {
    const { adapter } = spec.make(() => Promise.reject(new Error('lookup exploded')))
    const d = await run(adapter, startOptions(await passFolder()))
    expect(expectEndedBeforeSpawn(d, 'cli_missing').message).toContain('lookup exploded')
  })

  it('a binary that is not there at spawn time: cli_missing (errno)', async () => {
    const missing = join(home(), 'gone', spec.vendor === 'codex' ? 'codex.exe' : `${spec.vendor}.exe`)
    const { adapter, onSpawn } = spec.make(found(spec.vendor, missing))
    const d = await run(adapter, startOptions(await passFolder()))
    expectEndedBeforeSpawn(d, 'cli_missing')
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('a pass folder that no longer exists: folder_guard, nothing spawned', async () => {
    const { adapter, onSpawn } = spec.make(found(spec.vendor, process.execPath))
    await passFolder()
    const d = await run(adapter, startOptions(join(home(), 'deleted-folder')))
    expectEndedBeforeSpawn(d, 'folder_guard')
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('a stop while the binary is being resolved: user_cancelled, stoppedBy user, never spawned', async () => {
    let release: (r: ResolveResult) => void = () => undefined
    const pending = new Promise<ResolveResult>((r) => {
      release = r
    })
    const { adapter, onSpawn } = spec.make(() => pending)
    let stopped: Promise<void> | undefined
    const d = await run(adapter, startOptions(await passFolder()), (h) => {
      stopped = adapter.stop(h, 'user')
      // A second stop is the same stop.
      void adapter.stop(h, 'user')
      setTimeout(
        () => release({ ok: true, cli: cliAt(spec.vendor, process.execPath), rejected: [], candidates: [] }),
        20,
      )
    })
    await stopped
    expectEndedBeforeSpawn(d, 'user_cancelled')
    expect(d.exit.stoppedBy).toBe('user')
    expect(onSpawn).not.toHaveBeenCalled()
  })
})

describe('model names that could read as flags never reach argv (config_invalid, before the lookup)', () => {
  it.each(SPECS.filter((s) => s.vendor !== 'codex'))('$name', async (spec) => {
    const resolve = vi.fn(found(spec.vendor, process.execPath))
    const { adapter } = spec.make(resolve)
    for (const model of ['--yolo', 'gemini 3 pro']) {
      const d = await run(adapter, startOptions(await passFolder(), { model }))
      expect(expectEndedBeforeSpawn(d, 'config_invalid').message).toContain(model.slice(0, 20))
    }
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('Codex exec: its temporary folder', () => {
  const codex = SPECS[0] as Spec

  it('cannot be created (the temp root is a file): disk_full with the reason, nothing spawned', async () => {
    const root = join(home(), 'tmp-file')
    await mkdir(home(), { recursive: true })
    await writeFile(root, 'not a folder')
    const { adapter, onSpawn } = codex.make(found('codex', process.execPath), { tmpDir: root })
    const d = await run(adapter, startOptions(await passFolder()))
    expect(expectEndedBeforeSpawn(d, 'disk_full').message).toMatch(/could not create a temporary folder/)
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('is removed again when the spawn fails, with the output schema written there', async () => {
    const root = join(home(), 'codex-tmp')
    await mkdir(root, { recursive: true })
    const { adapter } = codex.make(found('codex', join(home(), 'gone', 'codex.exe')), { tmpDir: root })
    const d = await run(
      adapter,
      startOptions(await passFolder(), {
        step: 'catalog',
        mode: 'readonly',
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      }),
    )
    expectEndedBeforeSpawn(d, 'cli_missing')
    expect(await readdir(root)).toEqual([])
  })

  it('a read-only pass given a session to resume says it starts fresh (resumeIgnored), then runs as asked', async () => {
    const { adapter } = codex.make(nothing)
    const d = await run(
      adapter,
      startOptions(await passFolder(), {
        step: 'review',
        mode: 'readonly',
        resume: { sessionId: '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99' },
      }),
    )
    expect(d.signals).toContainEqual(
      expect.objectContaining({
        type: 'meta',
        key: META_RESUME_IGNORED,
        value: expect.objectContaining({ route: 'readonly' }) as Record<string, unknown>,
      }) as AdapterSignal,
    )
    expectEndedBeforeSpawn(d, 'cli_missing')
  })
})

describe('Muse: its prompt file', () => {
  it('cannot be written (DIM_FACTORY_HOME is a file): unknown, naming the prompt file, nothing spawned', async () => {
    const blocker = join(home(), 'home-file')
    await mkdir(home(), { recursive: true })
    await writeFile(blocker, 'not a folder')
    const muse = SPECS[1] as Spec
    const { adapter, onSpawn } = muse.make(found('muse', process.execPath), { dimFactoryHome: blocker })
    const d = await run(adapter, startOptions(await passFolder()))
    expect(expectEndedBeforeSpawn(d, 'unknown').message).toMatch(/could not write the prompt file/)
    expect(onSpawn).not.toHaveBeenCalled()
    expect(existsSync(join(blocker, 'runs'))).toBe(false)
  })
})
