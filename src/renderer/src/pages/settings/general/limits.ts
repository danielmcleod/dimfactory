// Settings → General's number fields (built-in defaults and semantic rules: `timeouts`, `storage`). The schema's
// bounds are mirrored here (importing config-schema.ts values would bundle zod;
// tests/renderer/settings keeps them equal) so a value core would refuse is caught before anything is written,
// with the reason next to the field. Timeouts are edited in minutes and stored in milliseconds.
import type { Timeouts } from '@shared/config-schema.ts'

export type TimeoutKey = keyof Timeouts
export type StorageKey = 'keepRuns' | 'keepDays' | 'rawLogDays'

export const MINUTE_MS = 60_000

/** TimeoutsZ bounds (ms). */
export const TIMEOUT_LIMITS: Readonly<Record<TimeoutKey, { min: number; max: number }>> = {
  stallMs: { min: 30_000, max: 3_600_000 },
  hardKillMs: { min: 60_000, max: 14_400_000 },
  toolStallMs: { min: 30_000, max: 7_200_000 },
  askMs: { min: 30_000, max: 3_600_000 },
}

/** StorageZ bounds (whole numbers). */
export const STORAGE_LIMITS: Readonly<Record<StorageKey, { min: number; max: number }>> = {
  keepRuns: { min: 1, max: 100_000 },
  keepDays: { min: 1, max: 3650 },
  rawLogDays: { min: 0, max: 3650 },
}

/** `5`, `0.5`, `2.25`: minutes as the field shows them. */
export function formatMinutes(ms: number): string {
  const min = ms / MINUTE_MS
  return String(Math.round(min * 100) / 100)
}

/** `5 min`. */
export function minutesText(ms: number): string {
  return `${formatMinutes(ms)} min`
}

export type Parsed = { ok: true; value: number } | { ok: false; message: string }

/** A timeout typed in minutes → ms, checked against the schema's bounds. */
export function parseMinutes(text: string, key: TimeoutKey): Parsed {
  const t = text.trim().replace(',', '.')
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return { ok: false, message: 'Enter a number of minutes.' }
  const ms = Math.round(Number(t) * MINUTE_MS)
  const { min, max } = TIMEOUT_LIMITS[key]
  if (ms < min) return { ok: false, message: `At least ${minutesText(min)}.` }
  if (ms > max) return { ok: false, message: `At most ${minutesText(max)}.` }
  return { ok: true, value: ms }
}

/** A storage count typed as a whole number, checked against the schema's bounds. */
export function parseCount(text: string, key: StorageKey): Parsed {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Enter a whole number.' }
  const n = Number(t)
  const { min, max } = STORAGE_LIMITS[key]
  if (n < min) return { ok: false, message: `At least ${min}.` }
  if (n > max) return { ok: false, message: `At most ${max.toLocaleString('en-US')}.` }
  return { ok: true, value: n }
}

/**
 * Config semantic rule: `stallMs < hardKillMs` and `toolStallMs < hardKillMs`. `next` is every timeout as it would be
 * after the change; the message names the field being changed. null when the change keeps the rule.
 */
export function timeoutOrderError(key: TimeoutKey, next: Timeouts): string | null {
  if (key === 'hardKillMs') {
    const longer = [
      next.stallMs >= next.hardKillMs ? `the stall warning (${minutesText(next.stallMs)})` : null,
      next.toolStallMs >= next.hardKillMs ? `the tool limit (${minutesText(next.toolStallMs)})` : null,
    ].filter((s): s is string => s !== null)
    return longer.length > 0 ? `Must be longer than ${longer.join(' and ')}.` : null
  }
  if ((key === 'stallMs' || key === 'toolStallMs') && next[key] >= next.hardKillMs) {
    return `Must be shorter than the hard stop (${minutesText(next.hardKillMs)}).`
  }
  return null
}
