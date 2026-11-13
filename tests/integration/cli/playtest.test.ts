// The command-line tool has no Electron, so Dim Factory's own play-test cannot play a game there: a run whose Verify
// has the play-test (a game folder with a playtest.json) reports "Not checked here" for it, which is no failure and no
// finding, and the run completes. The footer says so in one line.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME } from '../../../src/shared/playtest.ts'
import { CLI_ENTRY, cleanup, git, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      reject(new Error(`dimf timed out\n${stdout}\n${stderr}`))
    }, 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

describe('dimf run: a game play-test', () => {
  it('reports the play-test as not checked here, and the run completes', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C04a-ask-allow',
          write: { path: 'index.html', content: '<!doctype html><canvas></canvas>\n' },
        },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    writeFileSync(
      join(folder, 'playtest.json'),
      JSON.stringify({
        version: 1,
        scenarios: [{ name: 'Space starts the game', steps: [{ key: 'Space' }] }],
      }),
    )
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    writeFileSync(
      join(folder, '.dimfactory', 'dimfactory.json'),
      JSON.stringify({
        verify: {
          enabled: true,
          runAfter: ['implement'],
          commands: [{ name: PLAYTEST_COMMAND_NAME, run: [...PLAYTEST_ARGV] }],
        },
      }),
    )
    git(folder, 'add', '-A')
    git(folder, 'commit', '-q', '-m', 'a game with a playtest')
    const r = await cli([
      'run',
      folder,
      'make the game start',
      '--gates',
      'approve',
      '--asks',
      'allow',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(
      /Play-test\s+skipped\s+Not checked here: the play-test needs the Dim Factory app/,
    )
    const runs = join(home, 'runs')
    const id = readdirSync(runs, { withFileTypes: true }).find((d) => d.isDirectory())?.name ?? ''
    const run = JSON.parse(readFileSync(join(runs, id, 'run.json'), 'utf8')) as {
      state: {
        status: string
        steps: Record<
          string,
          { status: string; verify?: { commands: { name: string; status: string; reason?: string }[] } }
        >
      }
    }
    expect(run.state.status).toBe('completed')
    const c = run.state.steps['verify:1']?.verify?.commands.find((x) => x.name === PLAYTEST_COMMAND_NAME)
    expect(c).toMatchObject({ status: 'skipped' })
    expect(c?.reason).toMatch(/^Not checked here/)
    const findings = JSON.parse(readFileSync(join(runs, id, 'findings.json'), 'utf8')) as unknown
    expect(JSON.stringify(findings)).not.toContain(PLAYTEST_COMMAND_NAME)
  }, 150_000)
})
