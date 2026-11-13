// Easy mode's project permission through a real core, real git and the fake Claude on temp folders (the projects
// folder is a temp folder set in the user file, never the real Documents):
//  A. A new project made with "Allow these for this project": trust.json holds the grant for that folder; Implement's
//     `npm install` and `npm run dev` (the project's own manifest and script) are answered by core without an ask, each
//     logged and counted; a write outside the folder still asks; revoking while it waits takes effect at once: the next
//     `npm install` asks, and the verify command after Implement needs its trust card again. Nothing is left in
//     trust.json.
//  B. Without a revoke, the project's own verify command runs with no trust card (one more logged use), and a document
//     project's summary is the "How to open it" one (explain-easy.md).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunEnvelope, RunSnapshot } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeScenario } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import { rewriteAsks } from './asks.ts'

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

const PACKAGE = JSON.stringify({ name: 'shop', private: true, scripts: { dev: 'vite', test: 'node -e 0' } })
const SUMMARY = [
  '## What was made',
  'A guide.',
  '',
  '## How to open it',
  '1. Open docs/index.md.',
  '',
  '## What to check next',
  '- Read it.',
  '',
  '## Known limits',
  '- None known.',
].join('\n')

async function boot(
  spec: ScenarioSpec,
  edit?: (sc: Scenario) => void,
): Promise<{
  core: Core
  home: string
  projects: string
  sc: Scenario
}> {
  const sc = await makeScenario(spec)
  edit?.(sc)
  const { home } = await makeHome(sc)
  const root = mkdtempSync(join(tmpdir(), 'dimf-easy-perm-'))
  const projects = join(root, 'Projects')
  dirs.push(home, sc.dir, join(root, 'x'))
  const file = join(home, 'dimfactory.json')
  const user = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  // Clarify and Explain run on the Plan pass's model (haiku): they take the explain list in turn. No plan check.
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...user,
        passes: { ...(user['passes'] as object), plan: { model: 'haiku' } },
        easy: { projectsDir: projects, skipPlanCheck: true },
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
    await new Promise((r) => setTimeout(r, 150))
  }
}

const snap = async (core: Core, runId: string): Promise<RunSnapshot> =>
  value(await core.invoke('runs.get', { runId }))

async function events(core: Core, runId: string): Promise<RunEnvelope[]> {
  return value(await core.invoke('runs.events', { runId, sinceSeq: 0, limit: 2000 })).events
}

async function create(
  core: Core,
  idea: string,
  consent: boolean,
): Promise<{ runId: string; folder: string }> {
  const r = value(await core.invoke('easy.resolve', { idea }))
  return value(
    await core.invoke('easy.create', {
      idea,
      kind: r.kind,
      folder: r.folder,
      limits: { maxCostUsd: null, maxMinutes: null },
      consent,
    }),
  )
}

async function ended(core: Core, runId: string): Promise<RunSnapshot['summary']> {
  return waitFor(async () => {
    const s = (await snap(core, runId)).summary
    return s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled' ? s : undefined
  }, 150_000)
}

describe('the project permission through the core', () => {
  it('A: covers the install and the script, still asks outside, and a revoke takes effect during the run', async () => {
    const outside = join(tmpdir(), 'dimf-outside-never-written.txt')
    const { core, home } = await boot(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C04a-ask-allow' }],
        explain: [
          { recording: 'C02-review-shape', text: '{"questions": []}' },
          { recording: 'C02-review-shape', text: SUMMARY },
        ],
      },
      (sc) =>
        rewriteAsks(
          join(sc.dir, 'implement-1.script.jsonl'),
          [
            { tool: 'Bash', input: { command: 'npm install' } },
            { tool: 'Bash', input: { command: 'npm run dev' } },
            { tool: 'Write', input: { file_path: outside, content: 'x' } },
            { tool: 'Bash', input: { command: 'npm install' } },
          ],
          [{ op: 'writeFile', path: 'package.json', content: PACKAGE }],
        ),
    )
    const { runId, folder } = await create(core, 'A help guide for the customers of my knitting shop', true)
    const trust = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as {
      folders: Record<string, { grants: { easyProject?: { folder: string } } }>
    }
    expect(Object.values(trust.folders).map((f) => f.grants.easyProject?.folder)).toEqual([folder])
    expect(value(await core.invoke('easy.permissions')).map((p) => p.folder)).toEqual([folder])

    // The write outside the folder asks; the install and the script before it did not.
    const outsideAsk = await waitFor(async () => (await snap(core, runId)).asks[0])
    expect(outsideAsk.kind).toBe('edit')
    expect(outsideAsk.detail).toContain(outside)
    const s1 = await snap(core, runId)
    expect(s1.autoAnswered?.project).toBe(2)
    expect(value(await core.invoke('easy.permission', { folder, runId }))).toMatchObject({
      granted: true,
      runUses: 2,
    })

    // Revoked while it waits: the next install asks.
    value(await core.invoke('easy.revokePermission', { folder }))
    expect(value(await core.invoke('easy.permission', { folder }))).toMatchObject({ granted: false })
    value(await core.invoke('asks.answer', { runId, requestId: outsideAsk.requestId, decision: 'allow' }))
    const again = await waitFor(async () => {
      const a = (await snap(core, runId)).asks[0]
      return a !== undefined && a.requestId !== outsideAsk.requestId ? a : undefined
    })
    expect(again.kind).toBe('shell')
    expect(again.detail).toContain('npm install')
    value(await core.invoke('asks.answer', { runId, requestId: again.requestId, decision: 'allow' }))
    await ended(core, runId)

    const bodies = (await events(core, runId)).map((e) => e.body)
    // The plan capture is how Plan's answer is taken, not an ask.
    const auto = bodies.filter((b) => b.t === 'auto-answered' && b.why !== 'plan-capture')
    expect(auto.map((b) => (b.t === 'auto-answered' ? b.why : ''))).toEqual([
      'project-permission',
      'project-permission',
    ])
    expect(value(await core.invoke('easy.permission', { folder, runId })).runUses).toBe(2)
    const log = readFileSync(join(home, 'easy', 'permission-uses.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(log.map((l) => (JSON.parse(l) as { label: string }).label)).toEqual(['npm install', 'npm run dev'])
    const after = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as {
      folders: Record<string, { grants: Record<string, unknown> }>
    }
    expect(Object.values(after.folders).some((f) => f.grants['easyProject'] !== undefined)).toBe(false)
  }, 300_000)

  it('B: a change run’s own verify command runs with no trust card; a document says how to open it', async () => {
    const { core, home, sc } = await boot({
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        {
          recording: 'C08a-session-id-implement',
          prepend: [{ op: 'writeFile', path: 'package.json', content: PACKAGE }],
          write: { path: 'docs/index.md', content: '# Shop help\n' },
        },
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'docs/shipping.md', content: '# Shipping\n' },
        },
      ],
      explain: [
        { recording: 'C02-review-shape', text: '{"questions": []}' },
        { recording: 'C02-review-shape', text: SUMMARY },
        { recording: 'C02-review-shape', text: '{"questions": []}' },
        { recording: 'C02-review-shape', text: SUMMARY },
      ],
    })
    const first = await create(core, 'A help guide for the customers of my knitting shop', true)
    expect((await ended(core, first.runId)).status).toBe('completed')
    const folder = first.folder
    const resolved = JSON.parse(readFileSync(join(home, 'runs', first.runId, 'resolved.json'), 'utf8')) as {
      config: { passes: { plan: Record<string, unknown> } }
    }
    expect(resolved.config.passes.plan).toMatchObject({ explainPlain: true, clarifyPlain: true })

    // A change: the project now has its own test script, which the run checks with, trusted by the permission.
    const change = value(
      await core.invoke('easy.change', {
        folder,
        change: 'Add a page about shipping',
        limits: { maxCostUsd: null, maxMinutes: null },
      }),
    )
    const runId = change.runId
    const s = await ended(core, runId)
    expect(s.status).toBe('completed')
    const done = await snap(core, runId)
    expect(done.steps['verify:1'].status).toBe('done')
    const bodies = (await events(core, runId)).map((e) => e.body)
    expect(bodies.some((b) => b.t === 'card' && JSON.stringify(b).includes('"kind":"trust"'))).toBe(false)
    const log = readFileSync(join(home, 'easy', 'permission-uses.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(log.map((l) => JSON.parse(l) as { what: string; label: string; runId: string })).toContainEqual(
      expect.objectContaining({ what: 'command', label: 'npm run test', runId }),
    )
    expect(value(await core.invoke('easy.permission', { folder, runId })).runUses).toBeGreaterThanOrEqual(1)
    // The change run is a document project's too: its summary says how to open it.
    const changeResolved = JSON.parse(readFileSync(join(home, 'runs', runId, 'resolved.json'), 'utf8')) as {
      config: { passes: { plan: Record<string, unknown> } }
    }
    expect(changeResolved.config.passes.plan).toMatchObject({ explainPlain: true })
    // Explain was told to say how to open it (explain-easy.md).
    const stdin = sc
      .entries()
      .filter((e) => e.kind === 'stdin')
      .map((e) => JSON.stringify(e))
      .join('\n')
    expect(stdin).toContain('How to open it')
    expect(stdin).toContain('they open files, they do not run programs')
  }, 300_000)
})
