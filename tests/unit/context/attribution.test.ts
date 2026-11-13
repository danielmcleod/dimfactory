// Claude's context breakdown (adapters/claude/context-usage.ts): the get_context_usage request, its answer in both
// shapes (the control reply's camelCase, the /context result's snake_case twin), deferred MCP tools left out, memory
// files by their file name only; and the Context health contributors built from it (core/context/health.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contextUsageRequest, parseContextUsage } from '@core/adapters/claude/context-usage.ts'
import { contributorsOf } from '@core/context/health.ts'
import { newContextState } from '@core/context/state.ts'
import { projectMemoryFiles, memoryFilesFor } from '@core/context/facts.ts'

const C23B = join(
  process.cwd(),
  'tests',
  'fixtures',
  'claude',
  'stdio',
  'C23b-context-usage',
  'recording.jsonl',
)

describe('get_context_usage', () => {
  it('asks for the summary detail (no per-category token-count calls)', () => {
    expect(contextUsageRequest('ctx-1')).toEqual({
      type: 'control_request',
      request_id: 'ctx-1',
      request: { subtype: 'get_context_usage', detail: 'summary' },
    })
  })

  it('reads the control reply: skills, MCP servers (loaded tools only), memory files by name, agents', () => {
    const b = parseContextUsage({
      totalTokens: 38_436,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 19,
      autoCompactThreshold: 167_000,
      skills: {
        totalSkills: 2,
        includedSkills: 2,
        tokens: 600,
        skillFrontmatter: [
          { name: 'small', source: 'userSettings', tokens: 100 },
          { name: 'large', source: 'plugin', tokens: 500 },
        ],
      },
      mcpTools: [
        { name: 'mcp__gh__a', serverName: 'gh', tokens: 4_000 },
        { name: 'mcp__gh__b', serverName: 'gh', tokens: 5_000, isLoaded: true },
        { name: 'mcp__echo__echo', serverName: 'echo', tokens: 300, isLoaded: false },
      ],
      memoryFiles: [{ path: 'C:\\Users\\me\\proj\\CLAUDE.md', type: 'Project', tokens: 2_400 }],
      agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 210 }],
    })
    expect(b).toEqual({
      total: 38_436,
      window: 200_000,
      percent: 19,
      autoCompactAt: 167_000,
      skills: [
        { kind: 'skill', name: 'large', tokens: 500, from: 'vendor' },
        { kind: 'skill', name: 'small', tokens: 100, from: 'vendor' },
      ],
      mcp: [{ kind: 'mcp', name: 'gh', tokens: 9_000, tools: 2, from: 'vendor' }],
      memory: [{ kind: 'memory', name: 'CLAUDE.md', tokens: 2_400, from: 'vendor' }],
      agents: [{ kind: 'agent', name: 'reviewer', tokens: 210, from: 'vendor' }],
    })
  })

  it("reads the /context result's snake_case twin", () => {
    const b = parseContextUsage({
      total_tokens: 50_000,
      raw_max_tokens: 200_000,
      mcp_tools: [{ name: 'mcp__x__y', server_name: 'x', tokens: 700 }],
      memory_files: [{ path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
      agents: [{ agent_type: 'helper', source: 'plugin', tokens: 40 }],
      skills: [{ name: 's', source: 'userSettings', tokens: 30 }],
    })
    expect(b).toMatchObject({
      total: 50_000,
      window: 200_000,
      percent: 25,
      mcp: [{ name: 'x', tokens: 700, tools: 1 }],
      memory: [{ name: 'CLAUDE.md', tokens: 900 }],
      agents: [{ name: 'helper', tokens: 40 }],
      skills: [{ name: 's', tokens: 30 }],
    })
  })

  it('an answer with no figure at all is no breakdown', () => {
    expect(parseContextUsage({})).toBeUndefined()
    expect(parseContextUsage('nope')).toBeUndefined()
  })

  it('live C23b: summary detail still names skills, MCP tools (deferred) and agents', () => {
    const lines = readFileSync(C23B, 'utf8')
      .split('\n')
      .filter((l) => l.includes('skillFrontmatter'))
    expect(lines.length).toBe(2)
    for (const l of lines) {
      const frame = JSON.parse((JSON.parse(l) as { line: string }).line) as {
        response: { response: unknown }
      }
      const b = parseContextUsage(frame.response.response)
      expect(b?.window).toBe(200_000)
      expect(b?.skills.length).toBeGreaterThan(5)
      // The echo server's one tool is deferred (isLoaded false): not in the window.
      expect(b?.mcp).toEqual([])
    }
  })
})

describe('contributors', () => {
  it("the vendor's figures first, then the project's files Dim Factory sized, biggest first, five at most", () => {
    const cs = newContextState({
      promptTokens: 0,
      resumed: false,
      projectFiles: [{ kind: 'memory', name: 'CLAUDE.md', tokens: 3_000, from: 'estimate' }],
      mcpNames: ['ignored-when-a-breakdown-exists'],
      skillNames: [],
    })
    cs.breakdown = {
      end: {
        skills: [{ kind: 'skill', name: 's', tokens: 100, from: 'vendor' }],
        mcp: [{ kind: 'mcp', name: 'gh', tokens: 9_000, tools: 31, from: 'vendor' }],
        memory: [],
        agents: [
          { kind: 'agent', name: 'a1', tokens: 50, from: 'vendor' },
          { kind: 'agent', name: 'a2', tokens: 40, from: 'vendor' },
          { kind: 'agent', name: 'a3', tokens: 30, from: 'vendor' },
        ],
      },
    }
    expect(contributorsOf(cs).map((c) => c.name)).toEqual(['gh', 'CLAUDE.md', 's', 'a1', 'a2'])
  })

  it('without a breakdown (Codex): the project files sized, then the names the settings list, unsized', () => {
    const cs = newContextState({
      promptTokens: 0,
      resumed: false,
      projectFiles: [{ kind: 'memory', name: 'AGENTS.md', tokens: 1_200, from: 'estimate' }],
      mcpNames: ['linear'],
      skillNames: ['deploy'],
    })
    expect(contributorsOf(cs)).toEqual([
      { kind: 'memory', name: 'AGENTS.md', tokens: 1_200, from: 'estimate' },
      { kind: 'mcp', name: 'linear', tokens: 0, from: 'name' },
      { kind: 'skill', name: 'deploy', tokens: 0, from: 'name' },
    ])
  })
})

describe('project memory files', () => {
  it('each vendor reads its own; sizes only, from the project folder', () => {
    expect(memoryFilesFor('claude')).toEqual(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'])
    expect(memoryFilesFor('codex')).toEqual(['AGENTS.md'])
    expect(memoryFilesFor('gemini')).toEqual(['GEMINI.md'])
    const sizes: Record<string, number> = { [join('/p', 'AGENTS.md')]: 35_000 }
    expect(projectMemoryFiles('codex', '/p', (f) => sizes[f])).toEqual([
      { kind: 'memory', name: 'AGENTS.md', tokens: 10_000, from: 'estimate' },
    ])
    expect(projectMemoryFiles('gemini', '/p', (f) => sizes[f])).toEqual([])
  })
})
