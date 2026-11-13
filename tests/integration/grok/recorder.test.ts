// scripts/record-fixture.mjs, Grok mode (tests/fixtures/grok/README.md "Re-recording
// live"): each generated recipe (tests/fixtures/grok/recipes/<ID>/stdin.jsonl, responders.mjs, pass.json) is recorded
// against the fake CLI replaying that scenario's fixture, which deep-compares every host frame, so the recipe will
// drive the real Grok the way Dim Factory does. A recording on a real Grok profile is played by the fake with fake
// personal values: none may reach the recording, the recorded CLI never inherits GROK_* / XAI_* (it gets
// GROK_DISABLE_AUTOUPDATER=1 and its isolated GROK_HOME), and the everyday ~/.grok is refused.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../scripts/build-fake-cli.mjs'
import { fakeEnv, readFakeLog } from '../../fake-cli/harness.ts'
import { dimFactoryResponder } from '../../fixtures/grok/recipes/dim-factory-responder.mjs'
import { tempDir } from '../acp/adapter/helpers.ts'
import type { GrokFixture } from './helpers.ts'
import { GROK_FIXTURES, grokFixtureIds, loadGrokFixture } from './helpers.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const RECIPES = join(GROK_FIXTURES, 'recipes')
const build = await buildFakeCli()
const NODE = build.launchers.node.gemini[0]
const ENTRY: string =
  build.launchers.node.gemini[1] ??
  ((): never => {
    throw new Error('the fake CLI has no node entry')
  })()

type Frame = Record<string, unknown> & { dir?: string; line?: string; code?: number | null }

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

function readRecording(dir: string): { header: Record<string, unknown>; frames: Frame[]; text: string } {
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { header: header!, frames: frames, text }
}

const messageOf = (f: Frame): Record<string, unknown> | undefined => {
  try {
    return f.line === undefined ? undefined : (JSON.parse(f.line) as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/**
 * Frames of one direction, as text. Consecutive message chunks of one session and kind are joined (the recorder may
 * move a fragment to the next chunk so a split path or name is still redacted; the text is unchanged).
 */
function side(frames: readonly Frame[], dir: string): string[] {
  const out: string[] = []
  let run: { key: string; first: Record<string, unknown>; text: string } | undefined
  const flush = (): void => {
    if (run === undefined) return
    const params = run.first['params'] as Record<string, unknown>
    const update = params['update'] as Record<string, unknown>
    const content = { ...(update['content'] as Record<string, unknown>), text: run.text }
    out.push(JSON.stringify({ ...run.first, params: { ...params, update: { ...update, content } } }))
    run = undefined
  }
  for (const f of frames.filter((x) => x.dir === dir)) {
    const m = messageOf(f)
    const update = (m?.['params'] as Record<string, unknown> | undefined)?.['update'] as
      Record<string, unknown> | undefined
    if (
      m?.['method'] === 'session/update' &&
      typeof update?.['sessionUpdate'] === 'string' &&
      String(update['sessionUpdate']).endsWith('_chunk')
    ) {
      const key = `${String((m['params'] as Record<string, unknown>)['sessionId'])}:${String(update['sessionUpdate'])}`
      if (run?.key !== key) {
        flush()
        run = { key, first: m, text: '' }
      }
      run.text += String((update['content'] as Record<string, unknown>)['text'])
      continue
    }
    flush()
    out.push(f.line ?? '')
  }
  flush()
  return out
}

async function rerecord(f: GrokFixture): Promise<{
  code: number | null
  stdout: string
  stderr: string
  out: string
  log: string
  grokHome: string
}> {
  const recipe = join(RECIPES, f.id)
  const grokHome = tempDir('grok-rec-home-')
  const out = tempDir('grok-rec-out-')
  const log = join(tempDir('grok-rec-log-'), 'fake.log')
  const id = f.id.replace(/-.*/, '')
  const r = await runRecorder(
    [
      '--acp',
      '--vendor',
      'grok',
      '--grok-home',
      grokHome,
      '--bin',
      NODE,
      '--entry',
      ENTRY,
      '--cwd',
      tempDir('grok-rec-cwd-'),
      '--out',
      out,
      '--id',
      id,
      '--slug',
      f.id.slice(id.length + 1),
      '--cli-version',
      '1.0.50',
      '--timing',
      'off',
      '--timeout',
      '60000',
      '--stdin',
      join(recipe, 'stdin.jsonl'),
      '--pass-file',
      join(recipe, 'pass.json'),
      '--responders',
      join(recipe, 'responders.mjs'),
      '--',
      ...f.header.argv.slice(1),
    ],
    {
      FAKE_CLI_SCRIPT: f.recording,
      FAKE_CLI_TIMEOUT_MS: '15000',
      FAKE_CLI_LOG: log,
      FAKE_CLI_LOG_ENV: 'GROK_HOME,GROK_DISABLE_AUTOUPDATER,XAI_API_KEY,GROK_FOLDER_TRUST',
      // The recorder's own env: never inherited by the recorded CLI.
      XAI_API_KEY: 'xai-fake-not-a-key',
      GROK_FOLDER_TRUST: '0',
    },
  )
  return { ...r, out, log, grokHome }
}

describe('Grok recipes re-record their fixture through the recorder', () => {
  it.each(grokFixtureIds())('%s', async (name) => {
    const f = loadGrokFixture(name)
    const r = await rerecord(f)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(r.out)
    expect(got.header).toMatchObject({
      vendor: 'grok',
      route: 'acp',
      protocol: 'jsonrpc',
      jsonrpc: '2.0',
      scenario: name,
      argv: f.header.argv,
      envKeys: ['GROK_DISABLE_AUTOUPDATER', 'GROK_HOME'],
      envDrop: ['^GROK_', '^XAI_'],
      pass: f.header.pass,
    })
    // The fake took every host frame (it exits 99 otherwise) and the recording gives the fixture back, side by side.
    const frames = f.frames as Frame[]
    expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', code: frames.at(-1)?.code })
    for (const dir of ['in', 'out', 'err']) expect(side(got.frames, dir)).toEqual(side(frames, dir))
    // The recorded Grok saw its isolated home and no auto-update; none of the recorder's own Grok or xAI settings.
    const start = readFakeLog(r.log).find((e) => e.kind === 'start') as
      { env?: Record<string, string | null> } | undefined
    expect(start?.env).toEqual({
      GROK_HOME: r.grokHome,
      GROK_DISABLE_AUTOUPDATER: '1',
      XAI_API_KEY: null,
      GROK_FOLDER_TRUST: null,
    })
  })
})

describe('the Grok responder answers as the fixtures do', () => {
  it.each(grokFixtureIds())('%s', (name) => {
    const f = loadGrokFixture(name)
    const respond = dimFactoryResponder(f.header.pass)
    const frames = f.frames as Frame[]
    frames.forEach((fr, i) => {
      const m = fr.dir === 'out' ? messageOf(fr) : undefined
      if (m === undefined || typeof m['method'] !== 'string' || !('id' in m)) return
      const host: Record<string, unknown>[] = []
      for (const next of frames.slice(i + 1)) {
        if (next.dir !== 'in') break
        host.push(messageOf(next)!)
      }
      expect([respond(m)].flat()).toEqual(host)
    })
    expect(respond({ jsonrpc: '2.0', id: 9, method: 'x.ai/fs/read_file', params: {} })).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'Method not found: x.ai/fs/read_file' },
    })
  })

  it('never chooses an option that widens the session, whatever its kind; Allow for this run is never offered', () => {
    const options = [
      { optionId: 'yolo-1', name: 'Enable always-approve mode', kind: 'allow_once' },
      { optionId: 'edits', name: 'Allow all edits this session', kind: 'allow_once' },
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow `npm test` in this project', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'never', name: 'Never allow `npm test` in this project', kind: 'reject_always' },
    ]
    const ask = (id: number, kind = 'execute'): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: { sessionId: 's', options, toolCall: { toolCallId: `t${id}`, title: 'npm test', kind } },
    })
    const chosen = (reply: unknown): unknown =>
      (reply as { result: { outcome: { optionId?: string; outcome: string } } }).result.outcome.optionId ??
      'cancelled'
    const full = dimFactoryResponder({
      step: 'implement',
      mode: 'full',
      answers: [{ decision: 'allow' }, { decision: 'allow-session' }, { decision: 'deny' }],
    })
    expect([0, 1, 2].map((id) => chosen(full(ask(id))))).toEqual(['once', 'once', 'reject'])
    // A read-only pass and the GR03 study reject everything; a mode switch is always rejected.
    const review = dimFactoryResponder({ step: 'review', mode: 'readonly' })
    for (const id of [0, 1]) expect(chosen(review(ask(id)))).toBe('reject')
    const study = dimFactoryResponder({ step: 'implement', mode: 'autoedit', study: 'default-mode-edit' })
    expect(chosen(study(ask(0, 'edit')))).toBe('reject')
    const allowing = dimFactoryResponder({
      step: 'implement',
      mode: 'full',
      answers: [{ decision: 'allow' }],
    })
    expect(chosen(allowing(ask(0, 'switch_mode')))).toBe('reject')
  })
})

describe('the recorder refuses what would touch a real Grok profile', () => {
  const base = (out: string): string[] => [
    '--acp',
    '--vendor',
    'grok',
    '--bin',
    NODE,
    '--entry',
    ENTRY,
    '--out',
    out,
    '--id',
    'GR01',
    '--slug',
    'x',
  ]

  it('--grok-home is required, the everyday ~/.grok is refused without --allow-user-grok-home, the home always', async () => {
    const out = tempDir('grok-rec-out-')
    const missing = await runRecorder(base(out))
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/--grok-home <dir> is required/)
    // A stand-in user home (USERPROFILE and HOME) with its own .grok: that one is "the everyday" profile.
    const home = tempDir('grok-rec-user-')
    mkdirSync(join(home, '.grok'))
    const userEnv = { USERPROFILE: home, HOME: home }
    const everyday = await runRecorder([...base(out), '--grok-home', join(home, '.grok')], userEnv)
    expect(everyday.code).toBe(2)
    expect(everyday.stderr).toMatch(/everyday/)
    const itself = await runRecorder([...base(out), '--grok-home', home], userEnv)
    expect(itself.code).toBe(2)
    expect(itself.stderr).toMatch(/names the home folder/)
    expect(existsSync(join(out, 'recording.jsonl'))).toBe(false)
  })

  it('--grok-home belongs to Grok', async () => {
    const r = await runRecorder([
      ...base(tempDir('grok-rec-out-')).map((a) => (a === 'grok' ? 'gemini' : a)),
      '--gemini-home',
      tempDir('grok-rec-gh-'),
      '--grok-home',
      tempDir('grok-rec-home-'),
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--grok-home is only for --vendor grok/)
  })
})

describe('a Grok recording on a real profile (fake personal values)', () => {
  it('keeps the profile folder, the session folder, SSO labels, team ids and MCP names out', async () => {
    const grokHome = tempDir('grok-rec-profile-')
    writeFileSync(
      join(grokHome, 'config.toml'),
      [
        '[mcp_servers.fake-notes-server]',
        'command = "node"',
        'args = ["C:/fake/notes-server.js"]',
        '',
        '[grok_com_config.oidc]',
        'issuer = "https://fake-acme.okta.example"',
        'client_id = "0oaFAKECLIENT77"',
      ].join('\n'),
    )
    writeFileSync(join(grokHome, 'auth.json'), '{"access_token":"SENTINEL-NEVER-READ"}')
    const out = tempDir('grok-rec-out-')
    const homeText = JSON.stringify(grokHome).slice(1, -1)
    const recording = join(tempDir('grok-rec-scratch-'), 'recording.jsonl')
    const frames = [
      {
        kind: 'header',
        schemaVersion: 1,
        vendor: 'grok',
        route: 'acp',
        scenario: 'S01-profile',
        protocol: 'jsonrpc',
      },
      {
        t: 0,
        dir: 'in',
        line: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }),
      },
      {
        t: 0,
        dir: 'out',
        line: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: 1,
            authMethods: [
              {
                id: 'oidc',
                name: 'Single sign-on (https://fake-acme.okta.example)',
                description: 'Sign in with Single sign-on (https://fake-acme.okta.example)',
              },
            ],
            _meta: { grokShell: true, teamId: 'team-fake-4242' },
          },
        }),
      },
      {
        t: 0,
        dir: 'out',
        line: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Saved to ${homeText}\\\\sessions\\\\C%3A%5Cfake%5Cproj\\\\0199d2a4 via fake-notes-server."}}}}`,
      },
      { t: 0, dir: 'err', line: `warning: ${grokHome}/sessions/C%3A%5Cfake%5Cproj/log.jsonl` },
      { t: 0, dir: 'eof' },
      { t: 0, dir: 'exit', code: 0, signal: null },
    ]
    writeFileSync(recording, `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`)
    const stdin = join(tempDir('grok-rec-stdin-'), 'stdin.jsonl')
    writeFileSync(
      stdin,
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n${JSON.stringify({ $wait: { id: 1, method: { $absent: true } }, $timeoutMs: 15000 })}\n${JSON.stringify({ $sleep: 300 })}\n`,
    )
    const r = await runRecorder(
      [
        '--acp',
        '--vendor',
        'grok',
        '--grok-home',
        grokHome,
        '--bin',
        NODE,
        '--entry',
        ENTRY,
        '--cwd',
        tempDir('grok-rec-cwd-'),
        '--out',
        out,
        '--id',
        'S01',
        '--slug',
        'profile',
        '--timing',
        'off',
        '--timeout',
        '60000',
        '--stdin',
        stdin,
        '--',
        'agent',
        '--no-leader',
        'stdio',
      ],
      { FAKE_CLI_SCRIPT: recording, FAKE_CLI_TIMEOUT_MS: '15000' },
    )
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(out)
    expect(got.header).toMatchObject({ vendor: 'grok', argv: ['grok', 'agent', '--no-leader', 'stdio'] })
    for (const leak of ['fake-acme', 'team-fake-4242', 'fake-notes-server', 'C%3A%5Cfake', 'SENTINEL'])
      expect(got.text).not.toContain(leak)
    expect(got.text).not.toContain(homeText)
    expect(got.text).toContain('<GROK_HOME>')
    expect(got.text).toContain('<PROJECT>')
    const summary = JSON.parse(r.stdout) as { redactions: Record<string, number> }
    expect(summary.redactions).toMatchObject({ 'grok-auth-label': 2, 'grok-account': 1 })
    expect(r.stdout).not.toContain('fake-notes-server')
  })
})
