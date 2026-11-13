import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'

// The starter modules are plain JavaScript, so they are loaded by file URL and described with local interfaces.
interface Msg {
  type: string
  [key: string]: unknown
}
interface Client {
  receive: (text: string) => string | undefined
  close: () => void
}
interface Rooms {
  connect: (send: (obj: Msg) => void) => Client
  size: number
}
interface RulesLike {
  initialState: (n: number) => unknown
  applyMove: (
    s: unknown,
    i: number,
    m: unknown,
  ) => { ok: true; state: unknown } | { ok: false; reason: string }
}
interface RoomsModule {
  createRooms: (o: { rules: RulesLike; maxPlayers?: number; maxRooms?: number; now?: () => number }) => Rooms
  parseMessage: (t: unknown) => { ok: boolean; reason?: string; message?: Msg }
  ROOM_CODE_PATTERN: RegExp
  MESSAGE_MAX_BYTES: number
  RATE_MAX_MESSAGES: number
  RATE_WINDOW_MS: number
}
interface ServerHandle {
  url: string
  host: string
  port: number
  close: () => Promise<void>
}
interface ServerModule {
  startServer: (o: Record<string, unknown>) => Promise<ServerHandle>
}

const dir = fileURLToPath(new URL('../../../src/core/templates/vendor/starter/game-online/', import.meta.url))
let tmp = ''
let roomsMod: RoomsModule
let serverMod: ServerModule

beforeAll(async () => {
  // server.js imports ./src/server/rooms.js, so lay the files out the way a game project has them.
  tmp = mkdtempSync(join(tmpdir(), 'dimfactory-online-'))
  mkdirSync(join(tmp, 'src', 'server'), { recursive: true })
  copyFileSync(join(dir, 'server.js'), join(tmp, 'server.js'))
  copyFileSync(join(dir, 'rooms.js'), join(tmp, 'src', 'server', 'rooms.js'))
  writeFileSync(join(tmp, 'index.html'), '<h1>game</h1>')
  writeFileSync(join(tmp, 'package.json'), '{}')
  writeFileSync(join(tmp, '.env'), 'SECRET=1')
  roomsMod = (await import(
    /* @vite-ignore */ pathToFileURL(join(tmp, 'src', 'server', 'rooms.js')).href
  )) as RoomsModule
  serverMod = (await import(/* @vite-ignore */ pathToFileURL(join(tmp, 'server.js')).href)) as ServerModule
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A tiny take-turns game: players add 1 to 3 to a total, in turn. */
const rules: RulesLike = {
  initialState: (n) => ({ turn: 0, total: 0, players: n }),
  applyMove(s, i, m) {
    const st = s as { turn: number; total: number; players: number }
    if (i !== st.turn) return { ok: false, reason: 'Not your turn' }
    const add = (m as { add?: unknown } | null)?.add
    if (typeof add !== 'number' || add < 1 || add > 3) return { ok: false, reason: 'Add 1 to 3' }
    return { ok: true, state: { ...st, turn: (st.turn + 1) % st.players, total: st.total + add } }
  },
}

function player(rooms: Rooms) {
  const got: Msg[] = []
  const client = rooms.connect((o) => got.push(o))
  const send = (o: unknown) => client.receive(JSON.stringify(o))
  return { got, client, send, last: () => got[got.length - 1] as Msg }
}

describe('online rooms', () => {
  it('creates a room with a valid code, joins it, and starts when full', () => {
    const rooms = roomsMod.createRooms({ rules })
    const a = player(rooms)
    const b = player(rooms)
    a.send({ type: 'create' })
    const code = a.last().code as string
    expect(code).toMatch(roomsMod.ROOM_CODE_PATTERN)
    expect(code).toHaveLength(5)
    expect(a.last().type).toBe('waiting')
    b.send({ type: 'join', code })
    expect(a.last()).toEqual({ type: 'state', state: { turn: 0, total: 0, players: 2 }, you: 0, code })
    expect(b.last()).toMatchObject({ type: 'state', you: 1, code })
  })

  it('refuses a full room and an unknown code', () => {
    const rooms = roomsMod.createRooms({ rules })
    const a = player(rooms)
    const b = player(rooms)
    const c = player(rooms)
    a.send({ type: 'create' })
    const code = a.last().code as string
    b.send({ type: 'join', code })
    c.send({ type: 'join', code })
    expect(c.last()).toEqual({ type: 'error', reason: 'Room is full' })
    c.send({ type: 'join', code: code === 'ZZZZZ' ? 'YYYYY' : 'ZZZZZ' })
    expect(c.last()).toEqual({ type: 'error', reason: 'No such room' })
  })

  it('refuses new rooms past maxRooms', () => {
    const rooms = roomsMod.createRooms({ rules, maxRooms: 1 })
    player(rooms).send({ type: 'create' })
    const b = player(rooms)
    b.send({ type: 'create' })
    expect(b.last().type).toBe('error')
    expect(rooms.size).toBe(1)
  })

  it('applies a legal move for both players and refuses a wrong-player move to the sender only', () => {
    const rooms = roomsMod.createRooms({ rules })
    const a = player(rooms)
    const b = player(rooms)
    a.send({ type: 'create' })
    b.send({ type: 'join', code: a.last().code })
    const before = a.got.length
    b.send({ type: 'move', move: { add: 2 } })
    expect(b.last()).toEqual({ type: 'error', reason: 'Not your turn' })
    expect(a.got.length).toBe(before)
    a.send({ type: 'move', move: { add: 2 } })
    expect((a.last().state as { total: number }).total).toBe(2)
    expect((b.last().state as { total: number }).total).toBe(2)
    expect(b.last().you).toBe(1)
  })

  it('answers bad input with an error and never throws', () => {
    const rooms = roomsMod.createRooms({ rules })
    const a = player(rooms)
    const bad = [
      'not json',
      '"text"',
      '[]',
      'null',
      JSON.stringify({ type: 'nope' }),
      JSON.stringify({ type: 'join', code: 'abc' }),
      JSON.stringify({ type: 'join' }),
      JSON.stringify({ type: 'move' }),
      '{"__proto__":{"type":"create"}}',
      '{"constructor":{"type":"create"}}',
      'x'.repeat(roomsMod.MESSAGE_MAX_BYTES + 1),
      JSON.stringify({ type: 'move', move: [[[[[[1]]]]]] }),
    ]
    for (const text of bad) {
      const n = a.got.length
      expect(() => a.client.receive(text), text.slice(0, 20)).not.toThrow()
      expect(a.got.length).toBe(n + 1)
      expect(a.last().type).toBe('error')
    }
    expect(rooms.size).toBe(0)
    expect(() => a.client.receive(42 as unknown as string)).not.toThrow()
    expect(roomsMod.parseMessage({ type: 'create' }).ok).toBe(false)
  })

  it('drops __proto__ keys inside a move', () => {
    const parsed = roomsMod.parseMessage('{"type":"move","move":{"add":1,"__proto__":{"x":1}}}')
    expect(parsed.ok).toBe(true)
    expect(parsed.message?.move).toEqual({ add: 1 })
    expect(Object.getPrototypeOf(parsed.message?.move)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('rate limits: the 21st message in a window is told off once, flooding makes receive return close', () => {
    let t = 1000
    const rooms = roomsMod.createRooms({ rules, now: () => t })
    const a = player(rooms)
    for (let i = 0; i < roomsMod.RATE_MAX_MESSAGES; i++)
      expect(a.client.receive('{"type":"leave"}')).toBeUndefined()
    expect(a.got).toHaveLength(0)
    expect(a.client.receive('{"type":"leave"}')).toBeUndefined()
    expect(a.last()).toEqual({ type: 'error', reason: 'Too many messages' })
    for (let i = 0; i < 10; i++) a.client.receive('{"type":"leave"}')
    expect(a.got).toHaveLength(1)
    // Two more windows over the limit in a row.
    let result: string | undefined
    for (let w = 0; w < 2; w++) {
      t += roomsMod.RATE_WINDOW_MS
      for (let i = 0; i <= roomsMod.RATE_MAX_MESSAGES; i++) result = a.client.receive('{"type":"leave"}')
    }
    expect(result).toBe('close')
  })

  it('a quiet window resets the rate limit', () => {
    let t = 0
    const rooms = roomsMod.createRooms({ rules, now: () => t })
    const a = player(rooms)
    for (let w = 0; w < 5; w++) {
      t += roomsMod.RATE_WINDOW_MS
      for (let i = 0; i <= roomsMod.RATE_MAX_MESSAGES; i++)
        expect(a.client.receive('{"type":"leave"}')).toBeUndefined()
      t += roomsMod.RATE_WINDOW_MS
      a.client.receive('{"type":"leave"}')
    }
  })

  it('tells the other player when someone leaves or disconnects, and closes empty rooms', () => {
    const rooms = roomsMod.createRooms({ rules })
    const a = player(rooms)
    const b = player(rooms)
    a.send({ type: 'create' })
    b.send({ type: 'join', code: a.last().code })
    b.send({ type: 'leave' })
    expect(a.last()).toEqual({ type: 'left' })
    expect(rooms.size).toBe(1)
    a.client.close()
    expect(rooms.size).toBe(0)
  })
})

// A stand-in for the ws package's WebSocketServer, so no real WebSocket library is needed.
class FakeSocket extends EventEmitter {
  readyState = 1
  sent: string[] = []
  closedWith: number | undefined
  send(s: string) {
    this.sent.push(s)
  }
  close(code?: number) {
    this.closedWith = code
    this.readyState = 3
    this.emit('close')
  }
}
interface VerifyInfo {
  origin?: string
  req?: { headers: Record<string, string> }
}
class FakeWss extends EventEmitter {
  static last: FakeWss
  closed = false
  options: { path: string; maxPayload: number; verifyClient: (i: VerifyInfo) => boolean }
  constructor(options: { path: string; maxPayload: number; verifyClient: (i: VerifyInfo) => boolean }) {
    super()
    this.options = options
    FakeWss.last = this
  }
  close() {
    this.closed = true
  }
}

describe('online server', () => {
  const running: ServerHandle[] = []
  afterEach(async () => {
    while (running.length) await running.pop()!.close()
  })
  async function start(extra: Record<string, unknown> = {}) {
    const lines: string[] = []
    const handle = await serverMod.startServer({
      WebSocketServer: FakeWss,
      rules,
      root: tmp,
      port: 0,
      log: (l: string) => lines.push(l),
      ...extra,
    })
    running.push(handle)
    return { handle, lines }
  }

  it('binds 127.0.0.1 by default and logs the page address', async () => {
    const saved = process.env.HOST
    delete process.env.HOST
    try {
      const { handle, lines } = await start()
      expect(handle.host).toBe('127.0.0.1')
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`)
      expect(handle.port).toBeGreaterThan(0)
      expect(lines).toEqual([`Game server: http://127.0.0.1:${handle.port}/`])
      const res = await fetch(handle.url)
      expect(res.status).toBe(200)
    } finally {
      if (saved !== undefined) process.env.HOST = saved
    }
  })

  it('configures the ws server and checks the origin', async () => {
    const { handle } = await start()
    const o = FakeWss.last.options
    expect(o.path).toBe('/play')
    expect(o.maxPayload).toBe(2048)
    expect(o.maxPayload).toBe(roomsMod.MESSAGE_MAX_BYTES)
    expect(o.verifyClient({ origin: `http://127.0.0.1:${handle.port}` })).toBe(true)
    expect(o.verifyClient({ origin: `http://localhost:${handle.port}` })).toBe(true)
    expect(o.verifyClient({ req: { headers: { origin: `http://127.0.0.1:${handle.port}` } } })).toBe(true)
    expect(o.verifyClient({ origin: 'https://evil.example' })).toBe(false)
    expect(o.verifyClient({})).toBe(false)
    expect(o.verifyClient({ origin: '' })).toBe(false)
  })

  it('uses explicit allowed origins', async () => {
    await start({ allowedOrigins: ['https://play.example'] })
    const o = FakeWss.last.options
    expect(o.verifyClient({ origin: 'https://play.example' })).toBe(true)
    expect(o.verifyClient({ origin: 'http://127.0.0.1:1' })).toBe(false)
  })

  it('serves static files read-only with safe headers and refuses private paths', async () => {
    const { handle } = await start()
    const res = await fetch(handle.url)
    expect(await res.text()).toBe('<h1>game</h1>')
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain(`ws://127.0.0.1:${handle.port}`)
    for (const path of [
      '/../package.json',
      '/server.js',
      '/.env',
      '/src/server/rooms.js',
      '/node_modules/x',
      '/%2e%2e/x',
      '/a%00b',
    ]) {
      const r = await fetch(`http://127.0.0.1:${handle.port}${path}`)
      expect([403, 404], path).toContain(r.status)
      expect(await r.text()).not.toContain('SECRET')
    }
    const post = await fetch(handle.url, { method: 'POST', body: 'x' })
    expect(post.status).toBe(405)
  })

  it('wires sockets to rooms and closes flooding or binary clients', async () => {
    const { handle } = await start()
    const wss = FakeWss.last
    const a = new FakeSocket()
    const b = new FakeSocket()
    wss.emit('connection', a, {})
    wss.emit('connection', b, {})
    a.emit('message', Buffer.from('{"type":"create"}'), false)
    const code = (JSON.parse(a.sent[0] as string) as { code: string }).code
    b.emit('message', Buffer.from(JSON.stringify({ type: 'join', code })), false)
    expect(JSON.parse(b.sent[0] as string)).toMatchObject({ type: 'state', you: 1 })
    a.emit('message', Buffer.from('x'), true)
    expect(a.closedWith).toBe(1003)
    expect(JSON.parse(b.sent[1] as string)).toEqual({ type: 'left' })
    for (let i = 0; i < 100; i++) b.emit('message', Buffer.from('{"type":"leave"}'), false)
    expect(b.closedWith).toBeUndefined()
    await handle.close()
    expect(wss.closed).toBe(true)
    running.pop()
  })
})
