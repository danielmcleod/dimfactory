// Easy mode's second phase, core side: the short project title from an idea; the overrides layer (the plain summary
// for results that are not programs, Verify with the folder's own checks); the service giving the project permission
// to the new folder only (after it is made, before the run starts, and only with consent), checking added files before
// anything is made and copying them in, and a change run of a document project saying how to open it; Explain's
// prompt for a result that is not a program (explain-easy.md: "How to open it"); and the project permission covering
// the run's own verify, install and preview commands only through the in-memory marker.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { withProjectPermission } from '@core/config/trust.ts'
import { easyOverrides } from '@core/easy/overrides.ts'
import { EASY_TITLE_MAX, attachmentsNote, titleOf } from '@core/easy/resolve.ts'
import { EasyService } from '@core/easy/service.ts'
import type { EasyDeps } from '@core/easy/service.ts'
import { silentLogger } from '@core/log.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { depsTrustOf } from '@core/prepare/trust.ts'
import { previewTrustOf } from '@core/preview/trust.ts'
import { buildPrompt } from '@core/supervisor/effects.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import { loadTemplates } from '@core/templates/load.ts'
import { trustOf } from '@core/verify/trust.ts'
import type { EasyAttachment } from '@shared/easy.ts'
import type { RunStartRequest } from '@shared/ipc.ts'
import { reviewConfig } from '../supervisor/helpers.review.ts'
import { makeRun } from '../supervisor/helpers.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dimf-easy2-'))
  dirs.push(d)
  return d
}

describe('titleOf', () => {
  it('the first clause, without a leading article, capitalized, cut at a word', () => {
    expect(
      titleOf(
        'A help guide for the customers of my knitting shop: how to order, how shipping works and how to care for the yarn.',
      ),
    ).toBe('Help guide for the customers of my knitting shop')
    expect(titleOf('a tip splitter my friends can open on their phones. Make it pretty')).toBe(
      'Tip splitter my friends can open on their phones',
    )
    expect(titleOf('the')).toBe('The')
    expect(titleOf('landing page\nwith a form')).toBe('Landing page')
    const long = titleOf(`A ${'very '.repeat(30)}long idea`)
    expect(long.length).toBeLessThanOrEqual(EASY_TITLE_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/\s…$/)
  })
})

describe('the overrides layer', () => {
  const base = {
    profile: 'claude-only' as const,
    skipPlanCheck: false,
    limits: { maxCostUsd: null, maxMinutes: null },
  }

  it('a result that is not a program gets the plain summary; the folder’s own checks turn Verify on', () => {
    expect(easyOverrides(base).passes?.plan).toEqual({ extensions: 'none', clarifyPlain: true })
    expect(easyOverrides({ ...base, nonCode: true }).passes?.plan).toEqual({
      extensions: 'none',
      clarifyPlain: true,
      explainPlain: true,
    })
    expect(easyOverrides(base).verify).toBeUndefined()
    expect(easyOverrides({ ...base, checks: [] }).verify).toBeUndefined()
    expect(
      easyOverrides({ ...base, checks: [{ name: 'test', run: ['npm', 'run', 'test'] }] }).verify,
    ).toEqual({
      enabled: true,
      commands: [{ name: 'test', run: ['npm', 'run', 'test'] }],
    })
  })

  it('resolves explainPlain into the run config', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    cfg.passes.plan.explain = true
    cfg.passes.plan.explainPlain = true
    expect(runConfigFromResolved(cfg)).toMatchObject({ explain: true, explainPlain: true })
    cfg.passes.plan.explainPlain = false
    expect(runConfigFromResolved(cfg).explainPlain).toBeUndefined()
  })
})

describe("Explain's prompt", () => {
  it('a result that is not a program: How to open it, never a command (explain-easy.md)', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.explain = true
    c.explainPlain = true
    let state = makeRun(c)
    const spawn = {
      t: 'spawn' as const,
      step: 'explain' as const,
      spawnNo: 1,
      vendor: 'claude',
      model: 'opus',
      mode: 'readonly' as const,
      launch: {
        cause: 'initial' as const,
        plan: { vendor: 'claude', model: 'opus', mode: 'readonly' as const },
      },
    }
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const text = buildPrompt(state, cfg, spawn as never).text
    expect(text).toContain('## How to open it')
    expect(text).not.toContain('## How to run it')
    expect(text).toContain('they open files, they do not run programs')
    delete c.explainPlain
    state = makeRun(c)
    const code = buildPrompt(state, cfg, spawn as never).text
    expect(code).toContain('## How to run it')
  })
})

describe('the project permission and the run’s own commands', () => {
  it('trusted only through the in-memory marker, said so (each use is logged by the caller)', () => {
    const cmd = { name: 'test', argv: ['npm', 'run', 'test'], cwdRel: '.' }
    expect(trustOf(cmd, 'test: node -e 0', {}).trust).toBe('untrusted')
    expect(trustOf(cmd, 'test: node -e 0', withProjectPermission({}))).toMatchObject({
      trust: 'trusted',
      via: 'project',
    })
    const plan = { argv: ['npm', 'install'], cwdRel: '.' }
    expect(depsTrustOf(plan, 'b', {}).trust).toBe('untrusted')
    expect(depsTrustOf(plan, 'b', withProjectPermission({}))).toMatchObject({
      trust: 'trusted',
      via: 'project',
    })
    const pv = { argv: ['npm', 'run', 'dev'], cwdRel: '.' }
    expect(previewTrustOf(pv, 'dev: vite', {}).trust).toBe('untrusted')
    expect(previewTrustOf(pv, 'dev: vite', withProjectPermission({}))).toMatchObject({
      trust: 'trusted',
      via: 'project',
    })
    // An own grant needs no permission and is not counted as one of its uses.
    const granted = trustOf(cmd, 'b', {})
    expect(
      trustOf(cmd, 'b', {
        ...withProjectPermission({}),
        commands: { [granted.hash]: { kind: 'verify', argv: cmd.argv, cwdRel: '.', body: 'b', at: 1 } },
      }).via,
    ).toBeUndefined()
  })
})

describe('the service', () => {
  function world(o: { attachments?: Record<string, EasyAttachment> } = {}) {
    const home = temp()
    const docs = join(temp(), 'Documents')
    const order: string[] = []
    const starts: RunStartRequest[] = []
    const copied: string[][] = []
    const deps: EasyDeps = {
      home,
      documentsDir: docs,
      newHome: false,
      log: silentLogger,
      now: () => 1000,
      readUser: () => Promise.resolve(null),
      patchUser: () => Promise.resolve(),
      packs: () => Promise.resolve(readBuiltinPacks().map((v) => v.pack)),
      templates: () => loadTemplates({ home }),
      readiness: () => ({ claude: true, codex: false, profile: 'claude-only', runnable: true }),
      toolchain: () => Promise.resolve({ node: false, python: false }),
      estimate: () => Promise.resolve(null),
      prepareFolder: (folder) => {
        order.push(`prepare ${folder}`)
        return Promise.resolve(folder)
      },
      saveBrief: () => Promise.resolve(),
      startRun: (req) => {
        order.push('start')
        starts.push(req)
        return Promise.resolve({ runId: 'r9', displayNo: 9 })
      },
      summaries: () => [],
      runTask: () => Promise.resolve(null),
      exists: () => false,
      grantPermission: (folder) => {
        order.push(`grant ${folder}`)
        return Promise.resolve()
      },
      checkAttachments: (paths) =>
        Promise.resolve(
          paths.map(
            (p) =>
              o.attachments?.[p] ?? {
                path: p,
                name: p.split(/[\\/]/).pop() ?? p,
                bytes: 1,
                folder: false,
                dest: 'data',
              },
          ),
        ),
      copyAttachments: (paths) => {
        copied.push([...paths])
        order.push('copy')
        return Promise.resolve(paths.map((p) => `data/${p.split(/[\\/]/).pop() ?? p}`))
      },
      checks: () => Promise.resolve([{ name: 'test', run: ['npm', 'run', 'test'] }]),
    }
    return { svc: new EasyService(deps), order, starts, copied, docs }
  }

  it('gives the permission to the new folder only, after it is made and before the run, and only with consent', async () => {
    const t = world()
    const folder = join(t.docs, 'guide')
    const limits = { maxCostUsd: null, maxMinutes: null }
    await t.svc.create({ idea: 'A help guide', kind: 'document', folder, limits, consent: true })
    expect(t.order).toEqual([`prepare ${folder}`, `grant ${folder}`, 'start'])
    const u = world()
    await u.svc.create({ idea: 'A help guide', kind: 'document', folder, limits, consent: false })
    expect(u.order).toEqual([`prepare ${folder}`, 'start'])
    // The document's run says how to open it; an app's does not.
    expect(t.starts[0]?.overrides?.passes?.plan).toMatchObject({ explainPlain: true })
    const a = world()
    await a.svc.create({ idea: 'A tip splitter app', kind: 'app', folder, limits, consent: true })
    expect(a.starts[0]?.overrides?.passes?.plan).not.toHaveProperty('explainPlain')
  })

  it('checks added files before making anything; copies them in and tells the run about them', async () => {
    const bad = 'C:\\Users\\me\\.ssh\\id_rsa'
    const t = world({
      attachments: {
        [bad]: { path: bad, name: 'id_rsa', bytes: 1, folder: false, dest: 'assets', error: 'refused' },
      },
    })
    const folder = join(t.docs, 'report')
    const limits = { maxCostUsd: null, maxMinutes: null }
    await expect(
      t.svc.create({
        idea: 'A report from my sales',
        kind: 'data',
        folder,
        limits,
        consent: false,
        attachments: ['C:\\Users\\me\\sales.csv', bad],
      }),
    ).rejects.toThrow('id_rsa: refused')
    expect(t.order).toEqual([])
    await t.svc.create({
      idea: 'A report from my sales',
      kind: 'data',
      folder,
      limits,
      consent: false,
      attachments: ['C:\\Users\\me\\sales.csv'],
    })
    expect(t.order).toEqual([`prepare ${folder}`, 'copy', 'start'])
    expect(t.starts[0]?.task.endsWith(attachmentsNote(['data/sales.csv']))).toBe(true)
  })

  it('a change run checks with the folder’s own checks', async () => {
    const t = world()
    await t.svc.change({
      folder: 'C:\\p\\guide',
      change: 'Add a page',
      limits: { maxCostUsd: null, maxMinutes: null },
    })
    expect(t.starts[0]?.overrides?.verify).toEqual({
      enabled: true,
      commands: [{ name: 'test', run: ['npm', 'run', 'test'] }],
    })
  })
})
