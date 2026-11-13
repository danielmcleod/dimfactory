// The --smoke-test contract (src/main/smoke-args.ts, smoke.ts): env parsing, the single result line, and the run
// (wait for app.ready ≤ timeout, one core round trip, shutdown, print, exit code).
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmokeRun, printLine } from '../../../src/main/smoke.ts'
import type { SmokeDeps } from '../../../src/main/smoke.ts'
import { smokeFailLine, smokeMode, smokeOkLine } from '../../../src/main/smoke-args.ts'

describe('smokeMode', () => {
  it('is off without the flag', () => {
    expect(smokeMode(['electron', '.'], { DIM_FACTORY_HOME: '/h' })).toEqual({ enabled: false })
  })

  it('needs DIM_FACTORY_HOME (exit 2 otherwise)', () => {
    for (const env of [{}, { DIM_FACTORY_HOME: '' }, { DIM_FACTORY_HOME: '   ' }]) {
      expect(smokeMode(['app.exe', '--smoke-test'], env)).toEqual({
        enabled: true,
        ok: false,
        reason: 'DIM_FACTORY_HOME is required',
        exitCode: 2,
      })
    }
    expect(smokeFailLine('DIM_FACTORY_HOME is required')).toBe('SMOKE FAIL DIM_FACTORY_HOME is required')
  })

  it('runs with a home, packaged or not', () => {
    expect(smokeMode(['app.exe', '--smoke-test'], { DIM_FACTORY_HOME: ' C:\\t\\h ' })).toEqual({
      enabled: true,
      ok: true,
      home: 'C:\\t\\h',
    })
    expect(smokeMode(['electron.exe', '.', '--smoke-test'], { DIM_FACTORY_HOME: '/tmp/h' }).enabled).toBe(
      true,
    )
  })
})

describe('result lines', () => {
  it('SMOKE OK carries version, electron, platform and the rounded p95', () => {
    const line = smokeOkLine({
      version: '0.1.0',
      electron: '44.5.1',
      platform: 'win32',
      eventLoopP95Ms: 12.3456,
    })
    expect(line).toBe(
      'SMOKE OK {"version":"0.1.0","electron":"44.5.1","platform":"win32","eventLoopP95Ms":12.3}',
    )
    expect(JSON.parse(line.slice('SMOKE OK '.length))).toMatchObject({ eventLoopP95Ms: 12.3 })
  })

  it('SMOKE FAIL is always one line', () => {
    expect(smokeFailLine('a\nb\r\n  c')).toBe('SMOKE FAIL a b c')
    expect(smokeFailLine('')).toBe('SMOKE FAIL unknown error')
    expect(smokeFailLine('x'.repeat(2000)).length).toBeLessThan(520)
  })
})

describe('SmokeRun', () => {
  afterEach(() => vi.useRealTimers())

  function make(over: Partial<SmokeDeps> = {}) {
    const lines: string[] = []
    const exit = vi.fn()
    const shutdown = vi.fn(() => Promise.resolve())
    const run = new SmokeRun({
      verify: () => Promise.resolve(null),
      report: () => ({ version: '1.2.3', electron: '44.5.1', platform: 'linux', eventLoopP95Ms: 4 }),
      shutdown,
      print: (l) => {
        lines.push(l)
        return Promise.resolve()
      },
      exit,
      readyTimeoutMs: 1000,
      ...over,
    })
    return { run, lines, exit, shutdown }
  }

  it('prints SMOKE OK and exits 0 after app.ready and a good round trip', async () => {
    const { run, lines, exit, shutdown } = make()
    const p = run.start()
    run.rendererReady()
    await p
    expect(lines).toEqual([
      'SMOKE OK {"version":"1.2.3","electron":"44.5.1","platform":"linux","eventLoopP95Ms":4}',
    ])
    expect(shutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('fails with exit 1 when app.ready never comes', async () => {
    vi.useFakeTimers()
    const { run, lines, exit } = make()
    const p = run.start()
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(lines).toEqual(['SMOKE FAIL the renderer did not call app.ready within 1 s'])
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails when the round trip fails or throws', async () => {
    const a = make({ verify: () => Promise.resolve('STORAGE disk') })
    const pa = a.run.start()
    a.run.rendererReady()
    await pa
    expect(a.lines).toEqual(['SMOKE FAIL core round trip failed: STORAGE disk'])
    expect(a.exit).toHaveBeenCalledWith(1)

    const b = make({ verify: () => Promise.reject(new Error('boom')) })
    const pb = b.run.start()
    b.run.rendererReady()
    await pb
    expect(b.lines).toEqual(['SMOKE FAIL core round trip failed: boom'])
  })

  it('the first failure wins and nothing else is printed', async () => {
    const { run, lines, exit } = make()
    const p = run.start()
    await run.fail('the renderer process exited (crashed)')
    run.rendererReady()
    await p
    await run.fail('again')
    expect(lines).toEqual(['SMOKE FAIL the renderer process exited (crashed)'])
    expect(exit).toHaveBeenCalledTimes(1)
    expect(run.finished).toBe(true)
  })
})

describe('printLine', () => {
  it('writes one newline-terminated line and resolves once flushed', async () => {
    const s = new PassThrough()
    const chunks: string[] = []
    s.on('data', (c: Buffer) => chunks.push(c.toString('utf8')))
    await printLine('SMOKE OK {}', s)
    expect(chunks.join('')).toBe('SMOKE OK {}\n')
  })
})
