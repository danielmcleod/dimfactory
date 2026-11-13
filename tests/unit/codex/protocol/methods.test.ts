// protocol.ts against the committed 0.160 schema (the probe: required methods → the exec
// route when one is missing; optional ones downgrade a capability; the approvals table; cumulative usage).
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMITTED_BUNDLE, definitionRef, validate } from '../../../../scripts/codex-fixture-check.mjs'
import { contentHash } from '../../../../scripts/gen-codex-types.mjs'
import type { OptionalCapability } from '../../../../src/core/adapters/codex/protocol.ts'
import {
  APPROVAL_DECISIONS,
  CODEX_PROTOCOL_CLI_VERSION,
  CODEX_PROTOCOL_FOLDER,
  ELICITATION_CANCEL,
  METHODS,
  NEVER_SENT_DECISIONS,
  OPTIONAL_CAPABILITIES,
  REQUIRED_METHODS,
  WATCHED_SHAPES,
  breakdownFromExecUsage,
  checkProtocol,
  isCollaborationModeRejected,
  isUnknownMethodError,
  methodSetFromSchema,
  permissionsReply,
  shapeProblems,
  usageFromTokenBreakdown,
} from '../../../../src/core/adapters/codex/protocol.ts'

type Json = Record<string, unknown>
const SRC = fileURLToPath(new URL('../../../../src/', import.meta.url))
const FOLDER = join(SRC, 'core', 'adapters', 'codex', 'protocol', CODEX_PROTOCOL_FOLDER)
const bundleText = readFileSync(COMMITTED_BUNDLE, 'utf8')
const fresh = (): Json => JSON.parse(bundleText) as Json
const bundle = fresh()
const set = methodSetFromSchema(bundle)

const defs = (b: Json): Json => b['definitions'] as Json
const def = (b: Json, name: string): Json => (defs(b)[name] ?? (defs(b)['v2'] as Json)[name]) as Json
const ROOT_OF = {
  clientRequests: 'ClientRequest',
  clientNotifications: 'ClientNotification',
  serverRequests: 'ServerRequest',
  serverNotifications: 'ServerNotification',
} as const

/** A copy of the bundle without `method` in its root union. */
function withoutMethod(key: keyof typeof ROOT_OF, method: string): Json {
  const b = fresh()
  const root = def(b, ROOT_OF[key])
  root['oneOf'] = (root['oneOf'] as Json[]).filter((v) => {
    const m = (v['properties'] as Json)['method'] as Json
    return !(m['enum'] as unknown[]).includes(method)
  })
  return b
}

describe('the method table (protocol.ts METHODS) matches the 0.160 schema', () => {
  it.each(METHODS.map((m) => [m.method, m] as const))('%s is in the schema with its types', (_name, m) => {
    expect(set[m.set].has(m.method)).toBe(true)
    if (m.params !== null) expect(definitionRef(bundle, m.params)).toBeDefined()
    if (m.result !== undefined && m.result !== null) expect(definitionRef(bundle, m.result)).toBeDefined()
  })

  it('marks experimental exactly the methods the stable schema lacks (methods.json)', () => {
    const inventory = JSON.parse(readFileSync(join(FOLDER, 'methods.json'), 'utf8')) as Record<
      string,
      { method: string; experimental: boolean }[]
    >
    for (const m of METHODS) {
      const row = inventory[m.set]!.find((r) => r.method === m.method)
      expect(row, m.method).toBeDefined()
      expect(row!.experimental, m.method).toBe(m.experimental === true)
    }
  })

  it('requires exactly the required-method list', () => {
    expect(REQUIRED_METHODS.map((r) => r.method).sort()).toEqual(
      [
        'initialize',
        'thread/start',
        'thread/resume',
        'turn/start',
        'turn/interrupt',
        'item/agentMessage/delta',
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'turn/completed',
      ].sort(),
    )
  })

  it('downgrades exactly the optional capabilities', () => {
    expect(Object.keys(OPTIONAL_CAPABILITIES).sort()).toEqual(
      ['collaborationMode', 'modelList', 'tokenUsage', 'windowsSandbox'].sort(),
    )
  })

  it('the committed schema: app-server route, every capability, no shape problem', () => {
    expect(checkProtocol(bundle)).toEqual({
      transport: 'codex-app-server',
      missingRequired: [],
      capabilities: { modelList: true, collaborationMode: true, windowsSandbox: true, tokenUsage: true },
      missingOptional: [],
      shapeProblems: [],
    })
  })

  it.each(REQUIRED_METHODS.map((r) => [r.method, r.set] as const))(
    'without %s the probe routes to exec',
    (method, key) => {
      const r = checkProtocol(withoutMethod(key, method))
      expect(r.transport).toBe('codex-exec')
      expect(r.missingRequired).toEqual([method])
    },
  )

  it.each(
    Object.entries(OPTIONAL_CAPABILITIES) as [
      OptionalCapability,
      (typeof OPTIONAL_CAPABILITIES)[OptionalCapability],
    ][],
  )('without %s only that capability is downgraded', (cap, where) => {
    let b: Json
    if (where.kind === 'method') b = withoutMethod(where.set, where.method)
    else {
      b = fresh()
      delete (def(b, where.type)['properties'] as Json)[where.field]
    }
    const r = checkProtocol(b)
    expect(r.transport).toBe('codex-app-server')
    expect(r.missingOptional).toEqual([cap])
    expect(r.capabilities[cap]).toBe(false)
  })

  it('a malformed bundle is the exec route with every required method missing', () => {
    for (const b of [null, {}, { definitions: 'x' }]) {
      const r = checkProtocol(b)
      expect(r.transport).toBe('codex-exec')
      expect(r.missingRequired).toHaveLength(REQUIRED_METHODS.length)
    }
  })
})

describe('watched shapes (the drift the probe and the weekly diff report)', () => {
  it('every watched type exists with its properties and values', () => {
    for (const [type, shape] of Object.entries(WATCHED_SHAPES)) {
      expect(set.definition(type), type).toBeDefined()
      for (const p of shape.props ?? []) expect(set.fieldsOf(type), `${type}.${p}`).toContain(p)
      for (const v of shape.values ?? []) expect(set.valuesOf(type), `${type} ${v}`).toContain(v)
    }
  })

  it('a removed property Dim Factory sends breaks', () => {
    const b = fresh()
    delete (def(b, 'ThreadStartParams')['properties'] as Json)['approvalsReviewer']
    expect(shapeProblems(methodSetFromSchema(b))).toEqual([
      'ThreadStartParams.approvalsReviewer: property removed',
    ])
  })

  it('a new required property breaks a type Dim Factory sends, not one it only reads', () => {
    const b = fresh()
    const turnStart = def(b, 'TurnStartParams')
    ;(turnStart['properties'] as Json)['mustSend'] = { type: 'string' }
    turnStart['required'] = [...((turnStart['required'] as string[] | undefined) ?? []), 'mustSend']
    const usage = def(b, 'TokenUsageBreakdown')
    ;(usage['properties'] as Json)['newCounter'] = { type: 'integer' }
    usage['required'] = [...(usage['required'] as string[]), 'newCounter']
    expect(shapeProblems(methodSetFromSchema(b))).toEqual(['TurnStartParams.mustSend: new required property'])
  })

  it('a removed enum value breaks (sent or read)', () => {
    const b = fresh()
    const mode = def(b, 'SandboxMode')
    mode['enum'] = (mode['enum'] as string[]).filter((v) => v !== 'read-only')
    const readiness = def(b, 'WindowsSandboxReadiness')
    readiness['enum'] = (readiness['enum'] as string[]).filter((v) => v !== 'notConfigured')
    expect(shapeProblems(methodSetFromSchema(b))).toEqual([
      'SandboxMode: value "read-only" removed',
      'WindowsSandboxReadiness: value "notConfigured" removed',
    ])
  })
})

describe('JSON-RPC error forms', () => {
  it("an unknown method: -32601, or 0.160 serde's -32600 unknown variant", () => {
    expect(isUnknownMethodError({ code: -32601, message: 'Method not found' })).toBe(true)
    expect(
      isUnknownMethodError({
        code: -32600,
        message: 'Invalid request: unknown variant `windowsSandbox/readiness`, expected one of `initialize`',
      }),
    ).toBe(true)
    expect(
      isUnknownMethodError({ code: -32600, message: 'Invalid request: missing field `clientInfo`' }),
    ).toBe(false)
    expect(isUnknownMethodError({ code: -32602, message: 'unknown variant `x`' })).toBe(false)
  })

  it('collaborationMode refused: -32602, or a -32600 that names it', () => {
    expect(isCollaborationModeRejected({ code: -32602, message: 'Invalid params' })).toBe(true)
    expect(
      isCollaborationModeRejected({ code: -32600, message: 'collaborationMode requires experimentalApi' }),
    ).toBe(true)
    expect(isCollaborationModeRejected({ code: -32600, message: 'thread not found' })).toBe(false)
    expect(isCollaborationModeRejected({ code: -32001, message: 'overloaded' })).toBe(false)
  })
})

describe('approvals (the approvals table)', () => {
  it('maps allow / allow-session / deny / cancel exactly', () => {
    expect(APPROVAL_DECISIONS).toEqual({
      allow: 'accept',
      'allow-session': 'acceptForSession',
      deny: 'decline',
      cancel: 'cancel',
    })
  })

  it('never sends a decision that persists rules', () => {
    for (const never of NEVER_SENT_DECISIONS) expect(Object.values(APPROVAL_DECISIONS)).not.toContain(never)
    expect(NEVER_SENT_DECISIONS).toContain('acceptWithExecpolicyAmendment')
  })

  it('every reply is valid for both approval kinds', () => {
    for (const decision of Object.values(APPROVAL_DECISIONS)) {
      for (const type of ['CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse']) {
        expect(
          validate(bundle, { $ref: definitionRef(bundle, type) }, { decision }),
          `${type} ${decision}`,
        ).toEqual([])
      }
    }
  })

  it('permissions: deny grants nothing; allow grants what was asked, per turn or session', () => {
    const asked = { network: { enabled: true }, fileSystem: null }
    expect(permissionsReply('deny', asked)).toEqual({ permissions: {} })
    expect(permissionsReply('cancel', asked)).toEqual({ permissions: {} })
    expect(permissionsReply('allow', asked)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    })
    expect(permissionsReply('allow-session', asked)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    })
    const ref = { $ref: definitionRef(bundle, 'PermissionsRequestApprovalResponse') }
    for (const d of ['allow', 'allow-session', 'deny'] as const)
      expect(validate(bundle, ref, permissionsReply(d, asked))).toEqual([])
  })

  it('MCP elicitations are cancelled with a valid reply', () => {
    expect(ELICITATION_CANCEL).toEqual({ action: 'cancel', content: null, _meta: null })
    expect(
      validate(
        bundle,
        { $ref: definitionRef(bundle, 'McpServerElicitationRequestResponse') },
        ELICITATION_CANCEL,
      ),
    ).toEqual([])
  })
})

describe('usage (cumulative totals → Dim Factory Usage)', () => {
  it('cached input comes off input; reasoning is informational; cache writes are their own field', () => {
    expect(
      usageFromTokenBreakdown({
        inputTokens: 18432,
        cachedInputTokens: 12288,
        cacheWriteInputTokens: 512,
        outputTokens: 612,
        reasoningOutputTokens: 256,
      }),
    ).toEqual({ input: 6144, output: 612, cacheRead: 12288, cacheWrite: 512, reasoning: 256 })
  })

  it('never negative, never NaN', () => {
    expect(
      usageFromTokenBreakdown({
        inputTokens: 10,
        cachedInputTokens: 50,
        outputTokens: Number.NaN,
        reasoningOutputTokens: -3,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 50, cacheWrite: 0, reasoning: 0 })
  })

  it('exec turn.completed.usage (snake_case, cache writes possibly absent)', () => {
    expect(
      breakdownFromExecUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 7,
        reasoning_output_tokens: 3,
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 7,
      reasoningOutputTokens: 3,
    })
  })
})

describe('the generated folder', () => {
  const meta = JSON.parse(readFileSync(join(FOLDER, 'meta.json'), 'utf8')) as Json

  it('is what gen-codex-types wrote (meta.json hash), from the recorded CLI', () => {
    expect(meta['folder']).toBe(CODEX_PROTOCOL_FOLDER)
    expect(meta['cliVersion']).toBe(CODEX_PROTOCOL_CLI_VERSION)
    expect(meta['sha256']).toBe(contentHash(FOLDER))
  })

  it('every TypeScript file is generated (nobody edited one by hand)', () => {
    const files = readdirSync(FOLDER, { withFileTypes: true, recursive: true }).filter(
      (e) => e.isFile() && e.name.endsWith('.ts'),
    )
    expect(files.length).toBeGreaterThan(500)
    for (const f of files) {
      const text = readFileSync(join(f.parentPath, f.name), 'utf8')
      expect(text.startsWith('// GENERATED CODE! DO NOT MODIFY BY HAND!'), f.name).toBe(true)
    }
  })

  it('is only ever imported for types', () => {
    const offenders: string[] = []
    const scan = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (p !== join(SRC, 'core', 'adapters', 'codex', 'protocol')) scan(p)
          continue
        }
        if (!/\.tsx?$/.test(e.name)) continue
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/^(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
          if (!/protocol\/v\d+\.\d+\.\d+\//.test(m[1]!)) continue
          if (!/^(?:import|export)\s+type\b/.test(m[0]))
            offenders.push(`${relative(SRC, p)}: ${m[0].split('\n')[0]}`)
        }
        if (/import\(\s*['"][^'"]*protocol\/v\d+\.\d+\.\d+\//.test(text)) {
          // `import('…')` types are fine; a dynamic import at run time is not.
          for (const m of text.matchAll(/(?<!typeof\s)\bawait\s+import\(\s*['"][^'"]*protocol\/v\d/g))
            offenders.push(`${relative(SRC, p)}: ${m[0]}`)
        }
      }
    }
    scan(SRC)
    expect(offenders).toEqual([])
  })
})
