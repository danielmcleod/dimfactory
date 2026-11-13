// Integration (refresh validation: "model missing from the proposal → no deletion; a tickable deprecated flag";
// the Settings diff review): the diff the `catalog` diff-ready event carries is the one
// catalog.get shows and catalog.apply recomputes (catalog/live.ts diffFor: the CLI model lists that are known, the
// vendors the proposal priced). Here the user's passes also name Codex, so the refresh covers claude and codex, and the
// answer prices Claude only: no Codex model is offered for deprecation in either diff.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { AppEvent } from '../../../src/shared/ipc.ts'
import { LOCAL, STDIO } from '../adapters/helpers.ts'
import { cleanup, fakeClaudePath, hermeticEnv, loadConverter } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** C17 as a script whose initialize may carry any schema (the vendor enum here is claude and codex). */
async function refreshScript(dir: string): Promise<string> {
  const convert = await loadConverter()
  const text = convert(readFileSync(join(STDIO, 'C17-refresh-structured-output', 'recording.jsonl'), 'utf8'))
  const ops = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const op = JSON.parse(l) as { op: string; match?: { request?: { jsonSchema?: unknown } } }
      if (op.op === 'expectStdin' && op.match?.request?.jsonSchema !== undefined)
        op.match.request.jsonSchema = '$_'
      return JSON.stringify(op)
    })
  const file = join(dir, 'refresh.script.jsonl')
  writeFileSync(file, `${ops.join('\n')}\n`)
  return file
}

describe('the diff-ready event and catalog.get', () => {
  it('carry the same review when the refresh covers a vendor the answer did not price', async () => {
    const root = mkdtempSync(join(tmpdir(), 'event-diff-'))
    dirs.push(root)
    const scenario = join(root, 'scenario')
    mkdirSync(scenario, { recursive: true })
    writeFileSync(
      join(scenario, 'scenario.json'),
      JSON.stringify([
        { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
        {
          match: { argvIncludes: ['auth', 'status'] },
          script: join(LOCAL, 'auth-status.script.jsonl'),
          repeat: true,
        },
        {
          match: { argvIncludes: ['-p', 'WebSearch*'] },
          script: await refreshScript(scenario),
          repeat: true,
        },
        {
          match: { argvIncludes: ['-p'] },
          script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
          repeat: true,
        },
      ]),
    )
    const home = join(root, 'home')
    const claudeConfig = join(root, 'claude-config')
    mkdirSync(home, { recursive: true })
    mkdirSync(claudeConfig, { recursive: true })
    writeFileSync(
      join(home, 'dimfactory.json'),
      JSON.stringify({
        profile: 'claude-only',
        // Review on Codex: the refresh covers claude and codex.
        passes: { review: { vendor: 'codex' } },
        vendors: {
          claude: {
            path: await fakeClaudePath(),
            env: {
              FAKE_CLI_SCRIPT: scenario,
              FAKE_CLI_LOG: join(root, 'fake.log.jsonl'),
              FAKE_CLI_TIMEOUT_MS: '30000',
              CLAUDE_CONFIG_DIR: claudeConfig,
            },
          },
        },
      }),
    )
    const core = await createCore({
      home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      catalogScheduler: false,
    })
    cores.push(core)
    const events: Extract<AppEvent, { kind: 'catalog' }>[] = []
    core.bus.attach({ name: 'test', global: (ev) => ev.kind === 'catalog' && events.push(ev) })

    const plan = await core.invoke('catalog.refreshPlan')
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.vendors).toEqual(['claude', 'codex'])
    const started = await core.invoke('catalog.refresh', { consent: true })
    if (!started.ok) throw new Error(started.error.message)
    await until(() => events.some((e) => e.state === 'diff-ready' || e.state === 'failed'))
    const ended = events.at(-1)
    expect(ended?.error).toBeUndefined()
    expect(ended?.state).toBe('diff-ready')

    const got = await core.invoke('catalog.get')
    if (!got.ok) throw new Error(got.error.message)
    const shown = got.value.job?.diff
    expect(shown).toBeDefined()
    const view = (d: typeof shown) => ({
      rows: (d?.rows ?? []).map((r) => ({ id: r.id, flags: r.flags, ticked: r.ticked })),
      rejected: d?.rejected,
      unverifiable: d?.unverifiable,
    })
    expect(view(ended?.diff)).toEqual(view(shown))
    // The answer priced Claude only: no Codex model is offered for deprecation.
    expect(shown?.rows.filter((r) => r.vendor === 'codex')).toEqual([])
    expect(ended?.diff?.rows.filter((r) => r.vendor === 'codex')).toEqual([])
  })
})
