// Folder trust for ACP vendors that refuse an untrusted folder (Gemini's --skip-trust only with the trust.json
// `vendorFolder` grant or for Dim Factory-owned cwds such as probe-cwd and heal; readiness `trust`).
// A user folder needs the user's one-time grant; Dim Factory's own working folders under DIM_FACTORY_HOME need none.
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { homePaths } from '../../home.ts'

function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const same = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/**
 * A working folder Dim Factory made for itself (never the user's files): the probe folder and run-less heals under
 * `<home>/tmp`, a run's heal folder `<home>/runs/<id>/heal`, and catalog refresh jobs under `<home>/catalog/jobs`.
 * Isolated-run worktrees (`<home>/worktrees`) are copies of the user's project: they are NOT Dim Factory-owned.
 */
export function isDimFactoryOwnedCwd(cwd: string, dimFactoryHome: string): boolean {
  const c = real(cwd)
  const hp = homePaths(real(dimFactoryHome))
  if (same(c, hp.tmpDir) || inside(c, hp.tmpDir)) return true
  if (inside(c, hp.catalogJobsDir)) return true
  const rel = relative(hp.runsDir, c)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]/)
  return parts.length >= 2 && same(parts[1]!, 'heal')
}

/** Whether a folder may run without the vendor's own trust prompt, and why (for the readiness check's text). */
export type TrustDecision = { trusted: true; why: 'grant' | 'owned' | 'engine' } | { trusted: false }

/**
 * The vendor may skip its own folder trust for `cwd`: the engine says the run's folder is granted (`trustFolder`), the
 * folder is Dim Factory's own, or trust.json holds the user's `vendorFolder` grant for this vendor. A lookup that fails
 * grants nothing (fail closed).
 */
export async function folderTrust(o: {
  cwd: string
  vendor: string
  dimFactoryHome: string
  engineTrusted: boolean
  granted: (cwd: string, vendor: string) => Promise<boolean>
}): Promise<TrustDecision> {
  if (isDimFactoryOwnedCwd(o.cwd, o.dimFactoryHome)) return { trusted: true, why: 'owned' }
  if (o.engineTrusted) return { trusted: true, why: 'engine' }
  try {
    if (await o.granted(o.cwd, o.vendor)) return { trusted: true, why: 'grant' }
  } catch {
    // fail closed
  }
  return { trusted: false }
}
