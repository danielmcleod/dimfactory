// Verify commands (commands and trust; Settings → Isolation & Verify):
// `verify.detect` answers the folder's configured and detected verify commands with their trust state; a
// `trust.set` command grant for a verify command gets the script body its hash covers, read now (verifyGrantBody), and
// its revoke removes the command's grants for older bodies too (otherVerifyGrantBodies).
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { TrustGrantInput, TrustGrants } from '../shared/ipc.ts'
import { normalizeCwdRel } from './config/trust.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import { detectVerifyCommands } from './verify/detect.ts'
import { readCommandBody } from './verify/discover.ts'
import { commandHash } from './verify/trust.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * The body a verify command grant covers, read under the folder's scope root as the round will read it. Granting
 * with the hash the user was shown (verify.detect) refuses a body that changed since (CONFLICT): a grant only ever
 * trusts text the user saw. A revoke never widens trust, so it is not checked.
 */
export async function verifyGrantBody(
  scopeRoot: string,
  grant: Extract<TrustGrantInput, { kind: 'command' }>,
  granting: boolean,
): Promise<string | undefined> {
  const c = grant.command
  if (c.kind !== 'verify') return undefined
  const read = await readCommandBody(scopeRoot, { argv: c.argv, cwdRel: c.cwdRel })
  // A command trust cannot cover (another package's scripts, an include only make can name) is never granted.
  if (granting && read.error !== undefined) throw new DimFactoryError('VALIDATION', read.error)
  const body = read.body
  if (granting && c.hash !== undefined && commandHash({ argv: c.argv, cwdRel: c.cwdRel }, body) !== c.hash) {
    throw new DimFactoryError(
      'CONFLICT',
      'This command changed since it was shown (its script is different now); review it and trust it again',
    )
  }
  return body ?? undefined
}

/**
 * Settings → Isolation & Verify [Untrust]: the bodies of older grants for the same verify command (argv and cwd)
 * that the revoke of the current body leaves. An Untrust means the command is not trusted any more: such a grant would
 * still make it read "changed since you trusted it" (a grant for another body exists), so the revoke removes them too.
 * `undefined` in the list: a grant without a body.
 */
export function otherVerifyGrantBodies(
  grants: TrustGrants,
  command: { argv: readonly string[]; cwdRel: string },
  body: string | undefined,
): (string | undefined)[] {
  const cwdRel = normalizeCwdRel(command.cwdRel)
  const out: (string | undefined)[] = []
  for (const g of Object.values(grants.commands ?? {})) {
    if (g.kind !== 'verify' || normalizeCwdRel(g.cwdRel) !== cwdRel) continue
    if (g.argv.length !== command.argv.length || g.argv.some((a, i) => a !== command.argv[i])) continue
    if (g.body !== body) out.push(g.body)
  }
  return out
}

export function verifyHandlers(ctx: HandlerContext): HandlerMap {
  return {
    'verify.detect': async (req) => {
      const f = isObj(req) ? req['folder'] : undefined
      if (typeof f !== 'string' || f.trim() === '')
        throw new DimFactoryError('VALIDATION', 'folder is required')
      const folder = isAbsolute(f) ? f : resolve(f)
      const isDir = await stat(folder).then(
        (s) => s.isDirectory(),
        () => false,
      )
      if (!isDir) throw new DimFactoryError('NOT_FOUND', `The folder ${folder} does not exist`)
      const [trust, snap] = await Promise.all([ctx.config.trustGet(folder), ctx.config.snapshot({ folder })])
      return detectVerifyCommands({
        folder,
        scopeRoot: trust.scopeRoot,
        configured: snap.config?.verify.commands ?? [],
        grants: trust.grants,
      })
    },
  }
}
