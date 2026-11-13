// Claude's context breakdown: the `get_context_usage` control request (pinned SDK
// SDKControlGetContextUsageRequest, `detail: 'summary'`: no per-category token-count calls) and its answer
// (SDKControlGetContextUsageResponse, camelCase), or the /context result's `context_usage` twin (SDKContextUsage,
// snake_case), read into the ContextBreakdown core keeps. Live C23b: summary detail still names each skill
// (skills.skillFrontmatter), each MCP tool with its server (mcpTools, isLoaded false for a deferred one), the memory
// files and the custom subagents, each with its tokens.
// What is kept: per skill, per MCP server (tools summed), per memory file (its file name, never its folder) and per
// subagent, with tokens. Tool names, paths and the grid are dropped.
import { basename } from 'node:path'
import type { ContextBreakdown, ContextContributor } from '../../../shared/context.ts'
import { contextPercent } from '../../../shared/context.ts'
import type { ControlRequestFrame, JsonObject } from './protocol.ts'
import { num, obj, str } from './protocol.ts'

/** The control request (stdin frame) asking for the summary breakdown. */
export function contextUsageRequest(requestId: string): ControlRequestFrame {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'get_context_usage', detail: 'summary' },
  }
}

const list = (v: unknown): JsonObject[] =>
  Array.isArray(v) ? v.flatMap((x) => (obj(x) !== undefined ? [obj(x)!] : [])) : []

function contributor(
  kind: ContextContributor['kind'],
  name: string | undefined,
  tokens: number | undefined,
): ContextContributor | undefined {
  if (name === undefined || name.trim() === '' || tokens === undefined || !(tokens >= 0)) return undefined
  return { kind, name: name.trim(), tokens: Math.round(tokens), from: 'vendor' }
}

const byTokens = (a: ContextContributor, b: ContextContributor): number => b.tokens - a.tokens

/** The breakdown in an answer (either shape); undefined when it carries no figure at all. */
export function parseContextUsage(v: unknown): ContextBreakdown | undefined {
  const r = obj(v)
  if (r === undefined) return undefined
  const total = num(r['totalTokens']) ?? num(r['total_tokens'])
  const window = num(r['rawMaxTokens']) ?? num(r['raw_max_tokens']) ?? num(r['maxTokens'])
  const percent = num(r['percentage']) ?? contextPercent(total, window)

  const skills: ContextContributor[] = []
  const skillsField = r['skills']
  // Control reply: {totalSkills, includedSkills, tokens, skillFrontmatter: [{name, source, tokens}]}.
  const front = Array.isArray(skillsField) ? skillsField : obj(skillsField)?.['skillFrontmatter']
  for (const s of list(front)) {
    const c = contributor('skill', str(s['name']), num(s['tokens']))
    if (c !== undefined) skills.push(c)
  }

  const servers = new Map<string, ContextContributor>()
  for (const t of list(r['mcpTools'] ?? r['mcp_tools'])) {
    const server = str(t['serverName']) ?? str(t['server_name'])
    const tokens = num(t['tokens'])
    if (server === undefined || server.trim() === '' || tokens === undefined) continue
    // A deferred tool (isLoaded false, live C23b) is listed for awareness: its schema is not in the window.
    if (t['isLoaded'] === false) continue
    const s = servers.get(server) ?? { kind: 'mcp', name: server, tokens: 0, tools: 0, from: 'vendor' }
    s.tokens += Math.round(tokens)
    s.tools = (s.tools ?? 0) + 1
    servers.set(server, s)
  }

  const memory: ContextContributor[] = []
  for (const m of list(r['memoryFiles'] ?? r['memory_files'])) {
    const path = str(m['path'])
    const c = contributor(
      'memory',
      path !== undefined ? basename(path.replace(/\\/g, '/')) : undefined,
      num(m['tokens']),
    )
    if (c !== undefined) memory.push(c)
  }

  const agents: ContextContributor[] = []
  for (const a of list(r['agents'])) {
    const c = contributor('agent', str(a['agentType']) ?? str(a['agent_type']), num(a['tokens']))
    if (c !== undefined) agents.push(c)
  }

  const autoCompactAt = num(r['autoCompactThreshold'])
  if (
    total === undefined &&
    window === undefined &&
    skills.length + servers.size + memory.length + agents.length === 0
  )
    return undefined
  return {
    ...(total !== undefined ? { total: Math.round(total) } : {}),
    ...(window !== undefined && window > 0 ? { window: Math.round(window) } : {}),
    ...(percent !== undefined ? { percent: Math.round(percent) } : {}),
    ...(autoCompactAt !== undefined ? { autoCompactAt: Math.round(autoCompactAt) } : {}),
    skills: skills.sort(byTokens),
    mcp: [...servers.values()].sort(byTokens),
    memory: memory.sort(byTokens),
    agents: agents.sort(byTokens),
  }
}
