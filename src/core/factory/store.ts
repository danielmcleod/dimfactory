// The factory's files under DIM_FACTORY_HOME (never in a project):
//   queue/<key>.json        one folder's queue (key: a hash of the folder's path, as saved briefs use)
//   queue/factory.json      the launch notice and the schedule window last handled
//   queue/days/<date>.json  the day's ledger: the runs queues started, pauses and vendor fallbacks
//   reports/<date>.md       the daily report (written as the day's runs change)
// Every write is atomic. An unreadable or invalid file reads as empty and is logged; a queue file is never thrown away.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BriefInputZ } from '../../shared/brief.ts'
import { RunOverridesZ } from '../../shared/config-schema.ts'
import {
  QUEUE_PAUSE_REASONS,
  QUEUE_STATES,
  QUEUE_TASK_ID,
  QUEUE_TASK_STATUSES,
  QUEUE_TASK_TEXT_MAX,
} from '../../shared/factory.ts'
import type { DailyReportFallback, DailyReportPause, FactoryNotice } from '../../shared/factory.ts'
import { FAILURE_CATEGORIES } from '../../shared/failure.ts'
import { QUEUE_STOP_CATEGORIES } from '../../shared/factory.ts'
import { RUN_OUTCOMES } from '../../shared/run.ts'
import { briefKey } from '../brief/store.ts'
import { writeFileAtomic } from '../store/atomic.ts'
import type { FolderQueueDoc } from './model.ts'

export const queueDir = (home: string): string => join(home, 'queue')
export const queueFile = (home: string, folder: string): string =>
  join(queueDir(home), `${briefKey(folder)}.json`)
const stateFile = (home: string): string => join(queueDir(home), 'factory.json')
export const dayFile = (home: string, date: string): string => join(queueDir(home), 'days', `${date}.json`)
export const reportFile = (home: string, date: string): string => join(home, 'reports', `${date}.md`)

const SourceZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('todo'), file: z.string().max(4096), line: z.number().int().positive() }),
  z.object({
    kind: z.literal('github'),
    number: z.number().int().positive(),
    url: z.string().max(2048).optional(),
  }),
])

const TaskZ = z.object({
  id: z.string().regex(QUEUE_TASK_ID),
  task: z.string().min(1).max(QUEUE_TASK_TEXT_MAX),
  title: z.string().max(200),
  recipe: z.string().max(64).optional(),
  easy: z.object({ overrides: RunOverridesZ, brief: BriefInputZ.optional() }).optional(),
  rematch: z
    .object({
      runId: z.string().min(1).max(64),
      displayNo: z.number().int(),
      challenger: z.object({
        vendor: z.string().min(1).max(64),
        model: z.string().min(1).max(128).nullable().optional(),
        effort: z.string().min(1).max(32).optional(),
      }),
      blind: z.boolean().optional(),
      matchId: z.string().max(64).optional(),
    })
    .optional(),
  source: SourceZ,
  addedAt: z.number(),
  status: z.enum(QUEUE_TASK_STATUSES),
  runId: z.string().max(64).optional(),
  displayNo: z.number().int().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  outcome: z.enum(RUN_OUTCOMES).optional(),
  costUsd: z.number().nullable().optional(),
  reason: z.string().max(4000).optional(),
  category: z.enum([...FAILURE_CATEGORIES, ...QUEUE_STOP_CATEGORIES]).optional(),
  branch: z.string().max(400).optional(),
  commit: z.string().max(80).optional(),
})

const PauseZ = z.object({
  reason: z.enum(QUEUE_PAUSE_REASONS),
  text: z.string().max(4000),
  at: z.number(),
  taskId: z.string().optional(),
})

const QueueDocZ = z.object({
  schemaVersion: z.literal(1),
  folder: z.string().min(1).max(4096),
  tasks: z.array(TaskZ).max(1000),
  state: z.enum(QUEUE_STATES),
  pause: PauseZ.optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  scheduled: z.boolean().optional(),
})

/** Strip the keys zod reads as `undefined` (exactOptionalPropertyTypes: an absent key is not `undefined`). */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export interface LoadedQueues {
  docs: FolderQueueDoc[]
  /** Files that could not be read (`file: why`); they stay where they are. */
  problems: string[]
}

export async function loadQueues(home: string): Promise<LoadedQueues> {
  const dir = queueDir(home)
  const names = await readdir(dir).catch(() => [] as string[])
  const docs: FolderQueueDoc[] = []
  const problems: string[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name === 'factory.json') continue
    try {
      const r = QueueDocZ.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')))
      if (r.success) docs.push(clean(r.data) as FolderQueueDoc)
      else problems.push(`${name}: ${r.error.issues[0]?.message ?? 'invalid'}`)
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { docs, problems }
}

export async function saveQueue(home: string, doc: FolderQueueDoc): Promise<void> {
  await writeFileAtomic(queueFile(home, doc.folder), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

// ---- factory.json: the launch notice and the schedule window last handled ----------------------------------------

export interface FactoryStateDoc {
  /** The open notice (a due schedule at launch) until you act on it or dismiss it. */
  notice?: FactoryNotice
  /** The start (epoch ms) of the last schedule window Dim Factory handled (started, or raised its notice for). */
  handledWindow?: number
}

const NoticeZ = z.object({
  id: z.string().max(64),
  kind: z.enum(['schedule-due', 'resumed']),
  at: z.number(),
  text: z.string().max(4000),
  folders: z.array(z.string().max(4096)).max(1000),
})
const StateZ = z.object({ notice: NoticeZ.optional(), handledWindow: z.number().optional() })

export async function readFactoryState(home: string): Promise<FactoryStateDoc> {
  try {
    const r = StateZ.safeParse(JSON.parse(await readFile(stateFile(home), 'utf8')))
    return r.success ? (clean(r.data) as FactoryStateDoc) : {}
  } catch {
    return {}
  }
}

export async function writeFactoryState(home: string, doc: FactoryStateDoc): Promise<void> {
  await writeFileAtomic(stateFile(home), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

// ---- the day's ledger ----------------------------------------------------------------------------------------------

export interface DayLedger {
  date: string
  /** The runs a queue started this day. */
  queueRuns: string[]
  pauses: DailyReportPause[]
  fallbacks: DailyReportFallback[]
}

const LedgerZ = z.object({
  date: z.string(),
  queueRuns: z.array(z.string().max(64)).max(10_000),
  pauses: z
    .array(z.object({ at: z.number(), folder: z.string().max(4096), text: z.string().max(4000) }))
    .max(10_000),
  fallbacks: z
    .array(
      z.object({
        at: z.number(),
        runId: z.string().max(64),
        displayNo: z.number().int(),
        step: z.string().max(40),
        from: z.string().max(64),
        to: z.string().max(64),
        why: z.string().max(4000),
      }),
    )
    .max(10_000),
})

export async function readLedger(home: string, date: string): Promise<DayLedger> {
  try {
    const r = LedgerZ.safeParse(JSON.parse(await readFile(dayFile(home, date), 'utf8')))
    if (r.success && r.data.date === date) return clean(r.data)
  } catch {
    // none yet
  }
  return { date, queueRuns: [], pauses: [], fallbacks: [] }
}

export async function writeLedger(home: string, ledger: DayLedger): Promise<void> {
  await writeFileAtomic(dayFile(home, ledger.date), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}
