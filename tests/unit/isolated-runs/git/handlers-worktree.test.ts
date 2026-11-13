// worktree.* handlers (src/core/handlers-worktree.ts; IPC, Apply / Undo / Discard, the Diff tab):
// request checks, read-only and missing-host refusals, and the controller-backed host's answers from the run's records.
import { describe, expect, it, vi } from 'vitest'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import { WORKTREE_COMMANDS, applyRequestOf, createWorktreeHost } from '@core/handlers-worktree.ts'
import type { WorktreeHost } from '@core/handlers-worktree.ts'
import type { RunController } from '@core/supervisor/controller.ts'
import type { FinalizeRunState, RunState } from '@core/supervisor/types.ts'
import { homePaths } from '@core/home.ts'
import { COMMAND_AREA } from '@shared/ipc.ts'
import { REQUEST_SCHEMAS } from '@shared/ipc-schemas.ts'
import { MAIN_COMMANDS } from '../../../../src/main/router.ts'

const RUN = '20261009T120000Z-m13h'

function setup(o: { readOnly?: boolean; host?: boolean } = {}) {
  const host = {
    preview: vi.fn((_r: string) => Promise.resolve({ files: [], conflicts: [], actions: [] })),
    apply: vi.fn((_r: string, _q: unknown) =>
      Promise.resolve({ applied: ['a'], conflicts: [], undoToken: 'apply-1' }),
    ),
    undoApply: vi.fn((_r: string, _t: string) => Promise.resolve()),
    discard: vi.fn((_r: string) => Promise.resolve({ undoToken: 'discard-1', deleteAt: 10 })),
    undoDiscard: vi.fn((_r: string, _t: string) => Promise.resolve()),
  } satisfies WorktreeHost
  const ctx = {
    kind: 'app',
    readOnly: o.readOnly === true,
    ...(o.host !== false ? { worktree: host } : {}),
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), host }
}

const code = (r: { ok: boolean; error?: { code: string } }): string | null =>
  r.ok ? null : (r.error?.code ?? null)

describe('worktree.* requests', () => {
  it('are core commands (main routes them to the core)', () => {
    for (const c of WORKTREE_COMMANDS) {
      expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, c)).toBe(true)
      expect((MAIN_COMMANDS as readonly string[]).includes(c)).toBe(false)
    }
  })

  it('apply takes relative paths or reviewedOnly (not both), and mine/theirs per relative path', () => {
    expect(applyRequestOf({ runId: RUN })).toEqual({})
    expect(applyRequestOf({ runId: RUN, paths: ['a.ts', 'src/b.ts'] })).toEqual({
      paths: ['a.ts', 'src/b.ts'],
    })
    expect(applyRequestOf({ runId: RUN, reviewedOnly: true })).toEqual({ reviewedOnly: true })
    expect(applyRequestOf({ runId: RUN, reviewedOnly: false })).toEqual({})
    expect(applyRequestOf({ runId: RUN, resolutions: { 'a.ts': 'mine', 'b/c.ts': 'theirs' } })).toEqual({
      resolutions: { 'a.ts': 'mine', 'b/c.ts': 'theirs' },
    })
    for (const bad of [
      { paths: [] },
      { paths: ['/etc/passwd'] },
      { paths: ['../outside.txt'] },
      { paths: ['C:\\x.txt'] },
      { paths: 'all' },
      { paths: ['a.ts'], reviewedOnly: true },
      { reviewedOnly: 'yes' },
      { resolutions: { 'a.ts': 'both' } },
      { resolutions: { '../a.ts': 'mine' } },
      { resolutions: ['a.ts'] },
    ]) {
      expect(() => applyRequestOf({ runId: RUN, ...bad }), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION' }),
      )
    }
  })

  it('the IPC schema accepts the new fields and refuses a resolution that is not mine or theirs', () => {
    const z = REQUEST_SCHEMAS['worktree.apply']
    expect(z.safeParse({ runId: RUN, resolutions: { 'a.ts': 'theirs' }, reviewedOnly: true }).success).toBe(
      true,
    )
    expect(z.safeParse({ runId: RUN, resolutions: { 'a.ts': 'both' } }).success).toBe(false)
    expect(z.safeParse({ runId: RUN, extra: 1 }).success).toBe(false)
  })

  it('delegates to the host with the checked request', async () => {
    const { h, host } = setup()
    expect(await dispatch(h, 'worktree.preview', { runId: RUN })).toEqual({
      ok: true,
      value: { files: [], conflicts: [], actions: [] },
    })
    const r = await dispatch(h, 'worktree.apply', { runId: RUN, paths: ['a'], resolutions: { a: 'theirs' } })
    expect(r).toEqual({ ok: true, value: { applied: ['a'], conflicts: [], undoToken: 'apply-1' } })
    expect(host.apply).toHaveBeenCalledWith(RUN, { paths: ['a'], resolutions: { a: 'theirs' } })
    await dispatch(h, 'worktree.undoApply', { runId: RUN, undoToken: 'apply-1' })
    expect(host.undoApply).toHaveBeenCalledWith(RUN, 'apply-1')
    expect(await dispatch(h, 'worktree.discard', { runId: RUN })).toEqual({
      ok: true,
      value: { undoToken: 'discard-1', deleteAt: 10 },
    })
    await dispatch(h, 'worktree.undoDiscard', { runId: RUN, undoToken: 'discard-1' })
    expect(host.undoDiscard).toHaveBeenCalledWith(RUN, 'discard-1')
    expect(code(await dispatch(h, 'worktree.undoApply', { runId: RUN, undoToken: '' }))).toBe('VALIDATION')
    expect(code(await dispatch(h, 'worktree.apply', { runId: '', paths: ['a'] }))).toBe('VALIDATION')
  })

  it('a read-only core previews but refuses every write; a core without the host answers UNSUPPORTED', async () => {
    const ro = setup({ readOnly: true })
    expect(code(await dispatch(ro.h, 'worktree.preview', { runId: RUN }))).toBeNull()
    expect(code(await dispatch(ro.h, 'worktree.apply', { runId: RUN }))).toBe('FORBIDDEN')
    expect(code(await dispatch(ro.h, 'worktree.undoApply', { runId: RUN, undoToken: 't' }))).toBe('FORBIDDEN')
    expect(code(await dispatch(ro.h, 'worktree.discard', { runId: RUN }))).toBe('FORBIDDEN')
    expect(code(await dispatch(ro.h, 'worktree.undoDiscard', { runId: RUN, undoToken: 't' }))).toBe(
      'FORBIDDEN',
    )
    expect(ro.host.apply).not.toHaveBeenCalled()
    const none = setup({ host: false })
    expect(await dispatch(none.h, 'worktree.apply', { runId: RUN })).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'Isolated runs are not available here.' },
    })
  })
})

// ---- the controller-backed host --------------------------------------------------------------------------------

type Cmd = Parameters<RunController['command']>[0]

/** A controller whose reducer is `react`: it answers the command and may change the finalize state later. */
function fakeController(
  react: (cmd: Cmd, f: FinalizeRunState, later: (fn: (f: FinalizeRunState) => void) => void) => void | string,
) {
  const f: FinalizeRunState = { state: 'pending', lease: 'none', applies: [], applyNo: 0 }
  const state = { runId: RUN, isolation: { rows: [], finalize: f } } as unknown as RunState
  const listeners = new Set<() => void>()
  const later = (fn: (x: FinalizeRunState) => void): void => {
    setTimeout(() => {
      fn(f)
      for (const l of [...listeners]) l()
    }, 5)
  }
  const c = {
    state,
    command: vi.fn((cmd: Cmd) => {
      const refusal = react(cmd, f, later)
      return Promise.resolve(
        typeof refusal === 'string'
          ? { ok: false, error: { code: 'CONFLICT', message: refusal } }
          : { ok: true, value: undefined },
      )
    }),
    waitFor: (pred: (s: RunState) => boolean, ms?: number) =>
      new Promise<RunState>((resolve, reject) => {
        if (pred(state)) {
          resolve(state)
          return
        }
        const check = (): void => {
          if (!pred(state)) return
          listeners.delete(check)
          resolve(state)
        }
        listeners.add(check)
        if (ms !== undefined) setTimeout(() => reject(new Error('timeout')), ms)
      }),
  }
  return c
}

function host(c: ReturnType<typeof fakeController>, waitMs?: number): WorktreeHost {
  return createWorktreeHost({
    paths: homePaths('/nowhere'),
    controller: () => Promise.resolve(c as unknown as RunController),
    readDoc: () => Promise.resolve(null),
    ...(waitMs !== undefined ? { waitMs } : {}),
  })
}

describe('the controller-backed host', () => {
  it('apply: sends the command, then answers with the run’s record of that apply', async () => {
    const c = fakeController((cmd, f, later) => {
      if (cmd.kind !== 'apply') return
      f.applyNo += 1
      const no = f.applyNo
      f.op = { kind: 'apply', no, ...(cmd.paths !== undefined ? { paths: cmd.paths } : {}) }
      later((x) => {
        delete x.op
        x.applies.push({ no, token: 'apply-tok', at: 1, applied: ['a.txt'], conflicts: ['c.txt'] })
      })
    })
    expect(await host(c).apply(RUN, { paths: ['a.txt', 'c.txt'] })).toEqual({
      applied: ['a.txt'],
      conflicts: ['c.txt'],
      undoToken: 'apply-tok',
    })
    expect(c.command).toHaveBeenCalledWith({ kind: 'apply', paths: ['a.txt', 'c.txt'] })
  })

  it("apply: a failure the run records is the answer's error; a refusal keeps its code", async () => {
    const c = fakeController((cmd, f, later) => {
      if (cmd.kind !== 'apply') return
      f.applyNo += 1
      const no = f.applyNo
      f.op = { kind: 'apply', no }
      later((x) => {
        delete x.op
        x.failedNo = no
        x.error = 'git cat-file failed'
      })
    })
    await expect(host(c).apply(RUN, {})).rejects.toMatchObject({
      code: 'GIT',
      message: 'git cat-file failed',
    })
    const refused = fakeController(() => 'An apply was interrupted. Finish it first (its card in the run).')
    await expect(host(refused).apply(RUN, {})).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('apply: still waiting for the folder after the wait answers TIMEOUT (the apply goes on in the run)', async () => {
    const c = fakeController((cmd, f) => {
      if (cmd.kind !== 'apply') return
      f.applyNo += 1
      f.op = { kind: 'apply', no: f.applyNo }
    })
    await expect(host(c, 30).apply(RUN, {})).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('undoApply: done once the record reads undone; a refused undo is CONFLICT with the run’s words', async () => {
    const make = (ok: boolean) =>
      fakeController((cmd, f, later) => {
        if (cmd.kind !== 'undo-apply') return
        f.applies = [{ no: 1, token: cmd.token, at: 1, applied: ['a'], conflicts: [] }]
        f.op = { kind: 'undo', token: cmd.token }
        later((x) => {
          delete x.op
          const rec = x.applies[0]
          if (ok && rec !== undefined) rec.undone = true
          else x.error = 'Undo refused: 1 file changed after the apply (a). Nothing was written.'
        })
      })
    await expect(host(make(true)).undoApply(RUN, 'apply-1')).resolves.toBeUndefined()
    await expect(host(make(false)).undoApply(RUN, 'apply-1')).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('discard answers the deferred deletion at once; undoDiscard sends its token', async () => {
    const c = fakeController((cmd, f) => {
      if (cmd.kind === 'discard') f.discard = { token: 'discard-9', deleteAt: 12_345, back: 'pending' }
    })
    const hst = host(c)
    expect(await hst.discard(RUN)).toEqual({ undoToken: 'discard-9', deleteAt: 12_345 })
    await hst.undoDiscard(RUN, 'discard-9')
    expect(c.command).toHaveBeenLastCalledWith({ kind: 'undo-discard', token: 'discard-9' })
  })

  it('preview: a run that is not isolated, or not found, is NOT_FOUND', async () => {
    const hst = createWorktreeHost({
      paths: homePaths('/nowhere'),
      controller: () => Promise.reject(new Error('unused')),
      readDoc: (id) =>
        Promise.resolve(
          id === 'inplace'
            ? ({ state: { runId: id, config: { isolation: 'inPlace' } } } as unknown as Awaited<
                ReturnType<Parameters<typeof createWorktreeHost>[0]['readDoc']>
              >)
            : null,
        ),
    })
    await expect(hst.preview('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(hst.preview('inplace')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'This run has no isolated copy.',
    })
  })
})
