// How to find and validate the Gemini CLI (any other JS entry runs as system `node <entry>`, never Electron's
// execPath; the Gemini bin check is "shim → system node ≥ 20"). The npm package
// @google/gemini-cli installs a `gemini.cmd` shim on Windows (a shebang script elsewhere) whose entry is a JS bundle.
import { posix } from 'node:path'
import type { CliSpec, CliSpecContext } from '../../proc/resolve-cli.ts'

export const GEMINI_VENDOR = 'gemini'
export const GEMINI_DISPLAY_NAME = 'Gemini'

/** `gemini --version` prints the bare version (`0.62.0`), possibly after warnings on other lines. */
const VERSION_LINE = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m

export function parseGeminiVersion(stdout: string): { version: string } | null {
  const m = VERSION_LINE.exec(stdout)
  return m?.[1] === undefined ? null : { version: m[1] }
}

/** No standalone installer: npm's global prefix and PATH find it. On POSIX the user-level npm prefix is common. */
export function geminiWellKnown(ctx: Pick<CliSpecContext, 'platform' | 'home'>): string[] {
  return ctx.platform === 'win32' ? [] : [posix.join(ctx.home, '.npm-global', 'bin', 'gemini')]
}

export const geminiCliSpec: CliSpec = {
  vendor: GEMINI_VENDOR,
  bin: 'gemini',
  wellKnown: geminiWellKnown,
  versionArgs: ['--version'],
  parseVersion: (stdout) => parseGeminiVersion(stdout),
  // @google/gemini-cli's engines field: Node.js 20 or newer.
  minNode: '20.0.0',
}
