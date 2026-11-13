// Self-heal end to end on Claude (the healer is a read-only pass): the real Claude adapter spawns the fake CLI as
// the healer. The fake answers one fenced JSON block; its log shows the read-only argv (the read-only pass flags
// plus Bash, PowerShell, WebFetch and WebSearch disallowed, no session persistence), the heal folder as cwd, and a
// prompt that carries the
// stderr evidence but not the task. A second identical failure is served from heal/cache.json; a healer that never
// answers is stopped at the timeout.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Failure } from '../../../src/shared/failure.ts'
import { AdapterRegistry } from '../../../src/core/adapters/registry.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { HealRequest, HealerDeps } from '../../../src/core/heal/healer.ts'
import { readHealTail, runHealer } from '../../../src/core/heal/healer.ts'
import { LOCAL, STDIO, fakeAdapter, fakeSetup } from '../adapters/helpers.ts'

const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))

interface LogEntry {
  pid: number
  kind: string
  argv?: string[]
  cwd?: string
  line?: string
}

function scenario(healScript: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'heal-scenario-'))
  writeFileSync(
    join(dir, 'scenario.json'),
    JSON.stringify([
      { match: { argvIncludes: ['--version'] }, script: join(LOCAL, 'version.script.jsonl'), repeat: true },
      {
        match: { argvIncludes: ['auth', 'status'] },
        script: join(LOCAL, 'auth-status.script.jsonl'),
        repeat: true,
      },
      // Only the read-only route passes --permission-prompts (the probe handshake uses --permission-prompt-tool).
      { match: { argvIncludes: ['--permission-prompts'] }, script: join(HERE, healScript), repeat: true },
      {
        match: { argvIncludes: ['-p'] },
        script: join(STDIO, 'C16-probe-handshake', 'recording.jsonl'),
        repeat: true,
      },
    ]),
  )
  return { dir, log: join(dir, 'fake.log.jsonl') }
}

const readLog = (file: string): LogEntry[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LogEntry)

const same = (a: string, b: string): boolean => {
  const n = (p: string): string => realpathSync.native(p).toLowerCase()
  return n(a) === n(b)
}

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const failure: Failure = {
  category: 'unknown',
  message: 'claude exited with code 1',
  raw: "error: unknown option '--permission-mode'",
  classifiedBy: 'heuristic',
  step: 'review',
}

/** The failed Review's raw log: the prompt went in on stdin, the model streamed, then the CLI failed. */
function rawLog(home: string, runId: string): string {
  const file = homePaths(home).run(runId).raw('review', 1)
  const rec = (dir: string, line: unknown): string =>
    JSON.stringify({ t: 1, dir, line: typeof line === 'string' ? line : JSON.stringify(line) })
  const lines = [
    rec('in', { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } }),
    rec('in', {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Task:\nHEALTASKMARKER rename the greeting' }],
      },
    }),
    rec('out', { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'HEALPLANMARKER' } } }),
    rec('out', { type: 'user', message: { content: [{ type: 'tool_result', content: 'HEALBODYMARKER' }] } }),
    rec('err', "error: unknown option '--permission-mode'"),
  ]
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('self-heal on Claude (fake CLI)', () => {
  it('answers through a read-only, ephemeral Claude in the heal folder, then serves the cache', async () => {
    const setup = await fakeSetup()
    const s = scenario('heal-answer.script.jsonl')
    const adapter = fakeAdapter(setup, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } })
    const registry = new AdapterRegistry()
    registry.register(adapter)
    const home = process.env['DIM_FACTORY_HOME'] ?? mkdtempSync(join(tmpdir(), 'heal-home-'))
    const runId = 'r-heal-1'
    const tail = await readHealTail(rawLog(home, runId))
    expect(tail).toEqual(["stderr: error: unknown option '--permission-mode'"])

    const deps: HealerDeps = {
      home,
      registry,
      selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
    }
    const req: HealRequest = {
      runId,
      step: 'review',
      failure,
      trigger: 'auto',
      vendor: 'claude',
      vendorVersion: '2.1.289',
      passArgv: ['-p', '--permission-mode', 'dontAsk', '--model', 'sonnet'],
      tail,
    }
    const out = await runHealer(deps, req)
    expect(out.error).toBeUndefined()
    expect(out).toMatchObject({
      status: 'ok',
      diagnosis: 'The installed Claude Code renamed --permission-mode to --mode.',
      confidence: 'high',
      category: 'flag_drift',
      hidden: 1,
    })
    expect(out.actions).toEqual([
      expect.objectContaining({
        kind: 'config_patch',
        label: 'Use --mode instead of --permission-mode',
        target: 'resolved',
        ops: [{ op: 'add', path: '/vendors/claude/flagMap/--permission-mode', value: '--mode' }],
        persist: { scope: 'user' },
      }),
      expect.objectContaining({ kind: 'shell_copy', command: 'claude update', recheck: 'vendor.claude.bin' }),
    ])

    const log = readLog(s.log)
    const healStart = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    expect(healStart).toBeDefined()
    const argv = healStart?.argv ?? []
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--permission-prompts')).toBe('none')
    expect(flagValue(argv, '--settings')).toBe('{"disableAllHooks":true}')
    expect(flagValue(argv, '--model')).toBe('sonnet')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).not.toContain('--permission-prompt-tool')
    expect(argv.some((a) => a.startsWith('--session-id') || a.startsWith('--resume'))).toBe(false)
    expect((flagValue(argv, '--disallowedTools') ?? '').split(',').sort()).toEqual(
      [
        'AskUserQuestion',
        'Bash',
        'Edit',
        'Monitor',
        'NotebookEdit',
        'PowerShell',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    )
    expect(argv).not.toContain('--allowedTools')
    expect(same(healStart?.cwd ?? '', homePaths(home).run(runId).healDir)).toBe(true)

    // What the healer was told: the evidence, never the task, plan or file body.
    const stdin = log.filter((e) => e.pid === healStart?.pid && e.kind === 'stdin').map((e) => e.line ?? '')
    const user = stdin
      .map((l) => JSON.parse(l) as { type?: string; message?: { content?: { text?: string }[] } })
      .find((f) => f.type === 'user')
    const prompt = user?.message?.content?.[0]?.text ?? ''
    expect(prompt).toContain("You are Dim Factory's environment diagnostician.")
    expect(prompt).toContain("stderr: error: unknown option '--permission-mode'")
    expect(prompt).toContain('Pass config: argv: -p --permission-mode dontAsk --model sonnet')
    for (const marker of ['HEALTASKMARKER', 'HEALPLANMARKER', 'HEALBODYMARKER'])
      expect(prompt).not.toContain(marker)

    // The same failure again: heal/cache.json answers, nothing is spawned.
    const heals = (): number =>
      readLog(s.log).filter((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts')).length
    const again = await runHealer(deps, { ...req, trigger: 'user' })
    expect(again.status).toBe('cached')
    expect(again.diagnosis).toBe(out.diagnosis)
    expect(again.actions.map((a) => a.kind)).toEqual(['config_patch', 'shell_copy'])
    expect(heals()).toBe(1)
    const cache = JSON.parse(readFileSync(homePaths(home).healCache, 'utf8')) as {
      schemaVersion: number
      entries: Record<string, { healer: string }>
    }
    expect(cache.schemaVersion).toBe(1)
    expect(Object.values(cache.entries).map((e) => e.healer)).toEqual(['claude'])
  })

  it('stops a healer that never answers and fails with the install docs', async () => {
    const setup = await fakeSetup()
    const s = scenario('heal-hang.script.jsonl')
    const adapter = fakeAdapter(setup, { vendorEnv: { FAKE_CLI_SCRIPT: s.dir, FAKE_CLI_LOG: s.log } })
    const registry = new AdapterRegistry()
    registry.register(adapter)
    const home = process.env['DIM_FACTORY_HOME'] ?? mkdtempSync(join(tmpdir(), 'heal-home-'))
    const started = Date.now()
    const out = await runHealer(
      {
        home,
        registry,
        selfHeal: { enabled: true, vendor: 'claude', model: null, autoApplyConfigPatches: false },
        isReady: () => Promise.resolve(true),
        cache: null,
        timeoutMs: 3_000,
      },
      {
        step: 'probe',
        failure: {
          category: 'unknown',
          message: 'claude exited with code 1',
          raw: '',
          classifiedBy: 'heuristic',
        },
        trigger: 'user',
        vendor: 'claude',
        vendorVersion: '2.1.289',
        passArgv: [],
        tail: ['stderr: something odd'],
      },
    )
    expect(out.status).toBe('failed')
    expect(out.error).toBe('The diagnosis took longer than 3 s, so Dim Factory stopped it.')
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'open_docs', url: 'https://code.claude.com/docs/en/setup' }),
    ])
    // The fake was stopped long before its two-minute sleep ended; it ran in a run-less heal folder.
    expect(Date.now() - started).toBeLessThan(60_000)
    const log = readLog(s.log)
    const start = log.find((e) => e.kind === 'start' && e.argv?.includes('--permission-prompts'))
    expect(start?.cwd?.toLowerCase()).toContain(join('tmp', 'heal').toLowerCase())
  })
})
