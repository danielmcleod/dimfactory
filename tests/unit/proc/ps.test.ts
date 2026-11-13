import { describe, expect, it } from 'vitest'
import {
  CIM_SCRIPT,
  exeKey,
  findDescendants,
  parseBootTime,
  parseCimJson,
  parseCimSnapshot,
  parseDarwinBootTime,
  parseDarwinPs,
  parseProcStat,
  parseTasklistCsv,
} from '../../../src/core/proc/ps.ts'
import type { ProcInfo } from '../../../src/core/proc/ps.ts'

describe('win32 parsers', () => {
  it('the CIM command is a valid statement sequence', () => {
    expect(CIM_SCRIPT).toMatch(
      /^\$ErrorActionPreference='SilentlyContinue'; \[Console\]::OutputEncoding=\S+; \$o=Get-CimInstance Win32_OperatingSystem /,
    )
    expect(CIM_SCRIPT).toContain('ConvertTo-Json -Compress -Depth 3')
    expect(CIM_SCRIPT).not.toContain('"')
  })

  it('parses the {b,p} wrapper with the boot time, and the PowerShell 5.1 {value,Count} array form', () => {
    const row = { ProcessId: 7, ParentProcessId: 1, c: 5, Name: 'a.exe', ExecutablePath: 'C:\\a.exe' }
    expect(parseCimSnapshot(JSON.stringify({ b: 1789548684842, p: [row] }))).toEqual({
      bootMs: 1789548684842,
      procs: [{ pid: 7, ppid: 1, startMs: 5, exe: 'C:\\a.exe' }],
    })
    expect(parseCimSnapshot(JSON.stringify({ b: null, p: { value: [row], Count: 1 } }))).toEqual({
      bootMs: null,
      procs: [{ pid: 7, ppid: 1, startMs: 5, exe: 'C:\\a.exe' }],
    })
    expect(parseCimSnapshot(JSON.stringify([row])).bootMs).toBeNull()
  })

  it('parses CIM JSON arrays and a bare single object', () => {
    const json = JSON.stringify([
      { ProcessId: 0, ParentProcessId: 0, c: null, Name: 'System Idle Process', ExecutablePath: null },
      {
        ProcessId: 4242,
        ParentProcessId: 100,
        c: 1789548682047,
        Name: 'node.exe',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      },
    ])
    expect(parseCimJson(json)).toEqual([
      { pid: 0, ppid: 0, startMs: null, exe: 'System Idle Process' },
      { pid: 4242, ppid: 100, startMs: 1789548682047, exe: 'C:\\Program Files\\nodejs\\node.exe' },
    ])
    expect(
      parseCimJson('{"ProcessId":7,"ParentProcessId":1,"c":5,"Name":"a.exe","ExecutablePath":null}'),
    ).toEqual([{ pid: 7, ppid: 1, startMs: 5, exe: 'a.exe' }])
    expect(parseCimJson('  ')).toEqual([])
  })

  it('parses tasklist CSV (no ppid, no start time)', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","4242","Console","1","45,120 K"',
      '',
    ].join('\r\n')
    expect(parseTasklistCsv(csv)).toEqual([
      { pid: 0, ppid: null, startMs: null, exe: 'System Idle Process' },
      { pid: 4242, ppid: null, startMs: null, exe: 'node.exe' },
    ])
  })
})

describe('linux /proc parser', () => {
  it('reads ppid, pgid and start time after the last parenthesis', () => {
    const boot = parseBootTime('cpu  1 2 3\nbtime 1700000000\nprocesses 5\n')
    expect(boot).toBe(1_700_000_000_000)
    const stat = '4242 (node (worker) x) S 100 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 7 0 12345 0 0'
    expect(parseProcStat(stat, boot ?? 0)).toEqual({
      pid: 4242,
      comm: 'node (worker) x',
      ppid: 100,
      pgid: 4242,
      startMs: 1_700_000_000_000 + 123_450,
    })
    expect(parseProcStat('garbage', 0)).toBeNull()
  })
})

describe('darwin ps parser', () => {
  it('parses lstart and commands with spaces', () => {
    const out = [
      '    1     0     1 Mon Oct  5 09:00:01 2026     /sbin/launchd',
      ' 4242   100  4242 Mon Oct  5 16:56:01 2026     /Applications/Claude Helper.app/Contents/MacOS/claude',
      'garbage line',
    ].join('\n')
    const procs = parseDarwinPs(out)
    expect(procs).toHaveLength(2)
    expect(procs[1]).toMatchObject({
      pid: 4242,
      ppid: 100,
      pgid: 4242,
      exe: '/Applications/Claude Helper.app/Contents/MacOS/claude',
    })
    expect(procs[1]?.startMs).toBe(new Date('Mon Oct 5 16:56:01 2026').getTime())
  })

  it('parses kern.boottime', () => {
    expect(parseDarwinBootTime('{ sec = 1789548684, usec = 123456 } Mon Oct  5 09:00:01 2026\n')).toBe(
      1_789_548_684_000,
    )
    expect(parseDarwinBootTime('')).toBeNull()
  })
})

describe('findDescendants', () => {
  const p = (pid: number, ppid: number | null, startMs: number | null = 1000): ProcInfo => ({
    pid,
    ppid,
    startMs,
    exe: 'x',
  })

  it('walks through dead roots (Windows does not reparent) and honours the start-time guard', () => {
    const procs = [p(10, 1), p(11, 10), p(12, 11), p(20, 99), p(21, 20), p(30, 99, 10), p(31, 30, 2000)]
    // root 99 is dead (absent): 20 and its child 21 are found; 30 started before minStartMs → skipped with its subtree.
    const found = findDescendants(procs, [10, 99], { minStartMs: 500 }).map((x) => x.pid)
    expect(found.sort((a, b) => a - b)).toEqual([11, 12, 20, 21])
    expect(
      findDescendants(procs, [99])
        .map((x) => x.pid)
        .sort((a, b) => a - b),
    ).toEqual([20, 21, 30, 31])
  })

  it('never loops on pid cycles and excludes roots', () => {
    const procs = [p(1, 2), p(2, 1), p(3, 3)]
    expect(findDescendants(procs, [1]).map((x) => x.pid)).toEqual([2])
    expect(findDescendants(procs, [3])).toEqual([])
  })

  it('bounds direct children of a root by maxChildStartMs; deeper levels only by their parent', () => {
    const procs = [p(20, 99, 1000), p(21, 99, 5000), p(22, 20, 6000)]
    expect(findDescendants(procs, [99], { maxChildStartMs: 2000 }).map((x) => x.pid)).toEqual([20, 22])
  })

  it('skips a process that predates its parent (a stale ppid of a reused pid) and unknown starts when bounded', () => {
    const procs = [p(11, 10, 1000), p(12, 11, 500), p(13, 11, null), p(14, 11, 1500)]
    expect(findDescendants(procs, [10], { minStartMs: 0 }).map((x) => x.pid)).toEqual([11, 14])
    expect(findDescendants(procs, [10]).map((x) => x.pid)).toEqual([11, 13, 14])
  })

  it('cannot see below a parent that already exited (Windows; documented limitation)', () => {
    // root 100 → bash 200 (exited) → node 300: 300's ppid names a pid that is gone.
    const procs = [p(100, 1, 1000), p(300, 200, 2000)]
    expect(findDescendants(procs, [100], { minStartMs: 0 })).toEqual([])
  })
})

describe('exeKey', () => {
  it('normalizes win32 names and keeps POSIX basenames', () => {
    expect(exeKey('C:\\Program Files\\nodejs\\NODE.EXE', 'win32')).toBe('node')
    expect(exeKey('node.exe', 'win32')).toBe('node')
    expect(exeKey('/usr/local/bin/node', 'linux')).toBe('node')
  })
})
