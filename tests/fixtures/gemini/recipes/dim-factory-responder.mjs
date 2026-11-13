// A --responders module for live Gemini ACP recordings (the ACP base's permission order and decision table, and its
// Stop; tests/fixtures/gemini/README.md "Re-recording live"). It answers every agent request as
// Dim Factory's ACP base does (src/core/adapters/acp-base/protocol.ts), so a live recording replays through the adapter
// whatever the live model asks, however many times:
//
//   session/request_permission   1. a Plan pass's plan exit: rejected, then session/cancel (the plan is captured);
//                                   any other mode switch (Gemini's exit_plan_mode outside a Plan pass, enter
//                                   plan mode): rejected, never asked or approved
//                                2. a read-only pass: rejected (reject_once), never an ask
//                                3. otherwise an ask, answered with the next decision of `answers` (allow,
//                                   allow-session, deny; the last one repeated once the list runs out);
//                                   allow-session never picks a forbidden or persistent option. With `stop.after` an
//                                   ask, the first ask is the user's Stop instead: session/cancel, then the request
//                                   answered cancelled, and every later request cancelled too.
//   anything else                -32601 "Method not found: <method>" (fs and terminal capabilities stay false)
//
// Every recipe's responders.mjs is `export default dimFactoryResponder(<its pass.json>)` (recipes/synthesize.mjs).
import { isModeSwitch } from '../../../../src/core/adapters/acp-base/permissions.ts'
import {
  CANCELLED_OUTCOME,
  cancelParams,
  isPlanExit,
  permissionReply,
  rejectReply,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import { GEMINI_PLAN_EXIT_TITLE } from '../../../../src/core/adapters/gemini/wire.ts'

/** Gemini's optionPrefs (the Gemini config of the ACP base uses the same lists). */
export const GEMINI_PREFS = Object.freeze({
  allowSession: ['proceed_always_tool', 'proceed_always', 'proceed_always_server'],
  forbidden: ['proceed_always_and_save'],
})

const READ_ONLY_STEPS = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {{step?: string, mode?: string, planNative?: boolean, answers?: {decision: string}[],
 *   stop?: {after?: {type?: string}}}} pass
 */
export function dimFactoryResponder(pass, prefs = GEMINI_PREFS) {
  const readOnly = READ_ONLY_STEPS.has(String(pass.step)) || pass.mode === 'readonly'
  const answers = (pass.answers ?? []).map((a) => a.decision)
  const stopAtAsk = pass.stop?.after?.type === 'ask'
  let next = 0
  let stopped = false
  return (frame) => {
    if (!isObject(frame) || typeof frame.method !== 'string' || !Object.hasOwn(frame, 'id')) return undefined
    const { id, method } = frame
    if (method !== 'session/request_permission')
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    const params = isObject(frame.params) ? frame.params : {}
    const options = Array.isArray(params.options) ? params.options : []
    const toolCall = isObject(params.toolCall) ? params.toolCall : {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    const cancel = { jsonrpc: '2.0', method: 'session/cancel', params: cancelParams(String(params.sessionId)) }
    if (stopped) return reply(CANCELLED_OUTCOME)
    if (pass.planNative === true && isPlanExit(toolCall, GEMINI_PLAN_EXIT_TITLE)) {
      // Rule 1: capture, reject (never approve: an approved exit leaves plan mode), then end the turn.
      stopped = true
      return [reply(rejectReply(options, prefs)), cancel]
    }
    // Rule 1, any other mode switch: rejected, never asked (an approved switch could widen what the pass may do).
    if (isModeSwitch(toolCall, GEMINI_PLAN_EXIT_TITLE)) return reply(rejectReply(options, prefs))
    if (readOnly) return reply(rejectReply(options, prefs))
    if (stopAtAsk) {
      // The user's Stop while this ask is pending (the first kill step, the ACP spec's order).
      stopped = true
      return [cancel, reply(CANCELLED_OUTCOME)]
    }
    const decision = answers.length === 0 ? 'deny' : answers[Math.min(next, answers.length - 1)]
    next++
    return reply(permissionReply(decision, options, prefs))
  }
}
