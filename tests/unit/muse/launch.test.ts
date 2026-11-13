// Muse argv, prompt file and flag rules (`muse exec --json --prompt-file <runs/id/prompts/x.md>
// [--trust-workspace with grant] --disable-approval|--yolo`; prompts never in argv; extraArgs at the end, never a managed
// or a widening flag; flagMap renames a managed flag only).
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  museArgv,
  museEnv,
  museExtraArgsProblem,
  museFlagMapProblem,
  musePromptFile,
  musePromptText,
} from '@core/adapters/muse/launch.ts'
import { vendorArgsCheck } from '@core/adapters/vendor-args.ts'

const FILE = '/home/u/.dimfactory/runs/20261011T120000Z-a1b2/prompts/implement-muse-1.md'

describe('museArgv', () => {
  it('autoedit: --disable-approval with the network off; full: --yolo; never both', () => {
    expect(museArgv({ promptFile: FILE, step: 'implement', mode: 'autoedit', trust: true })).toEqual([
      'exec',
      '--json',
      '--prompt-file',
      FILE,
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      'restricted',
    ])
    expect(museArgv({ promptFile: FILE, step: 'fix', mode: 'full', trust: true })).toEqual([
      'exec',
      '--json',
      '--prompt-file',
      FILE,
      '--trust-workspace',
      '--yolo',
    ])
  })

  it('--trust-workspace only with the grant; --model only for a named model', () => {
    const argv = museArgv({
      promptFile: FILE,
      step: 'implement',
      mode: 'autoedit',
      trust: false,
      model: null,
    })
    expect(argv).not.toContain('--trust-workspace')
    expect(argv).not.toContain('--model')
    expect(
      museArgv({
        promptFile: FILE,
        step: 'implement',
        mode: 'autoedit',
        trust: true,
        model: 'muse-spark-1.2',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--prompt-file',
      FILE,
      '--model',
      'muse-spark-1.2',
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      'restricted',
    ])
  })

  it('refuses a read-only step (Muse has no read-only mode)', () => {
    for (const step of ['plan', 'review', 'critic', 'heal', 'catalog'] as const) {
      expect(() => museArgv({ promptFile: FILE, step, mode: 'autoedit', trust: true })).toThrow(/read-only/)
    }
    expect(() => museArgv({ promptFile: FILE, step: 'implement', mode: 'readonly', trust: true })).toThrow()
  })

  it('extraArgs go at the end; flagMap renames a managed flag (the prompt file value untouched)', () => {
    expect(
      museArgv({
        promptFile: FILE,
        step: 'implement',
        mode: 'autoedit',
        trust: true,
        extraArgs: ['--max-model-steps', '40'],
        flagMap: { '--prompt-file': '--prompt-path' },
      }),
    ).toEqual([
      'exec',
      '--json',
      '--prompt-path',
      FILE,
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      'restricted',
      '--max-model-steps',
      '40',
    ])
  })
})

describe('the prompt file', () => {
  it('is under runs/<id>/prompts, one per process, with the extra context leading the prompt', () => {
    expect(musePromptFile('/h', '20261011T120000Z-a1b2', 'implement', 3)).toBe(
      resolve('/h', 'runs', '20261011T120000Z-a1b2', 'prompts', 'implement-muse-3.md'),
    )
    expect(() => musePromptFile('/h', '../evil', 'implement', 1)).toThrow()
    expect(musePromptText({ prompt: 'Do it.' })).toBe('Do it.\n')
    expect(musePromptText({ prompt: 'Do it.', systemAppend: '  Follow the plan.  ' })).toBe(
      'Follow the plan.\n\nDo it.\n',
    )
    expect(musePromptText({ prompt: 'Do it.\n', systemAppend: '' })).toBe('Do it.\n')
  })
})

describe('extraArgs and flagMap rules', () => {
  it('refuses managed flags, widening flags (also in combined short flags), positionals and newlines', () => {
    expect(museExtraArgsProblem(['--max-model-steps', '30', '--reasoning-effort', 'high'])).toBeUndefined()
    expect(museExtraArgsProblem(['--yolo'])).toMatch(/manages/)
    expect(museExtraArgsProblem(['--prompt-file', 'x'])).toMatch(/manages/)
    expect(museExtraArgsProblem(['--approval-mode', 'on-request'])).toMatch(/widens/)
    expect(museExtraArgsProblem(['--approval-mode=never'])).toMatch(/widens/)
    expect(museExtraArgsProblem(['--disable-sandbox'])).toMatch(/widens/)
    // Dim Factory sets the sandbox's network itself (restricted on autoedit), so extraArgs never may.
    expect(museExtraArgsProblem(['--sandbox-network', 'enabled'])).toMatch(/manages/)
    expect(museExtraArgsProblem(['--sandbox-network=proxy-only'])).toMatch(/manages/)
    expect(museExtraArgsProblem(['--allow-workspace-switch'])).toMatch(/widens/)
    expect(museExtraArgsProblem(['--dangerously-anything'])).toMatch(/widens/)
    expect(museExtraArgsProblem(['do this instead'])).toMatch(/flags only/)
    expect(museExtraArgsProblem(['--x\nrm'])).toMatch(/newline/)
  })

  it('flagMap: only a managed flag, to a long flag Muse does not already use', () => {
    expect(museFlagMapProblem({ '--json': '--jsonl' })).toBeUndefined()
    expect(museFlagMapProblem({ '--max-model-steps': '--steps' })).toMatch(/not a flag Dim Factory manages/)
    expect(museFlagMapProblem({ '--disable-approval': '--yolo' })).toMatch(/manages|widens/)
    expect(museFlagMapProblem({ '--disable-approval': '--disable-sandbox' })).toMatch(/widens/)
    expect(museFlagMapProblem({ '--json': '--output-schema' })).toMatch(/already uses/)
    expect(museFlagMapProblem({ '--json': 'json' })).toMatch(/long flag/)
  })

  it("the recovery guard uses Muse's rules (a fix can never add --approval-mode or --disable-sandbox)", () => {
    expect(vendorArgsCheck('muse', { extraArgs: ['--approval-mode', 'never'], flagMap: {} })).toMatch(
      /widens/,
    )
    expect(vendorArgsCheck('muse', { extraArgs: [], flagMap: { '--yolo': '--disable-sandbox' } })).toMatch(
      /widens/,
    )
    expect(vendorArgsCheck('muse', { extraArgs: ['--max-model-steps', '10'], flagMap: {} })).toBeUndefined()
  })
})

describe('museEnv', () => {
  it('sanitizes the env, takes the resolved PATH and layers vendors.muse.env on top', () => {
    const env = museEnv(
      { NODE_OPTIONS: '--inspect', PATH: '/old', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
      { path: '/new', vendorEnv: { META_API_KEY: 'k' }, platform: 'linux' },
    )
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(env['PATH']).toBe('/new')
    expect(env['KEEP']).toBe('yes')
    expect(env['META_API_KEY']).toBe('k')
    expect(env['NO_COLOR']).toBe('1')
  })
})
