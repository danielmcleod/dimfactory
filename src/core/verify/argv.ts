// Verify commands are argv only (commands and trust): a configured string is tokenized
// quote-aware, and shell syntax in it is an error ("use a package script"). There is no shell path.
//
// Grammar: whitespace separates arguments; '…' is literal; "…" is literal except `\"` → `"` and `\\` → `\`;
// adjacent parts join (`--name="a b"` is one argument). Outside quotes a backslash is literal, so Windows paths work.
// Refused: CR/LF anywhere; `| & ; < > ( ) $ \`` and a `%…%` pair outside quotes; `$`, `\`` and a `%…%` pair inside
// "…" (a shell would expand them there too). Inside '…' everything is literal (a batch file still refuses `%` at
// spawn: proc/win-cmd.ts).

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; error: string }

const OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`'])
// Any `%…%` pair: cmd.exe expands `%NAME%` and its substitution forms (`%NAME:a=b%`, `%NAME:~0,1%`),
// whose names and patterns may hold almost any character. A lone `%` (`100%`) stays literal.
const WIN_VAR = /^%[^%]*%/

const shellError = (what: string): ArgvResult => ({
  ok: false,
  error: `${what} needs a shell, and Dim Factory runs verify commands without one: use a package script`,
})

/** Split a configured command line into argv (see the grammar above). */
export function tokenizeCommandLine(line: string): ArgvResult {
  if (/[\r\n]/.test(line)) return { ok: false, error: 'A verify command must be one line' }
  if (line.includes('\0')) return { ok: false, error: 'A verify command cannot contain a NUL character' }
  const argv: string[] = []
  let cur = ''
  let has = false
  let i = 0
  while (i < line.length) {
    const ch = line[i] ?? ''
    if (/\s/.test(ch)) {
      if (has) argv.push(cur)
      cur = ''
      has = false
      i++
      continue
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1)
      if (end === -1) return { ok: false, error: 'A quote is not closed' }
      cur += line.slice(i + 1, end)
      has = true
      i = end + 1
      continue
    }
    if (ch === '"') {
      i++
      let closed = false
      while (i < line.length) {
        const c = line[i] ?? ''
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
          cur += line[i + 1]
          i += 2
          continue
        }
        if (c === '$' || c === '`') return shellError(`\`${c}\``)
        const v = WIN_VAR.exec(line.slice(i))
        if (v !== null) return shellError(`\`${v[0]}\``)
        cur += c
        i++
      }
      if (!closed) return { ok: false, error: 'A quote is not closed' }
      has = true
      continue
    }
    if (OPERATORS.has(ch)) return shellError(`\`${ch}\``)
    const v = WIN_VAR.exec(line.slice(i))
    if (v !== null) return shellError(`\`${v[0]}\``)
    cur += ch
    has = true
    i++
  }
  if (has) argv.push(cur)
  if (argv.length === 0) return { ok: false, error: 'The verify command is empty' }
  return { ok: true, argv }
}

/** A configured `run` (argv or a line) as argv. An argv list is taken as is (no shell ever reads it). */
export function commandArgv(run: string | readonly string[]): ArgvResult {
  if (typeof run === 'string') return tokenizeCommandLine(run)
  if (run.length === 0 || run[0] === '') return { ok: false, error: 'The verify command is empty' }
  for (const a of run) {
    if (/[\0\r\n]/.test(a)) return { ok: false, error: 'A verify command argument contains a line break' }
  }
  return { ok: true, argv: [...run] }
}

// `%` is always quoted, so two arguments shown together never form a `%…%` pair.
const PLAIN = /^[A-Za-z0-9_\-+=.,/:@^~]+$/

/** One argument as the user would type it back (tokenizeCommandLine reads the result as the same argument). */
export function quoteArg(arg: string): string {
  if (arg !== '' && PLAIN.test(arg)) return arg
  if (!arg.includes("'")) return `'${arg}'`
  return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** argv as one display line (`pnpm run test`). */
export function displayArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}
