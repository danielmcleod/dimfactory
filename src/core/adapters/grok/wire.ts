// What Grok Build puts on the ACP wire where the schema leaves it free (read from
// xai-org/grok-build main on 2026-10-11: mvp_agent/acp_agent.rs, session_setup.rs, prompt_response_meta_tests.rs and
// the user guide 15, 22): the approval posture on session setup, the prompt answer's token totals and the permission
// options Dim Factory never chooses. Pure; shared with the fixture recipes.
import type { AcpMetaUsage } from '../acp-base/config.ts'
import { num, rec } from '../acp-base/wire.ts'

/**
 * The approval posture of a session (`_meta` on session/new and session/load; session_setup.rs reads `yoloMode` with
 * `as_bool()`, so an explicit `false` overrides an always-approve default from the user's own Grok config). Full mode
 * (Auto only) is always-approve for this session; every other pass asks (`autoMode` off: Grok's own classifier would
 * otherwise approve "safe" calls on its own).
 */
export const GROK_ASK_META = Object.freeze({ yoloMode: false, autoMode: false })
export const GROK_YOLO_META = Object.freeze({ yoloMode: true })

/**
 * A permission option Dim Factory never chooses, whatever its kind or id (user guide 22, the prompt's choices): "Enable
 * always-approve mode" widens the whole session, "Allow all edits this session" every later edit, and auto mode hands
 * the decisions to Grok's classifier. Grok's ACP option ids are not documented, so the names decide.
 */
export const GROK_FORBIDDEN_OPTION_NAME =
  /always[- ]?approve|\byolo\b|bypass|auto[- ]?(?:mode|approve)|all edits|never ask|don'?t ask/i

const sumOf = (values: readonly (number | undefined)[]): number | undefined =>
  values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined

/**
 * Grok's prompt answer (`acp::PromptResponse` with `build_prompt_response_meta`): no ACP `usage` field; `_meta.usage`
 * is the prompt's usage, `{totalTokens, modelUsage: {<model>: {inputTokens, outputTokens, cacheReadInputTokens,
 * modelCalls, costUSD}}}` (the headless `modelUsage` names), summed over the models. The cached reads are apart from
 * `inputTokens` (Grok's own total is input + cache read + cache creation + output) unless the answer's `totalTokens`
 * says otherwise (`= input + output` with cached reads > 0: they were inside the input, so they come off). The cost is
 * Grok's own figure when every model reports one. Exact (`approx: false`).
 *
 * Without `_meta.usage`, the per-turn keys (`inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`) are
 * the last turn's alone: reported, flagged approximate (`per-turn-only`). There `inputTokens` is the API's
 * `prompt_tokens`, which holds the cached reads (prompt_response_meta_tests.rs: prompt 1500, completion 200, total 1700,
 * cached 1000), so they come off the input. undefined when the answer has neither.
 */
export function grokMetaUsage(result: unknown): AcpMetaUsage | undefined {
  const meta = rec(rec(result)?.['_meta'])
  if (meta === undefined) return undefined
  const usage = rec(meta['usage'])
  const models = Object.values(rec(usage?.['modelUsage']) ?? {})
    .map(rec)
    .filter((m): m is Record<string, unknown> => m !== undefined)
    .filter((m) => num(m['inputTokens']) !== undefined || num(m['outputTokens']) !== undefined)
  if (models.length > 0) {
    const input = sumOf(models.map((m) => num(m['inputTokens']))) ?? 0
    const output = sumOf(models.map((m) => num(m['outputTokens']))) ?? 0
    const cacheRead = sumOf(models.map((m) => num(m['cacheReadInputTokens']) ?? num(m['cachedReadTokens'])))
    const cacheWrite = sumOf(models.map((m) => num(m['cacheCreationInputTokens'])))
    const reasoning = sumOf(models.map((m) => num(m['reasoningTokens'])))
    const costs = models.map((m) => num(m['costUSD']))
    const total = num(usage?.['totalTokens'])
    const cachedInInput =
      cacheRead !== undefined && cacheRead > 0 && total !== undefined && total === input + output
    const out: AcpMetaUsage = {
      input: Math.max(0, cachedInInput ? input - (cacheRead ?? 0) : input),
      output,
      approx: false,
    }
    if (cacheRead !== undefined) out.cacheRead = cacheRead
    if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
    if (reasoning !== undefined) out.reasoning = reasoning
    if (costs.every((c) => c !== undefined)) out.costUsd = sumOf(costs) ?? 0
    return out
  }
  const input = num(meta['inputTokens'])
  const output = num(meta['outputTokens'])
  if (input === undefined || output === undefined) return undefined
  const cacheRead = num(meta['cachedReadTokens'])
  const out: AcpMetaUsage = {
    input: Math.max(0, input - (cacheRead ?? 0)),
    output,
    approx: 'per-turn-only',
  }
  const reasoning = num(meta['reasoningTokens'])
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  if (reasoning !== undefined) out.reasoning = reasoning
  return out
}
