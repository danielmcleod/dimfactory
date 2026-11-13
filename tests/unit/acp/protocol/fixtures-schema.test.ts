// Every Gemini fixture frame against the pinned ACP schema (the fixtures are synthesized
// from schema v1.25.0): each host request and notification is valid for its method on the agent side, each
// agent request and notification for its method on the client side, each response for the result of the request it
// answers. Gemini CLI 0.62's `models` field is outside the pinned schema and allowed (no additionalProperties: false).
// The checker itself is shown to refuse frames the protocol refuses.
import { describe, expect, it } from 'vitest'
import { checkAcpRecording } from './acp-schema.ts'
import { fixtureNames, loadFixture } from './fixtures.ts'

describe('Gemini fixtures are valid ACP v1.25.0', () => {
  it.each(fixtureNames())('%s', (name) => {
    expect(checkAcpRecording(loadFixture(name).text)).toEqual([])
  })
})

describe('the checker refuses what the protocol refuses', () => {
  const g04 = loadFixture('G04-permission-allow-once').text
  /** Replace inside the double-encoded `line` strings of the recording. */
  const edit = (text: string, from: string, to: string): string => {
    const enc = (s: string): string => JSON.stringify(s).slice(1, -1)
    expect(text).toContain(enc(from))
    return text.replace(enc(from), enc(to))
  }

  it('a permission outcome that is not one of the two', () => {
    const bad = edit(g04, '"outcome":"selected"', '"outcome":"approved"')
    expect(checkAcpRecording(bad).join('\n')).toMatch(/session\/request_permission/)
  })

  it('a host frame without the JSON-RPC 2.0 header', () => {
    const bad = edit(g04, '{"jsonrpc":"2.0","id":1,"method":"initialize"', '{"id":1,"method":"initialize"')
    expect(checkAcpRecording(bad)).toEqual([expect.stringMatching(/no "jsonrpc":"2.0"/)])
  })

  it('a prompt without its session', () => {
    const bad = edit(
      g04,
      '"method":"session/prompt","params":{"sessionId"',
      '"method":"session/prompt","params":{"session"',
    )
    expect(checkAcpRecording(bad).join('\n')).toMatch(/sessionId: required/)
  })

  it('a tool kind the protocol does not have', () => {
    const bad = edit(g04, '"kind":"execute"', '"kind":"shell"')
    expect(checkAcpRecording(bad).join('\n')).toMatch(/session\/update/)
  })

  it('a method on the wrong side (the host asking the agent for permission)', () => {
    const lines = g04.split('\n')
    const stray = JSON.stringify({
      t: 0,
      dir: 'in',
      line: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'session/request_permission', params: {} }),
    })
    expect(checkAcpRecording([...lines.slice(0, 3), stray, ...lines.slice(3)].join('\n'))).toEqual([
      expect.stringMatching(/not handled by the agent/),
    ])
  })

  it('a reply to an id nobody asked with', () => {
    const lines = g04.split('\n')
    const stray = JSON.stringify({
      t: 0,
      dir: 'in',
      line: JSON.stringify({ jsonrpc: '2.0', id: 77, result: {} }),
    })
    expect(checkAcpRecording([...lines.slice(0, 3), stray, ...lines.slice(3)].join('\n'))).toEqual([
      expect.stringMatching(/answers an id no request of the other side used/),
    ])
  })
})
