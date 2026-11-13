// Easy mode for beginners, part B (the service and its files, on fake deps): a change keeps the folder's saved Brief and
// always has the secret scan (the full review when it names keys or people's data), a small one plans lighter with no
// Critic, a data report's change can bring a new data file, the change's estimate is there before the click, a folder
// with unsaved files is saved first or worked on in place, the overnight list keeps each idea's estimate and says what
// to know about it, the first memory note says what the project is, an added workbook gets a CSV copy, and the upload
// file leaves raw data out unless asked.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { loadTemplates } from '@core/templates/load.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { checkAttachments, copyAttachments } from '@core/easy/attach.ts'
import { makeUploadFile } from '@core/deploy/upload.ts'
import { readZip, ZipWriter } from '@core/deploy/zip.ts'
import { silentLogger } from '@core/log.ts'
import { DimFactoryError } from '@core/errors.ts'
import type { BriefInput } from '@shared/brief.ts'
import type { EasyAttachment, EasyFolderFacts } from '@shared/easy.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import type { QueueEasyRun, QueueView } from '@shared/factory.ts'
import type { RunSummary } from '@shared/run.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-easy-bs-'))
  dirs.push(d)
  return d
}

const LIMITS = { maxCostUsd: null, maxMinutes: null }
const BRIEF: BriefInput = { category: 'design', fields: { breakpoints: { choices: ['mobile', 'desktop'] } } }
const ESTIMATE = {
  total: { durationMs: { p50: 240_000, p80: 480_000 }, costUsd: { p50: 0.2, p80: 0.5 } },
} as unknown as RunEstimate

interface World {
  svc: EasyService
  starts: RunStartRequest[]
  estimates: RunStartRequest[]
  copied: { paths: readonly string[]; project: string }[]
  saved: string[]
  closed: string[]
  queued: { folder: string; task: { task: string; recipe: string; easy: QueueEasyRun } }[]
  home: string
}

function world(
  o: {
    brief?: BriefInput | null
    briefRefused?: boolean
    folder?: EasyFolderFacts
    estimate?: RunEstimate | null
    queueView?: QueueView
    summaries?: RunSummary[]
  } = {},
): World {
  const home = temp()
  const starts: RunStartRequest[] = []
  const estimates: RunStartRequest[] = []
  const copied: World['copied'] = []
  const saved: string[] = []
  const closed: string[] = []
  const queued: World['queued'] = []
  const deps: EasyDeps = {
    home,
    documentsDir: join(temp(), 'Documents'),
    newHome: false,
    log: silentLogger,
    now: () => 1000,
    readUser: () => Promise.resolve(null),
    patchUser: () => Promise.resolve(),
    packs: () => Promise.resolve(readBuiltinPacks().map((v) => v.pack)),
    templates: () => loadTemplates({ home }),
    readiness: () => ({ claude: true, codex: true, profile: 'balanced', runnable: true }),
    toolchain: () => Promise.resolve({ node: false, python: false }),
    estimate: (req) => {
      estimates.push(req)
      return Promise.resolve(o.estimate === undefined ? ESTIMATE : o.estimate)
    },
    prepareFolder: (folder) => Promise.resolve(folder),
    saveBrief: () => Promise.resolve(),
    readBrief: () => Promise.resolve(o.brief === undefined ? BRIEF : o.brief),
    startRun: (req) => {
      if (o.briefRefused === true && req.brief !== undefined)
        return Promise.reject(new DimFactoryError('VALIDATION', 'The brief does not fit its category: x'))
      starts.push(req)
      return Promise.resolve({ runId: 'r9', displayNo: 9 })
    },
    summaries: () => o.summaries ?? [],
    closeRun: (runId) => {
      closed.push(runId)
      return Promise.resolve()
    },
    runTask: (runId) => Promise.resolve({ task: `the task of ${runId}`, folder: 'x' }),
    exists: () => false,
    checkAttachments: (paths) =>
      Promise.resolve(
        paths.map((p): EasyAttachment => ({
          path: p,
          name: p.split(/[\\/]/).pop() ?? p,
          bytes: 10,
          folder: false,
          dest: 'data',
        })),
      ),
    copyAttachments: (paths, project) => {
      copied.push({ paths, project })
      return Promise.resolve(paths.map((p) => `data/${p.split(/[\\/]/).pop() ?? p}`))
    },
    ...(o.folder !== undefined ? { inspectFolder: () => Promise.resolve(o.folder as EasyFolderFacts) } : {}),
    saveFirst: (folder) => {
      saved.push(folder)
      return Promise.resolve()
    },
    queue: {
      add: (folder, task) => {
        queued.push({ folder, task })
        return Promise.resolve()
      },
      view: () =>
        o.queueView ??
        ({
          folders: queued.map((q, i) => ({
            folder: q.folder,
            state: 'idle',
            tasks: [{ id: `t${i}`, status: 'pending', addedAt: i, easy: q.task.easy }],
          })),
          schedule: { enabled: false, start: '22:00', end: null, days: [] },
        } as unknown as QueueView),
      start: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      schedule: () => Promise.resolve(),
    },
  }
  return { svc: new EasyService(deps), starts, estimates, copied, saved, closed, queued, home }
}

/** A project Easy made in a world (its record in easy/projects.json). */
function made(t: World, kind: 'website' | 'data' | 'document', idea: string): string {
  const folder = join(temp(), 'project')
  const id = kind === 'data' ? 'data-report-web' : kind === 'document' ? 'docs-simple' : 'landing-page'
  mkdirSync(join(t.home, 'easy'), { recursive: true })
  writeFileSync(
    join(t.home, 'easy', 'projects.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ folder, idea, kind, templateId: id, createdAt: 1, consent: true }],
    }),
  )
  return folder
}

describe('Make a change', () => {
  it("keeps the folder's saved Brief, scans for secrets and plans a small change lighter with no Critic", async () => {
    const t = world()
    const folder = made(t, 'website', 'A landing page for my bakery')
    await t.svc.change({ folder, change: 'Make the buttons bigger', limits: LIMITS })
    const req = t.starts[0]
    expect(req?.brief).toEqual(BRIEF)
    expect(req?.recipe).toBe('easy-change')
    expect(req?.task).toMatch(/^Make the buttons bigger\n\n/)
    expect(req?.task).toMatch(/Never invent facts/)
    expect(req?.overrides?.passes?.security).toMatchObject({ enabled: true, review: 'sensitive' })
    expect(req?.overrides?.passes?.critic?.enabled).toBe(false)
    expect(req?.overrides?.passes?.plan?.model).toBe('sonnet')
  })

  it('a change that names a key gets the full security review and the usual models', async () => {
    const t = world()
    const folder = made(t, 'website', 'A landing page for my bakery')
    await t.svc.change({ folder, change: 'Add a weather widget, my API key is in the notes', limits: LIMITS })
    const o = t.starts[0]?.overrides
    expect(o?.passes?.security).toMatchObject({ enabled: true, review: 'always' })
    expect(o?.passes?.critic?.enabled).toBeUndefined()
    expect(o?.passes?.plan?.model).toBeUndefined()
  })

  it('a Brief that no longer fits is left out rather than stopping the change; none saved runs without one', async () => {
    const t = world({ briefRefused: true })
    const folder = made(t, 'website', 'A landing page for my bakery')
    await t.svc.change({ folder, change: 'Bigger buttons', limits: LIMITS })
    expect(t.starts).toHaveLength(1)
    expect(t.starts[0]?.brief).toBeUndefined()
    const none = world({ brief: null })
    const f2 = made(none, 'website', 'A landing page for my bakery')
    await none.svc.change({ folder: f2, change: 'Bigger buttons', limits: LIMITS })
    expect(none.starts[0]?.brief).toBeUndefined()
  })

  it("a data report's change brings a new data file in first, writes the data copy again and gets the full review", async () => {
    const t = world()
    const folder = made(t, 'data', 'A report from my sales spreadsheet')
    await t.svc.change({
      folder,
      change: 'Use my new sales file',
      attachments: ['C:\\in\\sales-2026.csv'],
      limits: LIMITS,
    })
    expect(t.copied).toEqual([{ paths: ['C:\\in\\sales-2026.csv'], project: folder }])
    const req = t.starts[0]
    expect(req?.task).toContain('- data/sales-2026.csv')
    expect(req?.task).toMatch(/write the copy of the data the page keeps \(js\/data\.js\) again/)
    expect(req?.overrides?.passes?.security).toMatchObject({ enabled: true, review: 'always' })
  })

  it('files go only with a change to a project made here', async () => {
    const t = world({ folder: { folder: 'C:\\mine', name: 'mine', mode: 'inPlace' } })
    await expect(
      t.svc.change({ folder: 'C:\\mine', change: 'Use this', attachments: ['C:\\a.csv'], limits: LIMITS }),
    ).rejects.toThrow(/project made here/)
  })

  it('Carry on picks up a failed run: closes it first (it holds the folder), its task, the scan, the usual models', async () => {
    const t = world({ summaries: [{ runId: 'r1', status: 'failed' } as RunSummary] })
    const folder = made(t, 'website', 'A landing page for my bakery')
    await t.svc.change({ folder, continueRunId: 'r1', limits: LIMITS })
    const req = t.starts[0]
    expect(req?.task).toMatch(/stopped before it was finished[\s\S]*the task of r1/)
    expect(req?.overrides?.passes?.security).toMatchObject({ enabled: true, review: 'sensitive' })
    expect(req?.overrides?.passes?.critic?.enabled).toBeUndefined()
    expect(t.closed).toEqual(['r1'])
    // A run stopped at its limit is not failed: nothing to close.
    const limit = world({ summaries: [{ runId: 'r2', status: 'cancelled' } as RunSummary] })
    const f2 = made(limit, 'website', 'x')
    await limit.svc.change({ folder: f2, continueRunId: 'r2', limits: LIMITS })
    expect(limit.closed).toEqual([])
  })

  it('the estimate before the click: the run the change would start, and how it runs', async () => {
    const t = world()
    const folder = made(t, 'website', 'A landing page for my bakery')
    const small = await t.svc.changeEstimate({ folder, change: 'Make the buttons bigger' })
    expect(small).toEqual({
      estimate: { durationMs: { p50: 240_000, p80: 480_000 }, costUsd: { p50: 0.2, p80: 0.5 } },
      small: true,
      security: 'scan',
    })
    expect(t.estimates[0]?.brief).toEqual(BRIEF)
    expect(t.estimates[0]?.overrides?.passes?.critic?.enabled).toBe(false)
    const key = await t.svc.changeEstimate({ folder, change: 'Store the email addresses people send' })
    expect(key).toMatchObject({ small: false, security: 'full' })
    const none = world({ estimate: null })
    const f2 = made(none, 'website', 'x')
    expect((await none.svc.changeEstimate({ folder: f2, change: 'Bigger buttons' })).estimate).toBeNull()
    await expect(t.svc.changeEstimate({ folder, change: '  ' })).rejects.toThrow(/Say what to change/)
  })
})

describe('a folder the user already has', () => {
  const unsaved: EasyFolderFacts = { folder: 'C:\\site', name: 'site', mode: 'isolated', uncommitted: 3 }

  it('with unsaved files: saved first (then a copy), or worked on in place; both scan and keep the Brief', async () => {
    const t = world({ folder: unsaved })
    await t.svc.work({ folder: 'C:\\site', change: 'Add a contact page', how: 'saveFirst', limits: LIMITS })
    expect(t.saved).toEqual(['C:\\site'])
    expect(t.starts[0]?.overrides?.isolation).toEqual({ mode: 'worktree' })
    expect(t.starts[0]?.brief).toEqual(BRIEF)
    expect(t.starts[0]?.overrides?.passes?.security).toMatchObject({ enabled: true })
    await t.svc.work({ folder: 'C:\\site', change: 'Add a contact page', how: 'inPlace', limits: LIMITS })
    expect(t.saved).toHaveLength(1)
    expect(t.starts[1]?.overrides?.isolation).toEqual({ mode: 'inPlace' })
    // Not chosen: a copy of the last commit, as before.
    await t.svc.work({ folder: 'C:\\site', change: 'Add a contact page', limits: LIMITS })
    expect(t.starts[2]?.overrides?.isolation).toEqual({ mode: 'worktree' })
    expect(t.saved).toHaveLength(1)
  })
})

describe('the overnight list', () => {
  it("keeps each idea's estimate, and says what to know: a guessed vague idea, a data report with no file", async () => {
    const t = world()
    await t.svc.queueAdd({
      ideas: [
        { idea: 'Something for my bakery', kind: 'app', consent: false, guessed: true },
        { idea: 'A report from my sales spreadsheet', kind: 'data', consent: false },
      ],
      limits: LIMITS,
    })
    const v = await t.svc.queueView()
    expect(v.items.map((i) => i.warnings)).toEqual([
      [{ kind: 'vague', candidates: ['website', 'app'] }],
      [{ kind: 'exampleData' }],
    ])
    expect(v.items[0]?.estimate).toEqual({
      durationMs: { p50: 240_000, p80: 480_000 },
      costUsd: { p50: 0.2, p80: 0.5 },
    })
  })
})

describe('the first memory note of a project made here', () => {
  it('says what it is, what it came from and the rules its changes keep', async () => {
    const t = world()
    const folder = made(t, 'data', 'A report from my sales spreadsheet: monthly totals')
    const seed = await t.svc.memorySeed(folder)
    expect(seed?.conventions[0]).toMatch(
      /^What it is: Report from my sales spreadsheet \(a report from data\)/,
    )
    expect(seed?.conventions.join('\n')).toMatch(/\[Fill in: \.\.\.\]/)
    expect(seed?.conventions.join('\n')).toMatch(/js\/data\.js/)
    expect(seed?.decisions[0]).toMatch(/^It was asked for as: "A report from my sales spreadsheet/)
    expect(await t.svc.memorySeed(join(temp(), 'other'))).toBeNull()
  })
})

const CTX = { platform: process.platform, home: 'Z:\\nohome', dimFactoryHome: 'Z:\\nodim', env: {} }

async function workbook(path: string): Promise<void> {
  const z = await ZipWriter.create(path)
  const add = (name: string, text: string): Promise<void> =>
    z.add({ name, data: Buffer.from(text, 'utf8'), mtime: new Date(2026, 0, 1) })
  await add('xl/sharedStrings.xml', '<sst><si><t>Month</t></si><si><t>Total</t></si></sst>')
  await add(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>99</v></c></row></sheetData></worksheet>',
  )
  await z.finish('test')
}

describe('added files', () => {
  it('a workbook is noted and gets a CSV copy of its first sheet; an old .xls is unreadable; a big CSV is large', async () => {
    const src = temp()
    const xlsx = join(src, 'sales.xlsx')
    await workbook(xlsx)
    writeFileSync(join(src, 'old.xls'), 'binary')
    writeFileSync(join(src, 'big.csv'), 'a,b\n'.repeat(700_000))
    const checked = await checkAttachments([xlsx, join(src, 'old.xls'), join(src, 'big.csv')], CTX)
    expect(checked.map((a) => [a.name, a.note])).toEqual([
      ['sales.xlsx', 'converted'],
      ['old.xls', 'unreadable'],
      ['big.csv', 'large'],
    ])
    const project = temp()
    const written = await copyAttachments([xlsx], project, CTX)
    expect(written).toEqual(['data/sales.xlsx', 'data/sales.csv'])
    expect(readFileSync(join(project, 'data', 'sales.csv'), 'utf8')).toBe('Month,Total\n1,99\n')
  })
})

describe('the upload file and raw data', () => {
  it('leaves data/*.csv out by default and lists it; includes it when asked', async () => {
    const root = temp()
    const project = join(root, 'report')
    mkdirSync(join(project, 'data'), { recursive: true })
    mkdirSync(join(project, 'js'), { recursive: true })
    writeFileSync(join(project, 'index.html'), '<!doctype html><title>Report</title>')
    writeFileSync(join(project, 'js', 'data.js'), 'window.DATA = [{"month":"Jan","total":3}]')
    writeFileSync(join(project, 'data', 'people.csv'), 'name,email\nAda,ada@example.com\n')
    writeFileSync(join(project, 'data', 'cleaned.csv'), 'month,total\nJan,3\n')
    const out = await makeUploadFile({
      folder: project,
      dir: '.',
      outDir: root,
      baseName: 'report',
      game: false,
    })
    expect(out).toMatchObject({ status: 'made', dataLeftOut: ['data/cleaned.csv', 'data/people.csv'] })
    if (out.status !== 'made') throw new Error('no zip')
    const names = readZip(readFileSync(out.path))?.entries.map((e) => e.name)
    expect(names).toEqual(['index.html', 'js/data.js'])
    const all = await makeUploadFile({
      folder: project,
      dir: '.',
      outDir: root,
      baseName: 'report',
      game: false,
      includeData: true,
    })
    expect(all).toMatchObject({ status: 'made', dataIncluded: true })
    expect(all.status === 'made' && all.dataLeftOut).toBe(undefined)
    if (all.status !== 'made') throw new Error('no zip')
    expect(readZip(readFileSync(all.path))?.entries.map((e) => e.name)).toContain('data/people.csv')
    expect(readdirSync(root).filter((n) => n.endsWith('.zip'))).toEqual(['report-site.zip'])
  })
})
