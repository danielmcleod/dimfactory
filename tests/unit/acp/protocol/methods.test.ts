// protocol.ts against the pinned ACP schema (required and optional methods; the JSON-RPC header
// '2.0'): the vendored files are the release's bytes (one documented escape edit), every method
// of the table is the schema's own on the right side, and every frame the wire builders make is valid.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACP_CLIENT_INFO,
  ACP_METHODS,
  ACP_PROTOCOL_FOLDER,
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_FILES,
  ACP_SCHEMA_TAG,
  ACP_SCHEMA_VERSION,
  CANCELLED_OUTCOME,
  JSONRPC_HEADER,
  NEVER_SENT_METHODS,
  OPTIONAL_ACP_METHODS,
  REQUIRED_ACP_METHODS,
  acpMethod,
  cancelParams,
  initializeParams,
  loadSessionParams,
  newSessionParams,
  promptParams,
  resumeSessionParams,
  selectedOutcome,
  setModeParams,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import type {
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  RequestPermissionResponse,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import { STABLE, UNSTABLE, checkDef, schemaMethods } from './acp-schema.ts'
import { ACP_PROTOCOL_DIR } from './fixtures.ts'
import type { Json } from './fixtures.ts'

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const EM_DASH = String.fromCharCode(0x2014)
const ESCAPED = `${String.fromCharCode(92)}u2014`

describe('the vendored schema (protocol/v1.25.0)', () => {
  it('names the pinned release', () => {
    expect(ACP_SCHEMA_VERSION).toBe('1.25.0')
    expect(ACP_SCHEMA_TAG).toBe(`schema-v${ACP_SCHEMA_VERSION}`)
    expect(ACP_PROTOCOL_FOLDER).toBe(`v${ACP_SCHEMA_VERSION}`)
    expect(ACP_PROTOCOL_DIR.replace(/\\/g, '/')).toMatch(new RegExp(`/protocol/${ACP_PROTOCOL_FOLDER}/$`))
    expect(ACP_PROTOCOL_VERSION).toBe(1)
    expect(JSONRPC_HEADER).toBe('2.0')
    const readme = readFileSync(join(ACP_PROTOCOL_DIR, 'README.md'), 'utf8')
    expect(readme).toContain('https://github.com/agentclientprotocol/agent-client-protocol')
    expect(readme).toContain('schema-v1.25.0')
    expect(readFileSync(join(ACP_PROTOCOL_DIR, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/)
  })

  it.each(Object.entries(ACP_SCHEMA_FILES))('%s is the committed bytes', (file, pin) => {
    expect(sha256(readFileSync(join(ACP_PROTOCOL_DIR, file)))).toBe(pin.committed)
  })

  it.each(Object.entries(ACP_SCHEMA_FILES))(
    '%s gives the release bytes back (the escape edit undone)',
    (file, pin) => {
      const text = readFileSync(join(ACP_PROTOCOL_DIR, file), 'utf8')
      // The only edit: U+2014 written as the JSON escape (the UI-copy guard reads every .json under src/ as text).
      expect(text.includes(EM_DASH)).toBe(false)
      expect(sha256(text.split(ESCAPED).join(EM_DASH))).toBe(pin.upstream)
      if (file.endsWith('.json')) expect(JSON.parse(text)).toBeTypeOf('object')
    },
  )

  it('every file in the README table is pinned', () => {
    const readme = readFileSync(join(ACP_PROTOCOL_DIR, 'README.md'), 'utf8')
    for (const [file, pin] of Object.entries(ACP_SCHEMA_FILES)) {
      expect(readme).toContain(`\`${file}\``)
      expect(readme).toContain(pin.upstream)
    }
  })
})

describe('the method table (protocol.ts ACP_METHODS)', () => {
  const meta = JSON.parse(readFileSync(join(ACP_PROTOCOL_DIR, 'meta.json'), 'utf8')) as Record<string, Json>
  const sides: Record<string, string> = {}
  for (const [group, side] of [
    ['agentMethods', 'agent'],
    ['clientMethods', 'client'],
    ['protocolMethods', 'protocol'],
  ] as const)
    for (const m of Object.values(meta[group] ?? {})) sides[String(m)] = side

  it("the base's required and optional methods", () => {
    expect([...REQUIRED_ACP_METHODS].sort()).toEqual(
      [
        'initialize',
        'session/new',
        'session/prompt',
        'session/cancel',
        'session/update',
        'session/request_permission',
      ].sort(),
    )
    for (const m of ['session/load', 'session/resume', 'session/set_mode', 'session/set_model'])
      expect(OPTIONAL_ACP_METHODS).toContain(m)
    // Dim Factory never logs in for the user: it never calls authenticate.
    expect(NEVER_SENT_METHODS).toEqual(['authenticate', 'logout'])
  })

  it.each(ACP_METHODS.filter((m) => m.stable).map((m) => [m.method, m] as const))(
    '%s is the schema’s own, on its side, with its definitions',
    (method, entry) => {
      expect(sides[method]).toBe(entry.side)
      const s = schemaMethods(STABLE).get(method)
      expect(s?.side).toBe(entry.side)
      if (entry.kind === 'request') {
        expect(entry.params).toBe(s?.request)
        if (entry.result !== null) expect(entry.result).toBe(s?.response)
      } else {
        expect(entry.params).toBe(s?.notification)
      }
    },
  )

  it('session/set_model is the one method outside the pinned schema (Gemini CLI 0.62 still serves it)', () => {
    const unpinned = ACP_METHODS.filter((m) => !m.stable).map((m) => m.method)
    expect(unpinned).toEqual(['session/set_model'])
    expect(sides['session/set_model']).toBeUndefined()
    expect(schemaMethods(UNSTABLE).get('session/set_model')).toBeUndefined()
    expect(acpMethod('session/set_model')).toMatchObject({ params: null, result: null })
  })

  it('every client-side request the agent may make is in the table (refused unless Dim Factory reads it)', () => {
    for (const [method, side] of Object.entries(sides)) {
      if (side !== 'client') continue
      const kind = schemaMethods(STABLE).get(method)?.request !== undefined ? 'request' : 'notification'
      if (kind === 'request') expect(acpMethod(method), method).toBeDefined()
    }
    for (const m of ACP_METHODS.filter((x) => x.role === 'refused')) expect(m.side).toBe('client')
  })
})

describe('the wire builders make valid frames', () => {
  const cwd = 'C:\\work\\sandbox'
  const sid = '7c4e9a12-3b5d-4f60-8a1b-2c3d4e5f6000'

  it('initialize: protocol 1, fs and terminal false, Dim Factory named', () => {
    const p: InitializeRequest = initializeParams()
    expect(p).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dim-factory', title: 'Dim Factory', version: ACP_CLIENT_INFO.version },
    })
    expect(checkDef('InitializeRequest', p)).toEqual([])
    // A fresh object each time: a caller that mutates one never changes the next handshake.
    expect(initializeParams()).not.toBe(p)
    expect(initializeParams().clientInfo).not.toBe(p.clientInfo)
  })

  it('sessions: never an MCP server of Dim Factory’s own; the same cwd on new, load and resume', () => {
    const n: NewSessionRequest = newSessionParams(cwd)
    expect(n).toEqual({ cwd, mcpServers: [] })
    expect(checkDef('NewSessionRequest', n)).toEqual([])
    expect(checkDef('LoadSessionRequest', loadSessionParams(sid, cwd))).toEqual([])
    expect(loadSessionParams(sid, cwd)).toEqual({ sessionId: sid, cwd, mcpServers: [] })
    expect(checkDef('ResumeSessionRequest', resumeSessionParams(sid, cwd))).toEqual([])
    expect(checkDef('SetSessionModeRequest', setModeParams(sid, 'autoEdit'))).toEqual([])
    expect(checkDef('CancelNotification', cancelParams(sid))).toEqual([])
  })

  it('the prompt is one text block over JSON-RPC', () => {
    const text = 'line one\nline two "quoted"'
    const p: PromptRequest = promptParams(sid, text)
    expect(p).toEqual({ sessionId: sid, prompt: [{ type: 'text', text }] })
    expect(checkDef('PromptRequest', p)).toEqual([])
  })

  it('permission answers: a selected option, or cancelled', () => {
    const selected: RequestPermissionResponse = selectedOutcome('proceed_once')
    expect(checkDef('RequestPermissionResponse', selected)).toEqual([])
    expect(checkDef('RequestPermissionResponse', CANCELLED_OUTCOME)).toEqual([])
    expect(CANCELLED_OUTCOME).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(Object.isFrozen(CANCELLED_OUTCOME)).toBe(true)
  })

  it('the validator refuses what the schema refuses', () => {
    expect(checkDef('PromptRequest', { sessionId: sid })).toEqual(
      expect.arrayContaining([expect.stringMatching(/prompt: required/)]),
    )
    expect(checkDef('RequestPermissionResponse', { outcome: { outcome: 'approved' } })).not.toEqual([])
    expect(checkDef('InitializeRequest', { protocolVersion: '1' })).not.toEqual([])
  })
})
