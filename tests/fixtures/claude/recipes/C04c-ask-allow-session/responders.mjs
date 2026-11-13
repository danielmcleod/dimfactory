// First can_use_tool: allow-session (suggestions -> destination 'session', setMode dropped). Later asks: allow.
let first = true
export default (frame) => {
  if (frame.type !== 'control_request' || frame.request?.subtype !== 'can_use_tool') return undefined
  const r = frame.request
  const response = { behavior: 'allow', updatedInput: r.input }
  if (first) {
    first = false
    response.updatedPermissions = (r.permission_suggestions ?? [])
      .filter((s) => s.type !== 'setMode')
      .map((s) => ({ ...s, destination: 'session' }))
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }
}
