// A --responders module for live Grok ACP recordings (the ACP base's permission order and decision table; for Grok,
// plan emulated, full mode `_meta.yoloMode`; tests/fixtures/grok/README.md "Re-recording live"). It answers every
// agent request as Dim Factory's ACP base does with the Grok configuration (src/core/adapters/grok/config.ts), so a
// live recording replays through the adapter whatever the live model asks:
//
//   session/request_permission   1. a mode switch (Grok's enter_plan_mode / exit_plan_mode, a switch_mode tool):
//                                   rejected, never asked or approved (Grok's plan is emulated: no plan exit is
//                                   ever captured)
//                                2. a read-only pass, and the GR03 study (`study: 'default-mode-edit'`): rejected
//                                   (reject_once), never an ask
//                                3. otherwise an ask, answered with the next decision of `answers` (allow, deny; the
//                                   last one repeated once the list runs out). Allow for this run is never offered
//                                   (Grok's "Always allow" is remembered for the project), and an option whose name
//                                   would widen the session (always-approve, all edits, auto mode) is never chosen.
//   anything else                -32601 "Method not found: <method>" (fs and terminal capabilities stay false; Grok's
//                                   x.ai/* requests too)
//
// Every recipe's responders.mjs is `export default dimFactoryResponder(<its pass.json>)` (recipes/synthesize.mjs).
import { isModeSwitch } from '../../../../src/core/adapters/acp-base/permissions.ts'
import { permissionReply, rejectReply } from '../../../../src/core/adapters/acp-base/protocol.ts'
import { GROK_FORBIDDEN_OPTION_NAME } from '../../../../src/core/adapters/grok/wire.ts'

/** Grok's optionPrefs (the Grok config of the ACP base uses the same). */
export const GROK_PREFS = Object.freeze({
  allowSession: Object.freeze([]),
  forbidden: Object.freeze([]),
  forbiddenName: GROK_FORBIDDEN_OPTION_NAME,
})

const READ_ONLY_STEPS = new Set(['plan', 'review', 'critic', 'heal', 'catalog'])
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {{step?: string, mode?: string, study?: string, answers?: {decision: string}[]}} pass
 */
export function dimFactoryResponder(pass, prefs = GROK_PREFS) {
  const rejectAll =
    READ_ONLY_STEPS.has(String(pass.step)) || pass.mode === 'readonly' || pass.study !== undefined
  const answers = (pass.answers ?? []).map((a) => a.decision)
  let next = 0
  return (frame) => {
    if (!isObject(frame) || typeof frame.method !== 'string' || !Object.hasOwn(frame, 'id')) return undefined
    const { id, method } = frame
    if (method !== 'session/request_permission')
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    const params = isObject(frame.params) ? frame.params : {}
    const options = Array.isArray(params.options) ? params.options : []
    const toolCall = isObject(params.toolCall) ? params.toolCall : {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    // Rule 1: a mode switch is rejected, never asked (an approved switch could widen what the pass may do).
    if (isModeSwitch(toolCall)) return reply(rejectReply(options, prefs))
    if (rejectAll) return reply(rejectReply(options, prefs))
    const decision = answers.length === 0 ? 'deny' : answers[Math.min(next, answers.length - 1)]
    next++
    return reply(permissionReply(decision, options, prefs))
  }
}
