// The catalog refresh job end to end on Claude (a read-only, web-limited pass): the real Claude adapter spawns the
// fake CLI replaying the C17/C18 fixtures (C17 and C18a live, C18b synthesized; the fake deep-compares every stdin
// frame, initialize jsonSchema included, and exits 99 on a mismatch). Its log shows the exact read-only, web-limited argv and the job folder as cwd.
// Cancel and the timeout take the process tree down (a grandchild included).
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildArgv } from '../../../../src/core/adapters/claude/launch.ts'
import {
  JOB_FILES,
  readJobStatus,
  refreshJobDir,
  refreshJsonSchema,
  runRefreshJob,
} from '../../../../src/core/catalog/refresh.ts'
import type { RefreshJobDeps } from '../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../src/core/catalog/sources.ts'
import { loadSeedPricing } from '../../../../src/core/catalog/store.ts'
import { isAlive } from '../../../../src/core/proc/ps.ts'
import { readFakeLog } from '../../../fake-cli/harness.ts'
import type { FakeLogEntry } from '../../../fake-cli/harness.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup } from '../../adapters/helpers.ts'
import { loadConverter } from '../../run/scenario.ts'
import type { FakeSetup } from '../../adapters/helpers.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
})

const HANG_SCRIPT = [
  {
    op: 'expectStdin',
    match: { type: 'control_request', request: { subtype: 'initialize' } },
    capture: { rid: 'request_id' },
  },
  {
    op: 'stdout',
    json: {
      type: 'control_response',
      response: { subtype: 'success', request_id: '$rid', response: { models: [] } },
    },
  },
  { op: 'expectStdin', match: { type: 'user' } },
  {
    op: 'stdout',
    json: {
      type: 'system',
      subtype: 'init',
      session_id: 'refresh-hang-1',
      cwd: '$FAKE_CWD',
      model: 'claude-sonnet-5-5',
      permissionMode: 'dontAsk',
    },
  },
  { op: 'spawnGrandchild', sleepMs: 120000 },
  { op: 'sleep', ms: 120000 },
  { op: 'exit', code: 0 },
]

/** A scenario where the refresh spawn (the only one with --allowedTools) runs `script`. */
function scenario(script: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-scenario-'))
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      {
        match: { argvIncludes: ['auth', 'status'] },
        script: join(LOCAL, 'auth-status.script.jsonl'),
        repeat: true,
      },
      { match: { argvIncludes: ['--allowedTools'] }, script, repeat: true },
      {
        match: { argvIncludes: ['-p'] },
        script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
        repeat: true,
      },
    ]),
  )
  return { dir, log: join(dir, 'fake.log.jsonl') }
}

/** What the live C17 answered (2026-10-12), model and input price per million tokens, in its order. */
const LIVE_C17_ENTRIES: [string, number][] = [
  ['claude-fable-5-1', 10],
  ['claude-fable-5', 10],
  ['claude-opus-5-5', 4],
  ['claude-sonnet-5-5', 2],
  ['claude-haiku-5-5', 0.1],
  ['claude-opus-5', 5],
  ['claude-sonnet-5', 2],
  ['claude-opus-4-8', 5],
  ['claude-opus-4-7', 5],
  ['claude-opus-4-6', 5],
  ['claude-sonnet-4-6', 3],
  ['claude-haiku-4-5-20251001', 1],
]

/** A recording as a fake-cli script (scripts/fixture-to-script.mjs: partial stdin matches) whose initialize may carry any schema. */
async function withoutSchemaCheck(id: string): Promise<string> {
  const convert = await loadConverter()
  const file = join(mkdtempSync(join(tmpdir(), 'refresh-script-')), 'script.jsonl')
  writeFileSync(file, convert(readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')))
  return file
}

function hangScript(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'refresh-hang-')), 'hang.script.jsonl')
  writeFileSync(file, HANG_SCRIPT.map((o) => JSON.stringify(o)).join('\n'))
  return file
}

async function deps(
  s: { dir: string; log: string },
  o: Partial<RefreshJobDeps> = {},
): Promise<RefreshJobDeps> {
  return {
    home: process.env['DIM_FACTORY_HOME'] ?? mkdtempSync(join(tmpdir(), 'refresh-home-')),
    adapter: fakeAdapter(setup, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } }),
    catalog: { pricing: await loadSeedPricing(), models: { schemaVersion: 1, updatedAt: 0, vendors: {} } },
    vendors: ['claude'],
    ...o,
  }
}

const refreshStart = (log: readonly FakeLogEntry[]): FakeLogEntry | undefined =>
  log.find(
    (e) =>
      e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('--allowedTools'),
  )

const stdinOf = (log: readonly FakeLogEntry[], pid: unknown): unknown[] =>
  log.filter((e) => e.kind === 'stdin' && e.pid === pid).map((e) => JSON.parse(String(e['line'])) as unknown)

const same = (a: string, b: string): boolean =>
  realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase()

const req = (jobId: string, signal?: AbortSignal) => ({
  jobId,
  vendor: 'claude',
  model: 'sonnet',
  today: '2026-10-09',
  ...(signal !== undefined ? { signal } : {}),
})

describe('the refresh job on Claude (fake CLI)', () => {
  it('C17: read-only, web-limited argv in the job folder; the schema in initialize; structured_output saved', async () => {
    const s = scenario(join(STDIO, 'C17-refresh-structured-output', 'recording.jsonl'))
    const d = await deps(s)
    const jobId = '20261009T091400Z-c017'
    const r = await runRefreshJob(d, req(jobId))
    const log = readFakeLog(s.log)
    if (!r.ok) throw new Error(`${r.failure.message}\n${readFileSync(s.log, 'utf8').slice(-2000)}`)
    expect(r.answerSource).toBe('structured_output')
    // The live answer (2026-10-12), every model on the pricing page.
    expect(r.proposal.entries.map((e) => [e.model, e.inputPerMTok])).toEqual(LIVE_C17_ENTRIES)
    expect(r.proposal.newModels.map((m) => m.id)).toEqual(['claude-haiku-5-5'])

    // The spawn: exactly the refresh job's flags, the official hosts, the job folder as cwd.
    const start = refreshStart(log)
    expect(start?.['argv']).toEqual(
      buildArgv({
        route: 'readonly',
        mode: 'readonly',
        step: 'catalog',
        model: 'sonnet',
        webDomains: officialHosts(['claude']),
      }),
    )
    expect(same(String(start?.['cwd']), refreshJobDir(d.home, jobId))).toBe(true)
    const sent = stdinOf(log, start?.pid)
    expect(sent[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'initialize', jsonSchema: refreshJsonSchema(['claude']) },
    })
    const prompt = readFileSync(join(refreshJobDir(d.home, jobId), JOB_FILES.prompt), 'utf8')
    expect(sent[1]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null,
    })
    expect(sent).toHaveLength(2)

    // The job's record.
    expect(JSON.parse(readFileSync(join(refreshJobDir(d.home, jobId), JOB_FILES.proposal), 'utf8'))).toEqual(
      r.proposal,
    )
    const status = await readJobStatus(d.home, jobId)
    expect(status?.costUsd).toBeCloseTo(0.3608244, 9)
    expect(status).toMatchObject({
      state: 'diff-ready',
      answerSource: 'structured_output',
      usage: { input: 14, output: 5846, cacheRead: 107_402, cacheWrite: 70_214 },
      counts: { entries: 12, newModels: 1, unverifiable: 0, rejected: 0 },
      // The page it read (live: every fetch was on platform.claude.com; the Bash call the CLI refused
      // reads no page), the vendors it covered and every model it named, for the review's `notFetched` and
      // deprecation checks.
      fetchedHosts: ['platform.claude.com'],
      vendors: ['claude'],
      mentioned: LIVE_C17_ENTRIES.map(([model]) => ({ vendor: 'claude', model })),
    })
    expect(r.fetchedHosts).toEqual(['platform.claude.com'])
    const raw = readFileSync(join(refreshJobDir(d.home, jobId), JOB_FILES.raw), 'utf8')
      .trim()
      .split('\n')
    expect(raw.length).toBeGreaterThan(10)
    // The account's email never reaches the job's raw log. (The live pricing page names a sales address, which the
    // fixture holds as user@example.invalid, so the account's key is what is checked.)
    expect(raw.join('\n')).not.toMatch(/email\\*"\s*:\s*\\*"user@example\.invalid/)
    expect(raw.join('\n')).toMatch(/email\\*"\s*:\s*\\*"\[REDACTED\]/)
  })

  it("the user's own Claude allow-rules cannot widen it: confined env, --tools allow list, the same read-only cut", async () => {
    const s = scenario(join(STDIO, 'C17-refresh-structured-output', 'recording.jsonl'))
    // A Claude config dir whose user settings allow shell, edits, any fetch and subagents.
    const configDir = mkdtempSync(join(tmpdir(), 'refresh-claude-config-'))
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash', 'PowerShell(*)', 'Edit', 'Write', 'WebFetch', 'Agent', 'Workflow'] },
      }),
    )
    const d = await deps(s, {
      adapter: fakeAdapter(setup, {
        vendorEnv: {
          FAKE_CLI_SCRIPT: s.dir,
          FAKE_CLI_LOG: s.log,
          CLAUDE_CONFIG_DIR: configDir,
          // The user's vendor env tries to switch the confinement off; the spawn still has it.
          CLAUDE_CODE_EVAL_CONFINED: '0',
          FAKE_CLI_LOG_ENV: 'CLAUDE_CODE_EVAL_CONFINED',
        },
      }),
    })
    const r = await runRefreshJob(d, req('20261009T091500Z-d13r'))
    expect(r.ok).toBe(true)
    const start = refreshStart(readFakeLog(s.log))
    // The CLI then takes allow-rules only from the argv: no settings rule (the bare WebFetch above included) and no
    // built-in preapproved host (CLAUDE_CODE_EVAL_CONFINED in 2.1.289/2.1.293; capabilities.ts).
    expect(start?.['env']).toEqual({ CLAUDE_CODE_EVAL_CONFINED: '1' })
    const argv = (start?.['argv'] as string[] | undefined) ?? []
    expect(argv[argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
    expect(argv).toEqual(
      buildArgv({
        route: 'readonly',
        mode: 'readonly',
        step: 'catalog',
        model: 'sonnet',
        webDomains: officialHosts(['claude']),
      }),
    )
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe(
      'Edit,Write,NotebookEdit,AskUserQuestion,Monitor,Bash,PowerShell,Agent',
    )
  })

  it('C18a: no structured_output; the fenced JSON block of the answer', async () => {
    // Live C18a was recorded with an initialize without jsonSchema (what a CLI that ignores it does), so the job,
    // which always sends the schema, replays it as a script whose initialize may carry one.
    const s = scenario(await withoutSchemaCheck('C18a-refresh-fenced-fallback'))
    const d = await deps(s)
    const r = await runRefreshJob(d, req('20261009T092000Z-c18a'))
    if (!r.ok) throw new Error(r.failure.message)
    expect(r.answerSource).toBe('fenced-json')
    expect(r.proposal.entries.map((e) => [e.model, e.inputPerMTok]).slice(0, 2)).toEqual([
      ['claude-opus-5-5', 4],
      ['claude-sonnet-5-5', 2],
    ])
    expect(r.proposal.entries).toHaveLength(12)
  })

  it('C18b: retries exhausted is a failed job (stream_malformed) that still records its spend', async () => {
    const s = scenario(join(STDIO, 'C18b-refresh-structured-retries', 'recording.jsonl'))
    const d = await deps(s)
    const jobId = '20261009T093000Z-c18b'
    const r = await runRefreshJob(d, req(jobId))
    expect(r).toMatchObject({
      ok: false,
      cancelled: false,
      failure: {
        category: 'stream_malformed',
        message: 'Failed to provide valid structured output after 3 attempts',
      },
    })
    expect(await readJobStatus(d.home, jobId)).toMatchObject({
      state: 'failed',
      category: 'stream_malformed',
      costUsd: 0.15315,
    })
  })

  it('Cancel kills the process tree (grandchild included); the job reads cancelled', async () => {
    const s = scenario(hangScript())
    const d = await deps(s)
    const abort = new AbortController()
    const grandchild = (): FakeLogEntry | undefined => {
      try {
        return readFakeLog(s.log).find((e) => e.kind === 'grandchild')
      } catch {
        return undefined
      }
    }
    const poll = (): void => {
      if (grandchild() !== undefined) abort.abort('user')
      else setTimeout(poll, 50)
    }
    poll()
    const jobId = '20261009T094000Z-cncl'
    const r = await runRefreshJob(d, req(jobId, abort.signal))
    expect(r).toMatchObject({ ok: false, cancelled: true, failure: { category: 'user_cancelled' } })
    expect(await readJobStatus(d.home, jobId)).toMatchObject({ state: 'cancelled' })
    const pid = Number(grandchild()?.['pid'])
    expect(pid).toBeGreaterThan(0)
    const deadline = Date.now() + 10_000
    while (isAlive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50))
    expect(isAlive(pid)).toBe(false)
    const start = refreshStart(readFakeLog(s.log))
    expect(isAlive(Number(start?.pid))).toBe(false)
  }, 60_000)

  it('stops a refresh that runs past its timeout', async () => {
    const s = scenario(hangScript())
    const d = await deps(s, { timeoutMs: 3_000 })
    const started = Date.now()
    const jobId = '20261009T095000Z-tout'
    const r = await runRefreshJob(d, req(jobId))
    expect(r).toMatchObject({
      ok: false,
      cancelled: false,
      failure: {
        category: 'timeout_hard',
        message: 'The price refresh took longer than 3 s, so Dim Factory stopped it.',
      },
    })
    expect(Date.now() - started).toBeLessThan(45_000)
    const start = refreshStart(readFakeLog(s.log))
    expect(isAlive(Number(start?.pid))).toBe(false)
    expect(await readJobStatus(d.home, jobId)).toMatchObject({ state: 'failed', category: 'timeout_hard' })
  }, 60_000)
})
