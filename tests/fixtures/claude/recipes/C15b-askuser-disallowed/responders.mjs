// C15b (same rules as C15a): answer can_use_tool the way the Claude adapter would on an edit pass (src/core/adapters/claude/asks.ts
// autoAnswerFor): an ask that requires user interaction (AskUserQuestion) gets the adapter's own "unsupported" deny
// with no interrupt; any other ask is allowed as a user would (echoing the input).
const UNSUPPORTED_ASK_MESSAGE =
  'This tool needs an interactive prompt that Dim Factory cannot show. Continue without it.'

export default function respond(frame) {
  if (frame.type !== 'control_request' || frame.request?.subtype !== 'can_use_tool') return undefined
  const req = frame.request
  const response =
    req.requires_user_interaction === true
      ? { behavior: 'deny', message: UNSUPPORTED_ASK_MESSAGE }
      : { behavior: 'allow', updatedInput: req.input }
  return { type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }
}
