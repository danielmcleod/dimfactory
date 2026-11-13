// Verify environment failures (results; the failure table): 127 / 9009, ENOENT / EACCES on spawn, "not
// recognized", "command not found", a missing package or Python module are `env` (never a finding); TypeScript's
// TS2307, a missing relative file and a missing local Python module are the code's failures.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyEnvFailure, envFailureHint, hasFailureMarkers } from '../../../src/core/verify/classify.ts'
import type { EnvClassifyInput } from '../../../src/core/verify/classify.ts'

const CWD = join('/', 'repo')
const c = (o: Partial<EnvClassifyInput>): string | null =>
  classifyEnvFailure({ exitCode: 1, tail: [], cwd: CWD, argv0: 'vitest', exists: () => false, ...o })

describe('classifyEnvFailure', () => {
  it('spawn errors', () => {
    expect(c({ exitCode: null, spawnError: 'ENOENT' })).toMatch(/could not find vitest/)
    expect(c({ exitCode: null, spawnError: 'EACCES' })).toMatch(/not allowed to run/)
    expect(c({ exitCode: null, spawnError: 'ECWD' })).toMatch(/working folder/)
  })

  it('exit 127 and 9009', () => {
    expect(c({ exitCode: 127 })).toMatch(/not found \(exit 127\)/)
    expect(c({ exitCode: 9009 })).toMatch(/not found \(exit 9009\)/)
  })

  it('"not recognized", "command not found" in the last lines (the program is named)', () => {
    expect(
      c({
        tail: [
          '> vitest run',
          "'vitest' is not recognized as an internal or external command,",
          'operable program or batch file.',
          'ELIFECYCLE  Command failed with exit code 1.',
        ],
      }),
    ).toBe('A program it runs was not found: vitest')
    expect(c({ tail: ['sh: 1: vitest: command not found'] })).toBe('A program it runs was not found: vitest')
    expect(c({ tail: ['bash: ruff: command not found'] })).toBe('A program it runs was not found: ruff')
    expect(c({ tail: ['zsh: command not found: mypy'] })).toBe('A program it runs was not found: mypy')
    expect(c({ tail: ['sh: 1: jest: not found'] })).toBe('A program it runs was not found: jest')
    expect(c({ tail: ['/bin/sh: tsc: not found'] })).toBe('A program it runs was not found: tsc')
  })

  it('a shell script names itself and the line: dash, bash (macOS sh) and zsh, by path or *.sh name', () => {
    for (const line of [
      '/tmp/dim-run-x/ts-small/nf.sh: 2: vitest: not found',
      './test.sh: line 2: vitest: command not found',
      '/Users/Jane Doe/My Project/scripts/test: line 7: vitest: command not found',
      'test.sh: 3: vitest: not found',
      '~/repo/check.bash: line 1: vitest: command not found',
      '/home/u/repo/test.sh:2: command not found: vitest',
    ]) {
      expect(c({ exitCode: 127, tail: [line] }), line).toBe('A program it runs was not found: vitest')
    }
    // Without the line number, or without a path or a script name, it is not a shell's line.
    expect(c({ tail: ['/repo/test.sh: vitest: not found'] })).toBeNull()
    expect(c({ tail: ['Error: 42: vitest: not found'] })).toBeNull()
    expect(c({ tail: ['user: 42: vitest: command not found'] })).toBeNull()
  })

  it('a missing package (bare specifier or a path into node_modules) is env', () => {
    expect(c({ tail: ["Error: Cannot find module 'vitest'", 'Require stack:'] })).toMatch(
      /A package is missing: vitest/,
    )
    expect(c({ tail: ["Error: Cannot find module '@scope/pkg/dist/x.js'"] })).toMatch(/@scope\/pkg/)
    expect(c({ tail: ["Error: Cannot find module 'C:\\repo\\node_modules\\vitest\\vitest.mjs'"] })).toMatch(
      /A package is missing/,
    )
  })

  it("the code's own missing files and TypeScript errors are failures, not env", () => {
    expect(
      c({
        tail: [
          "src/a.ts(1,20): error TS2307: Cannot find module './b' or its corresponding type declarations.",
        ],
      }),
    ).toBeNull()
    expect(
      c({ tail: ["error TS2307: Cannot find module 'zod' or its corresponding type declarations."] }),
    ).toBeNull()
    expect(c({ tail: ["Cannot find module '../src/missing' from 'src/a.test.js'"] })).toBeNull()
    expect(c({ tail: ["Error: Cannot find module '/repo/scripts/gen.js'"] })).toBeNull()
    expect(c({ tail: ["Error: Cannot find module '#internal/x'"] })).toBeNull()
  })

  it('a missing Python module is env unless it is part of the project', () => {
    expect(c({ tail: ["E   ModuleNotFoundError: No module named 'requests'"] })).toMatch(
      /A Python module is missing: requests/,
    )
    expect(c({ tail: ['/usr/bin/python3: No module named pytest'] })).toMatch(/missing: pytest/)
    const local = (p: string): boolean => p === join(CWD, 'myapp') || p === join(CWD, 'src', 'other.py')
    expect(c({ tail: ["ModuleNotFoundError: No module named 'myapp.utils'"], exists: local })).toBeNull()
    expect(c({ tail: ["ModuleNotFoundError: No module named 'other'"], exists: local })).toBeNull()
  })

  // Env hides a failure from Fix (and Auto takes Skip verify), so it is decided strictly.
  it('real failures that also mention a missing module or program stay failures, with the env line as a hint', () => {
    const vitest = [
      ' FAIL  src/a.test.ts > adds',
      'AssertionError: expected 3 to be 4',
      ' FAIL  src/b.test.ts > subtracts',
      'AssertionError: expected 1 to be 0',
      "Error: Cannot find module 'left-pad'",
      ' Test Files  2 failed (2)',
      '      Tests  2 failed (2)',
    ]
    expect(c({ tail: vitest })).toBeNull()
    expect(envFailureHint({ exitCode: 1, tail: vitest, cwd: CWD, argv0: 'vitest' })).toBe(
      "A package is missing: left-pad (install the project's dependencies)",
    )
    const printed = [
      'FAIL src/cli.test.ts > prints the shell error',
      "  Received: 'foo' is not recognized as an internal or external command,",
      'Tests: 1 failed',
    ]
    expect(c({ tail: printed })).toBeNull()
    expect(envFailureHint({ exitCode: 1, tail: printed, cwd: CWD, argv0: 'vitest' })).toBeNull()
    for (const marker of [
      '--- FAIL: TestAdd (0.00s)',
      'FAILED tests/test_a.py::test_x - assert 1 == 2',
      '2 failing',
      ' × src/a.test.ts > adds 3ms',
      "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      '✖ 3 problems (3 errors, 0 warnings)',
      'error[E0425]: cannot find value `x` in this scope',
      'test result: FAILED. 1 passed; 1 failed',
    ]) {
      expect(hasFailureMarkers([marker]), marker).toBe(true)
      expect(c({ tail: [marker, 'sh: 1: vitest: not found'] }), marker).toBeNull()
    }
  })

  it('the shell lines must have their exact shape: a line that only contains the phrase is not one', () => {
    expect(
      c({ tail: ["  Received: 'foo' is not recognized as an internal or external command,"] }),
    ).toBeNull()
    expect(c({ tail: ['expected "\'x\' is not recognized as an internal or external command,"'] })).toBeNull()
    expect(c({ tail: ['log: vitest: command not found in cache'] })).toBeNull()
    expect(c({ tail: ['Error: the user command not found: nobody'] })).toBeNull()
    expect(c({ tail: ['bash: line 1: vitest: command not found'] })).toBe(
      'A program it runs was not found: vitest',
    )
    expect(c({ tail: ["'vitest' is not recognized as an internal or external command"] })).toBe(
      'A program it runs was not found: vitest',
    )
    // pnpm's own wrapper lines are no failure markers.
    expect(
      c({
        tail: [
          "'tsc' is not recognized as an internal or external command,",
          'operable program or batch file.',
          'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  Command failed with exit code 1.',
          'npm ERR! Test failed.  See above for more details.',
        ],
      }),
    ).toBe('A program it runs was not found: tsc')
    // exit 127 / 9009 with the code's own failures in the output is a failure too.
    expect(c({ exitCode: 127, tail: ['Tests: 1 failed'] })).toBeNull()
  })

  it('ordinary failures and passes are not env', () => {
    expect(c({ tail: ['FAIL src/a.test.ts', 'Tests: 1 failed, 4 passed'] })).toBeNull()
    expect(c({ tail: ['Error: user 42: not found'] })).toBeNull()
    expect(c({ exitCode: 0, tail: ["'x' is not recognized as an internal or external command,"] })).toBeNull()
    expect(c({ exitCode: null, tail: ['killed'] })).toBeNull()
  })
})
