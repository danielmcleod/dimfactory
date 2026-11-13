// Chaos seam (kill at each effect boundary; an E2E-only hook): a
// test-only kill switch. Under DIM_FACTORY_E2E=1, DIM_FACTORY_E2E_CHAOS_KILL=<point>[#<n>] ends this process the nth time
// (default the first) it reaches `<point>`, the way a crash or a Task Manager kill does: SIGKILL, no exit handlers, no
// flush. Before it dies it writes `{point, n, pid, at}` to the marker file createCore names (`<home>/e2e/chaos.json`),
// so the suite knows the kill landed where it asked. DIM_FACTORY_E2E_CHAOS_TRACE=<file> appends every point reached to
// that file (the suite's map of a run's boundaries). Disarmed (one comparison per point) unless DIM_FACTORY_E2E=1 and
// one of them is set; a packaged build drops every DIM_FACTORY_E2E* variable before core reads its environment
// (main/constants.ts dropE2EEnv), so no installed app can be told to kill itself. Points are named `<area>:<what>`:
// `effect:<t>` before a controller effect runs (its transition already durable), `event:<t>` when an effect's answer
// is queued (its work done, not yet reduced), `command:<kind>` once a user command's transition is durable, and a few
// inside effects (`spawn:spawned`, `revert:planned`, `apply:<step>`, `index:appended:<status>`…), named where they
// are called.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envName } from '../shared/brand.ts'

export const CHAOS_KILL_ENV = envName('E2E_CHAOS_KILL')
export const CHAOS_TRACE_ENV = envName('E2E_CHAOS_TRACE')

interface Armed {
  kill?: { point: string; nth: number; seen: number; marker: string }
  trace?: string
}

let armed: Armed | undefined

/** What `DIM_FACTORY_E2E_CHAOS_KILL` asks for (`<point>` or `<point>#<n>`, n ≥ 1), or undefined. */
export function parseChaosKill(raw: string | undefined): { point: string; nth: number } | undefined {
  const v = raw?.trim() ?? ''
  const m = /^([a-z][a-z0-9-]*:[A-Za-z0-9:_-]+)(?:#([1-9][0-9]{0,5}))?$/.exec(v)
  if (m === null) return undefined
  return { point: m[1] as string, nth: m[2] !== undefined ? Number(m[2]) : 1 }
}

/** createCore: arm the switch from Dim Factory's environment (DIM_FACTORY_E2E=1 only), or disarm it. */
export function armChaos(env: Readonly<Record<string, string | undefined>>, marker: string): void {
  armed = undefined
  if (env[envName('E2E')] !== '1') return
  const want = parseChaosKill(env[CHAOS_KILL_ENV])
  const trace = env[CHAOS_TRACE_ENV]?.trim() ?? ''
  if (want === undefined && trace === '') return
  armed = {
    ...(want !== undefined ? { kill: { ...want, seen: 0, marker } } : {}),
    ...(trace !== '' ? { trace } : {}),
  }
}

/** True while a kill or a trace is armed: a caller may skip building a point's name otherwise. */
export function chaosArmed(): boolean {
  return armed !== undefined
}

/** A named point: kills this process when it is the armed one's nth arrival (traced first); otherwise nothing. */
export function chaosPoint(point: string): void {
  const a = armed
  if (a === undefined) return
  if (a.trace !== undefined) {
    try {
      appendFileSync(a.trace, `${point}\n`)
    } catch {
      // A trace is a convenience.
    }
  }
  const k = a.kill
  if (k === undefined || k.point !== point) return
  k.seen++
  if (k.seen < k.nth) return
  try {
    mkdirSync(dirname(k.marker), { recursive: true })
    writeFileSync(k.marker, `${JSON.stringify({ point, n: k.seen, pid: process.pid, at: Date.now() })}\n`)
  } catch {
    // The kill matters more than the note.
  }
  process.kill(process.pid, 'SIGKILL')
  // TerminateProcess (Windows) may return before this thread is gone: run nothing more.
  const cell = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(cell, 0, 0, 1000)
}
