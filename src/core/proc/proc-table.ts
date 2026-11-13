// procs.json persistence and the relaunch orphan sweep.
import { readFile, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { newRequestId } from '../../shared/ids.ts'
import type { StepKey } from '../../shared/run.ts'
import type { Transport } from '../../shared/vendors.ts'
import { writeFileAtomicLite } from './atomic-lite.ts'
import { START_SLACK_MS, START_WINDOW_AFTER_MS } from './kill.ts'
import { exeKey, findDescendants, isAlive, snapshotProcesses } from './ps.ts'
import type { ProcInfo, ProcSnapshot } from './ps.ts'
import type { ChildHandle } from './spawn.ts'

export { START_WINDOW_AFTER_MS }

export type ProcStep = StepKey | 'heal' | 'catalog' | 'probe' | 'preview'
export type ProcTransport = Transport | 'verify' | 'probe' | 'git' | 'preview'
export type ProcExitHow = 'exited' | 'killed' | 'orphan-killed' | 'lost'

export interface ProcExit {
  code: number | null
  signal: string | null
  at: number
  how: ProcExitHow
}

export interface ProcRecord {
  id: string
  step: ProcStep
  pid: number
  pgid?: number
  spawnAt: number
  /** The spawned executable (system node for a node-entry CLI). */
  exe: string
  /** POSIX: `exe` with symlinks resolved at spawn (what /proc/<pid>/exe shows). An addition to the base entry shape. */
  exeReal?: string
  argv: string[]
  transport: ProcTransport
  exit?: ProcExit
}

export interface ProcsFile {
  schemaVersion: 1
  procs: ProcRecord[]
}

function isRecord(v: unknown): v is ProcRecord {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['pid'] === 'number' &&
    typeof r['spawnAt'] === 'number' &&
    typeof r['exe'] === 'string'
  )
}

/** The procs.json entry for a freshly spawned child (add it before the first stdin write). */
export function procRecordFor(
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
  step: ProcStep,
  transport: ProcTransport,
): Omit<ProcRecord, 'id'> {
  const rec: Omit<ProcRecord, 'id'> = {
    step,
    pid: child.pid,
    spawnAt: child.spawnAt,
    exe: child.command,
    argv: [...child.argv],
    transport,
  }
  if (child.realCommand !== undefined && child.realCommand !== child.command) rec.exeReal = child.realCommand
  if (child.pgid !== undefined) rec.pgid = child.pgid
  return rec
}

/** Read procs.json; a missing or unreadable file is an empty table. */
export async function readProcsFile(file: string): Promise<ProcRecord[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text) as { procs?: unknown }
    return Array.isArray(parsed.procs) ? parsed.procs.filter(isRecord) : []
  } catch {
    return []
  }
}

export async function writeProcsFile(file: string, procs: readonly ProcRecord[]): Promise<void> {
  const body: ProcsFile = { schemaVersion: 1, procs: [...procs] }
  await writeFileAtomicLite(file, `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * In-memory table with serialized atomic writes. Write `add()` after spawn and before the first stdin write, and
 * `touch()` every few seconds while children run: the file's mtime is the previous session's last sign of life,
 * which bounds what the relaunch sweep may attribute to a record that never got its `exit`.
 */
export class ProcTable {
  readonly file: string
  /** procs.json mtime when opened (epoch ms); undefined for a new file. */
  readonly lastWriteAt: number | undefined
  private procs: ProcRecord[]
  private chain: Promise<void> = Promise.resolve()

  private constructor(file: string, procs: ProcRecord[], lastWriteAt: number | undefined) {
    this.file = file
    this.procs = procs
    this.lastWriteAt = lastWriteAt
  }

  static async open(file: string): Promise<ProcTable> {
    let mtime: number | undefined
    try {
      mtime = (await stat(file)).mtimeMs
    } catch {
      mtime = undefined
    }
    return new ProcTable(file, await readProcsFile(file), mtime)
  }

  records(): readonly ProcRecord[] {
    return this.procs
  }

  /** Heartbeat: rewrite the file so its mtime shows this session is alive. */
  touch(): Promise<void> {
    return this.persist()
  }

  /** The relaunch sweep over this table's records (bounded by `lastWriteAt`); the marked records are saved. */
  async sweep(opts: SweepOptions = {}): Promise<SweepResult> {
    const result = await sweepOrphans(this.procs, {
      ...(this.lastWriteAt !== undefined ? { lastAliveAt: this.lastWriteAt } : {}),
      ...opts,
    })
    await this.replace(result.records)
    return result
  }

  add(rec: Omit<ProcRecord, 'id'> & { id?: string }): Promise<ProcRecord> {
    const full: ProcRecord = { ...rec, id: rec.id ?? newRequestId('proc') }
    this.procs = [...this.procs, full]
    return this.persist().then(() => full)
  }

  markExit(id: string, exit: ProcExit): Promise<void> {
    this.procs = this.procs.map((r) => (r.id === id ? { ...r, exit } : r))
    return this.persist()
  }

  replace(records: readonly ProcRecord[]): Promise<void> {
    this.procs = [...records]
    return this.persist()
  }

  private persist(): Promise<void> {
    const snapshot = this.procs
    const next = this.chain.then(() => writeProcsFile(this.file, snapshot))
    this.chain = next.catch(() => undefined)
    return next
  }
}

// ---- orphan sweep -----------------------------------------------------------------------------------------

const INTERPRETERS = new Set(['node', 'sh', 'bash', 'dash', 'zsh', 'env'])

/** An unknown start time (tasklist fallback) is never ours: pid + image name alone cannot rule out reuse. */
function startInWindow(proc: ProcInfo, rec: ProcRecord): boolean {
  if (proc.startMs === null) return false
  return proc.startMs >= rec.spawnAt - START_SLACK_MS && proc.startMs <= rec.spawnAt + START_WINDOW_AFTER_MS
}

function recordExeMatches(procExe: string, rec: ProcRecord, platform: NodeJS.Platform): boolean {
  return (
    exeMatches(procExe, rec.exe, platform) ||
    (rec.exeReal !== undefined && exeMatches(procExe, rec.exeReal, platform))
  )
}

/** Exe basename match; on POSIX a script record also matches its interpreter (`#!/usr/bin/env node`). */
export function exeMatches(
  procExe: string,
  recordExe: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const b = exeKey(recordExe, platform)
  const scriptRecord = platform !== 'win32' && !INTERPRETERS.has(posix.basename(recordExe))
  return procExeKeys(procExe, platform).some((a) => a === b || (scriptRecord && INTERPRETERS.has(a)))
}

/**
 * The names a snapshot's exe may stand for. macOS ps reads `comm` from the process's own argv[0], which a program
 * may rewrite with its title (npm's `npm run dev`, Node's process.title): its first word counts too.
 */
function procExeKeys(procExe: string, platform: NodeJS.Platform): string[] {
  const whole = exeKey(procExe, platform)
  if (platform !== 'darwin') return [whole]
  const first = procExe.trim().split(/\s+/)[0] ?? ''
  return first === '' || first === procExe ? [whole] : [whole, exeKey(first, platform)]
}

export interface SweepPlan {
  /** Un-ended records whose process is still alive and ours. */
  owned: { record: ProcRecord; proc: ProcInfo }[]
  /** Un-ended records whose process is gone (or whose pid now belongs to someone else, or cannot be verified). */
  lost: ProcRecord[]
  /** Descendants of recorded pids (alive or dead) and POSIX group members, excluding the owned roots. */
  descendants: ProcInfo[]
  /** Everything to kill. */
  pids: number[]
}

export interface PlanSweepOptions {
  platform?: NodeJS.Platform
  /** Pids never touched (this process and its parent are always excluded). */
  exclude?: Iterable<number>
  /** This boot's start (snapshot): a record spawned earlier belongs to an earlier boot and is never walked. */
  bootMs?: number | null
  /**
   * When the previous session was last known alive (procs.json mtime, see ProcTable.touch). A record without
   * `exit` whose process is gone died by then, so only processes started before it (+10 s) can be its children.
   * Without it such a record's children are not walked.
   */
  lastAliveAt?: number
}

const SWEPT: ReadonlySet<ProcExitHow> = new Set(['lost', 'orphan-killed'])

/**
 * Start-time bounds for a record's direct children and group members. A live process of ours still holds its
 * pid: children are anything that started after it. Otherwise the pid was ours only from the spawn until the
 * recorded exit (or the last sign of life of a session that crashed), and before any current holder started.
 */
function childWindow(
  rec: ProcRecord,
  proc: ProcInfo | undefined,
  ours: boolean,
  lastAliveAt: number | undefined,
): { minStartMs: number; maxChildStartMs?: number } | undefined {
  if (ours && proc?.startMs != null) return { minStartMs: proc.startMs }
  let end = rec.exit?.at ?? (lastAliveAt !== undefined ? lastAliveAt + START_WINDOW_AFTER_MS : undefined)
  if (end === undefined) return undefined
  if (proc !== undefined) {
    if (proc.startMs === null) return undefined
    end = Math.min(end, proc.startMs - 1)
  }
  return { minStartMs: rec.spawnAt - START_SLACK_MS, maxChildStartMs: end }
}

/**
 * Plan the relaunch sweep. A record's process is ours only with a known start time in the spawn window and a
 * matching exe. Children are attributed to a record only while it could have held its pid: from its spawn to its
 * recorded exit (or the previous session's last sign of life), never across a reboot; deeper levels must not
 * predate their parent. Records a sweep already settled (`lost`, `orphan-killed`) are skipped.
 */
export function planOrphanSweep(
  records: readonly ProcRecord[],
  procs: readonly ProcInfo[],
  opts: PlanSweepOptions = {},
): SweepPlan {
  const platform = opts.platform ?? process.platform
  const exclude = new Set([process.pid, process.ppid, 0, ...(opts.exclude ?? [])])
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const owned: SweepPlan['owned'] = []
  const lost: ProcRecord[] = []
  const descendants = new Map<number, ProcInfo>()
  const canTraverse = procs.some((p) => p.ppid !== null)
  const bootMs = opts.bootMs ?? null

  for (const rec of records) {
    if (rec.exit !== undefined && SWEPT.has(rec.exit.how)) continue
    const earlierBoot = bootMs !== null && rec.spawnAt < bootMs
    const proc = byPid.get(rec.pid)
    const ours =
      rec.exit === undefined &&
      !earlierBoot &&
      proc !== undefined &&
      startInWindow(proc, rec) &&
      recordExeMatches(proc.exe, rec, platform)
    if (rec.exit === undefined && !exclude.has(rec.pid)) {
      if (ours) owned.push({ record: rec, proc })
      else lost.push(rec)
    }
    if (earlierBoot || !canTraverse) continue
    const window = childWindow(rec, proc, ours, opts.lastAliveAt)
    if (window === undefined) continue
    for (const d of findDescendants(procs, [rec.pid], window)) descendants.set(d.pid, d)
    if (platform !== 'win32' && rec.pgid !== undefined) {
      const leader = byPid.get(rec.pgid)
      const leaderReused = leader !== undefined && !(leader.pid === rec.pid && ours)
      if (!leaderReused) {
        for (const p of procs) {
          if (p.pgid !== rec.pgid || p.pid === rec.pid || p.startMs === null) continue
          if (p.startMs < window.minStartMs) continue
          if (window.maxChildStartMs !== undefined && p.startMs > window.maxChildStartMs) continue
          descendants.set(p.pid, p)
          for (const d of findDescendants(procs, [p.pid], { minStartMs: p.startMs }))
            descendants.set(d.pid, d)
        }
      }
    }
  }
  const ownedPids = new Set(owned.map((o) => o.proc.pid))
  for (const pid of [...descendants.keys()])
    if (ownedPids.has(pid) || exclude.has(pid)) descendants.delete(pid)
  const pids = [...ownedPids, ...descendants.keys()].filter((p) => !exclude.has(p))
  return { owned, lost, descendants: [...descendants.values()], pids }
}

export interface SweepOptions extends PlanSweepOptions {
  snapshot?: () => Promise<ProcSnapshot>
  termWaitMs?: number
  now?: () => number
}

export interface SweepResult {
  plan: SweepPlan
  killed: number[]
  /** Records with `exit` filled in for owned (`orphan-killed`) and lost (`lost`) entries. */
  records: ProcRecord[]
}

/**
 * Relaunch orphan sweep: kill leftover vendor processes and their descendants, then mark the records. Pass
 * `lastAliveAt` (or use ProcTable.sweep) so the children of a record that never got its `exit` are swept.
 */
export async function sweepOrphans(
  records: readonly ProcRecord[],
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const platform = opts.platform ?? process.platform
  const snap = await (opts.snapshot ?? (() => snapshotProcesses(platform)))()
  const plan = planOrphanSweep(records, snap.procs, { ...opts, bootMs: opts.bootMs ?? snap.bootMs ?? null })
  const killed: number[] = []
  const send = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(pid, sig)
      if (!killed.includes(pid)) killed.push(pid)
    } catch {
      // already gone
    }
  }
  if (plan.pids.length > 0) {
    if (platform === 'win32') {
      for (const pid of plan.pids) send(pid, 'SIGKILL')
    } else {
      for (const pid of plan.pids) send(pid, 'SIGTERM')
      const deadline = Date.now() + (opts.termWaitMs ?? 2000)
      while (plan.pids.some(isAlive) && Date.now() < deadline) await delay(50)
      for (const pid of plan.pids) if (isAlive(pid)) send(pid, 'SIGKILL')
    }
  }
  const at = (opts.now ?? Date.now)()
  const ownedIds = new Set(plan.owned.map((o) => o.record.id))
  const lostIds = new Set(plan.lost.map((r) => r.id))
  const updated = records.map((r): ProcRecord => {
    if (ownedIds.has(r.id)) return { ...r, exit: { code: null, signal: null, at, how: 'orphan-killed' } }
    if (lostIds.has(r.id)) return { ...r, exit: { code: null, signal: null, at, how: 'lost' } }
    return r
  })
  return { plan, killed, records: updated }
}

/** Basename used in recovery notices. */
export function procLabel(rec: ProcRecord): string {
  const base = rec.exe.includes('\\') ? win32.basename(rec.exe) : posix.basename(rec.exe)
  return `${rec.step} (${base} pid ${rec.pid})`
}
