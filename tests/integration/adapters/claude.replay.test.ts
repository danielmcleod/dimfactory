// The real Claude adapter (start / answer / stop → proc/spawn → resolved .cmd shim or shebang launcher) against
// the fake CLI replaying each recording. The fake deep-compares every stdin frame with the recorded one (ids
// masked) and exits 99 on a mismatch; the test also re-checks the fake's stdin log and compares the adapter's
// output with the pure normalizer's view of the same recording.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeRecording } from '../../../src/core/adapters/claude/normalize.ts'
import type { Usage } from '../../../src/shared/events.ts'
import { readFakeLog } from '../../fake-cli/harness.ts'
import type { FakeLogEntry } from '../../fake-cli/harness.ts'
import { isAlive } from '../../../src/core/proc/ps.ts'
import type { FakeSetup } from './helpers.ts'
import {
  STDIO,
  drive,
  fakeAdapter,
  fakeSetup,
  hermeticEnv,
  loadRecording,
  recordingIds,
  startOptionsFor,
  tempDir,
  terminals,
  withoutLiveness,
} from './helpers.ts'

type CompareRecorded = (
  expected: unknown,
  actual: unknown,
  o?: { normalize?: (s: string) => string },
) => unknown[]
let compareRecorded: CompareRecorded

/**
 * C05c/C05d record a host that skips initialize; the adapter always sends it (C05 decision). C16 and C22a-C22c are
 * initialize-only sessions (the probe, the connector listing), never a pass (tests/integration/extensions/
 * claude-connectors.test.ts drives the listing). C23a sends `/compact` as a second user message, which a pass never does
 * (its frames are checked through the normalizer; C23s is its compaction inside one turn). C24a does the same with the
 * post-compaction reminder's hook registered (claude.compaction-reminder.test.ts drives the adapter's answers).
 */
const NOT_REPLAYABLE = new Set([
  'C05c-noinit-host',
  'C05d-noinit-nohost',
  'C16-probe-handshake',
  'C22a-connectors-listed',
  'C22b-connectors-strict-none',
  'C22c-connector-explicit-strict',
  'C23a-compact-manual',
  'C24a-compaction-reminder',
])
const STOPPED = new Set(['C10a-interrupt-then-close'])
/** C09c: the adapter stops at the second 401 retry; the fake may or may not finish writing first. */
const MAY_BE_CUT = new Set(['C09c-invalid-api-key'])
/** C10b has a script variant below; its recording ends with a tree kill the replay cannot reproduce. */
const SCRIPTED = new Set(['C10b-taskkill-tree'])

const replayIds = recordingIds().filter((id) => !NOT_REPLAYABLE.has(id) && !SCRIPTED.has(id))

let setup: FakeSetup
const priorUsage = new Map<string, Usage>()

beforeAll(async () => {
  setup = await fakeSetup()
  const mod = (await import(pathToFileURL(setup.build.entry).href)) as { compareRecorded: CompareRecorded }
  compareRecorded = mod.compareRecorded
})

function stdinLines(log: readonly FakeLogEntry[]): string[] {
  const start = log.find(
    (e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('-p'),
  )
  return log.filter((e) => e.kind === 'stdin' && e.pid === start?.pid).map((e) => String(e['line']))
}

function argvOf(log: readonly FakeLogEntry[]): string[] {
  const start = log.find(
    (e) => e.kind === 'start' && Array.isArray(e['argv']) && (e['argv'] as string[]).includes('-p'),
  )
  return (start?.['argv'] as string[] | undefined) ?? []
}

describe('claude adapter: recording replay', () => {
  it.each(replayIds)('%s', async (id) => {
    const rec = loadRecording(id)
    const cwd = tempDir('claude-cwd-')
    const log = join(tempDir('claude-log-'), 'fake.log')
    const adapter = fakeAdapter(setup)
    const base = id === 'C08b-resume-fix' ? priorUsage.get('C08a-session-id-implement') : undefined
    // C08b continues C08a's session: without C08a's totals the delta below would not be checked at all.
    if (id === 'C08b-resume-fix') expect(base, 'C08a must replay first and record its totals').toBeDefined()
    // The recorder gave C09c's CLI ANTHROPIC_API_KEY (an invalid one), so the adapter runs with one too, and
    // its auth failure names the variable as the pure normalizer does from the header's envKeys.
    const apiKey = (rec.header['envKeys'] as unknown[] | undefined)?.includes('ANTHROPIC_API_KEY') === true
    const o = startOptionsFor(rec, {
      cwd,
      env: {
        FAKE_CLI_SCRIPT: rec.path,
        FAKE_CLI_LOG: log,
        ...(apiKey ? { ANTHROPIC_API_KEY: 'fake-invalid-key' } : {}),
      },
      priorUsage: base,
    })
    // C23b recorded the context breakdown requests a pass sends with StartOptions.contextBreakdown.
    if (rec.inLines.some((l) => l.includes('get_context_usage'))) o.contextBreakdown = true
    const { handle, entries, exit } = await drive(adapter, o, rec.decisions, {
      ...(STOPPED.has(id) ? { stopAfterAnswer: 'user' as const } : {}),
    })
    if (id === 'C08a-session-id-implement') priorUsage.set(id, handle.cumulativeUsage()!)
    if (id === 'C08b-resume-fix') {
      const done = entries.find((e) => e.type === 'done')
      expect(done).toMatchObject({ usage: { input: 4, output: 231, cacheRead: 51887, cacheWrite: 415 } })
      expect((done as { usage: { costUsd: number } }).usage.costUsd).toBeCloseTo(0.0143554, 6)
    }

    // Inputs: the fake matched every recorded stdin frame (exit 99/98 otherwise) and saw nothing extra.
    const fakeLog = readFakeLog(log)
    const sent = stdinLines(fakeLog)
    const why = readFileSync(log, 'utf8').slice(-2000)
    if (MAY_BE_CUT.has(id)) expect([97, 98, 99], why).not.toContain(exit.code)
    else {
      expect(exit.code, why).toBe(rec.exit?.code)
      expect(sent).toHaveLength(rec.inLines.length)
    }
    sent.forEach((line, i) => {
      const expected = rec.inLines[i]
      if (expected === undefined) return
      expect(compareRecorded(JSON.parse(expected), JSON.parse(line)), `stdin #${i}`).toEqual([])
    })

    // argv: per-pass flags, never the prompt, --resume without --session-id.
    const argv = argvOf(fakeLog)
    expect(argv.slice(0, 7)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
    if (rec.prompt !== undefined) expect(argv.join(' ')).not.toContain(rec.prompt)
    if (o.resume !== undefined) {
      expect(argv).toContain(`--resume=${o.resume.sessionId}`)
      expect(argv.some((a) => a.startsWith('--session-id'))).toBe(false)
    }

    // Output: exactly what the pure normalizer makes of the recording.
    const expected = withoutLiveness(
      normalizeRecording(rec.text, {
        ...(o.resume?.priorUsage !== undefined ? { priorUsage: o.resume.priorUsage } : {}),
        resumed: o.resume !== undefined,
      }),
    )
    if (MAY_BE_CUT.has(id)) expect(terminals(entries)).toEqual(terminals(expected))
    else expect(withoutLiveness(entries)).toEqual(expected)
    expect(terminals(entries)).toHaveLength(1)
    expect(handle.pendingAsks()).toEqual([])
  })

  it('C08a recorded the session totals C08b subtracts', () => {
    expect(priorUsage.get('C08a-session-id-implement')).toMatchObject({ input: 4, output: 191 })
  })

  it('a resume on a route that cannot resume is ignored: fresh argv, no subtraction, a meta warning', async () => {
    const rec = loadRecording('C02-review-shape')
    const log = join(tempDir('claude-log-'), 'fake.log')
    const adapter = fakeAdapter(setup)
    const o = {
      ...startOptionsFor(rec, { cwd: tempDir(), env: { FAKE_CLI_SCRIPT: rec.path, FAKE_CLI_LOG: log } }),
      resume: { sessionId: 'old-session', priorUsage: { input: 1e9, output: 1e9, costUsd: 99 } },
    }
    expect(o.step).toBe('review')
    const { entries, exit } = await drive(adapter, o, rec.decisions)
    expect(exit.code).toBe(rec.exit?.code)
    expect(argvOf(readFakeLog(log)).some((a) => a.startsWith('--resume'))).toBe(false)
    expect(entries).toContainEqual(expect.objectContaining({ type: 'meta', key: 'resumeIgnored' }))
    const fresh = normalizeRecording(rec.text).find((e) => e.type === 'done')
    expect(entries.find((e) => e.type === 'done')).toEqual(fresh)
    expect(entries.some((e) => e.type === 'meta' && e.key === 'usageApprox')).toBe(false)
  })

  it('C10a: stop() sends interrupt, waits for the result and classifies a user stop', async () => {
    const rec = loadRecording('C10a-interrupt-then-close')
    const adapter = fakeAdapter(setup)
    const o = startOptionsFor(rec, { cwd: tempDir(), env: { FAKE_CLI_SCRIPT: rec.path } })
    const { entries, exit } = await drive(adapter, o, rec.decisions, { stopAfterAnswer: 'user' })
    expect(exit).toMatchObject({ code: 1, stoppedBy: 'user', sawTerminal: true })
    expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'user_cancelled', fatal: true }])
  })
})

describe('claude adapter: stop escalation (C10b script)', () => {
  const script = join(STDIO, 'C10b-taskkill-tree', 'script.jsonl')

  it.each(['user', 'timeout'] as const)(
    'stop(%s) closes stdin, then kills the tree',
    async (reason) => {
      const rec = loadRecording('C10b-taskkill-tree')
      const log = join(tempDir('claude-log-'), 'fake.log')
      const adapter = fakeAdapter(setup, { timing: { stopResultMs: 300, stopStdinMs: 300 } })
      const o = startOptionsFor(rec, { cwd: tempDir(), env: { FAKE_CLI_SCRIPT: script, FAKE_CLI_LOG: log } })
      // Stop once the CLI has started its grandchild (the script spawns it after the allowed tool call), so the tree
      // kill always has a grandchild to take down; stopping right after the answer raced the fake's own pace.
      let stopped: Promise<void> | undefined
      const hasGrandchild = (): boolean => {
        try {
          return readFakeLog(log).some((e) => e.kind === 'grandchild')
        } catch {
          return false
        }
      }
      const { entries, exit } = await drive(adapter, o, rec.decisions, {
        onStart: (h) => {
          const poll = (): void => {
            if (hasGrandchild()) stopped = adapter.stop(h, reason)
            else setTimeout(poll, 50)
          }
          poll()
        },
      })
      expect(exit.stoppedBy).toBe(reason)
      expect(exit.sawTerminal).toBe(false)
      expect(terminals(entries)).toMatchObject([
        { type: 'error', category: reason === 'user' ? 'user_cancelled' : 'timeout_hard' },
      ])
      // The root can exit (taskkill reaches it first) before the tree kill is over; stop() settles after it.
      // Under a loaded machine the process snapshots and taskkill take seconds, so no wall-clock bound here.
      expect(stopped).toBeDefined()
      await stopped
      const grandchild = readFakeLog(log).find((e) => e.kind === 'grandchild')
      expect(grandchild).toBeDefined()
      const pid = Number(grandchild?.['pid'])
      const deadline = Date.now() + 5000
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(isAlive(pid)).toBe(false)
    },
    60_000,
  )
})

describe('claude adapter: spawn hook', () => {
  it('reports the process after spawn and before the first stdin write', async () => {
    const rec = loadRecording('C01-plain-text')
    const log = join(tempDir('claude-log-'), 'fake.log')
    const calls: { pid: number; argv: readonly string[]; stdinSoFar: number }[] = []
    const adapter = fakeAdapter(setup, {
      onSpawn: (_o, child) => {
        calls.push({ pid: child.pid, argv: child.argv, stdinSoFar: stdinLines(readFakeLog(log)).length })
      },
    })
    const o = startOptionsFor(rec, { cwd: tempDir(), env: { FAKE_CLI_SCRIPT: rec.path, FAKE_CLI_LOG: log } })
    const { handle, exit } = await drive(adapter, o, rec.decisions)
    expect(exit.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.pid).toBe(handle.pid)
    expect(calls[0]!.stdinSoFar).toBe(0)
    expect(calls[0]!.argv).toContain('--permission-mode')
  })
})

describe('claude adapter: failure paths', () => {
  it('an unanswered initialize is flag drift and the process is killed', async () => {
    const dir = tempDir()
    const script = join(dir, 'silent.script.jsonl')
    writeFileSync(
      script,
      [
        JSON.stringify({
          op: 'expectStdin',
          match: { type: 'control_request', request: { subtype: 'initialize' } },
        }),
        JSON.stringify({ op: 'sleep', ms: 30000 }),
        JSON.stringify({ op: 'exit', code: 0 }),
      ].join('\n'),
    )
    const adapter = fakeAdapter(setup, { timing: { initializeMs: 300 } })
    const { entries, exit } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'implement',
        cwd: dir,
        prompt: 'hi',
        mode: 'autoedit',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
        env: { FAKE_CLI_SCRIPT: script },
      },
      new Map(),
    )
    expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'flag_drift', fatal: true }])
    expect(exit.sawTerminal).toBe(false)
  })

  it('an initialize error reply fails the pass as flag drift and never sends the prompt', async () => {
    const dir = tempDir()
    const script = join(dir, 'init-error.script.jsonl')
    const log = join(dir, 'fake.log')
    writeFileSync(
      script,
      [
        {
          op: 'expectStdin',
          match: { type: 'control_request', request: { subtype: 'initialize', appendSystemPrompt: 'rules' } },
          capture: { rid: 'request_id' },
        },
        {
          op: 'stdout',
          json: {
            type: 'control_response',
            response: { subtype: 'error', request_id: '$rid', error: 'Unknown field: appendSystemPrompt' },
          },
        },
        { op: 'sleep', ms: 30000 },
        { op: 'exit', code: 0 },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    )
    const adapter = fakeAdapter(setup)
    const { entries, exit } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'implement',
        cwd: dir,
        prompt: 'the secret task',
        systemAppend: 'rules',
        mode: 'autoedit',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
        env: { FAKE_CLI_SCRIPT: script, FAKE_CLI_LOG: log },
      },
      new Map(),
    )
    expect(terminals(entries)).toMatchObject([
      {
        type: 'error',
        category: 'flag_drift',
        fatal: true,
        message: expect.stringContaining('Unknown field: appendSystemPrompt') as unknown,
      },
    ])
    expect(exit.sawTerminal).toBe(true)
    expect(stdinLines(readFakeLog(log)).join('\n')).not.toContain('the secret task')
  })

  it('a missing working folder is folder_guard, not "Claude Code is not installed"', async () => {
    const adapter = fakeAdapter(setup)
    const cwd = join(tempDir(), 'deleted-worktree')
    const { entries, handle } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'implement',
        cwd,
        prompt: 'hi',
        mode: 'autoedit',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
      },
      new Map(),
    )
    expect(handle.pid).toBeUndefined()
    expect(terminals(entries)).toMatchObject([
      { type: 'error', category: 'folder_guard', message: expect.stringContaining(cwd) as unknown },
    ])
  })

  it('stop() before the process exists ends the attempt without spawning', async () => {
    const adapter = fakeAdapter(setup)
    const { entries, exit, handle } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'review',
        cwd: tempDir(),
        prompt: 'hi',
        mode: 'readonly',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
      },
      new Map(),
      { onStart: (h) => void adapter.stop(h, 'user') },
    )
    expect(handle.pid).toBeUndefined()
    expect(exit).toMatchObject({ code: null, stoppedBy: 'user' })
    expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'user_cancelled' }])
  })

  it('managed flags in extraArgs fail the pass before spawning', async () => {
    const adapter = fakeAdapter(setup)
    const { entries, handle } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'implement',
        cwd: tempDir(),
        prompt: 'hi',
        mode: 'autoedit',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
        extraArgs: ['--permission-mode', 'bypassPermissions'],
      },
      new Map(),
    )
    expect(handle.pid).toBeUndefined()
    expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'config_invalid' }])
  })

  it('a missing CLI is cli_missing', async () => {
    const adapter = fakeAdapter(setup, {
      resolve: () => Promise.resolve({ ok: false, rejected: [], candidates: [] }),
    })
    const { entries } = await drive(
      adapter,
      {
        runId: 'r',
        step: 'implement',
        cwd: tempDir(),
        prompt: 'hi',
        mode: 'autoedit',
        planNative: false,
        allowRules: [],
        askTimeoutMs: 1000,
        trustFolder: false,
      },
      new Map(),
    )
    expect(terminals(entries)).toMatchObject([{ type: 'error', category: 'cli_missing' }])
  })
})

describe('claude adapter: probe (C16)', () => {
  it('resolves the shim, reads auth, and handshakes without a user message', async () => {
    const log = join(tempDir('claude-log-'), 'fake.log')
    const adapter = fakeAdapter(setup, { vendorEnv: { FAKE_CLI_LOG: log } })
    const r = await adapter.probe()
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['vendor.claude.bin', 'pass'],
      ['vendor.claude.version', 'pass'],
      ['vendor.claude.auth', 'pass'],
      ['vendor.claude.env', 'pass'],
      ['vendor.claude.protocol', 'pass'],
      ['vendor.claude.plan', 'pass'],
    ])
    expect(r).toMatchObject({
      ok: true,
      version: '2.1.289',
      route: 'stdio',
      account: { method: 'claude.ai', plan: 'max' },
    })
    expect(r.binary?.source).toBe('config')
    expect(r.models.map((m) => m.id)).toContain('sonnet')
    expect(r.models).toHaveLength(12)
    const fake = readFakeLog(log)
    const sent = stdinLines(fake)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'initialize' },
    })
    // C16's flags: the stream and host flags every pass relies on, so a renamed flag fails the probe too.
    expect(argvOf(fake)).toEqual(
      expect.arrayContaining(['--include-partial-messages', '--permission-prompt-tool']),
    )
    expect(JSON.stringify(r)).not.toMatch(/example\.invalid|REDACTED/)
    // Cached per launch; force re-runs.
    expect(await adapter.probe()).toBe(r)
    await expect(adapter.listModels()).resolves.toHaveLength(12)
  })

  it('warns when ANTHROPIC_API_KEY would override the reported login', async () => {
    const adapter = fakeAdapter(setup, { env: hermeticEnv({ ANTHROPIC_API_KEY: 'not-a-real-key' }) })
    const r = await adapter.probe()
    expect(r.checks.find((c) => c.id === 'vendor.claude.env')).toMatchObject({ status: 'warn' })
  })

  it('applies the vendor flagMap and extraArgs to the handshake', async () => {
    const log = join(tempDir('claude-log-'), 'fake.log')
    const adapter = fakeAdapter(setup, {
      vendorEnv: { FAKE_CLI_LOG: log },
      flagMap: { '--permission-prompt-tool': '--permission-tool' },
      extraArgs: ['--max-turns', '3'],
    })
    const r = await adapter.probe()
    expect(r.checks.find((c) => c.id === 'vendor.claude.protocol')?.status).toBe('pass')
    const argv = argvOf(readFakeLog(log))
    expect(argv).toContain('--permission-tool')
    expect(argv).not.toContain('--permission-prompt-tool')
    expect(argv.slice(-2)).toEqual(['--max-turns', '3'])
  })

  it('a flagMap that escalates fails the protocol check without spawning a handshake', async () => {
    const log = join(tempDir('claude-log-'), 'fake.log')
    const adapter = fakeAdapter(setup, {
      vendorEnv: { FAKE_CLI_LOG: log },
      flagMap: { '--disallowedTools': '--allowedTools' },
    })
    const r = await adapter.probe()
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.id === 'vendor.claude.protocol')).toMatchObject({
      status: 'fail',
      category: 'config_invalid',
    })
    expect(argvOf(readFakeLog(log))).toEqual([])
  })
})
