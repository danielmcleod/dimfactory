// Verify environment failures (deps_missing): a command that could not run
// because of the machine, not the code, is status `env` and never a finding (the verifyEnv card offers Retry / Skip
// verify), so Fix never tries to "fix" a missing tool. Signals: exit 127 / 9009, ENOENT / EACCES on spawn, and in the
// output's last lines cmd.exe's "'x' is not recognized as an internal or external command," line, a shell's
// "command not found" / "not found" line, Node's "Cannot find module" for a package (not a relative file, not
// TypeScript's TS2307), and Python's "No module named" / ModuleNotFoundError for a module that is not part of the
// project.
// Env hides a failure from Fix (and Auto then takes Skip verify), so it is decided strictly. The shell
// lines must have their exact shape (a test that prints such text in an assertion is not one), and output that shows
// the code's own failures (FAIL, AssertionError, "N failed", a TypeScript or compiler error) is a failure even when it
// also names a missing module or program: the env line becomes the failure's hint (envFailureHint).
// A missing package or Python module that the run's own added lines import first (`introduced`) is not the machine's
// fault either: the AI wrote an import of something that is not there (an invented package, a typo), so it is the
// code's failure, a finding, never hidden as an environment problem.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface EnvClassifyInput {
  exitCode: number | null
  /** The spawn failed with this errno-style code (ENOENT, EACCES…). */
  spawnError?: string
  /** The output's last lines (cleaned). */
  tail: readonly string[]
  /** The command's working directory (a missing Python module that lives here is the code's problem). */
  cwd: string
  argv0: string
  /** Test seam. */
  exists?: (p: string) => boolean
  /**
   * Whether the run's own added lines import this module (a package name, a Python top-level module): a missing one
   * is then the code's failure, not the environment's. Absent: nothing is known of the run's lines.
   */
  introduced?: (name: string) => boolean
}

/** cmd.exe's own line, whole: `'vitest' is not recognized as an internal or external command,`. */
const NOT_RECOGNIZED = /^'([^']+)' is not recognized as an internal or external command,?$/i
const COMMAND_NOT_FOUND = [
  // zsh: `zsh: command not found: vitest`
  /^(?:[\w/.-]*\/)?zsh:\s*command not found:\s*(\S+)$/i,
  // bash: `bash: vitest: command not found`, `bash: line 1: vitest: command not found`; dash: `sh: 1: vitest: command
  // not found`, `sh: 1: vitest: not found`, `/bin/sh: tsc: not found` (always after the shell's own name)
  /^(?:[\w/.-]*\/)?(?:sh|bash|dash|ash)(?:\.exe)?:\s*(?:line \d+:\s*)?(?:\d+:\s*)?([^\s:]+): (?:command )?not found$/i,
  // A shell script's own line names the script, then always its line number: dash `/repo/test.sh: 2: vitest: not
  // found`, bash (and macOS's sh) `./test.sh: line 2: vitest: command not found`. The script is a path or a *.sh name.
  /^(?:[.~]?\/[^:]*|[\w.-]+\.(?:sh|bash|zsh)):\s*(?:line )?\d+:\s*([^\s:]+): (?:command )?not found$/i,
  // zsh running a script: `/repo/test.sh:2: command not found: vitest`
  /^(?:[.~]?\/[^:]*|[\w.-]+\.(?:sh|bash|zsh)):\d+: command not found: (\S+)$/i,
]
const NODE_MISSING = /Cannot find module ['"]([^'"]+)['"]/
const TS_MISSING = /or its corresponding type declarations|error TS\d+/i
const PY_MISSING = /(?:ModuleNotFoundError: )?No module named ['"]?([A-Za-z_][\w.]*)['"]?/

/**
 * The code's own failures in a test runner's, type checker's, linter's or compiler's output: vitest / jest / go
 * `FAIL`, pytest / cargo `FAILED`, AssertionError, `N failed` / `N failing`, a failed test's cross, `error TS…`,
 * eslint's `N problems (N errors`, rustc's `error[E…]`.
 */
const FAILURE_MARKERS: readonly RegExp[] = [
  /\bFAIL(?:ED)?\b/,
  /\bAssertionError\b/,
  /\b\d+ (?:failed|failing)\b/i,
  /^\s*[×✕✗✖]\s+\S/,
  /\berror TS\d+\b/,
  /\b\d+ problems? \(\d+ errors?\b/,
  /^error\[E\d+\]/,
]

/** The tail shows the code's own failures (FAILURE_MARKERS). */
export function hasFailureMarkers(tail: readonly string[]): boolean {
  return tail.some((l) => FAILURE_MARKERS.some((re) => re.test(l)))
}

/** A Node specifier that names a package or a path into node_modules (not one of the project's own files). */
function isPackageSpecifier(spec: string): boolean {
  if (/[\\/]node_modules[\\/]/.test(spec)) return true
  if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) return false
  return !spec.startsWith('#') // a package.json "imports" alias is the project's own
}

/** The package a Node specifier names (@scope/name/sub -> @scope/name, 
ame/sub -> 
ame, a node_modules path's). */
export function packageNameOf(spec: string): string {
  const nm = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(spec)
  if (nm !== null) return (nm[1] ?? '').replace(/\\/g, '/')
  const parts = spec.split('/')
  return spec.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? spec)
}

function isLocalPythonModule(name: string, cwd: string, exists: (p: string) => boolean): boolean {
  const top = name.split('.')[0] ?? name
  return [join(cwd, top), join(cwd, `${top}.py`), join(cwd, 'src', top), join(cwd, 'src', `${top}.py`)].some(
    (p) => exists(p),
  )
}

/** What the output's last lines say is missing (the last such line), whatever else they show; null: nothing. */
function envLineOf(input: EnvClassifyInput): string | null {
  const exists = input.exists ?? existsSync
  for (let i = input.tail.length - 1; i >= 0; i--) {
    const line = (input.tail[i] ?? '').trim()
    const nr = NOT_RECOGNIZED.exec(line)
    if (nr !== null) return `A program it runs was not found: ${nr[1] ?? ''}`.trim()
    for (const re of COMMAND_NOT_FOUND) {
      const m = re.exec(line)
      if (m !== null) return `A program it runs was not found: ${m[1] ?? ''}`.trim()
    }
    const node = NODE_MISSING.exec(line)
    if (
      node !== null &&
      !TS_MISSING.test(line) &&
      isPackageSpecifier(node[1] ?? '') &&
      input.introduced?.(packageNameOf(node[1] ?? '')) !== true
    ) {
      return `A package is missing: ${node[1] ?? ''} (install the project's dependencies)`
    }
    const py = PY_MISSING.exec(line)
    if (
      py !== null &&
      /No module named/.test(line) &&
      !isLocalPythonModule(py[1] ?? '', input.cwd, exists) &&
      input.introduced?.((py[1] ?? '').split('.')[0] ?? '') !== true
    ) {
      return `A Python module is missing: ${py[1] ?? ''} (install the project's dependencies)`
    }
  }
  if (input.exitCode === 127 || input.exitCode === 9009) {
    return `A program it runs was not found (exit ${input.exitCode})`
  }
  return null
}

/** UI copy for why a command could not run, or null when its failure is the code's (a finding). */
export function classifyEnvFailure(input: EnvClassifyInput): string | null {
  if (input.spawnError === 'ENOENT') return `Dim Factory could not find ${input.argv0}`
  if (input.spawnError === 'EACCES' || input.spawnError === 'EPERM')
    return `${input.argv0} is not allowed to run (not executable)`
  if (input.spawnError === 'ECWD') return 'Its working folder does not exist'
  if (input.spawnError !== undefined) return `It could not start (${input.spawnError})`
  if (input.exitCode === 0 || input.exitCode === null) return null
  // The code's own failures are in the output: a finding, whatever else is missing (envFailureHint names it).
  if (hasFailureMarkers(input.tail)) return null
  return envLineOf(input)
}

/**
 * A failing command's output also says something is missing although it is a failure (hasFailureMarkers): that line,
 * as the failure's hint (UI copy), else null.
 */
export function envFailureHint(input: EnvClassifyInput): string | null {
  if (input.spawnError !== undefined || input.exitCode === 0 || input.exitCode === null) return null
  if (!hasFailureMarkers(input.tail)) return null
  return envLineOf(input)
}
