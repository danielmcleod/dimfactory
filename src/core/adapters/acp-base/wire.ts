// What the ACP base reads off the wire. Every incoming frame is read
// defensively with the readers below: the vendored schema (protocol/, typed in protocol.ts) says what is expected,
// never what is trusted. The method names are the schema's own (meta.json `agentMethods` / `clientMethods`).
import type { PermissionOption, PermissionOptionKind } from './protocol.ts'

export type Rec = Record<string, unknown>

export const rec = (v: unknown): Rec | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Agent methods the client calls, and client methods the agent calls (ACP meta.json). */
export const M = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionResume: 'session/resume',
  sessionSetMode: 'session/set_mode',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  cancelRequest: '$/cancel_request',
} as const

const OPTION_KINDS: readonly string[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always']

/**
 * The options of a permission request, read defensively: one without an id or a known kind is dropped, and so is
 * every option whose id the request offers more than once. The agent maps the answer back by id alone, so an id shared
 * with any other entry (one of an unknown or missing kind included, e.g. a future `allow_forever`) could be read as
 * that entry: such an id is never chosen. The ids are counted over the raw list, before anything is
 * dropped.
 */
export function permissionOptions(v: unknown): PermissionOption[] {
  const raw = arr(v).map(rec)
  const seen = new Map<string, number>()
  for (const r of raw) {
    const id = str(r?.['optionId'])
    if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  const out: PermissionOption[] = []
  for (const r of raw) {
    const optionId = str(r?.['optionId'])
    const kind = str(r?.['kind'])
    if (optionId === undefined || optionId === '' || kind === undefined || !OPTION_KINDS.includes(kind))
      continue
    if ((seen.get(optionId) ?? 0) > 1) continue
    out.push({ optionId, name: str(r?.['name']) ?? '', kind: kind as PermissionOptionKind })
  }
  return out
}

/** The text of a ContentBlock (`{type:'text', text}`), else undefined. */
export function contentText(v: unknown): string | undefined {
  const r = rec(v)
  return str(r?.['type']) === 'text' ? str(r?.['text']) : undefined
}
