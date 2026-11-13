// runs.pin / runs.remove / runs.undoRemove handlers (IPC) and `dimf gc`'s report
// (CLI): validation, read-only and missing-host answers, and the report's lines (no em dash).
import { describe, expect, it } from 'vitest'
import { reportLines } from '../../../src/cli/commands/gc.ts'
import { main } from '../../../src/cli/dimf.ts'
import { historyHandlers } from '../../../src/core/handlers-history.ts'
import type { HistoryHost } from '../../../src/core/handlers-history.ts'
import type { HandlerContext, HandlerMap } from '../../../src/core/handlers.ts'
import { HISTORY_COMMANDS, dispatch } from '../../../src/core/handlers.ts'
import type { RetentionReport } from '../../../src/core/store/retention.ts'
import type { Req } from '../../../src/shared/ipc.ts'

function table(o: { readOnly?: boolean; host?: HistoryHost }): HandlerMap {
  const ctx = {
    readOnly: o.readOnly === true,
    ...(o.host !== undefined ? { history: o.host } : {}),
  } as unknown as HandlerContext
  return historyHandlers(ctx)
}

describe('history handlers', () => {
  it('validate, then call the host', async () => {
    const calls: unknown[] = []
    const host: HistoryHost = {
      pin: (runId, pinned) => {
        calls.push(['pin', runId, pinned])
        return Promise.resolve()
      },
      remove: (runIds) => {
        calls.push(['remove', runIds])
        return Promise.resolve({ undoToken: 'remove-1', removed: [...runIds] })
      },
      undoRemove: (token) => {
        calls.push(['undo', token])
        return Promise.resolve()
      },
    }
    const h = table({ host })
    expect(Object.keys(h).sort()).toEqual([...HISTORY_COMMANDS].sort())
    expect(await dispatch(h, 'runs.pin', { runId: 'r1', pinned: true })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await dispatch(h, 'runs.remove', { runIds: ['r1', 'r2'] })).toEqual({
      ok: true,
      value: { undoToken: 'remove-1', removed: ['r1', 'r2'] },
    })
    expect(await dispatch(h, 'runs.undoRemove', { undoToken: 'remove-1' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(calls).toEqual([
      ['pin', 'r1', true],
      ['remove', ['r1', 'r2']],
      ['undo', 'remove-1'],
    ])
    const bad = async <C extends 'runs.pin' | 'runs.remove' | 'runs.undoRemove'>(cmd: C, req: unknown) =>
      (await dispatch(h, cmd, req as Req<C>)).ok
    expect(await bad('runs.pin', { runId: 'r1' })).toBe(false)
    expect(await bad('runs.remove', { runIds: [] })).toBe(false)
    expect(await bad('runs.undoRemove', { undoToken: '' })).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('a read-only process is FORBIDDEN; no host is UNSUPPORTED', async () => {
    const ro = await dispatch(table({ readOnly: true }), 'runs.pin', { runId: 'r1', pinned: true })
    expect(ro.ok ? null : ro.error.code).toBe('FORBIDDEN')
    const none = await dispatch(table({}), 'runs.remove', { runIds: ['r1'] })
    expect(none.ok ? null : none.error.code).toBe('UNSUPPORTED')
  })
})

describe('dimf gc report', () => {
  const report = (over: Partial<RetentionReport> = {}): RetentionReport => ({
    dryRun: true,
    at: 0,
    policy: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
    removed: [{ runId: 'r1', displayNo: 1, title: 'old task', folder: 'C:\\repo', createdAt: 0 }],
    kept: [
      { runId: 'r2', displayNo: 2, title: 'pinned task', folder: 'C:\\repo', createdAt: 0, reason: 'pinned' },
    ],
    failed: [],
    copies: [],
    rawLogs: { files: 3, bytes: 3 * 1024 * 1024 },
    pendingRemoved: 0,
    gc: [
      { folderKey: '0123456789abcdef', action: 'gc', refs: 4, bytesBefore: 2048 },
      { folderKey: 'fedcba9876543210', action: 'skipped', reason: 'a run is using this folder' },
    ],
    gcPending: false,
    ...over,
  })

  it('a dry run says what would happen', () => {
    const lines = reportLines(report())
    expect(lines[0]).toBe(
      'Plan (nothing is changed: --dry-run): keep the newest 300 runs and every run from the last 60 days; raw logs for 14 days.',
    )
    expect(lines).toContain('Would delete 1 run:')
    expect(lines.some((l) => l.includes('#1') && l.includes('old task'))).toBe(true)
    expect(lines.some((l) => l.includes('#2') && l.includes('(pinned)'))).toBe(true)
    expect(lines).toContain('Raw logs: would delete 3 files (3.0 MB).')
    expect(lines).toContain('  0123456789abcdef  would collect (4 runs, 2 KB now)')
    expect(lines).toContain('  fedcba9876543210  left alone: a run is using this folder')
  })

  it('a real pass says what happened; no line has an em dash', () => {
    const lines = reportLines(
      report({
        dryRun: false,
        removed: [],
        rawLogs: { files: 0, bytes: 0 },
        pendingRemoved: 2,
        gc: [
          {
            folderKey: '0123456789abcdef',
            action: 'gc',
            refs: 1,
            bytesBefore: 5 * 1024 * 1024,
            bytesAfter: 1024,
          },
          { folderKey: 'aaaaaaaaaaaaaaaa', action: 'deleted', refs: 0, bytesBefore: 4096, bytesAfter: 0 },
        ],
      }),
    )
    expect(lines).toContain('Deleted 2 removed runs whose undo time had passed.')
    expect(lines).toContain('No run was deleted.')
    expect(lines).toContain('Raw logs: none older than 14 days.')
    expect(lines).toContain('  0123456789abcdef  collected: 5.0 MB before, 1 KB after')
    expect(lines).toContain('  aaaaaaaaaaaaaaaa  deleted: no run kept snapshots there (4 KB freed)')
    for (const l of [...lines, ...reportLines(report())]) expect(l).not.toContain('\u2014')
  })

  it('bad usage exits 2', async () => {
    const out: string[] = []
    expect(await main(['gc', '--bogus'], (s) => out.push(s))).toBe(2)
    expect(out.join('\n')).toContain('usage: dimf gc [--dry-run] [--json] [--home dir]')
  })
})
