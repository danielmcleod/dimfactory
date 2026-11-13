// Run & Preview sessions end to end with a fake dev server (a node script that starts a child of its own, prints its
// URL and serves a page): a trusted command starts as a tracked child with no shell, its output and URL reach the
// session view, Stop kills the whole tree, quit (stopAll) kills every running preview, an untrusted or changed command
// never starts, a missing program and a crash read as failed, the static server serves and stops, and a crashed
// session's leftovers are killed by the next launch's sweep (only the processes it recorded).
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { get } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import type { Logger } from '../../../src/core/log.ts'
import { detectPreviewCommands } from '../../../src/core/preview/detect.ts'
import { PreviewService } from '../../../src/core/preview/service.ts'
import { previewGrantCommand, readPreviewBody } from '../../../src/core/preview/trust.ts'
import { isAlive } from '../../../src/core/proc/ps.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import type { PreviewCommand, PreviewSessionView } from '../../../src/shared/preview.ts'
import { removeDir, tempDir, writeFiles } from '../../unit/verify/helpers.ts'

/** The fake dev server: a child that only sleeps (its pid in child.pid), then a page on a free port. */
const SERVER = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync('child.pid', String(child.pid))
writeFileSync('server.pid', String(process.pid))
console.log('compiling…')
const s = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<h1>fake</h1>') })
s.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + s.address().port + '/'))
`

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  flush: () => Promise.resolve(),
}

let folder = ''
let services: PreviewService[] = []

beforeEach(() => {
  folder = tempDir('dim-factory-preview-int-')
  writeFiles(folder, {
    'package.json': `${JSON.stringify({ name: 'x', scripts: { dev: 'node server.mjs', crash: 'node crash.mjs' } })}\n`,
    'server.mjs': SERVER,
    'crash.mjs': "console.error('it broke'); process.exit(3)\n",
    'site/index.html': '<h1>static</h1>',
  })
})

afterEach(async () => {
  await Promise.all(services.map((s) => s.stopAll().catch(() => undefined)))
  services = []
  removeDir(folder)
})

function service(o: { recordProcs?: boolean; events?: PreviewSessionView[] } = {}): PreviewService {
  const s = new PreviewService({
    paths: homePaths(process.env['DIM_FACTORY_HOME'] as string),
    log: silent,
    emitEveryMs: 20,
    ...(o.recordProcs !== undefined ? { recordProcs: o.recordProcs } : {}),
    ...(o.events !== undefined ? { emit: (v: PreviewSessionView) => o.events?.push(v) } : {}),
  })
  services.push(s)
  return s
}

async function command(id: string): Promise<PreviewCommand> {
  const cmd = (await detectPreviewCommands({ folder })).find((c) => c.id === id)
  if (cmd !== undefined) return cmd
  // `crash` is not a script detection offers: build it as a trusted package command.
  return {
    id,
    label: `npm run ${id}`,
    kind: 'server',
    source: 'package.json',
    argv: ['npm', 'run', id],
    cwdRel: '.',
    trust: 'untrusted',
  }
}

async function grantsFor(cmd: PreviewCommand): Promise<TrustGrants> {
  const read = await readPreviewBody(folder, cmd)
  const g = previewGrantCommand(cmd, read.body)
  const { commandGrantHash } = await import('../../../src/core/config/trust.ts')
  return { commands: { [commandGrantHash(g)]: { ...g, argv: [...g.argv], at: 1 } } }
}

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined && v !== null && v !== false) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const pidIn = (name: string): number => Number(readFileSync(join(folder, name), 'utf8'))

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

describe('a trusted dev server', () => {
  it('starts, reports its output and URL, and Stop kills its whole tree', async () => {
    const events: PreviewSessionView[] = []
    const svc = service({ events })
    const cmd = await command('pkg:dev')
    const started = await svc.start({ folder, scopeRoot: folder, command: cmd, grants: await grantsFor(cmd) })
    expect(started.status).toBe('running')
    const view = await until('the URL', () => {
      const v = svc.get(started.id)
      return v?.url !== null ? v : undefined
    })
    expect(view.url).toMatch(/^http:\/\/localhost:\d+\/$/)
    expect(view.tail).toContain('compiling…')
    expect(await fetchText(view.url as string)).toBe('<h1>fake</h1>')
    const server = await until('server.pid', () => {
      try {
        return pidIn('server.pid')
      } catch {
        return undefined
      }
    })
    const child = pidIn('child.pid')
    expect(isAlive(server)).toBe(true)
    expect(isAlive(child)).toBe(true)
    await svc.stop(started.id)
    expect(svc.get(started.id)?.status).toBe('stopped')
    await until('the tree to be gone', () => !isAlive(server) && !isAlive(child), 15_000)
    // The events told the panel every step, the URL among them, and the log kept the output.
    expect(events.some((e) => e.id === started.id && e.url !== null)).toBe(true)
    expect(events.at(-1)?.status).toBe('stopped')
    const log = await readFile(view.logPath as string, 'utf8')
    expect(log).toContain('$ npm run dev')
    expect(log).toContain('compiling…')
  })

  it('answers the running session when the same command starts again, and stopAll kills it (quit)', async () => {
    const svc = service()
    const cmd = await command('pkg:dev')
    const grants = await grantsFor(cmd)
    const a = await svc.start({ folder, scopeRoot: folder, command: cmd, grants })
    const b = await svc.start({ folder, scopeRoot: folder, command: cmd, grants })
    expect(b.id).toBe(a.id)
    const server = await until('server.pid', () => {
      try {
        return pidIn('server.pid')
      } catch {
        return undefined
      }
    })
    await svc.stopAll()
    await until('the tree to be gone', () => !isAlive(server) && !isAlive(pidIn('child.pid')), 15_000)
    await expect(svc.start({ folder, scopeRoot: folder, command: cmd, grants })).rejects.toThrow(/closing/)
  })
})

describe('trust', () => {
  it('never starts an untrusted command, nor one whose script changed since it was trusted', async () => {
    const svc = service()
    const cmd = await command('pkg:dev')
    await expect(svc.start({ folder, scopeRoot: folder, command: cmd, grants: {} })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const grants = await grantsFor(cmd)
    writeFileSync(
      join(folder, 'package.json'),
      `${JSON.stringify({ name: 'x', scripts: { dev: 'node server.mjs --evil' } })}\n`,
    )
    await expect(svc.start({ folder, scopeRoot: folder, command: cmd, grants })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('changed since you trusted it') as unknown,
    })
    expect(svc.list()).toEqual([])
  })
})

describe('ends', () => {
  it('reads a crash as failed with its exit code', async () => {
    const svc = service()
    const cmd = await command('crash')
    const s = await svc.start({ folder, scopeRoot: folder, command: cmd, grants: await grantsFor(cmd) })
    const ended = await until('the end', () => {
      const v = svc.get(s.id)
      return v?.endedAt !== undefined ? v : undefined
    })
    expect(ended.status).toBe('failed')
    expect(ended.exitCode).not.toBe(0)
    expect(ended.tail).toContain('it broke')
  })

  it('reads a program that is not installed as failed, without spawning anything', async () => {
    const svc = service()
    const cmd: PreviewCommand = {
      id: 'go:.',
      label: 'go-not-installed-here run .',
      kind: 'server',
      source: 'go',
      argv: ['go-not-installed-here', 'run', '.'],
      cwdRel: '.',
      trust: 'untrusted',
    }
    const s = await svc.start({ folder, scopeRoot: folder, command: cmd, grants: await grantsFor(cmd) })
    expect(s.status).toBe('failed')
    expect(s.reason).toContain('could not find go-not-installed-here')
  })
})

describe('the static server', () => {
  it('serves the folder read-only and stops', async () => {
    const svc = service()
    const cmd = (await detectPreviewCommands({ folder })).find((c) => c.kind === 'static') as PreviewCommand
    expect(cmd.staticRoot).toBe('site')
    const s = await svc.start({ folder, scopeRoot: folder, command: cmd, grants: {} })
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(await fetchText(s.url as string)).toBe('<h1>static</h1>')
    await until('the request in its output', () => svc.get(s.id)?.tail.some((l) => l.startsWith('GET / 200')))
    await svc.stop(s.id)
    expect(svc.get(s.id)?.status).toBe('stopped')
    await expect(fetchText(s.url as string)).rejects.toThrow()
  })
})

describe('the launch sweep', () => {
  it("kills a crashed session's recorded preview tree, and nothing else", async () => {
    const crashed = service({ recordProcs: true })
    const cmd = await command('pkg:dev')
    await crashed.start({ folder, scopeRoot: folder, command: cmd, grants: await grantsFor(cmd) })
    const server = await until('server.pid', () => {
      try {
        return pidIn('server.pid')
      } catch {
        return undefined
      }
    })
    const child = pidIn('child.pid')
    // The crashed session never stops anything: the next launch's service finds its records.
    services = services.filter((s) => s !== crashed)
    const next = service({ recordProcs: true })
    const killed = await next.sweepOrphans()
    expect(killed).toBeGreaterThan(0)
    await until('the tree to be gone', () => !isAlive(server) && !isAlive(child), 15_000)
    expect(isAlive(process.pid)).toBe(true)
    // Settled records are gone from the file; a second sweep has nothing to do.
    expect(await next.sweepOrphans()).toBe(0)
    await crashed.stopAll()
  }, 120_000)
})
