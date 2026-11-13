// Where Gemini keeps its own files (`~/.gemini/oauth_creds.json`,
// sessions in `~/.gemini/tmp/<project>/chats/`, plan files in `~/.gemini/tmp/<project>/<session>/plans/`). Dim Factory
// only checks that files exist and lists folder names; it never reads a credential file. `GEMINI_CLI_HOME` (when the
// CLI honours it) replaces the home folder, as Dim Factory's tests do with an empty one.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'

/** `<GEMINI_CLI_HOME or home>/.gemini`. */
export function geminiDir(env: EnvInput, home: string = homedir()): string {
  const v = getEnv(env, 'GEMINI_CLI_HOME')
  return join(v !== undefined && v.trim() !== '' ? v : home, '.gemini')
}

/** The OAuth credentials file of a Google sign-in. Its existence is checked; its contents are never read. */
export function oauthCredsPath(env: EnvInput, home?: string): string {
  return join(geminiDir(env, home), 'oauth_creds.json')
}

export const hasOauthCreds = (env: EnvInput, home?: string): boolean => {
  try {
    return statSync(oauthCredsPath(env, home)).isFile()
  } catch {
    return false
  }
}

/** Gemini's own temp folder: plan mode writes its plan files under it (the only place a plan file is read from). */
export function geminiTmpDir(env: EnvInput, home?: string): string {
  return join(geminiDir(env, home), 'tmp')
}

const dirs = (p: string): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

const files = (p: string): string[] => {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Gemini's session ids are matched by its own validator (`/^[a-zA-Z0-9-_]+$/`, session/load). */
const SESSION_ID = /^[A-Za-z0-9_-]+$/

/**
 * canResume's token-free look: Gemini records a session in
 * `<gemini dir>/tmp/<project>/chats/session-<time>-<first 8 chars of the id>.json(l)`. undefined: Dim Factory cannot
 * tell (no chats folder at all, an id it does not know the shape of), so session/load decides; false: chats exist
 * and none is this session's. Only folder and file names are read, never a file's content.
 */
export function geminiSessionExists(o: {
  sessionId: string
  env: EnvInput
  home: string
}): boolean | undefined {
  if (!SESSION_ID.test(o.sessionId) || o.sessionId.length < 8) return false
  const tmp = geminiTmpDir(o.env, o.home)
  if (!existsSync(tmp)) return undefined
  const short = o.sessionId.slice(0, 8).toLowerCase()
  let sawChats = false
  for (const project of dirs(tmp)) {
    const chats = join(tmp, project, 'chats')
    const names = files(chats)
    if (names.length === 0 && !existsSync(chats)) continue
    sawChats = true
    if (names.some((n) => /\.jsonl?$/i.test(n) && n.toLowerCase().includes(short))) return true
  }
  return sawChats ? false : undefined
}
