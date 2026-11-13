// Claude's Extensions levels through the real adapter and spawn path, against the fake CLI (a temp
// CLAUDE_CONFIG_DIR, never ~/.claude). Allowed list: `--strict-mcp-config --mcp-config <file>` where the file holds
// the allowed servers' definitions only (the others never reach the CLI), written 0600 in the run's scratch folder
// and gone once the process is; the session's skill allowlist goes in initialize. The servers' names, commands and
// env values never reach what Dim Factory writes down (the handle's argv, the spawn record, the raw log). None: today's
// read-only launch (no config file, no skill list).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import type { FakeSetup } from '../adapters/helpers.ts'
import { drive, fakeAdapter, fakeSetup, tempDir, terminals } from '../adapters/helpers.ts'
import { makeScenario } from '../run/scenario.ts'

let setup: FakeSetup
beforeAll(async () => {
  setup = await fakeSetup()
})

const SECRET = 'stand-in-secret-7f3a'
const SERVERS = {
  zeta_allowed: { command: 'node', args: ['zeta.js'], env: { ZETA_TOKEN: SECRET } },
  omega_other: { command: 'node', args: ['omega-cmd.js'] },
}
const NAMES = ['zeta_allowed', 'omega_other', 'zeta.js', 'omega-cmd.js', SECRET]

function claudeConfig(): string {
  const dir = tempDir('claude-config-')
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ primaryApiKey: 'sk-ant-api03-NOTREAD', mcpServers: SERVERS }),
  )
  mkdirSync(join(dir, 'skills', 'pdf'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n')
  return dir
}

const review = (cwd: string, o: Partial<StartOptions>): StartOptions => ({
  runId: 'run-ext',
  step: 'review',
  cwd,
  prompt: 'Review the change.',
  model: 'sonnet',
  mode: 'readonly',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

function recorder() {
  const raw: string[] = []
  const spawned: string[][] = []
  return {
    raw,
    spawned,
    tap: (dir: string, line: string): void => {
      raw.push(`${dir} ${line}`)
    },
    onSpawn: (_o: unknown, child: { argv: readonly string[] }): void => {
      spawned.push([...child.argv])
    },
  }
}

const mentions = (text: string): string[] => NAMES.filter((n) => text.includes(n))

describe('Claude: Allowed list', () => {
  it('the CLI sees only the allowed server, from a private file that is gone afterwards; names stay hidden', async () => {
    const sc = await makeScenario({
      review: [
        {
          recording: 'C02-review-shape',
          text: 'NO FINDINGS',
          prepend: [
            { op: 'expectArgs', includes: ['--strict-mcp-config', '--mcp-config'] },
            {
              op: 'expectFile',
              argvPath: '--mcp-config',
              json: {
                mcpServers: {
                  zeta_allowed: { command: 'node', args: ['zeta.js'], env: { ZETA_TOKEN: SECRET } },
                  omega_other: { $absent: true },
                },
              },
            },
          ],
        },
      ],
    })
    const scratch = tempDir('run-scratch-')
    const rec = recorder()
    const adapter = fakeAdapter(setup, { onSpawn: rec.onSpawn })
    const d = await drive(
      adapter,
      review(tempDir('claude-cwd-'), {
        env: { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfig() },
        extensions: { level: 'allowed', mcp: ['zeta_allowed'], skills: ['pdf'], scratchDir: scratch },
        tap: rec.tap,
      }),
      new Map(),
    )
    const log = sc.entries()
    expect(log.filter((e) => e.kind === 'error')).toEqual([])
    expect(log.some((e) => e.kind === 'expectFile' && e['ok'] === true)).toBe(true)
    expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    // The file was where the run keeps its private scratch files, and it is gone now.
    const argv = log.find((e) => e.kind === 'start' && (e['argv'] as string[]).includes('--mcp-config'))?.[
      'argv'
    ] as string[]
    const file = argv[argv.indexOf('--mcp-config') + 1] ?? ''
    expect(file.startsWith(scratch)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(scratch)).toEqual([])
    // initialize carried the session's skill allowlist.
    const init = log.find((e) => e.kind === 'stdin' && String(e['line']).includes('"initialize"'))
    expect(JSON.parse(String(init?.['line']))).toMatchObject({
      request: { subtype: 'initialize', skills: ['pdf'] },
    })
    // Nothing Dim Factory writes down names a server, a command or a secret.
    const handleArgv = (d.handle as unknown as { argv: string[] }).argv
    expect(mentions(handleArgv.join(' '))).toEqual([])
    expect(mentions(rec.spawned.flat().join(' '))).toEqual([])
    expect(mentions(rec.raw.join('\n'))).toEqual([])
    expect(rec.raw.some((l) => l.includes('[REDACTED]'))).toBe(true)
  }, 60_000)

  it('the file is private to the user (0600 where the OS has modes)', async () => {
    const sc = await makeScenario({
      review: [
        {
          recording: 'C02-review-shape',
          text: 'NO FINDINGS',
          // Holds the CLI at start, so the file can be looked at while the pass runs.
          prepend: [{ op: 'sleep', ms: 1500 }],
        },
      ],
    })
    const scratch = tempDir('run-scratch-')
    const adapter = fakeAdapter(setup)
    const seen: { mode: number }[] = []
    const watcher = setInterval(() => {
      for (const n of existsSync(scratch) ? readdirSync(scratch) : [])
        seen.push({ mode: statSync(join(scratch, n)).mode & 0o777 })
    }, 50)
    try {
      const d = await drive(
        adapter,
        review(tempDir('claude-cwd-'), {
          env: { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfig() },
          extensions: { level: 'allowed', mcp: ['zeta_allowed'], skills: [], scratchDir: scratch },
        }),
        new Map(),
      )
      expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    } finally {
      clearInterval(watcher)
    }
    expect(seen.length).toBeGreaterThan(0)
    if (process.platform !== 'win32') for (const s of seen) expect(s.mode).toBe(0o600)
    expect(readdirSync(scratch)).toEqual([])
  }, 60_000)

  it('no allowed server defined any more: strict MCP with no file at all', async () => {
    const sc = await makeScenario({
      review: [
        {
          recording: 'C02-review-shape',
          text: 'NO FINDINGS',
          prepend: [
            { op: 'expectArgs', includes: ['--strict-mcp-config'] },
            { op: 'expectFile', argvPath: '--mcp-config', absent: true },
          ],
        },
      ],
    })
    const scratch = tempDir('run-scratch-')
    const d = await drive(
      fakeAdapter(setup),
      review(tempDir('claude-cwd-'), {
        env: { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfig() },
        extensions: { level: 'allowed', mcp: ['gone_server'], skills: [], scratchDir: scratch },
      }),
      new Map(),
    )
    expect(sc.entries().filter((e) => e.kind === 'error')).toEqual([])
    expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    expect(readdirSync(scratch)).toEqual([])
  }, 60_000)
})

describe('Claude: None', () => {
  it("today's read-only launch: no config file and no skill list, whatever the allow list says", async () => {
    const sc = await makeScenario({
      review: [
        {
          recording: 'C02-review-shape',
          text: 'NO FINDINGS',
          prepend: [
            { op: 'expectArgs', includes: ['--strict-mcp-config'] },
            { op: 'expectFile', argvPath: '--mcp-config', absent: true },
          ],
        },
      ],
    })
    const scratch = tempDir('run-scratch-')
    const d = await drive(
      fakeAdapter(setup),
      review(tempDir('claude-cwd-'), {
        env: { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfig() },
        extensions: { level: 'none', mcp: ['zeta_allowed'], skills: ['pdf'], scratchDir: scratch },
      }),
      new Map(),
    )
    const log = sc.entries()
    expect(log.filter((e) => e.kind === 'error')).toEqual([])
    expect(terminals(d.entries)).toMatchObject([{ type: 'done' }])
    const init = log.find((e) => e.kind === 'stdin' && String(e['line']).includes('"initialize"'))
    expect((JSON.parse(String(init?.['line'])) as { request: object }).request).not.toHaveProperty('skills')
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([])
  }, 60_000)
})
