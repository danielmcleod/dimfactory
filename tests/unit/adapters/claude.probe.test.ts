// Claude CLI spec, probe checks, transcript lookup, allow-rule scan, and the dev CLI commands.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeCapabilities } from '@core/adapters/claude/capabilities.ts'
import { claudeDesktopBundle, claudeWellKnown, parseClaudeVersion } from '@core/adapters/claude/cli-spec.ts'
import { createClaudeAdapter } from '@core/adapters/claude/index.ts'
import {
  authChecks,
  binCheck,
  parseAuthStatus,
  planCheck,
  protocolCheck,
  protocolConfigCheck,
  toModelInfo,
  versionCheck,
} from '@core/adapters/claude/probe.ts'
import { encodeProjectDir, findTranscript, transcriptPath } from '@core/adapters/claude/session.ts'
import { isReadOnlyShellRule, scanShellAllowRules } from '@core/adapters/claude/settings-scan.ts'
import { getAdapter } from '@core/adapters/registry.ts'
import { main } from '../../../src/cli/dimf.ts'
import { formatProbe, probeExitCode } from '../../../src/cli/commands/probe.ts'

const META = fileURLToPath(new URL('../../fixtures/claude/meta/', import.meta.url))
const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const metaStdout = (name: string): string =>
  readFileSync(join(META, name), 'utf8').split('# stdout')[1]!.split('# stderr')[0]!.trim()

const tmp = (): string => mkdtempSync(join(tmpdir(), 'claude-probe-'))

describe('cli spec', () => {
  it('requires the product name in --version (meta/version.txt)', () => {
    expect(parseClaudeVersion(metaStdout('version.txt'))).toEqual({ version: '2.1.289' })
    expect(parseClaudeVersion('1.0.0')).toBeNull()
    expect(parseClaudeVersion('Claude 0.14.2')).toBeNull()
  })

  it('knows the installer location', () => {
    expect(claudeWellKnown({ platform: 'win32', home: 'C:\\Users\\u' })).toEqual([
      'C:\\Users\\u\\.local\\bin\\claude.exe',
    ])
    expect(claudeWellKnown({ platform: 'linux', home: '/home/u' })).toEqual(['/home/u/.local/bin/claude'])
  })

  it('finds Claude Desktop bundles, newest first', () => {
    const appData = tmp()
    for (const [v, build] of [
      ['2.1.286', 'aaa'],
      ['2.1.290', 'bbb'],
    ]) {
      const dir = join(appData, 'Claude', 'claude-code', v!, build!)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'claude.exe'), 'MZ')
    }
    const found = claudeDesktopBundle({ platform: 'win32', appData })
    expect(found.map((p) => p.split(/[\\/]/).slice(-3).join('/'))).toEqual([
      '2.1.290/bbb/claude.exe',
      '2.1.286/aaa/claude.exe',
    ])
    expect(claudeDesktopBundle({ platform: 'linux', appData })).toEqual([])
  })
})

describe('probe checks', () => {
  it('parses auth status JSON and never keeps email or organization', () => {
    const s = parseAuthStatus(metaStdout('auth-status.txt'))
    expect(s).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'example',
    })
    expect(parseAuthStatus(metaStdout('auth-status-logged-out.txt'))?.loggedIn).toBe(false)
    expect(parseAuthStatus('Login method: Claude Example Plan account')).toBeUndefined()
  })

  it('maps auth status to checks (pass, logged out, API key override)', () => {
    const ok = authChecks(
      { code: 0, stdout: metaStdout('auth-status.txt'), stderr: '', timedOut: false },
      {},
      1,
    )
    expect(ok.checks.map((c) => [c.id, c.status])).toEqual([
      ['vendor.claude.auth', 'pass'],
      ['vendor.claude.env', 'pass'],
    ])
    expect(ok.account).toEqual({ method: 'claude.ai', plan: 'example' })
    expect(JSON.stringify(ok)).not.toMatch(/example\.invalid|orgId/)

    const out = authChecks(
      { code: 1, stdout: metaStdout('auth-status-logged-out.txt'), stderr: '', timedOut: false },
      {},
      1,
    )
    expect(out.checks[0]).toMatchObject({ status: 'fail', blocking: true, category: 'auth_required' })
    expect(out.checks[0]!.recovery[0]).toMatchObject({ kind: 'shell_copy', command: 'claude auth login' })

    // The key is the login itself (authMethod api_key) → no warning.
    const key = authChecks(
      { code: 0, stdout: metaStdout('auth-status-api-key-env.txt'), stderr: '', timedOut: false },
      { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxxxxxx' },
      1,
    )
    expect(key.checks.find((c) => c.id === 'vendor.claude.env')).toMatchObject({ status: 'pass' })

    // The key is set but Claude Code reports another login: the key would override it → warn.
    const override = authChecks(
      { code: 0, stdout: metaStdout('auth-status.txt'), stderr: '', timedOut: false },
      { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxxxxxx' },
      1,
    )
    const env = override.checks.find((c) => c.id === 'vendor.claude.env')
    expect(env).toMatchObject({ status: 'warn', blocking: false })
    expect(env?.recovery[0]).toMatchObject({ kind: 'shell_copy', id: 'claude.unset-key' })
  })

  it('an unreadable auth status never echoes stdout (the text form prints email and organization)', () => {
    const r = authChecks(
      {
        code: 0,
        stdout: metaStdout('auth-status-text.txt').replace('Example Organization', 'Acme Rockets Ltd'),
        stderr: 'Email: someone@corp.invalid\nwarning: legacy output format',
        timedOut: false,
      },
      {},
      1,
    )
    const auth = r.checks.find((c) => c.id === 'vendor.claude.auth')
    expect(auth).toMatchObject({ status: 'warn' })
    expect(auth?.detail).toMatch(/not the expected JSON; warning: legacy output format/)
    expect(JSON.stringify(r)).not.toMatch(/Acme|Organization|Email|example\.invalid|corp\.invalid/)
  })

  it('applies the version floor, recommendation and testedUpTo', () => {
    expect(versionCheck('2.1.280', 1)).toMatchObject({ status: 'fail', category: 'cli_version' })
    expect(versionCheck('2.1.281', 1).status).toBe('warn')
    // The recommendation is the re-recorded 2.1.289 (it was 2.1.287), so 2.1.287 now warns.
    expect(versionCheck('2.1.287', 1).status).toBe('warn')
    expect(versionCheck('2.1.288', 1).status).toBe('warn')
    expect(versionCheck('2.1.289', 1).status).toBe('pass')
    const newer = versionCheck('2.2.0', 1)
    expect(newer.status).toBe('warn')
    expect(newer.recovery[0]).toMatchObject({ command: 'npm install -g @anthropic-ai/claude-code@2.1.289' })
    expect(planCheck('2.1.289', 1).status).toBe('pass')
  })

  it('reports a missing binary with install actions', () => {
    const c = binCheck(undefined, [], 1)
    expect(c).toMatchObject({ id: 'vendor.claude.bin', status: 'fail', category: 'cli_missing' })
    expect(c.recovery.map((a) => a.kind)).toEqual([
      'shell_copy',
      'settings_link',
      'switch_vendor',
      'open_docs',
    ])
  })

  it('disallowed flags in the vendor settings fail the protocol check before any spawn', () => {
    const c = protocolConfigCheck('flagMap may not rename --disallowedTools to --allowedTools', 1)
    expect(c).toMatchObject({ id: 'vendor.claude.protocol', status: 'fail', category: 'config_invalid' })
    expect(c.recovery[0]).toMatchObject({ kind: 'settings_link', pointer: '/vendors/claude' })
  })

  it('a handshake without a reply is flag drift', () => {
    const fail = protocolCheck(
      { ok: false, models: [], ms: 15000, unexpected: [], error: 'no reply', stderr: [] },
      1,
    )
    expect(fail).toMatchObject({ status: 'fail', category: 'flag_drift' })
    const pass = protocolCheck(
      { ok: true, models: [{ id: 'opus', source: 'cli' }], ms: 1500, unexpected: [], stderr: [] },
      1,
    )
    expect(pass.status).toBe('pass')
  })

  it('maps initialize models (C16)', () => {
    expect(
      toModelInfo({
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5-5',
        displayName: 'Sonnet 5.5',
        description: '',
        supportedEffortLevels: ['low', 'high'],
      }),
    ).toEqual({
      id: 'sonnet',
      label: 'Sonnet 5.5',
      aliases: ['claude-sonnet-5-5'],
      efforts: ['low', 'high'],
      source: 'cli',
    })
  })
})

describe('canResume transcript lookup', () => {
  it('encodes the cwd like Claude Code', () => {
    expect(encodeProjectDir('C:\\_Dev\\AI\\DimFactory')).toBe('C---Dev-AI-DimFactory')
    expect(transcriptPath('/cfg', '/home/u/p', 'abc').replace(/\\/g, '/')).toBe(
      '/cfg/projects/-home-u-p/abc.jsonl',
    )
  })

  it('finds an existing transcript and rejects path-like ids', () => {
    const cfg = tmp()
    const cwd = tmp()
    const file = transcriptPath(cfg, cwd, 'sess-1')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}\n')
    expect(findTranscript(cfg, cwd, 'sess-1')).toMatchObject({ ok: true })
    expect(findTranscript(cfg, cwd, 'sess-2')).toMatchObject({ ok: false, reason: 'missing' })
    expect(findTranscript(cfg, cwd, '../x')).toMatchObject({ ok: false, reason: 'invalid-id' })
  })

  it('adapter.canResume honours CLAUDE_CONFIG_DIR', async () => {
    const cfg = tmp()
    const cwd = tmp()
    const file = transcriptPath(cfg, cwd, 'abc')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}\n')
    const a = createClaudeAdapter({ env: { CLAUDE_CONFIG_DIR: cfg }, home: tmp() })
    await expect(a.canResume('abc', cwd)).resolves.toEqual({ ok: true })
    await expect(a.canResume('nope', cwd)).resolves.toEqual({ ok: false, reason: 'cannot-resume' })
  })
})

describe('claude-allow-rules scan (read-only tool cut)', () => {
  it('classifies shell rules', () => {
    for (const r of [
      'Bash(git status)',
      'Bash(git status:*)',
      'PowerShell(Get-ChildItem:*)',
      'Bash(ls *)',
      'Bash(git diff)',
      'Bash(git log --oneline -5)',
      'Bash(rg TODO src)',
      'Bash(tree -L 2)',
      'Read',
    ]) {
      expect(isReadOnlyShellRule(r), r).toBe(true)
    }
    for (const r of [
      'Bash',
      'Bash(*)',
      'Bash(npx vitest:*)',
      'Bash(npm run *)',
      'Bash(git status; rm -rf x)',
      'Bash(git branch:*)',
    ]) {
      expect(isReadOnlyShellRule(r), r).toBe(false)
    }
  })

  it('wildcards on commands with write/exec flags are not read-only (rg --pre, --output, tree -o)', () => {
    for (const r of [
      'Bash(rg:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show *)',
      'Bash(tree:*)',
      'Bash(rg --pre ./script.sh pat)',
      'Bash(rg --pre=./script.sh pat)',
      'Bash(git diff --output=out.txt)',
      'Bash(git log --output out.txt)',
      'Bash(git show --ext-diff HEAD)',
      'Bash(tree -o out.txt)',
      'Bash(tree -aR)',
    ]) {
      expect(isReadOnlyShellRule(r), r).toBe(false)
    }
  })

  it('scans user, project and local settings', () => {
    const cfg = tmp()
    const cwd = tmp()
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(
      join(cfg, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git status:*)', 'Bash(rg:*)'] } }),
    )
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm run build)'] } }),
    )
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json')
    expect(scanShellAllowRules(cwd, cfg).map((r) => r.rule)).toEqual(['Bash(rg:*)', 'Bash(npm run build)'])
  })

  it('readiness warns and support() gives the mode copy', async () => {
    const home = tmp()
    const cwd = tmp()
    mkdirSync(join(home, '.claude'))
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(make:*)'] } }),
    )
    const a = createClaudeAdapter({ env: {}, home })
    const review = await a.readiness(cwd, {
      pass: 'review',
      mode: 'readonly',
      planNative: false,
      trustFolder: false,
    })
    expect(review.map((c) => [c.id, c.status])).toEqual([
      ['pass.review.readiness.mode', 'pass'],
      ['pass.review.readiness.claude-allow-rules', 'warn'],
    ])
    const impl = await a.readiness(cwd, {
      pass: 'implement',
      mode: 'autoedit',
      planNative: false,
      trustFolder: false,
      resumeSessionId: 'missing',
    })
    expect(impl.map((c) => [c.id, c.status])).toEqual([
      ['pass.implement.readiness.mode', 'pass'],
      ['pass.implement.readiness.resume', 'skip'],
    ])
    expect(a.support({ pass: 'plan', mode: 'readonly', planNative: true, trustFolder: false }).copy).toMatch(
      /plan mode/,
    )
    expect(
      a.support({ pass: 'review', mode: 'autoedit', planNative: false, trustFolder: false }).copy,
    ).toMatch(/read-only/)
  })
})

describe('dev CLI', () => {
  const run = async (args: string[]): Promise<{ code: number; out: string[] }> => {
    const out: string[] = []
    const code = await main(args, (s) => out.push(s))
    return { code, out }
  }

  it('registers the Claude adapter in place of its stub', () => {
    expect(getAdapter('claude')?.versionFloor).toBe('2.1.281')
  })

  it('normalize prints events and signals as NDJSON', async () => {
    // C04e-ask-deny-twice is C04b's first recording (two asks); the live C04b asks once.
    const { code, out } = await run([
      'normalize',
      'claude',
      join(STDIO, 'C04e-ask-deny-twice', 'recording.jsonl'),
    ])
    expect(code).toBe(0)
    const lines = out.map((l) => JSON.parse(l) as { type: string })
    expect(lines.filter((l) => l.type === 'ask')).toHaveLength(2)
    expect(lines.filter((l) => l.type === 'done')).toHaveLength(1)
    expect(lines.some((l) => l.type === 'liveness' || l.type === 'stdin')).toBe(false)
    // The live C04b (2026-10-12): the model stops after the first denied call.
    const live = await run(['normalize', 'claude', join(STDIO, 'C04b-ask-deny', 'recording.jsonl')])
    expect(live.code).toBe(0)
    const liveLines = live.out.map((l) => JSON.parse(l) as { type: string })
    expect(liveLines.filter((l) => l.type === 'ask')).toHaveLength(1)
    expect(liveLines.filter((l) => l.type === 'done')).toHaveLength(1)
  })

  it('normalize accepts a plain stdout capture', async () => {
    const dir = tmp()
    const file = join(dir, 'stdout.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\nnot json\n`)
    const { code, out } = await run(['normalize', 'claude', file, '--liveness'])
    expect(code).toBe(0)
    expect(out.map((l) => (JSON.parse(l) as { type: string }).type)).toContain('session')
  })

  it('later commands say when they arrive; bad usage exits 2', async () => {
    // `run` and `gc` are real commands: a missing task is a usage error, and so is an unknown option.
    expect((await run(['run', 'x'])).code).toBe(2)
    expect((await run(['gc', '--bogus'])).code).toBe(2)
    expect((await run(['normalize'])).code).toBe(2)
    expect((await run(['bogus'])).code).toBe(2)
    expect((await run([])).code).toBe(0)
  })

  it('formats probe results and exits 0 only without failures', () => {
    const r = {
      vendor: 'claude',
      at: 1,
      ok: true,
      checks: [versionCheck('2.1.289', 1), versionCheck('2.1.281', 1)],
      capabilities: claudeCapabilities(),
      models: [{ id: 'opus', source: 'cli' as const }],
    }
    expect(probeExitCode(r)).toBe(0)
    expect(formatProbe(r, 'Claude')).toMatch(/ready, with warnings[\s\S]*WARN {2}vendor\.claude\.version/)
    expect(probeExitCode({ ...r, checks: [versionCheck('1.0.0', 1)] })).toBe(1)
  })
})
