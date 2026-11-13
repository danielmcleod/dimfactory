import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DimFactoryError,
  fail,
  ok,
  storageError,
  toResult,
  toResultError,
  unwrap,
} from '../../../src/core/errors.ts'
import {
  createFileLogger,
  createMemoryLogger,
  sanitizeLogValue,
  silentLogger,
} from '../../../src/core/log.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

describe('errors', () => {
  it('DimFactoryError maps to its ResultCode; errnos map to STORAGE; anything else to INTERNAL', async () => {
    expect(await toResult(() => 5)).toEqual({ ok: true, value: 5 })
    expect(
      await toResult(() => {
        throw new DimFactoryError('FOLDER_BUSY', 'busy', { details: { runId: 'r' } })
      }),
    ).toEqual({ ok: false, error: { code: 'FOLDER_BUSY', message: 'busy', details: { runId: 'r' } } })
    expect(toResultError(Object.assign(new Error('nope'), { code: 'EACCES' })).code).toBe('STORAGE')
    expect(toResultError(new TypeError('bug'))).toEqual({ code: 'INTERNAL', message: 'bug' })
    expect(toResultError('str')).toEqual({ code: 'INTERNAL', message: 'str' })
    expect(storageError('w', Object.assign(new Error('full'), { code: 'ENOSPC' })).details).toEqual({
      errno: 'ENOSPC',
      category: 'disk_full',
    })
  })

  it('ok / fail / unwrap', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
    expect(fail('NOT_FOUND', 'x')).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } })
    expect(unwrap(ok('v'))).toBe('v')
    expect(() => unwrap(fail('GIT', 'g'))).toThrow(DimFactoryError)
  })
})

describe('log', () => {
  it('redacts secrets, the home path and emails; caps long strings; flattens errors', () => {
    const v = sanitizeLogValue(
      {
        key: 'sk-ant-abcdefghijklmnopqrstuvwxyz',
        path: 'C:\\Users\\alice\\proj\\x.ts',
        mail: 'alice@corp.com',
        long: 'z'.repeat(5000),
        err: Object.assign(new Error('boom sk-ant-abcdefghijklmnopqrstuvwxyz'), { code: 'EPERM' }),
      },
      { home: 'C:\\Users\\alice', username: 'alice' },
    ) as Record<string, unknown>
    expect(v['key']).toBe('[REDACTED]')
    expect(v['path']).toBe('~\\proj\\x.ts')
    expect(v['mail']).toBe('[email]')
    expect((v['long'] as string).length).toBeLessThan(2100)
    expect(v['err']).toMatchObject({ name: 'Error', message: 'boom [REDACTED]', code: 'EPERM' })
  })

  it('redacts before cutting: a secret straddling the 2000-character cut never leaks partially', () => {
    const token = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' // 36 characters after ghp_
    const msg = `${'x'.repeat(1961)}${token} tail`
    const v = sanitizeLogValue({ err: new Error(msg), stderr: msg }, {}) as Record<string, unknown>
    const text = JSON.stringify(v)
    expect(text).not.toContain('ghp_A1b2')
    expect(text).not.toContain('A1b2C3d4E5f6G7h8I9j0')
    expect(v['stderr']).toMatch(/^x{1961}\[REDACTED\]/)
    expect((v['stderr'] as string).length).toBeLessThan(2100)
    // Huge values: bounded pre-cut, still redacted, still capped.
    const huge = `${'y'.repeat(200_000)}${token}`
    expect(sanitizeLogValue(`${token} ${huge}`, {})).toMatch(/^\[REDACTED\] y+…\[\+\d+\]$/)
  })

  it('memory logger honours level and child bindings; silent logger is inert', async () => {
    const log = createMemoryLogger('info')
    log.debug('hidden')
    log.child({ runId: 'r1' }).warn('w', { n: 1 })
    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ level: 'warn', msg: 'w', runId: 'r1', n: 1 })
    silentLogger.error('x')
    await silentLogger.flush()
  })

  it('file logger writes JSONL and rotates at maxBytes keeping N files', async () => {
    const file = join(home(), 'logs', 'main.log')
    const log = createFileLogger({ file, maxBytes: 400, keep: 2 })
    for (let i = 0; i < 40; i++) {
      log.info('event', { i, pad: 'p'.repeat(40) })
      if (i % 5 === 4) await log.flush()
    }
    await log.close()
    const files = (await readdir(join(home(), 'logs'))).sort()
    expect(files).toEqual(['main.log', 'main.log.1', 'main.log.2'])
    const last = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { i: number })
    expect(last.at(-1)?.i).toBe(39)
    for (const f of files) {
      const text = await readFile(join(home(), 'logs', f), 'utf8')
      expect(text.length).toBeLessThan(800)
    }
  })
})
