// Shared setup for the process-layer integration tests: a fake-CLI CliSpec and resolved launchers.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import type { FakeCliBuild } from '../../../scripts/build-fake-cli.mjs'
import { sanitizeEnv } from '../../../src/core/proc/env.ts'
import { resolveCli } from '../../../src/core/proc/resolve-cli.ts'
import type { CliSpec, ResolvedCli } from '../../../src/core/proc/resolve-cli.ts'
import { isAlive } from '../../../src/core/proc/ps.ts'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
export const SHARED_FIXTURES = fileURLToPath(new URL('../../fixtures/fake/', import.meta.url))
export const fixture = (name: string): string => join(FIXTURES, name)
export const sharedFixture = (name: string): string => join(SHARED_FIXTURES, name)

export const isWin = process.platform === 'win32'
export const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']

/** Test CliSpec: the fake answers `--version` like Claude Code (scenario `version.script.jsonl`). */
export const fakeClaudeSpec: CliSpec = {
  vendor: 'claude',
  bin: 'claude',
  wellKnown: () => [],
  versionArgs: ['--version'],
  parseVersion: (out) => {
    const m = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/m.exec(out)
    return m?.[1] === undefined ? null : { version: m[1] }
  },
  rejectWindowsApps: true,
  minNode: '20.0.0',
}

/** The launcher a user install would expose: the npm-style .cmd shim on win32, the shebang copy on POSIX. */
export function installedLauncher(build: FakeCliBuild): string {
  const path = isWin ? build.launchers.cmd?.claude : build.launchers.sh?.claude
  if (path === undefined) throw new Error('fake CLI launcher missing for this OS')
  return path
}

export const nodeDir = dirname(process.execPath)
export const testPath = (build: FakeCliBuild): string => [build.dir, nodeDir].join(isWin ? ';' : ':')

let memo: Promise<{ build: FakeCliBuild; cli: ResolvedCli }> | undefined

/** Resolve the fake once per test file (validation spawns the fake's --version). */
export function resolveFake(): Promise<{ build: FakeCliBuild; cli: ResolvedCli }> {
  memo ??= resolveFakeWith()
  return memo
}

export async function resolveFakeWith(vendorEnv: Record<string, string> = {}): Promise<{
  build: FakeCliBuild
  cli: ResolvedCli
}> {
  const build = await buildFakeCli()
  const r = await resolveCli(fakeClaudeSpec, {
    configuredPath: installedLauncher(build),
    pathEnv: testPath(build),
    npmPrefixes: [],
    vendorEnv: { FAKE_CLI_SCRIPT: join(FIXTURES, 'scenario'), ...vendorEnv },
  })
  if (!r.ok) throw new Error(`fake CLI did not resolve: ${JSON.stringify(r.rejected)}`)
  return { build, cli: r.cli }
}

export function vendorEnv(
  build: FakeCliBuild,
  cli: ResolvedCli,
  extra: Record<string, string>,
): Record<string, string> {
  return sanitizeEnv(process.env, {
    purpose: 'vendor',
    vendor: 'claude',
    path: testPath(build),
    pathPrepend: cli.pathPrepend,
    vendorEnv: extra,
  })
}

export function plainEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v
  return out
}

export const real = (p: string): string => {
  const r = realpathSync.native(p)
  return isWin ? r.toLowerCase() : r
}

export async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await delay(50)
  }
  return !isAlive(pid)
}

/** Best-effort cleanup for a test that failed before killing what it spawned. */
export function forceKill(pid: number | undefined): void {
  if (pid === undefined || !isAlive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // gone
  }
}

/** Pull lines one by one from an async iterable. */
export function lineReader(lines: AsyncIterable<string>): (timeoutMs?: number) => Promise<string> {
  const it = lines[Symbol.asyncIterator]()
  return async (timeoutMs = 10_000) => {
    const timer = delay(timeoutMs, 'timeout' as const, { ref: false })
    const r = await Promise.race([it.next(), timer])
    if (r === 'timeout') throw new Error(`no line within ${timeoutMs} ms`)
    if (r.done === true) throw new Error('stream ended')
    return r.value
  }
}
