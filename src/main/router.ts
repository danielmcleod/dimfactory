// The `dimf:cmd` pipeline after the sender check (ipc.ts: sender check + zod → core
// handlers): envelope → known command (e2e.* only under DIM_FACTORY_E2E=1) → request schema → main-owned handler or
// core.invoke. Pure: no Electron. Every path resolves to a Result; nothing throws to the renderer.
import { toResult } from '@core/errors.ts'
import type { Cmd, Req, Res, Result } from '@shared/ipc.ts'
import { COMMAND_AREA, IPC_PROTOCOL } from '@shared/ipc.ts'

/** Commands main answers itself (app shell, theme, E2E); the rest go to the core. */
export const MAIN_COMMANDS = [
  'app.info',
  'app.ready',
  'app.quit',
  'dialog.pickFolder',
  'dialog.pickFiles',
  'shell.open',
  'log.write',
  'diagnostics.build',
  'diagnostics.copy',
  'diagnostics.save',
  'events.focus',
  'state.get',
  'state.set',
  'ui.setTheme',
  'notifications.test',
  'notifications.repairShortcut',
  'e2e.state',
  'e2e.power',
  'e2e.clock',
  'mcp.addToEditor',
  'preview.open',
  'preview.openPair',
  'preview.smoke',
  'preview.savePdf',
  'preview.playtest',
  'preview.tryIt',
  'preview.shareCheck',
  'preview.phone',
] as const satisfies readonly Cmd[]
export type MainCmd = (typeof MAIN_COMMANDS)[number]

const MAIN_SET: ReadonlySet<string> = new Set(MAIN_COMMANDS)

export function isMainCommand(cmd: Cmd): cmd is MainCmd {
  return MAIN_SET.has(cmd)
}

/** Main-owned handlers; a main command without one (not built yet) answers UNSUPPORTED. */
export type MainHandlers = { [C in MainCmd]?: (req: Req<C>) => Promise<Res<C>> }

export const CMD_MAX = 64
export const CID_MAX = 128
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['v', 'cmd', 'req', 'cid'])

export interface ParsedEnvelope {
  cmd: string
  req: unknown
  cid: string
}

const fail = (
  code: 'VALIDATION' | 'FORBIDDEN' | 'UNKNOWN_COMMAND' | 'UNSUPPORTED' | 'INTERNAL',
  message: string,
) => ({ ok: false, error: { code, message } }) as const

/** The preload's WireEnvelope: {v, cmd, req, cid} and nothing else, v = IPC_PROTOCOL. */
export function checkEnvelope(raw: unknown): Result<ParsedEnvelope> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('VALIDATION', 'Malformed IPC envelope.')
  }
  const r = raw as Record<string, unknown>
  if (Object.keys(r).some((k) => !ENVELOPE_KEYS.has(k))) return fail('VALIDATION', 'Malformed IPC envelope.')
  if (r['v'] !== IPC_PROTOCOL) {
    return fail('VALIDATION', `IPC protocol mismatch: expected ${IPC_PROTOCOL}. Restart Dim Factory.`)
  }
  const { cmd, cid } = r
  if (typeof cmd !== 'string' || cmd === '' || cmd.length > CMD_MAX) {
    return fail('VALIDATION', 'Malformed IPC envelope: cmd.')
  }
  if (typeof cid !== 'string' || cid.length > CID_MAX)
    return fail('VALIDATION', 'Malformed IPC envelope: cid.')
  return { ok: true, value: { cmd, req: r['req'], cid } }
}

export interface RouterDeps {
  /** DIM_FACTORY_E2E=1: the e2e.* commands exist. */
  e2e: boolean
  /** ipc-schemas `parseRequest`. */
  parse: (cmd: Cmd, raw: unknown) => Result<unknown>
  main: MainHandlers
  core: (cmd: Cmd, req: unknown) => Promise<Result<unknown>>
  /** Called for every failed command (logging). */
  onFailure?: (
    cmd: string,
    cid: string | undefined,
    error: Extract<Result<unknown>, { ok: false }>['error'],
  ) => void
}

export type Router = (senderOk: boolean, raw: unknown) => Promise<Result<unknown>>

export function createRouter(d: RouterDeps): Router {
  const route = async (
    senderOk: boolean,
    raw: unknown,
  ): Promise<{ r: Result<unknown>; cmd: string; cid?: string }> => {
    if (!senderOk) return { r: fail('FORBIDDEN', 'This sender may not use Dim Factory commands.'), cmd: '?' }
    const env = checkEnvelope(raw)
    if (!env.ok) return { r: env, cmd: '?' }
    const { cmd: name, req, cid } = env.value
    const known = Object.prototype.hasOwnProperty.call(COMMAND_AREA, name)
    if (!known || (COMMAND_AREA[name as Cmd] === 'e2e' && !d.e2e)) {
      return { r: fail('UNKNOWN_COMMAND', `Unknown command "${name}".`), cmd: name, cid }
    }
    const cmd = name as Cmd
    let parsed: Result<unknown>
    try {
      parsed = d.parse(cmd, req)
    } catch (err) {
      return { r: fail('INTERNAL', `Request check failed: ${String(err)}`), cmd, cid }
    }
    if (!parsed.ok) return { r: parsed, cmd, cid }
    if (isMainCommand(cmd)) {
      const h = d.main[cmd] as ((req: unknown) => Promise<unknown>) | undefined
      if (h === undefined) {
        return { r: fail('UNSUPPORTED', `${cmd} is not available in this build.`), cmd, cid }
      }
      return { r: await toResult(() => h(parsed.value)), cmd, cid }
    }
    return { r: await d.core(cmd, parsed.value), cmd, cid }
  }
  return async (senderOk, raw) => {
    let out: { r: Result<unknown>; cmd: string; cid?: string }
    try {
      out = await route(senderOk, raw)
    } catch (err) {
      out = { r: fail('INTERNAL', err instanceof Error ? err.message : String(err)), cmd: '?' }
    }
    if (!out.r.ok) {
      try {
        d.onFailure?.(out.cmd, out.cid, out.r.error)
      } catch {
        // logging never breaks a reply
      }
    }
    return out.r
  }
}
