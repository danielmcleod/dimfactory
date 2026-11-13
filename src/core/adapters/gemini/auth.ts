// vendor.gemini.auth (Gemini: "GEMINI_API_KEY / Vertex env or
// ~/.gemini/oauth_creds.json exists (contents not read)"). An ACP `authRequired` answer to the probe's session/new
// overrides what the environment and files suggest. Dim Factory never calls `authenticate` and never reads credentials.
import type { CheckResult } from '../../../shared/preflight.ts'
import type { ProbeAccount } from '../../../shared/vendors.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import type { AcpAuthInput } from '../acp-base/config.ts'
import { defined, shellCopy, switchToClaude, vendorCheck } from '../acp-base/probe.ts'
import { GEMINI_DISPLAY_NAME, GEMINI_VENDOR } from './cli-spec.ts'
import { hasOauthCreds } from './home.ts'

const set = (env: EnvInput, key: string): boolean => (getEnv(env, key) ?? '').trim() !== ''
const on = (env: EnvInput, key: string): boolean => /^(?:true|1)$/i.test((getEnv(env, key) ?? '').trim())

/** How Gemini would sign in, from the environment and the existence of its OAuth file (never their values). */
export function geminiAuthSource(env: EnvInput, home: string): string | undefined {
  if (set(env, 'GEMINI_API_KEY')) return 'a Gemini API key (GEMINI_API_KEY)'
  if (
    on(env, 'GOOGLE_GENAI_USE_VERTEXAI') &&
    (set(env, 'GOOGLE_API_KEY') || set(env, 'GOOGLE_CLOUD_PROJECT'))
  )
    return 'Vertex AI'
  if (on(env, 'GOOGLE_GENAI_USE_GCA')) return 'Google Code Assist'
  if (hasOauthCreds(env, home)) return 'a Google sign-in'
  return undefined
}

/**
 * Subscription auth is shown as an API-equivalent cost: the sign-in as Gemini names its auth types
 * (`oauth-personal` = Login with Google, also what GOOGLE_GENAI_USE_GCA selects; `gemini-api-key`; `vertex-ai`), from
 * the same environment and file-existence facts as the auth check and in the same order. A Google login is billed by
 * the account, not per token (catalog/cost reads it as subscription auth); a key or Vertex AI is not. undefined: not
 * signed in, or signed in some way Dim Factory cannot tell (then no "API-equiv." label is claimed).
 */
export function geminiAccount(o: AcpAuthInput): ProbeAccount | undefined {
  if (o.handshake?.authRequired === true) return undefined
  if (set(o.env, 'GEMINI_API_KEY')) return { method: 'gemini-api-key' }
  if (
    on(o.env, 'GOOGLE_GENAI_USE_VERTEXAI') &&
    (set(o.env, 'GOOGLE_API_KEY') || set(o.env, 'GOOGLE_CLOUD_PROJECT'))
  )
    return { method: 'vertex-ai' }
  if (on(o.env, 'GOOGLE_GENAI_USE_GCA') || hasOauthCreds(o.env, o.home)) return { method: 'oauth-personal' }
  return undefined
}

export function geminiAuthCheck(o: AcpAuthInput): CheckResult {
  const login = shellCopy(
    GEMINI_VENDOR,
    'gemini.login',
    'Copy the sign-in command',
    'login',
    `${GEMINI_DISPLAY_NAME} is not signed in`,
    'auth',
  )
  const recovery = defined([login, switchToClaude(GEMINI_VENDOR)])
  const source = geminiAuthSource(o.env, o.home)
  if (o.handshake?.authRequired === true) {
    return vendorCheck(
      GEMINI_VENDOR,
      'auth',
      'fail',
      `${GEMINI_DISPLAY_NAME} needs a sign-in`,
      source !== undefined
        ? `${GEMINI_DISPLAY_NAME} refused to start a session although it is set up for ${source}; the sign-in may have expired. Run the sign-in command in a terminal, then re-check.`
        : 'Run the sign-in command in a terminal, then re-check.',
      o.at,
      { category: 'auth_required', recovery },
    )
  }
  if (source !== undefined) {
    return vendorCheck(
      GEMINI_VENDOR,
      'auth',
      'pass',
      'Signed in',
      `${GEMINI_DISPLAY_NAME} signs in with ${source}.`,
      o.at,
    )
  }
  if (o.handshake?.sessionOk === true) {
    return vendorCheck(
      GEMINI_VENDOR,
      'auth',
      'pass',
      'Signed in',
      `${GEMINI_DISPLAY_NAME} started a session, so it is signed in (Dim Factory does not check how).`,
      o.at,
    )
  }
  return vendorCheck(
    GEMINI_VENDOR,
    'auth',
    'fail',
    `${GEMINI_DISPLAY_NAME} is not signed in`,
    'Run the sign-in command in a terminal (it opens a browser once), then re-check. A GEMINI_API_KEY in the environment works too.',
    o.at,
    { category: 'auth_required', recovery },
  )
}
