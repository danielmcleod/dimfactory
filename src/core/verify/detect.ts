// `verify.detect` (Settings → Isolation & Verify: commands with trust state; the composer's
// "Verify: N commands"): the configured verify.commands first, then the detected ones not configured yet, each with
// its trust state against trust.json and where its program resolves.
import { posix, relative, resolve, sep } from 'node:path'
import type { VerifyCommandConfig } from '../../shared/config-schema.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { DetectedCommand, VerifyCommand } from '../../shared/verify.ts'
import { VERIFY_DEFAULT_TIMEOUT_MS } from '../../shared/verify.ts'
import { isBuiltinCheckArgv } from '../../shared/pageload.ts'
import { BUILTIN_COMMAND_PATH } from '../../shared/playtest.ts'
import { normalizeCwdRel } from '../config/trust.ts'
import { resolvePathEnv } from '../proc/path-env.ts'
import { configCommands, cwdRelOf, discoverCommands } from './discover.ts'
import { resolveCommand } from './resolve-cmd.ts'
import { commandHash, trustOf } from './trust.ts'

export interface DetectVerifyOptions {
  folder: string
  /** The scope root (cwdRel and grants are relative to it). Default: the folder. */
  scopeRoot?: string
  /** The resolved config's `verify.commands`. */
  configured: readonly VerifyCommandConfig[]
  /** The folder's grants (trust.get). */
  grants: TrustGrants
  /** The resolved PATH entries. Default: path-env's. */
  pathEntries?: readonly string[]
}

const sameCommand = (a: DetectedCommand, b: DetectedCommand): boolean =>
  normalizeCwdRel(a.cwdRel) === normalizeCwdRel(b.cwdRel) &&
  a.run.length === b.run.length &&
  a.run.every((x, i) => x === b.run[i])

export async function detectVerifyCommands(o: DetectVerifyOptions): Promise<VerifyCommand[]> {
  const folder = resolve(o.folder)
  const root = resolve(o.scopeRoot ?? o.folder)
  const [configured, detected] = await Promise.all([
    configCommands(o.configured, { folder, scopeRoot: root }),
    discoverCommands(folder, { scopeRoot: root }),
  ])
  const extra = detected.filter((d) => !configured.some((c) => c.run.length > 0 && sameCommand(c, d)))
  const pathEntries = o.pathEntries ?? (await resolvePathEnv()).entries
  // The folder's place in the scope root, compared by real name (the root is a real path; the folder may be spelled
  // with an 8.3 short name or under a linked temp folder), so a command's cwd reads from the folder whatever the spelling.
  const folderRel = cwdRelOf(root, folder)
  return [...configured, ...extra].map((c): VerifyCommand => {
    const argv0 = c.run[0]
    const resolved =
      argv0 === undefined
        ? null
        : isBuiltinCheckArgv(c.run)
          ? BUILTIN_COMMAND_PATH
          : (resolveCommand(argv0, { cwd: resolve(root, c.cwdRel), root, pathEntries })?.path ?? null)
    const fromFolder =
      folderRel !== null
        ? posix.relative(posix.join('/', folderRel), posix.join('/', normalizeCwdRel(c.cwdRel)))
        : relative(folder, resolve(root, c.cwdRel)).split(sep).join('/')
    const common = {
      ...c,
      id: `${c.source}:${normalizeCwdRel(c.cwdRel)}:${c.name}`,
      cwd: fromFolder === '' ? '.' : fromFolder,
      argv: [...c.run],
      timeoutMs: c.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS,
      resolved,
      configured: c.source === 'config',
    }
    if (c.error !== undefined) {
      return { ...common, hash: commandHash(c, c.body), trust: 'invalid', trusted: false }
    }
    const t = trustOf(c, c.body, o.grants)
    return {
      ...common,
      hash: t.hash,
      trust: t.trust,
      trusted: t.trust === 'trusted',
      ...(t.grantedBody !== undefined ? { grantedBody: t.grantedBody } : {}),
    }
  })
}
