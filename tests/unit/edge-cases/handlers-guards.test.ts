// Coverage: the core command table's own guards (the IPC contract: an unknown command is
// UNKNOWN_COMMAND, an unbuilt one UNSUPPORTED; a read-only core (the CLI beside the app) refuses every command that
// changes a run with FORBIDDEN before the run is touched; requests are checked before any host call). The host is a
// stub whose every member is a spy, so "never touched" is checked, not assumed.
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_AREA } from '@shared/ipc.ts'
import type { Cmd, Req } from '@shared/ipc.ts'
import { createHandlers, dispatch, parseStatuses } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { UserCommand } from '@core/supervisor/types.ts'

const RUN = '20261012T120000Z-m17g'

function host(o: { readOnly?: boolean; paused?: boolean; status?: string; known?: boolean } = {}) {
  const command = vi.fn((_c: UserCommand) => Promise.resolve({ ok: true as const, value: undefined }))
  const state = {
    status: o.status ?? 'running',
    steps: {
      prepare: { status: 'skipped' },
      implement: { status: o.paused === true ? 'paused' : 'running' },
    },
  }
  const controller = vi.fn(() => Promise.resolve({ command, state }))
  const startRun = vi.fn(() => Promise.resolve({ runId: RUN }))
  const readDoc = vi.fn(() => Promise.resolve(o.known === false ? null : { state, lastSeq: 3 }))
  const replay = vi.fn(() => ({ events: [], lastSeq: 3, hasMore: false }))
  const patch = vi.fn(() => Promise.resolve({ changed: false }))
  const runGit = {
    revert: vi.fn(),
    undoRevert: vi.fn(),
    files: vi.fn(),
    file: vi.fn(),
    branch: vi.fn(),
  }
  const ctx = {
    kind: 'cli',
    readOnly: o.readOnly === true,
    controller,
    liveController: vi.fn(() => undefined),
    readDoc,
    startRun,
    bus: { replay, lastSeq: vi.fn(() => 3) },
    config: { patch },
    runGit,
  } as unknown as HandlerContext
  return { h: createHandlers(ctx), command, controller, startRun, readDoc, replay, patch, runGit }
}

const codeOf = (r: { ok: boolean; error?: { code: string } }): string | null =>
  r.ok ? null : (r.error?.code ?? null)

describe('dispatch', () => {
  it('a command that is not in the contract is UNKNOWN_COMMAND, inherited names included', async () => {
    const { h } = host()
    for (const cmd of ['runs.nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
      const r = await dispatch(h, cmd as Cmd, {})
      expect(r).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${cmd}".` },
      })
    }
  })

  it('a contract command this build has no handler for is UNSUPPORTED', async () => {
    const r = await dispatch({}, 'runs.list', {})
    expect(r).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED', message: 'runs.list is not available in this build.' },
    })
  })

  it('a handler that throws a plain fs error answers STORAGE; anything else INTERNAL; never a rejection', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const storage = await dispatch({ 'runs.list': () => Promise.reject(enospc) }, 'runs.list', {})
    expect(storage).toMatchObject({
      ok: false,
      error: { code: 'STORAGE', details: { category: 'disk_full' } },
    })
    const internal = await dispatch(
      {
        'runs.list': () => {
          throw new TypeError('boom')
        },
      },
      'runs.list',
      {},
    )
    expect(internal).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'boom' } })
  })
})

describe('a read-only core refuses every run change before touching the run', () => {
  const cases: [Cmd, unknown][] = [
    ['runs.start', { folder: 'C:\\w', task: 'Add a flag.' }],
    ['runs.stop', { runId: RUN }],
    ['runs.close', { runId: RUN }],
    ['runs.resume', { runId: RUN }],
    ['runs.retryPass', { runId: RUN, pass: 'implement' }],
    ['runs.skipPass', { runId: RUN, pass: 'review' }],
    ['runs.keepWaiting', { runId: RUN, pass: 'implement' }],
    ['runs.switchToAuto', { runId: RUN }],
    ['asks.answer', { runId: RUN, requestId: 'r1', decision: 'allow' }],
    ['asks.undo', { runId: RUN, requestId: 'r1' }],
    ['cards.resolve', { runId: RUN, cardId: 'c1', choiceId: 'ok' }],
    ['diff.revert', { runId: RUN, paths: ['src/a.ts'] }],
    ['diff.undoRevert', { runId: RUN, undoToken: 'tok' }],
    ['diff.files', { runId: RUN, seg: 'combined' }],
    ['diff.file', { runId: RUN, seg: 'implement', path: 'src/a.ts' }],
    ['runs.branch', { runId: RUN, action: 'delete' }],
  ]

  it.each(cases)('%s: FORBIDDEN', async (cmd, req) => {
    expect(Object.prototype.hasOwnProperty.call(COMMAND_AREA, cmd)).toBe(true)
    const s = host({ readOnly: true, paused: true })
    const r = await dispatch(s.h, cmd, req as Req<typeof cmd>)
    expect(r).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'This Dim Factory process is read-only.' },
    })
    expect(s.controller).not.toHaveBeenCalled()
    expect(s.command).not.toHaveBeenCalled()
    expect(s.startRun).not.toHaveBeenCalled()
    for (const f of Object.values(s.runGit)) expect(f).not.toHaveBeenCalled()
  })

  it('the same requests reach the run on a writable core', async () => {
    const s = host({ paused: true })
    expect(await dispatch(s.h, 'runs.stop', { runId: RUN })).toEqual({ ok: true, value: undefined })
    expect(s.command).toHaveBeenLastCalledWith({ kind: 'stop' })
    expect(await dispatch(s.h, 'asks.answer', { runId: RUN, requestId: 'r1', decision: 'deny' })).toEqual({
      ok: true,
      value: undefined,
    })
    // The CLI core answers as the CLI.
    expect(s.command).toHaveBeenLastCalledWith({
      kind: 'answer',
      requestId: 'r1',
      decision: 'deny',
      via: 'cli',
    })
    expect(await dispatch(s.h, 'runs.resume', { runId: RUN, allowTimedOutAsk: true })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(s.command).toHaveBeenLastCalledWith({ kind: 'resume', allowTimedOutAsk: true })
  })
})

describe('requests are checked before the host is called', () => {
  it('runs.start needs a folder and a task', async () => {
    const s = host()
    for (const req of [null, {}, { folder: ' ', task: 'x' }, { folder: 'C:\\w', task: '  ' }]) {
      expect(codeOf(await dispatch(s.h, 'runs.start', req as Req<'runs.start'>))).toBe('VALIDATION')
    }
    expect(s.startRun).not.toHaveBeenCalled()
  })

  it('a run command needs a run id; asks need a known decision; passes a pass name', async () => {
    const s = host()
    expect(codeOf(await dispatch(s.h, 'runs.stop', {} as Req<'runs.stop'>))).toBe('VALIDATION')
    expect(codeOf(await dispatch(s.h, 'runs.stop', { runId: '' }))).toBe('VALIDATION')
    expect(
      codeOf(
        await dispatch(s.h, 'asks.answer', {
          runId: RUN,
          requestId: 'r1',
          decision: 'always',
        } as unknown as Req<'asks.answer'>),
      ),
    ).toBe('VALIDATION')
    expect(
      codeOf(
        await dispatch(s.h, 'runs.retryPass', {
          runId: RUN,
          pass: 'verify',
        } as unknown as Req<'runs.retryPass'>),
      ),
    ).toBe('VALIDATION')
    expect(s.command).not.toHaveBeenCalled()
  })

  it("diff paths must be the run's relative paths: no traversal, no absolute path, no drive", async () => {
    const s = host()
    for (const paths of [
      ['../outside.txt'],
      ['src/../../x'],
      ['/etc/passwd'],
      ['C:\\Windows\\x'],
      ['\\\\srv\\s'],
      [' '],
      [],
    ]) {
      expect(codeOf(await dispatch(s.h, 'diff.revert', { runId: RUN, paths }))).toBe('VALIDATION')
    }
    expect(codeOf(await dispatch(s.h, 'diff.file', { runId: RUN, seg: 'implement', path: '../x' }))).toBe(
      'VALIDATION',
    )
    expect(
      codeOf(await dispatch(s.h, 'diff.files', { runId: RUN, seg: 'S0' } as unknown as Req<'diff.files'>)),
    ).toBe('VALIDATION')
    expect(
      codeOf(
        await dispatch(s.h, 'runs.branch', { runId: RUN, action: 'push' } as unknown as Req<'runs.branch'>),
      ),
    ).toBe('VALIDATION')
    for (const f of Object.values(s.runGit)) expect(f).not.toHaveBeenCalled()
  })

  it('runs.events: an unknown run is NOT_FOUND; sinceSeq must be a number ≥ 0', async () => {
    const gone = host({ known: false })
    expect(codeOf(await dispatch(gone.h, 'runs.events', { runId: RUN, sinceSeq: 0 }))).toBe('NOT_FOUND')
    const s = host()
    expect(codeOf(await dispatch(s.h, 'runs.events', { runId: RUN, sinceSeq: -1 }))).toBe('VALIDATION')
    expect(
      codeOf(
        await dispatch(s.h, 'runs.events', { runId: RUN, sinceSeq: '0' } as unknown as Req<'runs.events'>),
      ),
    ).toBe('VALIDATION')
    expect(s.replay).not.toHaveBeenCalled()
    expect(await dispatch(s.h, 'runs.events', { runId: RUN, sinceSeq: 2 })).toMatchObject({ ok: true })
    expect(s.replay).toHaveBeenCalledWith(RUN, 2, 2000)
  })

  it('config.patch takes only JSON Patch operations', async () => {
    const s = host()
    for (const ops of [undefined, 'add', [{ op: 'move', from: '/a', path: '/b' }], [{ op: 'add' }]]) {
      expect(
        codeOf(await dispatch(s.h, 'config.patch', { scope: 'user', ops } as unknown as Req<'config.patch'>)),
      ).toBe('VALIDATION')
    }
    expect(s.patch).not.toHaveBeenCalled()
    expect(
      await dispatch(s.h, 'config.patch', {
        scope: 'user',
        ops: [{ op: 'replace', path: '/auto', value: true }],
      }),
    ).toMatchObject({ ok: true })
    expect(s.patch).toHaveBeenCalledWith({
      scope: 'user',
      ops: [{ op: 'replace', path: '/auto', value: true }],
    })
  })
})

describe('runs.resume', () => {
  it('a run with nothing paused: CONFLICT, unless an earlier process left it queued or waiting (then a no-op)', async () => {
    const running = host({ status: 'running' })
    expect(await dispatch(running.h, 'runs.resume', { runId: RUN })).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'Nothing is paused.' },
    })
    for (const status of ['queued', 'waiting']) {
      const s = host({ status })
      expect(await dispatch(s.h, 'runs.resume', { runId: RUN })).toEqual({ ok: true, value: undefined })
      expect(s.command).not.toHaveBeenCalled()
    }
  })
})

describe('parseStatuses (the CLI --status filter)', () => {
  it('reads a comma list, trimming and skipping blanks', () => {
    expect(parseStatuses(' running, paused ,,')).toEqual(['running', 'paused'])
    expect(parseStatuses('')).toEqual([])
  })

  it('refuses an unknown status, naming the ones it takes', () => {
    expect(() => parseStatuses('running,done')).toThrow(/Unknown status "done"\. Use: .*running/)
  })
})
