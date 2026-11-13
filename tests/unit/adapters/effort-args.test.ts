// How a pass's effort level reaches each vendor: Claude `--effort <level>` (a managed flag), Codex exec
// `-c model_reasoning_effort="<level>"` and app-server turn/start `effort` (and plan mode's settings), never for a
// local preset, and never anything but a plain level (`high --x` is not passed). Gemini, Grok and Muse have no
// effort setting (capabilities.effort false); the engine leaves it out of their StartOptions.
import { describe, expect, it } from 'vitest'
import { MANAGED_FLAGS, claudeCapabilities } from '@core/adapters/claude/capabilities.ts'
import { buildArgv, extraArgsProblem, flagMapProblem } from '@core/adapters/claude/launch.ts'
import { codexCapabilities, defaultFacts } from '@core/adapters/codex/capabilities.ts'
import { effortFor, execArgv } from '@core/adapters/codex/launch.ts'
import { planCollaboration, turnStartParams } from '@core/adapters/codex/params.ts'
import { museCapabilities } from '@core/adapters/muse/capabilities.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import type { StartInput } from '@core/supervisor/effects.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import type { LocalPreset } from '@shared/vendors.ts'

const PRESET: LocalPreset = {
  id: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3',
}

describe('Claude', () => {
  const argv = (effort: string | null | undefined): string[] =>
    buildArgv({ route: 'edit', mode: 'autoedit', step: 'implement', model: 'opus', effort })

  it('sends --effort <level> after the model', () => {
    const a = argv('high')
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 4)).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ])
  })

  it('null, absent or anything but a plain level sends no --effort', () => {
    for (const e of [null, undefined, '', 'high --x', 'High', '--dangerously-skip-permissions']) {
      expect(argv(e)).not.toContain('--effort')
      expect(argv(e).join(' ')).not.toContain('--x')
    }
  })

  it('--effort is a managed flag: extraArgs may not set it, flagMap may rename it', () => {
    expect(MANAGED_FLAGS).toContain('--effort')
    expect(extraArgsProblem(['--effort', 'max'])).toMatch(/--effort/)
    expect(extraArgsProblem(['--effort=max'])).toMatch(/--effort/)
    expect(flagMapProblem({ '--effort': '--reasoning-effort' })).toBeUndefined()
  })

  it('a renamed --effort follows the flagMap', () => {
    const a = buildArgv({
      route: 'readonly',
      mode: 'readonly',
      step: 'review',
      effort: 'low',
      flagMap: { '--effort': '--reasoning-effort' },
    })
    expect(a[a.indexOf('--reasoning-effort') + 1]).toBe('low')
    expect(a).not.toContain('--effort')
  })

  it('says it has an effort setting', () => {
    expect(claudeCapabilities('win32').effort).toBe(true)
  })
})

describe('Codex', () => {
  const exec = (o: { effort?: string | null; local?: LocalPreset }): string[] =>
    execArgv({ step: 'implement', mode: 'autoedit', cwd: 'C:\\w', outFile: 'o', model: 'gpt-6-luna', ...o })

  it('exec: -c model_reasoning_effort="<level>"', () => {
    const a = exec({ effort: 'xhigh' })
    expect(a[a.indexOf('model_reasoning_effort="xhigh"') - 1]).toBe('-c')
    // Every flag goes before the prompt marker.
    expect(a.indexOf('model_reasoning_effort="xhigh"')).toBeLessThan(a.lastIndexOf('-'))
  })

  it('exec: none for null, a non-level, or a local preset', () => {
    for (const o of [{ effort: null }, {}, { effort: 'high --x' }, { effort: 'high', local: PRESET }]) {
      expect(exec(o).some((x) => x.startsWith('model_reasoning_effort'))).toBe(false)
    }
  })

  it('app-server: turn/start carries effort; plan mode settings carry it too', () => {
    expect(turnStartParams({ threadId: 't', prompt: 'p', effort: 'high' })).toMatchObject({ effort: 'high' })
    expect(turnStartParams({ threadId: 't', prompt: 'p' })).not.toHaveProperty('effort')
    expect(turnStartParams({ threadId: 't', prompt: 'p', effort: 'high --x' })).not.toHaveProperty('effort')
    expect(planCollaboration('gpt-6-luna', 'low').settings).toEqual({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
      developer_instructions: null,
    })
    expect(planCollaboration('gpt-6-luna').settings.reasoning_effort).toBeNull()
    expect(planCollaboration('gpt-6-luna', 'Low;x').settings.reasoning_effort).toBeNull()
  })

  it('effortFor: a plain level, never for a local preset', () => {
    expect(effortFor({ effort: 'medium' })).toBe('medium')
    expect(effortFor({ effort: 'medium', local: PRESET })).toBeUndefined()
    expect(effortFor({ effort: null })).toBeUndefined()
    expect(effortFor({ effort: 'a b' })).toBeUndefined()
  })

  it('says it has an effort setting', () => {
    expect(codexCapabilities(defaultFacts()).effort).toBe(true)
  })
})

describe('vendors without an effort setting', () => {
  it('Muse says it has none', () => {
    expect(museCapabilities().effort).toBe(false)
  })

  it('the engine sends a pass effort to Claude and Codex only', () => {
    const config = resolveBuiltinConfig({ profile: 'balanced' })
    const input = (vendor: string): StartInput =>
      ({
        runId: 'r',
        cwd: 'C:\\w',
        config,
        state: { allowRules: [] },
        prompt: 'p',
        spawn: {
          t: 'spawn',
          step: 'review',
          attempt: 1,
          spawnNo: 1,
          launch: { planMode: 'emulated' },
          vendor,
          model: null,
          effort: 'high',
          mode: 'readonly',
        },
      }) as unknown as StartInput
    expect(startOptionsFor(input('claude')).effort).toBe('high')
    expect(startOptionsFor(input('codex')).effort).toBe('high')
    expect(startOptionsFor(input('gemini'))).not.toHaveProperty('effort')
    expect(startOptionsFor(input('local-ollama'))).not.toHaveProperty('effort')
  })
})
