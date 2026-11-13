// Run branch through the dev CLI: `dimf run --run-branch` is
// `isolation.branch=runBranch` for the run (it used to be refused). The run makes its branch at the pre-Implement
// boundary, completes, and run.json records it; the user's branch stays where it was.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLI_ENTRY, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import { gitOut, versionWrite } from './helpers.ts'

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

function cli(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: hermeticEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dimf ${args[0]} timed out\n${out}`))
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
    child.stdin.end('')
  })
}

describe('dimf run --run-branch', () => {
  it('makes the run branch at Implement and records it; the previous branch stays at base', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const prev = gitOut(folder, 'symbolic-ref', 'HEAD')
    const base = gitOut(folder, 'rev-parse', 'HEAD')

    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--run-branch',
      '--gates',
      'approve',
      '--home',
      home,
    ])
    expect(r.code, r.out).toBe(0)

    const ids = readdirSync(join(home, 'runs'), { withFileTypes: true }).filter((d) => d.isDirectory())
    expect(ids).toHaveLength(1)
    const run = JSON.parse(readFileSync(join(home, 'runs', ids[0]?.name ?? '', 'run.json'), 'utf8')) as {
      state: { status: string; branch?: { name: string; base: string; previous: string } }
    }
    expect(run.state.status).toBe('completed')
    const branch = run.state.branch
    expect(branch?.name).toMatch(/^dim\/\d{8}-add-a-version-flag$/)
    expect(branch).toEqual({ name: branch?.name, base, previous: prev })
    expect(gitOut(folder, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branch?.name}`)
    expect(gitOut(folder, 'rev-parse', prev)).toBe(base)
    expect(readFileSync(join(folder, 'src/version.ts'), 'utf8')).toBe(versionWrite.content)
  }, 240_000)
})
