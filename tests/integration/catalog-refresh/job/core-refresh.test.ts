// Catalog refresh through a real core (catalog.spec.ts "refresh without consent rejected"): core.invoke
// has no IPC schema in front of it, so catalog.refresh itself refuses a request without literal consent and spawns
// nothing; catalog.refreshPlan gives the consent card's numbers; with consent the job runs Claude (the fake replaying
// C17) and ends diff-ready with the validated diff in the `catalog` AppEvent. A read-only core refuses the refresh.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { REFRESH_COPY } from '../../../../src/core/catalog/refresh-jobs.ts'
import { readJobStatus } from '../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../src/core/catalog/sources.ts'
import type { AppEvent } from '../../../../src/shared/ipc.ts'
import { readFakeLog } from '../../../fake-cli/harness.ts'
import { LOCAL, STDIO } from '../../adapters/helpers.ts'
import { cleanup, fakeClaudePath, hermeticEnv } from '../../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function until(pred: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** A home whose `claude` is the fake: the refresh spawn (the only one with --allowedTools) replays C17. */
async function home(): Promise<{ home: string; log: string }> {
  const root = mkdtempSync(join(tmpdir(), 'core-'))
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
        match: { argvIncludes: ['--allowedTools'] },
        script: join(STDIO, 'C17-refresh-structured-output', 'recording.jsonl'),
        repeat: true,
      },
      {
        match: { argvIncludes: ['-p'] },
        script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
        repeat: true,
      },
    ]),
  )
  const log = join(root, 'fake.log.jsonl')
  const h = join(root, 'home')
  const claudeConfig = join(root, 'claude-config')
  mkdirSync(h, { recursive: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(
    join(h, 'dimfactory.json'),
    JSON.stringify({
      profile: 'claude-only',
      vendors: {
        claude: {
          path: await fakeClaudePath(),
          env: {
            FAKE_CLI_SCRIPT: scenario,
            FAKE_CLI_LOG: log,
            FAKE_CLI_TIMEOUT_MS: '30000',
            CLAUDE_CONFIG_DIR: claudeConfig,
          },
        },
      },
    }),
  )
  return { home: h, log }
}

const refreshSpawns = (log: string): number => {
  try {
    return readFakeLog(log).filter(
      (e) =>
        e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('--allowedTools'),
    ).length
  } catch {
    return 0
  }
}

describe('catalog refresh through the core', () => {
  it('no consent, no job; the plan; with consent, Claude runs read-only and the diff is ready', async () => {
    const h = await home()
    const core = await createCore({
      home: h.home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      catalogScheduler: false,
    })
    cores.push(core)
    const events: Extract<AppEvent, { kind: 'catalog' }>[] = []
    core.bus.attach({ name: 'test', global: (ev) => ev.kind === 'catalog' && events.push(ev) })

    // catalog.spec.ts: refresh without consent is rejected and starts nothing.
    for (const req of [{ consent: false }, {}, { consent: 'true' }, undefined]) {
      const r = await core.invoke('catalog.refresh', req as never)
      expect(r.ok ? null : r.error.code).toBe('VALIDATION')
    }
    expect(events).toEqual([])
    expect(refreshSpawns(h.log)).toBe(0)

    // The consent card's numbers: Claude with the configured model, the priors priced at the seed's sonnet rate.
    const plan = await core.invoke('catalog.refreshPlan')
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value).toMatchObject({
      vendor: 'claude',
      model: 'sonnet',
      vendorName: 'Claude',
      estDurationMs: 240_000,
      estSamples: 0,
      copy: REFRESH_COPY,
      vendors: ['claude'],
      hosts: officialHosts(['claude']),
    })
    expect(plan.value.estCostUsd).toBeCloseTo(0.224, 6)
    expect(refreshSpawns(h.log)).toBe(0)

    // With consent.
    const started = await core.invoke('catalog.refresh', { consent: true })
    if (!started.ok) throw new Error(started.error.message)
    const { jobId } = started.value
    await until(() => events.some((e) => e.state === 'diff-ready' || e.state === 'failed'))
    const end = events.at(-1)
    expect(end?.error).toBeUndefined()
    expect(end).toMatchObject({ state: 'diff-ready', jobId })
    expect(events[0]).toMatchObject({ state: 'running', jobId, progress: 'Starting Claude' })
    expect(events.map((e) => e.progress).filter((p) => p !== undefined)).toContain(
      'Reading platform.claude.com',
    )
    // The validated diff of the live C17: Sonnet 5.5's cache-read price moved (0.2 → 0.1, ticked), the other
    // known prices confirmed, Haiku 5.5 new (flagged: the CLI's model list is not known here), nothing unverifiable.
    const rows = end?.diff?.rows ?? []
    expect(
      rows.some(
        (r) =>
          r.kind === 'price' &&
          r.model === 'claude-sonnet-5-5' &&
          r.field === 'cacheReadPerMTok' &&
          r.proposed === 0.1 &&
          r.ticked,
      ),
    ).toBe(true)
    expect(rows.filter((r) => r.kind === 'confirm').map((r) => r.model)).toContain('claude-opus-5-5')
    expect(rows.find((r) => r.kind === 'new-model')).toMatchObject({
      model: 'claude-haiku-5-5',
      ticked: false,
    })
    expect(end?.diff?.unverifiable).toEqual([])
    expect(refreshSpawns(h.log)).toBe(1)
    expect(await readJobStatus(h.home, jobId)).toMatchObject({
      state: 'diff-ready',
      vendor: 'claude',
      model: 'sonnet',
    })

    // Cancel after the end is a no-op; an unknown job is NOT_FOUND.
    expect(await core.invoke('catalog.cancel', { jobId })).toEqual({ ok: true, value: undefined })
    const unknown = await core.invoke('catalog.cancel', { jobId: '20200101T000000Z-0000' })
    expect(unknown.ok ? null : unknown.error.code).toBe('NOT_FOUND')
  })

  it('a read-only core never starts a refresh', async () => {
    const h = await home()
    const core = await createCore({ home: h.home, host: { kind: 'cli' }, env: hermeticEnv(), readOnly: true })
    cores.push(core)
    const r = await core.invoke('catalog.refresh', { consent: true })
    expect(r.ok ? null : r.error.code).toBe('FORBIDDEN')
    expect(refreshSpawns(h.log)).toBe(0)
  })
})
