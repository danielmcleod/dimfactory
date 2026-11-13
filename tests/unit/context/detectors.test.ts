// The inefficiency detectors `D1` to `D10` (core/context/detectors.ts), one table each: below the threshold nothing, past
// it an item, past the strong threshold a strong one; plus their order and the thresholds' overrides.
import { describe, expect, it } from 'vitest'
import type { ContextBreakdown, ContextContributor } from '@shared/context.ts'
import type { Usage } from '@shared/events.ts'
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  d10Subagents,
  d1Overhead,
  d2Mcp,
  d3BigFiles,
  d4Loops,
  d5BigOutput,
  d6NoProgress,
  d7Compactions,
  d8Burn,
  d9Cache,
  detectAll,
} from '@core/context/detectors.ts'
import type { PassContext } from '@core/context/detectors.ts'
import { newContextState } from '@core/context/state.ts'
import type { ContextFacts, ContextState } from '@core/context/state.ts'

const T = DEFAULT_CONTEXT_THRESHOLDS

const facts = (o: Partial<ContextFacts> = {}): ContextFacts => ({
  promptTokens: 1_000,
  resumed: false,
  extensions: 'passthrough',
  projectFiles: [],
  mcpNames: [],
  skillNames: [],
  ...o,
})

function pass(o: {
  step?: PassContext['step']
  cs?: Partial<ContextState>
  facts?: Partial<ContextFacts>
  window?: number
  usage?: Usage
  p80?: number
  mutating?: boolean
}): PassContext {
  const cs = { ...newContextState(facts(o.facts)), ...o.cs }
  return {
    step: o.step ?? 'implement',
    mutating: o.mutating ?? true,
    cs,
    ...(o.window !== undefined ? { window: o.window } : {}),
    ...(o.usage !== undefined ? { usage: o.usage } : {}),
    ...(o.p80 !== undefined ? { p80Tokens: o.p80 } : {}),
  }
}

const mcp = (name: string, tokens: number, tools: number): ContextContributor => ({
  kind: 'mcp',
  name,
  tokens,
  tools,
  from: 'vendor',
})
const breakdown = (o: Partial<ContextBreakdown>): ContextBreakdown => ({
  skills: [],
  mcp: [],
  memory: [],
  agents: [],
  ...o,
})

describe('D1 big overhead before the task', () => {
  it.each([
    [29_000, 1_000_000, 0],
    [31_000, 1_000_000, 1],
    [20_000, 128_000, 1], // 16% of the window
    [61_000, 1_000_000, 1],
  ])('baseline %i of a %i window: %i item', (baseline, window, n) => {
    expect(d1Overhead(pass({ cs: { baseline }, window }), [], T)).toHaveLength(n)
  })

  it('compares with a read-only pass at Extensions None and suggests lowering Extensions', () => {
    const impl = pass({ cs: { baseline: 42_000 } })
    const review = pass({ step: 'review', cs: { baseline: 14_000 }, facts: { extensions: 'none' } })
    expect(d1Overhead(impl, [impl, review], T)).toEqual([
      {
        id: 'D1',
        step: 'implement',
        strong: false,
        suggestion: 'lower-extensions',
        tokens: 42_000,
        compare: { step: 'review', tokens: 14_000 },
      },
    ])
    expect(d1Overhead(pass({ cs: { baseline: 70_000 } }), [], T)[0]?.strong).toBe(true)
  })

  it('at Extensions None it suggests trimming the memory files instead; a resumed session has no baseline', () => {
    expect(
      d1Overhead(pass({ cs: { baseline: 40_000 }, facts: { extensions: 'none' } }), [], T)[0],
    ).toMatchObject({ suggestion: 'trim-memory' })
    const resumed = pass({
      facts: { resumed: true },
      cs: { breakdown: { start: breakdown({ total: 90_000 }) } },
    })
    expect(d1Overhead(resumed, [], T)).toEqual([])
  })

  it("falls back to Claude's start breakdown less Dim Factory's prompt", () => {
    const p = pass({ cs: { breakdown: { start: breakdown({ total: 41_000 }) } } })
    expect(d1Overhead(p, [], T)[0]).toMatchObject({ tokens: 40_000 })
  })
})

describe('D2 too many MCP tools', () => {
  it.each([
    [[mcp('github', 9_000, 31)], 0, false],
    [[mcp('github', 11_000, 31)], 1, false],
    [[mcp('github', 4_000, 30), mcp('linear', 3_000, 12)], 1, false],
    [[mcp('github', 25_000, 90)], 1, true],
  ])('%j: %i item (strong %s)', (servers, n, strong) => {
    const items = d2Mcp(pass({ cs: { breakdown: { end: breakdown({ mcp: servers }) } } }), [], T)
    expect(items).toHaveLength(n)
    if (n > 0)
      expect(items[0]).toMatchObject({ name: servers[0]!.name, strong, suggestion: 'lower-extensions' })
  })
})

describe('D3 huge skills and memory files', () => {
  it('the vendor sizes and the project files Dim Factory sized, biggest first, strong past 20k', () => {
    const p = pass({
      facts: {
        projectFiles: [
          { kind: 'memory', name: 'CLAUDE.md', tokens: 40_000, from: 'estimate' },
          { kind: 'memory', name: 'AGENTS.md', tokens: 7_000, from: 'estimate' },
        ],
      },
      cs: {
        breakdown: {
          end: breakdown({ skills: [{ kind: 'skill', name: 'big-skill', tokens: 9_000, from: 'vendor' }] }),
        },
      },
    })
    expect(d3BigFiles(p, [], T)).toEqual([
      {
        id: 'D3',
        step: 'implement',
        strong: true,
        suggestion: 'trim-memory',
        name: 'CLAUDE.md',
        tokens: 40_000,
        fileKind: 'memory',
      },
      {
        id: 'D3',
        step: 'implement',
        strong: false,
        suggestion: 'lower-extensions',
        name: 'big-skill',
        tokens: 9_000,
        fileKind: 'skill',
      },
    ])
  })

  it("the vendor's own size of a memory file wins over Dim Factory's estimate", () => {
    const p = pass({
      facts: { projectFiles: [{ kind: 'memory', name: 'CLAUDE.md', tokens: 40_000, from: 'estimate' }] },
      cs: {
        breakdown: {
          end: breakdown({ memory: [{ kind: 'memory', name: 'CLAUDE.md', tokens: 5_000, from: 'vendor' }] }),
        },
      },
    })
    expect(d3BigFiles(p, [], T)).toEqual([])
  })
})

describe('D4 loops and rereads', () => {
  const tools = (o: Partial<ContextState['tools']>): Partial<ContextState> => ({
    tools: { ...newContextState().tools, ...o },
  })
  it.each([
    [{}, []],
    [{ looping: { f: { name: 'Bash', summary: '$ npm test' } }, fpCounts: { f: 3 } }, [['loop', 3, false]]],
    [{ looping: { f: { name: 'Bash', summary: '$ npm test' } }, fpCounts: { f: 9 } }, [['loop', 9, true]]],
    [{ reread: { target: 'src/a.ts', count: 3 } }, []],
    [{ reread: { target: 'src/a.ts', count: 4 } }, [['reread', 4, false]]],
    [{ reread: { target: 'src/a.ts', count: 8 } }, [['reread', 8, true]]],
  ])('%j', (track, expected) => {
    const items = d4Loops(pass({ cs: tools(track) }), [], T)
    expect(items.map((i) => [i.variant, i.count, i.strong])).toEqual(expected)
  })
})

describe('D5 huge tool output', () => {
  it.each([
    [25_000, 0, false],
    [25_001, 1, false],
    [60_000, 1, true],
  ])('%i tokens: %i item (strong %s)', (tokens, n, strong) => {
    const cs = newContextState()
    cs.tools.biggest = { name: 'Grep', summary: 'q', tokens }
    const items = d5BigOutput(pass({ cs }), [], T)
    expect(items).toHaveLength(n)
    if (n > 0) expect(items[0]).toMatchObject({ name: 'Grep', tokens, strong, suggestion: 'narrow-output' })
  })
})

describe('D6 no progress', () => {
  it.each([
    [39, true, 0],
    [40, true, 1],
    [80, false, 0],
  ])('%i calls without a change, mutating %s: %i item', (n, mutating, items) => {
    const cs = newContextState()
    cs.tools.maxSinceEdit = n
    expect(d6NoProgress(pass({ cs, mutating }), [], T)).toHaveLength(items)
  })
  it('strong from 80', () => {
    const cs = newContextState()
    cs.tools.maxSinceEdit = 80
    expect(d6NoProgress(pass({ cs }), [], T)[0]).toMatchObject({ strong: true, count: 80 })
  })
})

describe('D7 repeated compactions', () => {
  it.each([
    [1, 0, false],
    [2, 1, false],
    [3, 1, true],
  ])('%i compactions: %i item (strong %s)', (compactions, n, strong) => {
    const items = d7Compactions(pass({ cs: { compactions } }), [], T)
    expect(items).toHaveLength(n)
    if (n > 0) expect(items[0]).toMatchObject({ count: compactions, strong })
  })
})

describe('D8 burn vs the usual high', () => {
  const u = (tokens: number): Usage => ({ input: tokens, output: 0 })
  it.each([
    [u(100_000), 100_000, 0, undefined],
    [u(150_000), 100_000, 1, false],
    [u(230_000), 100_000, 1, true],
    [u(230_000), undefined, 0, undefined],
  ])('%j vs p80 %s', (usage, p80, n, strong) => {
    const items = d8Burn(pass({ usage, ...(p80 !== undefined ? { p80 } : {}) }), [], T)
    expect(items).toHaveLength(n)
    if (n > 0) expect(items[0]?.strong).toBe(strong)
  })
  it('names the ratio', () => {
    expect(d8Burn(pass({ usage: u(230_000), p80: 100_000 }), [], T)[0]).toMatchObject({ ratio: 2.3 })
  })
})

describe('D9 prompt cache misses', () => {
  it.each([
    [{ input: 5_000, output: 1, cacheRead: 1_000 }, 0], // under 20k prompt tokens
    [{ input: 30_000, output: 1, cacheRead: 40_000 }, 0], // 57% hits
    [{ input: 50_000, output: 1, cacheRead: 30_000 }, 1], // 38% hits
    [{ input: 50_000, output: 1 }, 0], // no cache figures
  ])('%j: %i item', (usage, n) => {
    expect(d9Cache(pass({ usage }), [], T)).toHaveLength(n)
  })
  it('strong under 25% hits', () => {
    expect(d9Cache(pass({ usage: { input: 90_000, output: 1, cacheRead: 10_000 } }), [], T)[0]).toMatchObject(
      { percent: 10, strong: true },
    )
  })
})

describe('D10 subagent fan-out', () => {
  it.each([
    [{ a: 40_000 }, 100_000, 0],
    [{ a: 40_000, b: 24_000 }, 100_000, 1],
    [{ a: 90_000 }, 100_000, 1],
  ])('%j of %i: %i item', (subagents, total, n) => {
    expect(d10Subagents(pass({ cs: { subagents }, usage: { input: total, output: 0 } }), [], T)).toHaveLength(
      n,
    )
  })
})

describe('detectAll', () => {
  it('strong items first, then in pass order; thresholds can be overridden', () => {
    const a = pass({ step: 'plan', cs: { compactions: 2 } })
    const b = pass({ step: 'implement', cs: { compactions: 3 } })
    expect(detectAll([a, b]).map((i) => [i.step, i.strong])).toEqual([
      ['implement', true],
      ['plan', false],
    ])
    expect(detectAll([a, b], { compactionsWarn: 3 }).map((i) => i.step)).toEqual(['implement'])
  })
})
