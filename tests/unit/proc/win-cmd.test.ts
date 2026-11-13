// Batch-file escaping (src/core/proc/win-cmd.ts, ported from cross-spawn; verify execution). The strings
// here are pure; tests/integration/verify/quoting.test.ts runs the same escaping through a real cmd.exe.
import { describe, expect, it } from 'vitest'
import { SpawnError } from '../../../src/core/proc/spawn.ts'
import {
  BATCH_PERCENT_REASON,
  batchInvocation,
  comspecPath,
  escapeCmdArgument,
  escapeCmdCommand,
  isBatchFile,
  quoteForMsvcrt,
} from '../../../src/core/proc/win-cmd.ts'

describe('quoteForMsvcrt (the inside of a quoted argument)', () => {
  it('doubles a backslash run before a quote and escapes the quote', () => {
    expect(quoteForMsvcrt('a"b')).toBe('a\\"b')
    expect(quoteForMsvcrt('a\\"b')).toBe('a\\\\\\"b')
    expect(quoteForMsvcrt('a\\\\"b')).toBe('a\\\\\\\\\\"b')
  })

  it('doubles a trailing run (the closing quote follows); other backslashes are literal', () => {
    expect(quoteForMsvcrt('C:\\dir\\')).toBe('C:\\dir\\\\')
    expect(quoteForMsvcrt('C:\\dir\\\\')).toBe('C:\\dir\\\\\\\\')
    expect(quoteForMsvcrt('a\\\\b\\c')).toBe('a\\\\b\\c')
    expect(quoteForMsvcrt('')).toBe('')
  })

  it('is linear on long backslash runs (no regular-expression backtracking)', () => {
    const s = `${'\\'.repeat(200_000)}x`
    const started = Date.now()
    expect(quoteForMsvcrt(s)).toBe(s)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('escapeCmdArgument', () => {
  it('quotes, then caret-escapes every metacharacter (quotes included), once or twice', () => {
    expect(escapeCmdArgument('test', false)).toBe('^"test^"')
    expect(escapeCmdArgument('a b', false)).toBe('^"a^ b^"')
    expect(escapeCmdArgument('a b', true)).toBe('^^^"a^^^ b^^^"')
    expect(escapeCmdArgument('a&b|c', false)).toBe('^"a^&b^|c^"')
    expect(escapeCmdArgument('%PATH%', false)).toBe('^"^%PATH^%^"')
    expect(escapeCmdArgument('!X!', false)).toBe('^"^!X^!^"')
    expect(escapeCmdArgument('', false)).toBe('^"^"')
    expect(escapeCmdArgument('a"b', false)).toBe('^"a\\^"b^"')
  })

  it('leaves no metacharacter unescaped', () => {
    const meta = '()[]%!^"`<>&|;, *?'
    for (const ch of meta) {
      const once = escapeCmdArgument(`x${ch}y`, false)
      expect(once.replace(/\^./g, ''), ch).not.toMatch(/[()[\]%!^"`<>&|;, *?]/)
    }
  })
})

describe('batchInvocation', () => {
  const env = { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', SystemRoot: 'C:\\WINDOWS' }

  it('cmd.exe /d /v:off /s /c "<file> <args>" with verbatim arguments', () => {
    expect(batchInvocation('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'a&b'], { env })).toEqual({
      command: 'C:\\WINDOWS\\system32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"run^^^" ^^^"a^^^&b^^^""'],
      windowsVerbatimArguments: true,
    })
  })

  it('normalizes / in the file path; escapes its metacharacters once', () => {
    const inv = batchInvocation('C:/a (x86)/b&c/run.bat', [], { env })
    expect(inv.args[4]).toBe('"C:\\a^ ^(x86^)\\b^&c\\run.bat"')
    expect(escapeCmdCommand('a b')).toBe('a^ b')
  })

  it('single escaping only when asked', () => {
    expect(batchInvocation('C:\\r.cmd', ['a b'], { env, doubleEscape: false }).args[4]).toBe(
      '"C:\\r.cmd ^"a^ b^""',
    )
  })

  it('refuses % in any argument or in the path (cmd.exe expands %X:a=b% before carets count)', () => {
    for (const arg of ['%PATH%', '%PATH:a=b%', '%CD:\\=/%', '%VAR:x=y&echo INJECTED>canary.txt&%', '100%']) {
      let err: unknown
      try {
        batchInvocation('C:\\r.cmd', ['ok', arg], { env })
      } catch (e) {
        err = e
      }
      expect(err, arg).toBeInstanceOf(SpawnError)
      expect((err as SpawnError).code).toBe('EARGV')
      expect((err as SpawnError).message).toBe(`Argument 2 contains %: ${BATCH_PERCENT_REASON}`)
    }
    expect(() => batchInvocation('C:\\a%CD%b\\r.cmd', [], { env })).toThrow(/The path of r\.cmd contains %/)
    expect(BATCH_PERCENT_REASON).not.toContain('\u2014')
  })
})

describe('comspecPath / isBatchFile', () => {
  it('uses ComSpec only when it is an absolute cmd.exe', () => {
    expect(comspecPath({ ComSpec: 'D:\\Win\\System32\\cmd.exe' })).toBe('D:\\Win\\System32\\cmd.exe')
    expect(comspecPath({ COMSPEC: 'C:\\evil\\pwsh.exe', SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    )
    expect(comspecPath({ ComSpec: 'cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('.cmd and .bat in any case', () => {
    expect(isBatchFile('x.CMD')).toBe(true)
    expect(isBatchFile('x.bat')).toBe(true)
    expect(isBatchFile('x.exe')).toBe(false)
    expect(isBatchFile('x.cmd.exe')).toBe(false)
  })
})
