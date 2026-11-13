// The outside-agent endpoint proves itself before the stdio bridge sends it the bearer token. The bridge reads the
// token from DIM_FACTORY_HOME/state.json (a file only this user can read), so only the real app and the bridge know
// it. The bridge sends a fresh random nonce, with no token, to `POST /mcp/<route>/proof`; the app answers
// HMAC-SHA256(token, label | port | route | nonce). The port is the one the app listens on, so a listener that holds
// the configured port while Dim Factory is closed cannot pass a real app's answer through from another port, and the
// nonce is new for every check, so no earlier answer can be replayed. Only then does the bridge send the token, on the
// same connection that answered (bridge.ts). No network trust is involved: the proof is the secret file's.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** The path suffix of a route's proof (`/mcp/<route>/proof`). */
export const MCP_PROOF_SUFFIX = 'proof'
/** The header that carries the bridge's nonce. */
export const MCP_NONCE_HEADER = 'x-dim-factory-nonce'
const LABEL = 'dim-factory/mcp-server-proof/v1'
const NONCE = /^[A-Za-z0-9_-]{22,128}$/

/** A fresh nonce (32 random bytes, base64url). */
export function newProofNonce(): string {
  return randomBytes(32).toString('base64url')
}

/** Whether `s` is a nonce the endpoint answers (base64url, 22 to 128 characters). */
export function isProofNonce(s: string | undefined): s is string {
  return s !== undefined && NONCE.test(s)
}

/** The answer only a holder of `token` can give for this port, route and nonce (base64url). */
export function serverProof(token: string, o: { port: number; route: string; nonce: string }): string {
  return createHmac('sha256', token).update(`${LABEL}\n${o.port}\n${o.route}\n${o.nonce}`).digest('base64url')
}

/** Constant-time check of an answer against the expected proof. */
export function proofMatches(
  given: unknown,
  token: string,
  o: { port: number; route: string; nonce: string },
): boolean {
  if (typeof given !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(given)) return false
  const want = Buffer.from(serverProof(token, o), 'utf8')
  const got = Buffer.from(given, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}
