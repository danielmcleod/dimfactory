// The smoke check's record (Run & Preview). Main loads the preview's page in a hidden sandboxed window and hands core
// what it saw; core turns a run's console errors into `[should]` findings (source `preview`) and keeps the result with
// the run (runs/<id>/preview/smoke.json, the screenshot beside it). For a game it also keeps the built-in game checks
// (a blank canvas, a loop that does not run, a different game for the same seed, pause, the test hook), the requests
// to other computers its loopback-only preview blocked, and a picture of a moment of play (gameplay.png); each failed
// check, failed load and blocked host is a `[should]` finding too (a slow frame rate is a warning only). An
// on-demand check (no run) is kept in memory only, as a note in the panel.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Finding } from '../../shared/findings.ts'
import type { PreviewSmokeView, SmokeConsoleError, SmokeFailedLoad } from '../../shared/preview.ts'
import type { BlockedRequest, GameCheck, GameMeasures } from '../../shared/playtest.ts'
import { findingId } from '../findings/parse.ts'
import type { HomePaths } from '../home.ts'
import { writeFileAtomicLite } from '../proc/atomic-lite.ts'

/** At most this many console errors and failed loads are kept (the first ones). */
export const SMOKE_MAX_ITEMS = 50
/** At most this many console errors become findings. */
export const SMOKE_MAX_FINDINGS = 20
const MESSAGE_MAX = 2000

/** What main saw on the page. */
export interface SmokeObservation {
  url: string
  loaded: boolean
  consoleErrors: SmokeConsoleError[]
  failedLoads: SmokeFailedLoad[]
  /** A small JPEG data: URL. */
  thumbnail: string | null
  /** The full screenshot (PNG bytes). */
  png: Uint8Array | null
  error?: string
  /** A game's built-in checks (main ran them in the same hidden window). */
  checks?: GameCheck[]
  measures?: GameMeasures
  /** A game's requests to other computers, blocked (loopback-only). */
  blocked?: BlockedRequest[]
  /** A game: a picture of a moment of play (PNG bytes). */
  gamePng?: Uint8Array | null
}

/** runs/<id>/preview/ */
export function runPreviewDir(paths: HomePaths, runId: string): string {
  return join(paths.run(runId).dir, 'preview')
}

const firstLine = (s: string): string => (s.split(/\r?\n/)[0] ?? '').trim()

/** Console errors as `[should]` findings, one per distinct message, numbered F1…. */
export function smokeFindings(errors: readonly SmokeConsoleError[]): Finding[] {
  const out: Finding[] = []
  const seenMessages = new Set<string>()
  const used = new Set<string>()
  for (const e of errors) {
    if (out.length >= SMOKE_MAX_FINDINGS) break
    const msg = firstLine(e.message)
    if (msg === '' || seenMessages.has(msg)) continue
    seenMessages.add(msg)
    const title = `The preview page logged a console error: ${msg.length > 200 ? `${msg.slice(0, 200)}…` : msg}`
    let id = findingId('preview', title)
    for (let n = 2; used.has(id); n++) id = `${findingId('preview', title)}-${n}`
    used.add(id)
    const where = e.source !== undefined ? `${e.source}${e.line !== undefined ? `:${e.line}` : ''}` : ''
    const rest = e.message.split(/\r?\n/).slice(1).join('\n').trim()
    out.push({
      id,
      n: out.length + 1,
      severity: 'should',
      source: 'preview',
      title,
      body: [where !== '' ? `At ${where}.` : '', rest].filter((x) => x !== '').join('\n'),
      flags: [],
      round: 1,
    })
  }
  return out
}

/**
 * A game's findings beyond its console errors, all `[should]` (source `preview`): each failed load, each host it
 * tried to reach on the internet (blocked: the game should bundle what it needs), and each built-in check that failed
 * (a blank canvas, a loop that does not run, a different game for the same seed, pause that does not stop it, a test
 * hook that breaks its contract). A slow frame rate is a warning only, never a finding.
 */
export function gameFindings(o: {
  checks: readonly GameCheck[]
  failedLoads: readonly SmokeFailedLoad[]
  blocked: readonly BlockedRequest[]
}): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  const seen = new Set<string>()
  for (const f of o.failedLoads) {
    if (out.length >= SMOKE_MAX_FINDINGS) break
    const title = `The game could not load ${f.url.length > 160 ? `${f.url.slice(0, 160)}…` : f.url} (${f.error})`
    if (seen.has(title)) continue
    seen.add(title)
    out.push({ title, body: 'Every file the game uses must be in the project and load from it.' })
  }
  const hosts = [...new Set(o.blocked.map((b) => b.host))]
  for (const host of hosts.slice(0, 5)) {
    const first = o.blocked.find((b) => b.host === host)
    out.push({
      title: `The game tried to load something from the internet (${host}); game previews have no internet, so it was blocked`,
      body: `${first?.url ?? host}
Put what it needs in the project (the game must work offline), or allow the internet for this preview.`,
    })
  }
  for (const c of o.checks) {
    if (c.status !== 'fail' || c.id === 'errors' || c.id === 'offline') continue
    out.push({ title: `Game check: ${c.title}`, body: c.detail ?? '' })
  }
  return out
}

const capItems = <T>(list: readonly T[]): T[] => list.slice(0, SMOKE_MAX_ITEMS)
const capMessage = (s: string): string => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s)

/**
 * Record a smoke check: the view the panel shows (findings for a run), with the screenshot written beside it. A run's
 * is kept in runs/<id>/preview/; an on-demand one goes to preview/smoke/ in the home (the screenshot only).
 */
export async function recordSmoke(
  paths: HomePaths,
  o: { sessionId: string; runId?: string; at: number; seen: SmokeObservation },
): Promise<PreviewSmokeView> {
  const consoleErrors = capItems(o.seen.consoleErrors).map((e) => ({ ...e, message: capMessage(e.message) }))
  const failedLoads = capItems(o.seen.failedLoads)
  const dir =
    o.runId !== undefined ? runPreviewDir(paths, o.runId) : join(paths.home, 'preview', 'smoke', o.sessionId)
  await mkdir(dir, { recursive: true })
  let screenshotPath: string | null = null
  if (o.seen.png !== null && o.seen.png.length > 0) {
    screenshotPath = join(dir, 'smoke.png')
    await writeFile(screenshotPath, o.seen.png)
  }
  let gameplayPath: string | null = null
  if (o.seen.gamePng !== undefined && o.seen.gamePng !== null && o.seen.gamePng.length > 0) {
    gameplayPath = join(dir, 'gameplay.png')
    await writeFile(gameplayPath, o.seen.gamePng)
  }
  const blocked = capItems(o.seen.blocked ?? [])
  const game = o.seen.checks !== undefined
  const findings: Finding[] = []
  if (o.runId !== undefined) {
    findings.push(...smokeFindings(consoleErrors))
    if (game) {
      for (const g of gameFindings({ checks: o.seen.checks ?? [], failedLoads, blocked })) {
        if (findings.length >= SMOKE_MAX_FINDINGS) break
        let id = findingId('preview', g.title)
        for (let n = 2; findings.some((f) => f.id === id); n++) id = `${findingId('preview', g.title)}-${n}`
        findings.push({
          id,
          n: findings.length + 1,
          severity: 'should',
          source: 'preview',
          title: g.title,
          body: g.body,
          flags: [],
          round: 1,
        })
      }
    }
  }
  const view: PreviewSmokeView = {
    sessionId: o.sessionId,
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    at: o.at,
    url: o.seen.url,
    loaded: o.seen.loaded,
    consoleErrors,
    failedLoads,
    thumbnail: o.seen.thumbnail,
    screenshotPath,
    findings,
    ...(o.seen.error !== undefined ? { error: o.seen.error } : {}),
    ...(game
      ? {
          checks: o.seen.checks ?? [],
          measures: o.seen.measures ?? {},
          blocked,
          gameplayPath,
        }
      : blocked.length > 0
        ? { blocked }
        : {}),
  }
  if (o.runId !== undefined)
    await writeFileAtomicLite(join(dir, 'smoke.json'), `${JSON.stringify(view, null, 2)}\n`)
  return view
}

/** A run's last smoke check (null when it has none, or the file cannot be read). */
export async function readRunSmoke(paths: HomePaths, runId: string): Promise<PreviewSmokeView | null> {
  try {
    const v = JSON.parse(await readFile(join(runPreviewDir(paths, runId), 'smoke.json'), 'utf8')) as unknown
    if (typeof v !== 'object' || v === null) return null
    const o = v as Partial<PreviewSmokeView>
    if (typeof o.sessionId !== 'string' || !Array.isArray(o.consoleErrors) || !Array.isArray(o.findings))
      return null
    return v as PreviewSmokeView
  } catch {
    return null
  }
}
