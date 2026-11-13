// support() and capabilities (the mode mapping and honest copy: Codex app-server, exec (fallback) and
// "Codex, Windows sandbox not ready" rows; first launch: Codex counts as ready only if
// support({mode:'autoedit'}) ≠ unsupported), and the probe's own checks (bin, version, auth, protocol, plan,
// winSandbox) as pure functions.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CodexFacts, WinSandboxState } from '@core/adapters/codex/capabilities.ts'
import {
  APP_SERVER_COPY,
  EXEC_COPY,
  PLAN_NATIVE_COPY,
  FULL_WITHOUT_WIN_SANDBOX,
  MCP_NOTE,
  WIN_SANDBOX_AUTOEDIT_COPY,
  WIN_SANDBOX_FULL_COPY,
  WIN_SANDBOX_READONLY_COPY,
  WIN_SANDBOX_UNCHECKED_COPY,
  WIN_SANDBOX_UNCHECKED_READONLY_COPY,
  codexCapabilities,
  codexSupport,
  defaultFacts,
  winSandboxReady,
} from '@core/adapters/codex/capabilities.ts'
import {
  authCheck,
  factsFrom,
  parseLoginStatus,
  planCheck,
  protocolCheck,
  toModelInfo,
  versionCheck,
  winSandboxCheck,
} from '@core/adapters/codex/probe.ts'
import { checkProtocol } from '@core/adapters/codex/protocol.ts'
import { threadPolicyProblem } from '@core/adapters/codex/appserver.ts'
import type { ReadinessNeed } from '@shared/vendors.ts'

const EM_DASH = String.fromCharCode(0x2014)
const need = (
  pass: ReadinessNeed['pass'],
  mode: ReadinessNeed['mode'],
  planNative = false,
): ReadinessNeed => ({
  pass,
  mode,
  planNative,
  trustFolder: false,
})
const facts = (o: Partial<CodexFacts> = {}): CodexFacts => ({ ...defaultFacts('linux'), ...o })
/** The committed 0.160 schema bundle (every method present: the app-server route). */
const committedBundle = (): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../src/core/adapters/codex/protocol/v0.160.0/schema/codex_app_server_protocol.schemas.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as unknown

describe('support(): the Codex mode rows', () => {
  it('app-server', () => {
    const f = facts()
    expect(codexSupport(need('implement', 'autoedit'), f)).toEqual({
      status: 'supported',
      copy: APP_SERVER_COPY.autoedit,
    })
    expect(codexSupport(need('implement', 'full'), f)).toEqual({
      status: 'supported',
      copy: APP_SERVER_COPY.full,
    })
    expect(codexSupport(need('review', 'autoedit'), f)).toEqual({
      status: 'supported',
      copy: APP_SERVER_COPY.readonly,
    })
    expect(codexSupport(need('plan', 'readonly', true), f)).toEqual({
      status: 'supported',
      copy: PLAN_NATIVE_COPY,
    })
    expect(APP_SERVER_COPY.autoedit).toMatch(/sandbox-gated/i)
  })

  it('exec fallback: autoedit degraded (no relay), plan emulated', () => {
    const f = facts({ route: 'exec', planNative: false })
    expect(codexSupport(need('implement', 'autoedit'), f)).toEqual({
      status: 'degraded',
      copy: EXEC_COPY.autoedit,
      reason: 'no-relay',
    })
    expect(codexSupport(need('plan', 'readonly', true), f)).toEqual({
      status: 'supported',
      copy: EXEC_COPY.readonly,
    })
    const caps = codexCapabilities(f)
    expect(caps).toMatchObject({
      planMode: 'emulated',
      askRelay: false,
      modelList: 'static',
      allowSession: 'app',
    })
  })

  it('Windows sandbox not ready: readonly degraded, autoedit UNSUPPORTED (never a silent downgrade), full unsupported until X11 is recorded', () => {
    for (const winSandbox of ['notConfigured', 'updateRequired', 'unavailable'] as const) {
      const f = facts({ winSandbox })
      expect(codexSupport(need('review', 'readonly'), f)).toMatchObject({
        status: 'degraded',
        copy: WIN_SANDBOX_READONLY_COPY,
      })
      const edit = codexSupport(need('implement', 'autoedit'), f)
      expect(edit.status).toBe('unsupported')
      expect(edit.reason).toBe(`winSandbox-${winSandbox}`)
      // Full is "supported if X11 confirms", and X11 is synthesized: full waits for the live recording.
      expect(FULL_WITHOUT_WIN_SANDBOX).toBe(false)
      expect(codexSupport(need('implement', 'full'), f)).toMatchObject({
        status: 'unsupported',
        copy: WIN_SANDBOX_FULL_COPY,
      })
    }
    expect(codexSupport(need('implement', 'autoedit'), facts({ winSandbox: 'notConfigured' })).copy).toBe(
      WIN_SANDBOX_AUTOEDIT_COPY,
    )
    // First launch: this machine (no sandbox) is not Codex-ready.
    expect(codexCapabilities(facts({ winSandbox: 'notConfigured' })).modes.autoedit.status).toBe(
      'unsupported',
    )
  })

  it('a win32 sandbox nobody confirmed (not probed, or no answer) is not ready for edits', () => {
    for (const f of [defaultFacts('win32'), facts({ winSandbox: 'unchecked' })]) {
      expect(winSandboxReady(f)).toBe(false)
      expect(codexSupport(need('implement', 'autoedit'), f)).toMatchObject({
        status: 'unsupported',
        copy: WIN_SANDBOX_UNCHECKED_COPY,
      })
      expect(codexSupport(need('implement', 'full'), f).status).toBe('unsupported')
      expect(codexSupport(need('review', 'readonly'), f)).toMatchObject({
        status: 'degraded',
        copy: WIN_SANDBOX_UNCHECKED_READONLY_COPY,
      })
    }
    // Off Windows there is no such sandbox to wait for; on Windows only `ready` lets an edit pass run.
    expect(codexSupport(need('implement', 'autoedit'), defaultFacts('linux')).status).toBe('supported')
    expect(codexSupport(need('implement', 'autoedit'), facts({ winSandbox: 'ready' })).status).toBe(
      'supported',
    )
  })

  it('the probe reads an error, a timeout or an unknown status as unchecked, never ready', () => {
    const schema = { check: checkProtocol(committedBundle()) }
    const handshake = (winSandbox?: WinSandboxState) => ({
      ok: true,
      ms: 1,
      models: [],
      unexpected: [],
      stderr: [],
      ...(winSandbox !== undefined ? { winSandbox } : {}),
    })
    expect(factsFrom({ schema, handshake: handshake('unchecked'), platform: 'win32' }).winSandbox).toBe(
      'unchecked',
    )
    expect(factsFrom({ schema, handshake: handshake(), platform: 'win32' }).winSandbox).toBe('unchecked')
    expect(factsFrom({ schema, handshake: undefined, platform: 'win32' }).winSandbox).toBe('unchecked')
    expect(factsFrom({ schema, handshake: handshake('ready'), platform: 'win32' }).winSandbox).toBe('ready')
    expect(factsFrom({ schema, handshake: handshake('unchecked'), platform: 'linux' }).winSandbox).toBe('n/a')
    const c = winSandboxCheck('unchecked', 1)
    expect(c).toMatchObject({ status: 'fail', blocking: false, category: 'sandbox_unavailable' })
    expect(c?.recovery.map((a) => a.kind)).toEqual(
      process.platform === 'win32' ? ['vendor_setup', 'shell_copy', 'switch_vendor'] : [],
    )
  })

  it('every read-only Codex copy says MCP servers still load (no --strict-mcp-config for Codex)', () => {
    const readOnly = [
      codexSupport(need('review', 'readonly'), facts()),
      codexSupport(need('critic', 'autoedit'), facts()),
      codexSupport(need('plan', 'readonly', true), facts()),
      codexSupport(need('catalog', 'readonly'), facts()),
      codexSupport(need('review', 'readonly'), facts({ route: 'exec' })),
      codexSupport(need('review', 'readonly'), facts({ winSandbox: 'notConfigured' })),
      codexSupport(need('review', 'readonly'), facts({ winSandbox: 'unchecked' })),
      codexSupport(need('heal', 'readonly'), defaultFacts('win32')),
    ]
    for (const s of readOnly) expect(s.copy.endsWith(` ${MCP_NOTE}`), s.copy).toBe(true)
    // Edit passes keep their own copy (the MCP servers there are the user's choice, as with Claude's Implement).
    expect(codexSupport(need('implement', 'autoedit'), facts()).copy).not.toContain(MCP_NOTE)
  })

  it('the sandbox check speaks plain words (no protocol names)', () => {
    for (const s of [
      'ready',
      'notConfigured',
      'updateRequired',
      'unavailable',
      'unchecked',
      'unknown',
    ] as const) {
      const c = winSandboxCheck(s, 1)
      expect(`${c?.title ?? ''} ${c?.detail ?? ''}`).not.toMatch(
        /windowsSandbox|readiness|notConfigured|updateRequired/,
      )
    }
  })

  it('copy has no em dash', () => {
    for (const f of [facts(), facts({ route: 'exec' }), facts({ winSandbox: 'notConfigured' })]) {
      for (const pass of ['plan', 'implement', 'review', 'fix', 'catalog'] as const)
        for (const mode of ['readonly', 'autoedit', 'full'] as const)
          expect(codexSupport(need(pass, mode, true), f).copy).not.toContain(EM_DASH)
    }
  })
})

describe('probe checks', () => {
  it('login status: the method only, never the key', () => {
    expect(parseLoginStatus({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT' })).toEqual({
      loggedIn: true,
      method: 'chatgpt',
    })
    expect(
      parseLoginStatus({ code: 0, stdout: '', stderr: 'Logged in using an API key - sk-proj-abc***xyz' }),
    ).toEqual({
      loggedIn: true,
      method: 'api_key',
    })
    expect(parseLoginStatus({ code: 1, stdout: '', stderr: 'WARNING: proceeding…\nNot logged in' })).toEqual({
      loggedIn: false,
    })
    const a = authCheck(
      { code: 0, stdout: '', stderr: 'Logged in using an API key - sk-proj-abc***xyz', timedOut: false },
      1,
    )
    expect(JSON.stringify(a)).not.toContain('sk-')
    expect(a).toMatchObject({ loggedIn: true, account: { method: 'api_key' }, check: { status: 'pass' } })
    const out = authCheck({ code: 1, stdout: '', stderr: 'Not logged in', timedOut: false }, 1)
    expect(out.check).toMatchObject({ status: 'fail', blocking: true, category: 'auth_required' })
    expect(out.check.recovery.find((r) => r.kind === 'shell_copy')).toMatchObject({ command: 'codex login' })
  })

  it('version: floor 0.147.0 fails below, 0.160.1 recommended, newer than tested warns (prerelease ignored)', () => {
    expect(versionCheck('0.146.9', 1)).toMatchObject({ status: 'fail', category: 'cli_version' })
    expect(versionCheck('0.147.0-alpha.6.5', 1).status).toBe('warn')
    // Live re-record: every live fixture was recorded with 0.160.1, now the recommendation.
    expect(versionCheck('0.160.0', 1)).toMatchObject({
      status: 'warn',
      title: 'Codex 0.160.0 works; 0.160.1 is recommended',
    })
    expect(versionCheck('0.160.1', 1).status).toBe('pass')
    expect(versionCheck('0.161.0', 1)).toMatchObject({
      status: 'warn',
      title: expect.stringMatching(/newer than tested/) as string,
    })
  })

  it('model/list rows: the slug as id, the display name as label, hidden ones left out', () => {
    expect(
      toModelInfo({
        id: 'gpt-5.6',
        model: 'gpt-5.6',
        displayName: 'GPT 5.6',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'high', description: '' },
        ],
      }),
    ).toEqual({ id: 'gpt-5.6', label: 'GPT 5.6', isDefault: true, efforts: ['low', 'high'], source: 'cli' })
    expect(toModelInfo({ id: 'x', model: 'x', hidden: true })).toBeUndefined()
  })

  it('winSandbox: ready passes; notConfigured fails without blocking and offers the setup, then the elevated command', () => {
    expect(winSandboxCheck('n/a', 1)).toBeUndefined()
    expect(winSandboxCheck('ready', 1)).toMatchObject({ id: 'vendor.codex.winSandbox', status: 'pass' })
    const c = winSandboxCheck('notConfigured', 1)!
    expect(c).toMatchObject({ status: 'fail', blocking: false, category: 'sandbox_unavailable' })
    if (process.platform === 'win32') {
      expect(c.recovery.map((r) => r.kind)).toEqual(['vendor_setup', 'shell_copy', 'switch_vendor'])
      expect(c.recovery[0]).toMatchObject({
        vendor: 'codex',
        call: 'windowsSandbox/setupStart',
        params: { mode: 'unelevated' },
      })
      expect(c.recovery[1]).toMatchObject({
        command: 'codex sandbox setup --elevated --current-user',
        elevated: true,
        recheck: 'vendor.codex.winSandbox',
      })
      // sandbox_unavailable's last resort (one set of fixes for every blocked pass).
      expect(c.recovery[2]).toMatchObject({ id: 'codex.switch-vendor', pass: 'all', to: 'claude' })
    }
  })

  it('plan: native with collaborationMode on app-server, else read-only with the template', () => {
    expect(planCheck({ route: 'app-server', planNative: true }, 1).status).toBe('pass')
    expect(planCheck({ route: 'exec', planNative: false }, 1).status).toBe('skip')
  })
})

describe('route choice from the schema (a missing required method → exec, with a warning)', () => {
  const bundlePath = fileURLToPath(
    new URL(
      '../../../../src/core/adapters/codex/protocol/v0.160.0/schema/codex_app_server_protocol.schemas.json',
      import.meta.url,
    ),
  )
  const bundle = (): Record<string, unknown> =>
    JSON.parse(readFileSync(bundlePath, 'utf8')) as Record<string, unknown>

  /** The bundle without one ServerRequest / ClientRequest variant. */
  function without(method: string): unknown {
    const b = bundle()
    const defs = b['definitions'] as Record<string, Record<string, unknown>>
    for (const root of ['ClientRequest', 'ServerRequest', 'ServerNotification', 'ClientNotification']) {
      const d = defs[root]
      if (d === undefined) continue
      for (const key of ['oneOf', 'anyOf'] as const) {
        const list = d[key]
        if (Array.isArray(list)) {
          d[key] = list.filter((v: { properties?: { method?: { enum?: string[]; const?: string } } }) => {
            const m = v.properties?.method
            return !(m?.const === method || m?.enum?.includes(method))
          })
        }
      }
    }
    return b
  }

  it('the committed 0.160 schema routes to app-server with every optional capability', () => {
    const p = checkProtocol(bundle())
    expect(p).toMatchObject({ transport: 'codex-app-server', missingRequired: [] })
    expect(p.missingOptional).toEqual([])
    const f = factsFrom({ schema: { check: p }, handshake: undefined, platform: 'linux' })
    expect(f).toMatchObject({ route: 'app-server', planNative: true, modelList: true, tokenUsage: true })
  })

  it('without turn/interrupt (required): exec, a warning, no relay', () => {
    const p = checkProtocol(without('turn/interrupt'))
    expect(p.transport).toBe('codex-exec')
    expect(p.missingRequired).toEqual(['turn/interrupt'])
    const check = protocolCheck({ check: p }, undefined, 1)
    expect(check).toMatchObject({ status: 'warn', title: 'Codex runs without a question relay' })
    const f = factsFrom({ schema: { check: p }, handshake: undefined, platform: 'win32' })
    expect(f).toMatchObject({ route: 'exec', planNative: false, winSandbox: 'unavailable' })
    expect(codexCapabilities(f).askRelay).toBe(false)
  })

  it('exec on win32 takes the handshake readiness: a ready sandbox leaves autoedit degraded, not unsupported', () => {
    const p = checkProtocol(without('turn/interrupt'))
    const handshake = { ok: true, ms: 1, models: [], unexpected: [], stderr: [] }
    const ready = factsFrom({
      schema: { check: p },
      handshake: { ...handshake, winSandbox: 'ready' },
      platform: 'win32',
    })
    expect(ready).toMatchObject({ route: 'exec', winSandbox: 'ready' })
    const need = { pass: 'implement', mode: 'autoedit', planNative: false, trustFolder: false } as const
    expect(codexSupport(need, ready)).toMatchObject({ status: 'degraded', reason: 'no-relay' })
    const notSetUp = factsFrom({
      schema: { check: p },
      handshake: { ...handshake, winSandbox: 'notConfigured' },
      platform: 'win32',
    })
    expect(codexSupport(need, notSetUp)).toMatchObject({
      status: 'unsupported',
      reason: 'winSandbox-notConfigured',
    })
    // No answer (the method missing, or no handshake): unavailable, as before.
    const silent = factsFrom({
      schema: { check: p },
      handshake: { ...handshake, winSandbox: 'unknown' },
      platform: 'win32',
    })
    expect(silent.winSandbox).toBe('unavailable')
  })

  it('without the command approval request (required): exec', () => {
    expect(checkProtocol(without('item/commandExecution/requestApproval')).transport).toBe('codex-exec')
  })

  it('without model/list (optional): app-server, the picker takes free text', () => {
    const p = checkProtocol(without('model/list'))
    expect(p.transport).toBe('codex-app-server')
    expect(p.missingOptional).toEqual(['modelList'])
    expect(
      codexCapabilities(factsFrom({ schema: { check: p }, handshake: undefined, platform: 'linux' }))
        .modelList,
    ).toBe('static')
  })

  it('a probe that could not read the schema fails the protocol check (flag drift)', () => {
    expect(protocolCheck({ error: 'exit 2' }, undefined, 1)).toMatchObject({
      status: 'fail',
      category: 'flag_drift',
    })
  })
})

describe('thread/start answer vs the pass (never a silent downgrade)', () => {
  it('an edit pass answered with a read-only sandbox is sandbox_unavailable', () => {
    expect(
      threadPolicyProblem(
        { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
        { sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' },
      ),
    ).toMatchObject({ category: 'sandbox_unavailable' })
  })

  it('a wider sandbox than asked, or questions routed away from the user, is refused', () => {
    expect(
      threadPolicyProblem(
        { sandbox: 'read-only', approvalPolicy: 'never' },
        { sandbox: { type: 'dangerFullAccess' } },
      ),
    ).toMatchObject({ category: 'config_invalid' })
    expect(
      threadPolicyProblem(
        { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
        { sandbox: { type: 'workspaceWrite' }, approvalsReviewer: 'auto_review' },
      ),
    ).toMatchObject({ category: 'config_invalid' })
  })

  it('the asked-for policy, or one Dim Factory cannot judge, passes', () => {
    expect(
      threadPolicyProblem(
        { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
        { sandbox: { type: 'workspaceWrite', writableRoots: [] }, approvalsReviewer: 'user' },
      ),
    ).toBeUndefined()
    expect(
      threadPolicyProblem(
        { sandbox: 'read-only', approvalPolicy: 'never' },
        { sandbox: { type: 'externalSandbox' } },
      ),
    ).toBeUndefined()
    expect(threadPolicyProblem({ sandbox: 'read-only', approvalPolicy: 'never' }, undefined)).toBeUndefined()
  })
})
