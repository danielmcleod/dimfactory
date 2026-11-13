// Seeds for the context report end to end tests: a project's earlier runs in runs/index.jsonl, each with its
// context-health.json (a big memory file, a heavy skill in the first three, an MCP server never called).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextContributor, ContextHealthReport } from '../../src/shared/context.ts'
import type { RunSummary } from '../../src/shared/run.ts'
import { DAY_MS, seededSummary } from './history-helpers.ts'
const skill: ContextContributor = { kind: 'skill', name: 'big-helper', tokens: 12_000, from: 'vendor' }
const memory: ContextContributor = { kind: 'memory', name: 'CLAUDE.md', tokens: 40_000, from: 'estimate' }
const tracker: ContextContributor = {
  kind: 'mcp',
  name: 'tracker',
  tokens: 9_000,
  tools: 31,
  from: 'vendor',
  calls: 0,
}

/**
 * A project folder of its own for the seeded runs (the harness makes its sandbox only in start(), after the history is
 * read): made in the test's root before start.
 */
export function contextProject(root: string): string {
  const dir = join(root, 'context-project')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Six runs of `folder`: the first three loaded the skill and two of them failed; one had a grounding finding. */
export function seedContextRuns(home: string, folder: string, now: number): RunSummary[] {
  const runs = join(home, 'runs')
  mkdirSync(runs, { recursive: true })
  const out: RunSummary[] = []
  for (let i = 0; i < 6; i++) {
    const withSkill = i < 3
    const failed = i < 2
    const s = seededSummary(
      {
        title: `context run ${i + 1}`,
        folder,
        status: failed ? 'failed' : 'completed',
        ageMs: (i + 1) * DAY_MS,
      },
      i + 1,
      now,
    )
    out.push(s)
    const health: ContextHealthReport = {
      version: 1,
      passes: [
        {
          step: 'implement',
          vendor: 'claude',
          peakPercent: 40,
          compactions: 0,
          contributors: [memory, ...(withSkill ? [skill] : []), tracker],
        },
        { step: 'review', vendor: 'claude', peakPercent: 20, compactions: 0, contributors: [memory] },
      ],
      items: [],
      grounding: { findings: i === 2 ? 1 : 0, musts: i === 2 ? 1 : 0, hallucinations: 0 },
    }
    mkdirSync(join(runs, s.runId), { recursive: true })
    writeFileSync(join(runs, s.runId, 'context-health.json'), `${JSON.stringify(health, null, 2)}\n`)
  }
  writeFileSync(
    join(runs, 'index.jsonl'),
    out.map((s) => JSON.stringify({ v: 1, op: 'put', s })).join('\n') + '\n',
  )
  return out
}
