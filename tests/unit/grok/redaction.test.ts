// The recorder's Grok rules (scripts/redact-grok.mjs: deterministic redaction, the same two
// layers) and the committed Grok recordings: every agent frame is a fixed point of the protocol rules (the session
// group folder, an SSO issuer or auth provider label, team and principal ids), stderr of the text rule; the rules keep
// every value's type and leave method names alone; the profile's own terms come from config.toml and AGENTS.md, and
// credential files are never opened. (tests/unit/fixtures-redaction.test.ts holds the shared rules for every fixture.)
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NEVER_READ,
  REDACTED,
  profileTerms,
  readProfileText,
  redactGrokText,
  redactGrokValue,
} from '../../../scripts/redact-grok.mjs'

const ACP = fileURLToPath(new URL('../../fixtures/grok/acp/', import.meta.url))
const recordings = readdirSync(ACP, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

describe("the committed Grok recordings are fixed points of the recorder's Grok rules", () => {
  it.each(recordings)('%s', (name) => {
    const lines = readFileSync(join(ACP, name, 'recording.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(1)
      .map((l) => JSON.parse(l) as { dir: string; line?: string })
    for (const f of lines) {
      if (f.line === undefined) continue
      if (f.dir === 'out') {
        const value = JSON.parse(f.line) as unknown
        const r = redactGrokValue(value)
        expect(r.counts, f.line).toEqual({})
        expect(r.value).toEqual(value)
      }
      if (f.dir === 'err') expect(redactGrokText(f.line)).toBe(f.line)
    }
  })
})

describe('redactGrokValue', () => {
  it('the session group folder under <GROK_HOME>/sessions or .grok/sessions, in any escaping', () => {
    const v = {
      a: '<GROK_HOME>/sessions/C%3A%5Cwork%5Capp/0199/summary.json',
      b: '~\\.grok\\sessions\\slug-1a2b3c\\0199',
      c: 'x.ai/sessions/list',
      d: 'see sessions/new',
    }
    const r = redactGrokValue(v)
    expect(r.value).toEqual({
      a: '<GROK_HOME>/sessions/<PROJECT>/0199/summary.json',
      b: '~\\.grok\\sessions\\<PROJECT>\\0199',
      c: 'x.ai/sessions/list',
      d: 'see sessions/new',
    })
    expect(r.counts).toEqual({ 'grok-project': 2 })
    expect(redactGrokValue(r.value).counts).toEqual({})
    expect(redactGrokText('error at <GROK_HOME>/sessions/abc/log')).toBe(
      'error at <GROK_HOME>/sessions/<PROJECT>/log',
    )
  })

  it('an SSO issuer and a custom provider label in authMethods; the defaults stay', () => {
    const init = {
      result: {
        authMethods: [
          { id: 'cached_token', name: 'cached_token', description: 'Cached token from ~/.grok/auth.json' },
          {
            id: 'oidc',
            name: 'Single sign-on (https://acme.example)',
            description: 'Sign in with Single sign-on (https://acme.example)',
          },
          { id: 'grok.com', name: 'Acme Login', description: 'Sign in with Acme Login' },
          { id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' },
        ],
      },
    }
    const r = redactGrokValue(init)
    expect((r.value as typeof init).result.authMethods).toEqual([
      init.result.authMethods[0],
      { id: 'oidc', name: REDACTED, description: `Sign in with ${REDACTED}` },
      { id: 'grok.com', name: REDACTED, description: `Sign in with ${REDACTED}` },
      init.result.authMethods[3],
    ])
    expect(r.counts).toEqual({ 'grok-auth-label': 4 })
    expect(redactGrokValue(r.value).counts).toEqual({})
  })

  it('team, principal and issuer ids in any key spelling; types kept; other keys untouched', () => {
    const r = redactGrokValue({
      _meta: {
        teamId: 't-1',
        team_id: 't-2',
        principalId: 'p',
        issuer: 'https://x',
        count: 3,
        agentVersion: '1.0.50',
      },
    })
    expect(r.value).toEqual({
      _meta: {
        teamId: REDACTED,
        team_id: REDACTED,
        principalId: REDACTED,
        issuer: REDACTED,
        count: 3,
        agentVersion: '1.0.50',
      },
    })
    expect(r.counts).toEqual({ 'grok-account': 4 })
  })
})

describe('profileTerms: what the profile names, read in memory; credentials never', () => {
  it('config.toml MCP servers (names and distinctive values), the OIDC settings, an auth provider, AGENTS.md', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-profile-'))
    writeFileSync(
      join(home, 'config.toml'),
      [
        '# comment',
        '[mcp_servers.fake-notes-server]',
        'command = "node"',
        "args = ['C:/fake/notes-server.js', '--port']",
        'env = { NOTES_TOKEN = "fake-token-value-12345" }',
        '',
        '[mcp_servers."quoted server"]',
        'url = "https://mcp.fake.example/sse"',
        '',
        '[grok_com_config.oidc]',
        'issuer = "https://fake-acme.okta.example"',
        'client_id = "0oaFAKECLIENT77"',
        '',
        '[auth]',
        'auth_provider_command = "fake-sso-helper --print"',
        'auth_provider_label = "Fake Acme SSO"',
        '',
        '[ui]',
        'permission_mode = "ask"',
      ].join('\n'),
    )
    writeFileSync(
      join(home, 'AGENTS.md'),
      '# Notes\nAlways mention project Fakeproject Zeta in commit messages.\n',
    )
    writeFileSync(join(home, 'auth.json'), '{"access_token":"SENTINEL"}')
    const t = profileTerms(home)
    expect(t.names).toEqual(['fake-notes-server', 'quoted server'])
    for (const v of [
      'C:/fake/notes-server.js',
      'fake-token-value-12345',
      'https://mcp.fake.example/sse',
      'https://fake-acme.okta.example',
      '0oaFAKECLIENT77',
      'fake-sso-helper --print',
      'Fake Acme SSO',
    ])
      expect(t.literals, v).toContain(v)
    expect(t.literals.some((l) => l.includes('Fakeproject Zeta'))).toBe(true)
    // A plain word ("node", "ask") is never a literal; nothing from auth.json is.
    expect(t.literals).not.toContain('node')
    expect(t.literals).not.toContain('ask')
    expect(JSON.stringify(t)).not.toContain('SENTINEL')
  })

  it("config.toml's secret lines (api_key, env_key, tokens) are dropped as it is read, never kept", () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-profile-'))
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[model.grok-4-fast]',
        'api_key = "xai-fake-inline-key-0123456789"',
        'env_key = "FAKE_ACME_XAI_KEY_NAME"',
        '[mcp_servers.fake-vault]',
        'command = "C:/fake/vault-mcp.exe"',
        '[mcp_servers.fake-vault.env]',
        'API_KEY = "fake-mcp-api-key-0123456789"',
        'access_token = "fake-access-token-0123456789"',
        '[grok_com_config.oidc]',
        'issuer = "https://fake-acme.okta.example"',
        'client_secret = """',
        'fake-multi-line-secret-0123456789',
        '"""',
      ].join('\n'),
    )
    const t = profileTerms(home)
    expect(t.names).toEqual(['fake-vault'])
    expect(t.literals).toContain('C:/fake/vault-mcp.exe')
    expect(t.literals).toContain('https://fake-acme.okta.example')
    for (const secret of [
      'xai-fake-inline-key-0123456789',
      'FAKE_ACME_XAI_KEY_NAME',
      'fake-mcp-api-key-0123456789',
      'fake-access-token-0123456789',
      'fake-multi-line-secret-0123456789',
    ])
      expect(JSON.stringify(t), secret).not.toContain(secret)
  })

  it('refuses to open a credential file, even when asked', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-profile-'))
    for (const f of NEVER_READ) expect(() => readProfileText(join(home, f))).toThrow(/refusing to read/)
    expect(profileTerms(join(home, 'missing'))).toEqual({ literals: [], names: [], skipped: 0 })
  })
})
