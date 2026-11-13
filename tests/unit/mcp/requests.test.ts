// Outside agents' run requests: a pending record only (persisted, announced), the same request answered once, at most
// MCP_MAX_PENDING waiting, expiry after a day, settling once (approved with its run, or declined), and settled ones kept
// for a while for get_request_status.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../../../src/core/log.ts'
import {
  MCP_MAX_PENDING,
  MCP_REQUEST_TTL_MS,
  MCP_SETTLED_KEEP_MS,
  McpRequestStore,
} from '../../../src/core/mcp/requests.ts'
import type { McpRunRequest } from '../../../src/shared/ipc.ts'

const dirs: string[] = []
const stores: McpRequestStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(start = 1_000_000): {
  store: () => McpRequestStore
  file: string
  clock: { now: number }
  events: McpRunRequest[][]
} {
  const dir = mkdtempSync(join(tmpdir(), 'dim-factory-mcp-req-'))
  dirs.push(dir)
  const file = join(dir, 'mcp-requests.json')
  const clock = { now: start }
  const events: McpRunRequest[][] = []
  return {
    file,
    clock,
    events,
    store: () => {
      const s = new McpRequestStore({
        file,
        now: () => clock.now,
        log: silentLogger,
        onChange: (p) => events.push(p),
      })
      stores.push(s)
      return s
    },
  }
}

const REQ = { folder: 'C:\\work\\app', task: 'Add a --version flag', requestedBy: 'Claude Code 2.1' }

describe('McpRequestStore', () => {
  it('adds a pending request, persists it and announces the pending list', async () => {
    const t = setup()
    const s = t.store()
    const r = await s.add({ ...REQ, profile: 'balanced', notes: 'the user asked' })
    expect(r).toMatchObject({
      status: 'pending',
      folder: REQ.folder,
      task: REQ.task,
      profile: 'balanced',
      notes: 'the user asked',
      requestedBy: 'Claude Code 2.1',
      requestedAt: 1_000_000,
      expiresAt: 1_000_000 + MCP_REQUEST_TTL_MS,
    })
    expect(r.id).toMatch(/^req-[A-Za-z0-9_-]{12}$/)
    expect(t.events.at(-1)?.map((x) => x.id)).toEqual([r.id])
    const disk = JSON.parse(readFileSync(t.file, 'utf8')) as { schemaVersion: number; requests: unknown[] }
    expect(disk.schemaVersion).toBe(1)
    expect(disk.requests).toHaveLength(1)
    // A new store (the next launch) reads it back.
    expect((await t.store().pending()).map((x) => x.id)).toEqual([r.id])
  })

  it('answers the same folder and task with the request already waiting', async () => {
    const s = setup().store()
    const a = await s.add(REQ)
    const b = await s.add(REQ)
    expect(b.id).toBe(a.id)
    expect(await s.pending()).toHaveLength(1)
  })

  it(`keeps at most ${MCP_MAX_PENDING} waiting`, async () => {
    const s = setup().store()
    for (let i = 0; i < MCP_MAX_PENDING; i++) await s.add({ ...REQ, task: `task ${i}` })
    await expect(s.add({ ...REQ, task: 'one more' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await s.pending()).toHaveLength(MCP_MAX_PENDING)
  })

  it('expires a request after a day', async () => {
    const t = setup()
    const s = t.store()
    const r = await s.add(REQ)
    t.clock.now += MCP_REQUEST_TTL_MS - 1
    expect(await s.pending()).toHaveLength(1)
    t.clock.now += 1
    expect(s.pendingNow()).toEqual([])
    expect(await s.pending()).toEqual([])
    expect(t.events.at(-1)).toEqual([])
    expect(await s.get(r.id)).toMatchObject({ status: 'expired', resolvedAt: t.clock.now })
    await expect(s.pendingOne(r.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(s.settle(r.id, { status: 'declined' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('settles once: approved with its run, or declined', async () => {
    const s = setup().store()
    const a = await s.add({ ...REQ, task: 'a' })
    const b = await s.add({ ...REQ, task: 'b' })
    expect(await s.pendingOne(a.id)).toMatchObject({ id: a.id, status: 'pending' })
    expect(await s.settle(a.id, { status: 'approved', runId: 'run-1', displayNo: 7 })).toMatchObject({
      status: 'approved',
      runId: 'run-1',
      displayNo: 7,
    })
    await s.settle(b.id, { status: 'declined' })
    await expect(s.settle(a.id, { status: 'declined' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(s.pendingOne('req-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await s.pending()).toEqual([])
    expect((await s.get(b.id))?.status).toBe('declined')
  })

  it('records an approval whose run started while the request expired, and nothing else after expiry', async () => {
    const t = setup()
    const s = t.store()
    const a = await s.add({ ...REQ, task: 'a' })
    const b = await s.add({ ...REQ, task: 'b' })
    // The user approved `a` while it was pending; its run took long enough to start that it expired meanwhile.
    expect(await s.pendingOne(a.id)).toMatchObject({ status: 'pending' })
    t.clock.now += MCP_REQUEST_TTL_MS
    expect(await s.settle(a.id, { status: 'approved', runId: 'run-9', displayNo: 9 })).toMatchObject({
      status: 'approved',
      runId: 'run-9',
    })
    expect((await s.get(a.id))?.status).toBe('approved')
    await expect(s.settle(b.id, { status: 'declined' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      s.settle(a.id, { status: 'approved', runId: 'run-10', displayNo: 10 }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('drops settled requests after a week', async () => {
    const t = setup()
    const s = t.store()
    const r = await s.add(REQ)
    await s.settle(r.id, { status: 'declined' })
    t.clock.now += MCP_SETTLED_KEEP_MS
    expect(await s.get(r.id)).toBeUndefined()
  })

  it('starts empty from a corrupt file', async () => {
    const t = setup()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(t.file, '{nope')
    expect(await t.store().pending()).toEqual([])
  })
})
