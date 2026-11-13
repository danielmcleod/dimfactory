// Security pass, child processes ("No shell, hidden windows"; `.cmd` needs a
// shell, argv caps at 32,767 chars and 8,191 via cmd.exe; verify execution "ComSpec /d /s /c with cross-spawn's
// escaping"). Only src/core/proc spawns; no spawn ever asks for a shell; the one route through a shell is the
// documented batch-file one (win-cmd.ts batchInvocation, the only verbatim-argument spawn), and it refuses a `/c` line
// longer than cmd.exe runs (cmd failed it as "The command line is too long.", which a verify step read as the
// command failing), as validateArgv refuses a command line longer than CreateProcess takes.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_WIN_COMMAND_LINE, SpawnError, validateArgv } from '../../../src/core/proc/spawn.ts'
import { CMD_LINE_MAX, batchInvocation } from '../../../src/core/proc/win-cmd.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mts|mjs|cjs|js)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${sep}protocol${sep}`))
}
const rel = (f: string): string => relative(resolve('.'), f).split(sep).join('/')
const code = (f: string): string[] =>
  readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))

const using = (re: RegExp, dir = 'src'): string[] =>
  sourceFiles(dir)
    .filter((f) => code(f).some((l) => re.test(l)))
    .map(rel)
    .sort()

describe('who spawns', () => {
  it('node:child_process is imported under src/core/proc only', () => {
    const files = using(/from\s+'(node:)?child_process'|require\(\s*'(node:)?child_process'\s*\)/)
    expect(files.filter((f) => !f.startsWith('src/core/proc/'))).toEqual([])
    expect(files).toEqual(['src/core/proc/spawn.ts'])
  })

  it('no spawn asks for a shell, and nothing but spawn is taken from child_process (exec always uses one)', () => {
    expect(using(/\bshell:\s*true\b/)).toEqual([])
    const imports = code(resolve('src/core/proc/spawn.ts'))
      .filter((l) => /from\s+'node:child_process'/.test(l))
      .map((l) => l.replace(/\s+/g, ' ').trim())
    expect(imports).toEqual([
      "import { spawn } from 'node:child_process'",
      "import type { ChildProcess } from 'node:child_process'",
    ])
    // Every spawn() call in spawn.ts passes shell: false explicitly.
    const lines = code(resolve('src/core/proc/spawn.ts')).join('\n')
    const calls = lines.split(/\bspawn\(/).slice(1)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.slice(0, 600)).toMatch(/shell:\s*false/)
  })

  it('verbatim arguments (the batch route through cmd.exe) come only from batchInvocation', () => {
    const files = using(/windowsVerbatimArguments/)
    expect(files).toEqual([
      'src/core/prepare/install.ts',
      'src/core/preview/service.ts',
      'src/core/proc/spawn.ts',
      'src/core/proc/win-cmd.ts',
      'src/core/verify/run.ts',
    ])
    for (const f of [
      'src/core/prepare/install.ts',
      'src/core/preview/service.ts',
      'src/core/verify/run.ts',
    ]) {
      const text = code(resolve(f)).join('\n')
      expect(text, f).toMatch(/inv = batchInvocation\(/)
      expect(text, f).toMatch(/windowsVerbatimArguments: false,/)
    }
  })

  it('Electron main, the preload and the renderer never spawn', () => {
    for (const dir of ['src/main', 'src/preload', 'src/renderer'])
      expect(using(/child_process|\bspawn\(|\bfork\(|utilityProcess/, dir), dir).toEqual([])
  })
})

describe('argv limits', () => {
  it('refuse NUL, CR and LF anywhere, and a win32 command line past CreateProcess', () => {
    for (const bad of ['a\0b', 'a\nb', 'a\rb']) {
      expect(() => validateArgv('C:\\x.exe', ['ok', bad], 'win32')).toThrow(SpawnError)
      expect(() => validateArgv('/x', [bad], 'linux')).toThrow(SpawnError)
    }
    expect(() => validateArgv('C:\\x.exe', ['a'.repeat(MAX_WIN_COMMAND_LINE)], 'win32')).toThrow(/limit is/)
    expect(MAX_WIN_COMMAND_LINE).toBeLessThan(32_767)
  })

  it('a batch file whose /c line is longer than cmd.exe runs is refused before it spawns', () => {
    const env = { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', SystemRoot: 'C:\\WINDOWS' }
    // Under the cap: runs. Each argument costs its quotes and escapes (doubled for a batch file).
    const fits = batchInvocation('C:\\p\\npm.cmd', ['run', 'a'.repeat(7_900)], { env })
    expect(fits.args[4]?.length).toBeLessThanOrEqual(CMD_LINE_MAX)
    let err: unknown
    try {
      batchInvocation('C:\\p\\npm.cmd', ['run', ...Array.from({ length: 500 }, (_, i) => `--flag-${i}`)], {
        env,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SpawnError)
    expect((err as SpawnError).code).toBe('EARGV')
    expect((err as SpawnError).message).toMatch(
      /^The command for npm\.cmd is \d+ characters once quoted for cmd\.exe; cmd\.exe runs at most 8000$/,
    )
    // The limit leaves a margin under what cmd.exe was measured to run (8,147 characters).
    expect(CMD_LINE_MAX).toBeLessThan(8_147)
    // Copy shown to the user: no em dash.
    expect((err as SpawnError).message).not.toContain('\u2014')
  })
})
