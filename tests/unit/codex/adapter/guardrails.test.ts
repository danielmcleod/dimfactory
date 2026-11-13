// Guardrails on Codex: a relayed approval that breaks a rule is declined without asking the user, and the No network
// rule turns the sandbox's network and web search off and fails closed when Codex does not confirm it.
import { describe, expect, it } from 'vitest'
import { networkProblem } from '@core/adapters/codex/appserver.ts'
import { execArgv, noNetworkOf } from '@core/adapters/codex/launch.ts'
import { CodexNormalizer } from '@core/adapters/codex/normalize.ts'
import type { NormalizerOptions } from '@core/adapters/codex/normalize.ts'
import { threadStartParams } from '@core/adapters/codex/params.ts'
import type { GuardrailRule } from '@shared/guardrails.ts'
import { presetRules } from '@shared/guardrails.ts'

function make(
  rules: readonly GuardrailRule[] | undefined,
  o: Partial<NormalizerOptions> = {},
): CodexNormalizer {
  return new CodexNormalizer({
    step: 'implement',
    mode: 'autoedit',
    cwd: '/w',
    planNative: false,
    resumed: false,
    askTimeoutMs: 600_000,
    allowRules: [],
    structured: false,
    loopback: false,
    now: () => 1000,
    ...(rules !== undefined ? { guardrails: { rules, allowAgentSettings: false } } : {}),
    ...o,
  })
}

const cmd = (command: string, extra: Record<string, unknown> = {}) => ({
  kind: 'command',
  threadId: 't',
  turnId: 'u',
  itemId: 'c1',
  startedAtMs: 1,
  environmentId: null,
  command,
  cwd: '/w',
  ...extra,
})

const fileItem = (n: CodexNormalizer, path: string): void => {
  n.notification('item/started', {
    item: {
      type: 'fileChange',
      id: 'f1',
      status: 'inProgress',
      changes: [{ path, kind: { type: 'update', move_path: null }, diff: '' }],
    },
  })
}

describe('Codex approvals against the guardrails', () => {
  it('declines a forbidden command without asking, and reports it', async () => {
    const n = make(presetRules('recommended'))
    const r = n.request('item/commandExecution/requestApproval', cmd('git push origin main'), 5)
    expect(r.step.events).toEqual([])
    expect(await r.reply).toEqual({ decision: 'decline' })
    expect(r.step.signals).toMatchObject([
      { type: 'guardrail-blocked', finding: { kind: 'forbiddenCommand' } },
      { type: 'auto-answered', requestId: '5', decision: 'deny', tool: 'shell', why: 'guardrail' },
    ])
    expect(n.pendingAsks()).toEqual([])
  })

  it('still asks the user about an ordinary command', () => {
    const n = make(presetRules('recommended'))
    const r = n.request('item/commandExecution/requestApproval', cmd('npm install'), 6)
    expect(r.step.events[0]).toMatchObject({ type: 'ask', kind: 'shell' })
  })

  it('declines an edit to a settings file or a protected file', async () => {
    const n = make([{ kind: 'protectedFiles', paths: ['migrations/**'] }])
    fileItem(n, '/w/.codex/config.toml')
    const a = n.request(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'f1', startedAtMs: 1 },
      7,
    )
    expect(await a.reply).toEqual({ decision: 'decline' })
    expect(a.step.signals[0]).toMatchObject({ type: 'guardrail-blocked', finding: { self: true } })
    const m = make([{ kind: 'protectedFiles', paths: ['migrations/**'] }])
    fileItem(m, '/w/migrations/1.sql')
    const b = m.request(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'f1', startedAtMs: 1 },
      8,
    )
    expect(b.step.signals[0]).toMatchObject({
      finding: { kind: 'protectedFiles', subject: 'migrations/1.sql' },
    })
  })

  it('declines a write outside the folder and a wider write grant under No writes outside', () => {
    const n = make([{ kind: 'noWritesOutside' }])
    fileItem(n, '/home/me/notes.txt')
    const a = n.request(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'f1', startedAtMs: 1 },
      9,
    )
    expect(a.step.signals[0]).toMatchObject({ finding: { kind: 'noWritesOutside' } })
    const g = make([{ kind: 'noWritesOutside' }])
    fileItem(g, '/w/src/a.ts')
    const b = g.request(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'f1', startedAtMs: 1, grantRoot: '/home/me' },
      10,
    )
    expect(b.step.signals[0]).toMatchObject({ finding: { kind: 'noWritesOutside' } })
  })

  it('declines network access under the No network rule', async () => {
    const rules: GuardrailRule[] = [{ kind: 'network', allow: false }]
    const n = make(rules)
    const r = n.request(
      'item/commandExecution/requestApproval',
      cmd('npm install', { networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' } }),
      11,
    )
    expect(await r.reply).toEqual({ decision: 'decline' })
    expect(r.step.signals[0]).toMatchObject({ finding: { kind: 'network' } })
    const p = make(rules).request(
      'item/permissions/requestApproval',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'p',
        environmentId: null,
        startedAtMs: 1,
        cwd: '/w',
        reason: null,
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      12,
    )
    expect(await p.reply).toEqual({ permissions: {} })
    expect(p.step.signals[1]).toMatchObject({ type: 'auto-answered', why: 'guardrail' })
  })

  it('asks as before when the pass carries no guardrails', () => {
    const r = make(undefined).request('item/commandExecution/requestApproval', cmd('git push'), 13)
    expect(r.step.events[0]).toMatchObject({ type: 'ask' })
  })
})

describe('the No network rule on Codex', () => {
  const policy = { rules: [{ kind: 'network', allow: false }] as GuardrailRule[], allowAgentSettings: false }

  it('turns the sandbox network and web search off on thread/start', () => {
    expect(noNetworkOf({ guardrails: policy })).toBe(true)
    expect(noNetworkOf({})).toBe(false)
    const p = threadStartParams({ step: 'research', web: true, mode: 'autoedit', cwd: '/w', noNetwork: true })
    expect(p.config).toMatchObject({
      'sandbox_workspace_write.network_access': false,
      web_search: 'disabled',
    })
    expect(threadStartParams({ step: 'implement', mode: 'autoedit', cwd: '/w' }).config).toBeUndefined()
  })

  it('sends the same settings to the exec fallback', () => {
    const a = execArgv({ step: 'implement', mode: 'autoedit', cwd: '/w', outFile: 'o', noNetwork: true })
    expect(a.join(' ')).toContain('-c sandbox_workspace_write.network_access=false -c web_search="disabled"')
  })

  it('fails closed unless thread/start confirms the sandbox has no network', () => {
    expect(networkProblem({ sandbox: { type: 'workspaceWrite', networkAccess: false } })).toBeUndefined()
    expect(networkProblem({ sandbox: { type: 'readOnly', networkAccess: false } })).toBeUndefined()
    expect(networkProblem({ sandbox: { type: 'workspaceWrite', networkAccess: true } })?.category).toBe(
      'config_invalid',
    )
    expect(networkProblem({ sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } })).toBeDefined()
    expect(networkProblem(undefined)).toBeDefined()
    // Full access has no sandbox; preflight has already said the rule does nothing there.
    expect(networkProblem({ sandbox: { type: 'dangerFullAccess' } })).toBeUndefined()
  })
})
