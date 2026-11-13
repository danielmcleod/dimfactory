// Effort is a managed setting: Codex extraArgs may not set `model_reasoning_effort` through any `-c` form, at config
// validation (with its file:line:col) and at spawn (the adapter's extraArgs check refuses the launch).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateSemantics } from '@shared/config-schema.ts'
import { codexEffortOverrides } from '@shared/vendors.ts'
import { FORBIDDEN_FLAGS, MANAGED_FLAGS } from '@core/adapters/codex/capabilities.ts'
import { appServerArgv, extraArgsProblem } from '@core/adapters/codex/launch.ts'
import { loadConfigFile } from '@core/config/load.ts'

const FORMS: string[][] = [
  ['-c', 'model_reasoning_effort=high'],
  ['--config', 'model_reasoning_effort=high'],
  ['--config=model_reasoning_effort=high'],
  ['-c', 'model_reasoning_effort="xhigh"'],
  ['-c', 'Model_Reasoning_Effort=low'],
  ['-c', 'plan_mode_reasoning_effort=high'],
]

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Codex effort in extraArgs', () => {
  it('the spawn check refuses every -c / --config form and names the effort setting', () => {
    for (const args of FORMS) {
      const problem = extraArgsProblem(args)
      expect(problem, args.join(' ')).toMatch(
        /^extraArgs may not set \S+; effort is managed by Dim Factory\./,
      )
      expect(problem).toContain('Effort')
      expect(problem).toContain('default effort')
    }
    // After other harmless overrides too.
    expect(
      extraArgsProblem(['-c', 'model_verbosity=low', '--config', 'model_reasoning_effort=high']),
    ).toMatch(/model_reasoning_effort; effort is managed/)
  })

  it('leaves other -c keys alone (including ones that merely contain the word)', () => {
    expect(extraArgsProblem(['-c', 'model_verbosity=low'])).toBeUndefined()
    expect(extraArgsProblem(['-c', 'model_reasoning_summary=auto'])).toBeUndefined()
    expect(extraArgsProblem(['--config=hide_agent_reasoning=true'])).toBeUndefined()
    // The argv still carries them when allowed.
    expect(appServerArgv({ extraArgs: ['-c', 'model_verbosity=low'] })).toEqual([
      '-c',
      'model_verbosity=low',
      'app-server',
      '--listen',
      'stdio://',
    ])
  })

  it('config validation refuses it at the entry that names the key, for each form', () => {
    for (const args of FORMS) {
      const issues = validateSemantics(
        { vendors: { codex: { extraArgs: args } } },
        { scope: 'user', managedFlags: { codex: MANAGED_FLAGS }, forbiddenFlags: { codex: FORBIDDEN_FLAGS } },
      )
      const at = args.length === 2 ? 1 : 0
      expect(
        issues.map((i) => [i.pointer, i.code, i.severity]),
        args.join(' '),
      ).toEqual([[`/vendors/codex/extraArgs/${at}`, 'managed-flag', 'error']])
      expect(issues[0]!.message).toMatch(/effort is managed by Dim Factory/)
    }
    // Without the adapters' flag lists (a CLI check, an unbuilt adapter), the effort rule still holds.
    expect(
      validateSemantics(
        { vendors: { codex: { extraArgs: ['-c', 'model_reasoning_effort=high'] } } },
        { scope: 'user' },
      ).map((i) => i.code),
    ).toEqual(['managed-flag'])
    // Other vendors' extraArgs are not read as Codex overrides.
    expect(
      validateSemantics(
        { vendors: { claude: { extraArgs: ['-c', 'model_reasoning_effort=high'] } } },
        { scope: 'user' },
      ),
    ).toEqual([])
    expect(
      validateSemantics(
        { vendors: { codex: { extraArgs: ['-c', 'model_verbosity=low'] } } },
        { scope: 'user' },
      ),
    ).toEqual([])
  })

  it('codexEffortOverrides finds every pair and skips values that only look like one', () => {
    expect(
      codexEffortOverrides([
        '-c',
        'model_verbosity=low',
        '--config',
        'model_reasoning_effort=high',
        '--config=model_reasoning_effort=low',
      ]),
    ).toEqual([
      { index: 3, key: 'model_reasoning_effort' },
      { index: 4, key: 'model_reasoning_effort' },
    ])
    expect(codexEffortOverrides(['model_reasoning_effort=high'])).toEqual([])
    expect(codexEffortOverrides(['-c'])).toEqual([])
  })

  it('a loaded user file reports it at its line and column and is not used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-effort-'))
    dirs.push(dir)
    const file = join(dir, 'dimfactory.json')
    writeFileSync(
      file,
      '{\n  "vendors": {\n    "codex": { "extraArgs": ["-c", "model_reasoning_effort=high"] }\n  }\n}\n',
    )
    const r = await loadConfigFile(file, {
      scope: 'user',
      managedFlags: { codex: MANAGED_FLAGS },
      forbiddenFlags: { codex: FORBIDDEN_FLAGS },
    })
    expect(r.value).toBeUndefined()
    expect(r.issues.map((i) => [i.pointer, i.line, i.code, i.severity])).toEqual([
      ['/vendors/codex/extraArgs/1', 3, 'managed-flag', 'error'],
    ])
    expect(r.issues[0]!.message).toContain('effort is managed by Dim Factory')
  })
})
