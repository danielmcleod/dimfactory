// `dimf match` as a subprocess against the fake Claude: `start` follows both sides until each has built and exits 5
// (they wait to be applied or discarded), naming the runs to resume; `show` and `list` read the record afterwards;
// usage errors exit 2 before anything is started.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MatchView } from '../../../src/shared/match.ts'
import { CLI_ENTRY, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[], timeoutMs = 240_000): Promise<CliResult> {
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
      reject(new Error(`dimf ${args.slice(0, 2).join(' ')} timed out\n${stdout}\n${stderr}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

const write = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

async function world(): Promise<{ home: string; folder: string }> {
  const sc = await makeScenario({
    plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
    implement: [
      { recording: 'C08a-session-id-implement', write },
      { recording: 'C08a-session-id-implement', write },
    ],
  })
  const { home } = await makeHome(sc)
  const folder = makeSandbox({ git: false })
  writeFileSync(join(folder, 'not-in-git.txt'), 'plain folder\n')
  dirs.push(home, sc.dir, folder)
  return { home, folder }
}

const SETS = [
  '--set',
  'profile=claude-only',
  '--set',
  'gates.afterPlan=false',
  '--set',
  'gates.beforeFix=false',
  '--set',
  'isolation.worktree.install=never',
  '--set',
  'verify.enabled=false',
]

describe('dimf match (subprocess, fake Claude)', () => {
  it('start follows both sides until they have built, then show and list read the record', async () => {
    const { home, folder } = await world()
    const none = await cli(['match', 'list', '--home', home])
    expect(none).toMatchObject({ code: 0, stdout: 'No matches.\n' })

    const r = await cli([
      'match',
      'start',
      folder,
      'add a --version flag',
      '--a',
      'claude',
      '--b',
      'claude:opus',
      ...SETS,
      '--home',
      home,
    ])
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(5)
    expect(r.stdout).toMatch(/^Match \d{8}T\d{6}Z-[0-9a-f]{4} in /)
    expect(r.stdout).toContain('Side A (Claude Code, run #1)')
    expect(r.stdout).toContain('Side B (Claude Code (opus), run #2)')
    expect(r.stdout).toContain('both sides built')
    expect(r.stdout.match(/built, not applied/g)).toHaveLength(2)
    const resumes = [...r.stdout.matchAll(/ resume (\d{8}T\d{6}Z-[0-9a-f]{4})/g)].map((m) => m[1])
    expect(resumes).toHaveLength(2)
    // Nothing reached the folder: both results are in their copies.
    expect(existsSync(join(folder, 'src', 'version.ts'))).toBe(false)
    for (const id of resumes) {
      expect(existsSync(join(home, 'worktrees', id ?? '', 'src', 'version.ts'))).toBe(true)
      expect(existsSync(join(home, 'worktrees', id ?? '', 'not-in-git.txt'))).toBe(true)
    }

    const matchId = /^Match (\S+) in /.exec(r.stdout)?.[1] ?? ''
    const show = await cli(['match', 'show', matchId, '--json', '--home', home])
    expect(show.code).toBe(0)
    const view = JSON.parse(show.stdout) as MatchView
    expect(view).toMatchObject({ matchId, kind: 'headToHead', ready: true, ended: false, folder })
    expect(view.sides.map((s) => s.runId)).toEqual(resumes)
    expect(view.sides[1].contestant).toEqual({ vendor: 'claude', model: 'opus' })

    const list = await cli(['match', 'list', '--home', home])
    expect(list.code).toBe(0)
    expect(list.stdout).toContain(`Match ${matchId}`)
    expect(list.stdout).toContain('add a --version flag')
  }, 300_000)

  it('usage errors start nothing', async () => {
    const { home, folder } = await world()
    const noB = await cli(['match', 'start', folder, 'a task', '--a', 'claude', '--home', home])
    expect(noB.code).toBe(2)
    expect(noB.stderr).toContain('--b names who builds that side')
    const unknown = await cli([
      'match',
      'start',
      folder,
      'a task',
      '--a',
      'claude',
      '--b',
      'nobody',
      '--home',
      home,
    ])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('Side B: nobody is not a vendor Dim Factory knows.')
    const sub = await cli(['match', 'begin'])
    expect(sub.code).toBe(2)
    expect(sub.stderr).toContain('expected start, show or list')
    const missing = await cli(['match', 'show', '20260101T000000Z-0000', '--home', home])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('That match is not here any more.')
    expect((await cli(['match', 'list', '--home', home])).stdout).toBe('No matches.\n')
  }, 120_000)
})
