// scripts/record-fixture.mjs, Codex mode (README "Re-recording"): each generated recipe
// (tests/fixtures/codex/recipes/<ID>/stdin.jsonl, responders.json, pass.json) is recorded against the fake CLI replaying
// that scenario's fixture, which deep-compares every host frame. A recipe that records cleanly and gives back the
// fixture's frames is a recipe that will drive the real CLI the way Dim Factory does, for the live re-record. A live
// recording on the everyday ~/.codex (the live stage A) is played by the fake with fake personal values: none of them
// may reach the recording.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { COMMITTED_BUNDLE, checkRecording } from '../../../../scripts/codex-fixture-check.mjs'
import { applyHostNames, matchHostNames } from '../../../fake-cli/fake-cli.mjs'
import { fakeEnv } from '../../../fake-cli/harness.ts'
import type { CodexFrame, CodexRecording } from './helpers.ts'
import { CODEX_FIXTURES, fixtureIds, loadCodexRecording, tempDir, withCwd } from './helpers.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const RECIPES = join(CODEX_FIXTURES, 'recipes')
const build = await buildFakeCli()
const NODE = build.launchers.node.codex[0]
const ENTRY: string =
  build.launchers.node.codex[1] ??
  ((): never => {
    throw new Error('the fake codex has no node entry')
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

function readRecording(dir: string): { header: Record<string, unknown>; frames: CodexFrame[] } {
  const [header, ...frames] = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { header: header!, frames: frames as unknown as CodexFrame[] }
}

/**
 * Frames of one direction, as text (the recorder interleaves the two sides as they happen). Consecutive streamed
 * deltas of one item are joined: the recorder may move a fragment from one delta to the next so that a split path or
 * name is still redacted (the text is unchanged).
 */
/**
 * The host frames of a re-record are the recording's, except for the host's name where the recording was made under
 * the former one (masked like an id, RECORDED_HOST_NAMES); the server frames are the recording's with its echo of the
 * client name set to the bound name, as the fake writes them.
 */
function expectSameSides(got: readonly CodexFrame[], rec: readonly CodexFrame[]): void {
  const hostNames = new Map<string, string>()
  const gotIn = side(got, 'in')
  const recIn = side(rec, 'in')
  expect(gotIn).toHaveLength(recIn.length)
  gotIn.forEach((line, i) => {
    const recorded = recIn[i] ?? ''
    expect(line === recorded || matchHostNames(recorded, line, hostNames), line).toBe(true)
  })
  expect(side(got, 'out')).toEqual(side(rec, 'out').map((line) => applyHostNames(line, hostNames)))
}

function side(frames: readonly CodexFrame[], dir: CodexFrame['dir']): string[] {
  const out: string[] = []
  let run: { key: string; first: Record<string, unknown>; text: string } | undefined
  const flush = (): void => {
    if (run === undefined) return
    const params = { ...(run.first['params'] as Record<string, unknown>), delta: run.text }
    out.push(JSON.stringify({ ...run.first, params, emittedAtMs: 0 }))
    run = undefined
  }
  for (const f of frames.filter((x) => x.dir === dir)) {
    const text = f.line ?? f.content ?? ''
    let m: Record<string, unknown> | undefined
    try {
      m = JSON.parse(text) as Record<string, unknown>
    } catch {
      m = undefined
    }
    const p = m?.['params'] as Record<string, unknown> | undefined
    const streamed = typeof m?.['method'] === 'string' && /(\/delta|Delta)$/.test(m['method'])
    if (m !== undefined && streamed && typeof p?.['delta'] === 'string') {
      const key = `${String(m['method'])}:${String(p['itemId'])}`
      if (run?.key !== key) {
        flush()
        run = { key, first: m, text: '' }
      }
      run.text += p['delta']
      continue
    }
    flush()
    out.push(text)
  }
  flush()
  return out
}

/** Record `name`'s recipe against the fake replaying `name`'s fixture. */
async function rerecord(
  rec: CodexRecording,
  o: { vars?: Record<string, string>; exec?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; out: string; cwd: string }> {
  const name = rec.id
  const recipe = join(RECIPES, name)
  const cwd = tempDir('codex-rec-cwd-')
  const codexHome = tempDir('codex-rec-home-')
  const out = tempDir('codex-rec-out-')
  const id = name.replace(/-.*/, '')
  const slug = name.slice(id.length + 1)
  const binArgs = o.exec
    ? withCwd(rec.header.argv.slice(1), cwd).map((a) =>
        a.endsWith('last-message.txt') ? join(cwd, 'last.txt') : a,
      )
    : ['app-server', '--listen', 'stdio://']
  if (o.exec) mkdirSync(join(cwd), { recursive: true })
  const args = [
    ...(o.exec ? ['--vendor', 'codex', '--route', 'exec', '--output-file', '-o'] : ['--codex-app-server']),
    '--bin',
    NODE,
    '--arg',
    ENTRY,
    ...binArgs.flatMap((a) => ['--arg', a]),
    '--codex-home',
    codexHome,
    '--cwd',
    cwd,
    '--out',
    out,
    '--id',
    id,
    '--slug',
    slug,
    '--cli-version',
    '0.160.1',
    '--timing',
    'off',
    '--timeout',
    '60000',
    '--stdin',
    join(recipe, 'stdin.jsonl'),
    '--pass-file',
    join(recipe, 'pass.json'),
    // A live recipe answers like Dim Factory's adapter (responders.mjs, recipes/dim-factory-responder.mjs).
    ...(existsSync(join(recipe, 'responders.mjs'))
      ? ['--responders', join(recipe, 'responders.mjs')]
      : existsSync(join(recipe, 'responders.json'))
        ? ['--responders', join(recipe, 'responders.json')]
        : []),
    ...Object.entries(o.vars ?? {}).flatMap(([k, v]) => ['--var', `${k}=${v}`]),
  ]
  const r = await runRecorder(args, { FAKE_CLI_SCRIPT: rec.path, FAKE_CLI_TIMEOUT_MS: '15000' })
  return { ...r, out, cwd }
}

describe('Codex recipes re-record their fixture through the recorder', () => {
  it.each(fixtureIds('app-server'))('%s', async (name) => {
    const rec = loadCodexRecording('app-server', name)
    // A resume recipe names the thread an earlier recording created: --var threadId=<it> (README "Re-recording").
    const resume = rec.header.pass?.resume?.sessionId
    const r = await rerecord(rec, { vars: resume !== undefined ? { threadId: resume } : {} })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(r.out)
    expect(got.header).toMatchObject({
      vendor: 'codex',
      route: 'app-server',
      protocol: 'jsonrpc',
      scenario: name,
      envKeys: ['CODEX_HOME'],
      envDrop: ['^OPENAI_', '^CODEX_'],
      pass: rec.header.pass,
    })
    // The fake took every host frame (it exits 99 otherwise) and the recording gives the fixture back, side by side.
    expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', code: 0 })
    expectSameSides(got.frames, rec.frames)
    expect(got.frames.filter((f) => f.dir === 'eof')).toHaveLength(1)
  })

  it.each(fixtureIds('exec'))('%s (exec: the prompt, the close, the JSONL, the -o file)', async (name) => {
    const rec = loadCodexRecording('exec', name)
    const r = await rerecord(rec, { exec: true })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(r.out)
    expect(got.frames.map((f) => f.dir)).toEqual(rec.frames.map((f) => f.dir))
    expect(side(got.frames, 'in')).toEqual(side(rec.frames, 'in'))
    expect(side(got.frames, 'out')).toEqual(side(rec.frames, 'out'))
    expect(side(got.frames, 'err')).toEqual(side(rec.frames, 'err'))
    const file = rec.frames.find((f) => f.dir === 'file')
    if (file !== undefined) {
      expect(got.frames.find((f) => f.dir === 'file')).toEqual({
        t: 0,
        dir: 'file',
        argvPath: '-o',
        content: file.content,
      })
    }
    const exit = rec.frames.at(-1)!
    if (rec.frames.some((f) => f.dir === 'hold'))
      expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', killed: 'tree' })
    else expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', code: exit.code })
    // The recorded argv names the sandbox through the placeholder, never the real path.
    expect(JSON.stringify(got.header['argv'])).toContain('<CWD>')
  })
})

describe('the Codex recorder guards', () => {
  const base = (out: string): string[] => [
    '--codex-app-server',
    '--bin',
    NODE,
    '--arg',
    ENTRY,
    '--out',
    out,
    '--id',
    'X99',
    '--slug',
    'guard',
  ]

  it('needs an isolated CODEX_HOME', async () => {
    const r = await runRecorder(base(tempDir('codex-guard-')))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--codex-home <dir> is required/)
  })

  it('refuses the everyday ~/.codex unless told otherwise', async () => {
    const home = tempDir('codex-guard-home-')
    mkdirSync(join(home, '.codex'))
    const r = await runRecorder([...base(tempDir('codex-guard-')), '--codex-home', join(home, '.codex')], {
      USERPROFILE: home,
      HOME: home,
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--codex-home is the everyday/)
  })

  it('a server request no responder answers gets -32601, and a null reply leaves it pending', async () => {
    // X08b's recipe without its responders: the approval request is refused with -32601 at once, which the fake
    // (expecting the pending ask, then the late cancel) reports as a mismatch.
    const rec = loadCodexRecording('app-server', 'X08b-stop-pending-ask')
    const out = tempDir('codex-rec-out-')
    const r = await runRecorder(
      [
        '--codex-app-server',
        '--bin',
        NODE,
        '--arg',
        ENTRY,
        '--arg',
        'app-server',
        '--codex-home',
        tempDir('codex-rec-home-'),
        '--cwd',
        tempDir('codex-rec-cwd-'),
        '--out',
        out,
        '--id',
        'X08b',
        '--slug',
        'stop-pending-ask',
        '--timing',
        'off',
        '--timeout',
        '30000',
        '--stdin',
        join(RECIPES, 'X08b-stop-pending-ask', 'stdin.jsonl'),
      ],
      { FAKE_CLI_SCRIPT: rec.path, FAKE_CLI_TIMEOUT_MS: '3000' },
    )
    expect(r.code).toBe(0)
    const got = readRecording(out)
    const refusal = side(got.frames, 'in').find((l) => l.includes('-32601'))
    expect(JSON.parse(refusal!)).toMatchObject({ id: 0, error: { code: -32601 } })
    expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', code: 99 })
  })
})

describe('a recording on a real profile (the live stage A, fake values)', () => {
  // The profile's own files, as an everyday ~/.codex has them; and the git identity the sandbox's commits carry.
  const MCP_COMMAND = 'C:\\fake-tools\\fake-files-mcp.exe'
  const MCP_URL = 'https://mcp.fake-remote.example/mcp'
  const TOKEN = 'fake-token-value-0123456789'
  const AGENTS_LINE = 'Prefer the fake house style when writing code.'
  const INSTRUCTIONS = 'Always answer as the fake person from Fake Street.'
  const GIT_NAME = 'Fake Person McFake'
  const INSTALL = '11111111-2222-4333-8444-555555555555'
  const ENVIRONMENT = 'env-fake-0001'
  const OS = 'Windows 10.0.99999; x86_64'
  // A scratch folder under the temp folder names the session that made it (cut by a shell's table).
  const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
  const SCRATCH = join(tmpdir(), 'fake-tool', 'C---fake-project', SESSION, 'scratchpad', 'live', 's...')

  function profile(): { codexHome: string; gitConfig: string } {
    const codexHome = tempDir('codex-rec-profile-')
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        'model = "gpt-5.6-terra"',
        `developer_instructions = "${INSTRUCTIONS}"`,
        '[mcp_servers.fake-files]',
        `command = '${MCP_COMMAND}'`,
        `env = { FAKE_TOKEN = "${TOKEN}" }`,
        '[mcp_servers.fake-remote]',
        `url = "${MCP_URL}"`,
        '',
      ].join('\n'),
    )
    writeFileSync(join(codexHome, 'AGENTS.md'), `# Notes\n- ${AGENTS_LINE}\n`)
    const gitConfig = join(tempDir('codex-rec-git-'), 'gitconfig')
    writeFileSync(gitConfig, `[user]\n\tname = ${GIT_NAME}\n`)
    return { codexHome, gitConfig }
  }

  /** X01b's handshake as the everyday profile answered it in stage A, plus what a configured profile adds. */
  function liveRecording(codexHome: string): string {
    const recipe = readFileSync(join(RECIPES, 'X01b-handshake-readiness', 'stdin.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('{"$'))
    const at = 1791626208976
    const out = (msg: unknown): unknown => ({ t: 0, dir: 'out', line: JSON.stringify(msg) })
    const delta = (text: string): unknown =>
      out({
        method: 'item/agentMessage/delta',
        params: { threadId: 't-1', turnId: 'u-1', itemId: 'msg_1', delta: text },
        emittedAtMs: at,
      })
    const frames = [
      { t: 0, dir: 'in', line: recipe[0] },
      out({
        id: 1,
        result: {
          userAgent: `dim-factory/0.160.1 (${OS}) dumb (dim-factory; 0.1.0)`,
          codexHome,
          platformFamily: 'windows',
          platformOs: 'windows',
        },
      }),
      { t: 0, dir: 'in', line: recipe[1] },
      { t: 0, dir: 'in', line: recipe[2] },
      out({
        method: 'remoteControl/status/changed',
        params: {
          status: 'disabled',
          serverName: hostname(),
          installationId: INSTALL,
          environmentId: ENVIRONMENT,
        },
        emittedAtMs: at,
      }),
      out({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            limitName: null,
            normalModelSlug: null,
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791626208 },
            secondary: null,
            credits: { hasCredits: true, unlimited: false, balance: '123.45' },
            individualLimit: null,
            spendControlReached: false,
            planType: 'plus',
            rateLimitReachedType: null,
          },
        },
        emittedAtMs: at,
      }),
      out({
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: null,
          name: 'fake-files',
          status: 'failed',
          error: `program not found: ${MCP_COMMAND}`,
          failureReason: null,
        },
        emittedAtMs: at,
      }),
      out({
        method: 'warning',
        params: { threadId: null, message: 'MCP client for `fake-files` failed to start' },
        emittedAtMs: at,
      }),
      { t: 0, dir: 'err', line: `ERROR codex_core::mcp: fake-remote at ${MCP_URL} is unreachable` },
      { t: 0, dir: 'err', line: `WARN codex_core::rollout: could not list ${SCRATCH}` },
      // The AGENTS.md line split across two deltas, then the git identity.
      delta(`As your notes say: ${AGENTS_LINE.slice(0, 24)}`),
      delta(`${AGENTS_LINE.slice(24)} Signed, ${GIT_NAME}.`),
      out({ id: 2, result: { status: 'ready' } }),
      { t: 0, dir: 'eof' },
      { t: 0, dir: 'exit', code: 0, signal: null },
    ]
    const header = {
      kind: 'header',
      schemaVersion: 1,
      vendor: 'codex',
      route: 'app-server',
      scenario: 'X99-live-profile',
      protocol: 'jsonrpc',
      argv: ['codex.exe', 'app-server', '--listen', 'stdio://'],
    }
    return `${[header, ...frames].map((f) => JSON.stringify(f)).join('\n')}\n`
  }

  it('no profile, account, install or machine value reaches the recording, and it stays valid 0.160', async () => {
    const { codexHome, gitConfig } = profile()
    const scenario = join(tempDir('codex-rec-live-'), 'recording.jsonl')
    const source = liveRecording(codexHome)
    writeFileSync(scenario, source)
    // The fake really says all of it (the checks below are not vacuous).
    expect(checkRecording(JSON.parse(readFileSync(COMMITTED_BUNDLE, 'utf8')), source)).toEqual([])
    for (const v of [
      INSTALL,
      ENVIRONMENT,
      OS,
      'fake-files',
      MCP_URL,
      AGENTS_LINE.slice(0, 24),
      GIT_NAME,
      SESSION,
    ])
      expect(source).toContain(v)

    const out = tempDir('codex-rec-out-')
    const r = await runRecorder(
      [
        '--codex-app-server',
        '--bin',
        NODE,
        '--arg',
        ENTRY,
        ...['app-server', '--listen', 'stdio://'].flatMap((a) => ['--arg', a]),
        '--codex-home',
        codexHome,
        '--cwd',
        tempDir('codex-rec-cwd-'),
        '--out',
        out,
        '--id',
        'X99',
        '--slug',
        'live-profile',
        '--cli-version',
        '0.160.1',
        '--timing',
        'off',
        '--timeout',
        '60000',
        '--stdin',
        join(RECIPES, 'X01b-handshake-readiness', 'stdin.jsonl'),
      ],
      {
        FAKE_CLI_SCRIPT: scenario,
        FAKE_CLI_TIMEOUT_MS: '15000',
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    )
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const summary = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>
    // Counts only: the profile's values never reach the summary either.
    expect(summary['profile']).toEqual({ literals: 5, names: 2, unreadConfigStatements: 0, gitName: true })
    expect(Object.keys(summary['redactions'] ?? {})).toEqual(
      expect.arrayContaining([
        'tmp',
        'codexHome',
        'account-key',
        'hostname',
        'codex-user-agent',
        'codex-remote-control',
        'codex-plan',
        'codex-mcp',
        'profile',
        'profile-name',
      ]),
    )
    expect(r.stdout).not.toContain('fake-files')

    const text = readFileSync(join(out, 'recording.jsonl'), 'utf8')
    const got = readRecording(out)
    const lines = got.frames.map((f) => f.line ?? '').join('\n')
    const leaks = [
      INSTALL,
      ENVIRONMENT,
      OS,
      'fake-files',
      'fake-remote',
      'fake-tools',
      TOKEN,
      MCP_URL,
      AGENTS_LINE.slice(0, 24),
      INSTRUCTIONS,
      GIT_NAME,
      SESSION,
      'C---fake-project',
      '"plus"',
      '123.45',
      JSON.stringify(codexHome).slice(1, -1),
    ]
    for (const v of leaks) expect({ v, found: lines.includes(v) }).toEqual({ v, found: false })
    expect(lines.toLowerCase()).not.toContain(hostname().toLowerCase())

    expect(checkRecording(JSON.parse(readFileSync(COMMITTED_BUNDLE, 'utf8')), text)).toEqual([])
    expect(side(got.frames, 'in')).toEqual(
      source.split('\n').flatMap((l) => {
        const f = l === '' ? undefined : (JSON.parse(l) as CodexFrame)
        return f?.dir === 'in' && f.line !== undefined ? [f.line] : []
      }),
    )
    const outs = side(got.frames, 'out').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(outs).toEqual([
      {
        id: 1,
        result: {
          userAgent: 'dim-factory/0.160.1 <REDACTED> (dim-factory; 0.1.0)',
          codexHome: '<CODEX_HOME>',
          platformFamily: 'windows',
          platformOs: 'windows',
        },
      },
      expect.objectContaining({
        params: {
          status: 'disabled',
          serverName: 'host',
          installationId: '<REDACTED>',
          environmentId: '<REDACTED>',
        },
      }),
      expect.objectContaining({
        params: {
          rateLimits: expect.objectContaining({
            // The window's length and reset are stand-ins (the plan and the window's start stay private).
            primary: { usedPercent: 12, windowDurationMins: 0, resetsAt: 0 },
            planType: 'unknown',
            credits: { hasCredits: true, unlimited: false, balance: '<REDACTED>' },
          }) as unknown,
        },
      }),
      expect.objectContaining({
        params: {
          threadId: null,
          name: '<REDACTED>',
          status: 'failed',
          error: '<REDACTED>',
          failureReason: null,
        },
      }),
      expect.objectContaining({
        params: { threadId: null, message: 'MCP client for `<REDACTED>` failed to start' },
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          delta: 'As your notes say: <REDACTED> Signed, <REDACTED>.',
        }) as unknown,
      }),
      { id: 2, result: { status: 'ready' } },
    ])
    expect(side(got.frames, 'err')).toEqual([
      'ERROR codex_core::mcp: <REDACTED> at <REDACTED> is unreachable',
      'WARN codex_core::rollout: could not list <TMP>',
    ])
  })

  it('a profile that trusts its own CODEX_HOME or the home folder keeps the <CODEX_HOME> and ~ placeholders (live X01a)', async () => {
    const { codexHome, gitConfig } = profile()
    // The everyday profile of live stage B trusts its own CODEX_HOME as a project; a folder below it stays private.
    const inside = join(codexHome, 'fake-private-tools')
    const home = homedir()
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        readFileSync(join(codexHome, 'config.toml'), 'utf8'),
        `[projects.'${codexHome}']`,
        'trust_level = "trusted"',
        `[projects.'${home}']`,
        'trust_level = "trusted"',
        `[projects.'${inside}']`,
        'trust_level = "trusted"',
        '',
      ].join('\n'),
    )
    const recipe = readFileSync(join(RECIPES, 'X01b-handshake-readiness', 'stdin.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('{"$'))
    const out = (msg: unknown): unknown => ({ t: 0, dir: 'out', line: JSON.stringify(msg) })
    const message = `Loaded ${join(codexHome, 'sessions', 'rollout.jsonl')}; skipped ${join(inside, 'run.cmd')}; see ${join(home, 'fake-notes.txt')}`
    const frames = [
      { t: 0, dir: 'in', line: recipe[0] },
      out({
        id: 1,
        result: { userAgent: 'fake', codexHome, platformFamily: 'windows', platformOs: 'windows' },
      }),
      { t: 0, dir: 'in', line: recipe[1] },
      { t: 0, dir: 'in', line: recipe[2] },
      out({ method: 'warning', params: { threadId: null, message }, emittedAtMs: 1791626208976 }),
      out({ id: 2, result: { status: 'ready' } }),
      { t: 0, dir: 'eof' },
      { t: 0, dir: 'exit', code: 0, signal: null },
    ]
    const header = {
      kind: 'header',
      schemaVersion: 1,
      vendor: 'codex',
      route: 'app-server',
      scenario: 'X99-trusted-home',
      protocol: 'jsonrpc',
      argv: ['codex.exe', 'app-server', '--listen', 'stdio://'],
    }
    const scenario = join(tempDir('codex-rec-trusted-'), 'recording.jsonl')
    writeFileSync(scenario, `${[header, ...frames].map((f) => JSON.stringify(f)).join('\n')}\n`)

    const dir = tempDir('codex-rec-out-')
    const r = await runRecorder(
      [
        '--codex-app-server',
        '--bin',
        NODE,
        '--arg',
        ENTRY,
        ...['app-server', '--listen', 'stdio://'].flatMap((a) => ['--arg', a]),
        '--codex-home',
        codexHome,
        '--cwd',
        tempDir('codex-rec-cwd-'),
        '--out',
        dir,
        '--id',
        'X99',
        '--slug',
        'trusted-home',
        '--timing',
        'off',
        '--timeout',
        '60000',
        '--stdin',
        join(RECIPES, 'X01b-handshake-readiness', 'stdin.jsonl'),
      ],
      {
        FAKE_CLI_SCRIPT: scenario,
        FAKE_CLI_TIMEOUT_MS: '15000',
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    )
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const outs = side(readRecording(dir).frames, 'out').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(outs[0]).toMatchObject({ result: { codexHome: '<CODEX_HOME>' } })
    const said = String((outs[1]?.['params'] as Record<string, unknown> | undefined)?.['message'])
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(said).toBe(
      `Loaded <CODEX_HOME>${sep}sessions${sep}rollout.jsonl; skipped <REDACTED>${sep}run.cmd; see ~${sep}fake-notes.txt`,
    )
  })
})
