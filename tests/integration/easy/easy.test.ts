// Easy mode through a real core, real git and the fake Claude on temp folders (the projects folder is a temp folder
// set in the user file, never the real Documents): easy.state for an existing home, easy.setExperience writing
// ui.experience, easy.resolve deciding locally without creating anything, easy.create making the git-initialised empty
// folder and starting an ordinary run with the Easy recipe and overrides (plain questions from clarify-easy.md, no
// extensions, the run's own limit), the limit stopping the run once its cost passes it (runs.limits says why), and the
// project list.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'
import type { Scenario } from '../run/scenario.ts'

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

async function boot(): Promise<{ core: Core; home: string; projects: string; sc: Scenario }> {
  const sc = await makeScenario({
    clarify: [{ recording: 'C02-review-shape', text: '{"questions": []}' }],
    plan: { recording: 'C06-plan-native-host' },
  })
  const { home } = await makeHome(sc)
  const root = mkdtempSync(join(tmpdir(), 'dimf-easy-int-'))
  const projects = join(root, 'Projects')
  dirs.push(home, sc.dir, join(root, 'x'))
  const file = join(home, 'dimfactory.json')
  const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  // Clarify runs on the Plan pass's model: haiku, so the fake tells it from the reviewers.
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...user,
        passes: { ...(user['passes'] as object), plan: { model: 'haiku' } },
        easy: { projectsDir: projects },
      },
      null,
      2,
    ),
  )
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  value(await core.invoke('vendors.probe', { vendor: 'claude' }))
  return { core, home, projects, sc }
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe('Easy mode through the core', () => {
  it('state, the switch, a local resolve, then a new project whose run stops at its own limit', async () => {
    const { core, home, projects, sc } = await boot()

    // An existing home (it has a user file): never asked; the projects folder from Easy settings.
    const state = value(await core.invoke('easy.state'))
    expect(state).toMatchObject({ experience: null, askWelcome: false, projectsDir: projects })
    expect(value(await core.invoke('easy.setExperience', { experience: 'easy' })).experience).toBe('easy')
    expect(JSON.parse(readFileSync(join(home, 'dimfactory.json'), 'utf8'))).toMatchObject({
      ui: { experience: 'easy' },
    })

    const idea = 'A help guide for the customers of my knitting shop'
    const resolved = value(await core.invoke('easy.resolve', { idea }))
    expect(resolved).toMatchObject({
      kind: 'document',
      template: { id: 'docs-simple' },
      recipe: 'easy-documents',
      folder: join(projects, 'help-guide-customers'),
      vendors: { claude: true, ready: true },
      limits: { maxCostUsd: null, maxMinutes: null },
    })
    // Resolving creates nothing.
    expect(existsSync(projects)).toBe(false)

    const started = value(
      await core.invoke('easy.create', {
        idea,
        kind: resolved.kind,
        folder: resolved.folder,
        // A limit far below what any pass costs: the first pass that ends stops the run.
        limits: { maxCostUsd: 0.000_001, maxMinutes: null },
        consent: true,
      }),
    )
    expect(started.folder).toBe(resolved.folder)
    // A new repository with nothing committed.
    expect(readdirSync(resolved.folder)).toContain('.git')

    const resolvedJson = JSON.parse(
      readFileSync(join(home, 'runs', started.runId, 'resolved.json'), 'utf8'),
    ) as { config: Record<string, unknown> }
    expect(resolvedJson.config).toMatchObject({
      limits: { maxCostUsd: 0.000_001, maxMinutes: null },
      auto: false,
      passes: {
        plan: { clarify: true, clarifyPlain: true, extensions: 'none' },
        // The passes that build run at the user's own level (pass through by default).
        implement: { extensions: 'passthrough' },
        fix: { extensions: 'passthrough' },
        review: { extensions: 'none' },
      },
    })

    const ended = await waitFor(async () => {
      const s = value(await core.invoke('runs.get', { runId: started.runId })).summary
      return s.status === 'cancelled' || s.status === 'completed' || s.status === 'failed' ? s : undefined
    })
    expect(ended.status).toBe('cancelled')
    const limits = value(await core.invoke('runs.limits', { runId: started.runId }))
    expect(limits.limits).toEqual({ maxCostUsd: 0.000_001, maxMinutes: null })
    expect(limits.stop).toMatchObject({ kind: 'cost', limit: 0.000_001 })

    // Clarify asked its plain questions (clarify-easy.md).
    const stdin = sc
      .entries()
      .filter((e) => e.kind === 'stdin')
      .map((e) => JSON.stringify(e))
      .join('\n')
    expect(stdin).toContain('Someone who does not write code wants this made')

    const list = value(await core.invoke('easy.projects'))
    expect(list[0]).toMatchObject({ folder: resolved.folder, kind: 'document', lastRunId: started.runId })
  })
})
