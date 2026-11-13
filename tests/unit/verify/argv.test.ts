// Verify argv (commands and trust): a configured string is tokenized quote-aware and shell
// metacharacters are an error ("use a package script"); there is no shell path. displayArgv reads back as the argv.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { commandArgv, displayArgv, quoteArg, tokenizeCommandLine } from '../../../src/core/verify/argv.ts'

const ok = (line: string): string[] => {
  const r = tokenizeCommandLine(line)
  if (!r.ok) throw new Error(`expected ok for ${line}: ${r.error}`)
  return r.argv
}
const err = (line: string): string => {
  const r = tokenizeCommandLine(line)
  if (r.ok) throw new Error(`expected an error for ${line}: ${JSON.stringify(r.argv)}`)
  return r.error
}

describe('tokenizeCommandLine', () => {
  it('splits on whitespace and joins quoted parts', () => {
    expect(ok('pnpm run test')).toEqual(['pnpm', 'run', 'test'])
    expect(ok('  pytest   -q\t-k  smoke ')).toEqual(['pytest', '-q', '-k', 'smoke'])
    expect(ok(`node "scripts/run all.js" --grep='a b' x"y z"w`)).toEqual([
      'node',
      'scripts/run all.js',
      '--grep=a b',
      'xy zw',
    ])
    expect(ok(`echo "" ''`)).toEqual(['echo', '', ''])
  })

  it('keeps Windows paths: a backslash is literal outside quotes', () => {
    expect(ok('node scripts\\check.js C:\\temp\\x')).toEqual(['node', 'scripts\\check.js', 'C:\\temp\\x'])
    expect(ok('"C:\\Program Files\\node\\node.exe" -v')).toEqual(['C:\\Program Files\\node\\node.exe', '-v'])
  })

  it('inside "…": \\" and \\\\ are escapes; inside \'…\' nothing is', () => {
    expect(ok('say "a \\"b\\" c\\\\"')).toEqual(['say', 'a "b" c\\'])
    expect(ok(`say 'a \\"b\\"'`)).toEqual(['say', 'a \\"b\\"'])
  })

  it('shell syntax outside quotes is refused with "use a package script"', () => {
    for (const line of [
      'npm test | tee log',
      'tsc && vitest',
      'a; b',
      'a > out.txt',
      'a < in.txt',
      'a & b',
      '(cd x)',
      'echo $HOME',
      'echo `id`',
      'echo %PATH%',
      'npm test 2>&1',
    ]) {
      expect(err(line), line).toMatch(/use a package script/)
    }
  })

  it('$, backticks and %VAR% are refused inside "…" too (a shell expands them there); \'…\' is literal', () => {
    expect(err('echo "$HOME"')).toMatch(/use a package script/)
    expect(err('echo "`id`"')).toMatch(/use a package script/)
    expect(err('echo "%USERPROFILE%"')).toMatch(/use a package script/)
    expect(ok(`echo '$HOME' '%PATH%' '\`id\`' 'a|b&c;d<e>f(g)'`)).toEqual([
      'echo',
      '$HOME',
      '%PATH%',
      '`id`',
      'a|b&c;d<e>f(g)',
    ])
    expect(ok('grep "a|b" "x&y" "(z)"')).toEqual(['grep', 'a|b', 'x&y', '(z)'])
    expect(ok('echo 100%')).toEqual(['echo', '100%'])
    expect(ok('echo 50%off')).toEqual(['echo', '50%off'])
  })

  it('any %…% pair is refused, the substitution forms cmd.exe expands included', () => {
    for (const line of [
      'echo %PATH:a=b%',
      'mytool --root=%CD:\\=/%',
      'echo %PATH:~0,1%',
      'echo "%VAR:x=y&echo INJECTED>canary.txt&%"',
      'echo "%CD:\\=/%"',
      'echo %ProgramFiles(x86)%',
      'echo %=C:%',
      'echo 100% 50%off',
    ]) {
      expect(err(line), line).toMatch(/needs a shell.*use a package script/)
    }
    expect(err('mytool --root=%CD:\\=/%')).toBe(
      '`%CD:\\=/%` needs a shell, and Dim Factory runs verify commands without one: use a package script',
    )
  })

  it('refuses line breaks, NUL, unclosed quotes and an empty line', () => {
    expect(err('npm test\nrm -rf /')).toMatch(/one line/)
    expect(err('npm test\r')).toMatch(/one line/)
    expect(err('a\0b')).toMatch(/NUL/)
    expect(err('echo "abc')).toMatch(/not closed/)
    expect(err("echo 'abc")).toMatch(/not closed/)
    expect(err('   ')).toMatch(/empty/)
  })
})

describe('commandArgv', () => {
  it('takes an argv list as is (no shell reads it), refusing line breaks and an empty program', () => {
    expect(commandArgv(['npm', 'run', 'a|b&c'])).toEqual({ ok: true, argv: ['npm', 'run', 'a|b&c'] })
    expect(commandArgv([])).toMatchObject({ ok: false })
    expect(commandArgv([''])).toMatchObject({ ok: false })
    expect(commandArgv(['a', 'b\nc'])).toMatchObject({ ok: false })
    expect(commandArgv('npm test')).toEqual({ ok: true, argv: ['npm', 'test'] })
  })
})

describe('displayArgv', () => {
  it('quotes only what needs it', () => {
    expect(displayArgv(['pnpm', 'run', 'test'])).toBe('pnpm run test')
    expect(displayArgv(['node', 'a b.js', '', '%PATH%', "it's"])).toBe(`node 'a b.js' '' '%PATH%' "it's"`)
    expect(quoteArg('C:\\x')).toBe("'C:\\x'")
    // `%` is always quoted, so two arguments shown together never read back as a %…% pair.
    expect(displayArgv(['echo', '100%', '50%off'])).toBe("echo '100%' '50%off'")
    expect(tokenizeCommandLine(displayArgv(['echo', '100%', '50%off']))).toEqual({
      ok: true,
      argv: ['echo', '100%', '50%off'],
    })
  })

  it('reads back as the same argv (property)', () => {
    const arg = fc
      .string({ unit: 'binary', maxLength: 12 })
      .filter((s) => !/[\0\r\n]/.test(s) && !(s.includes("'") && /[$`%]/.test(s)))
    fc.assert(
      fc.property(fc.array(arg, { minLength: 1, maxLength: 5 }), (argv) => {
        const r = tokenizeCommandLine(displayArgv(argv))
        expect(r).toEqual({ ok: true, argv })
      }),
      { numRuns: 300 },
    )
  })
})
