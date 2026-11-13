// Grok's own failure texts for the classifier (the ACP rows of
// heal/signals/acp-gemini.ts acpSignals plus these, through AcpVendorConfig.signalRegex). The sign-in texts are Grok
// Build's own (xai-grok-shell agent/auth_method.rs AUTH_ERROR_*, read 2026-10-11); the rest are common API error words
// (429, credits, context length, an unknown model) not yet seen from a live Grok: a live recording confirms them. Exit
// codes: Grok documents 0, 1 (any error), 130 and 143 (signals), so none names a category by itself (user guide 14).
import type { FailureCategory } from '../../../shared/failure.ts'
import type { RegexRule } from '../../heal/signals/generic.ts'
import { retryDetail } from '../../heal/signals/generic.ts'

/** No Grok exit code means one thing (1 is every error; 130 and 143 are SIGINT and SIGTERM). */
export const GROK_EXIT_CODES: Readonly<Record<number, FailureCategory>> = {}

/** Ordered: the first matching rule wins (before the shared ACP regexes). */
export const GROK_REGEX: readonly RegexRule[] = [
  // "Session expired. Run `grok login` to re-authenticate."
  {
    id: 'grok.regex.session-expired',
    re: /Session expired\.?\s+Run `?grok login`?/i,
    category: 'auth_expired',
  },
  // "Authentication failed. Run `grok login`, set XAI_API_KEY, or add api_key to ~/.grok/config.toml."
  {
    id: 'grok.regex.auth-failed',
    re: /Authentication failed\.?\s+Run `?grok login`?|API-key auth is disabled|Set XAI_API_KEY or add api_key/i,
    category: 'auth_required',
  },
  {
    id: 'grok.regex.credits',
    re: /used all (?:of )?(?:its |your )?(?:available )?credits|monthly spending limit|doesn'?t have any credits/i,
    category: 'billing',
  },
  {
    id: 'grok.regex.429',
    re: /\b429\b|Too Many Requests|rate[ -]limit(?:ed)?\b/i,
    category: 'rate_limited',
    detail: retryDetail,
  },
  {
    id: 'grok.regex.context',
    re: /maximum (?:context|prompt) length|context (?:window|length) (?:exceeded|is exceeded)|prompt is too long/i,
    category: 'context_exceeded',
  },
  {
    id: 'grok.regex.model',
    re: /\bmodel\b[^\n]{0,60}(?:not found|does not exist|is not available|unknown)/i,
    category: 'model_unavailable',
  },
]
