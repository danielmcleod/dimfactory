// The tools outside agents get on Dim Factory's MCP endpoint. Reads go through the same core commands the app uses
// (runs.list, runs.get, runs.output, diff.files, diff.file, runs.events, folders.recent, estimates.get), with paging
// and size caps; request_run only records a request for the user to approve (requests.ts). Every text answer is
// redacted (shared/redact.ts) before it leaves; a folder must be one Dim Factory knows or an existing absolute folder
// the folder guard allows; a diff path must be one of the run's changed files.
import { posix, resolve, win32 } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FindingsFile } from '../../shared/findings.ts'
import type { Cmd, DiffSegment, McpRunRequest, Req, Res, Result } from '../../shared/ipc.ts'
import { DIFF_SEGMENTS } from '../../shared/ipc.ts'
import { redactText } from '../../shared/redact.ts'
import type { RunEnvelope, RunSnapshot, RunSummary } from '../../shared/run.ts'
import { RUN_STATUSES } from '../../shared/run.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { McpRequestStore } from './requests.ts'
import { MCP_NOTES_MAX, MCP_TASK_MAX } from './requests.ts'

/** Caps on what one answer carries. */
export const MCP_LIST_MAX = 50
export const MCP_DIFF_FILES_MAX = 500
export const MCP_PATCH_MAX = 64 * 1024
export const MCP_TEXT_MAX = 64 * 1024
export const MCP_LOG_MAX_EVENTS = 500
export const MCP_ANSWER_MAX = 128 * 1024

export type CoreInvoke = <C extends Cmd>(cmd: C, req: Req<C>) => Promise<Result<Res<C>>>

export interface McpToolDeps {
  invoke: CoreInvoke
  /** The run's whole task (run.json), null when unreadable. */
  readTask(runId: string): Promise<string | null>
  /** An existing absolute folder that the folder guard allows (the folder, normalized), else a VALIDATION error. */
  checkFolder(folder: string): Promise<string>
  requests: McpRequestStore
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** Redacted text, cut at `max` characters with a note. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  const red = redactText(text, { mode: 'heal' }).text
  if (red.length <= max) return { text: red, truncated: false }
  return { text: `${red.slice(0, max)}\n[cut: ${red.length - max} more characters]`, truncated: true }
}

function answer(value: unknown): ToolResult {
  const json = JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: capText(json, MCP_ANSWER_MAX).text }] }
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: capText(message, 4096).text }], isError: true }
}

async function call<C extends Cmd>(deps: McpToolDeps, cmd: C, req: Req<C>): Promise<Res<C>> {
  const r = await deps.invoke(cmd, req)
  if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
  return r.value
}

/** A tool body: errors become an isError answer with the message (never a stack). */
const guarded =
  <A>(fn: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args)
    } catch (err) {
      return failure(errorMessage(err))
    }
  }

export function runBrief(s: RunSummary): Record<string, unknown> {
  return {
    runId: s.runId,
    number: s.displayNo,
    title: s.title,
    folder: s.folder,
    status: s.status,
    phase: s.phase,
    ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
    ...(s.failure !== undefined ? { failure: s.failure } : {}),
    profile: s.profile,
    createdAt: new Date(s.createdAt).toISOString(),
    ...(s.endedAt !== undefined ? { endedAt: new Date(s.endedAt).toISOString() } : {}),
    costUsd: s.progress.costUsd,
    tokens: s.progress.tokens,
    filesChanged: s.progress.filesChanged,
    findings: s.findings,
  }
}

function runDetail(snap: RunSnapshot, task: string | null): Record<string, unknown> {
  const s = snap.summary
  const steps = s.steps.map((st) => {
    const view = snap.steps[st.key]
    return {
      pass: st.key,
      status: st.status,
      ...(st.vendor !== undefined ? { vendor: st.vendor } : {}),
      ...(st.model !== undefined && st.model !== null ? { model: st.model } : {}),
      ...(st.mode !== undefined ? { mode: st.mode } : {}),
      activeSeconds: Math.round(st.activeMs / 1000),
      ...(view?.attempt !== undefined && view.attempt > 1 ? { attempt: view.attempt } : {}),
      ...(view?.reason !== undefined ? { reason: view.reason } : {}),
      ...(st.usage?.costUsd !== undefined ? { costUsd: st.usage.costUsd } : {}),
      ...(st.failureCategory !== undefined ? { failure: st.failureCategory } : {}),
    }
  })
  const openCards = snap.cards
    .filter((c) => (c as { state?: unknown }).state !== 'resolved')
    .map((c) => (c as { title?: unknown }).title)
    .filter((t): t is string => typeof t === 'string')
  return {
    ...runBrief(s),
    ...(task !== null ? { task: capText(task, 8192).text } : {}),
    isolation: s.isolation,
    auto: s.auto,
    ...(s.progress.etaMs !== undefined ? { etaSeconds: Math.round(s.progress.etaMs / 1000) } : {}),
    ...(s.progress.etaState !== undefined ? { eta: s.progress.etaState } : {}),
    steps,
    waitingForUser: {
      questions: snap.asks.length,
      cards: openCards,
      note: 'Questions and cards are answered by the user in Dim Factory.',
    },
  }
}

function describeEvent(e: RunEnvelope): string {
  const b = e.body
  const at = new Date(e.ts).toISOString()
  const head = `${e.seq} ${at}`
  switch (b.t) {
    case 'ev': {
      const ev = b.ev
      switch (ev.type) {
        case 'text':
          return `${head} ${b.step} text: ${ev.delta}`
        case 'tool':
          return `${head} ${b.step} tool ${ev.name}${ev.status !== undefined ? ` (${ev.status})` : ''}: ${ev.summary}`
        case 'ask':
          return `${head} ${b.step} asks (${ev.kind}): ${ev.detail}`
        case 'done':
          return `${head} ${b.step} done: ${ev.result.slice(0, 2000)}`
        case 'error':
          return `${head} ${b.step} error${ev.fatal ? ' (fatal)' : ''}: ${ev.message}`
        case 'session':
          return `${head} ${b.step} session started`
      }
      return `${head} ${b.step} event`
    }
    case 'step-status':
      return `${head} ${b.step} ${b.status}${b.reason !== undefined ? `: ${b.reason}` : ''}`
    case 'run-status':
      return `${head} run ${b.status} (${b.phase})${b.outcome !== undefined ? ` ${b.outcome}` : ''}`
    case 'card': {
      const title = (b.card as { title?: unknown }).title
      return `${head} card ${b.state}${typeof title === 'string' ? `: ${title}` : ''}${b.choiceId !== undefined ? ` -> ${b.choiceId}` : ''}`
    }
    case 'ask-resolved':
      return `${head} ${b.step} question answered by ${b.by}${b.decision !== undefined ? `: ${b.decision}` : ''}`
    case 'snag':
      return `${head} ${b.step} snag: ${b.failure.category}`
    case 'diff-stats':
      return `${head} files changed: ${b.files} (+${b.added} -${b.deleted})`
    case 'output':
      return `${head} output ${b.file} updated`
    case 'guardrail':
      return `${head} ${b.step} guardrail ${b.finding.rule}: ${b.finding.subject}${b.undone ? ' (put back)' : ''}`
    case 'auto-answered':
      return `${head} ${b.step} ${b.tool} ${b.decision} automatically (${b.why})`
    case 'usage':
      return `${head} ${b.step} usage: ${b.usage.input} in, ${b.usage.output} out`
    case 'context':
      return `${head} ${b.step} context: ${b.percent !== undefined ? `${b.percent}%` : 'n/a'}, ${b.compactions} summaries${b.compacting ? ', summarising' : ''}`
    case 'ask-extended':
      return `${head} ${b.step} question extended`
  }
}

const RunIdArg = z.string().min(1).max(128).describe('The run id (from list_runs).')
const SegmentArg = z
  .enum(DIFF_SEGMENTS)
  .optional()
  .describe('implement (Implement only), fix (Fix only) or combined (default: the whole run).')

/** Add Dim Factory's tools to `server`. `requestedBy`: the caller's name for request_run when it gives none. */
export function registerDimFactoryTools(
  server: McpServer,
  deps: McpToolDeps,
  requestedBy: (given: string | undefined) => string,
): void {
  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description:
        "Dim Factory's runs, newest first: id, number, title, folder, status, outcome, cost and findings counts. Page with `cursor`.",
      inputSchema: {
        status: z.array(z.enum(RUN_STATUSES)).max(RUN_STATUSES.length).optional(),
        folder: z.string().min(1).max(4096).optional().describe('Only runs in this folder (absolute path).'),
        limit: z.number().int().min(1).max(MCP_LIST_MAX).optional().describe(`At most ${MCP_LIST_MAX}.`),
        cursor: z.string().max(128).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const page = await call(deps, 'runs.list', {
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.folder !== undefined ? { folder: resolve(a.folder) } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
        limit: a.limit ?? 20,
      })
      return answer({ runs: page.items.map(runBrief), nextCursor: page.nextCursor })
    }),
  )

  server.registerTool(
    'get_run',
    {
      title: 'Get a run',
      description:
        'One run: its task, passes with their status, vendor and model, time left, cost, findings counts, outcome or failure, and what waits for the user.',
      inputSchema: { runId: RunIdArg },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const snap = await call(deps, 'runs.get', { runId: a.runId })
      return answer(runDetail(snap, await deps.readTask(a.runId)))
    }),
  )

  server.registerTool(
    'get_findings',
    {
      title: 'Get findings',
      description: "The run's review findings (must and should), with what Fix did about each when it ran.",
      inputSchema: { runId: RunIdArg },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const r = await deps.invoke('runs.output', { runId: a.runId, file: 'findings' })
      if (!r.ok) {
        if (r.error.code === 'NOT_FOUND') return answer({ findings: [], note: 'No findings yet.' })
        throw new DimFactoryError(r.error.code, r.error.message)
      }
      let file: FindingsFile
      try {
        file = JSON.parse(r.value.text) as FindingsFile
      } catch {
        return failure('The findings file could not be read.')
      }
      const findings = (Array.isArray(file.findings) ? file.findings : []).slice(0, 200).map((f) => ({
        n: f.n,
        id: f.id,
        severity: f.severity,
        source: f.source,
        title: f.title,
        ...(f.body !== '' ? { body: f.body.slice(0, 4000) } : {}),
        ...(f.flags.length > 0 ? { flags: f.flags } : {}),
        selectedForFix: file.selected?.[f.id] === true,
        ...(file.fixReport?.[f.id] !== undefined ? { fix: file.fixReport[f.id] } : {}),
      }))
      return answer({ round: file.round, sources: file.sources, findings })
    }),
  )

  server.registerTool(
    'get_plan',
    {
      title: 'Get the plan',
      description: "The run's plan (Markdown), as Plan wrote it or as the user edited it.",
      inputSchema: { runId: RunIdArg },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const r = await deps.invoke('runs.output', { runId: a.runId, file: 'plan' })
      if (!r.ok) {
        if (r.error.code === 'NOT_FOUND') return answer({ plan: null, note: 'This run has no plan yet.' })
        throw new DimFactoryError(r.error.code, r.error.message)
      }
      const t = capText(r.value.text, MCP_TEXT_MAX)
      return { content: [{ type: 'text', text: t.text }] }
    }),
  )

  server.registerTool(
    'get_diff',
    {
      title: 'Get the diff',
      description: `The files the run changed in a segment; with \`path\` (one of them), that file's patch (cut at ${MCP_PATCH_MAX / 1024} KB).`,
      inputSchema: {
        runId: RunIdArg,
        segment: SegmentArg,
        path: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe('A changed file, exactly as the file list names it.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const seg: DiffSegment = a.segment ?? 'combined'
      const files = await call(deps, 'diff.files', { runId: a.runId, seg })
      if (a.path === undefined) {
        return answer({
          segment: seg,
          available: files.available,
          total: files.files.length,
          files: files.files.slice(0, MCP_DIFF_FILES_MAX).map((f) => ({
            path: f.path,
            ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
            status: f.status,
            added: f.added,
            deleted: f.deleted,
            ...(f.binary ? { binary: true } : {}),
          })),
          ...(files.files.length > MCP_DIFF_FILES_MAX
            ? { cut: files.files.length - MCP_DIFF_FILES_MAX }
            : {}),
        })
      }
      const want = a.path
      const hit = files.files.find((f) => f.path === want || f.oldPath === want)
      if (hit === undefined) return failure(`${want} is not a file this run changed in the ${seg} segment.`)
      const patch = await call(deps, 'diff.file', { runId: a.runId, seg, path: hit.path })
      const t = capText(patch.patch, MCP_PATCH_MAX)
      return answer({
        segment: seg,
        path: hit.path,
        truncated: patch.truncated || t.truncated,
        patch: t.text,
      })
    }),
  )

  server.registerTool(
    'get_log',
    {
      title: 'Get the log',
      description: `The run's most recent events (passes starting and ending, tools, questions, errors), at most ${MCP_LOG_MAX_EVENTS}.`,
      inputSchema: {
        runId: RunIdArg,
        limit: z.number().int().min(1).max(MCP_LOG_MAX_EVENTS).optional().describe('Default 100.'),
      },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const limit = a.limit ?? 100
      const snap = await call(deps, 'runs.get', { runId: a.runId })
      const sinceSeq = Math.max(0, snap.lastSeq - limit)
      const page = await call(deps, 'runs.events', { runId: a.runId, sinceSeq, limit, condensed: true })
      const lines = page.events.slice(-limit).map(describeEvent)
      const t = capText(lines.join('\n'), MCP_TEXT_MAX)
      return { content: [{ type: 'text', text: t.text === '' ? 'No events yet.' : t.text }] }
    }),
  )

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description: 'The folders Dim Factory has run in, most recent first, and whether each still exists.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const folders = await call(deps, 'folders.recent', undefined)
      return answer({
        folders: folders.slice(0, MCP_LIST_MAX).map((f) => ({
          folder: f.folder,
          lastRunAt: new Date(f.lastRunAt).toISOString(),
          isGit: f.isGit,
          exists: f.exists,
        })),
      })
    }),
  )

  server.registerTool(
    'get_estimate',
    {
      title: 'Estimate a run',
      description:
        'What a run in this folder would take and cost (from earlier runs, or typical figures), per pass and in total. Starts nothing.',
      inputSchema: {
        folder: z.string().min(1).max(4096).describe('Absolute folder path.'),
        profile: z.string().min(1).max(32).optional(),
      },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const folder = await deps.checkFolder(a.folder)
      const est = await call(deps, 'estimates.get', {
        folder,
        ...(a.profile !== undefined ? { overrides: { profile: a.profile } } : {}),
      })
      return answer(est)
    }),
  )

  server.registerTool(
    'request_run',
    {
      title: 'Ask for a run',
      description:
        'Ask Dim Factory to run a task in a folder. Nothing starts: the user approves or declines the request in Dim Factory. Answers a request id with status pending_approval.',
      inputSchema: {
        folder: z.string().min(1).max(4096).describe('Absolute folder path (see list_folders).'),
        task: z
          .string()
          .min(1)
          .max(MCP_TASK_MAX)
          .describe('What the run should do, as you would tell a developer.'),
        profile: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe("A profile name; default: the folder's default."),
        notes: z
          .string()
          .max(MCP_NOTES_MAX)
          .optional()
          .describe('Why you ask, for the user (shown with the request, not sent to the run).'),
        requestedBy: z.string().min(1).max(80).optional().describe('Your name, as the user knows you.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (a) => {
      if (a.task.trim() === '') return failure('The task is empty.')
      const folder = await deps.checkFolder(a.folder)
      if (a.profile !== undefined) {
        const resolved = await call(deps, 'config.resolve', { folder })
        const names = resolved.profiles ?? []
        if (names.length > 0 && !names.includes(a.profile)) {
          return failure(`There is no profile "${a.profile}" for this folder. Profiles: ${names.join(', ')}.`)
        }
      }
      const req = await deps.requests.add({
        folder,
        task: a.task,
        ...(a.profile !== undefined ? { profile: a.profile } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}),
        requestedBy: requestedBy(a.requestedBy),
      })
      return answer(requestView(req))
    }),
  )

  server.registerTool(
    'get_request_status',
    {
      title: 'Request status',
      description:
        'What became of a request_run: pending_approval, approved (with the run id), declined or expired.',
      inputSchema: { requestId: z.string().min(1).max(128) },
      annotations: READ_ONLY,
    },
    guarded(async (a) => {
      const r = await deps.requests.get(a.requestId)
      if (r === undefined) return failure('No such request (it may have been settled long ago).')
      return answer(requestView(r))
    }),
  )
}

/** What an agent sees of a request. */
export function requestView(r: McpRunRequest): Record<string, unknown> {
  return {
    requestId: r.id,
    status: r.status === 'pending' ? 'pending_approval' : r.status,
    folder: r.folder,
    task: r.task.length > 2000 ? `${r.task.slice(0, 2000)}...` : r.task,
    ...(r.profile !== undefined ? { profile: r.profile } : {}),
    requestedAt: new Date(r.requestedAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    ...(r.runId !== undefined ? { runId: r.runId, runNumber: r.displayNo } : {}),
    ...(r.status === 'pending'
      ? { note: 'The user approves or declines this in Dim Factory. Nothing runs until then.' }
      : {}),
  }
}

/**
 * A folder an agent named: absolute, no NUL, resolved. On Windows also a local drive path only, checked before
 * anything touches the disk: a UNC path (`\\host\share`, which would make Windows connect to that host and offer it
 * the user's sign-in), a device path (`\\?\`, `\\.\`) and an alternate data stream (`C:\proj::$INDEX_ALLOCATION`, a `:`
 * after the drive) are refused. VALIDATION otherwise.
 */
export function normalizeAgentFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? win32 : posix
  if (folder.includes('\u0000') || !P.isAbsolute(folder)) {
    throw new DimFactoryError('VALIDATION', 'The folder must be an absolute path.')
  }
  if (platform === 'win32' && !/^[A-Za-z]:[\\/][^:]*$/.test(folder)) {
    throw new DimFactoryError(
      'VALIDATION',
      'The folder must be a local drive path such as C:\\code\\project (no network, device or stream path).',
    )
  }
  return P.resolve(folder)
}
