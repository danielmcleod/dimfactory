// Codex argv and JSON-RPC params per pass and mode (the mode mapping: read-only passes
// {sandbox:'read-only', approvalPolicy:'never', ephemeral:true}; autoedit {workspace-write, on-request,
// approvalsReviewer:'user'}; full {danger-full-access, never}; "exec fallback" argv; "Local preset"; X17).
import { describe, expect, it } from 'vitest'
import {
  appServerArgv,
  applyFlagMap,
  codexEnv,
  ephemeralFor,
  execArgv,
  extraArgsProblem,
  flagMapProblem,
  localProviderArgs,
  sandboxFor,
} from '@core/adapters/codex/launch.ts'
import {
  approvalReply,
  initializeParams,
  permissionsReply,
  planCollaboration,
  strictOutputSchema,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from '@core/adapters/codex/params.ts'
import { NEVER_SENT_DECISIONS } from '@core/adapters/codex/protocol.ts'
import { refreshJsonSchema } from '@core/catalog/refresh.ts'
import { presetForModel } from '@core/config/local-presets.ts'
import type { StartStep } from '@core/adapters/types.ts'
import type { Mode } from '@shared/run.ts'
import type { LocalPreset } from '@shared/vendors.ts'

const CWD = 'C:\\work\\proj'
const STEPS: StartStep[] = ['plan', 'implement', 'review', 'critic', 'fix', 'heal', 'catalog']
const MODES: Mode[] = ['readonly', 'autoedit', 'full']
const READ_ONLY: StartStep[] = ['plan', 'review', 'critic', 'heal', 'catalog']
const PRESET: LocalPreset = {
  id: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-coder:30b',
  apiKeyEnv: 'OLLAMA_KEY',
}

describe('handshake', () => {
  it('initialize names dim-factory and asks for the experimental API only for a native plan', () => {
    expect(initializeParams(true)).toEqual({
      clientInfo: { name: 'dim-factory', title: null, version: expect.any(String) as string },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    expect(initializeParams(false).capabilities).toEqual({
      experimentalApi: false,
      requestAttestation: false,
    })
  })

  it('one private app-server per pass: root -c extraArgs first, never the daemon', () => {
    expect(appServerArgv({})).toEqual(['app-server', '--listen', 'stdio://'])
    expect(appServerArgv({ extraArgs: ['-c', 'model_reasoning_effort="high"'] })).toEqual([
      '-c',
      'model_reasoning_effort="high"',
      'app-server',
      '--listen',
      'stdio://',
    ])
    expect(appServerArgv({ flagMap: { '--listen': '--listen-on' } })).toEqual([
      'app-server',
      '--listen-on',
      'stdio://',
    ])
  })
})

describe('thread/start per pass and mode', () => {
  for (const step of STEPS) {
    for (const mode of MODES) {
      it(`${step} · ${mode}`, () => {
        const p = threadStartParams({ step, mode, cwd: CWD, model: null })
        const readOnly = READ_ONLY.includes(step) || mode === 'readonly'
        expect(p.cwd).toBe(CWD)
        expect(p.approvalsReviewer).toBe('user')
        expect(p).not.toHaveProperty('model')
        if (readOnly) {
          expect(p).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
        } else if (mode === 'full') {
          expect(p).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
        } else {
          expect(p).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
        }
        // Read-only steps are ephemeral; Implement and Fix never are (their thread is resumed later).
        expect(p.ephemeral).toBe(READ_ONLY.includes(step))
        // Read-only steps (None by default) also switch off Codex's apps, plugins and hooks.
        const featuresOff = { 'features.apps': false, 'features.plugins': false, 'features.hooks': false }
        if (step === 'catalog') expect(p.config).toEqual({ web_search: 'live', ...featuresOff })
        else if (READ_ONLY.includes(step)) expect(p.config).toEqual(featuresOff)
        else expect(p).not.toHaveProperty('config')
      })
    }
  }

  it('model, developerInstructions on new threads only', () => {
    const p = threadStartParams({
      step: 'implement',
      mode: 'autoedit',
      cwd: CWD,
      model: 'gpt-5.6',
      systemAppend: 'Extra',
    })
    expect(p).toMatchObject({ model: 'gpt-5.6', developerInstructions: 'Extra' })
    const r = threadResumeParams('thr-1', {
      step: 'fix',
      mode: 'autoedit',
      cwd: CWD,
      model: 'gpt-5.6',
      systemAppend: 'Extra',
    })
    expect(r).toEqual({
      threadId: 'thr-1',
      excludeTurns: true,
      cwd: CWD,
      model: 'gpt-5.6',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    })
    expect(r).not.toHaveProperty('ephemeral')
    expect(r).not.toHaveProperty('developerInstructions')
  })

  it('a local preset: dim_factory_local over the Responses API, its model, never --oss', () => {
    const p = threadStartParams({
      step: 'implement',
      mode: 'autoedit',
      cwd: CWD,
      model: null,
      local: PRESET,
    })
    expect(p).toMatchObject({
      model: 'qwen3-coder:30b',
      modelProvider: 'dim_factory_local',
      config: {
        'model_providers.dim_factory_local': {
          name: 'Ollama',
          base_url: 'http://127.0.0.1:11434/v1',
          wire_api: 'responses',
          env_key: 'OLLAMA_KEY',
        },
      },
    })
    const args = localProviderArgs(PRESET)
    expect(args).toEqual([
      '-c',
      'model_providers.dim_factory_local={name="Ollama",base_url="http://127.0.0.1:11434/v1",wire_api="responses",env_key="OLLAMA_KEY"}',
      '-c',
      'model_provider="dim_factory_local"',
    ])
  })

  it('a model the pass names runs on the local preset (both routes); none keeps the preset’s', () => {
    const p = threadStartParams({
      step: 'implement',
      mode: 'autoedit',
      cwd: CWD,
      model: 'llama3.3:70b',
      local: PRESET,
    })
    expect(p).toMatchObject({ model: 'llama3.3:70b', modelProvider: 'dim_factory_local' })
    const a = execArgv({
      step: 'implement',
      mode: 'autoedit',
      cwd: CWD,
      outFile: 'o',
      model: 'llama3.3:70b',
      local: PRESET,
    })
    expect(a[a.indexOf('-m') + 1]).toBe('llama3.3:70b')
    const b = execArgv({
      step: 'implement',
      mode: 'autoedit',
      cwd: CWD,
      outFile: 'o',
      model: null,
      local: PRESET,
    })
    expect(b[b.indexOf('-m') + 1]).toBe('qwen3-coder:30b')
    // The preset as the pass runs it: the pass's model, and no context window of the preset's own model.
    expect(presetForModel({ ...PRESET, contextWindow: 8192 }, 'llama3.3:70b')).toEqual({
      id: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.3:70b',
      apiKeyEnv: 'OLLAMA_KEY',
    })
    expect(presetForModel({ ...PRESET, contextWindow: 8192 }, null)).toEqual({
      ...PRESET,
      contextWindow: 8192,
    })
  })
})

describe('turn/start', () => {
  it('the prompt is the input text (never argv); native plan and X17 add their fields', () => {
    expect(turnStartParams({ threadId: 't', prompt: 'do it' })).toEqual({
      threadId: 't',
      input: [{ type: 'text', text: 'do it', text_elements: [] }],
    })
    const plan = turnStartParams({
      threadId: 't',
      prompt: 'p',
      collaborationMode: planCollaboration('gpt-5.6'),
    })
    expect(plan.collaborationMode).toEqual({
      mode: 'plan',
      settings: { model: 'gpt-5.6', reasoning_effort: null, developer_instructions: null },
    })
    const schema = { type: 'object' }
    expect(turnStartParams({ threadId: 't', prompt: 'p', outputSchema: schema }).outputSchema).toEqual(schema)
  })

  it('live X17: the outputSchema goes as strict structured outputs take it (every property required, optional ones nullable)', () => {
    // The live refusal: "'schema.properties.entries.items.required' is required to include every key in properties.
    // Missing 'aliases'." (400 invalid_json_schema, before any model call).
    const refresh = refreshJsonSchema(['codex'])
    const before = JSON.stringify(refresh)
    const strict = strictOutputSchema(refresh)
    expect(JSON.stringify(refresh)).toBe(before) // pure
    expect(strictOutputSchema(strict)).toEqual(strict) // idempotent
    expect(turnStartParams({ threadId: 't', prompt: 'p', outputSchema: refresh }).outputSchema).toEqual(
      strict,
    )
    const objects: Record<string, unknown>[] = []
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v !== null && typeof v === 'object') {
        const r = v as Record<string, unknown>
        if (r['properties'] !== undefined) objects.push(r)
        for (const [k, x] of Object.entries(r)) {
          expect(['minLength', 'maxLength', 'minItems', 'maxItems']).not.toContain(k)
          visit(x)
        }
      }
    }
    visit(strict)
    expect(objects.length).toBe(4) // the answer, an entry, a new model, an unverifiable model
    for (const o of objects) {
      expect(o['required']).toEqual(Object.keys(o['properties'] as object))
      expect(o['additionalProperties']).toBe(false)
    }
    const entry = ((strict['properties'] as Record<string, Record<string, unknown>>)['entries']!['items'] ??
      {}) as Record<string, Record<string, Record<string, unknown>>>
    expect(entry['properties']!['aliases']!['type']).toEqual(['array', 'null'])
    expect(entry['properties']!['deprecated']!['type']).toEqual(['boolean', 'null'])
    // What was required stays as it was (no null where the parser needs a value).
    expect(entry['properties']!['inputPerMTok']!['type']).toBe('number')
    expect(entry['properties']!['vendor']).toEqual({
      type: 'string',
      enum: ['codex'],
      description: 'Dim Factory vendor id',
    })
    // An optional enum takes null in its values too; a property without a type becomes anyOf with null.
    expect(
      strictOutputSchema({
        type: 'object',
        properties: { kind: { type: 'string', enum: ['a', 'b'] }, any: { description: 'x' } },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        kind: { type: ['string', 'null'], enum: ['a', 'b', null] },
        any: { anyOf: [{ description: 'x' }, { type: 'null' }] },
      },
      required: ['kind', 'any'],
      additionalProperties: false,
    })
  })
})

describe('approvals (the approvals table)', () => {
  it('allow/allow-session/deny/cancel map exactly; amendments are never sent', () => {
    expect(approvalReply('allow')).toEqual({ decision: 'accept' })
    expect(approvalReply('allow-session')).toEqual({ decision: 'acceptForSession' })
    expect(approvalReply('deny')).toEqual({ decision: 'decline' })
    expect(approvalReply('cancel')).toEqual({ decision: 'cancel' })
    const all = (['allow', 'allow-session', 'deny', 'cancel'] as const).map((d) =>
      JSON.stringify(approvalReply(d)),
    )
    for (const never of NEVER_SENT_DECISIONS) for (const r of all) expect(r).not.toContain(never)
  })

  it('permissions: deny is {permissions:{}}; allow grants what was asked, for the turn or the session', () => {
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
  })
})

describe('exec fallback argv', () => {
  const FORBIDDEN = ['--full-auto', '--approve-for-me', '--oss', '--local-provider', '--yolo']

  for (const step of STEPS) {
    for (const mode of MODES) {
      it(`${step} · ${mode}`, () => {
        const a = execArgv({ step, mode, cwd: CWD, outFile: 'C:\\t\\out.txt', model: 'gpt-5.6' })
        const { sandbox } = sandboxFor(step, mode)
        expect(a.slice(0, 11)).toEqual([
          'exec',
          '--json',
          '--color',
          'never',
          '--skip-git-repo-check',
          '--sandbox',
          sandbox,
          '--cd',
          CWD,
          '-c',
          'approvals_reviewer="user"',
        ])
        expect(a.at(-1)).toBe('-')
        expect(a).toContain('-o')
        for (const f of FORBIDDEN) expect(a).not.toContain(f)
        expect(a.includes('--ephemeral')).toBe(ephemeralFor(step))
        if (step === 'implement' || step === 'fix') expect(a).not.toContain('--ephemeral')
      })
    }
  }

  it('resume: every flag before `resume <UUID>`, the prompt from stdin last, never ephemeral', () => {
    const a = execArgv({
      step: 'fix',
      mode: 'autoedit',
      cwd: CWD,
      outFile: 'o',
      resumeId: '01900000-0000-7000-8000-000000000001',
      extraArgs: ['-c', 'x=1'],
    })
    expect(a.slice(0, 3)).toEqual(['-c', 'x=1', 'exec'])
    expect(a.slice(-3)).toEqual(['resume', '01900000-0000-7000-8000-000000000001', '-'])
    expect(a.indexOf('-o')).toBeLessThan(a.indexOf('resume'))
    expect(a.indexOf('--sandbox')).toBeLessThan(a.indexOf('resume'))
    expect(a).not.toContain('--ephemeral')
  })

  it('X17 on exec: web search live and the schema file', () => {
    const a = execArgv({ step: 'catalog', mode: 'readonly', cwd: CWD, outFile: 'o', schemaFile: 's.json' })
    expect(a).toEqual(
      expect.arrayContaining(['-c', 'web_search="live"', '--output-schema', 's.json', '--ephemeral']),
    )
  })

  it('a local preset passes its provider with -c, never --oss', () => {
    const a = execArgv({ step: 'implement', mode: 'autoedit', cwd: CWD, outFile: 'o', local: PRESET })
    expect(a).toEqual(
      expect.arrayContaining(['-m', 'qwen3-coder:30b', '-c', 'model_provider="dim_factory_local"']),
    )
    expect(a).not.toContain('--oss')
  })
})

describe('extraArgs and flagMap', () => {
  it('extraArgs are root -c overrides only, never a safety key or a flag', () => {
    expect(extraArgsProblem(['-c', 'model_verbosity="low"', '--config=tui.theme="x"'])).toBeUndefined()
    // Effort is a managed setting (the pass's Effort), so its -c key is refused like a managed flag.
    expect(extraArgsProblem(['-c', 'model_reasoning_effort="high"'])).toMatch(/effort is managed/)
    expect(extraArgsProblem(['--full-auto'])).toMatch(/widens/)
    expect(extraArgsProblem(['--sandbox', 'danger-full-access'])).toMatch(/manages/)
    expect(extraArgsProblem(['-c', 'sandbox_mode="danger-full-access"'])).toMatch(/sandbox/)
    expect(extraArgsProblem(['-c', 'approvals_reviewer="auto_review"'])).toMatch(/approvals/)
    expect(extraArgsProblem(['-c', 'model_providers.x={}'])).toMatch(/provider/)
    expect(extraArgsProblem(['-c'])).toMatch(/no key=value/)
    expect(extraArgsProblem(['-c', 'a=1\nb'])).toMatch(/newline/)
    expect(extraArgsProblem(['plain'])).toMatch(/overrides only/)
  })

  it('flagMap renames managed flags only, never onto a flag Codex already has', () => {
    expect(flagMapProblem({ '--sandbox': '--sandbox-mode' })).toBeUndefined()
    expect(flagMapProblem({ '--nope': '--x' })).toMatch(/not a flag Dim Factory manages/)
    expect(flagMapProblem({ '--sandbox': '--yolo' })).toMatch(/widens/)
    expect(flagMapProblem({ '--sandbox': '--profile' })).toMatch(/widens|already/)
    expect(flagMapProblem({ '--sandbox': '--model' })).toMatch(/manages/)
    expect(
      applyFlagMap(['--sandbox', 'read-only', '--cd=x'], { '--sandbox': '--sandbox-mode', '--cd': '--dir' }),
    ).toEqual(['--sandbox-mode', 'read-only', '--dir=x'])
  })
})

describe('child env', () => {
  it('CODEX_SANDBOX* removed, codex-path first on PATH, the vendor env last', () => {
    const env = codexEnv(
      {
        PATH: 'C:\\bin',
        CODEX_SANDBOX: 'seatbelt',
        CODEX_SANDBOX_NETWORK_DISABLED: '1',
        NODE_OPTIONS: '--x',
        KEEP: '1',
      },
      {
        path: 'C:\\bin',
        pathPrepend: ['C:\\codex-path'],
        vendorEnv: { CODEX_HOME: 'C:\\h' },
        platform: 'win32',
      },
    )
    expect(env['CODEX_SANDBOX']).toBeUndefined()
    expect(env['CODEX_SANDBOX_NETWORK_DISABLED']).toBeUndefined()
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['CODEX_HOME']).toBe('C:\\h')
    expect(env['KEEP']).toBe('1')
    const path = env['PATH'] ?? env['Path'] ?? ''
    expect(path.split(';')[0]).toBe('C:\\codex-path')
  })
})
