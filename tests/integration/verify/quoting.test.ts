// win32 quoting corpus (verify command execution: .cmd/.bat run via ComSpec /d /s /c with cross-spawn's escaping,
// ported in src/core/proc/win-cmd.ts). Each case spawns a real batch file that forwards `%*` to node, which prints
// its argv as JSON; the arguments must arrive byte for byte. Injection attempts (&, |, ^, !VAR!, quotes, parentheses)
// stay literal: no canary file appears and nothing else is printed. A line break and any `%` are refused before
// anything is spawned: cmd.exe ends a command at a newline, and it expands %VAR% and its substitution forms
// (%CD:\=/%, %PATH:a=b%) on the /c line before carets are read, so no escape keeps either literal. The
// batch files live in a folder whose name needs escaping too, in node_modules\.bin (cross-spawn's shim case) and
// elsewhere (.cmd and .bat).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import { homePaths } from '../../../src/core/home.ts'
import { SpawnError, spawnChild } from '../../../src/core/proc/spawn.ts'
import { batchInvocation } from '../../../src/core/proc/win-cmd.ts'
import { readBody } from '../../../src/core/verify/discover.ts'
import { runVerifyRound, verifyChildEnv } from '../../../src/core/verify/run.ts'

const isWin = process.platform === 'win32'

let base = ''
let dir = ''
const launchers: Record<'shim' | 'cmd' | 'bat', string> = { shim: '', cmd: '', bat: '' }

beforeAll(() => {
  if (!isWin) return
  base = mkdtempSync(join(tmpdir(), 'dim-factory-quoting-'))
  dir = join(base, 'dir with space (x86) & co')
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const body = `@"${process.execPath}" "%~dp0ECHO_JS" %*\r\n`
  launchers.shim = join(dir, 'node_modules', '.bin', 'echo-args.cmd')
  writeFileSync(launchers.shim, body.replace('ECHO_JS', '..\\..\\echo.cjs'))
  launchers.cmd = join(dir, 'echo-args.cmd')
  writeFileSync(launchers.cmd, body.replace('ECHO_JS', 'echo.cjs'))
  launchers.bat = join(dir, 'echo args.bat')
  writeFileSync(launchers.bat, body.replace('ECHO_JS', 'echo.cjs'))
})

afterAll(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const CANARY_VAR = 'DIM_FACTORY_QUOTING_CANARY'

async function echo(
  file: string,
  args: readonly string[],
  cwd = dir,
): Promise<{ out: string; err: string; code: number | null }> {
  const env = { ...verifyChildEnv(process.env, process.env['PATH'] ?? '', cwd), [CANARY_VAR]: 'EXPANDED' }
  const inv = batchInvocation(file, args, { env })
  const child = await spawnChild({
    command: inv.command,
    args: inv.args,
    cwd,
    env,
    stdin: 'ignore',
    windowsVerbatimArguments: true,
  })
  const out: string[] = []
  const err: string[] = []
  const read = async (s: 'stdout' | 'stderr', into: string[]): Promise<void> => {
    for await (const l of child.lines(s)) into.push(l)
  }
  const reads = Promise.all([read('stdout', out), read('stderr', err)])
  const exit = await child.exited
  await reads
  return { out: out.join('\n'), err: err.join('\n'), code: exit.code }
}

const CASES: Record<string, string[]> = {
  plain: ['test', '--reporter=dot'],
  spaces: ['two words', ' leading', 'trailing ', '   '],
  empty: ['', 'a', '', 'b', ''],
  quotes: ['"quoted"', 'a"b', '"', '""', '"""', "it's", '"a b" c'],
  'backslashes before quotes': ['a\\"b', 'a\\\\"b', '\\"', '\\\\"x\\\\"'],
  'trailing backslashes': ['C:\\dir\\', 'C:\\dir\\\\', '\\', 'back\\slash\\path'],
  ampersand: ['&', 'a&b', 'a && echo INJECTED', '&&'],
  pipe: ['|', 'a|b', 'a || echo INJECTED'],
  caret: ['^', 'a^b', '^^', '^&', 'end^'],
  redirection: ['<', '>', 'a<b>c', '> canary.txt', '2>&1', '>>canary.txt'],
  'delayed expansion': [`!${CANARY_VAR}!`, '!PATH!', '!', 'a!b!c'],
  parentheses: ['(', ')', '(a)', 'a)b(c', ') & echo INJECTED & ('],
  'other metacharacters': ['a;b', 'a,b', 'a=b', '*', '?', 'a*b?', '`backtick`', '[x]', '$HOME', '#'],
  'tab and unicode': ['tab\there', 'é ✓ 日本語', 'emoji 🎉'],
  'quote-breaking injections': [
    '"&echo INJECTED>canary.txt&"',
    '\\"&echo INJECTED>canary.txt&\\"',
    'a\\" & echo INJECTED > canary.txt & "',
    '^"&echo INJECTED>canary.txt^"',
    '" | echo INJECTED > canary.txt | "',
  ],
  'many arguments': Array.from({ length: 40 }, (_, i) => `arg ${i} & ${'^'.repeat(i % 4)}"`),
}

/** Arguments cmd.exe would expand on the /c line: each is refused (EARGV) before anything runs. */
const PERCENT: readonly string[] = [
  '%PATH%',
  `%${CANARY_VAR}%`,
  `%${CANARY_VAR}`,
  '100%',
  '%%',
  '%1',
  '%*',
  '%~dp0',
  '%~1',
  `"%${CANARY_VAR}%"`,
  '%PATH:~0,1%',
  '%PATH:a=b%',
  `%${CANARY_VAR}:E=X%`,
  '%CD:\\=/%',
  '%VAR:x=y&echo INJECTED>canary.txt&%',
  `%${CANARY_VAR}:E=x&echo INJECTED>canary.txt&%`,
  `%${CANARY_VAR}:~0,1%&echo INJECTED>canary.txt`,
]

describe.skipIf(!isWin)('win32 batch-file quoting corpus', () => {
  for (const kind of ['shim', 'cmd', 'bat'] as const) {
    describe.concurrent(`via ${kind === 'shim' ? 'node_modules\\.bin\\*.cmd' : `a .${kind} file`}`, () => {
      for (const [name, args] of Object.entries(CASES)) {
        it(name, async () => {
          const r = await echo(launchers[kind], args)
          expect(r.err).toBe('')
          expect(r.code).toBe(0)
          expect(JSON.parse(r.out)).toEqual(args)
          expect(existsSync(join(dir, 'canary.txt'))).toBe(false)
        })
      }
    })
  }

  it('any % in an argument is refused before anything is spawned (substitution forms included)', async () => {
    for (const kind of ['shim', 'cmd', 'bat'] as const) {
      for (const arg of PERCENT) {
        const err = await echo(launchers[kind], ['ok', arg]).catch((e: unknown) => e)
        expect(err, `${kind} ${arg}`).toBeInstanceOf(SpawnError)
        expect((err as SpawnError).code).toBe('EARGV')
        expect((err as SpawnError).message).toMatch(/^Argument 2 contains %/)
      }
    }
    expect(existsSync(join(dir, 'canary.txt'))).toBe(false)
  })

  it('a batch file whose own path holds % is refused the same way', async () => {
    const odd = join(dir, 'a%PATH%b')
    mkdirSync(odd, { recursive: true })
    const file = join(odd, 'echo-args.cmd')
    writeFileSync(file, `@"${process.execPath}" "%~dp0..\\echo.cjs" %*\r\n`)
    const err = await echo(file, ['ok']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SpawnError)
    expect((err as SpawnError).code).toBe('EARGV')
    expect((err as SpawnError).message).toMatch(/^The path of echo-args\.cmd contains %/)
  })

  it('a trusted %CD:\\=/% from a folder named "proj & mkdir PWNED & rem" never reaches cmd.exe', async () => {
    const proj = join(base, 'proj & mkdir PWNED & rem')
    mkdirSync(join(proj, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(proj, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(
      join(proj, 'node_modules', '.bin', 'mytool.cmd'),
      `@"${process.execPath}" "%~dp0..\\..\\echo.cjs" %*\r\n`,
    )
    const command = { name: 'mytool', argv: ['mytool', '--root=%CD:\\=/%'], cwdRel: '.' }
    const body = await readBody(proj, command)
    const g = { kind: 'verify' as const, argv: command.argv, cwdRel: '.', ...(body !== null ? { body } : {}) }
    const r = await runVerifyRound(
      {
        paths: homePaths(process.env['DIM_FACTORY_HOME'] ?? ''),
        pathEnv: process.env['PATH'] ?? '',
        grants: () => Promise.resolve({ commands: { [commandGrantHash(g)]: { ...g, at: 1 } } }),
      },
      {
        runId: '20261009T120000Z-quoting',
        round: 'verify:1',
        folder: proj,
        commands: [command],
        failFast: false,
      },
    )
    expect(r.results[0]).toMatchObject({ name: 'mytool', status: 'skipped', exitCode: null })
    expect(r.results[0]?.reason).toMatch(/^Argument 1 contains %/)
    expect(existsSync(join(proj, 'PWNED'))).toBe(false)
    expect(existsSync(join(base, 'PWNED'))).toBe(false)
  })

  it('a line break is refused before anything is spawned', async () => {
    for (const bad of ['a\nb', 'a\r\nb', 'a\rb', '&\necho INJECTED']) {
      const err = await echo(launchers.cmd, ['ok', bad]).catch((e: unknown) => e)
      expect(err, JSON.stringify(bad)).toBeInstanceOf(SpawnError)
      expect((err as SpawnError).code).toBe('EARGV')
    }
    expect(existsSync(join(dir, 'canary.txt'))).toBe(false)
  })
})
