// Deps install trust (kind `deps` grants in trust.json; a worktree
// has another folder key, so grants are read from and written to the SOURCE folder). A `deps` grant's hash is
// sha256(JSON{kind:'deps', argv, cwdRel, body}); the body names every command that runs first and the sha256 of each
// file the install reads (the lockfile and manifests: a changed lockfile asks for consent again), plus, for a command
// that runs package scripts or make, the text a verify grant hashes for it. Digests, not texts, keep trust.json small.
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GrantCommand } from '../../shared/failure.ts'
import type { TrustGrants, TrustState } from '../../shared/ipc.ts'
import { commandGrantHash, coveredByProject, grantTrust, normalizeCwdRel } from '../config/trust.ts'
import type { TrustOptions } from '../config/trust.ts'
import { displayArgv } from '../verify/argv.ts'
import { cwdRelOf, readCommandBody } from '../verify/discover.ts'
import type { DepsPlan } from './detectDeps.ts'

/** A source file larger than this is named by its size alone (no install reads a lockfile that big). */
const MAX_HASH_BYTES = 256 * 1024 * 1024

/** sha256 of a file's bytes; text (no NUL byte) with CRLF read as LF, so a checkout's line endings do not matter. */
function digestOf(bytes: Buffer): string {
  const text = !bytes.includes(0)
  const data = text ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes
  return createHash('sha256').update(data).digest('hex')
}

/** One body line per source: `file <rel> sha256 <hex>`, or why it could not be read. Never follows a link. */
async function sourceLine(root: string, rel: string): Promise<string> {
  const abs = resolve(root, rel)
  if (cwdRelOf(root, abs) === null) return `file ${rel} outside the project`
  const st = await lstat(abs).catch(() => null)
  if (st === null) return `file ${rel} missing`
  if (st.isSymbolicLink()) return `file ${rel} is a link`
  if (!st.isFile()) return `file ${rel} is not a file`
  if (st.size > MAX_HASH_BYTES) return `file ${rel} ${st.size} bytes`
  const bytes = await readFile(abs).catch(() => null)
  return bytes === null ? `file ${rel} unreadable` : `file ${rel} sha256 ${digestOf(bytes)}`
}

export type DepsBodyRead = { body: string; error?: undefined } | { body: null; error: string }

/**
 * The text a `deps` grant's hash covers, read now under `root` (the scope root: the worktree's for an install, the
 * source folder's in preflight). `error`: trust cannot cover what the command runs (a package-manager option that
 * picks another package's scripts, an include only make can name), so it never runs.
 */
export async function readDepsBody(root: string, plan: DepsPlan): Promise<DepsBodyRead> {
  const lines: string[] = []
  for (const step of plan.setup ?? []) lines.push(`step ${displayArgv(step)}`)
  for (const rel of plan.sources) lines.push(await sourceLine(root, rel))
  if (plan.manager === 'custom') {
    // A configured command may be `npm run setup` or `make deps`: what it runs is the verify body.
    const read = await readCommandBody(root, { argv: plan.argv, cwdRel: plan.cwdRel })
    if (read.error !== undefined) return { body: null, error: read.error }
    if (read.body !== null) lines.push('script', read.body)
  }
  return { body: lines.join('\n') }
}

/** What a `deps` grant for this plan trusts (the command grant shape). */
export function depsGrantCommand(plan: Pick<DepsPlan, 'argv' | 'cwdRel'>, body: string): GrantCommand {
  return { kind: 'deps', argv: [...plan.argv], cwdRel: normalizeCwdRel(plan.cwdRel), body }
}

/** The grant key: sha256(JSON{kind:'deps', argv, cwdRel, body}). */
export function depsHash(plan: Pick<DepsPlan, 'argv' | 'cwdRel'>, body: string): string {
  return commandGrantHash(depsGrantCommand(plan, body))
}

export interface DepsTrustCheck {
  trust: 'trusted' | 'untrusted' | 'changed'
  hash: string
  body: string
  /** `changed`: the body the newest `deps` grant for the same command and folder covers. */
  grantedBody?: string | null
  /** Trusted only by an Easy run's project permission (the install reads the project's own manifest). */
  via?: 'project'
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** How the plan with this body stands against the source folder's grants. Auto never implies trust. */
export function depsTrustOf(
  plan: Pick<DepsPlan, 'argv' | 'cwdRel'>,
  body: string,
  grants: TrustGrants,
): DepsTrustCheck {
  const hash = depsHash(plan, body)
  const all = grants.commands ?? {}
  if (all[hash]?.kind === 'deps') return { trust: 'trusted', hash, body }
  if (coveredByProject(grants)) return { trust: 'trusted', hash, body, via: 'project' }
  const cwdRel = normalizeCwdRel(plan.cwdRel)
  let newest: { at: number; body: string | null } | null = null
  for (const g of Object.values(all)) {
    if (g.kind !== 'deps' || normalizeCwdRel(g.cwdRel) !== cwdRel || !sameArgv(g.argv, plan.argv)) continue
    if (newest === null || g.at > newest.at) newest = { at: g.at, body: g.body ?? null }
  }
  if (newest === null) return { trust: 'untrusted', hash, body }
  return { trust: 'changed', hash, body, grantedBody: newest.body }
}

export type DepsTrustRead = DepsTrustCheck | { trust: 'invalid'; error: string }

/** Read the body under `root` and check it: what an install does right before it spawns anything. */
export async function checkDepsTrust(
  root: string,
  plan: DepsPlan,
  grants: TrustGrants,
): Promise<DepsTrustRead> {
  const read = await readDepsBody(root, plan)
  if (read.error !== undefined) return { trust: 'invalid', error: read.error }
  return depsTrustOf(plan, read.body, grants)
}

/**
 * Record the `deps` grant for `body` (the depsConsent card's [Install]) in the SOURCE folder's trust entry: a worktree
 * has its own folder key, and the next run's worktree is another one again.
 */
export function grantDeps(
  sourceFolder: string,
  plan: Pick<DepsPlan, 'argv' | 'cwdRel'>,
  body: string,
  opts: TrustOptions = {},
): Promise<TrustState> {
  return grantTrust(sourceFolder, { kind: 'command', command: depsGrantCommand(plan, body) }, opts)
}
