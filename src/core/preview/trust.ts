// Preview command trust (trust.json): a `commands` grant of kind `preview`, keyed
// sha256(JSON{kind:'preview', argv, cwdRel, body}). The body is what decides what the command runs, read whole:
// a package manager's `scripts` map (verify's readCommandBody), or a `docker compose` command's compose files. A
// preview grant is its own: trusting `npm run dev` for Verify does not trust it as a preview, nor the other way round.
// Bodies are read again before every start; a changed body needs a new grant.
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GrantCommand } from '../../shared/failure.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { PreviewTrust } from '../../shared/preview.ts'
import { commandGrantHash, coveredByProject, normalizeCwdRel } from '../config/trust.ts'
import { programName, readCommandBody } from '../verify/discover.ts'
import type { BodyRead } from '../verify/discover.ts'

export interface PreviewBodyCommand {
  argv: readonly string[]
  cwdRel: string
}

/** The compose files `docker compose` reads in a folder without `-f`: the first base file, then its override. */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const
const COMPOSE_OVERRIDES: Readonly<Record<string, string[]>> = {
  'compose.yaml': ['compose.override.yaml', 'compose.override.yml'],
  'compose.yml': ['compose.override.yml', 'compose.override.yaml'],
  'docker-compose.yaml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
  'docker-compose.yml': ['docker-compose.override.yml', 'docker-compose.override.yaml'],
}
const MAX_COMPOSE_BYTES = 1024 * 1024

async function readSmall(p: string): Promise<string | null> {
  try {
    const s = await stat(p)
    if (!s.isFile() || s.size > MAX_COMPOSE_BYTES) return null
    return (await readFile(p, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** `docker compose …` / `docker-compose …`: the args after the compose command; null for anything else. */
export function composeArgs(argv: readonly string[]): readonly string[] | null {
  const prog = programName(argv[0] ?? '')
  if (prog === 'docker-compose') return argv.slice(1)
  if (prog === 'docker' && argv[1] === 'compose') return argv.slice(2)
  return null
}

/** Compose's global options that take a value (`-f compose.yml`, `-p name`): they stay with the `down`. */
const COMPOSE_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--project-directory',
  '--env-file',
  '--ansi',
  '--progress',
  '--parallel',
])

/**
 * The `docker compose down` for a compose preview command: the same program and global options (its compose files and
 * project name), then `down`. Null when `argv` is not a compose command.
 */
export function composeDownArgv(argv: readonly string[]): string[] | null {
  const args = composeArgs(argv)
  if (args === null) return null
  const globals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (!a.startsWith('-')) break
    globals.push(a)
    if (COMPOSE_VALUE_OPTIONS.has(a) && i + 1 < args.length) globals.push(args[++i] ?? '')
  }
  return [...argv.slice(0, argv.length - args.length), ...globals, 'down']
}

/** The compose files a compose command reads in `cwd` (its `-f` files, else the default one and its override). */
async function composeBody(cwd: string, args: readonly string[]): Promise<BodyRead> {
  const named: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-f' || a === '--file') named.push(args[++i] ?? '')
    else if (a.startsWith('--file=')) named.push(a.slice('--file='.length))
    else if (a === '--project-directory' || a.startsWith('--project-directory=') || a === '--env-file') {
      return {
        body: null,
        error:
          'This compose command reads files from another folder, which Dim Factory cannot show you to trust: run it from the folder that holds its compose file',
      }
    }
  }
  const files: string[] = []
  if (named.length > 0) files.push(...named)
  else {
    for (const name of COMPOSE_FILES) {
      if ((await readSmall(join(cwd, name))) === null) continue
      files.push(name)
      for (const o of COMPOSE_OVERRIDES[name] ?? []) {
        if ((await readSmall(join(cwd, o))) !== null) {
          files.push(o)
          break
        }
      }
      break
    }
  }
  if (files.length === 0) return { body: null }
  const parts: string[] = []
  for (const f of files) {
    const text = await readSmall(resolve(cwd, f))
    parts.push(`# ---- ${f}${text === null ? ' (not found)' : ''} ----`)
    if (text !== null) parts.push(text.endsWith('\n') ? text.slice(0, -1) : text)
  }
  return { body: parts.join('\n') }
}

/**
 * The text a preview command's trust hash covers, read now under `root` (the scope root): verify's body for a package
 * manager or make, the compose files for `docker compose`, null for a fixed tool command (its argv says what it runs).
 */
export async function readPreviewBody(root: string, cmd: PreviewBodyCommand): Promise<BodyRead> {
  const compose = composeArgs(cmd.argv)
  if (compose !== null) return composeBody(resolve(root, cmd.cwdRel), compose)
  return readCommandBody(root, { argv: cmd.argv, cwdRel: cmd.cwdRel })
}

/** What a `command` grant for this preview command trusts. */
export function previewGrantCommand(cmd: PreviewBodyCommand, body: string | null): GrantCommand {
  return {
    kind: 'preview',
    argv: [...cmd.argv],
    cwdRel: normalizeCwdRel(cmd.cwdRel),
    ...(body !== null ? { body } : {}),
  }
}

/** sha256(JSON{kind:'preview', argv, cwdRel, body}). */
export function previewHash(cmd: PreviewBodyCommand, body: string | null): string {
  return commandGrantHash(previewGrantCommand(cmd, body))
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** How a preview command with this body stands against the folder's grants. */
export function previewTrustOf(
  cmd: PreviewBodyCommand,
  body: string | null,
  grants: TrustGrants,
): { trust: Exclude<PreviewTrust, 'none'>; hash: string; via?: 'project' } {
  const hash = previewHash(cmd, body)
  const all = grants.commands ?? {}
  if (all[hash]?.kind === 'preview') return { trust: 'trusted', hash }
  // An Easy run's project permission: the project's own preview command, in its own folder.
  if (coveredByProject(grants)) return { trust: 'trusted', hash, via: 'project' }
  const cwdRel = normalizeCwdRel(cmd.cwdRel)
  const earlier = Object.values(all).some(
    (g) => g.kind === 'preview' && normalizeCwdRel(g.cwdRel) === cwdRel && sameArgv(g.argv, cmd.argv),
  )
  return { trust: earlier ? 'changed' : 'untrusted', hash }
}

/** The bodies of the grants for the same preview command (argv and cwd) other than `body` (an Untrust removes them). */
export function otherPreviewGrantBodies(
  grants: TrustGrants,
  cmd: PreviewBodyCommand,
  body: string | undefined,
): (string | undefined)[] {
  const cwdRel = normalizeCwdRel(cmd.cwdRel)
  return Object.values(grants.commands ?? {})
    .filter((g) => g.kind === 'preview' && normalizeCwdRel(g.cwdRel) === cwdRel && sameArgv(g.argv, cmd.argv))
    .map((g) => g.body)
    .filter((b) => b !== body)
}
