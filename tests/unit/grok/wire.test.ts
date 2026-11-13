// What Grok puts on the ACP wire (src/core/adapters/grok/wire.ts, signals.ts) and the generic ACP base extensions
// added for it (the failure table): the prompt answer's `_meta.usage` as the pass usage,
// option names Dim Factory never chooses, Grok's failure texts in the classifier, the mode `_meta` and the version
// check of a vendor with no tested version.
import { describe, expect, it } from 'vitest'
import { createAcpAdapter } from '@core/adapters/acp-base/index.ts'
import { AcpNormalizer } from '@core/adapters/acp-base/normalize.ts'
import { versionCheck } from '@core/adapters/acp-base/probe.ts'
import {
  allowSessionOption,
  canAllowSession,
  permissionReply,
  rejectReply,
} from '@core/adapters/acp-base/protocol.ts'
import type { PermissionOption } from '@core/adapters/acp-base/protocol.ts'
import { grokConfig } from '@core/adapters/grok/config.ts'
import { GROK_REGEX } from '@core/adapters/grok/signals.ts'
import { GROK_FORBIDDEN_OPTION_NAME, grokMetaUsage } from '@core/adapters/grok/wire.ts'
import { classify, signalTableFor } from '@core/heal/classify.ts'
import { ACP_REGEX } from '@core/heal/signals/acp-gemini.ts'

const PREFS = grokConfig.optionPrefs
const opt = (optionId: string, name: string, kind: PermissionOption['kind']): PermissionOption => ({
  optionId,
  name,
  kind,
})

describe('grokMetaUsage: the prompt answer has no ACP usage; _meta.usage is the pass usage', () => {
  it("modelUsage summed over the models; cached reads apart; Grok's cost when every model has one; exact", () => {
    const result = {
      stopReason: 'end_turn',
      _meta: {
        totalTokens: 90000,
        inputTokens: 10,
        outputTokens: 1,
        usage: {
          totalTokens: 6144 + 18432 + 210 + 500 + 100 + 20,
          modelUsage: {
            'grok-4.6': { inputTokens: 6144, outputTokens: 210, cacheReadInputTokens: 18432, costUSD: 0.02 },
            'grok-4.5-mini': {
              inputTokens: 500,
              outputTokens: 20,
              cacheReadInputTokens: 100,
              costUSD: 0.001,
            },
          },
        },
      },
    }
    expect(grokMetaUsage(result)).toEqual({
      input: 6644,
      output: 230,
      cacheRead: 18532,
      costUsd: 0.021,
      approx: false,
    })
  })

  it('a total of input + output with cached reads means they were inside the input: they come off', () => {
    const usage = (total: number) => ({
      _meta: {
        usage: {
          totalTokens: total,
          modelUsage: { m: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 400 } },
        },
      },
    })
    expect(grokMetaUsage(usage(1050))).toMatchObject({ input: 600, cacheRead: 400 })
    expect(grokMetaUsage(usage(1450))).toMatchObject({ input: 1000, cacheRead: 400 })
    // No total: Grok's own formula (input + cache read + cache creation + output) stands.
    const noTotal = {
      _meta: {
        usage: { modelUsage: { m: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 400 } } },
      },
    }
    expect(grokMetaUsage(noTotal)).toMatchObject({ input: 1000 })
  })

  it("the per-turn keys hold the cached reads inside inputTokens (Grok's own test numbers)", () => {
    // xai-org/grok-build prompt_response_meta_tests.rs enriches_meta_with_camelcase_token_keys: TokenUsage
    // {prompt_tokens 1500, completion_tokens 200, total_tokens 1700, reasoning_tokens 75, cached_prompt_tokens 1000}
    // gives inputTokens 1500 and cachedReadTokens 1000; 1700 = 1500 + 200, so the 1000 are inside the 1500.
    const answer = {
      stopReason: 'end_turn',
      _meta: {
        totalTokens: 1700,
        inputTokens: 1500,
        outputTokens: 200,
        cachedReadTokens: 1000,
        reasoningTokens: 75,
      },
    }
    expect(grokMetaUsage(answer)).toEqual({
      input: 500,
      output: 200,
      cacheRead: 1000,
      reasoning: 75,
      approx: 'per-turn-only',
    })
    // Never below zero, whatever a malformed answer says.
    expect(
      grokMetaUsage({ _meta: { inputTokens: 10, outputTokens: 1, cachedReadTokens: 50 } }),
    ).toMatchObject({ input: 0, cacheRead: 50 })
  })

  it('a model without a cost leaves the cost out; the per-turn keys alone are approximate; nothing: undefined', () => {
    const partial = {
      _meta: {
        usage: {
          modelUsage: {
            a: { inputTokens: 1, outputTokens: 1, costUSD: 1 },
            b: { inputTokens: 1, outputTokens: 1 },
          },
        },
      },
    }
    expect(grokMetaUsage(partial)).toEqual({ input: 2, output: 2, approx: false })
    expect(
      grokMetaUsage({
        _meta: { inputTokens: 9216, outputTokens: 150, cachedReadTokens: 6144, reasoningTokens: 60 },
      }),
    ).toEqual({ input: 3072, output: 150, cacheRead: 6144, reasoning: 60, approx: 'per-turn-only' })
    expect(grokMetaUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(grokMetaUsage({ _meta: { sessionId: 's' } })).toBeUndefined()
    expect(grokMetaUsage(null)).toBeUndefined()
  })

  it('the normalizer: exact usage flags nothing; Gemini-style totals keep their usageApprox', () => {
    const make = (metaUsage: typeof grokMetaUsage) =>
      new AcpNormalizer({
        vendor: 'grok',
        displayName: 'Grok',
        step: 'review',
        mode: 'readonly',
        cwd: '/w',
        planNative: false,
        resumed: false,
        askTimeoutMs: 1000,
        allowRules: [],
        optionPrefs: PREFS,
        usage: { inputIncludesCached: false, cumulative: false, metaUsage },
        planRoots: [],
        requestPrefix: 'r:',
        now: () => 1,
      })
    const answer = {
      stopReason: 'end_turn',
      _meta: {
        usage: { modelUsage: { m: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 } } },
      },
    }
    const exact = make(grokMetaUsage)
    exact.session('s')
    const step = exact.promptResult(answer)
    expect(step.signals.filter((s) => s.type === 'meta')).toEqual([])
    expect(step.events.at(-1)).toEqual({
      type: 'done',
      result: '',
      usage: { input: 100, output: 10, cacheRead: 5 },
    })
    const legacy = make(() => ({ input: 7, output: 1 }))
    legacy.session('s')
    expect(legacy.promptResult(answer).signals).toContainEqual({
      type: 'meta',
      key: 'usageApprox',
      value: { reason: 'no-cached-split' },
    })
  })
})

describe("the decision table with Grok's preferences (optionPrefs.forbiddenName)", () => {
  it('allow picks Allow once even when an always-approve option of the same kind comes first', () => {
    const options = [
      opt('a', 'Enable always-approve mode', 'allow_once'),
      opt('b', 'Allow all edits this session', 'allow_once'),
      opt('c', 'Allow once', 'allow_once'),
      opt('d', 'Reject once', 'reject_once'),
    ]
    expect(permissionReply('allow', options, PREFS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'c' },
    })
    expect(permissionReply('deny', options, PREFS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'd' },
    })
    expect(rejectReply(options, PREFS)).toEqual({ outcome: { outcome: 'selected', optionId: 'd' } })
  })

  it('only widening options of the needed kind: cancelled, which never allows anything', () => {
    const options = [
      opt('a', 'Enable always-approve mode', 'allow_once'),
      opt('d', 'Reject once', 'reject_once'),
    ]
    expect(permissionReply('allow', options, PREFS)).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('allow-session never chooses an allow_always (Grok remembers them for the project); the ask hides it', () => {
    const options = [
      opt('always', 'Always allow `npm test` in this project', 'allow_always'),
      opt('once', 'Allow once', 'allow_once'),
    ]
    expect(allowSessionOption(options, PREFS)).toBeUndefined()
    expect(canAllowSession(options, PREFS)).toBe(false)
    expect(permissionReply('allow-session', options, PREFS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    })
    // A forbidden name keeps even an optionPrefs.allowSession id from being chosen (a generic guard).
    const prefs = { allowSession: ['x'], forbidden: [], forbiddenName: GROK_FORBIDDEN_OPTION_NAME }
    expect(
      allowSessionOption([opt('x', 'Enable always-approve mode', 'allow_always')], prefs),
    ).toBeUndefined()
    expect(allowSessionOption([opt('x', 'Allow for this session', 'allow_always')], prefs)?.optionId).toBe(
      'x',
    )
  })
})

describe("Grok's failure texts (through the ACP base's table)", () => {
  // createAcpAdapter registers Grok's table (the ACP rows, Grok's regexes first).
  createAcpAdapter(grokConfig)
  const at = 1_000

  it('the table is registered once, Grok first, then the shared ACP rows', () => {
    const table = signalTableFor('grok')
    expect(table?.regex?.map((r) => r.id)).toEqual([...GROK_REGEX, ...ACP_REGEX].map((r) => r.id))
    expect(new Set(GROK_REGEX.map((r) => r.id)).size).toBe(GROK_REGEX.length)
    for (const r of GROK_REGEX) {
      expect(r.id.startsWith('grok.regex.')).toBe(true)
      expect(r.re.global || r.re.sticky).toBe(false)
    }
  })

  it.each([
    ['Session expired. Run `grok login` to re-authenticate.', 'auth_expired'],
    [
      'Authentication failed. Run `grok login`, set XAI_API_KEY, or add api_key to ~/.grok/config.toml.',
      'auth_required',
    ],
    ['API-key auth is disabled by your administrator.', 'auth_required'],
    ['Your team has used all available credits or reached its monthly spending limit.', 'billing'],
    ['429 Too Many Requests', 'rate_limited'],
    ["This model's maximum context length is 256000 tokens", 'context_exceeded'],
    ['The model grok-9 does not exist or your team does not have access to it', 'model_unavailable'],
  ])('%s → %s', (text, category) => {
    expect(classify({ vendor: 'grok', now: at, exitCode: 1, stderrTail: [text] })?.category).toBe(category)
  })

  it('ACP authRequired on session/new is auth_required; exit 1 alone names nothing', () => {
    expect(
      classify({
        vendor: 'grok',
        now: at,
        rpcError: { code: -32000, message: 'Authentication required', method: 'session/new', required: true },
      })?.category,
    ).toBe('auth_required')
    expect(grokConfig.exitCodes).toEqual({})
  })
})

describe('the version check of a vendor with no tested version ("record")', () => {
  it('passes and says the version is recorded', () => {
    const c = versionCheck(grokConfig, '1.0.50', { text: 'Commands:\n  stdio  x\n      --no-leader  y' }, 1)
    expect(c).toMatchObject({ id: 'vendor.grok.version', status: 'pass', title: 'Grok 1.0.50' })
    expect(c.detail).toBe('Version recorded. Dim Factory has not yet been tested against a live Grok.')
  })
})
