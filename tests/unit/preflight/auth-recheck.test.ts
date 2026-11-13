// claudeAuthRechecker: `claude auth status` through proc, mapped by the adapter's authChecks.
// A node script stands in for the CLI (prints the JSON the real one prints; exit 1 when logged out).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolveResult } from '@core/proc/resolve-cli.ts'
import { authRecheckers, claudeAuthRechecker } from '@core/preflight/checks/vendor.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dim-factory-auth-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeCli(body: string): { resolveBinary: () => Promise<ResolveResult>; argvFile: string } {
  const script = join(dir, 'claude.mjs')
  const argvFile = join(dir, 'argv.json')
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n${body}\n`,
  )
  const result: ResolveResult = {
    ok: true,
    candidates: [script],
    rejected: [],
    cli: {
      vendor: 'claude',
      command: process.execPath,
      prefixArgs: [script],
      kind: 'node-entry',
      version: '2.1.289',
      source: 'config',
      pathPrepend: [],
      warnings: [],
      path: script,
      target: script,
      mtimeMs: 0,
      size: 0,
    },
  }
  return { resolveBinary: () => Promise.resolve(result), argvFile }
}

const opts = {
  env: { PATH: process.env['PATH'] ?? '' },
  pathEnv: process.env['PATH'] ?? '',
  home: tmpdir(),
  now: () => 7,
}

describe('claudeAuthRechecker', () => {
  it('logged out → vendor.claude.auth fails with auth_required', async () => {
    const cli = fakeCli(`process.stdout.write('{"loggedIn": false}'); process.exit(1)`)
    const checks = await claudeAuthRechecker(cli, opts)('claude', { timeoutMs: 10_000 })
    expect(checks.find((c) => c.id === 'vendor.claude.auth')).toMatchObject({
      status: 'fail',
      category: 'auth_required',
      at: 7,
    })
    expect(checks.find((c) => c.id === 'vendor.claude.env')?.status).toBe('pass')
  })

  it('logged in → pass; runs `auth status` after the prefix args', async () => {
    const cli = fakeCli(
      `process.stdout.write('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}')`,
    )
    const checks = await claudeAuthRechecker(cli, opts)('claude', { timeoutMs: 10_000 })
    expect(checks.find((c) => c.id === 'vendor.claude.auth')).toMatchObject({
      status: 'pass',
      detail: 'claude.ai (max)',
    })
    expect(JSON.parse(readFileSync(cli.argvFile, 'utf8'))).toEqual(['auth', 'status'])
  })

  it('a timeout or an unresolved binary keeps the previous result ([])', async () => {
    const slow = fakeCli(`setTimeout(() => {}, 5000)`)
    expect(await claudeAuthRechecker(slow, opts)('claude', { timeoutMs: 200 })).toEqual([])
    const missing = {
      resolveBinary: () => Promise.resolve({ ok: false, rejected: [], candidates: [] } as ResolveResult),
    }
    expect(await claudeAuthRechecker(missing, opts)('claude', { timeoutMs: 200 })).toEqual([])
    expect(await claudeAuthRechecker(slow, opts)('codex', { timeoutMs: 200 })).toEqual([])
  })

  it('authRecheckers dispatches by vendor', async () => {
    const r = authRecheckers({ claude: () => Promise.resolve([]) })
    await expect(r('claude', { timeoutMs: 1 })).resolves.toEqual([])
    await expect(r('gemini', { timeoutMs: 1 })).resolves.toEqual([])
  })
})
