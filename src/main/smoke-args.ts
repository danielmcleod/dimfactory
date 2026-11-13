// The `--smoke-test` contract (a packaged smoke test on 3 OS): it needs DIM_FACTORY_HOME (exit 2
// without it), boots normally, waits for the renderer's app.ready, checks one core round trip and prints exactly one
// stdout line, `SMOKE OK {json}` (exit 0) or `SMOKE FAIL <reason>` (exit 1). Pure parsing and formatting.
import { HOME_ENV } from '@core/home.ts'
import { SMOKE_FLAG } from './constants.ts'

export type SmokeMode =
  | { enabled: false }
  | { enabled: true; ok: true; home: string }
  | { enabled: true; ok: false; reason: string; exitCode: 2 }

export function smokeMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SmokeMode {
  if (!argv.includes(SMOKE_FLAG)) return { enabled: false }
  const home = env[HOME_ENV]?.trim() ?? ''
  if (home === '') return { enabled: true, ok: false, reason: `${HOME_ENV} is required`, exitCode: 2 }
  return { enabled: true, ok: true, home }
}

export interface SmokeReport {
  version: string
  electron: string
  platform: string
  eventLoopP95Ms: number
}

export function smokeOkLine(r: SmokeReport): string {
  const body: SmokeReport = {
    version: r.version,
    electron: r.electron,
    platform: r.platform,
    eventLoopP95Ms: Math.round(r.eventLoopP95Ms * 10) / 10,
  }
  return `SMOKE OK ${JSON.stringify(body)}`
}

/** One line, whatever the reason contains. */
export function smokeFailLine(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim()
  return `SMOKE FAIL ${oneLine === '' ? 'unknown error' : oneLine.slice(0, 500)}`
}
