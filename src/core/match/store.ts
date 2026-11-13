// The match records: `<home>/matches/<matchId>/match.json`, one per match, written atomically. A record that cannot be
// read (damaged, or written by a later build) is left alone and reads as absent.
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { RUN_ID_PATTERN } from '../../shared/ids.ts'
import { MATCH_KINDS, MATCH_SIDES } from '../../shared/match.ts'
import type { MatchRecord } from '../../shared/match.ts'
import type { MatchResult } from '../../shared/scoreboard.ts'
import { assertSafeSegment } from '../home.ts'
import type { HomePaths } from '../home.ts'
import { readJsonFile, writeJsonAtomic } from './../store/atomic.ts'

const ShaZ = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
const IdZ = z.string().regex(RUN_ID_PATTERN)

const SideZ = z.object({
  side: z.enum(MATCH_SIDES),
  contestant: z.object({
    vendor: z.string().min(1).max(64),
    model: z.string().min(1).max(128).nullable().optional(),
    effort: z.string().min(1).max(32).optional(),
  }),
  runId: IdZ.optional(),
  displayNo: z.number().int().nonnegative().optional(),
  notStarted: z.string().max(2000).optional(),
  recorded: z.literal(true).optional(),
})

const ResultSideZ = z.object({
  builder: z.object({
    vendor: z.string().min(1).max(64),
    model: z.string().min(1).max(128).nullable().optional(),
    effort: z.string().min(1).max(32).optional(),
  }),
  finished: z.boolean(),
  checks: z
    .object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
    .optional(),
  costUsd: z.number().nullable().optional(),
  buildMs: z.number().nonnegative().optional(),
})
const ResultZ = z.object({
  at: z.number(),
  category: z.string().min(1).max(64),
  sides: z.tuple([ResultSideZ, ResultSideZ]),
})

const PickZ = z.object({
  side: z.enum([...MATCH_SIDES, 'none']),
  at: z.number(),
  undoToken: z.string().min(1).max(200).optional(),
  copiesRemovedAt: z.number().optional(),
})

const MatchRecordZ = z.object({
  schemaVersion: z.literal(1),
  matchId: IdZ,
  kind: z.enum(MATCH_KINDS),
  folder: z.string().min(1),
  folderKey: z.string().min(1).max(64),
  task: z.string(),
  createdAt: z.number(),
  start: z.object({ tree: ShaZ, commit: ShaZ }),
  sides: z.tuple([SideZ, SideZ]),
  pending: z
    .object({
      request: z.record(z.string(), z.unknown()),
      hints: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  shared: z.boolean().optional(),
  source: z.object({ runId: IdZ, displayNo: z.number().int().nonnegative() }).optional(),
  openTask: z.boolean().optional(),
  blind: z.object({ swap: z.boolean(), revealedAt: z.number().optional() }).optional(),
  pick: PickZ.optional(),
  result: ResultZ.optional(),
  cleanedAt: z.number().optional(),
})

function resultOf(r: z.infer<typeof ResultZ>): MatchResult {
  const side = (s: z.infer<typeof ResultSideZ>): MatchResult['sides'][number] => ({
    builder: {
      vendor: s.builder.vendor,
      ...(s.builder.model !== undefined ? { model: s.builder.model } : {}),
      ...(s.builder.effort !== undefined ? { effort: s.builder.effort } : {}),
    },
    finished: s.finished,
    ...(s.checks !== undefined ? { checks: s.checks } : {}),
    ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    ...(s.buildMs !== undefined ? { buildMs: s.buildMs } : {}),
  })
  return { at: r.at, category: r.category, sides: [side(r.sides[0]), side(r.sides[1])] }
}

/** `<home>/matches` */
export function matchesDir(paths: HomePaths): string {
  return join(paths.home, 'matches')
}

/** `<home>/matches/<matchId>` */
export function matchDir(paths: HomePaths, matchId: string): string {
  return join(matchesDir(paths), assertSafeSegment(matchId, 'match id'))
}

export function matchFile(paths: HomePaths, matchId: string): string {
  return join(matchDir(paths, matchId), 'match.json')
}

export async function writeMatch(paths: HomePaths, rec: MatchRecord): Promise<void> {
  await mkdir(matchDir(paths, rec.matchId), { recursive: true })
  await writeJsonAtomic(matchFile(paths, rec.matchId), rec)
}

/** The record, or null when there is none or it cannot be read as one. */
export async function readMatch(paths: HomePaths, matchId: string): Promise<MatchRecord | null> {
  if (!RUN_ID_PATTERN.test(matchId)) return null
  const r = await readJsonFile(matchFile(paths, matchId))
  if (r.kind !== 'ok') return null
  const parsed = MatchRecordZ.safeParse(r.value)
  if (!parsed.success || parsed.data.matchId !== matchId) return null
  const d = parsed.data
  const side = (s: z.infer<typeof SideZ>): MatchRecord['sides'][number] => ({
    side: s.side,
    contestant: {
      vendor: s.contestant.vendor,
      ...(s.contestant.model !== undefined ? { model: s.contestant.model } : {}),
      ...(s.contestant.effort !== undefined ? { effort: s.contestant.effort } : {}),
    },
    ...(s.runId !== undefined ? { runId: s.runId } : {}),
    ...(s.displayNo !== undefined ? { displayNo: s.displayNo } : {}),
    ...(s.notStarted !== undefined ? { notStarted: s.notStarted } : {}),
    ...(s.recorded === true ? { recorded: true as const } : {}),
  })
  return {
    schemaVersion: 1,
    matchId: d.matchId,
    kind: d.kind,
    folder: d.folder,
    folderKey: d.folderKey,
    task: d.task,
    createdAt: d.createdAt,
    start: d.start,
    sides: [side(d.sides[0]), side(d.sides[1])],
    ...(d.pending !== undefined
      ? {
          pending: {
            request: d.pending.request,
            ...(d.pending.hints !== undefined ? { hints: d.pending.hints } : {}),
          },
        }
      : {}),
    ...(d.shared !== undefined ? { shared: d.shared } : {}),
    ...(d.source !== undefined ? { source: d.source } : {}),
    ...(d.openTask !== undefined ? { openTask: d.openTask } : {}),
    ...(d.blind !== undefined
      ? {
          blind: {
            swap: d.blind.swap,
            ...(d.blind.revealedAt !== undefined ? { revealedAt: d.blind.revealedAt } : {}),
          },
        }
      : {}),
    ...(d.pick !== undefined
      ? {
          pick: {
            side: d.pick.side,
            at: d.pick.at,
            ...(d.pick.undoToken !== undefined ? { undoToken: d.pick.undoToken } : {}),
            ...(d.pick.copiesRemovedAt !== undefined ? { copiesRemovedAt: d.pick.copiesRemovedAt } : {}),
          },
        }
      : {}),
    ...(d.result !== undefined ? { result: resultOf(d.result) } : {}),
    ...(d.cleanedAt !== undefined ? { cleanedAt: d.cleanedAt } : {}),
  }
}

/** Every match id with a folder under `<home>/matches`, newest first (ids start with their creation time). */
export async function listMatchIds(paths: HomePaths): Promise<string[]> {
  const names = await readdir(matchesDir(paths)).catch(() => [] as string[])
  return names
    .filter((n) => RUN_ID_PATTERN.test(n))
    .sort()
    .reverse()
}

export async function removeMatch(paths: HomePaths, matchId: string): Promise<void> {
  await rm(matchDir(paths, matchId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
