// How to find and validate the Grok CLI (Grok bin "resolve", version "record").
// Grok Build ships a native binary named `grok` (xai-org/grok-build: xai-grok-pager, installed as `grok`); the
// PowerShell installer puts it in %USERPROFILE%\.grok\bin and adds that to the user's PATH (user guide 01, read
// 2026-10-11). Nothing here runs a shell or reads a credential file.
import { posix, win32 } from 'node:path'
import type { CliSpec, CliSpecContext } from '../../proc/resolve-cli.ts'

export const GROK_VENDOR = 'grok'
export const GROK_DISPLAY_NAME = 'Grok'

/**
 * `grok --version` prints `grok <version> (<commit>) <channel>` (xai-grok-pager-bin main.rs version_text). The product
 * name must lead the line: other CLIs named `grok` (community Grok CLIs on npm) print a bare version and are not this
 * one. The binary's own names (`xai-grok-pager`, `grok-pager`) count too.
 */
const VERSION_LINE =
  /^\s*(?:grok|xai-grok-pager|grok-pager)\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.-])/im

export function parseGrokVersion(stdout: string): { version: string } | null {
  const m = VERSION_LINE.exec(stdout)
  return m?.[1] === undefined ? null : { version: m[1] }
}

/** The installers' own folder (`~/.grok/bin`), and the user-level bin folder some POSIX installs use. */
export function grokWellKnown(ctx: Pick<CliSpecContext, 'platform' | 'home'>): string[] {
  return ctx.platform === 'win32'
    ? [win32.join(ctx.home, '.grok', 'bin', 'grok.exe')]
    : [posix.join(ctx.home, '.grok', 'bin', 'grok'), posix.join(ctx.home, '.local', 'bin', 'grok')]
}

export const grokCliSpec: CliSpec = {
  vendor: GROK_VENDOR,
  bin: 'grok',
  wellKnown: grokWellKnown,
  versionArgs: ['--version'],
  parseVersion: (stdout) => parseGrokVersion(stdout),
}
