// vendor.grok.auth (Grok: "XAI_API_KEY, or ACP authRequired on Test"). The key's
// presence (never its value) and the existence of Grok's cached sign-in (`$GROK_HOME/auth.json`, never opened) say
// how Grok would sign in; on Test the probe's session/new answers ACP authRequired when it cannot. Without either, the
// launch probe warns (Grok also signs in with a key in its own config.toml, which Dim Factory never reads).
// Dim Factory never calls `authenticate` and never reads a credential.
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import { vendorCheckId } from '../../../shared/preflight.ts'
import type { ProbeAccount } from '../../../shared/vendors.ts'
import { commandFor, osFamily, shellFor } from '../../heal/commands.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import type { AcpAuthInput } from '../acp-base/config.ts'
import { switchToClaude, vendorCheck } from '../acp-base/probe.ts'
import { GROK_DISPLAY_NAME, GROK_VENDOR } from './cli-spec.ts'
import { hasCachedSignIn } from './home.ts'

/** The key Grok reads (user guide 02), and the legacy name its auth code still accepts when that one is unset. */
export const XAI_KEY_ENV = ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'] as const

const set = (env: EnvInput, key: string): boolean => (getEnv(env, key) ?? '').trim() !== ''

export const hasXaiKey = (env: EnvInput): boolean => XAI_KEY_ENV.some((k) => set(env, k))

/**
 * How Grok would sign in, from the environment and the existence of its cached sign-in (never their values). The
 * cached sign-in comes first: Grok uses the key only when no session token is active (user guide 02, "Precedence").
 */
export function grokAuthSource(env: EnvInput, home: string): string | undefined {
  if (hasCachedSignIn(env, home)) return 'its own sign-in (grok login)'
  if (hasXaiKey(env)) return 'an xAI API key (XAI_API_KEY)'
  return undefined
}

/**
 * Subscription auth: the sign-in method only. An xAI API key is billed per token; a Grok sign-in may be a subscription,
 * which Dim Factory cannot tell, so nothing is claimed for it (undefined).
 */
export function grokAccount(o: AcpAuthInput): ProbeAccount | undefined {
  if (o.handshake?.authRequired === true) return undefined
  if (hasCachedSignIn(o.env, o.home)) return undefined
  return hasXaiKey(o.env) ? { method: 'api-key' } : undefined
}

/**
 * The sign-in command to copy (`grok login`, user guide 02; the commands table's Grok row). Copied, never run.
 */
export function grokLoginAction(): RecoveryAction {
  const os = osFamily()
  return {
    id: `${GROK_VENDOR}.login`,
    label: 'Copy the sign-in command',
    kind: 'shell_copy',
    command: commandFor('login', GROK_VENDOR, os)?.command ?? 'grok login',
    shell: shellFor(os),
    reason: `${GROK_DISPLAY_NAME} is not signed in. It opens a browser once; an XAI_API_KEY in the environment works too`,
    recheck: vendorCheckId(GROK_VENDOR, 'auth'),
  }
}

export function grokAuthCheck(o: AcpAuthInput): CheckResult {
  const recovery = [grokLoginAction(), switchToClaude(GROK_VENDOR)]
  const source = grokAuthSource(o.env, o.home)
  if (o.handshake?.authRequired === true) {
    return vendorCheck(
      GROK_VENDOR,
      'auth',
      'fail',
      `${GROK_DISPLAY_NAME} needs a sign-in`,
      source !== undefined
        ? `${GROK_DISPLAY_NAME} refused to start a session although it is set up to use ${source}; the sign-in may have expired. Run the sign-in command in a terminal, then press Test.`
        : 'Run the sign-in command in a terminal, then press Test.',
      o.at,
      { category: 'auth_required', recovery },
    )
  }
  if (o.handshake?.sessionOk === true) {
    return vendorCheck(
      GROK_VENDOR,
      'auth',
      'pass',
      'Signed in',
      `${GROK_DISPLAY_NAME} started a session, so it is signed in${source !== undefined ? ` (with ${source})` : ''}.`,
      o.at,
    )
  }
  if (source !== undefined) {
    return vendorCheck(
      GROK_VENDOR,
      'auth',
      'pass',
      'Signed in',
      `${GROK_DISPLAY_NAME} signs in with ${source}. Test starts a session to make sure.`,
      o.at,
    )
  }
  // Neither a key in the environment nor Grok's cached sign-in. Grok may still sign in another way Dim Factory
  // does not read (a per-model `api_key` / `env_key` in its config.toml, user guide 02 "Precedence"), so the launch
  // probe only warns; Test starts a session, and an `authRequired` answer then fails (above).
  return vendorCheck(
    GROK_VENDOR,
    'auth',
    'warn',
    `${GROK_DISPLAY_NAME} sign-in not checked`,
    `Dim Factory found no XAI_API_KEY and no ${GROK_DISPLAY_NAME} sign-in (grok login). If ${GROK_DISPLAY_NAME} signs in another way (a key in its own config), passes work; otherwise they stop with a sign-in error. Press Test to start a session and make sure, or run the sign-in command in a terminal.`,
    o.at,
    { category: 'auth_required', recovery },
  )
}
