// What is installed that an Easy template may need: Node.js and Python, looked up on PATH (the same resolved PATH the
// vendor CLIs and Verify use). On Windows the Microsoft Store's "python" stubs under WindowsApps open the Store instead
// of running Python, so they do not count.
// Node.js counts only when it is new enough for Vite (the React templates build with it): its version is read with
// `node --version` (no shell, a short time limit, kept for a minute so the confirm screen does not wait each time;
// "Check again" reads it afresh). A Node.js that is there but older is reported as such, so Easy can say so plainly.
import type { EasyToolchain } from '../../shared/easy.ts'
import { findOnPath } from '../proc/resolve-cli.ts'
import { execCapture } from '../proc/spawn.ts'

const STORE_STUB = /[\\/]WindowsApps[\\/]/i

/** The oldest Node.js Vite runs on: 20.19 in the 20 line, else 22.12 or newer (Vite's own `engines`). */
export function nodeMeetsVite(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (m === null) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major === 20) return minor >= 19
  if (major === 22) return minor >= 12
  return major > 22
}

/** How long a read version is kept. */
export const NODE_VERSION_TTL_MS = 60_000
const NODE_VERSION_TIMEOUT_MS = 5000

const versionCache = new Map<string, { at: number; version: string | null }>()

/** Forget the versions read so far (the confirm screen's "Check again"). */
export function forgetNodeVersions(): void {
  versionCache.clear()
}

/** `node --version` of one executable (null: it gave none in time, or it is a script that needs a shell to run). */
export async function readNodeVersion(path: string, now = Date.now()): Promise<string | null> {
  const hit = versionCache.get(path)
  if (hit !== undefined && now - hit.at < NODE_VERSION_TTL_MS) return hit.version
  // A .cmd or .bat shim needs cmd.exe: it is not run here, and counts as found with no version read.
  if (/\.(?:cmd|bat)$/i.test(path)) return null
  const r = await execCapture(path, ['--version'], { timeoutMs: NODE_VERSION_TIMEOUT_MS })
  const version = r.code === 0 ? (/v?(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null
  versionCache.set(path, { at: now, version })
  return version
}

export interface ToolchainLookup {
  /** PATH entries in search order. */
  entries: readonly string[]
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  /** Test seam. */
  isFile?: (path: string) => boolean
  /** Test seam: the version of a Node.js executable (default: readNodeVersion). */
  nodeVersion?: (path: string) => Promise<string | null>
}

/** Which toolchains are on PATH, and whether Node.js is new enough for the templates that build with Vite. */
export async function detectToolchain(o: ToolchainLookup): Promise<EasyToolchain> {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const find = (bin: string): string[] =>
    findOnPath(bin, o.entries, platform, env, ...(o.isFile !== undefined ? [o.isFile] : []))
  const real = (hits: string[]): string[] => hits.filter((h) => platform !== 'win32' || !STORE_STUB.test(h))
  const node = real(find('node'))[0]
  const python = real([...find('python3'), ...find('python'), ...(platform === 'win32' ? find('py') : [])])
  if (node === undefined) return { node: false, python: python.length > 0, nodeVersion: null }
  const version = await (o.nodeVersion ?? readNodeVersion)(node).catch(() => null)
  // A Node.js whose version could not be read (a shim) is taken as it is: the project's own checks will tell.
  const old = version !== null && !nodeMeetsVite(version)
  return {
    node: !old,
    python: python.length > 0,
    nodeVersion: version,
    ...(old ? { nodeOld: true } : {}),
  }
}

/**
 * The toolchain an E2E test asks for (DIM_FACTORY_E2E_NODE): `none` (Node.js is not installed), or a version (Node.js
 * is installed at that version). Undefined: the machine's own is looked up.
 */
export function e2eToolchain(node: string | undefined, python: boolean): EasyToolchain | undefined {
  if (node === undefined || node === '') return undefined
  if (node === 'none') return { node: false, python, nodeVersion: null }
  const old = !nodeMeetsVite(node)
  return { node: !old, python, nodeVersion: node, ...(old ? { nodeOld: true } : {}) }
}
