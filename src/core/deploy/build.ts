// "Get it ready to share" (the Deploy panel and Easy's Share it): run the project's own `build` script, the one its
// package.json defines, so the folder a host serves (dist/ for a React site) is there and current for the upload file
// and the copyable deploy steps. It runs only as a trusted command, exactly as Verify runs one (the same grant: a
// project whose Verify already ran its build is trusted for it), or under Easy's project permission; otherwise the
// caller gets the script to show and a hash to trust it with. Nothing runs on its own.
import type { TrustGrants } from '../../shared/ipc.ts'
import type { DeployBuildResult } from '../../shared/deploy.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'
import { displayArgv } from '../verify/argv.ts'
import { detectPackageManager, readCommandBody } from '../verify/discover.ts'
import { trustOf } from '../verify/trust.ts'
import type { TrustCheck } from '../verify/trust.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The command's name in the logs and the trust grant (Verify's name for a build). */
export const BUILD_COMMAND_NAME = 'build'

/** The project's build command (`npm run build`, by its package manager), when package.json has a build script. */
export async function buildCommandOf(folder: string): Promise<{ argv: string[]; display: string } | null> {
  let scripts: unknown
  try {
    const pkg = JSON.parse(
      (await readFile(join(folder, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''),
    ) as unknown
    scripts =
      typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>)['scripts'] : undefined
  } catch {
    return null
  }
  if (typeof scripts !== 'object' || scripts === null) return null
  const build = (scripts as Record<string, unknown>)['build']
  if (typeof build !== 'string' || build.trim() === '') return null
  const pm = await detectPackageManager(folder, folder)
  const argv = [pm, 'run', 'build']
  return { argv, display: displayArgv(argv) }
}

/** How the build command stands against the folder's grants (Verify's own check), with the script it runs. */
export async function buildTrust(
  scopeRoot: string,
  cmd: { argv: readonly string[]; cwdRel: string },
  grants: TrustGrants,
): Promise<TrustCheck & { error?: string }> {
  const body = await readCommandBody(scopeRoot, { argv: cmd.argv, cwdRel: cmd.cwdRel })
  const t = trustOf({ argv: cmd.argv, cwdRel: cmd.cwdRel }, body.body, grants)
  return body.error !== undefined ? { ...t, error: body.error } : t
}

/** What a finished build command means for the user: built, or failed with the end of its output. */
export function buildResultOf(r: VerifyCommandResult, dir: string): DeployBuildResult {
  if (r.status === 'pass') return { status: 'built', dir, durationMs: r.durationMs }
  const reason =
    r.status === 'env'
      ? `The build could not run: ${r.reason ?? 'something it needs is missing'}. Install the project first (npm install), then try again.`
      : r.status === 'fail'
        ? `The build failed${r.reason !== undefined ? `: ${r.reason}` : ''}. The end of its output is below.`
        : `The build did not run: ${r.reason ?? 'it was stopped'}.`
  return { status: 'failed', reason, excerpt: r.excerpt }
}
