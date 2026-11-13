// Folder trust from the dev CLI (trust.json `vendorFolder`; the CLI prints what the app's buttons
// do, src/cli/hints.ts): `dimf config trust <folder> vendorFolder --vendor gemini` writes the grant (and
// `--revoke` takes it back); a vendor that never asks for folder trust, or a missing --vendor, is a usage error with
// nothing written; the snag's grant prints that command.
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { RecoveryAction } from '../../../../src/shared/failure.ts'
import { recoveryHint, shellArg } from '../../../../src/cli/hints.ts'
import { CLI_ENTRY, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../../run/scenario.ts'
import { trustJsonOnDisk } from './helpers.ts'

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
      reject(new Error(`dimf ${args.join(' ')} timed out\n${stdout}\n${stderr}`))
    }, 90_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end()
  })
}

const vendorFolder = (home: string): unknown => {
  const folders = (trustJsonOnDisk(home)?.['folders'] ?? {}) as Record<
    string,
    { grants?: Record<string, unknown> }
  >
  return Object.values(folders)[0]?.grants?.['vendorFolder']
}

describe('dimf config trust … vendorFolder', () => {
  it('writes the Gemini grant, revokes it, and refuses what is not a folder-trust vendor', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)

    const noVendor = await cli(['config', 'trust', folder, 'vendorFolder', '--home', home])
    expect(noVendor.code).toBe(2)
    expect(noVendor.stderr).toContain('vendorFolder needs --vendor <id>')
    const claude = await cli([
      'config',
      'trust',
      folder,
      'vendorFolder',
      '--vendor',
      'claude',
      '--home',
      home,
    ])
    expect(claude.code).toBe(2)
    expect(claude.stderr).toContain('claude does not ask Dim Factory to trust folders')
    expect(trustJsonOnDisk(home)).toBeNull()

    const t = await cli(['config', 'trust', folder, 'vendorFolder', '--vendor', 'gemini', '--home', home])
    expect(t.code, t.stdout + t.stderr).toBe(0)
    expect(t.stdout).toMatch(
      /Allowed for .*: the vendor works in this folder without its own folder-trust prompt \(gemini\)\./,
    )
    expect(vendorFolder(home)).toEqual({ gemini: { at: expect.any(Number) as number } })

    const r = await cli([
      'config',
      'trust',
      folder,
      'vendorFolder',
      '--vendor',
      'gemini',
      '--revoke',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Revoked for .*: vendorFolder \(gemini\)\./)
    expect(vendorFolder(home)).toBeUndefined()
  }, 180_000)

  it('the grant a snag or a check offers prints that command in a terminal', () => {
    const folder = process.platform === 'win32' ? 'C:\\work\\my app' : '/work/my app'
    const a: Extract<RecoveryAction, { kind: 'grant' }> = {
      id: 'implement:grant-vendorFolder',
      label: 'Trust this folder for Gemini',
      kind: 'grant',
      grant: 'vendorFolder',
      vendor: 'gemini',
      detail: '',
    }
    expect(recoveryHint(a, { cli: 'dimf', folder, home: 'C:\\h' })).toBe(
      `dimf config trust ${shellArg(folder)} vendorFolder --vendor gemini --home ${shellArg('C:\\h')}`,
    )
    const { vendor: _v, ...noVendor } = a
    expect(recoveryHint(noVendor as RecoveryAction, { cli: 'dimf', folder })).toBeUndefined()
  })
})
