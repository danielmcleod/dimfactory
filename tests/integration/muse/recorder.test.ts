// scripts/record-fixture.mjs, Muse mode (tests/fixtures/muse/README.md "Re-recording live"):
// each generated recipe (tests/fixtures/muse/recipes/<ID>/prompt.md, pass.json) is recorded against the fake CLI
// replaying that scenario's fixture, which checks the prompt file the recipe names. A recipe that records cleanly and
// gives back the fixture's frames drives the real CLI the way Dim Factory does, for the live re-record. A recording made
// with personal values (the provider's request ids, plugin and MCP server names, the key) keeps none of them, and the
// recorded CLI never inherits META_* / MUSE_*.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import { redactMuseValue } from '../../../scripts/redact-muse.mjs'
import { fakeEnv, readFakeLog } from '../../fake-cli/harness.ts'
import { MUSE_FIXTURES, fixtureIds, loadFixture, tempDir } from './helpers.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const RECIPES = join(MUSE_FIXTURES, 'recipes')
const build = await buildFakeCli()
const NODE = build.launchers.node.muse[0]
const ENTRY: string =
  build.launchers.node.muse[1] ??
  ((): never => {
    throw new Error('the fake muse has no node entry')
  })()

function runRecorder(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECORD, ...args], {
      env: fakeEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function readRecording(dir: string): {
  header: Record<string, unknown>
  frames: Record<string, unknown>[]
  text: string
} {
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { header: header!, frames, text }
}

const withoutTime = (frames: Record<string, unknown>[]): Record<string, unknown>[] =>
  frames.map(({ t: _t, ...rest }) => rest)

function keyFile(value: string): string {
  const file = join(tempDir('muse-key-'), 'muse.env')
  writeFileSync(file, `META_API_KEY=${value}\n`)
  return file
}

describe('Muse recipes record cleanly against the replayed fixtures', () => {
  it.each(fixtureIds())('%s', async (id) => {
    const f = loadFixture(id)
    const recipe = join(RECIPES, id)
    const out = tempDir('muse-rec-')
    const argv = f.header.argv.slice(1).map((a) => (a === '<PROMPT_FILE>' ? join(recipe, 'prompt.md') : a))
    const r = await runRecorder(
      [
        '--muse',
        '--muse-home',
        tempDir('muse-home-'),
        '--bin',
        NODE,
        '--entry',
        ENTRY,
        '--cwd',
        tempDir('muse-sandbox-'),
        '--out',
        out,
        '--id',
        id.slice(0, 3),
        '--slug',
        id.slice(4),
        '--cli-version',
        '1.4.2',
        '--timing',
        'off',
        '--env-file',
        keyFile('mk-recorder-secret-0001'),
        '--pass-file',
        join(recipe, 'pass.json'),
        '--timeout',
        '60000',
        '--',
        ...argv,
      ],
      { FAKE_CLI_SCRIPT: f.recording },
    )
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const rec = readRecording(out)
    expect(rec.header).toMatchObject({
      vendor: 'muse',
      route: 'exec',
      scenario: id,
      cliVersion: '1.4.2',
      argv: f.header.argv,
      envKeys: ['APPDATA', 'HOME', 'LOCALAPPDATA', 'META_API_KEY', 'USERPROFILE', 'XDG_CONFIG_HOME'],
      envDrop: ['^META_', '^MUSE_'],
      pass: f.header.pass,
    })
    // The same frames as the fixture: the prompt file first, the stdin close, every record, the exit. stdout and
    // stderr are two pipes, so their interleaving is the OS's: each side is compared on its own.
    const of = (frames: Record<string, unknown>[], dir: string) =>
      withoutTime(frames.filter((x) => x['dir'] === dir))
    for (const dir of ['out', 'err', 'eof', 'exit']) expect(of(rec.frames, dir)).toEqual(of(f.frames, dir))
    expect(withoutTime(rec.frames.slice(0, 2))).toEqual(withoutTime(f.frames.slice(0, 2)))
    expect(rec.frames.at(-1)).toMatchObject({ dir: 'exit' })
    expect(rec.frames).toHaveLength(f.frames.length)
    expect(rec.text).not.toContain('mk-recorder-secret-0001')
  })
})

describe('Muse recordings keep nothing personal', () => {
  const personal = [
    JSON.stringify({
      schema_version: 1,
      id: '0199d2a0-4c21-7d00-8000-000000000001',
      stream: { kind: 'session', id: '0199d2a0-4c1e-7a3b-8d5f-6e7a8b9c0f09' },
      sequence: 1,
      recorded_at: 1,
      record_type: 'event',
      durability: 'durable',
      causation_id: 'c',
      payload_type: 'task.lifecycle.status',
      payload: {
        kind: 'task_lifecycle',
        task_id: 't',
        event: {
          kind: 'status',
          task_id: 't',
          message: 'ok',
          details: {
            phase: 'stream_succeeded',
            facets: [
              {
                kind: 'producer',
                detail: {
                  kind: 'provider',
                  provider: 'meta',
                  request_id: 'req-private-7731',
                  response_id: 'resp_private_42',
                },
              },
            ],
          },
        },
      },
    }),
    JSON.stringify({
      payload_type: 'task.lifecycle.proposed',
      payload: {
        event: {
          kind: 'proposed',
          task_id: 'u',
          task_kind: 'reminder.agent.plugin:acme-private:skill-reminder',
        },
      },
    }),
    JSON.stringify({
      payload_type: 'task.lifecycle.proposed',
      payload: { event: { kind: 'proposed', task_id: 'v', task_kind: 'tool.mcp__corpdb__query' } },
    }),
  ]
  const script = (museHome: string) => [
    ...personal.map((line) => ({ op: 'stdout', line })),
    { op: 'stderr', line: 'warning: MCP tool mcp__corpdb__query timed out' },
    // What the isolated profile names, as Muse might print it.
    {
      op: 'stderr',
      line: `loaded MCP server corpwiki (C:/corp/tools/wiki-mcp.exe, token wk-secret-123456) and plugin acme-internal-kit from ${join(museHome, '.config', 'muse', 'settings.json')}`,
    },
    { op: 'exit', code: 0 },
  ]
  /** An isolated home with a profile of its own (an MCP server, a plugin, a remembered permission profile). */
  const profileHome = (dir: string): string => {
    const museHome = join(dir, 'mhome')
    mkdirSync(join(museHome, '.config', 'muse'), { recursive: true })
    writeFileSync(
      join(museHome, '.config', 'muse', 'settings.json'),
      JSON.stringify({
        schema_version: 1,
        permissions: { default_profile: 'unrestricted' },
        mcp_servers: {
          corpwiki: {
            command: 'C:/corp/tools/wiki-mcp.exe',
            args: ['--tenant', 'acme-tenant-77'],
            env: { WIKI_TOKEN: 'wk-secret-123456' },
          },
        },
        plugins: { 'acme-internal-kit': { source: 'https://git.acme.example/kit.git' } },
      }),
    )
    return museHome
  }

  it('redacts the provider ids, plugin and MCP server names; the key and inherited META_*/MUSE_* never reach the CLI', async () => {
    const dir = tempDir('muse-personal-')
    const museHome = profileHome(dir)
    const scriptFile = join(dir, 'personal.script.jsonl')
    writeFileSync(
      scriptFile,
      `${script(museHome)
        .map((o) => JSON.stringify(o))
        .join('\n')}\n`,
    )
    const prompt = join(dir, 'prompt.md')
    writeFileSync(prompt, 'Say hello.\n')
    const log = join(dir, 'fake.log')
    const out = join(dir, 'out')
    const r = await runRecorder(
      [
        '--muse',
        '--muse-home',
        museHome,
        '--bin',
        NODE,
        '--entry',
        ENTRY,
        '--cwd',
        dir,
        '--out',
        out,
        '--id',
        'MX1',
        '--slug',
        'personal',
        '--timing',
        'off',
        '--env-file',
        keyFile('mk-file-key-9'),
        '--',
        'exec',
        '--json',
        '--prompt-file',
        prompt,
        '--trust-workspace',
        '--disable-approval',
      ],
      {
        FAKE_CLI_SCRIPT: scriptFile,
        FAKE_CLI_LOG: log,
        FAKE_CLI_LOG_ENV:
          'META_API_KEY,MUSE_TRANSPORT_TRACE,META_ORG,HOME,USERPROFILE,XDG_CONFIG_HOME,APPDATA,LOCALAPPDATA',
        META_API_KEY: 'mk-shell-key-1',
        META_ORG: 'acme',
        MUSE_TRANSPORT_TRACE: '1',
      },
    )
    expect(r.code).toBe(0)
    const rec = readRecording(out)
    for (const secret of [
      'req-private-7731',
      'resp_private_42',
      'acme-private',
      'corpdb',
      'mk-file-key-9',
      'mk-shell-key-1',
      // What the isolated profile's settings name, and the profile folder itself.
      'corpwiki',
      'wiki-mcp.exe',
      'wk-secret-123456',
      'acme-internal-kit',
      museHome,
      museHome.replace(/\\/g, '/'),
    ])
      expect(rec.text).not.toContain(secret)
    expect(rec.text).toContain('<MUSE_HOME>')
    expect(rec.frames[0]).toEqual({
      t: 0,
      dir: 'promptFile',
      argvPath: '--prompt-file',
      content: 'Say hello.\n',
    })
    expect(rec.frames[1]).toMatchObject({ dir: 'eof' })
    expect(rec.header['argv']).toEqual([
      'muse',
      'exec',
      '--json',
      '--prompt-file',
      '<PROMPT_FILE>',
      '--trust-workspace',
      '--disable-approval',
    ])
    // Every recorded record is a fixed point of the Muse rules.
    for (const f of rec.frames.filter((x) => x['dir'] === 'out')) {
      const value = JSON.parse(f['line'] as string) as unknown
      expect(redactMuseValue(value).value).toEqual(value)
    }
    // The CLI saw the file's key only, and none of the recorder's own META_* / MUSE_*.
    const start = readFakeLog(log).find((e) => e['kind'] === 'start')
    expect(start?.['env']).toEqual({
      META_API_KEY: 'mk-file-key-9',
      MUSE_TRANSPORT_TRACE: null,
      META_ORG: null,
      // Muse's home is the isolated folder (it loads that profile's ~/.config/muse, not the everyday one).
      HOME: museHome,
      USERPROFILE: museHome,
      XDG_CONFIG_HOME: join(museHome, '.config'),
      APPDATA: join(museHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(museHome, 'AppData', 'Local'),
    })
    expect(rec.header['envKeys']).toEqual([
      'APPDATA',
      'HOME',
      'LOCALAPPDATA',
      'META_API_KEY',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
    ])
    const summary = JSON.parse(r.stdout) as { redactions: Record<string, number> }
    expect(summary.redactions).toMatchObject({ 'muse-provider-id': 2 })
    expect(summary.redactions['museHome']).toBeGreaterThan(0)
  })

  it('refuses a Muse recording without a prompt file, and --vendor muse without --muse', async () => {
    const dir = tempDir('muse-refuse-')
    const base = [
      '--muse-home',
      tempDir('muse-home-'),
      '--bin',
      NODE,
      '--entry',
      ENTRY,
      '--cwd',
      dir,
      '--out',
      join(dir, 'out'),
      '--id',
      'MX2',
      '--slug',
      'x',
    ]
    const noPrompt = await runRecorder(['--muse', ...base, '--', 'exec', '--json', '--disable-approval'])
    expect(noPrompt.code).toBe(2)
    expect(noPrompt.stderr).toContain('--prompt-file')
    const noMode = await runRecorder(['--vendor', 'muse', '--route', 'exec', ...base, '--', 'exec', '--json'])
    expect(noMode.code).toBe(2)
    expect(noMode.stderr).toContain('--muse')
  })

  it('--muse-home is required, never the everyday home, never a settings folder, only for --muse', async () => {
    const dir = tempDir('muse-home-refuse-')
    const prompt = join(dir, 'prompt.md')
    writeFileSync(prompt, 'Say hello.\n')
    const rest = [
      '--bin',
      NODE,
      '--entry',
      ENTRY,
      '--cwd',
      dir,
      '--out',
      join(dir, 'out'),
      '--id',
      'MX3',
      '--slug',
      'x',
    ]
    const argv = ['--', 'exec', '--json', '--prompt-file', prompt, '--disable-approval']
    const missing = await runRecorder(['--muse', ...rest, ...argv])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('--muse-home <dir> is required')
    const everyday = await runRecorder(['--muse', '--muse-home', homedir(), ...rest, ...argv])
    expect(everyday.code).toBe(2)
    expect(everyday.stderr).toContain('--muse-home is the everyday home')
    const settings = join(dir, 'h', '.config')
    mkdirSync(settings, { recursive: true })
    const folder = await runRecorder(['--muse', '--muse-home', settings, ...rest, ...argv])
    expect(folder.code).toBe(2)
    expect(folder.stderr).toContain('names a settings folder')
    const other = await runRecorder([
      '--muse-home',
      dir,
      '--vendor',
      'codex',
      '--route',
      'exec',
      '--codex-home',
      dir,
      ...rest,
      ...argv,
    ])
    expect(other.code).toBe(2)
    expect(other.stderr).toContain('--muse-home is only for --muse')
    expect(existsSync(join(dir, 'out'))).toBe(false)
  })
})
