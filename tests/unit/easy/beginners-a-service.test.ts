// Easy's service for a website or app (easy/service.ts on fake deps): resolve says how it is built (React when Node.js
// is ready, plain HTML on request or without it), what the idea needs and the checks it runs before it is called ready;
// create starts from the chosen template with the needs answered in its task, its checks as the run's Verify commands
// (the page-load check always, the npm ones only with Node.js), the Easy recipe's look in its Brief; a change to it runs
// the same checks; the overnight list makes it the recommended way; and the default projects folder leaves a
// OneDrive-synced Documents (a folder set in Easy settings still wins).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { loadTemplates } from '@core/templates/load.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { silentLogger } from '@core/log.ts'
import type { EasyToolchain } from '@shared/easy.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { QueueEasyRun } from '@shared/factory.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-easy-a-'))
  dirs.push(d)
  return d
}

const READY: EasyToolchain = { node: true, python: false, nodeVersion: '22.12.0' }
const NO_NODE: EasyToolchain = { node: false, python: false, nodeVersion: null }

function world(o: { toolchain?: EasyToolchain; user?: unknown; documents?: string; userDir?: string } = {}) {
  const home = temp()
  const starts: RunStartRequest[] = []
  const queued: { folder: string; task: { task: string; recipe: string; easy: QueueEasyRun } }[] = []
  const fresh: boolean[] = []
  const deps: EasyDeps = {
    home,
    documentsDir: o.documents ?? join(temp(), 'Documents'),
    ...(o.userDir !== undefined ? { userDir: o.userDir, env: {} } : {}),
    newHome: false,
    log: silentLogger,
    now: () => 1000,
    readUser: () => Promise.resolve(o.user ?? null),
    patchUser: () => Promise.resolve(),
    packs: () => Promise.resolve(readBuiltinPacks().map((v) => v.pack)),
    templates: () => loadTemplates({ home }),
    readiness: () => ({ claude: true, codex: false, profile: 'claude-only', runnable: true }),
    toolchain: (t) => {
      fresh.push(t?.fresh === true)
      return Promise.resolve(o.toolchain ?? READY)
    },
    estimate: () => Promise.resolve(null),
    prepareFolder: (folder) => Promise.resolve(folder),
    saveBrief: () => Promise.resolve(),
    startRun: (req) => {
      starts.push(req)
      return Promise.resolve({ runId: 'r9', displayNo: 9 })
    },
    summaries: () => [],
    runTask: () => Promise.resolve(null),
    exists: () => false,
    queue: {
      add: (folder, task) => {
        queued.push({ folder, task })
        return Promise.resolve()
      },
      view: () =>
        ({
          folders: [],
          schedule: { enabled: false, start: '22:00', end: null, days: [] },
        }) as unknown as ReturnType<NonNullable<EasyDeps['queue']>['view']>,
      start: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      schedule: () => Promise.resolve(),
    },
  }
  return { svc: new EasyService(deps), starts, queued, fresh, home }
}

const LIMITS = { maxCostUsd: null, maxMinutes: null }

describe('resolve: a website or app', () => {
  it('React by default, with its checks and what it needs', async () => {
    const t = world()
    const r = await t.svc.resolve({ idea: 'An AI caption writer app for my photos' })
    expect(r.kind).toBe('app')
    expect(r.template.id).toBe('react-site')
    expect(r.stack).toEqual({ chosen: 'react', react: true })
    expect(r.checks).toEqual(['Tests', 'Build', 'Page loads (Dim Factory)'])
    expect(r.needs?.map((n) => [n.need, n.recommended])).toEqual([['ai', 'proxy']])
  })

  it('plain HTML when picked; without Node.js plain HTML with no npm checks; Check again reads it afresh', async () => {
    const t = world()
    const html = await t.svc.resolve({ idea: 'A tip splitter', stack: 'html' })
    expect(html.template.id).toBe('static-site')
    expect(html.stack).toEqual({ chosen: 'html', react: true })
    expect(html.checks).toEqual(['Site check', 'Page loads (Dim Factory)'])
    const none = await world({ toolchain: NO_NODE }).svc.resolve({ idea: 'A tip splitter', stack: 'react' })
    expect(none.template.id).toBe('static-site')
    expect(none.stack).toEqual({ chosen: 'html', react: false })
    expect(none.checks).toEqual(['Page loads (Dim Factory)'])
    expect(none.toolchain.nodeVersion).toBeNull()
    await t.svc.resolve({ idea: 'A tip splitter', recheck: true })
    expect(t.fresh.at(-1)).toBe(true)
    // A guide has no stack and no needs.
    const doc = await t.svc.resolve({ idea: 'A help guide for my shop' })
    expect(doc.stack).toBeUndefined()
    expect(doc.needs).toBeUndefined()
  })
})

describe('create and change', () => {
  it('starts from the chosen template, with the answers, the checks and the look', async () => {
    const t = world()
    await t.svc.create({
      idea: 'A landing page for my bakery with a sign-up form for our newsletter',
      kind: 'website',
      folder: join(temp(), 'bakery'),
      limits: LIMITS,
      consent: true,
      needs: { forms: 'list' },
    })
    const req = t.starts[0]
    if (req === undefined) throw new Error('no run')
    expect(req.task).toContain('Start from this outline')
    expect(req.task).toMatch(/Dim Factory already put a working starter here/)
    expect(req.task).toMatch(/What it needs beyond pages in a browser/)
    expect(req.task).toMatch(/Supabase table/)
    expect(req.overrides?.verify).toEqual({
      enabled: true,
      commands: [
        { name: 'Tests', run: ['npm', 'run', 'test'] },
        { name: 'Build', run: ['npm', 'run', 'build'] },
        { name: 'Page loads (Dim Factory)', run: ['dimf:pageload', 'dist/index.html'] },
      ],
    })
    expect(req.brief?.category).toBe('design')
    expect(req.brief?.fields['output']?.choices).toEqual(['components', 'tokens'])
  })

  it('plain HTML without Node.js: only the page-load check', async () => {
    const t = world({ toolchain: NO_NODE })
    await t.svc.create({
      idea: 'A tip splitter',
      kind: 'app',
      folder: join(temp(), 'tips'),
      limits: LIMITS,
      consent: false,
    })
    expect(t.starts[0]?.overrides?.verify).toEqual({
      enabled: true,
      commands: [{ name: 'Page loads (Dim Factory)', run: ['dimf:pageload', 'index.html'] }],
    })
    expect(t.starts[0]?.brief?.fields['quality']?.choices).toEqual(['responsive', 'accessible', 'dark-mode'])
  })

  it('a change to it runs the same checks', async () => {
    const t = world()
    const folder = join(temp(), 'tips')
    await t.svc.create({ idea: 'A tip splitter', kind: 'app', folder, limits: LIMITS, consent: false })
    await t.svc.change({ folder, change: 'Add a dark mode switch', limits: LIMITS })
    expect(t.starts[1]?.overrides?.verify?.commands?.map((c) => c.run[0])).toEqual([
      'npm',
      'npm',
      'dimf:pageload',
    ])
  })

  it('the overnight list: React, its checks, and each need met the recommended way', async () => {
    const t = world()
    await t.svc.queueAdd({
      ideas: [{ idea: 'An AI caption writer', kind: 'app', consent: true }],
      limits: LIMITS,
    })
    const q = t.queued[0]
    if (q === undefined) throw new Error('nothing queued')
    expect(q.task.task).toMatch(/small server function/)
    expect(q.task.easy.overrides.verify?.commands?.map((c) => c.name)).toEqual([
      'Tests',
      'Build',
      'Page loads (Dim Factory)',
    ])
    expect(q.task.easy.overrides.gates?.afterPlan).toBe(false)
    expect(q.task.easy.overrides.passes?.plan?.clarify).toBe(false)
  })
})

describe('the default projects folder', () => {
  it('leaves a OneDrive-synced Documents for the user folder, and says why; a set folder wins', async () => {
    const user = temp()
    const synced = join(user, 'OneDrive', 'Documents')
    const s = await world({ documents: synced, userDir: user }).svc.state()
    expect(s.defaultProjectsDir).toBe(join(user, 'Dim Factory Projects'))
    expect(s.projectsDir).toBe(join(user, 'Dim Factory Projects'))
    expect(s.defaultProjectsReason).toBe('onedrive')
    const set = join(user, 'Mine')
    const kept = await world({
      documents: synced,
      userDir: user,
      user: { easy: { projectsDir: set } },
    }).svc.state()
    expect(kept.projectsDir).toBe(set)
    const plain = await world({ documents: join(user, 'Documents'), userDir: user }).svc.state()
    expect(plain.projectsDir).toBe(join(user, 'Documents', 'Dim Factory Projects'))
    expect(plain.defaultProjectsReason).toBeUndefined()
  })
})
