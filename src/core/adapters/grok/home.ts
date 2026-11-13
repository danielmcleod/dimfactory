// Where Grok keeps its own files (Grok Build user guide 02 and 17, read 2026-10-11): the home
// `$GROK_HOME` (default `~/.grok`), the sign-in `auth.json` in it, and sessions in `sessions/<encoded cwd>/<id>/`.
// Dim Factory only checks that files exist and lists folder names; it never opens a credential file.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'

/** `$GROK_HOME`, else `<home>/.grok`. */
export function grokHome(env: EnvInput, home: string = homedir()): string {
  const v = getEnv(env, 'GROK_HOME')
  return v !== undefined && v.trim() !== '' ? v : join(home, '.grok')
}

/** The cached sign-in (`grok login`). Its existence is checked; its contents are never read. */
export function grokAuthFile(env: EnvInput, home?: string): string {
  return join(grokHome(env, home), 'auth.json')
}

export const hasCachedSignIn = (env: EnvInput, home?: string): boolean => {
  try {
    return statSync(grokAuthFile(env, home)).isFile()
  } catch {
    return false
  }
}

/** Grok's session ids are UUIDs (UUIDv7 when Grok makes them; a client-chosen `--session-id` must be a UUID too). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const dirs = (p: string): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * canResume's token-free look: Grok records a session in
 * `<grok home>/sessions/<the URL-encoded cwd, or a slug and hash>/<session id>/`. undefined when Dim Factory cannot tell
 * (no sessions folder at all), so session/load decides; false when sessions exist and none is this one, or the id is
 * not a UUID. Only folder names are read, never a file.
 */
export function grokSessionExists(o: {
  sessionId: string
  env: EnvInput
  home: string
}): boolean | undefined {
  if (!SESSION_ID.test(o.sessionId)) return false
  const root = join(grokHome(o.env, o.home), 'sessions')
  if (!existsSync(root)) return undefined
  const id = o.sessionId.toLowerCase()
  return dirs(root).some((group) => dirs(join(root, group)).some((s) => s.toLowerCase() === id))
}
