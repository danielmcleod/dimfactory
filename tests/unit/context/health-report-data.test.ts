// What a run's context-health.json keeps for the project's Context report: the calls each pass made to each MCP
// server (Claude's `mcp__<server>__<tool>`, Codex's `mcp:<server>/<tool>`) on the server's contributor row, and the
// run's grounding counts from its findings (counts only).
import { describe, expect, it } from 'vitest'
import { contributorsOf, groundingCounts } from '@core/context/health.ts'
import { applyToolEvent, mcpServerOf, newContextState } from '@core/context/state.ts'
import type { RunState } from '@core/supervisor/types.ts'
import type { Finding } from '@shared/findings.ts'

const start = (name: string, fp: string) => ({ type: 'tool', name, summary: '', phase: 'start', fp }) as const

describe('MCP calls per server', () => {
  it('knows the server of Claude and Codex MCP tools, and no other tool', () => {
    expect(mcpServerOf('mcp__linear__create_issue')).toBe('linear')
    expect(mcpServerOf('mcp__my-server__a__b')).toBe('my-server')
    expect(mcpServerOf('mcp:github/search')).toBe('github')
    expect(mcpServerOf('Bash')).toBeUndefined()
    expect(mcpServerOf('mcp')).toBeUndefined()
  })

  it('counts calls per server and puts them on the server contributor (0: loaded, never called)', () => {
    const cs = newContextState({
      promptTokens: 0,
      resumed: false,
      projectFiles: [],
      mcpNames: ['linear', 'idle'],
      skillNames: [],
    })
    applyToolEvent(cs, start('mcp__linear__a', 'f1'))
    applyToolEvent(cs, start('mcp__linear__b', 'f2'))
    applyToolEvent(cs, start('Read', 'f3'))
    expect(cs.tools.mcpCalls).toEqual({ linear: 2 })
    expect(contributorsOf(cs)).toEqual([
      { kind: 'mcp', name: 'linear', tokens: 0, from: 'name', calls: 2 },
      { kind: 'mcp', name: 'idle', tokens: 0, from: 'name', calls: 0 },
    ])
  })

  it('a pass that ran no tool says nothing about its servers', () => {
    const cs = newContextState({
      promptTokens: 0,
      resumed: false,
      projectFiles: [],
      mcpNames: ['linear'],
      skillNames: [],
    })
    expect(contributorsOf(cs)).toEqual([{ kind: 'mcp', name: 'linear', tokens: 0, from: 'name' }])
  })
})

describe('grounding counts', () => {
  const f = (over: Partial<Finding>): Finding => ({
    id: Math.random().toString(16).slice(2),
    n: 1,
    severity: 'should',
    source: 'review',
    title: 't',
    body: '',
    flags: [],
    round: 1,
    ...over,
  })

  it('counts grounding findings (the source, or a reviewer marking), their musts and possible hallucinations', () => {
    const list = [
      f({ source: 'grounding', severity: 'must' }),
      f({ source: 'grounding' }),
      f({ source: 'critic', flags: ['grounding'], severity: 'must' }),
      f({ source: 'verify', flags: ['possible-hallucination'], severity: 'must' }),
      f({ source: 'review' }),
    ]
    const s = { findings: { list } } as unknown as RunState
    expect(groundingCounts(s)).toEqual({ findings: 3, musts: 2, hallucinations: 1 })
    expect(groundingCounts({} as RunState)).toEqual({ findings: 0, musts: 0, hallucinations: 0 })
  })
})
