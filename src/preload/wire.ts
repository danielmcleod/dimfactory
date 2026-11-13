// The preload ⇄ main wire format: the command envelope carries the IPC
// protocol version, and main hands the initial ThemeState to the preload as a base64url JSON argument. Shared by
// main and the sandboxed preload, so it uses only web/Node-common globals (btoa, atob, TextEncoder) and no zod.
import type { Accent, Theme } from '../shared/config-schema.ts'
import type { Cmd, CmdEnvelope, ResolvedTheme, ThemeState } from '../shared/ipc.ts'
import { IPC_PROTOCOL } from '../shared/ipc.ts'
import { BRAND } from '../shared/brand.ts'

/** CmdEnvelope plus the protocol version; main rejects any other version. */
export interface WireEnvelope extends CmdEnvelope {
  v: number
}

export function makeEnvelope(cmd: Cmd, req: unknown, cid: string): WireEnvelope {
  return { v: IPC_PROTOCOL, cmd, req, cid }
}

export const THEME_ARG_PREFIX = `--${BRAND.slug}-theme=`

/** Kept in step with config-schema's THEMES / ACCENTS without importing it (that module pulls in zod). */
const THEMES = ['light', 'dark', 'system'] as const satisfies readonly Theme[]
const ACCENTS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet'] as const satisfies readonly Accent[]
const RESOLVED = ['light', 'dark'] as const satisfies readonly ResolvedTheme[]

export const FALLBACK_THEME: ThemeState = { theme: 'system', resolved: 'light', accent: 'slate' }

function toBase64Url(text: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function isThemeState(v: unknown): v is ThemeState {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    (THEMES as readonly unknown[]).includes(r['theme']) &&
    (RESOLVED as readonly unknown[]).includes(r['resolved']) &&
    (ACCENTS as readonly unknown[]).includes(r['accent'])
  )
}

export function encodeThemeArg(s: ThemeState): string {
  return (
    THEME_ARG_PREFIX + toBase64Url(JSON.stringify({ theme: s.theme, resolved: s.resolved, accent: s.accent }))
  )
}

/** The ThemeState passed on the command line, or null when absent or malformed. */
export function decodeThemeArg(argv: readonly string[]): ThemeState | null {
  const arg = argv.find((a) => a.startsWith(THEME_ARG_PREFIX))
  if (arg === undefined) return null
  try {
    const v: unknown = JSON.parse(fromBase64Url(arg.slice(THEME_ARG_PREFIX.length)))
    return isThemeState(v) ? { theme: v.theme, resolved: v.resolved, accent: v.accent } : null
  } catch {
    return null
  }
}
