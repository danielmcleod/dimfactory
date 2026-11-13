// Muse failure signals for the classifier. Exit codes from the official docs
// (dev.meta.ai/docs/muse-code/extending: 0 done, 1 failed or cancelled (also --max-model-steps), 2 usage, 130/143
// signals); a failed run's reason is on the final stderr line (changelog 1.4.0) and in its `run.terminal.*` record's
// `reason`. The texts below are SYNTHESIZED from the docs' wording until a live recording shows Muse's own.
import type { FailureCategory } from '../../../shared/failure.ts'
import { registerSignalTable, signalTableFor } from '../../heal/classify.ts'
import { exitRulesOf } from '../../heal/signals/acp-gemini.ts'
import type { ExitRule, RegexRule, SignalTable } from '../../heal/signals/generic.ts'
import { asRecord, retryDetail, str } from '../../heal/signals/generic.ts'
import { MUSE_VENDOR } from './cli-spec.ts'
import { RUN_TERMINAL_PREFIX, TERMINAL_COMPLETED } from './protocol.ts'

/** Exit 2 is a usage error: a flag Dim Factory passed was refused (flag drift). 1 is read from the texts. */
export const MUSE_EXIT_CODES: Readonly<Record<number, FailureCategory>> = { 2: 'flag_drift' }

export const MUSE_EXIT: readonly ExitRule[] = exitRulesOf(MUSE_VENDOR, MUSE_EXIT_CODES)

/** Ordered: the first matching rule wins (an expired sign-in before a missing one, a daily quota before a 429). */
export const MUSE_REGEX: readonly RegexRule[] = [
  {
    id: 'muse.regex.auth-expired',
    re: /(?:session|sign[- ]?in|login|token|credentials?) (?:has |have )?expired/i,
    category: 'auth_expired',
  },
  {
    id: 'muse.regex.auth',
    re: /META_API_KEY|not (?:signed|logged) in|sign[- ]?in (?:is )?required|authenticat(?:ion|e) (?:is )?(?:required|failed)|\bunauthori[sz]ed\b|\b401\b|invalid api key|no credentials/i,
    category: 'auth_required',
  },
  {
    id: 'muse.regex.untrusted',
    re: /--trust-workspace|trust (?:this|the) workspace|workspace is not trusted|untrusted workspace/i,
    category: 'trust_required',
  },
  {
    id: 'muse.regex.max-model-steps',
    re: /max(?:imum)?[- ]model[- ]steps|model step limit/i,
    category: 'turn_limit',
  },
  { id: 'muse.regex.settings', re: /malformed settings file/i, category: 'config_invalid' },
  {
    id: 'muse.regex.sandbox',
    re: /sandbox (?:is )?(?:not active|unavailable)|could not confirm (?:that )?the sandbox|bubblewrap/i,
    category: 'sandbox_unavailable',
  },
  { id: 'muse.regex.billing', re: /\b402\b|payment required|billing/i, category: 'billing' },
  {
    id: 'muse.regex.quota',
    re: /usage limit|quota|out of credits|insufficient credits/i,
    category: 'quota_exceeded',
    detail: retryDetail,
  },
  {
    id: 'muse.regex.rate',
    re: /\b429\b|rate[- ]limit|too many requests/i,
    category: 'rate_limited',
    detail: retryDetail,
  },
  {
    id: 'muse.regex.model',
    re: /unknown model|unsupported model|\bmodel\b[^\n]{0,60}(?:not found|not available|unavailable|does not exist)/i,
    category: 'model_unavailable',
  },
  {
    id: 'muse.regex.context',
    re: /context (?:window|length) (?:exceeded|is too long)|maximum context length|prompt is too long/i,
    category: 'context_exceeded',
  },
  {
    id: 'muse.regex.approval',
    re: /approvals? (?:are |is )?disabled|requires? (?:an )?approval|was not approved|escalation (?:failed|denied|refused)/i,
    category: 'permission_denied',
  },
  { id: 'muse.regex.policy', re: /content policy|policy violation/i, category: 'content_policy' },
  {
    id: 'muse.regex.server',
    re: /\b50[0234]\b|overloaded|internal server error|service unavailable/i,
    category: 'vendor_internal',
  },
]

type Frame = Record<string, unknown>

/** The payload of a record (an envelope), or the frame itself when it is already a payload. */
function payloadOf(f: Frame): { type: string | undefined; payload: Frame } {
  const payload = asRecord(f['payload'])
  return payload !== undefined
    ? { type: str(f['payload_type']), payload }
    : { type: str(f['payload_type']), payload: f }
}

/** A `run.terminal.*` record that did not complete: its terminal word and reason. */
export function failedTerminalOf(v: unknown): { terminal: string; reason: string | undefined } | undefined {
  const f = asRecord(v)
  if (f === undefined) return undefined
  const { type, payload } = payloadOf(f)
  const isTerminal = type?.startsWith(RUN_TERMINAL_PREFIX) === true || str(payload['kind']) === 'run_terminal'
  if (!isTerminal) return undefined
  const terminal = str(payload['terminal']) ?? type?.slice(RUN_TERMINAL_PREFIX.length) ?? ''
  if (terminal === TERMINAL_COMPLETED) return undefined
  return { terminal, reason: str(payload['reason']) ?? undefined }
}

function failedTerminals(list: readonly unknown[]): { terminal: string; reason: string | undefined }[] {
  const out: { terminal: string; reason: string | undefined }[] = []
  for (const v of list) {
    const t = failedTerminalOf(v)
    if (t !== undefined) out.push(t)
  }
  return out
}

export const MUSE_SIGNALS: SignalTable = {
  vendor: MUSE_VENDOR,
  // No structured stage: Muse documents no terminal word as a category of its own (`cancelled` also covers
  // --max-model-steps), so the reason decides through the regex stage.
  hasFailure: (list) => failedTerminals(list).length > 0,
  texts: (list) =>
    failedTerminals(list).flatMap((t) =>
      t.reason !== undefined && t.reason.trim() !== '' ? [t.reason] : [`Muse run ${t.terminal}`],
    ),
  exit: MUSE_EXIT,
  regex: MUSE_REGEX,
}

/** The classifier's table for Muse (registered once, by the adapter and its normalizer). */
export function ensureMuseSignals(): void {
  if (signalTableFor(MUSE_VENDOR) === undefined) registerSignalTable(MUSE_SIGNALS)
}
