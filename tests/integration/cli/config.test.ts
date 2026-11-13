// Config from the dev CLI: `dimf config resolve` (user + project + run layering
// with provenance badges and file:line), `run --set` on any run-override path, the done-check flow (a typo'd key in
// the user dimfactory.json blocks `run` with a message that says how to fix it; fixed, the run proceeds and first
// launch picks claude-only), `config restore` (Restore last good) and `config trust <folder> projectAuto`.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageError, parseSets } from '../../../src/cli/args.ts'
import { shellArg } from '../../../src/cli/hints.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import {
  CLI_ENTRY,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
} from '../run/scenario.ts'

const dirs: string[] = []
afterEach(async () => {
  // Retried while Windows still holds a folder (a git child of a live check that hit its budget, still exiting).
  const list = dirs.splice(0)
  for (let attempt = 0; ; attempt++) {
    try {
      cleanup(...list)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 60 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw err
      await delay(250)
    }
  }
})

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[], o: { timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: hermeticEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dimf ${args.join(' ')} timed out\n${stdout}\n${stderr}`))
    }, o.timeoutMs ?? 90_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The `vendors` JSON makeHome wrote (the fake Claude), to rebuild the user file around it. */
const vendorsOf = (userFile: string): string =>
  JSON.stringify((JSON.parse(readFileSync(userFile, 'utf8')) as { vendors: unknown }).vendors)

describe('--set accepts any run-override path', () => {
  it('passes, gates, planning, isolation and verify; JSON, text and lists; typos get a suggestion', () => {
    expect(
      parseSets([
        'review.model=opus',
        'passes.fix.inherit=null',
        'fix.vendor=claude',
        'planning.native=off',
        'verify.runAfter=implement,fix',
        'isolation.worktree.copy=[".env"]',
        'isolation.worktree.install=never',
        'gates.beforeFix=true',
        'profile=thorough',
        'critic.promptTemplate=critic-strict',
      ]),
    ).toEqual({
      passes: {
        review: { model: 'opus' },
        fix: { inherit: null, vendor: 'claude' },
        critic: { promptTemplate: 'critic-strict' },
      },
      planning: { native: 'off' },
      verify: { runAfter: ['implement', 'fix'] },
      isolation: { worktree: { copy: ['.env'], install: 'never' } },
      gates: { beforeFix: true },
      profile: 'thorough',
    })
    expect(() => parseSets(['plan.modle=opus'])).toThrow(/unknown key "modle" \(did you mean "model"\?\)/)
    expect(() => parseSets(['timeouts.askMs=1000'])).toThrow(/"timeouts" is not a run setting/)
    expect(() => parseSets(['vendors.claude.path=x'])).toThrow(UsageError)
    expect(() => parseSets(['implement.mode=full'])).toThrow(/use --auto instead/)
    expect(() => parseSets(['review.mode=autoedit'])).toThrow(/must be "readonly"/)
    expect(() => parseSets(['planning.native=sometimes'])).toThrow(UsageError)
    expect(() => parseSets(['gates.afterPlan=maybe'])).toThrow(/takes true or false/)
  })
})

describe('dimf config resolve', () => {
  it('prints every value with its source and file:line (user + project + run)', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const userFile = join(home, 'dimfactory.json')
    writeFileSync(
      userFile,
      [
        '{',
        `  "vendors": ${vendorsOf(userFile)},`,
        '  "passes": {',
        '    "review": { "model": "opus" }',
        '  }',
        '}',
      ].join('\n'),
    )
    mkdirSync(join(folder, '.dimfactory'))
    const projectFile = join(folder, '.dimfactory', 'dimfactory.json')
    writeFileSync(projectFile, '{\n  // team\n  "gates": { "beforeFix": true }\n}\n')
    const r = await cli([
      'config',
      'resolve',
      folder,
      '--set',
      'critic.enabled=false',
      '--profile',
      'claude-only',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const line = (key: string, value: string, where: string): RegExp =>
      new RegExp(`^${escape(key)}\\s+${escape(value)}\\s+${escape(where)}$`, 'm')
    expect(r.stdout).toMatch(line('passes.review.model', 'opus', `user (${userFile}:4, passes)`))
    expect(r.stdout).toMatch(line('gates.beforeFix', 'true', `project (${projectFile}:3)`))
    expect(r.stdout).toMatch(line('passes.critic.enabled', 'false', 'run (passes)'))
    expect(r.stdout).toMatch(line('profile', 'claude-only', 'run'))
    expect(r.stdout).toMatch(line('passes.fix.vendor', 'claude', 'inherit (inherit:implement)'))
    expect(r.stdout).toMatch(/^passes\.implement\.model\s+null\s+cli /m)
    expect(r.stdout).toMatch(/^vendors\.claude\.env\.FAKE_CLI_LOG\s+\(set, hidden\)\s+user /m)

    const json = await cli(['config', 'resolve', folder, '--json', '--home', home])
    expect(json.code, json.stderr).toBe(0)
    const v = JSON.parse(json.stdout) as {
      config: { passes: { review: { model: string } } }
      provenance: Record<string, { source: string; line?: number }>
    }
    expect(v.config.passes.review.model).toBe('opus')
    expect(v.provenance['/gates/beforeFix']).toMatchObject({ source: 'project', line: 3 })
    // No vendor was spawned: resolving is read-only and probe-free.
    expect(sc.entries()).toEqual([])
  }, 60_000)
})

describe('done-check: fix a typo from its file:line:col message', () => {
  it('a typo blocks `run` (exit 3) with the position and a suggestion; fixed, the run proceeds', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C04a-ask-allow',
          write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        },
      ],
      reviewModel: 'haiku',
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const userFile = join(home, 'dimfactory.json')
    const vendors = vendorsOf(userFile)
    const typoLine = '    "review": { "modle": "haiku" }'
    const lines = ['{', `  "vendors": ${vendors},`, '  "passes": {', typoLine, '  }', '}']
    writeFileSync(userFile, lines.join('\n'))
    const args = [
      'run',
      folder,
      'add a --version flag',
      '--gates',
      'approve',
      '--asks',
      'allow',
      '--home',
      home,
    ]

    const blocked = await cli(args)
    expect(blocked.code, blocked.stdout + blocked.stderr).toBe(3)
    const col = typoLine.indexOf('"modle"') + 1
    expect(blocked.stderr).toContain('Your dimfactory.json has an error')
    expect(blocked.stderr).toContain(`${userFile}:4:${col} Unknown key "modle" (did you mean "model"?)`)
    expect(blocked.stderr).toContain(`-> Open dimfactory.json at line 4: ${userFile}:4:${col}`)
    // Nothing was spawned (not even a probe): the file that names the binaries is broken.
    expect(sc.entries()).toEqual([])
    expect(readFileSync(userFile, 'utf8')).toBe(lines.join('\n'))

    // The message alone says what to do: rename the key.
    writeFileSync(userFile, lines.join('\n').replace('"modle"', '"model"'))
    const fixed = await cli(args, { timeoutMs: 120_000 })
    expect(fixed.code, fixed.stdout + fixed.stderr).toBe(0)
    expect(fixed.stdout).toMatch(/Run #1 completed/)
    // First launch: Claude ready, Codex not → claude-only, saved in the user file (which keeps everything else).
    expect(fixed.stderr).toMatch(
      /First run: Claude is ready and Codex is not ready, so Dim Factory chose the "claude-only" profile/,
    )
    const user = JSON.parse(readFileSync(userFile, 'utf8')) as { profile?: string; passes?: unknown }
    expect(user.profile).toBe('claude-only')
    expect(user.passes).toEqual({ review: { model: 'haiku' } })
    // Review ran on the user's model.
    expect(passArgvs(sc.entries()).some((a) => a.includes('dontAsk') && a.includes('haiku'))).toBe(true)
  }, 180_000)
})

describe('dimf config restore / trust', () => {
  it('restore puts the last good dimfactory.json back and says it loads', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const userFile = join(home, 'dimfactory.json')
    const good = readFileSync(userFile, 'utf8')
    // A writable core loads the valid file once: that stores the last-good copy.
    const core = await createCore({ home, host: { kind: 'cli' }, env: hermeticEnv() })
    await core.shutdown()
    expect(readFileSync(homePaths(home).lastGoodUserConfig, 'utf8')).toBe(good)
    writeFileSync(userFile, good.replace('"vendors"', '"vendorz"'))

    const resolve = await cli(['config', 'resolve', '--home', home])
    expect(resolve.code).toBe(1)
    expect(resolve.stdout).toMatch(/Unknown key "vendorz" \(did you mean "vendors"\?\)/)
    expect(resolve.stderr).toContain(`config restore --home ${shellArg(home)}`)

    const r = await cli(['config', 'restore', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain(`Restored ${userFile} from the last version that loaded without errors.`)
    expect(r.stdout).toContain('It loads without errors.')
    expect(readFileSync(userFile, 'utf8')).toBe(good)
  }, 60_000)

  it('trust <folder> projectAuto clears the folder.trust.projectAuto block', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    mkdirSync(join(folder, '.dimfactory'))
    writeFileSync(join(folder, '.dimfactory', 'dimfactory.json'), '{ "auto": true }\n')

    const before = await cli(['preflight', folder, '--home', home])
    expect(before.code, before.stdout + before.stderr).toBe(3)
    expect(before.stdout).toMatch(/FAIL folder\.trust\.projectAuto\s+This project turns on Auto mode/)
    expect(before.stdout).toContain(`-> Allow this project's Auto mode: `)
    expect(before.stdout).toContain(`config trust ${shellArg(folder)} projectAuto --home ${shellArg(home)}`)
    expect(before.stdout).toContain('-> Run without Auto mode: run again with --set auto=false')

    const t = await cli(['config', 'trust', folder, 'projectAuto', '--home', home])
    expect(t.code, t.stdout + t.stderr).toBe(0)
    expect(t.stdout).toMatch(/Allowed for .*: the project's dimfactory\.json may turn on Auto mode/)

    const after = await cli(['preflight', folder, '--home', home])
    expect(after.stdout).toMatch(/ok {3}folder\.trust\.projectAuto/)
    expect(after.stdout).not.toMatch(/FAIL folder\.trust\.projectAuto/)
  }, 90_000)
})
