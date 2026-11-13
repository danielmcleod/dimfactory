// Running a Windows batch file (.cmd/.bat) without a shell line (ComSpec /d /s /c with
// cross-spawn's escaping). Every argument is quoted and caret-escaped so cmd.exe treats it as literal text.
//
// The escaping below is ported from cross-spawn 7.0.x (lib/util/escape.js, lib/parse.js):
//   The MIT License (MIT)
//   Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions
//   of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// Changes from cross-spawn (each one keeps more of the text literal, none keeps less):
// - The MSVC-runtime quoting is a linear scan (quoteForMsvcrt): cross-spawn 7.0.5+'s regular expressions double
//   only one backslash of a run before a quote.
// - Metacharacters are escaped twice for EVERY batch file, not only node_modules\.bin shims. A batch file that uses
//   its arguments (`%*`, `%1`) puts them through cmd's parser a second time, so a single escape lets `"`-tricks such
//   as `a\"&calc` out of their quotes. Global npm/pnpm shims (`%APPDATA%\npm\pnpm.cmd`) forward `%*` like any shim.
// - `/v:off` is added, so a registry-enabled DelayedExpansion cannot expand `!VAR!` inside an argument.
// - CR and LF are refused (validateArgv): cmd.exe ends a command at a newline, so no escape can keep one literal.
// - `%` is refused in the batch file's path and in every argument. cmd.exe expands `%NAME%` and its
//   substitution forms (`%NAME:old=new%`, `%NAME:~0,1%`) on the `/c` line before carets are read, and inserts the
//   value raw, so a `&` in it (a folder named `a & b` through `%CD:\=/%`) splits the line. No caret escape stops
//   that; refusing the character does. A verify command that needs `%` goes through a package script.
import { win32 } from 'node:path'
import { getEnv } from './env.ts'
import type { EnvInput } from './env.ts'
import { SpawnError } from './spawn.ts'

/** cmd.exe metacharacters (see http://www.robvanderwoude.com/escapechars.php). */
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

/** Escape the batch file's path (not quoted, every metacharacter caret-escaped). */
export function escapeCmdCommand(command: string): string {
  return command.replace(META_CHARS, '^$1')
}

/**
 * Quote one argument the way the MSVC runtime splits a command line (https://qntm.org/cmd), then caret-escape every
 * metacharacter, the quotes included, so cmd.exe never enters a quoted state; `doubleEscape` repeats the caret escape
 * for the batch file's own re-parse of its arguments.
 */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let s = `"${quoteForMsvcrt(`${arg}`)}"`
  s = s.replace(META_CHARS, '^$1')
  if (doubleEscape) s = s.replace(META_CHARS, '^$1')
  return s
}

/**
 * The inside of an MSVC-runtime quoted argument: a run of backslashes followed by a double quote has the backslashes
 * doubled and the quote escaped; a run at the end (followed by the closing quote) is doubled; other backslashes are
 * literal. cross-spawn writes this as two regular expressions; their backtracking-free form (`(?=(\\+?)?)\1"`)
 * doubles only the last backslash of a run, so `\\"` would end the quotes early. This is the same rule as one
 * linear scan.
 */
export function quoteForMsvcrt(arg: string): string {
  let out = ''
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') out += `${'\\'.repeat(slashes * 2)}\\"`
    else out += `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2)
}

export const isBatchFile = (file: string): boolean => /\.(?:cmd|bat)$/i.test(file)

/** cmd.exe to run batch files with: ComSpec when it names a cmd.exe by absolute path, else System32's. */
export function comspecPath(env: EnvInput = process.env): string {
  const spec = getEnv(env, 'ComSpec', 'win32')
  if (spec !== undefined && win32.isAbsolute(spec) && /(?:^|\\)cmd\.exe$/i.test(spec)) return spec
  const root = getEnv(env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
  return win32.join(root, 'System32', 'cmd.exe')
}

export interface CmdInvocation {
  command: string
  args: string[]
  /** Node must pass `args` as they are (they are already quoted and escaped). */
  windowsVerbatimArguments: true
}

/** Why `%` is refused for a batch file (UI copy: the reason a verify command was not run). */
export const BATCH_PERCENT_REASON =
  'cmd.exe would expand the % in it before the batch file runs, so Dim Factory does not pass it: use a package script'

/**
 * The longest `/c` line Dim Factory hands cmd.exe (argv limits: cmd.exe caps a command line
 * at 8,191 characters). cmd refuses a longer line itself ("The command line is too long.", exit 1), which a
 * verify step would read as the command failing; measured on Windows 11, a `/c` line of 8,147 characters ran and one
 * of 8,148 did not. The cap keeps a margin under that; a longer line is refused as EARGV before anything spawns.
 */
export const CMD_LINE_MAX = 8_000

/**
 * The spawn for a batch file and its arguments: `cmd.exe /d /v:off /s /c "<file> <arg>…"` with every part escaped.
 * `/d` skips AutoRun commands; `/s /c` strips exactly the outer quotes. Throws SpawnError EARGV when the path or an
 * argument holds `%` (see the header: no escape keeps it literal on the `/c` line), or when the quoted line is longer
 * than cmd.exe runs (CMD_LINE_MAX).
 */
export function batchInvocation(
  file: string,
  args: readonly string[],
  opts: { env?: EnvInput; doubleEscape?: boolean } = {},
): CmdInvocation {
  if (file.includes('%')) {
    throw new SpawnError('EARGV', `The path of ${win32.basename(file)} contains %: ${BATCH_PERCENT_REASON}`, {
      path: file,
    })
  }
  const pct = args.findIndex((a) => a.includes('%'))
  if (pct !== -1) {
    throw new SpawnError('EARGV', `Argument ${pct + 1} contains %: ${BATCH_PERCENT_REASON}`, { path: file })
  }
  const doubleEscape = opts.doubleEscape ?? true
  const line = [
    escapeCmdCommand(win32.normalize(file)),
    ...args.map((a) => escapeCmdArgument(a, doubleEscape)),
  ].join(' ')
  const quoted = `"${line}"`
  if (quoted.length > CMD_LINE_MAX) {
    throw new SpawnError(
      'EARGV',
      `The command for ${win32.basename(file)} is ${quoted.length} characters once quoted for cmd.exe; ` +
        `cmd.exe runs at most ${CMD_LINE_MAX}`,
      { path: file },
    )
  }
  return {
    command: comspecPath(opts.env),
    args: ['/d', '/v:off', '/s', '/c', quoted],
    windowsVerbatimArguments: true,
  }
}
