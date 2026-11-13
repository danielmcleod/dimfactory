// The Settings command editor splits a line as core does and refuses shell syntax with core's words (verify
// commands and trust: argv only, quote-aware; shell metacharacters are an error, "use a package script"; no
// `sh -c` path). The renderer's port (pages/settings/verify/argv.ts) and core's src/core/verify/argv.ts read one corpus
// alike, injection attempts included, and show argv back the same way.
import { describe, expect, it } from 'vitest'
import {
  displayArgv,
  EMPTY_COMMAND,
  ONE_LINE,
  shellSyntaxMessage,
  tokenizeCommand,
  UNCLOSED_QUOTE,
} from '@renderer/pages/settings/verify/argv.ts'
import { displayArgv as coreDisplay, tokenizeCommandLine } from '../../../src/core/verify/argv.ts'

const CORPUS: readonly string[] = [
  'pnpm run test',
  '  node   scripts/check.mjs  ',
  'node "scripts/my smoke.mjs" --fast',
  'node \'a b\' "c \\"d\\"" \'\'',
  '--name="a b"',
  'C:\\tools\\lint.exe --fix C:\\repo\\',
  '"C:\\Program Files\\nodejs\\node.exe" -v',
  'node -e "a & b | c"',
  "node -e 'a & b | c; $x `y` %PATH%'",
  'pnpm test && rm -rf /',
  'pnpm test & calc',
  'pnpm test | tee out.txt',
  'pnpm test; del /s /q C:\\',
  'pnpm test > out.txt',
  'pnpm test < in.txt',
  '(pnpm test)',
  'node -e $(whoami)',
  'node `whoami`',
  'echo %PATH%',
  'echo "%USERPROFILE%"',
  'echo "$HOME"',
  'echo 50%',
  // The substitution forms cmd.exe expands (any %…% pair is refused).
  'echo %PATH:a=b%',
  'mytool --root=%CD:\\=/%',
  'echo "%VAR:x=y&echo INJECTED>canary.txt&%"',
  'echo 100% 50%off',
  "echo '100%' '50%off'",
  'echo ^& calc',
  'echo !VAR!',
  'pnpm "test',
  "pnpm 'test",
  'pnpm test\nrm -rf /',
  'pnpm test\r\ncalc',
  'pnpm te\0st',
  '',
  '   ',
  '""',
  'a"b c"d',
  'x "\\\\server\\share"',
]

describe('the command line, as core reads it', () => {
  it.each(CORPUS.map((l) => [JSON.stringify(l), l] as const))('%s', (_, line) => {
    const mine = tokenizeCommand(line)
    const core = tokenizeCommandLine(line)
    expect(mine.ok).toBe(core.ok)
    if (mine.ok && core.ok) {
      expect(mine.argv).toEqual(core.argv)
      // Shown back as core shows it, and read again as the same argv.
      expect(displayArgv(mine.argv)).toBe(coreDisplay(core.argv))
      const again = tokenizeCommand(displayArgv(mine.argv))
      expect(again).toEqual({ ok: true, argv: mine.argv })
    } else if (!mine.ok && !core.ok) {
      expect(mine.message).toBe(core.error)
    }
  })

  it('words its refusals plainly, without an em dash', () => {
    expect(tokenizeCommand('pnpm test && rm -rf /')).toEqual({ ok: false, message: shellSyntaxMessage('&') })
    expect(shellSyntaxMessage('&')).toBe(
      '`&` needs a shell, and Dim Factory runs verify commands without one: use a package script',
    )
    expect(tokenizeCommand('echo %PATH%')).toEqual({ ok: false, message: shellSyntaxMessage('%PATH%') })
    expect(tokenizeCommand('mytool --root=%CD:\\=/%')).toEqual({
      ok: false,
      message: shellSyntaxMessage('%CD:\\=/%'),
    })
    expect(tokenizeCommand('echo %PATH:a=b%')).toEqual({
      ok: false,
      message: shellSyntaxMessage('%PATH:a=b%'),
    })
    expect(tokenizeCommand('a\nb')).toEqual({ ok: false, message: ONE_LINE })
    expect(tokenizeCommand('"a')).toEqual({ ok: false, message: UNCLOSED_QUOTE })
    expect(tokenizeCommand(' ')).toEqual({ ok: false, message: EMPTY_COMMAND })
    for (const m of [shellSyntaxMessage('|'), ONE_LINE, UNCLOSED_QUOTE, EMPTY_COMMAND]) {
      expect(m).not.toContain('\u2014')
    }
  })
})
