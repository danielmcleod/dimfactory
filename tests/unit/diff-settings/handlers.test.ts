// IPC handlers (src/core/handlers-diff-settings.ts): diff.blob, diff.markReviewed, storage.usage and storage.clearShadow
// validate their requests (no path outside the run, a known segment and side, a folder key), refuse writes on a
// read-only core, answer UNSUPPORTED without the core's hosts, and hand the rest to them.
import { describe, expect, it, vi } from 'vitest'
import { DIFF_SETTINGS_COMMANDS, createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DiffViewHost, StorageHost } from '@core/handlers-diff-settings.ts'
import { isRunRelativePath } from '@core/handlers-diff-settings.ts'
import { COMMAND_AREA } from '@shared/ipc.ts'
import type { StorageUsage } from '@shared/ipc.ts'
import { MAIN_COMMANDS } from '../../../src/main/router.ts'

const RUN = '20261008T120000Z-diff1'
const KEY = '0123456789abcdef'
const USAGE: StorageUsage = {
  home: 'C:\\home',
  totalBytes: 10,
  freeBytes: 100,
  runs: { count: 1, bytes: 5 },
  shadows: [{ folderKey: KEY, path: 'C:\\proj', bytes: 5 }],
  worktrees: { count: 0, bytes: 0 },
  catalogBytes: 0,
  logsBytes: 0,
}

function setup(o: { readOnly?: boolean; hosts?: boolean } = {}) {
  const blob = vi.fn((..._a: unknown[]) => Promise.resolve({ base64: 'iVBO', bytes: 4, mime: 'image/png' }))
  const markReviewed = vi.fn((..._a: unknown[]) => Promise.resolve())
  const usage = vi.fn(() => Promise.resolve(USAGE))
  const clearShadow = vi.fn((_k: string) => Promise.resolve(USAGE))
  const diffView: DiffViewHost = { blob, markReviewed }
  const storage: StorageHost = { usage, clearShadow }
  const ctx = {
    kind: 'app',
    readOnly: o.readOnly === true,
    ...(o.hosts !== false ? { diffView, storage } : {}),
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), blob, markReviewed, usage, clearShadow }
}

const code = (r: { ok: boolean; error?: { code: string } }): string | null =>
  r.ok ? null : (r.error?.code ?? null)

describe('diff and storage handlers', () => {
  it('are core commands (main routes them to the core)', () => {
    for (const c of DIFF_SETTINGS_COMMANDS) {
      expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, c)).toBe(true)
      expect((MAIN_COMMANDS as readonly string[]).includes(c)).toBe(false)
    }
  })

  it('isRunRelativePath: relative paths only, never absolute, a drive, NUL or ..', () => {
    for (const p of ['a.png', 'src/a.ts', 'dir\\file.txt', 'name with space.txt', '..hidden', 'a..b']) {
      expect(isRunRelativePath(p), p).toBe(true)
    }
    for (const p of [
      '',
      ' ',
      '/etc/passwd',
      '\\\\server\\share',
      'C:\\x',
      'c:x',
      '../x',
      'a/../../b',
      'a/..',
      'a\0b',
      3,
    ]) {
      expect(isRunRelativePath(p), String(p)).toBe(false)
    }
  })

  it('diff.blob: a segment, a side and one of the run’s paths; handed to the host', async () => {
    const { h, blob } = setup()
    expect(
      await dispatch(h, 'diff.blob', { runId: RUN, seg: 'combined', side: 'new', path: 'img/a.png' }),
    ).toEqual({
      ok: true,
      value: { base64: 'iVBO', bytes: 4, mime: 'image/png' },
    })
    expect(blob).toHaveBeenLastCalledWith(RUN, 'combined', 'new', 'img/a.png')
    for (const bad of [
      { runId: RUN, seg: 'combined', side: 'new', path: '../secret.png' },
      { runId: RUN, seg: 'combined', side: 'new', path: 'C:\\Windows\\a.png' },
      { runId: RUN, seg: 'combined', side: 'both', path: 'a.png' },
      { runId: RUN, seg: 'all', side: 'old', path: 'a.png' },
      { runId: '', seg: 'combined', side: 'old', path: 'a.png' },
    ]) {
      expect(code(await dispatch(h, 'diff.blob', bad as never)), JSON.stringify(bad)).toBe('VALIDATION')
    }
    expect(blob).toHaveBeenCalledTimes(1)
  })

  it('diff.markReviewed: relative paths (deduplicated), a boolean, an optional segment', async () => {
    const { h, markReviewed } = setup()
    expect(
      await dispatch(h, 'diff.markReviewed', { runId: RUN, paths: ['a.ts', 'a.ts', 'b.ts'], reviewed: true }),
    ).toEqual({ ok: true, value: undefined })
    expect(markReviewed).toHaveBeenLastCalledWith(RUN, { paths: ['a.ts', 'b.ts'], reviewed: true })
    await dispatch(h, 'diff.markReviewed', { runId: RUN, paths: ['a.ts'], reviewed: false, seg: 'fix' })
    expect(markReviewed).toHaveBeenLastCalledWith(RUN, { paths: ['a.ts'], reviewed: false, seg: 'fix' })
    for (const bad of [
      { runId: RUN, paths: [], reviewed: true },
      { runId: RUN, paths: ['/abs.ts'], reviewed: true },
      { runId: RUN, paths: ['a.ts'], reviewed: 'yes' },
      { runId: RUN, paths: ['a.ts'], reviewed: true, seg: 'other' },
    ]) {
      expect(code(await dispatch(h, 'diff.markReviewed', bad as never)), JSON.stringify(bad)).toBe(
        'VALIDATION',
      )
    }
  })

  it('storage.usage reads; storage.clearShadow takes a 16-hex folder key', async () => {
    const { h, usage, clearShadow } = setup()
    expect(await dispatch(h, 'storage.usage', undefined)).toEqual({ ok: true, value: USAGE })
    expect(usage).toHaveBeenCalledTimes(1)
    expect(await dispatch(h, 'storage.clearShadow', { folderKey: KEY })).toEqual({ ok: true, value: USAGE })
    expect(clearShadow).toHaveBeenLastCalledWith(KEY)
    for (const folderKey of ['../../x', '0123456789ABCDEF', '0123', '']) {
      expect(code(await dispatch(h, 'storage.clearShadow', { folderKey }))).toBe('VALIDATION')
    }
  })

  it('a read-only core reads storage but refuses blobs, marks and clearing; no hosts → UNSUPPORTED', async () => {
    const ro = setup({ readOnly: true })
    expect(code(await dispatch(ro.h, 'storage.usage', undefined))).toBeNull()
    expect(code(await dispatch(ro.h, 'storage.clearShadow', { folderKey: KEY }))).toBe('FORBIDDEN')
    expect(
      code(await dispatch(ro.h, 'diff.blob', { runId: RUN, seg: 'combined', side: 'old', path: 'a.png' })),
    ).toBe('FORBIDDEN')
    expect(
      code(await dispatch(ro.h, 'diff.markReviewed', { runId: RUN, paths: ['a'], reviewed: true })),
    ).toBe('FORBIDDEN')
    expect(ro.clearShadow).not.toHaveBeenCalled()
    const none = setup({ hosts: false })
    expect(await dispatch(none.h, 'storage.usage', undefined)).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Storage details are not available here.' },
    })
    expect(
      code(await dispatch(none.h, 'diff.blob', { runId: RUN, seg: 'combined', side: 'old', path: 'a.png' })),
    ).toBe('UNSUPPORTED')
  })
})
