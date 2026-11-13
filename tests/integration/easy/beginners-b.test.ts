// Beginners, part B through a real core, real git and the fake Claude on temp folders (the projects folder is a temp
// folder set in the user file; no network): a checklist idea starts from the plain printable checklist, not the
// runbook; a change to a project Easy made runs with its saved Brief, the security advisor's secret scan (its reviewer
// kept for changes that touch keys or people's data) and, for a small change, a lighter Plan model with no Critic; the
// change's estimate is there before it starts; and a folder with unsaved files is counted, then saved first.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

async function boot(): Promise<{ core: Core; home: string; projects: string }> {
  const sc = await makeScenario({
    clarify: [{ recording: 'C02-review-shape', text: '{"questions": []}' }],
    plan: { recording: 'C06-plan-native-host' },
  })
  const { home } = await makeHome(sc)
  const projects = join(temp('dimf-easy-b-'), 'Projects')
  dirs.push(home, sc.dir)
  const file = join(home, 'dimfactory.json')
  const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...user, easy: { projectsDir: projects } }, null, 2))
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  value(await core.invoke('vendors.probe', { vendor: 'claude' }))
  return { core, home, projects }
}

interface Resolved {
  config: {
    passes: {
      plan: { model: string | null }
      critic: { enabled: boolean }
      security: { enabled: boolean; review?: string }
    }
  }
  brief?: { text: string }
}

const LIMITS = { maxCostUsd: null, maxMinutes: null }

/** Stop a run and wait until it lets go of its folder (its summary is no longer running). */
async function stopped(core: Core, runId: string): Promise<void> {
  value(await core.invoke('runs.stop', { runId }))
  for (let i = 0; i < 200; i++) {
    const page = value(await core.invoke('runs.list', {}))
    const s = page.items.find((r) => r.runId === runId)
    if (s !== undefined && s.status !== 'running' && s.phase !== 'stopping' && s.lock !== 'held') return
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('a checklist idea', () => {
  it('starts from the plain printable checklist; server words still get the runbook', async () => {
    const { core } = await boot()
    const r = value(
      await core.invoke('easy.resolve', {
        idea: 'A step by step checklist for opening my cafe each morning',
      }),
    )
    expect(r.kind).toBe('checklist')
    expect(r.template).toEqual({ id: 'checklist', label: 'Checklist (print or tick on screen)' })
    expect(r.checks).toEqual(['Page loads (Dim Factory)'])
    const ops = value(
      await core.invoke('easy.resolve', { idea: 'A checklist for deploying our server', kind: 'checklist' }),
    )
    expect(ops.template.id).toBe('runbook')
  })
})

describe('a change to a project Easy made', () => {
  it('keeps the saved Brief and scans; a small one plans lighter with no Critic; its estimate comes first', async () => {
    const { core, home } = await boot()
    const idea = 'A landing page for my bakery with our opening hours'
    const r = value(await core.invoke('easy.resolve', { idea, stack: 'html' }))
    const first = value(
      await core.invoke('easy.create', {
        idea,
        kind: r.kind,
        folder: r.folder,
        limits: LIMITS,
        consent: false,
        stack: 'html',
      }),
    )
    const firstDoc = JSON.parse(readFileSync(homePaths(home).run(first.runId).runJson, 'utf8')) as {
      state: { task: string }
    }
    // Every Easy task carries the rule: the owner's facts are marked slots, never made up.
    expect(firstDoc.state.task).toMatch(/Never invent facts[\s\S]*\[Fill in: what goes here\]/)
    await stopped(core, first.runId)

    const est = value(
      await core.invoke('easy.changeEstimate', { folder: r.folder, change: 'Make the buttons bigger' }),
    )
    expect(est).toMatchObject({ small: true, security: 'scan' })

    const change = value(
      await core.invoke('easy.change', {
        folder: r.folder,
        change: 'Make the buttons bigger',
        limits: LIMITS,
      }),
    )
    const resolved = JSON.parse(
      readFileSync(homePaths(home).run(change.runId).resolvedJson, 'utf8'),
    ) as Resolved
    // The saved Brief carries on (the website's look and choices).
    expect(resolved.brief?.text).toBeTruthy()
    expect(resolved.config.passes.security).toMatchObject({ enabled: true, review: 'sensitive' })
    expect(resolved.config.passes.critic.enabled).toBe(false)
    expect(resolved.config.passes.plan.model).toBe('sonnet')
    await stopped(core, change.runId)

    // A change that names a key gets the full review and the usual models.
    const key = value(
      await core.invoke('easy.change', {
        folder: r.folder,
        change: 'Add a weather widget, my API key is in my notes',
        limits: LIMITS,
      }),
    )
    const keyResolved = JSON.parse(
      readFileSync(homePaths(home).run(key.runId).resolvedJson, 'utf8'),
    ) as Resolved
    expect(keyResolved.config.passes.security).toMatchObject({ enabled: true, review: 'always' })
    expect(keyResolved.config.passes.critic.enabled).toBe(true)
    await stopped(core, key.runId)
  })
})

describe('a folder with unsaved files', () => {
  it('says how many; saving them first commits them before the copy', async () => {
    const { core } = await boot()
    const folder = join(temp('dimf-existing-b-'), 'site')
    mkdirSync(folder)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
        cwd: folder,
        encoding: 'utf8',
      })
    git('init', '-q')
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Site</title>')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Site, changed</title>')
    writeFileSync(join(folder, 'about.html'), '<!doctype html><title>About</title>')
    const v = value(await core.invoke('easy.inspectFolder', { folder }))
    expect(v).toMatchObject({ mode: 'isolated', uncommitted: 2, made: false })
    const started = value(
      await core.invoke('easy.work', {
        folder,
        change: 'Add a contact page',
        how: 'saveFirst',
        limits: LIMITS,
      }),
    )
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '-1', '--format=%s').trim()).toBe('Saved my changes before a change in Dim Factory')
    await stopped(core, started.runId)
  })
})
