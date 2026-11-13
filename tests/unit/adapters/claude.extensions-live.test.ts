// Live Claude recordings (claude.exe 2.1.289, 2026-10-25) behind the Extensions launch rules:
// - the read-only and plan fixtures re-recorded with the argv the adapter sends today (skills off and, in Claude's own
//   plan mode, hooks off at None);
// - C20a/C20b: a project subagent with `permissionMode: bypassPermissions` cannot escape a read-only pass (dontAsk
//   denies its shell, the host denies its asks in plan mode), recorded with the subagent tool left in on purpose;
// - C21a/C21b: `dontAsk` denies an allowed MCP server's tool, and its `mcp__<name>__*` allow rule (Run without asking)
//   lets it run;
// - C22a-C22d: the claude.ai connectors are listed only with strict MCP off, and one passed explicitly as a
//   `claudeai-proxy` server connects under strict MCP and reaches the pass.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ArgvInput } from '@core/adapters/claude/launch.ts'
import { buildArgv, probeArgv } from '@core/adapters/claude/launch.ts'
import { parseRecording } from '@core/adapters/claude/normalize.ts'
import type { JsonObject } from '@core/adapters/claude/protocol.ts'
import { obj, parseFrame } from '@core/adapters/claude/protocol.ts'
import { parseConnectors } from '@core/extensions/claude-connectors.ts'
import { synth } from '../../synth.ts'

const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const text = (id: string): string => readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')
const header = (id: string) => parseRecording(text(id)).header
const argvOf = (id: string): string[] => {
  const a: unknown = header(id)?.['argv']
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(1) : []
}

function frames(id: string, dir: 'out' | 'in'): JsonObject[] {
  return parseRecording(text(id)).frames.flatMap((f) => {
    const v = f.dir === dir && f.line !== undefined ? parseFrame(f.line) : undefined
    return v !== undefined ? [v] : []
  })
}
const out = (id: string): JsonObject[] => frames(id, 'out')
const init = (id: string): JsonObject | undefined =>
  out(id).find((f) => f['type'] === 'system' && f['subtype'] === 'init')
const results = (id: string): JsonObject[] => out(id).filter((f) => f['type'] === 'result')
const denied = (id: string): JsonObject[] =>
  out(id).filter((f) => f['type'] === 'system' && f['subtype'] === 'permission_denied')
/** The tool results of the subagent (frames with a parent tool use) or of the main thread. */
function toolResults(id: string, sub: boolean): { isError: boolean; text: string }[] {
  return out(id)
    .filter((f) => f['type'] === 'user' && (f['parent_tool_use_id'] !== null) === sub)
    .flatMap((f): unknown[] => {
      const content: unknown = obj(f['message'])?.['content']
      return Array.isArray(content) ? (content as unknown[]) : []
    })
    .flatMap((c) => {
      const o = obj(c)
      return o?.['type'] === 'tool_result'
        ? [{ isError: o['is_error'] === true, text: JSON.stringify(o['content']) }]
        : []
    })
}
/** The `mcp_status` replies, in order. */
const statusReplies = (id: string): Record<string, unknown>[][] =>
  out(id).flatMap((f) => {
    const body = obj(f['response'])
    const servers = obj(body?.['response'])?.['mcpServers']
    return f['type'] === 'control_response' && Array.isArray(servers)
      ? [servers as Record<string, unknown>[]]
      : []
  })

const ro = { route: 'readonly', step: 'review', mode: 'readonly' } as const
const plan = { route: 'plan', step: 'plan', mode: 'readonly' } as const
const argv = (i: Omit<ArgvInput, 'mode'> & { mode?: ArgvInput['mode'] }): string[] =>
  buildArgv({ mode: 'readonly', ...i })

describe('the re-recorded read-only and plan fixtures carry the argv the adapter sends today', () => {
  it.each([
    ['C02-review-shape', argv({ ...ro, model: 'sonnet' })],
    ['C11b-invalid-model', argv({ ...ro, model: 'claude-nonexistent-9' })],
    ['C12a-max-turns', argv({ ...ro, model: 'sonnet', extraArgs: ['--max-turns', '1'] })],
    ['C12b-max-budget', argv({ ...ro, model: 'sonnet', extraArgs: ['--max-budget-usd', '0.0001'] })],
    ['C13-subagent', argv({ ...ro, model: 'sonnet' })],
    ['C06-plan-native-host', argv({ ...plan, model: 'opus' })],
    ['C06b-plan-host-shell', argv({ ...plan, model: 'sonnet' })],
  ])('%s', (id, expected) => {
    expect(argvOf(id)).toEqual(expected)
    expect(argvOf(id)).toContain('--disable-slash-commands')
  })
})

describe('a custom subagent with permissionMode bypassPermissions cannot escape a read-only pass (C20a, C20b)', () => {
  it('C20a: on the read-only route dontAsk denies its shell and it has no edit tool; nothing ran', () => {
    // Recorded without the subagent cut, on purpose: what the subagent could do if it ran.
    expect(argvOf('C20a-custom-agent-bypass-readonly')).toEqual(argv({ ...ro, model: 'haiku' }))
    expect(argvOf('C20a-custom-agent-bypass-readonly').join(' ')).not.toContain('Agent')
    expect(init('C20a-custom-agent-bypass-readonly')?.['permissionMode']).toBe('dontAsk')
    expect(denied('C20a-custom-agent-bypass-readonly')).toMatchObject([
      { tool_name: 'Bash', decision_reason_type: 'mode', agent_id: expect.any(String) as unknown },
    ])
    const sub = toolResults('C20a-custom-agent-bypass-readonly', true)
    expect(sub.length).toBeGreaterThan(0)
    expect(sub.every((r) => r.isError)).toBe(true)
    expect(sub[0]?.text).toContain("don't ask mode")
  })

  it("C20b: in Claude's own plan mode its tools still ask the host, which denies them as a read-only pass", () => {
    expect(argvOf('C20b-custom-agent-bypass-plan')).toEqual(argv({ ...plan, model: 'haiku' }))
    const asks = out('C20b-custom-agent-bypass-plan')
      .filter((f) => f['type'] === 'control_request' && obj(f['request'])?.['subtype'] === 'can_use_tool')
      .map((f) => obj(f['request']) ?? {})
    // Neither was let through by the subagent's own mode: Write asks as plan mode's (`mode`), the shell command as an
    // unclassified one (`other`).
    expect(asks.map((r) => [r['tool_name'], r['decision_reason_type']])).toEqual([
      ['Write', 'mode'],
      ['Bash', 'other'],
    ])
    expect(toolResults('C20b-custom-agent-bypass-plan', true)).toEqual([
      { isError: true, text: '"Read-only pass"' },
      { isError: true, text: '"Read-only pass"' },
    ])
    expect(results('C20b-custom-agent-bypass-plan').at(-1)?.['permission_denials']).toHaveLength(2)
  })

  it('the launch still cuts the subagent tool on those routes when custom subagents exist (they bring their own prompts, models and MCP servers)', () => {
    const cut = (a: string[]): string => a[a.indexOf('--disallowedTools') + 1] ?? ''
    expect(cut(argv({ ...ro, customAgents: true }))).toContain('Agent')
    expect(cut(argv({ ...plan, customAgents: true }))).toContain('Agent')
  })
})

describe('an allowed MCP server on a read-only pass (C21a, C21b)', () => {
  const allowed = { ...ro, model: 'haiku', extensions: 'allowed', mcpConfigPath: 'mcp/servers.json' } as const

  it('C21a: dontAsk denies its tool, so a read-only pass never uses it by default', () => {
    expect(argvOf('C21a-mcp-dontask-denied')).toEqual(argv(allowed))
    expect(init('C21a-mcp-dontask-denied')?.['mcp_servers']).toMatchObject([{ status: 'connected' }])
    expect(denied('C21a-mcp-dontask-denied')).toMatchObject([
      { tool_name: 'mcp__<REDACTED>', decision_reason_type: 'mode' },
    ])
    expect(results('C21a-mcp-dontask-denied').at(-1)?.['permission_denials']).toHaveLength(1)
  })

  it('C21b: Run without asking adds mcp__<name>__* to --allowedTools, and the tool runs', () => {
    const a = argv({ ...allowed, mcpWithoutAsking: ['probe-echo'] })
    expect(a.slice(-2)).toEqual(['--allowedTools', 'mcp__probe-echo__*'])
    expect(argvOf('C21b-mcp-run-without-asking')).toEqual(a)
    expect(denied('C21b-mcp-run-without-asking')).toEqual([])
    expect(toolResults('C21b-mcp-run-without-asking', false).at(-1)).toEqual({
      isError: false,
      text: `[{"type":"text","text":"${synth('hi')}"}]`,
    })
    expect(results('C21b-mcp-run-without-asking').at(-1)?.['permission_denials']).toEqual([])
  })
})

describe('the claude.ai connectors (C22a-C22d)', () => {
  it('C22a: with strict MCP off an initialize-only session lists them in mcp_status (no user message)', () => {
    expect(argvOf('C22a-connectors-listed')).toEqual(probeArgv({ connectors: true }))
    expect(argvOf('C22a-connectors-listed')).not.toContain('--strict-mcp-config')
    expect(frames('C22a-connectors-listed', 'in').some((f) => f['type'] === 'user')).toBe(false)
    const [first, last] = [
      statusReplies('C22a-connectors-listed')[0],
      statusReplies('C22a-connectors-listed').at(-1),
    ]
    expect(first?.length).toBeGreaterThan(0)
    for (const s of last ?? [])
      expect(s).toMatchObject({ scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy' } })
    expect(first?.some((s) => s['status'] === 'pending')).toBe(true)
    expect(last?.some((s) => s['status'] === 'connected' && Array.isArray(s['tools']))).toBe(true)
    // The listing reads them from that reply (the recording's names, addresses and ids are redacted: stand-ins here).
    const standIn = (last ?? []).map((s, i) => ({
      ...s,
      name: `claude.ai Example ${i}`,
      config: { type: 'claudeai-proxy', url: `https://mcp-proxy.example.invalid/${i}`, id: `srv_${i}` },
    }))
    expect(parseConnectors({ mcpServers: standIn }).map((c) => [c.name, c.status])).toEqual(
      (last ?? []).map((s, i) => [`claude_ai_Example_${i}`, s['status']]),
    )
    // Redacted values are never taken for a connector.
    expect(parseConnectors({ mcpServers: last })).toEqual([])
  })

  it('C22b: under strict MCP the account connectors are never fetched', () => {
    expect(argvOf('C22b-connectors-strict-none')).toEqual(probeArgv())
    expect(statusReplies('C22b-connectors-strict-none')).toEqual([[], []])
  })

  it('C22c: one passed explicitly as a claudeai-proxy server connects under strict MCP, connectors env off', () => {
    expect(argvOf('C22c-connector-explicit-strict')).toEqual([
      ...probeArgv(),
      '--mcp-config',
      'mcp/servers.json',
    ])
    expect(header('C22c-connector-explicit-strict')?.['envKeys']).toEqual(['ENABLE_CLAUDEAI_MCP_SERVERS'])
    expect(statusReplies('C22c-connector-explicit-strict').at(-1)).toMatchObject([
      { status: 'connected', source: 'dynamic', config: { type: 'claudeai-proxy' } },
    ])
  })

  it('C22d: an allowed connector reaches a read-only pass at Allowed list with its tools', () => {
    expect(argvOf('C22d-connector-allowed-pass')).toEqual(
      argv({ ...ro, model: 'haiku', extensions: 'allowed', mcpConfigPath: 'mcp/servers.json' }),
    )
    expect(init('C22d-connector-allowed-pass')?.['mcp_servers']).toEqual([
      { name: '<REDACTED>', status: 'connected', source: 'dynamic' },
    ])
    const tools = (init('C22d-connector-allowed-pass')?.['tools'] as string[] | undefined) ?? []
    expect(tools.filter((t) => t.startsWith('mcp__')).length).toBeGreaterThan(0)
    expect(results('C22d-connector-allowed-pass').at(-1)).toMatchObject({ subtype: 'success', result: 'OK' })
  })
})
