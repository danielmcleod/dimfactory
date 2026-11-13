// The synthesized Research fixtures still carry exactly what the code sends: C19 (Claude) its argv, env keys and
// initialize jsonSchema; X19 (Codex app-server) its thread/start safety set and turn/start outputSchema. Both are
// synthesized (Research was never recorded live) and say so in their headers.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildArgv } from '@core/adapters/claude/launch.ts'
import { strictOutputSchema } from '@core/adapters/codex/params.ts'
import { RESEARCH_SCHEMA, parseResearch } from '@core/research/parse.ts'

type Json = Record<string, unknown>

const lines = (rel: string): Json[] =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Json)

const messagesOf = (frames: Json[], dir: 'in' | 'out'): Json[] =>
  frames
    .filter((f) => f['dir'] === dir && typeof f['line'] === 'string')
    .map((f) => JSON.parse(f['line'] as string) as Json)

describe('C19-research-web (Claude, synthesized)', () => {
  const [header, ...frames] = lines('../../fixtures/claude/stdio/C19-research-web/recording.jsonl')

  it('is marked synthesized and carries the argv and env of a web-enabled Research pass', () => {
    expect(header).toMatchObject({ synthesized: true, scenario: 'C19-research-web' })
    expect(header?.['argv']).toEqual([
      'claude.exe',
      ...buildArgv({ route: 'readonly', mode: 'readonly', step: 'research', model: 'sonnet', webOpen: true }),
    ])
    expect(header?.['envKeys']).toContain('CLAUDE_CODE_EVAL_CONFINED')
  })

  it('sends the research schema in initialize, and its structured answer parses with every claim cited', () => {
    const init = messagesOf(frames, 'in').find((m) => m['type'] === 'control_request')
    expect((init?.['request'] as Json)['jsonSchema']).toEqual(RESEARCH_SCHEMA)
    const result = messagesOf(frames, 'out').find((m) => m['type'] === 'result')
    const parsed = parseResearch(result?.['structured_output'])
    expect(parsed.result?.dropped).toBe(0)
    expect(parsed.result?.features).toHaveLength(2)
    // The tools it used: a repository read, a web search, a page fetch, then the answer.
    const tools = messagesOf(frames, 'out')
      .filter((m) => m['type'] === 'assistant')
      .flatMap((m) => ((m['message'] as Json)['content'] as Json[]).filter((c) => c['type'] === 'tool_use'))
      .map((c) => c['name'])
    expect(tools).toEqual(['Read', 'WebSearch', 'WebFetch', 'StructuredOutput'])
  })
})

describe('X19-research-web-search (Codex app-server, synthesized)', () => {
  const [header, ...frames] = lines('../../fixtures/codex/app-server/X19-research-web-search/recording.jsonl')
  const request = (method: string): Json | undefined =>
    messagesOf(frames, 'in').find((m) => m['method'] === method)?.['params'] as Json | undefined

  it('is read-only, ephemeral, with live web search and the research outputSchema in strict form', () => {
    expect(header).toMatchObject({ synthesized: true })
    expect(request('thread/start')).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      config: { web_search: 'live' },
    })
    expect(request('turn/start')?.['outputSchema']).toEqual(strictOutputSchema(RESEARCH_SCHEMA))
    const search = messagesOf(frames, 'out').find(
      (m) =>
        m['method'] === 'item/completed' && ((m['params'] as Json)['item'] as Json)['type'] === 'webSearch',
    )
    expect(search).toBeDefined()
  })
})
