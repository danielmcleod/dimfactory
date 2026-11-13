// Hardening follow-up (the config load check):
// the config load check refuses a flag that widens what a pass may do in `vendors.<id>.extraArgs`
// (alone, in any spelling of a long flag, `--dangerously-*`, or as one letter of a combined short flag such as `-dy`),
// with its `file:line:col`, as the adapters' spawn checks, support() and the recovery guard already do.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateSemantics } from '@shared/config-schema.ts'
import { acpExtraArgsProblem } from '@core/adapters/acp-base/launch.ts'
import { ESCALATION_FLAGS, MANAGED_FLAGS as CLAUDE_MANAGED } from '@core/adapters/claude/capabilities.ts'
import { extraArgsProblem as claudeExtraArgsProblem } from '@core/adapters/claude/launch.ts'
import { FORBIDDEN_FLAGS as CODEX_FORBIDDEN } from '@core/adapters/codex/capabilities.ts'
import {
  FORBIDDEN_FLAGS as GEMINI_FORBIDDEN,
  MANAGED_FLAGS as GEMINI_MANAGED,
  geminiConfig,
} from '@core/adapters/gemini/config.ts'
import { FORBIDDEN_FLAGS as GROK_FORBIDDEN } from '@core/adapters/grok/config.ts'
import { loadConfigFile } from '@core/config/load.ts'

const forbiddenFlags = {
  claude: ESCALATION_FLAGS,
  codex: CODEX_FORBIDDEN,
  gemini: GEMINI_FORBIDDEN,
  grok: GROK_FORBIDDEN,
}
const managedFlags = { claude: CLAUDE_MANAGED, gemini: GEMINI_MANAGED }

const issuesFor = (vendor: string, extraArgs: string[]) =>
  validateSemantics({ vendors: { [vendor]: { extraArgs } } }, { scope: 'user', managedFlags, forbiddenFlags })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('forbidden flags at load', () => {
  it('refuses a forbidden letter inside a combined short flag, as the spawn check does', () => {
    for (const arg of ['-dy', '-yd', '-dw']) {
      // The adapter's own spawn check refuses it already: the load check now agrees.
      expect(acpExtraArgsProblem(geminiConfig, [arg])).toBeDefined()
      const letter = arg.includes('y') ? '-y' : '-w'
      expect(issuesFor('gemini', [arg])).toEqual([
        {
          pointer: '/vendors/gemini/extraArgs/0',
          code: 'forbidden-flag',
          message: `${arg} combines ${letter} with other short flags; ${letter} widens what a pass may do`,
          severity: 'error',
        },
      ])
    }
  })

  it('refuses a forbidden flag alone, a long one in any spelling, and --dangerously-*', () => {
    expect(issuesFor('gemini', ['-y']).map((i) => [i.pointer, i.code, i.message])).toEqual([
      [
        '/vendors/gemini/extraArgs/0',
        'forbidden-flag',
        '-y widens what a pass may do; extraArgs may not set it',
      ],
    ])
    expect(issuesFor('gemini', ['--debug', '--YOLO']).map((i) => [i.pointer, i.message])).toEqual([
      ['/vendors/gemini/extraArgs/1', '--YOLO widens what a pass may do; extraArgs may not set it'],
    ])
    expect(issuesFor('gemini', ['--approval_mode=yolo']).map((i) => i.message)).toEqual([
      '--approval_mode widens what a pass may do; extraArgs may not set it',
    ])
    expect(issuesFor('claude', ['--add-dir', 'C:\\other']).map((i) => [i.pointer, i.code])).toEqual([
      ['/vendors/claude/extraArgs/0', 'forbidden-flag'],
    ])
    expect(claudeExtraArgsProblem(['--add-dir', 'C:\\other'])).toBeDefined()
    expect(issuesFor('grok', ['--dangerously-anything']).map((i) => i.code)).toEqual(['forbidden-flag'])
    expect(issuesFor('codex', ['--profile', 'x']).map((i) => i.code)).toEqual(['forbidden-flag'])
  })

  it('leaves harmless flags, values and other vendors alone; a managed letter still reads as managed', () => {
    expect(issuesFor('gemini', ['-d', '--debug', '--sandbox'])).toEqual([])
    // A letter of a cluster that is neither managed nor forbidden.
    expect(issuesFor('gemini', ['-ds'])).toEqual([])
    // A value is not a flag.
    expect(issuesFor('claude', ['--max-turns', '40'])).toEqual([])
    // No list for a vendor: nothing to check there (a registry stub, an unknown vendor).
    expect(issuesFor('opencode', ['-y', '--yolo'])).toEqual([])
    // Managed first (it names the rename the user may want instead).
    expect(issuesFor('gemini', ['-my']).map((i) => i.code)).toEqual(['managed-flag'])
  })

  it('the loaded file reports it at its line and column, and the file is not used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forbidden-'))
    dirs.push(dir)
    const file = join(dir, 'dimfactory.json')
    writeFileSync(file, '{\n  "vendors": {\n    "gemini": { "extraArgs": ["--debug", "-dy"] }\n  }\n}\n')
    const r = await loadConfigFile(file, { scope: 'user', managedFlags, forbiddenFlags })
    expect(r.value).toBeUndefined()
    expect(r.issues.map((i) => [i.pointer, i.line, i.col, i.code, i.severity, i.message])).toEqual([
      [
        '/vendors/gemini/extraArgs/1',
        3,
        42,
        'forbidden-flag',
        'error',
        '-dy combines -y with other short flags; -y widens what a pass may do',
      ],
    ])
    // Without the vendors' forbidden flags (the old check), the same file loaded.
    const old = await loadConfigFile(file, { scope: 'user', managedFlags })
    expect(old.issues).toEqual([])
  })
})
