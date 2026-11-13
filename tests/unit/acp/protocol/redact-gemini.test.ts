// The recorder's Gemini profile rules (scripts/redact-gemini.mjs: deterministic fixture redaction) and the
// shared stable-id rule they sit on (src/shared/redact.ts ACCOUNT_KEY_PATTERN): the project folder under .gemini/tmp,
// MCP names in tool titles and permission options, the quota's tier and resets, and the terms a profile's own files
// name. Credential files are never opened.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NEVER_READ,
  PROJECT_PLACEHOLDER,
  REDACTED,
  parseJsonc,
  profileTerms,
  readProfileText,
  redactGeminiText,
  redactGeminiValue,
} from '../../../../scripts/redact-gemini.mjs'
import { ACCOUNT_KEY_PATTERN, redactJsonValue } from '../../../../src/shared/redact.ts'
import { allFixtures, message } from './fixtures.ts'

const twice = (v: unknown): unknown => redactGeminiValue(redactGeminiValue(v).value).value

describe('the project folder under .gemini/tmp', () => {
  it.each([
    [
      '/home/u/.gemini/tmp/3f2a9c0d1e/chats/session.json',
      `/home/u/.gemini/tmp/${PROJECT_PLACEHOLDER}/chats/session.json`,
    ],
    [
      'C:\\Users\\u\\.gemini\\tmp\\ts-small\\plans\\a.md',
      `C:\\Users\\u\\.gemini\\tmp\\${PROJECT_PLACEHOLDER}\\plans\\a.md`,
    ],
    ['<GEMINI_CLI_HOME>/.gemini/history/abc123', `<GEMINI_CLI_HOME>/.gemini/history/${PROJECT_PLACEHOLDER}`],
  ])('%s', (input, want) => {
    expect(redactGeminiText(input)).toBe(want)
    expect(redactGeminiValue({ path: input })).toEqual({
      value: { path: want },
      counts: { 'gemini-project': 1 },
    })
    expect(redactGeminiText(want)).toBe(want)
  })

  it('JSON-escaped once and twice (a raw line)', () => {
    const line = JSON.stringify({ a: 'x\\.gemini\\tmp\\deadbeef\\f' })
    expect(redactGeminiText(line)).toContain(`\\\\.gemini\\\\tmp\\\\${PROJECT_PLACEHOLDER}\\\\f`)
    expect(redactGeminiText(JSON.stringify(line))).not.toContain('deadbeef')
  })

  it('leaves other paths alone', () => {
    for (const s of ['/home/u/.gemini/settings.json', 'tmp/x', '.geminix/tmp/y', 'src/tmp/z']) {
      expect(redactGeminiText(s)).toBe(s)
    }
  })
})

describe('MCP names and the quota', () => {
  it('an MCP tool title and the options that quote a server or tool', () => {
    const request = {
      jsonrpc: '2.0',
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        options: [
          {
            optionId: 'proceed_always_server',
            name: 'Always allow all tools from server "notes"',
            kind: 'allow_always',
          },
          { optionId: 'proceed_always_tool', name: 'Always allow tool "read_note"', kind: 'allow_always' },
          { optionId: 'proceed_once', name: 'Allow "once"', kind: 'allow_once' },
        ],
        toolCall: { toolCallId: 't', title: 'read_note (notes MCP Server)', kind: 'other' },
      },
    }
    const r = redactGeminiValue(request)
    const v = r.value as typeof request
    expect(v.params.toolCall.title).toBe(`${REDACTED} (${REDACTED} MCP Server)`)
    expect(v.params.options.map((o) => o.name)).toEqual([
      `Always allow all tools from server "${REDACTED}"`,
      `Always allow tool "${REDACTED}"`,
      'Allow "once"',
    ])
    expect(r.counts).toEqual({ 'gemini-mcp': 3 })
    expect(twice(request)).toEqual(r.value)
    expect(redactGeminiValue(r.value).counts).toEqual({})
  })

  it('the quota: plan-like text and reset numbers go, token counts stay', () => {
    const response = {
      jsonrpc: '2.0',
      id: 4,
      result: {
        stopReason: 'end_turn',
        _meta: {
          quota: {
            token_count: { input_tokens: 10, output_tokens: 2 },
            user_tier: 'standard-tier',
            resets_at: 1791626208,
            remaining_requests: 412,
            model_usage: [{ model: 'gemini-3-pro-preview', token_count: { input_tokens: 10 } }],
          },
        },
      },
    }
    const r = redactGeminiValue(response)
    expect((r.value as typeof response).result._meta.quota).toEqual({
      token_count: { input_tokens: 10, output_tokens: 2 },
      user_tier: REDACTED,
      resets_at: 0,
      remaining_requests: 0,
      model_usage: [{ model: 'gemini-3-pro-preview', token_count: { input_tokens: 10 } }],
    })
    expect(r.counts).toEqual({ 'gemini-quota': 3 })
    expect(redactGeminiValue(r.value).counts).toEqual({})
  })

  it('non-objects pass through', () => {
    for (const v of [null, 3, 'text', true]) expect(redactGeminiValue(v)).toEqual({ value: v, counts: {} })
  })
})

describe('the committed Gemini recordings are fixed points of the rules', () => {
  it.each(allFixtures().map((f) => [f.name, f] as const))('%s', (_n, fx) => {
    for (const f of fx.frames) {
      if (f.dir !== 'out' && f.dir !== 'err') continue
      const m = message(f)
      if (m !== undefined) expect(redactGeminiValue(m).counts).toEqual({})
      else expect(redactGeminiText(f.line ?? '')).toBe(f.line)
    }
  })
})

describe('the profile’s own files (read in memory; credentials never opened)', () => {
  function profile(): string {
    const home = mkdtempSync(join(tmpdir(), 'gemini-profile-'))
    const dir = join(home, '.gemini')
    mkdirSync(join(dir, 'commands', 'git'), { recursive: true })
    mkdirSync(join(dir, 'extensions', 'fake-ext', 'commands'), { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      [
        '{',
        '  // the user’s own MCP servers',
        '  "mcpServers": {',
        '    "fake-notes": { "command": "C:/tools/fake-notes-mcp.exe", "args": ["--vault", "D:/vaults/diary"], "env": { "NOTES_TOKEN": "abcdefghijklmnop1234" } },',
        '    "web": { "httpUrl": "https://mcp.example.invalid/sse" },',
        '  },',
        '  /* block */ "general": { "preferredEditor": "vim" }',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'GEMINI.md'),
      '# Memory\n- Always sign answers as the fake persona Zed.\n- short\n',
    )
    writeFileSync(join(dir, 'commands', 'git', 'commit.toml'), 'description = "x"\nprompt = "y"\n')
    writeFileSync(join(dir, 'commands', 'deploy.toml'), 'prompt = "z"\n')
    writeFileSync(
      join(dir, 'extensions', 'fake-ext', 'gemini-extension.json'),
      '{"name":"fake-extension-x","mcpServers":{"ext-server":{"command":"npx fake-ext-server"}}}',
    )
    writeFileSync(join(dir, 'extensions', 'fake-ext', 'commands', 'review.toml'), 'prompt = "r"\n')
    writeFileSync(join(dir, 'installation_id'), 'aaaabbbb-cccc-4ddd-8eee-ffff00001111\n')
    // Credentials: present, and never opened (readProfileText refuses them; profileTerms never asks).
    for (const f of NEVER_READ) writeFileSync(join(dir, f), 'SENTINEL-SECRET-VALUE')
    return home
  }

  it('collects the names and literals, never the credentials', () => {
    const home = profile()
    const terms = profileTerms(home)
    expect(terms.names).toEqual(
      expect.arrayContaining([
        'fake-notes',
        'git:commit',
        'deploy',
        'fake-ext',
        'fake-extension-x',
        'ext-server',
        'review',
      ]),
    )
    // "web" is too short to match as a word anywhere.
    expect(terms.names).not.toContain('web')
    expect(terms.literals).toEqual(
      expect.arrayContaining([
        'C:/tools/fake-notes-mcp.exe',
        'D:/vaults/diary',
        'abcdefghijklmnop1234',
        'https://mcp.example.invalid/sse',
        'npx fake-ext-server',
        'Always sign answers as the fake persona Zed.',
        'aaaabbbb-cccc-4ddd-8eee-ffff00001111',
      ]),
    )
    expect(JSON.stringify(terms)).not.toContain('SENTINEL')
    expect(terms.skipped).toBe(0)
  })

  it.each([...NEVER_READ])('%s is refused outright', (file) => {
    const home = profile()
    expect(() => readProfileText(join(home, '.gemini', file))).toThrow(/refusing to read/)
  })

  it('an empty or missing profile names nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'gemini-empty-'))
    expect(profileTerms(home)).toEqual({ literals: [], names: [], skipped: 0 })
  })

  it('settings with comments and trailing commas', () => {
    expect(parseJsonc('{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }')).toEqual({
      a: 'x // not a comment',
      b: [1, 2],
    })
    expect(parseJsonc('{ nope')).toBeUndefined()
  })
})

describe('the shared stable-id rule (src/shared/redact.ts)', () => {
  it('takes the Google Cloud project an account is billed through', () => {
    for (const key of [
      'cloudaicompanionProject',
      'cloudaicompanion_project_id',
      'googleCloudProject',
      'GOOGLE_CLOUD_PROJECT',
      'gcp_project_id',
      'quotaProjectId',
    ]) {
      expect(ACCOUNT_KEY_PATTERN.test(key), key).toBe(true)
      expect(redactJsonValue({ [key]: 'my-fake-project-123' }, { mode: 'fixture' }).value).toEqual({
        [key]: '<REDACTED>',
      })
    }
    // A thread's or session's own ids are not account ids.
    for (const key of ['projectId', 'sessionId', 'toolCallId', 'project'])
      expect(ACCOUNT_KEY_PATTERN.test(key)).toBe(false)
  })
})
