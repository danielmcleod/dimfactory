// A run's own Tools (the composer's Tools picker and Use skill, run overrides `tools`): the run layer resolves them (a
// file may not set them); each pass gets them on top of the settings' Allowed list by one rule (passExtensionsPlan):
// picks add only to passes that change files and never to a read-only pass, removals apply everywhere, levels never
// change and Run without asking is never added; the passes that change files get a short prompt note naming the picks
// and the rule never to send secrets through them; nothing is enabled when nothing was picked.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import { DimFactoryConfigZ, ResolvedConfigZ, RunOverridesZ } from '@shared/config-schema.ts'
import type { AllowedExtensions } from '@shared/extensions.ts'
import {
  NO_RUN_TOOLS,
  hasRunTools,
  passExtensionsPlan,
  resolvedRunTools,
  runToolsNote,
} from '@shared/extensions.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { CLOSING_NOTE, buildPrompt, startOptionsFor, toolsNoteFor } from '@core/supervisor/effects.ts'
import { Flow } from '../supervisor/helpers.review.ts'
import type { EffectOf, RunState } from '@core/supervisor/types.ts'

const allowed = (
  mcp: string[] = [],
  skills: string[] = [],
  mcpWithoutAsking: string[] = [],
): AllowedExtensions => ({
  mcp,
  skills,
  mcpWithoutAsking,
})

const tools = {
  on: { claude: { mcp: ['linear'], skills: ['pdf'] } },
  off: { claude: { mcp: ['slack'] } },
  skill: { vendor: 'claude', name: 'brand-voice' },
}

describe('passExtensionsPlan', () => {
  it('no picks: exactly the settings (the levels and lists as before)', () => {
    for (const level of ['none', 'allowed', 'passthrough'] as const) {
      const p = passExtensionsPlan({
        pass: 'implement',
        vendor: 'claude',
        level,
        allowed: allowed(['a'], ['s'], ['a']),
      })
      expect(p.level).toBe(level)
      expect(p.picked).toEqual({ mcp: [], skills: [] })
      expect(p.skill).toBeUndefined()
      if (level === 'allowed') expect([p.mcp, p.skills, p.mcpWithoutAsking]).toEqual([['a'], ['s'], ['a']])
      else expect([p.mcp, p.skills, p.mcpWithoutAsking]).toEqual([[], [], []])
    }
  })

  it('a pass that changes files at Allowed list: picks added, removals taken off, Use skill allowed', () => {
    const p = passExtensionsPlan({
      pass: 'implement',
      vendor: 'claude',
      level: 'allowed',
      allowed: allowed(['github', 'slack'], [], ['slack']),
      tools,
    })
    expect(p.level).toBe('allowed')
    expect(p.mcp).toEqual(['github', 'linear'])
    expect(p.skills).toEqual(['pdf', 'brand-voice'])
    // Run without asking is the settings' opt-in only: slack was taken off, linear never gets it.
    expect(p.mcpWithoutAsking).toEqual([])
    expect(p.picked).toEqual({ mcp: ['linear'], skills: ['pdf', 'brand-voice'] })
    expect(p.skill).toBe('brand-voice')
  })

  it('a read-only pass gets no addition (it stays read-only), only the removals', () => {
    for (const pass of ['plan', 'review', 'critic', 'security'] as const) {
      const p = passExtensionsPlan({
        pass,
        vendor: 'claude',
        level: 'allowed',
        allowed: allowed(['github', 'slack'], ['notes'], ['github']),
        tools,
      })
      expect(p.mcp).toEqual(['github'])
      expect(p.skills).toEqual(['notes'])
      expect(p.mcpWithoutAsking).toEqual(['github'])
      expect(p.picked).toEqual({ mcp: [], skills: [] })
      expect(p.skill).toBeUndefined()
    }
  })

  it('never changes a level: None stays None, Pass through keeps everything (the picks load there anyway)', () => {
    const none = passExtensionsPlan({
      pass: 'implement',
      vendor: 'claude',
      level: 'none',
      allowed: allowed(),
      tools,
    })
    expect(none).toEqual({
      level: 'none',
      mcp: [],
      skills: [],
      mcpWithoutAsking: [],
      picked: { mcp: [], skills: [] },
    })
    const all = passExtensionsPlan({
      pass: 'fix',
      vendor: 'claude',
      level: 'passthrough',
      allowed: allowed(),
      tools,
    })
    expect(all.level).toBe('passthrough')
    expect([all.mcp, all.skills]).toEqual([[], []])
    expect(all.picked).toEqual({ mcp: ['linear'], skills: ['pdf', 'brand-voice'] })
    expect(all.skill).toBe('brand-voice')
    // A read-only pass at Pass through is not told about the run's picks either.
    const plan = passExtensionsPlan({
      pass: 'plan',
      vendor: 'claude',
      level: 'passthrough',
      allowed: allowed(),
      tools,
    })
    expect(plan.picked).toEqual({ mcp: [], skills: [] })
  })

  it("picks are per vendor (a local preset is Codex's); another vendor's pass is untouched", () => {
    const codex = passExtensionsPlan({
      pass: 'implement',
      vendor: 'codex',
      level: 'allowed',
      allowed: allowed(['codex_apps']),
      tools,
    })
    expect(codex.mcp).toEqual(['codex_apps'])
    expect(codex.picked).toEqual({ mcp: [], skills: [] })
    const local = passExtensionsPlan({
      pass: 'implement',
      vendor: 'local-ollama',
      level: 'allowed',
      allowed: allowed(),
      tools: { on: { codex: { mcp: ['linear'] } } },
    })
    expect(local.mcp).toEqual(['linear'])
  })

  it('a removal wins over a pick of the same name', () => {
    const p = passExtensionsPlan({
      pass: 'implement',
      vendor: 'claude',
      level: 'allowed',
      allowed: allowed(),
      tools: { on: { claude: { mcp: ['linear'] } }, off: { claude: { mcp: ['linear'] } } },
    })
    expect(p.mcp).toEqual([])
    expect(p.picked.mcp).toEqual([])
  })
})

describe('runToolsNote', () => {
  it('names the picks and the never-send-secrets rule; the Use skill has its own line', () => {
    const note = runToolsNote({
      picked: { mcp: ['linear'], skills: ['pdf', 'brand-voice'] },
      skill: 'brand-voice',
    })
    expect(note).toContain('linear (MCP server), pdf (skill)')
    expect(note).not.toContain('brand-voice (skill)')
    expect(note).toContain('never send secrets or credentials through them')
    expect(note).toContain('use the brand-voice skill for this task')
    const only = runToolsNote({ picked: { mcp: [], skills: ['brand-voice'] }, skill: 'brand-voice' })
    expect(only).toContain('use the brand-voice skill')
    expect(only).toContain('Never send secrets or credentials')
    expect(runToolsNote({ picked: { mcp: [], skills: [] } })).toBe('')
    expect(note).not.toContain('—')
  })
})

describe('the run layer', () => {
  it('resolves a run layer’s tools (vendors by their extensions vendor, lists complete); none is the default', () => {
    expect(resolveBuiltinConfig({ profile: 'claude-only' }).tools).toEqual(NO_RUN_TOOLS)
    const cfg = resolveBuiltinConfig({ profile: 'claude-only', overrides: { tools } })
    expect(cfg.tools).toEqual({
      on: { claude: { mcp: ['linear'], skills: ['pdf'] } },
      off: { claude: { mcp: ['slack'], skills: [] } },
      skill: { vendor: 'claude', name: 'brand-voice' },
    })
    expect(resolvedRunTools({ on: { 'local-x': { mcp: ['a'] } } }).on).toEqual({
      codex: { mcp: ['a'], skills: [] },
    })
    expect(hasRunTools(undefined)).toBe(false)
    expect(hasRunTools({ on: { claude: { mcp: [] } } })).toBe(false)
    expect(hasRunTools({ skill: { vendor: 'codex', name: 'x' } })).toBe(true)
  })

  it('only the run layer may hold them: a config file may not, and bad names are refused', () => {
    expect(RunOverridesZ.safeParse({ tools }).success).toBe(true)
    expect(DimFactoryConfigZ.safeParse({ tools }).success).toBe(false)
    expect(RunOverridesZ.safeParse({ tools: { on: { claude: { mcp: ['bad name'] } } } }).success).toBe(false)
    expect(RunOverridesZ.safeParse({ tools: { skill: { vendor: 'claude', name: '../x' } } }).success).toBe(
      false,
    )
  })

  it('a resolved.json written before Tools existed reads as none', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' }) as Partial<ResolvedConfig>
    delete cfg.tools
    expect(ResolvedConfigZ.parse(cfg).tools).toEqual(NO_RUN_TOOLS)
  })
})

describe('the engine', () => {
  const spawn = (step: 'review' | 'implement' | 'fix', vendor = 'claude'): EffectOf<'spawn'> =>
    ({
      t: 'spawn',
      step,
      spawnNo: 1,
      vendor,
      model: null,
      mode: step === 'review' ? 'readonly' : 'autoedit',
      launch: { planMode: 'emulated' },
    }) as unknown as EffectOf<'spawn'>
  const state = { allowRules: [] } as unknown as RunState
  const config = (): ResolvedConfig => ({
    ...resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: {
        passes: { implement: { extensions: 'allowed' }, review: { extensions: 'allowed' } },
        tools,
      },
    }),
    extensions: { allowed: { claude: allowed(['github'], [], []) } },
  })

  it('startOptionsFor: Implement gets the picks, Review only the removals', () => {
    const cfg = config()
    const i = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config: cfg,
      state,
      spawn: spawn('implement'),
      prompt: 'p',
    })
    expect(i.extensions).toEqual({
      level: 'allowed',
      mcp: ['github', 'linear'],
      skills: ['pdf', 'brand-voice'],
    })
    const r = startOptionsFor({
      runId: 'r',
      cwd: '/w',
      config: cfg,
      state,
      spawn: spawn('review'),
      prompt: 'p',
    })
    expect(r.extensions).toEqual({ level: 'allowed', mcp: ['github'], skills: [] })
  })

  it('the prompt note goes to Implement, Fix and the Tests step only, and only with picks', () => {
    const cfg = config()
    expect(toolsNoteFor(state, cfg, 'implement')).toContain('linear (MCP server)')
    expect(toolsNoteFor(state, cfg, 'fix')).toContain('never send secrets')
    expect(toolsNoteFor(state, cfg, 'tests')).toContain('brand-voice')
    for (const step of ['plan', 'review', 'critic', 'security', 'deploy'] as const)
      expect(toolsNoteFor(state, cfg, step)).toBe('')
    const plain = resolveBuiltinConfig({ profile: 'claude-only' })
    expect(toolsNoteFor(state, plain, 'implement')).toBe('')
  })

  it("buildPrompt gives Implement's prompt the note, before the closing note; Review's has none", () => {
    const f = new Flow()
    const cfg = config()
    const impl = buildPrompt(f.state, cfg, { step: 'implement', launch: { fresh: {} } } as never).text
    expect(impl.trimEnd().endsWith(`use the brand-voice skill for this task.\n\n${CLOSING_NOTE}`)).toBe(true)
    expect(impl).toContain('turned on these of their own tools: linear (MCP server), pdf (skill)')
    const review = buildPrompt(f.state, cfg, { step: 'review', launch: { fresh: {} } } as never, {
      diff: 'D',
    }).text
    expect(review).not.toContain('of their own tools')
    const plain = buildPrompt(f.state, resolveBuiltinConfig({ profile: 'claude-only' }), {
      step: 'implement',
      launch: { fresh: {} },
    } as never).text
    expect(plain).not.toContain('of their own tools')
  })
})
