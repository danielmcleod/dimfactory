// Security pass, "no credential reads" (policy: "Never read or store
// credentials"; probe checks "exists (contents not read)"). Every credential file each vendor keeps is named
// in the source only where Dim Factory checks that it exists, and those modules have no way to read a file; the probes
// that see a sign-in or a key say how the user signs in, never the key; the settings Dim Factory does read (Claude's
// settings.json, Grok's config.toml, ~/.npmrc) yield only what they are read for, never a secret in them. Proven with
// node:fs spied: no read of a credential file ever happens.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Every path node:fs was asked to read or open (sync, async, promise and stream forms). */
const reads = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof Fs>()
  const record = (p: unknown): void => {
    if (typeof p === 'string') reads.push(p)
    else if (p instanceof URL) reads.push(p.pathname)
    else if (Buffer.isBuffer(p)) reads.push(p.toString())
  }
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F =>
    ((...a: Parameters<F>) => {
      record(a[0])
      return f(...a)
    }) as F
  return {
    ...real,
    readFileSync: wrap(real.readFileSync),
    openSync: wrap(real.openSync),
    readFile: wrap(real.readFile),
    open: wrap(real.open),
    createReadStream: wrap(real.createReadStream),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  const record = (p: unknown): void => {
    if (typeof p === 'string') reads.push(p)
  }
  return {
    ...real,
    readFile: (...a: Parameters<typeof real.readFile>) => {
      record(a[0])
      return real.readFile(...a)
    },
    open: (...a: Parameters<typeof real.open>) => {
      record(a[0])
      return real.open(...a)
    },
  }
})

const { hasOauthCreds, oauthCredsPath } = await import('../../../src/core/adapters/gemini/home.ts')
const { geminiAccount, geminiAuthCheck } = await import('../../../src/core/adapters/gemini/auth.ts')
const { grokAuthFile, hasCachedSignIn } = await import('../../../src/core/adapters/grok/home.ts')
const { grokAccount, grokAuthCheck } = await import('../../../src/core/adapters/grok/auth.ts')
const { scanGrokAllowRules } = await import('../../../src/core/adapters/grok/allow-rules.ts')
const { scanShellAllowRules } = await import('../../../src/core/adapters/claude/settings-scan.ts')
const { authChecks } = await import('../../../src/core/adapters/claude/probe.ts')
const { museAccount, museAuthCheck } = await import('../../../src/core/adapters/muse/probe.ts')
const { npmrcPrefix, NPMRC_MAX_BYTES } = await import('../../../src/core/proc/resolve-cli.ts')

// Fake secrets assembled at runtime, so this file never holds a scanner-shaped literal.
const SECRET = ['zz', 'SECRET', 'value', '0123456789abcdef'].join('-')
const KEY_ENV = {
  ANTHROPIC_API_KEY: `sk-ant-${SECRET}`,
  GEMINI_API_KEY: `AIza${SECRET}`,
  XAI_API_KEY: `xai-${SECRET}`,
  META_API_KEY: `meta-${SECRET}`,
}

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A user home holding every vendor's credential files, each with a secret in it. */
function homeWithCredentials(): { home: string; files: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'dim-factory-creds-'))
  roots.push(home)
  const files = [
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude.json'),
    join(home, '.codex', 'auth.json'),
    join(home, '.gemini', 'oauth_creds.json'),
    join(home, '.gemini', 'google_accounts.json'),
    join(home, '.gemini', '.env'),
    join(home, '.grok', 'auth.json'),
    join(home, '.npmrc'),
  ]
  for (const f of files) {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify({ token: SECRET, refresh_token: SECRET }))
  }
  return { home, files }
}

const credentialRead = (files: readonly string[]): string[] =>
  reads.filter((r) => files.some((f) => resolve(r).toLowerCase() === resolve(f).toLowerCase()))

describe('vendor sign-in checks', () => {
  it('see that a credential file exists without ever reading it', () => {
    const { home, files } = homeWithCredentials()
    reads.length = 0
    const env = {}
    expect(hasOauthCreds(env, home)).toBe(true)
    expect(oauthCredsPath(env, home)).toBe(join(home, '.gemini', 'oauth_creds.json'))
    expect(hasCachedSignIn(env, home)).toBe(true)
    expect(grokAuthFile(env, home)).toBe(join(home, '.grok', 'auth.json'))
    const at = 1
    const gem = geminiAuthCheck({ env, home, handshake: undefined, at })
    const grok = grokAuthCheck({ env, home, handshake: undefined, at })
    expect(gem.status).toBe('pass')
    expect(grok.status).not.toBe('fail')
    expect(geminiAccount({ env, home, handshake: undefined, at })).toEqual({ method: 'oauth-personal' })
    // A Grok sign-in may be a subscription, which Dim Factory cannot tell: nothing is claimed for it.
    expect(grokAccount({ env, home, handshake: undefined, at })).toBeUndefined()
    expect(credentialRead(files)).toEqual([])
    expect(JSON.stringify([gem, grok])).not.toContain(SECRET)
  })

  it("say how the user signs in from a key's presence, never its value", () => {
    const { home, files } = homeWithCredentials()
    reads.length = 0
    const at = 1
    const out = [
      geminiAuthCheck({ env: KEY_ENV, home, handshake: undefined, at }),
      geminiAccount({ env: KEY_ENV, home, handshake: undefined, at }),
      grokAuthCheck({ env: KEY_ENV, home, handshake: undefined, at }),
      grokAccount({ env: KEY_ENV, home, handshake: undefined, at }),
      museAuthCheck(KEY_ENV, at),
      museAccount(KEY_ENV),
      authChecks(
        {
          code: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
          stderr: '',
          timedOut: false,
        },
        KEY_ENV,
        at,
      ),
      authChecks(
        {
          code: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
          stderr: '',
          timedOut: false,
        },
        KEY_ENV,
        at,
      ),
    ]
    const text = JSON.stringify(out)
    expect(text).not.toContain(SECRET)
    for (const v of Object.values(KEY_ENV)) expect(text).not.toContain(v)
    expect(credentialRead(files)).toEqual([])
  })
})

describe('settings Dim Factory reads', () => {
  it("Claude's settings.json: only its permission rules, never the env block's secrets", () => {
    const root = mkdtempSync(join(tmpdir(), 'dim-factory-claude-settings-'))
    roots.push(root)
    const configDir = join(root, 'claude')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: KEY_ENV.ANTHROPIC_API_KEY, OTHER_TOKEN: SECRET },
        apiKeyHelper: `echo ${SECRET}`,
        permissions: { allow: ['Bash(npm install:*)', 'Read'] },
      }),
    )
    reads.length = 0
    const rules = scanShellAllowRules(join(root, 'project'), configDir)
    // The spy sees reads (the control for every 'never read' above).
    expect(reads.map((r) => resolve(r))).toContain(resolve(configDir, 'settings.json'))
    expect(rules.map((r) => r.rule)).toEqual(['Bash(npm install:*)'])
    expect(JSON.stringify(rules)).not.toContain(SECRET)
  })

  it("Grok's config.toml: its allow rules, with every secret line dropped before anything looks at it", () => {
    const root = mkdtempSync(join(tmpdir(), 'dim-factory-grok-settings-'))
    roots.push(root)
    const grokHome = join(root, 'grok-home')
    mkdirSync(grokHome, { recursive: true })
    writeFileSync(
      join(grokHome, 'config.toml'),
      [
        '[model.grok-code]',
        `api_key = "${KEY_ENV.XAI_API_KEY}"`,
        `env_key = "MY_SECRET_${SECRET}"`,
        '[permission]',
        `allow = ["Bash(rm ${SECRET})"]`,
        '[auth]',
        `access_token = '''`,
        SECRET,
        `'''`,
      ].join('\n'),
    )
    const found = scanGrokAllowRules({
      cwd: join(root, 'project'),
      env: { GROK_HOME: grokHome },
      home: join(root, 'user'),
      platform: 'win32',
    })
    // The allow rule is the user's own setting, shown as written; nothing from a secret line comes through.
    expect(found.map((r) => r.rule)).toEqual([`Bash(rm ${SECRET})`])
    expect(JSON.stringify(found)).not.toContain(KEY_ENV.XAI_API_KEY)
    expect(JSON.stringify(found)).not.toContain(`MY_SECRET_`)
  })

  it('~/.npmrc: the prefix only; registry tokens are never looked at', () => {
    const rc = [
      `//registry.npmjs.org/:_authToken=npm_${SECRET}`,
      `_auth=${SECRET}`,
      'email=me@example.com',
      'prefix = ~/.npm-global',
      `//npm.pkg.github.com/:_password=${SECRET}`,
    ].join('\n')
    expect(npmrcPrefix(rc, '/home/me')).toBe('/home/me/.npm-global')
    expect(npmrcPrefix(`_authToken=${SECRET}\n`, '/home/me')).toBeUndefined()
    // A token line that only looks like a prefix setting is not one.
    expect(npmrcPrefix(`//r/:_authToken=x\nprefixes=${SECRET}\n`, '/h')).toBeUndefined()
    expect(NPMRC_MAX_BYTES).toBeLessThanOrEqual(64 * 1024)
  })
})

// ---- the source names credential files only where it checks they exist ------------------------------------------

/** Each vendor's credential files and other secret stores (by name, as they would appear in the source). */
const CREDENTIAL_NAMES: readonly { name: string; re: RegExp }[] = [
  { name: 'Claude .credentials.json', re: /\.credentials\.json/ },
  { name: 'Claude ~/.claude.json', re: /['"/\\]\.claude\.json\b/ },
  { name: 'Codex and Grok auth.json', re: /['"/\\]auth\.json\b/ },
  { name: 'Gemini oauth_creds.json', re: /oauth_creds\.json/ },
  { name: 'Gemini google_accounts.json', re: /google_accounts\.json/ },
  { name: 'Gemini mcp-oauth-tokens.json', re: /mcp-oauth-tokens/ },
  { name: 'a .env file', re: /['"/\\]\.env['"]/ },
  { name: 'git credentials', re: /\.git-credentials|credential\.helper/ },
  { name: 'netrc', re: /['"/\\]_?netrc\b/ },
  {
    name: 'cloud credentials',
    re: /\.aws[\\/]credentials|application_default_credentials|\.docker[\\/]config\.json/,
  },
  {
    name: 'an OS keychain',
    re: /\bkeytar\b|find-generic-password|secret-tool|CredRead|\bcmdkey\b|safeStorage/,
  },
]

/** Where each name may appear in code, and why. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // existence only (statSync), and the module imports no way to read a file
  'Gemini oauth_creds.json': ['src/core/adapters/gemini/home.ts'],
  'Codex and Grok auth.json': ['src/core/adapters/grok/home.ts'],
  // Extensions: Claude keeps its user and local MCP servers there. Only those entries are kept: the account and any
  // API key in the file are dropped as it is parsed (claudeGlobalMcpOnly; tests/unit/extensions/claude.test.ts).
  'Claude ~/.claude.json': ['src/core/extensions/claude.ts'],
  // a search keyword of Settings' worktree copy-ins field (the palette), not a file anything opens
  'a .env file': ['src/renderer/src/pages/settings/index.ts'],
}

/** Modules that name a credential file: they may stat it, never read it. */
const EXISTENCE_ONLY = ['src/core/adapters/gemini/home.ts', 'src/core/adapters/grok/home.ts']

function sourceFiles(): string[] {
  return readdirSync(resolve('src'), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${sep}protocol${sep}`))
}
const rel = (f: string): string => relative(resolve('.'), f).split(sep).join('/')
const code = (f: string): string[] =>
  readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))

describe('the source', () => {
  it('names a credential file only where it checks that the file exists', () => {
    const found: Record<string, string[]> = {}
    for (const f of sourceFiles()) {
      const lines = code(f)
      for (const c of CREDENTIAL_NAMES) {
        if (lines.some((l) => c.re.test(l))) (found[c.name] ??= []).push(rel(f))
      }
    }
    for (const list of Object.values(found)) list.sort()
    expect(found).toEqual(ALLOWED)
  })

  it('those modules have no way to read a file', () => {
    for (const f of EXISTENCE_ONLY) {
      const text = code(resolve(f)).join('\n')
      const fsImports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)]
        .flatMap((m) => (m[1] ?? '').split(','))
        .map((s) => s.trim())
        .filter((s) => s !== '')
      expect(
        fsImports.filter((n) => /read(?!dir)|open|stream/i.test(n)),
        f,
      ).toEqual([])
      expect(text, f).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+'node:fs/)
      expect(text, f).not.toMatch(/require\(/)
    }
  })
})
