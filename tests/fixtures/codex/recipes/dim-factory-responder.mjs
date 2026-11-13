// A --responders module for live Codex recordings (tests/fixtures/codex/README.md "Re-recording live"): it answers
// every server request exactly as Dim Factory's adapter does (src/core/adapters/codex/asks.ts, normalize.ts request(),
// src/core/proc/jsonrpc.ts), so a recording replays through the adapter whatever the live model asks for:
//
//   approvals (command, file change, permissions)  the next decision of `answers` (allow, allow-session, deny,
//                                                   cancel), the last one repeated once the list runs out
//   mcpServer/elicitation/request                   cancelled; with `{ mcpApprovals: true }` (an edit pass) an MCP
//                                                   tool approval takes the next decision like an approval (X20)
//   the requests Dim Factory refuses                  -32000 "Not supported by Dim Factory; continue without it."
//   anything else                                   -32601 "Method not found: <method>"
//
// A recipe's responders.mjs is `export default dimFactoryResponder(['allow'])`; its pass.json `answers` list the same
// decisions, one per ask the recording holds.
import {
  ASK_METHODS,
  ELICITATION,
  isMcpApproval,
  REFUSED_CODE,
  REFUSED_MESSAGE,
  REFUSED_METHODS,
  replyFor,
} from '../../../../src/core/adapters/codex/asks.ts'
import { ELICITATION_CANCEL } from '../../../../src/core/adapters/codex/protocol.ts'
import { METHOD_NOT_FOUND } from '../../../../src/core/proc/jsonrpc.ts'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {readonly ('allow' | 'allow-session' | 'deny' | 'cancel')[]} answers
 * @param {{ mcpApprovals?: boolean }} [o] relay MCP tool approvals (a pass that may ask), as the adapter does
 */
export function dimFactoryResponder(answers, o = {}) {
  if (answers.length === 0) throw new Error('dimFactoryResponder: at least one answer')
  let next = 0
  return (frame) => {
    if (!isObject(frame) || typeof frame.method !== 'string' || !Object.hasOwn(frame, 'id')) return undefined
    const { id, method } = frame
    const params = isObject(frame.params) ? frame.params : {}
    if (ASK_METHODS.includes(method)) {
      const decision = answers[Math.min(next, answers.length - 1)]
      next++
      return { id, result: replyFor(method, decision, params) }
    }
    if (method === ELICITATION && o.mcpApprovals === true && isMcpApproval(params)) {
      const decision = answers[Math.min(next, answers.length - 1)]
      next++
      return { id, result: replyFor(ELICITATION, decision, params) }
    }
    if (method === ELICITATION) return { id, result: ELICITATION_CANCEL }
    if (REFUSED_METHODS.includes(method)) return { id, error: { code: REFUSED_CODE, message: REFUSED_MESSAGE } }
    return { id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } }
  }
}
