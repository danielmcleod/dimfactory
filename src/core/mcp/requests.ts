// Run requests from outside agents (DIM_FACTORY_HOME/mcp-requests.json). A request is only a record: nothing is spawned
// until the user approves it in Dim Factory, and approving starts the run through runs.start (its authoritative
// preflight). At most MCP_MAX_PENDING wait at once; each expires MCP_REQUEST_TTL_MS after it was made. Settled requests
// (approved, declined, expired) are kept a while so get_request_status can still answer, then dropped.
import { randomBytes } from 'node:crypto'
import type { McpRunRequest } from '../../shared/ipc.ts'
import { MCP_REQUEST_STATUSES } from '../../shared/ipc.ts'
import { DimFactoryError } from '../errors.ts'
import type { Logger } from '../log.ts'
import { isPlainObject, readVersionedJson, writeVersionedJson } from '../store/versions.ts'

export const MCP_REQUEST_TTL_MS = 24 * 60 * 60_000
export const MCP_MAX_PENDING = 5
/** Settled requests kept for get_request_status: this many, for at most this long. */
export const MCP_SETTLED_KEEP = 50
export const MCP_SETTLED_KEEP_MS = 7 * 24 * 60 * 60_000
export const MCP_TASK_MAX = 100 * 1024
export const MCP_NOTES_MAX = 4 * 1024

export interface NewRequest {
  folder: string
  task: string
  profile?: string
  notes?: string
  requestedBy: string
}

function parseRequest(v: unknown): McpRunRequest | null {
  if (!isPlainObject(v)) return null
  const s = (k: string): string | undefined => (typeof v[k] === 'string' ? v[k] : undefined)
  const n = (k: string): number | undefined =>
    typeof v[k] === 'number' && Number.isFinite(v[k]) ? v[k] : undefined
  const id = s('id')
  const folder = s('folder')
  const task = s('task')
  const requestedBy = s('requestedBy')
  const requestedAt = n('requestedAt')
  const expiresAt = n('expiresAt')
  const status = s('status')
  if (
    id === undefined ||
    folder === undefined ||
    task === undefined ||
    requestedBy === undefined ||
    requestedAt === undefined ||
    expiresAt === undefined ||
    !(MCP_REQUEST_STATUSES as readonly string[]).includes(status ?? '')
  )
    return null
  const profile = s('profile')
  const notes = s('notes')
  const runId = s('runId')
  const displayNo = n('displayNo')
  const resolvedAt = n('resolvedAt')
  return {
    id,
    folder,
    task,
    requestedBy,
    requestedAt,
    expiresAt,
    status: status as McpRunRequest['status'],
    ...(profile !== undefined ? { profile } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(displayNo !== undefined ? { displayNo } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  }
}

export class McpRequestStore {
  readonly #file: string
  readonly #now: () => number
  readonly #log: Logger
  readonly #onChange: (pending: McpRunRequest[]) => void
  #items: McpRunRequest[] = []
  #loaded: Promise<void> | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(o: {
    file: string
    now: () => number
    log: Logger
    /** The pending list after every change (the `mcp-requests` event). */
    onChange: (pending: McpRunRequest[]) => void
  }) {
    this.#file = o.file
    this.#now = o.now
    this.#log = o.log
    this.#onChange = o.onChange
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const r = await readVersionedJson<Record<string, unknown>>(this.#file)
      if (r.kind === 'ok' && Array.isArray(r.value['requests'])) {
        this.#items = (r.value['requests'] as unknown[])
          .map(parseRequest)
          .filter((x): x is McpRunRequest => x !== null)
      } else if (r.kind === 'corrupt') this.#log.warn('mcp-requests.json is corrupt; starting empty')
    })()
    return this.#loaded
  }

  /** Expire what is due and drop old settled requests; true when anything changed. */
  #sweep(): boolean {
    const now = this.#now()
    let changed = false
    for (const r of this.#items) {
      if (r.status === 'pending' && r.expiresAt <= now) {
        r.status = 'expired'
        r.resolvedAt = now
        changed = true
      }
    }
    const settled = this.#items.filter((r) => r.status !== 'pending')
    const keep = new Set(
      settled
        .filter((r) => now - (r.resolvedAt ?? r.requestedAt) < MCP_SETTLED_KEEP_MS)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
        .slice(0, MCP_SETTLED_KEEP)
        .map((r) => r.id),
    )
    const next = this.#items.filter((r) => r.status === 'pending' || keep.has(r.id))
    if (next.length !== this.#items.length) changed = true
    this.#items = next
    return changed
  }

  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    const next = Math.min(...this.pendingNow().map((r) => r.expiresAt))
    if (!Number.isFinite(next)) return
    const delay = Math.max(1000, Math.min(next - this.#now() + 50, 2 ** 31 - 1))
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#mutate(() => true).catch(() => undefined)
    }, delay)
    this.#timer.unref?.()
  }

  /** Run `fn` on the loaded, swept list; persist and announce when it (or the sweep) changed something. */
  #mutate<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.#load()
      const swept = this.#sweep()
      const before = JSON.stringify(this.#items)
      const out = fn()
      if (swept || JSON.stringify(this.#items) !== before) {
        await writeVersionedJson(this.#file, { requests: this.#items })
        this.#onChange(this.pendingNow())
      }
      this.#arm()
      return out
    }
    const p = this.#queue.then(run, run)
    this.#queue = p.catch(() => undefined)
    return p
  }

  /** Pending requests as last loaded (oldest first), without touching the disk. */
  pendingNow(): McpRunRequest[] {
    const now = this.#now()
    return this.#items.filter((r) => r.status === 'pending' && r.expiresAt > now).map((r) => ({ ...r }))
  }

  async pending(): Promise<McpRunRequest[]> {
    return this.#mutate(() => this.pendingNow())
  }

  async get(id: string): Promise<McpRunRequest | undefined> {
    return this.#mutate(() => {
      const r = this.#items.find((x) => x.id === id)
      return r !== undefined ? { ...r } : undefined
    })
  }

  /** Add a request (the same folder and task already waiting answers that one). CONFLICT when too many wait. */
  async add(req: NewRequest): Promise<McpRunRequest> {
    return this.#mutate(() => {
      const same = this.#items.find(
        (r) => r.status === 'pending' && r.folder === req.folder && r.task === req.task,
      )
      if (same !== undefined) return { ...same }
      if (this.pendingNow().length >= MCP_MAX_PENDING) {
        throw new DimFactoryError(
          'CONFLICT',
          `${MCP_MAX_PENDING} requests already wait for the user in Dim Factory. Ask again once they have answered.`,
        )
      }
      const now = this.#now()
      const r: McpRunRequest = {
        id: `req-${randomBytes(9).toString('base64url')}`,
        folder: req.folder,
        task: req.task,
        ...(req.profile !== undefined ? { profile: req.profile } : {}),
        ...(req.notes !== undefined && req.notes !== '' ? { notes: req.notes } : {}),
        requestedBy: req.requestedBy,
        requestedAt: now,
        expiresAt: now + MCP_REQUEST_TTL_MS,
        status: 'pending',
      }
      this.#items.push(r)
      return { ...r }
    })
  }

  /** The pending request `id` (NOT_FOUND / CONFLICT otherwise). */
  async pendingOne(id: string): Promise<McpRunRequest> {
    return this.#mutate(() => {
      const r = this.#items.find((x) => x.id === id)
      if (r === undefined) throw new DimFactoryError('NOT_FOUND', 'That request is gone.')
      if (r.status !== 'pending') {
        throw new DimFactoryError('CONFLICT', `That request was already ${r.status}.`, {
          details: { status: r.status },
        })
      }
      return { ...r }
    })
  }

  /**
   * Settle a pending request (approved with its run, or declined). An approval whose run started is recorded even
   * when the request expired while the run was starting (the user approved it while it was pending).
   */
  async settle(
    id: string,
    outcome: { status: 'approved'; runId: string; displayNo: number } | { status: 'declined' },
  ): Promise<McpRunRequest> {
    return this.#mutate(() => {
      const r = this.#items.find((x) => x.id === id)
      if (r === undefined) throw new DimFactoryError('NOT_FOUND', 'That request is gone.')
      const expiredWhileStarting = outcome.status === 'approved' && r.status === 'expired'
      if (r.status !== 'pending' && !expiredWhileStarting) {
        throw new DimFactoryError('CONFLICT', `That request was already ${r.status}.`, {
          details: { status: r.status },
        })
      }
      r.status = outcome.status
      r.resolvedAt = this.#now()
      if (outcome.status === 'approved') {
        r.runId = outcome.runId
        r.displayNo = outcome.displayNo
      }
      return { ...r }
    })
  }

  /** Load and announce the list (boot), arming the expiry timer. */
  async init(): Promise<void> {
    await this.#mutate(() => undefined)
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
