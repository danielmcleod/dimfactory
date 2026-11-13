// How to find and validate the Muse Code CLI (Muse "bin: resolve",
// "version: record"). The official installer (dev.meta.ai/install.ps1 | install.sh) puts a native binary named `muse` on
// the PATH; its exact folder is not documented, so the resolver's PATH search is what finds it.
import { posix, win32 } from 'node:path'
import type { CliSpec, CliSpecContext } from '../../proc/resolve-cli.ts'

export const MUSE_VENDOR = 'muse'
export const MUSE_DISPLAY_NAME = 'Muse'

const SEMVER = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`
/** `muse 1.4.2-R3401.1`, `Muse Code 1.4.2`, `muse-code v1.4.2`: the product named before the version. */
const NAMED = new RegExp(String.raw`\bmuse(?:[ -]code)?\b[^\d\r\n]{0,20}v?${SEMVER}`, 'i')
/**
 * A bare version line with Muse's release suffix (`1.4.2-R3401.1`, also seen as `1.3.0-R3401.1`, the SDK's
 * `0.1.0-R708.1`). A bare semver alone does not identify the product.
 */
const BARE_RELEASE = /^\s*v?(\d+\.\d+\.\d+-R\d+(?:\.\d+)*)\s*$/m

export function parseMuseVersion(stdout: string): { version: string } | null {
  const named = NAMED.exec(stdout)
  if (named?.[1] !== undefined) return { version: named[1] }
  const bare = BARE_RELEASE.exec(stdout)
  return bare?.[1] === undefined ? null : { version: bare[1] }
}

/**
 * Where an installer commonly puts a native CLI in the user's home (a guess the resolver validates like any other
 * candidate; PATH and the configured path come first or after as resolve-cli orders them).
 */
export function museWellKnown(ctx: Pick<CliSpecContext, 'platform' | 'home'>): string[] {
  return ctx.platform === 'win32'
    ? [win32.join(ctx.home, '.local', 'bin', 'muse.exe')]
    : [posix.join(ctx.home, '.local', 'bin', 'muse')]
}

export const museCliSpec: CliSpec = {
  vendor: MUSE_VENDOR,
  bin: 'muse',
  wellKnown: museWellKnown,
  versionArgs: ['--version'],
  parseVersion: (stdout) => parseMuseVersion(stdout),
}
