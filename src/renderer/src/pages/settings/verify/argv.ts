// A verify command line typed in Settings, as core reads it (argv only; a string
// is tokenized quote-aware; shell metacharacters are an error, "use a package script"; there is no `sh -c` path).
// A port of core's src/core/verify/argv.ts (the renderer may not import core): the same grammar and the same words, so
// the renderer refuses what core would refuse before anything is written; core checks again. A test runs one corpus
// through both (tests/renderer/verify/argv.test.ts).
//
// Grammar: whitespace separates arguments; '…' is literal; "…" is literal except `\"` → `"` and `\\` → `\`; adjacent
// parts join (`--name="a b"` is one argument). Outside quotes a backslash is literal, so Windows paths work.
// Refused: CR/LF anywhere; `| & ; < > ( ) $ \`` and a `%…%` pair outside quotes; `$`, `\`` and a `%…%` pair inside "…"
// (a shell would expand them there too). Inside '…' everything is literal.

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; message: string }

const OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`'])
// Any `%…%` pair: cmd.exe expands `%NAME%` and its substitution forms (`%NAME:a=b%`, `%NAME:~0,1%`).
const WIN_VAR = /^%[^%]*%/

/** The refusal of shell syntax (core's words): `what` is the character or variable, as code. */
export function shellSyntaxMessage(what: string): string {
  return `\`${what}\` needs a shell, and Dim Factory runs verify commands without one: use a package script`
}

export const ONE_LINE = 'A verify command must be one line'
export const NUL_CHARACTER = 'A verify command cannot contain a NUL character'
export const UNCLOSED_QUOTE = 'A quote is not closed'
export const EMPTY_COMMAND = 'The verify command is empty'

const refuse = (message: string): ArgvResult => ({ ok: false, message })

/** Split a command line into argv, or say why it cannot run without a shell. */
export function tokenizeCommand(line: string): ArgvResult {
  if (/[\r\n]/.test(line)) return refuse(ONE_LINE)
  if (line.includes('\0')) return refuse(NUL_CHARACTER)
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
      if (end === -1) return refuse(UNCLOSED_QUOTE)
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
        if (c === '$' || c === '`') return refuse(shellSyntaxMessage(c))
        const v = WIN_VAR.exec(line.slice(i))
        if (v !== null) return refuse(shellSyntaxMessage(v[0]))
        cur += c
        i++
      }
      if (!closed) return refuse(UNCLOSED_QUOTE)
      has = true
      continue
    }
    if (OPERATORS.has(ch)) return refuse(shellSyntaxMessage(ch))
    const v = WIN_VAR.exec(line.slice(i))
    if (v !== null) return refuse(shellSyntaxMessage(v[0]))
    cur += ch
    has = true
    i++
  }
  if (has) argv.push(cur)
  if (argv.length === 0) return refuse(EMPTY_COMMAND)
  return { ok: true, argv }
}

// `%` is always quoted, so two arguments shown together never form a `%…%` pair.
const PLAIN = /^[A-Za-z0-9_\-+=.,/:@^~]+$/

/** One argument as the user would type it back (tokenizeCommand reads the result as the same argument). */
export function quoteArg(arg: string): string {
  if (arg !== '' && PLAIN.test(arg)) return arg
  if (!arg.includes("'")) return `'${arg}'`
  return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** argv as one line (`pnpm run test`), as core shows it. */
export function displayArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}
