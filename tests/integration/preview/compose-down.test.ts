// "Stop containers too" for a docker compose preview, with a fake docker on PATH (a node script that logs its argv):
// Stop alone never runs `docker compose down`; the user's click runs it for the same compose files through the same
// trusted runner (after stopping the compose command if it still runs); a changed compose file, a preview that is not
// compose, and a failing down are each refused or reported, and nothing runs on its own.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import type { Logger } from '../../../src/core/log.ts'
import { detectPreviewCommands } from '../../../src/core/preview/detect.ts'
import { PreviewService } from '../../../src/core/preview/service.ts'
import { composeDownArgv, previewGrantCommand, readPreviewBody } from '../../../src/core/preview/trust.ts'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import { samePath } from '../../../src/core/real-path.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import type { PreviewCommand, PreviewSessionView } from '../../../src/shared/preview.ts'
import { removeDir, tempDir, writeFiles } from '../../unit/verify/helpers.ts'

/** The fake docker: logs `{argv, cwd}` to docker.log beside it; `compose up` serves until killed, `compose down` ends. */
const DOCKER = `
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
appendFileSync(join(here, 'docker.log'), JSON.stringify({ argv, cwd: process.cwd() }) + '\\n')
const sub = argv.slice(1).find((a, i, all) => !a.startsWith('-') && !['-f', '--file', '-p', '--project-name'].includes(all[i - 1]))
if (sub === 'up') {
  console.log('Container web-1  Started')
  setInterval(() => {}, 1000)
} else if (sub === 'down') {
  if (existsSync(join(process.cwd(), 'down-fails'))) {
    console.error('Error response from daemon: cannot stop container')
    process.exit(2)
  }
  console.log('Container web-1  Stopped')
  console.log('Container web-1  Removed')
} else {
  process.exit(1)
}
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
let bin = ''
let services: PreviewService[] = []

beforeEach(() => {
  folder = tempDir('dim-factory-compose-int-')
  bin = tempDir('dim-factory-fake-docker-')
  writeFiles(folder, {
    'compose.yaml': 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n',
    'package.json': `${JSON.stringify({ name: 'x', scripts: { dev: 'node -e "setInterval(()=>{},1000)"' } })}\n`,
  })
  writeFileSync(join(bin, 'docker.mjs'), DOCKER)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'docker.cmd'), `@"${process.execPath}" "%~dp0docker.mjs" %*\r\n`)
  } else {
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/docker.mjs" "$@"\n`,
    )
    chmodSync(join(bin, 'docker'), 0o755)
  }
})

afterEach(async () => {
  await Promise.all(services.map((s) => s.stopAll().catch(() => undefined)))
  services = []
  removeDir(folder)
  removeDir(bin)
})

function service(): PreviewService {
  const s = new PreviewService({
    paths: homePaths(process.env['DIM_FACTORY_HOME'] as string),
    log: silent,
    emitEveryMs: 20,
    pathEnv: () => Promise.resolve(`${bin}${delimiter}${process.env['PATH'] ?? ''}`),
  })
  services.push(s)
  return s
}

async function command(id: string): Promise<PreviewCommand> {
  const cmd = (await detectPreviewCommands({ folder })).find((c) => c.id === id)
  if (cmd === undefined) throw new Error(`no ${id}`)
  return cmd
}

async function grantsFor(cmd: PreviewCommand): Promise<TrustGrants> {
  const read = await readPreviewBody(folder, cmd)
  const g = previewGrantCommand(cmd, read.body)
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

/** What the fake docker was asked to do, in order. */
function dockerCalls(): { argv: string[]; cwd: string }[] {
  const log = join(bin, 'docker.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
}

async function startCompose(svc: PreviewService): Promise<{ view: PreviewSessionView; grants: TrustGrants }> {
  const cmd = await command('docker:compose')
  const grants = await grantsFor(cmd)
  const view = await svc.start({ folder, scopeRoot: folder, command: cmd, grants })
  await until('compose up', () => dockerCalls().some((c) => c.argv[1] === 'up'))
  return { view, grants }
}

describe('compose down argv', () => {
  it('keeps the program and the global options (compose files, project), then down', () => {
    expect(composeDownArgv(['docker', 'compose', 'up'])).toEqual(['docker', 'compose', 'down'])
    expect(composeDownArgv(['docker', 'compose', '-f', 'a.yml', '-p', 'demo', 'up', '--build'])).toEqual([
      'docker',
      'compose',
      '-f',
      'a.yml',
      '-p',
      'demo',
      'down',
    ])
    expect(composeDownArgv(['docker-compose', '--file=a.yml', 'up', '-d'])).toEqual([
      'docker-compose',
      '--file=a.yml',
      'down',
    ])
    expect(composeDownArgv(['npm', 'run', 'dev'])).toBeNull()
    expect(composeDownArgv(['docker', 'run', 'nginx'])).toBeNull()
  })
})

describe('Stop containers too', () => {
  it('is offered for a compose preview only, and Stop alone never runs docker compose down', async () => {
    const svc = service()
    const { view } = await startCompose(svc)
    expect(view.compose).toBe(true)
    expect(view.composeDown).toBeUndefined()
    await svc.stop(view.id)
    expect(svc.get(view.id)?.status).toBe('stopped')
    expect(dockerCalls().map((c) => c.argv)).toEqual([['compose', 'up']])

    const dev = await command('pkg:dev')
    const other = await svc.start({ folder, scopeRoot: folder, command: dev, grants: await grantsFor(dev) })
    expect(other.compose).toBeUndefined()
    await expect(svc.composeDown(other.id, await grantsFor(dev))).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(dockerCalls()).toHaveLength(1)
  })

  it('on the click: stops the compose command, then runs docker compose down in its folder', async () => {
    const svc = service()
    const { view, grants } = await startCompose(svc)
    expect(svc.get(view.id)?.status).toBe('running')
    await svc.composeDown(view.id, grants)
    const after = svc.get(view.id)!
    expect(after.status).toBe('stopped')
    expect(after.composeDown).toEqual({ status: 'done', reason: 'Containers stopped' })
    const calls = dockerCalls()
    expect(calls.map((c) => c.argv)).toEqual([
      ['compose', 'up'],
      ['compose', 'down'],
    ])
    // The child's getcwd() is the real path (macOS /private/var for /var): the same folder, however spelled.
    expect(samePath(calls[1]!.cwd, folder), `${calls[1]!.cwd} is ${folder}`).toBe(true)
    // Its output joins the session's.
    expect(after.tail).toContain('$ docker compose down')
    expect(after.tail).toContain('Container web-1  Removed')
  })

  it('after the compose command already ended, it still runs (the containers may keep running)', async () => {
    const svc = service()
    const { view, grants } = await startCompose(svc)
    await svc.stop(view.id)
    await svc.composeDown(view.id, grants)
    expect(svc.get(view.id)?.composeDown?.status).toBe('done')
    expect(dockerCalls().map((c) => c.argv[1])).toEqual(['up', 'down'])
  })

  it('refuses when the compose file changed since it was trusted (nothing runs)', async () => {
    const svc = service()
    const { view, grants } = await startCompose(svc)
    writeFileSync(join(folder, 'compose.yaml'), 'services:\n  web:\n    image: evil\n')
    await expect(svc.composeDown(view.id, grants)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(dockerCalls().map((c) => c.argv[1])).toEqual(['up'])
    // Still running: a refused down does not stop it either.
    expect(svc.get(view.id)?.status).toBe('running')
    await expect(svc.composeDown(view.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('reports a failing docker compose down', async () => {
    const svc = service()
    const { view, grants } = await startCompose(svc)
    writeFileSync(join(folder, 'down-fails'), '')
    await svc.composeDown(view.id, grants)
    const d = svc.get(view.id)?.composeDown
    expect(d).toEqual({ status: 'failed', reason: 'docker compose down ended with code 2' })
    expect(svc.get(view.id)?.tail.some((l) => l.includes('cannot stop container'))).toBe(true)
  })

  it('an unknown session is NOT_FOUND', async () => {
    const svc = service()
    await expect(svc.composeDown('pv_nope', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
