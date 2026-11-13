// canResume by rollout lookup (session.ts: token-free, no process) and the local preset's readiness
// against a fake loopback server (GET {baseUrl}/models, Ollama /api/show, LM Studio
// /api/v0/models, warn under 32k, loopback only).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCodexAdapter } from '@core/adapters/codex/index.ts'
import {
  listLocalModels,
  lmStudioContext,
  localReadiness,
  loopbackUrl,
  ollamaContext,
} from '@core/adapters/codex/local.ts'
import { codexHome, dayFolders, findRollout, uuidV7Time } from '@core/adapters/codex/session.ts'
import type { LocalPreset } from '@shared/vendors.ts'

// A made-up UUIDv7 (its first 48 bits are 2024-06-10T02:35:18.400Z).
const THREAD = '01900000-0000-7000-8000-000000000001'

describe('canResume: the thread has a rollout under CODEX_HOME', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('a UUIDv7 thread id carries its creation time', () => {
    expect(new Date(uuidV7Time(THREAD)!).toISOString()).toBe('2024-06-10T02:35:18.400Z')
    expect(uuidV7Time('not-a-uuid')).toBeUndefined()
    expect(dayFolders(uuidV7Time(THREAD)!)).toContain(join('2024', '06', '10'))
  })

  it('finds the rollout by name only; a missing or ephemeral thread is not resumable', async () => {
    expect(findRollout(home, THREAD)).toBeUndefined()
    const day = join(home, 'sessions', '2024', '06', '10')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2024-06-10T02-35-18-${THREAD}.jsonl`), '')
    expect(findRollout(home, THREAD)).toBe(join(day, `rollout-2024-06-10T02-35-18-${THREAD}.jsonl`))
    // A non-v7 id (no time in it) is found by walking the day folders.
    const v4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const other = join(home, 'sessions', '2025', '01', '02')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, `rollout-2025-01-02T00-00-00-${v4}.jsonl`), '')
    expect(findRollout(home, v4)).toBeDefined()
    expect(findRollout(home, '01900000-0000-7000-8000-000000000002')).toBeUndefined()

    const adapter = createCodexAdapter({ env: { CODEX_HOME: home }, home: tmpdir() })
    await expect(adapter.canResume(THREAD, '/anywhere')).resolves.toEqual({ ok: true })
    await expect(adapter.canResume('01900000-0000-7000-8000-000000000002', '/w')).resolves.toEqual({
      ok: false,
      reason: 'cannot-resume',
    })
  })

  it('CODEX_HOME from the vendor env, else ~/.codex', () => {
    expect(codexHome({ CODEX_HOME: 'X:\\h' }, 'C:\\Users\\me')).toBe('X:\\h')
    expect(codexHome({}, '/home/me')).toBe(join('/home/me', '.codex'))
  })
})

describe('local preset readiness (loopback only)', () => {
  let server: Server
  let base: string
  const hits: string[] = []
  let context = 8192
  let responses = 400

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(`${req.method} ${req.url}`)
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/v1/models')
        return json(200, { object: 'list', data: [{ id: 'qwen3-coder:30b' }, { id: 'llama3' }] })
      if (req.url === '/v1/responses') return json(responses, { error: 'model is required' })
      if (req.url === '/api/show') return json(200, { model_info: { 'qwen3.context_length': context } })
      return json(404, { error: 'not found' })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const preset = (o: Partial<LocalPreset> = {}): LocalPreset => ({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: base,
    model: 'qwen3-coder:30b',
    ...o,
  })

  it('only loopback hosts are ever contacted', () => {
    expect(loopbackUrl('http://127.0.0.1:11434/v1')).toBeDefined()
    expect(loopbackUrl('http://localhost:1234/v1')).toBeDefined()
    expect(loopbackUrl('http://[::1]:1234/v1')).toBeDefined()
    expect(loopbackUrl('https://api.example.com/v1')).toBeUndefined()
    expect(loopbackUrl('http://10.0.0.5:11434/v1')).toBeUndefined()
    // Windows resolves *.localhost through DNS, so such a name is not this computer.
    expect(loopbackUrl('http://llm.localhost:8000/v1')).toBeUndefined()
  })

  it('server up, Responses API present (an empty body is refused, not 404), small context warns', async () => {
    hits.length = 0
    context = 8192
    responses = 400
    const checks = await localReadiness({ pass: 'implement', preset: preset(), at: 1 })
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['pass.implement.readiness.local-server', 'pass'],
      ['pass.implement.readiness.local-responses', 'pass'],
      ['pass.implement.readiness.local-context', 'warn'],
    ])
    expect(hits).toEqual(expect.arrayContaining(['GET /v1/models', 'POST /v1/responses', 'POST /api/show']))
  })

  it('no /responses (404) fails with local_server; a missing model fails; a big context passes', async () => {
    responses = 404
    context = 131072
    const a = await localReadiness({ pass: 'fix', preset: preset(), at: 1 })
    expect(a.find((c) => c.id.endsWith('local-responses'))).toMatchObject({
      status: 'fail',
      category: 'local_server',
    })
    expect(a.find((c) => c.id.endsWith('local-context'))).toMatchObject({ status: 'pass' })
    const b = await localReadiness({ pass: 'fix', preset: preset({ model: 'gone:1b' }), at: 1 })
    expect(b.find((c) => c.id.endsWith('local-server'))).toMatchObject({
      status: 'fail',
      category: 'local_server',
    })
    responses = 400
  })

  it('a server that is down fails local-server with the start command and the presets link', async () => {
    const checks = await localReadiness({
      pass: 'implement',
      preset: preset({ baseUrl: 'http://127.0.0.1:9/v1' }),
      at: 1,
    })
    expect(checks[0]).toMatchObject({ status: 'fail', category: 'local_server' })
    expect(checks[0]!.recovery.map((r) => r.kind)).toEqual(['shell_copy', 'settings_link'])
    expect(checks.slice(1).every((c) => c.status === 'skip')).toBe(true)
  })

  it('a non-loopback preset is never contacted: every check skips', async () => {
    hits.length = 0
    const checks = await localReadiness({
      pass: 'implement',
      preset: preset({ baseUrl: 'https://llm.example.com/v1' }),
      at: 1,
    })
    expect(checks.every((c) => c.status === 'skip')).toBe(true)
    expect(hits).toEqual([])
  })

  it('model list from {baseUrl}/models; context readers', async () => {
    expect(await listLocalModels(preset())).toEqual([
      { id: 'qwen3-coder:30b', source: 'local-server', isDefault: true },
      { id: 'llama3', source: 'local-server' },
    ])
    expect(await listLocalModels(preset({ baseUrl: 'https://llm.example.com/v1' }))).toEqual([])
    expect(ollamaContext({ model_info: { 'llama.context_length': 4096 } })).toBe(4096)
    expect(ollamaContext({ parameters: 'num_ctx 16384\nstop "x"' })).toBe(16384)
    expect(
      lmStudioContext({ data: [{ id: 'm', loaded_context_length: 32768, max_context_length: 131072 }] }, 'm'),
    ).toBe(32768)
  })

  it('a redirect is never followed: nothing reaches its target and the server reads as pointing elsewhere', async () => {
    // A loopback server (or a local proxy) answering 30x must not carry Dim Factory's requests, or its trust
    // in the answers, to another computer. The target here is a second local server that must see no request.
    const targetHits: string[] = []
    const target = createServer((req, res) => {
      targetHits.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder:30b' }] }))
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
    const redirector = createServer((req, res) => {
      res.writeHead(307, { location: `${targetBase}${req.url ?? '/'}` })
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    const from = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/v1`
    try {
      const checks = await localReadiness({ pass: 'implement', preset: preset({ baseUrl: from }), at: 1 })
      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ['pass.implement.readiness.local-server', 'fail'],
        ['pass.implement.readiness.local-responses', 'skip'],
        ['pass.implement.readiness.local-context', 'skip'],
      ])
      expect(checks[0]).toMatchObject({ title: 'Ollama points somewhere else', category: 'local_server' })
      expect(checks[0]!.detail).toContain('redirect')
      expect(await listLocalModels(preset({ baseUrl: from }))).toEqual([])
      expect(targetHits).toEqual([])
    } finally {
      await new Promise<void>((resolve) => redirector.close(() => resolve()))
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  it('an injected fetch is asked never to follow, and an answer from elsewhere is not trusted', async () => {
    const inits: unknown[] = []
    const answer = (url: string) => ({
      status: 200,
      ok: true,
      url,
      json: () => Promise.resolve({ data: [{ id: 'qwen3-coder:30b' }] }),
    })
    const models = await listLocalModels(preset({ baseUrl: 'http://127.0.0.1:1/v1' }), (u, init) => {
      inits.push(init)
      return Promise.resolve(answer(u))
    })
    expect(models.map((m) => m.id)).toEqual(['qwen3-coder:30b'])
    expect(inits).toEqual([expect.objectContaining({ redirect: 'manual' })])
    // A fetch that followed anyway and ended on another host: no answer.
    const elsewhere = await listLocalModels(preset({ baseUrl: 'http://127.0.0.1:1/v1' }), () =>
      Promise.resolve(answer('http://192.168.1.20:11434/v1/models')),
    )
    expect(elsewhere).toEqual([])
    // An opaque redirect (a browser-style fetch): no answer either.
    const opaque = await listLocalModels(preset({ baseUrl: 'http://127.0.0.1:1/v1' }), () =>
      Promise.resolve({ status: 0, ok: false, type: 'opaqueredirect', json: () => Promise.resolve(null) }),
    )
    expect(opaque).toEqual([])
  })

  it("the adapter's readiness adds the local checks for a local-<id> pass", async () => {
    const adapter = createCodexAdapter({ env: {}, home: tmpdir(), platform: 'linux' })
    const checks = await adapter.readiness('/w', {
      pass: 'implement',
      mode: 'autoedit',
      planNative: false,
      trustFolder: false,
      local: preset(),
    })
    expect(checks.map((c) => c.id)).toEqual([
      'pass.implement.readiness.mode',
      'pass.implement.readiness.local-server',
      'pass.implement.readiness.local-responses',
      'pass.implement.readiness.local-context',
    ])
  })
})
