// scripts/record-fixture.mjs, ACP mode (tests/fixtures/gemini/README.md "Re-recording
// live"): each generated recipe (tests/fixtures/gemini/recipes/<ID>/stdin.jsonl, responders.mjs, pass.json) is
// recorded against the fake CLI replaying that scenario's fixture, which deep-compares every host frame. A recipe that
// records cleanly and gives back the fixture's frames will drive the real CLI the way Dim Factory does, for the live
// re-record; its responders.mjs (the Dim Factory responder) answers however many requests a live model makes. A recording on a real Gemini profile is played by the fake with fake personal values: none may reach the
// recording, the recorded CLI never inherits GEMINI_* / GOOGLE_*, and the everyday ~/.gemini is refused.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { fakeEnv, readFakeLog } from '../../../fake-cli/harness.ts'
import { dimFactoryResponder } from '../../../fixtures/gemini/recipes/dim-factory-responder.mjs'
import type { ResponderPass } from '../../../fixtures/gemini/recipes/dim-factory-responder.mjs'
import type { AcpFrame, AcpRecording } from './helpers.ts'
import { GEMINI_FIXTURES, fixtureIds, loadRecording, messageOf, tempDir } from './helpers.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const RECORD = join(ROOT, 'scripts', 'record-fixture.mjs')
const RECIPES = join(GEMINI_FIXTURES, 'recipes')
const build = await buildFakeCli()
const NODE = build.launchers.node.gemini[0]
const ENTRY: string =
  build.launchers.node.gemini[1] ??
  ((): never => {
    throw new Error('the fake gemini has no node entry')
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

function readRecording(dir: string): { header: Record<string, unknown>; frames: AcpFrame[]; text: string } {
  const text = readFileSync(join(dir, 'recording.jsonl'), 'utf8')
  const [header, ...frames] = text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { header: header!, frames: frames as unknown as AcpFrame[], text }
}

/**
 * Frames of one direction, as text (the recorder interleaves the two sides as they happen). Consecutive message chunks
 * of one session and kind are joined: the recorder may move a fragment from one chunk to the next so that a split path
 * or name is still redacted (the text is unchanged).
 */
function side(frames: readonly AcpFrame[], dir: AcpFrame['dir']): string[] {
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
    const text = f.line ?? ''
    const m = messageOf(f)
    const update = (m?.['params'] as Record<string, unknown> | undefined)?.['update'] as
      Record<string, unknown> | undefined
    const chunk =
      m?.['method'] === 'session/update' &&
      typeof update?.['sessionUpdate'] === 'string' &&
      String(update['sessionUpdate']).endsWith('_chunk')
    if (m !== undefined && chunk) {
      const key = `${String((m['params'] as Record<string, unknown>)['sessionId'])}:${String(update['sessionUpdate'])}`
      if (run?.key !== key) {
        flush()
        run = { key, first: m, text: '' }
      }
      run.text += String((update['content'] as Record<string, unknown>)['text'])
      continue
    }
    flush()
    out.push(text)
  }
  flush()
  return out
}

/**
 * Record `rec`'s recipe against the fake replaying `rec`'s fixture. `fakeEnv` reaches the fake (FAKE_CLI_OUT_CWD=1:
 * the fake names real folders, as a live CLI does).
 */
async function rerecord(
  rec: AcpRecording,
  fakeEnvExtra: Record<string, string> = {},
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  out: string
  cwd: string
  geminiHome: string
}> {
  const name = rec.id
  const recipe = join(RECIPES, name)
  const cwd = tempDir('gemini-rec-cwd-')
  const geminiHome = tempDir('gemini-rec-home-')
  const out = tempDir('gemini-rec-out-')
  const id = name.replace(/-.*/, '')
  const slug = name.slice(id.length + 1)
  const command = readFileSync(join(recipe, 'record.txt'), 'utf8')
  const resume = rec.header.pass?.resume?.sessionId
  const args = [
    '--acp',
    '--vendor',
    'gemini',
    '--gemini-home',
    geminiHome,
    '--bin',
    NODE,
    '--entry',
    ENTRY,
    '--cwd',
    cwd,
    '--out',
    out,
    '--id',
    id,
    '--slug',
    slug,
    '--cli-version',
    '0.62.0',
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
    ...(resume !== undefined ? ['--var', `sessionId=${resume}`] : []),
    ...(command.includes('--keep-stdin') ? ['--keep-stdin'] : []),
    '--',
    ...rec.header.argv.slice(1),
  ]
  const r = await runRecorder(args, {
    FAKE_CLI_SCRIPT: rec.path,
    FAKE_CLI_TIMEOUT_MS: '15000',
    ...fakeEnvExtra,
  })
  return { ...r, out, cwd, geminiHome }
}

/** A fixture's recording with its text changed (a variant scenario), as an AcpRecording in a temp folder. */
function variant(name: string, edit: (text: string) => string): AcpRecording {
  const rec = loadRecording(name)
  const dir = tempDir('gemini-variant-')
  const path = join(dir, 'recording.jsonl')
  writeFileSync(path, edit(rec.text))
  return { ...rec, path, text: readFileSync(path, 'utf8') }
}

describe('Gemini recipes re-record their fixture through the recorder', () => {
  it.each(fixtureIds())('%s', async (name) => {
    const rec = loadRecording(name)
    const r = await rerecord(rec)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(r.out)
    expect(got.header).toMatchObject({
      vendor: 'gemini',
      route: 'acp',
      protocol: 'jsonrpc',
      jsonrpc: '2.0',
      scenario: name,
      argv: rec.header.argv,
      launch: 'node <entry>',
      envKeys: ['GEMINI_CLI_HOME'],
      envDrop: ['^GEMINI_', '^GOOGLE_'],
      pass: rec.header.pass,
    })
    // The fake took every host frame (it exits 99 otherwise) and the recording gives the fixture back, side by side.
    expect(got.frames.at(-1)).toMatchObject({ dir: 'exit', code: rec.frames.at(-1)?.code })
    expect(side(got.frames, 'in')).toEqual(side(rec.frames, 'in'))
    expect(side(got.frames, 'out')).toEqual(side(rec.frames, 'out'))
    expect(side(got.frames, 'err')).toEqual(side(rec.frames, 'err'))
    expect(got.frames.filter((f) => f.dir === 'eof')).toHaveLength(
      rec.frames.filter((f) => f.dir === 'eof').length,
    )
  })
})

describe('what a live Gemini run leaves for the replay', () => {
  it('the plan file an exit_plan_mode names is recorded as a file frame before the request, redacted', async () => {
    // The fake names its real GEMINI_CLI_HOME (the recorder's --gemini-home) and folders, as the live CLI would.
    const rec = loadRecording('G08-plan-exit-captured')
    const r = await rerecord(rec, { FAKE_CLI_OUT_CWD: '1' })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(r.out)
    const fileOf = (f: AcpFrame): Record<string, unknown> => ({
      dir: f.dir,
      path: f.path,
      content: f.content,
    })
    expect(got.frames.filter((f) => f.dir === 'file').map(fileOf)).toEqual(
      rec.frames.filter((f) => f.dir === 'file').map(fileOf),
    )
    const fileAt = got.frames.findIndex((f) => f.dir === 'file')
    const requestAt = got.frames.findIndex((f) => messageOf(f)?.['method'] === 'session/request_permission')
    expect(fileAt).toBeLessThan(requestAt)
    // Redacted like every other line: no folder of this machine, the project folder as <PROJECT>.
    expect(got.text).not.toContain(r.geminiHome)
    expect(got.text.split(JSON.stringify(r.geminiHome).slice(1, -1)).length).toBe(1)
    expect(JSON.parse(JSON.stringify(got.header))).toMatchObject({ scenario: 'G08-plan-exit-captured' })
    expect(JSON.stringify(summaryOf(r.stdout))).toContain('gemini-plan-file')
  })

  it('a plan file outside <GEMINI_CLI_HOME>/.gemini/tmp is never read or recorded', async () => {
    // The same exit naming a file in the sandbox instead (a profile with a custom plans folder): no file frame.
    const rec = variant('G08-plan-exit-captured', (text) =>
      text
        .split(
          '<GEMINI_CLI_HOME>/.gemini/tmp/<PROJECT>/7c4e9a12-3b5d-4f60-8a1b-2c3d4e5f6012/plans/version-flag.md',
        )
        .join('<CWD>/plans/version-flag.md'),
    )
    expect(rec.text).toContain('<CWD>/plans/version-flag.md')
    const r = await rerecord(rec, { FAKE_CLI_OUT_CWD: '1' })
    expect(r.code).toBe(0)
    expect(readRecording(r.out).frames.filter((f) => f.dir === 'file')).toEqual([])
    expect(existsSync(join(r.cwd, 'plans', 'version-flag.md'))).toBe(true)
  })

  it("Gemini's [MODE_UPDATE] echo is recorded as sent, never merged into the text around it", async () => {
    const rec = loadRecording('G04-permission-allow-once')
    const r = await rerecord(rec)
    expect(r.code).toBe(0)
    const echoes = readRecording(r.out).frames.filter((f) => (f.line ?? '').includes('[MODE_UPDATE]'))
    expect(echoes.map((f) => f.line)).toEqual(
      rec.frames.filter((f) => (f.line ?? '').includes('[MODE_UPDATE]')).map((f) => f.line),
    )
    expect(echoes).toHaveLength(1)
  })
})

/** The recorder's summary (its stdout JSON). */
function summaryOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('the Dim Factory responder answers as the fixtures do', () => {
  it.each(fixtureIds())('%s', (name) => {
    const rec = loadRecording(name)
    const respond = dimFactoryResponder((rec.header.pass ?? {}) as ResponderPass)
    // Each agent request is followed in the recording by the host frames that answer it (the reply, and the
    // session/cancel a plan exit or a Stop sends with it, in the ACP base's order): the responder gives exactly those.
    rec.frames.forEach((f, i) => {
      const m = f.dir === 'out' ? messageOf(f) : undefined
      if (m === undefined || typeof m['method'] !== 'string' || !('id' in m)) return
      const host: Record<string, unknown>[] = []
      for (const next of rec.frames.slice(i + 1)) {
        if (next.dir !== 'in') break
        host.push(messageOf(next)!)
      }
      expect([respond(m)].flat()).toEqual(host)
    })
    expect(respond({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} })).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'Method not found: fs/read_text_file' },
    })
  })

  it('answers however many asks a live model makes, never with a forbidden or persistent option', () => {
    const options = [
      { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'proceed_always_and_save', name: 'Allow for all future sessions', kind: 'allow_always' },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
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
    // A read-only pass rejects every one.
    const review = dimFactoryResponder({ step: 'review', mode: 'readonly' })
    for (const id of [0, 1, 2, 3]) expect(chosen(review(ask(id)))).toBe('cancel')
    // An asking pass: the decisions in order, then the last one again; allow-session is the session-scoped option.
    const implement = dimFactoryResponder({
      step: 'implement',
      mode: 'autoedit',
      answers: [{ decision: 'allow' }, { decision: 'allow-session' }],
    })
    expect([0, 1, 2].map((id) => chosen(implement(ask(id))))).toEqual([
      'proceed_once',
      'proceed_always',
      'proceed_always',
    ])
    // A Plan pass: an ordinary ask is rejected (read-only), the plan exit is rejected and the turn cancelled, and
    // anything after that is answered cancelled.
    const plan = dimFactoryResponder({ step: 'plan', mode: 'readonly', planNative: true })
    expect(chosen(plan(ask(0)))).toBe('cancel')
    expect(plan(ask(1, 'switch_mode'))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'selected', optionId: 'cancel' } } },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } },
    ])
    expect(chosen(plan(ask(2)))).toBe('cancelled')
  })
})

describe('the recorder refuses what would touch a real profile', () => {
  const base = (out: string): string[] => [
    '--acp',
    '--vendor',
    'gemini',
    '--bin',
    NODE,
    '--entry',
    ENTRY,
    '--out',
    out,
    '--id',
    'G01',
    '--slug',
    'x',
  ]

  it('--gemini-home is required for Gemini', async () => {
    const r = await runRecorder(base(tempDir('gemini-rec-out-')))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--gemini-home <dir> is required/)
  })

  it('the everyday home is refused without --allow-user-gemini-home, and a .gemini folder always', async () => {
    const out = tempDir('gemini-rec-out-')
    const everyday = await runRecorder([...base(out), '--gemini-home', homedir()])
    expect(everyday.code).toBe(2)
    expect(everyday.stderr).toMatch(/everyday home/)
    const dotGemini = join(tempDir('gemini-rec-home-'), '.gemini')
    mkdirSync(dotGemini)
    const folder = await runRecorder([...base(out), '--gemini-home', dotGemini])
    expect(folder.code).toBe(2)
    expect(folder.stderr).toMatch(/names a \.gemini folder/)
    expect(existsSync(join(out, 'recording.jsonl'))).toBe(false)
  })

  it('--gemini-home belongs to Gemini; --acp is not the Codex app-server', async () => {
    const out = tempDir('gemini-rec-out-')
    const codex = await runRecorder([
      '--vendor',
      'codex',
      '--route',
      'app-server',
      '--bin',
      NODE,
      '--out',
      out,
      '--id',
      'X',
      '--slug',
      'y',
      '--gemini-home',
      tempDir('gemini-rec-home-'),
    ])
    expect(codex.code).toBe(2)
    expect(codex.stderr).toMatch(/--gemini-home is only for --vendor gemini/)
    const both = await runRecorder([
      '--acp',
      '--codex-app-server',
      '--bin',
      NODE,
      '--out',
      out,
      '--id',
      'X',
      '--slug',
      'y',
    ])
    expect(both.code).toBe(2)
    expect(both.stderr).toMatch(/different protocols/)
  })
})

describe('a recording on a real profile (fake personal values)', () => {
  it('keeps the profile, the project, MCP names, the quota tier and the account’s project out; no inherited keys', async () => {
    const geminiHome = tempDir('gemini-rec-profile-')
    const dir = join(geminiHome, '.gemini')
    mkdirSync(join(dir, 'commands'), { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        mcpServers: { 'fake-notes-server': { command: 'node', args: ['C:/fake/notes-server.js'] } },
      }),
    )
    writeFileSync(join(dir, 'oauth_creds.json'), '{"refresh_token":"SENTINEL-NEVER-READ"}')
    const cwd = tempDir('gemini-rec-cwd-')
    const out = tempDir('gemini-rec-out-')
    const homeText = JSON.stringify(geminiHome).slice(1, -1)
    // What the fake (standing in for a signed-in Gemini) says back.
    const recording = join(tempDir('gemini-rec-scratch-'), 'recording.jsonl')
    const frames = [
      {
        kind: 'header',
        schemaVersion: 1,
        vendor: 'gemini',
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
            _meta: { quota: { user_tier: 'fake-paid-tier', resets_at: 1791626208 } },
          },
        }),
      },
      {
        t: 0,
        dir: 'out',
        line: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"m","title":"read_note (fake-notes-server MCP Server)","kind":"other","status":"pending"}}}`,
      },
      {
        t: 0,
        dir: 'out',
        line: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Saved ${homeText}\\\\.gemini\\\\tmp\\\\9f8e7d6c5b4a\\\\plans\\\\a.md via fake-notes-server, billed to fake-gcp-project-77."}}}}`,
      },
      { t: 0, dir: 'err', line: `warning: ${geminiHome}/.gemini/tmp/9f8e7d6c5b4a/logs.json` },
      { t: 0, dir: 'eof' },
      { t: 0, dir: 'exit', code: 0, signal: null },
    ]
    writeFileSync(recording, `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`)
    const stdin = join(tempDir('gemini-rec-stdin-'), 'stdin.jsonl')
    writeFileSync(
      stdin,
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n${JSON.stringify({ $wait: { id: 1, method: { $absent: true } }, $timeoutMs: 15000 })}\n${JSON.stringify({ $sleep: 300 })}\n`,
    )
    const envFile = join(tempDir('gemini-rec-env-'), 'gemini.env')
    writeFileSync(envFile, 'GOOGLE_CLOUD_PROJECT=fake-gcp-project-77\n')
    const log = join(tempDir('gemini-rec-log-'), 'fake.log')
    const r = await runRecorder(
      [
        '--acp',
        '--vendor',
        'gemini',
        '--gemini-home',
        geminiHome,
        '--bin',
        NODE,
        '--entry',
        ENTRY,
        '--cwd',
        cwd,
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
        '--env-file',
        envFile,
        '--',
        '--acp',
        '--skip-trust',
      ],
      {
        FAKE_CLI_SCRIPT: recording,
        FAKE_CLI_TIMEOUT_MS: '15000',
        FAKE_CLI_LOG: log,
        FAKE_CLI_LOG_ENV: 'GEMINI_CLI_HOME,GEMINI_API_KEY,GOOGLE_API_KEY,GOOGLE_CLOUD_PROJECT',
        // The recorder's own env: never inherited by the recorded CLI.
        GEMINI_API_KEY: 'AIza-fake-not-a-key',
        GOOGLE_API_KEY: 'fake-google-key',
      },
    )
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const got = readRecording(out)
    expect(got.header).toMatchObject({
      vendor: 'gemini',
      argv: ['gemini', '--acp', '--skip-trust'],
      envKeys: ['GEMINI_CLI_HOME', 'GOOGLE_CLOUD_PROJECT'],
      envDrop: ['^GEMINI_', '^GOOGLE_'],
    })
    for (const leak of [
      'fake-paid-tier',
      '1791626208',
      'fake-notes-server',
      '9f8e7d6c5b4a',
      'fake-gcp-project-77',
      'SENTINEL',
    ])
      expect(got.text).not.toContain(leak)
    expect(got.text).not.toContain(homeText)
    expect(got.text).not.toContain(geminiHome)
    expect(got.text).toContain('<GEMINI_CLI_HOME>')
    expect(got.text).toContain('<PROJECT>')
    // Counts only, never values.
    const summary = JSON.parse(r.stdout) as {
      profile: { names: number; literals: number }
      redactions: Record<string, number>
    }
    expect(summary.profile).toMatchObject({ names: 1, literals: 1 })
    expect(r.stdout).not.toContain('fake-notes-server')
    expect(summary.redactions).toMatchObject({ 'gemini-quota': 2, 'gemini-mcp': 1 })
    // The recorded CLI saw its isolated home and the --env-file project, never the recorder's own keys.
    const start = readFakeLog(log).find((e) => e.kind === 'start') as
      { env?: Record<string, string | null> } | undefined
    expect(start?.env).toEqual({
      GEMINI_CLI_HOME: geminiHome,
      GEMINI_API_KEY: null,
      GOOGLE_API_KEY: null,
      GOOGLE_CLOUD_PROJECT: 'fake-gcp-project-77',
    })
  })
})
