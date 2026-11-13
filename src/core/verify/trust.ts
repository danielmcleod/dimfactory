// Verify command trust (trust.json): a `commands` grant whose hash
// sha256(JSON{kind:'verify', argv, cwdRel, body}) covers the script body, so a changed body needs a new grant. Bodies
// are re-read before each round; Auto never implies trust.
import type { GrantCommand } from '../../shared/failure.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import { isBuiltinCheckArgv } from '../../shared/pageload.ts'
import type { VerifyTrustState } from '../../shared/verify.ts'
import { commandGrantHash, coveredByProject, normalizeCwdRel } from '../config/trust.ts'
import { readBody } from './discover.ts'
import type { BodyCommand } from './discover.ts'

/** The argv of a command (DetectedCommand.run, or `argv`). */
export function argvOfCommand(cmd: BodyCommand): string[] {
  if (cmd.argv !== undefined) return [...cmd.argv]
  return Array.isArray(cmd.run) ? [...(cmd.run as readonly string[])] : []
}

/** What a `command` grant for this verify command trusts (the command grant shape; `body` absent when null). */
export function grantCommandOf(cmd: BodyCommand, body: string | null): GrantCommand {
  return {
    kind: 'verify',
    argv: argvOfCommand(cmd),
    cwdRel: normalizeCwdRel(cmd.cwdRel),
    ...(body !== null ? { body } : {}),
  }
}

/** The grant key: sha256(JSON{kind:'verify', argv, cwdRel, body}) (config/trust.ts commandGrantHash). */
export function commandHash(cmd: BodyCommand, body: string | null): string {
  return commandGrantHash(grantCommandOf(cmd, body))
}

export interface TrustCheck {
  trust: Exclude<VerifyTrustState, 'invalid'>
  hash: string
  body: string | null
  /** `changed`: the body the newest grant for the same argv and cwd covers (null: that grant has none). */
  grantedBody?: string | null
  /** Trusted only by an Easy run's project permission (no grant of its own): each such use is logged. */
  via?: 'project'
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** How a command with this body stands against the folder's grants. */
export function trustOf(cmd: BodyCommand, body: string | null, grants: TrustGrants): TrustCheck {
  const hash = commandHash(cmd, body)
  // Dim Factory's own checks spawn nothing: the project's page or game runs only in the sandboxed preview, so no grant
  // is needed (the project's playtest.json is data it reads).
  if (isBuiltinCheckArgv(argvOfCommand(cmd))) return { trust: 'trusted', hash, body }
  const all = grants.commands ?? {}
  if (all[hash] !== undefined) return { trust: 'trusted', hash, body }
  if (coveredByProject(grants)) return { trust: 'trusted', hash, body, via: 'project' }
  const argv = argvOfCommand(cmd)
  const cwdRel = normalizeCwdRel(cmd.cwdRel)
  let newest: { at: number; body: string | null } | null = null
  for (const g of Object.values(all)) {
    if (g.kind !== 'verify' || normalizeCwdRel(g.cwdRel) !== cwdRel || !sameArgv(g.argv, argv)) continue
    if (newest === null || g.at > newest.at) newest = { at: g.at, body: g.body ?? null }
  }
  if (newest === null) return { trust: 'untrusted', hash, body }
  return { trust: 'changed', hash, body, grantedBody: newest.body }
}

/** Re-read the body under `root` (the scope root) and check it: what each round does before it spawns anything. */
export async function checkTrust(root: string, cmd: BodyCommand, grants: TrustGrants): Promise<TrustCheck> {
  return trustOf(cmd, await readBody(root, cmd), grants)
}
