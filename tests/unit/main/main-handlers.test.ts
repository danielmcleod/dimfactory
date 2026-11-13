// Main-owned commands (src/main/main-handlers.ts): shell.open targets and refusals, log.write caps, focus, quit,
// the E2E folder short-circuit and app.info.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { createMemoryLogger } from '../../../src/core/log.ts'
import { createAppStateStore } from '../../../src/main/app-state.ts'
import { LOG_WRITE_DATA_MAX, LOG_WRITE_MSG_MAX } from '../../../src/main/constants.ts'
import { capLogWrite, createMainHandlers, resolveShellOpen } from '../../../src/main/main-handlers.ts'
import type { MainHandlerDeps } from '../../../src/main/main-handlers.ts'
import { toResult } from '../../../src/core/errors.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

function setup(over: Partial<MainHandlerDeps> = {}) {
  const paths = homePaths(home())
  const log = createMemoryLogger()
  const deps: MainHandlerDeps = {
    core: { paths, log },
    appInfo: () => ({
      name: 'Dim Factory',
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      versions: { electron: '44.5.1', chrome: '1', node: '24' },
      home: paths.home,
      logsDir: paths.logsDir,
      packaged: false,
      e2e: false,
      ipcProtocol: 1,
      notifications: null,
    }),
    gitInfo: () => Promise.resolve({ path: 'git', version: '2.55.0' }),
    pickFolder: vi.fn(() => Promise.resolve('C:\\picked')),
    openPath: vi.fn(() => Promise.resolve('')),
    openExternal: vi.fn(() => Promise.resolve()),
    theme: {
      set: vi.fn(() =>
        Promise.resolve({ theme: 'dark' as const, resolved: 'dark' as const, accent: 'slate' as const }),
      ),
    },
    appState: createAppStateStore(paths),
    setFocus: vi.fn(),
    rendererReady: vi.fn(),
    requestQuit: vi.fn(() => Promise.resolve({ quitting: false, activeRuns: 2 })),
    e2eState: vi.fn(() => ({
      now: 1,
      timeScale: 1,
      activeRuns: 0,
      procs: [],
      windowFocused: true,
      notifications: [],
      tray: { icon: 'tray-0.png', tooltip: 'Dim Factory' },
    })),
    ...over,
  }
  return { h: createMainHandlers(deps), deps, paths, log }
}

describe('resolveShellOpen', () => {
  const isDir = (dirs: string[]) => (p: string) => Promise.resolve(dirs.includes(p))

  it('opens a known run folder, its raw logs when present, and its worktree when it has one', async () => {
    const paths = homePaths(home())
    const run = paths.run('r1')
    expect(await resolveShellOpen({ target: 'runFolder', runId: 'r1' }, paths, isDir([run.dir]))).toEqual({
      kind: 'path',
      path: run.dir,
    })
    expect(await resolveShellOpen({ target: 'rawLog', runId: 'r1' }, paths, isDir([run.dir]))).toEqual({
      kind: 'path',
      path: run.dir,
    })
    expect(
      await resolveShellOpen({ target: 'rawLog', runId: 'r1' }, paths, isDir([run.dir, run.rawDir])),
    ).toEqual({
      kind: 'path',
      path: run.rawDir,
    })
    await expect(
      resolveShellOpen({ target: 'worktree', runId: 'r1' }, paths, isDir([run.dir])),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const wt = paths.worktree('r1')
    expect(await resolveShellOpen({ target: 'worktree', runId: 'r1' }, paths, isDir([run.dir, wt]))).toEqual({
      kind: 'path',
      path: wt,
    })
  })

  it('refuses unknown runs and run ids that are not one safe segment', async () => {
    const paths = homePaths(home())
    await expect(
      resolveShellOpen({ target: 'runFolder', runId: 'nope' }, paths, isDir([])),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    for (const runId of ['..', '../x', 'a\\b', 'C:x']) {
      await expect(resolveShellOpen({ target: 'runFolder', runId }, paths, isDir([]))).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    }
  })

  it('opens only existing absolute folders', async () => {
    const paths = homePaths(home())
    const dir = join(home(), 'project')
    expect(await resolveShellOpen({ target: 'folder', path: dir }, paths, isDir([dir]))).toEqual({
      kind: 'path',
      path: dir,
    })
    await expect(
      resolveShellOpen({ target: 'folder', path: 'relative' }, paths, isDir(['relative'])),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    await expect(resolveShellOpen({ target: 'folder', path: dir }, paths, isDir([]))).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('opens logs and home, and only allowlisted https links', async () => {
    const paths = homePaths(home())
    expect(await resolveShellOpen({ target: 'logs' }, paths, isDir([]))).toEqual({
      kind: 'path',
      path: paths.logsDir,
    })
    expect(await resolveShellOpen({ target: 'home' }, paths, isDir([]))).toEqual({
      kind: 'path',
      path: paths.home,
    })
    expect(
      await resolveShellOpen({ target: 'url', url: 'https://docs.anthropic.com/x' }, paths, isDir([])),
    ).toEqual({
      kind: 'url',
      url: 'https://docs.anthropic.com/x',
    })
    for (const url of ['https://evil.example/', 'http://github.com/', 'file:///etc/passwd']) {
      await expect(resolveShellOpen({ target: 'url', url }, paths, isDir([]))).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    }
  })
})

describe('capLogWrite', () => {
  it('caps the message at 2 KB and the data at 8 KB', () => {
    const big = capLogWrite('m'.repeat(5000), { blob: 'x'.repeat(20_000) })
    expect(big.msg.length).toBe(LOG_WRITE_MSG_MAX + 1)
    expect(big.data).toMatchObject({ truncated: true })
    expect(String(big.data?.['preview']).length).toBe(LOG_WRITE_DATA_MAX)
  })

  it('keeps small data, wraps non-objects and survives unserializable values', () => {
    expect(capLogWrite('hi', undefined)).toEqual({ msg: 'hi' })
    expect(capLogWrite('hi', { a: 1 })).toEqual({ msg: 'hi', data: { a: 1 } })
    expect(capLogWrite('hi', [1, 2])).toEqual({ msg: 'hi', data: { data: [1, 2] } })
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(capLogWrite('hi', cyclic)).toEqual({ msg: 'hi', data: { data: '[unserializable]' } })
  })
})

describe('createMainHandlers', () => {
  it('app.info adds git to the static info', async () => {
    const { h } = setup()
    expect(await h['app.info']?.()).toMatchObject({
      name: 'Dim Factory',
      git: { path: 'git', version: '2.55.0' },
    })
  })

  it('app.ready, events.focus and app.quit reach their hosts', async () => {
    const { h, deps } = setup()
    await h['app.ready']?.({ route: '#/' })
    expect(deps.rendererReady).toHaveBeenCalledWith('#/')
    await h['events.focus']?.({ runIds: Array.from({ length: 150 }, (_, i) => `r${i}`) })
    expect(vi.mocked(deps.setFocus).mock.calls[0]?.[0]).toHaveLength(150)
    expect(await h['app.quit']?.({ confirm: false })).toEqual({ quitting: false, activeRuns: 2 })
    expect(deps.requestQuit).toHaveBeenCalledWith(false)
  })

  it('dialog.pickFolder uses the dialog, or the E2E folder without one', async () => {
    const real = setup()
    expect(await real.h['dialog.pickFolder']?.({ defaultPath: 'C:\\x' })).toBe('C:\\picked')
    expect(real.deps.pickFolder).toHaveBeenCalledWith('C:\\x')
    const e2e = setup({ e2ePickFolder: 'C:\\fixture' })
    expect(await e2e.h['dialog.pickFolder']?.({})).toBe('C:\\fixture')
    expect(e2e.deps.pickFolder).not.toHaveBeenCalled()
  })

  it('shell.open opens paths and links, and maps a shell error to INTERNAL', async () => {
    const { h, deps, paths } = setup()
    await mkdir(paths.run('r1').dir, { recursive: true })
    await h['shell.open']?.({ target: 'runFolder', runId: 'r1' })
    expect(deps.openPath).toHaveBeenCalledWith(paths.run('r1').dir)
    await h['shell.open']?.({ target: 'url', url: 'https://github.com/x' })
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/x')
    const failing = setup({ openPath: () => Promise.resolve('Access is denied') })
    const r = await toResult(() => failing.h['shell.open']!({ target: 'home' }))
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })

  it('log.write logs at the requested level under part=renderer', async () => {
    const { h, log } = setup()
    await h['log.write']?.({ level: 'warn', msg: 'slow frame', data: { ms: 70 } })
    expect(log.records).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'slow frame', part: 'renderer', ms: 70 }),
    )
  })

  it('state.get / state.set use state.json', async () => {
    const { h } = setup()
    expect((await h['state.get']?.())?.setupDismissed).toBe(false)
    expect((await h['state.set']?.({ setupDismissed: true }))?.setupDismissed).toBe(true)
    expect((await h['state.get']?.())?.setupDismissed).toBe(true)
  })

  it('ui.setTheme and e2e.state delegate', async () => {
    const setTheme = vi.fn(() =>
      Promise.resolve({ theme: 'dark' as const, resolved: 'dark' as const, accent: 'slate' as const }),
    )
    const { h } = setup({ theme: { set: setTheme } })
    expect(await h['ui.setTheme']?.({ theme: 'dark' })).toMatchObject({ resolved: 'dark' })
    expect(setTheme).toHaveBeenCalledWith({ theme: 'dark' })
    expect(await h['e2e.state']?.()).toMatchObject({ tray: { icon: 'tray-0.png' } })
  })

  it('preview.openPair hands the two session ids and their labels to the preview windows, and nothing else', async () => {
    const unused = (): Promise<never> => Promise.reject(new Error('not used'))
    const openPair = vi.fn(() => Promise.resolve())
    const { h } = setup({
      preview: {
        open: unused,
        openPair,
        smoke: unused,
        savePdf: unused,
        playtest: unused,
        tryIt: unused,
        shareCheck: unused,
        phone: unused,
      },
    })
    await h['preview.openPair']?.({ sessionIds: ['pv_a', 'pv_b'], labels: ['Claude', 'Codex'] })
    expect(openPair.mock.calls).toEqual([
      [
        ['pv_a', 'pv_b'],
        ['Claude', 'Codex'],
      ],
    ])
  })

  it('has no handler for the commands main does not serve here (the router answers UNSUPPORTED)', () => {
    const { h } = setup()
    for (const c of [
      'diagnostics.build',
      'notifications.test',
      'e2e.power',
      'e2e.clock',
      'preview.open',
      'preview.openPair',
    ] as const) {
      expect(h[c]).toBeUndefined()
    }
  })
})
