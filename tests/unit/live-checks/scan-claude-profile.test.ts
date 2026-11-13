// scripts/scan-profile-leaks.mjs --claude-config (the live re-record; tests/fixtures/claude/
// README.md "Redaction"): the review scan before live Claude data is committed looks for what the recording profile's
// own files name (its hook commands, CLAUDE.md lines, the synced skills' folder and, with names, the user's skills and
// agents), counts only. All values here are fake; the credential and account files are never read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanFiles, scanMatchers } from '../../../scripts/scan-profile-leaks.mjs'

const HOOK = 'node C:/fake/hooks/notify-me.js'
const MEMORY = 'Always sign every answer as the fake person.'
const BUCKET = '11111111-2222-4333-8444-555555555555_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ONLY_IN_CREDENTIALS = 'fake-token-never-read-0000'

let root = ''
let config = ''
let repo = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-claude-'))
  config = join(root, 'claude-config')
  repo = join(root, 'repo')
  const put = (base: string, rel: string, text: string): void => {
    const p = join(base, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  put(config, 'agents/fake-reviewer.md', '---\nname: fake-reviewer\n---\n')
  put(
    config,
    'settings.json',
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } }),
  )
  put(config, 'CLAUDE.md', `- ${MEMORY}\n`)
  put(config, `skills/synced/${BUCKET}/docs/SKILL.md`, '---\nname: docs\n---\n')
  put(config, '.credentials.json', JSON.stringify({ token: ONLY_IN_CREDENTIALS }))
  put(repo, 'tests/fixtures/claude/stdio/x/recording.jsonl', `{"line":"ran ${HOOK} for fake-reviewer"}\n`)
  put(repo, 'docs/notes.md', `${MEMORY}\nsynced to ${BUCKET}\n${ONLY_IN_CREDENTIALS}\n`)
  put(repo, 'src/clean.ts', 'export const docs = "plain words: docs, run, review"\n')
  // A frame that names one of the account's ids alone (the synced folder joins two of them).
  const [org, account] = BUCKET.split('_')
  put(repo, 'ids/org.json', JSON.stringify({ organization_uuid: org }))
  put(repo, 'ids/account.json', JSON.stringify({ account_uuid: account?.toUpperCase() }))
  put(repo, 'ids/other.json', JSON.stringify({ account_uuid: '99999999-2222-4333-8444-555555555555' }))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the review scan, Claude profile', () => {
  it('finds the profile’s terms and, with names, its names; counts only', () => {
    const matchers = scanMatchers({ claudeConfig: config, names: true, home: root })
    const { found } = scanFiles(repo, ['tests', 'docs', 'src'], matchers)
    expect(found).toEqual([
      // The memory line, and the synced folder's name once whole and once by each of its two ids.
      { file: 'docs/notes.md', kind: 'claude-term', count: 4 },
      { file: 'tests/fixtures/claude/stdio/x/recording.jsonl', kind: 'claude-term', count: 1 },
      { file: 'tests/fixtures/claude/stdio/x/recording.jsonl', kind: 'claude-name', count: 1 },
    ])
  })

  it('finds a lone account id of the synced folder’s name, in any case; not another id', () => {
    const matchers = scanMatchers({ claudeConfig: config, home: root })
    const { found } = scanFiles(repo, ['ids'], matchers)
    expect(found).toEqual([
      { file: 'ids/account.json', kind: 'claude-term', count: 1 },
      { file: 'ids/org.json', kind: 'claude-term', count: 1 },
    ])
  })

  it('without --names only the verbatim terms; never what only the credential file holds', () => {
    const matchers = scanMatchers({ claudeConfig: config, home: root })
    expect(matchers.map((m) => m.kind)).not.toContain('claude-name')
    for (const m of matchers) expect(m.re.source).not.toContain('never-read')
    const { found } = scanFiles(repo, ['src'], matchers)
    expect(found).toEqual([])
  })
})
