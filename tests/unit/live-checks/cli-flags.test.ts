// CLI_FLAGS against what the recorded CLI says it accepts (the live re-record;
// CLI_FLAGS is static, updated with testedUpTo): every option of `claude --help` at testedUpTo
// (tests/fixtures/claude/meta/help.txt, 2.1.289) is a flag the CLI already defines, so a flagMap rename can never
// point a managed flag at one of them (`--disallowedTools` → `--brief` would turn the read-only tool cut into a switch).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLI_FLAGS, TESTED_UP_TO } from '../../../src/core/adapters/claude/capabilities.ts'
import { flagMapProblem } from '../../../src/core/adapters/claude/launch.ts'

const HELP = readFileSync(
  fileURLToPath(new URL('../../fixtures/claude/meta/help.txt', import.meta.url)),
  'utf8',
)

/** The flags the Options section defines (the option column only, never a flag a description mentions). */
function helpFlags(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'Options:')
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l))
  const flags: string[] = []
  for (const line of lines.slice(start + 1, end)) {
    const m = /^ {2}(-[\w-]+(?:, -[\w-]+)*)/.exec(line)
    if (m?.[1] !== undefined) flags.push(...m[1].split(', '))
  }
  return flags
}

describe('CLI_FLAGS and the CLI at testedUpTo', () => {
  it('the help capture is of testedUpTo and lists the stream flags every pass relies on', () => {
    expect(HELP).toContain(`claude.exe ${TESTED_UP_TO}`)
    const flags = helpFlags(HELP)
    expect(flags.length).toBeGreaterThan(70)
    for (const f of ['-p', '--print', '--input-format', '--output-format', '--permission-mode', '--tools'])
      expect(flags).toContain(f)
  })

  it('holds every option `claude --help` lists', () => {
    const known = new Set<string>(CLI_FLAGS)
    expect(helpFlags(HELP).filter((f) => !known.has(f))).toEqual([])
  })

  it('a flagMap may not rename a managed flag to one of the newer options', () => {
    for (const to of ['--brief', '--name', '--tmux', '--include-hook-events', '--prompt-suggestions'])
      expect(flagMapProblem({ '--disallowedTools': to }), to).toMatch(/already uses/)
  })
})
