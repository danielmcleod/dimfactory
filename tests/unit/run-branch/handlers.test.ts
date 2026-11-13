// Git IPC handlers (src/core/handlers.ts): diff.revert, diff.undoRevert, diff.files, diff.file and runs.branch
// validate their requests, refuse on a read-only core, answer UNSUPPORTED without the core's run-git host, and hand
// the rest to it.
import { describe, expect, it, vi } from 'vitest'
import { BRANCH_REVERT_COMMANDS, createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext, RunGitHost } from '@core/handlers.ts'
import { COMMAND_AREA } from '@shared/ipc.ts'
import type { DiffSegment } from '@shared/ipc.ts'

const RUN = '20261008T120000Z-m7aa'
const PATCH = 'diff --git a/a.ts b/a.ts'

function setup(o: { readOnly?: boolean; host?: boolean } = {}) {
  const revert = vi.fn((_runId: string, _req: object) =>
    Promise.resolve({ undoToken: 'revert-1', restored: ['a.ts'], deleted: [], skipped: [] }),
  )
  const undoRevert = vi.fn((_runId: string, _token: string) => Promise.resolve())
  const branch = vi.fn((_runId: string, _action: string) => Promise.resolve({ done: true, commands: [] }))
  const files = vi.fn((_runId: string, seg: DiffSegment) =>
    Promise.resolve({ seg, files: [], reviewed: [], available: [seg], persisted: false }),
  )
  const file = vi.fn((_runId: string, _seg: DiffSegment, _path: string, _ignoreEol: boolean) =>
    Promise.resolve({ patch: PATCH, truncated: false }),
  )
  const host: RunGitHost = { revert, undoRevert, branch, files, file }
  const ctx = {
    kind: 'app',
    readOnly: o.readOnly === true,
    ...(o.host !== false ? { runGit: host } : {}),
  } as unknown as HandlerContext
  return { ctx, host: { revert, undoRevert, branch, files, file } }
}

describe('git handlers', () => {
  it('are routed commands of the core (not main)', () => {
    for (const c of BRANCH_REVERT_COMMANDS)
      expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, c)).toBe(true)
  })

  it('diff.revert: "all" or relative paths, an optional segment; handed to the host', async () => {
    const { ctx, host } = setup()
    const h = createHandlers(ctx)
    expect(await dispatch(h, 'diff.revert', { runId: RUN, paths: 'all' })).toEqual({
      ok: true,
      value: { undoToken: 'revert-1', restored: ['a.ts'], deleted: [], skipped: [] },
    })
    expect(host.revert).toHaveBeenLastCalledWith(RUN, {})
    await dispatch(h, 'diff.revert', { runId: RUN, seg: 'fix', paths: ['src/a.ts', 'b\\c.ts'] })
    expect(host.revert).toHaveBeenLastCalledWith(RUN, { seg: 'fix', paths: ['src/a.ts', 'b\\c.ts'] })
    for (const paths of [[], ['../outside'], ['/abs'], ['C:\\abs'], ['a/../../b'], ['']]) {
      const r = await dispatch(h, 'diff.revert', { runId: RUN, paths })
      expect(r.ok ? null : r.error.code, JSON.stringify(paths)).toBe('VALIDATION')
    }
    const seg = await dispatch(h, 'diff.revert', { runId: RUN, seg: 'other', paths: 'all' } as never)
    expect(seg.ok ? null : seg.error.code).toBe('VALIDATION')
  })

  it('diff.undoRevert and runs.branch validate and delegate', async () => {
    const { ctx, host } = setup()
    const h = createHandlers(ctx)
    expect(await dispatch(h, 'diff.undoRevert', { runId: RUN, undoToken: 'revert-1' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(host.undoRevert).toHaveBeenCalledWith(RUN, 'revert-1')
    const bad = await dispatch(h, 'diff.undoRevert', { runId: RUN, undoToken: '' })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
    expect(await dispatch(h, 'runs.branch', { runId: RUN, action: 'return' })).toEqual({
      ok: true,
      value: { done: true, commands: [] },
    })
    expect(host.branch).toHaveBeenCalledWith(RUN, 'return')
    const act = await dispatch(h, 'runs.branch', { runId: RUN, action: 'merge' } as never)
    expect(act.ok ? null : act.error.code).toBe('VALIDATION')
  })

  it('diff.files and diff.file: a known segment, a relative path; handed to the host', async () => {
    const { ctx, host } = setup()
    const h = createHandlers(ctx)
    expect(await dispatch(h, 'diff.files', { runId: RUN, seg: 'combined' })).toEqual({
      ok: true,
      value: { seg: 'combined', files: [], reviewed: [], available: ['combined'], persisted: false },
    })
    expect(host.files).toHaveBeenCalledWith(RUN, 'combined')
    expect(await dispatch(h, 'diff.file', { runId: RUN, seg: 'implement', path: 'src/a.ts' })).toEqual({
      ok: true,
      value: { patch: PATCH, truncated: false },
    })
    expect(host.file).toHaveBeenLastCalledWith(RUN, 'implement', 'src/a.ts', false)
    await dispatch(h, 'diff.file', { runId: RUN, seg: 'fix', path: 'b.ts', ignoreEol: true })
    expect(host.file).toHaveBeenLastCalledWith(RUN, 'fix', 'b.ts', true)
    const bad = [
      await dispatch(h, 'diff.files', { runId: RUN, seg: 'other' } as never),
      await dispatch(h, 'diff.file', { runId: RUN, seg: 'combined', path: '../x' }),
      await dispatch(h, 'diff.file', { runId: RUN, seg: 'combined', path: '' }),
      await dispatch(h, 'diff.file', { runId: RUN, seg: 'combined', path: 'a', ignoreEol: 'yes' } as never),
    ]
    for (const r of bad) expect(r.ok ? null : r.error.code).toBe('VALIDATION')
  })

  it('a read-only core refuses; a core without the host answers UNSUPPORTED', async () => {
    const ro = createHandlers(setup({ readOnly: true }).ctx)
    for (const r of [
      await dispatch(ro, 'diff.revert', { runId: RUN, paths: 'all' }),
      await dispatch(ro, 'diff.undoRevert', { runId: RUN, undoToken: 'x' }),
      await dispatch(ro, 'diff.files', { runId: RUN, seg: 'combined' }),
      await dispatch(ro, 'diff.file', { runId: RUN, seg: 'combined', path: 'a.ts' }),
      await dispatch(ro, 'runs.branch', { runId: RUN, action: 'delete' }),
    ]) {
      expect(r.ok ? null : r.error.code).toBe('FORBIDDEN')
    }
    const none = createHandlers(setup({ host: false }).ctx)
    const r = await dispatch(none, 'diff.revert', { runId: RUN, paths: 'all' })
    expect(r).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Reverts and run branches are not available here.' },
    })
  })
})
