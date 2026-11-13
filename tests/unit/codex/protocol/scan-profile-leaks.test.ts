// scripts/scan-profile-leaks.mjs (live recordings; tests/fixtures/codex/README.md
// "Re-recording live" step 4): the review scan before live data is committed finds what only the recording profile
// names. A unit test once had taken the id of one of the user's real Codex threads as its test id; the scan
// now looks for the profile's own ids (session_index.jsonl, installation_id) besides its terms and the machine. All
// values here are fake; the credential file is never read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { profileIds, scanFiles, scanMatchers, uuidV7Ms } from '../../../../scripts/scan-profile-leaks.mjs'

// Fake UUIDv7 ids: one from before the recording day, one the recording itself made.
const OLD_THREAD = '01900000-0000-7000-8000-00000000aaaa'
const RECORDED_THREAD = '01a20000-0000-7000-8000-00000000bbbb'
const INSTALL = '22222222-3333-4444-8555-666666666666'
const IN_AUTH_ONLY = '99999999-8888-4777-8666-555555555555'
const MCP_COMMAND = 'C:\\fake-tools\\fake-notes-mcp.exe'
const SINCE = Date.parse('2026-10-10T00:00:00Z')

let root: string
let codexHome: string
let repo: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-profile-'))
  codexHome = join(root, 'codex-home')
  repo = join(root, 'repo')
  mkdirSync(codexHome)
  writeFileSync(
    join(codexHome, 'session_index.jsonl'),
    [
      JSON.stringify({ id: OLD_THREAD, thread_name: 'fake title' }),
      JSON.stringify({ id: RECORDED_THREAD, thread_name: 'fake recording' }),
      '',
    ].join('\n'),
  )
  writeFileSync(join(codexHome, 'installation_id'), `${INSTALL}\n`)
  // Never read: an id only the credential file has must not become a term.
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ account_id: IN_AUTH_ONLY }))
  writeFileSync(join(codexHome, 'config.toml'), `[mcp_servers.fake-notes]\ncommand = '${MCP_COMMAND}'\n`)
  for (const d of ['tests/unit', 'tests/fixtures/x', 'docs', 'node_modules/pkg'])
    mkdirSync(join(repo, d), { recursive: true })
  writeFileSync(join(repo, 'tests/unit/a.test.ts'), `const THREAD = '${OLD_THREAD.toUpperCase()}'\n`)
  writeFileSync(join(repo, 'tests/fixtures/x/recording.jsonl'), `{"thread":"${RECORDED_THREAD}"}\n`)
  writeFileSync(
    join(repo, 'docs/notes.md'),
    `ran ${MCP_COMMAND.replace(/\\/g, '/')} as C:\\Users\\fakeperson\\x\n`,
  )
  writeFileSync(join(repo, 'docs/install.json'), JSON.stringify({ id: INSTALL, auth: IN_AUTH_ONLY }))
  writeFileSync(join(repo, 'node_modules/pkg/index.js'), `// ${OLD_THREAD}\n`)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the review scan for what the recording profile names', () => {
  it('reads the profile’s own ids, skipping the recording’s own (v7 from --since on), never auth.json', () => {
    expect(uuidV7Ms(OLD_THREAD)).toBeLessThan(SINCE)
    expect(uuidV7Ms(RECORDED_THREAD)).toBeGreaterThanOrEqual(SINCE)
    expect(uuidV7Ms(INSTALL)).toBeUndefined()
    expect(profileIds(codexHome, SINCE).sort()).toEqual([OLD_THREAD, INSTALL].sort())
    expect(profileIds(codexHome).sort()).toEqual([OLD_THREAD, RECORDED_THREAD, INSTALL].sort())
  })

  it('counts per file and kind, never a value; skips dependencies', () => {
    const matchers = scanMatchers({
      codexHome,
      since: SINCE,
      home: 'C:\\Users\\fakeperson',
      user: 'fakeperson',
      host: 'FAKE-HOST-01',
    })
    const r = scanFiles(repo, ['tests', 'docs', 'node_modules'], matchers)
    expect(r.found).toEqual([
      { file: 'docs/install.json', kind: 'profile-id', count: 1 },
      { file: 'docs/notes.md', kind: 'profile-term', count: 1 },
      { file: 'docs/notes.md', kind: 'user-name', count: 1 },
      { file: 'tests/unit/a.test.ts', kind: 'profile-id', count: 1 },
    ])
    expect(JSON.stringify(r)).not.toContain(OLD_THREAD)
    expect(JSON.stringify(r)).not.toContain('fake-notes')
    expect(r.scanned).toBe(4)
  })
})
