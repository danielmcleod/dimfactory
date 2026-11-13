// The diff secret scanner: true positives for every rule family (with their new-file line numbers through context
// lines and several hunks), the false positives it must not raise, unified-diff parsing edge cases, masking and the
// cap. Every secret-shaped value here is assembled at run time from pieces and a seeded generator, so no complete
// token appears in this source.
import { describe, expect, it } from 'vitest'
import {
  SECRET_RULES,
  isAllowlistedPath,
  maskSecret,
  scanPatchForSecrets,
  scanTextForSecrets,
  shannonEntropy,
  type SecretHit,
} from '@core/security/secrets.ts'

const k = (...parts: string[]): string => parts.join('')

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const ALNUM = UPPER + LOWER + DIGITS
const B64 = ALNUM + '+/'
const B64URL = ALNUM + '-_'
const HEX = '0123456789abcdef'

/** Deterministic pseudo-random characters (mulberry32): synthetic bodies, never real keys. */
function synth(alphabet: string, n: number, seed: number): string {
  let a = seed >>> 0
  let out = ''
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    out += alphabet[Math.floor(r * alphabet.length)] ?? ''
  }
  return out
}

/** `${name}` without writing a template placeholder in a plain string. */
const tpl = (name: string): string => k('$', '{', name, '}')

const githubToken = (seed: number): string => k('gh', 'p_', synth(ALNUM, 36, seed))
const awsKeyId = (seed: number): string => k('AK', 'IA', synth(UPPER + DIGITS, 16, seed))

/**
 * A two-hunk patch of `file` whose second hunk adds `added` at new-file line 12, between a removed line and
 * context lines.
 */
function twoHunkPatch(file: string, added: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,4 @@',
    ' line one',
    '+const first = 1',
    ' line two',
    ' line three',
    '@@ -10,4 +11,5 @@ function x() {',
    ' context a',
    '-removed old',
    `+${added}`,
    '+another added',
    ' context b',
    ' context c',
    '',
  ].join('\n')
}

/** A new file whose lines are all added, from line 1. */
function newFilePatch(file: string, lines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n')
}

function expectNoLeak(hits: readonly SecretHit[], value: string): void {
  const json = JSON.stringify(hits)
  expect(json).not.toContain(value)
  for (const h of hits) expect(h.masked).not.toContain(value)
}

interface Positive {
  rule: string
  file: string
  value: string
  line: (value: string) => string
}

const azureKey = k(synth(ALNUM + '+/', 86, 25), '==')

const POSITIVES: readonly Positive[] = [
  {
    rule: 'private-key',
    file: 'deploy/id_rsa',
    value: k('-----BEGIN ', 'RSA PRIV', 'ATE KEY-----'),
    line: (v) => `const pem = '${v}'`,
  },
  { rule: 'aws-access-key-id', file: '.env', value: awsKeyId(1), line: (v) => `aws_access_key_id = ${v}` },
  {
    rule: 'aws-secret-access-key',
    file: 'config/aws.ini',
    value: synth(ALNUM + '+/', 40, 2),
    line: (v) => `aws_secret_access_key = ${v}`,
  },
  { rule: 'github-token', file: '.env', value: githubToken(3), line: (v) => `GITHUB_TOKEN=${v}` },
  {
    rule: 'github-fine-grained-token',
    file: 'scripts/release.ts',
    value: k('github', '_pat_', synth(ALNUM, 22, 4), '_', synth(ALNUM, 59, 5)),
    line: (v) => `const pat = "${v}"`,
  },
  {
    rule: 'gitlab-token',
    file: 'ci/settings.yml',
    value: k('gl', 'pat-', synth(ALNUM, 20, 6)),
    line: (v) => `gitlab: ${v}`,
  },
  {
    rule: 'slack-token',
    file: 'src/notify.ts',
    value: k('xo', 'xb-', synth(DIGITS, 12, 7), '-', synth(DIGITS, 13, 8), '-', synth(ALNUM, 24, 9)),
    line: (v) => `const slackBot = '${v}'`,
  },
  {
    rule: 'slack-webhook',
    file: 'src/notify.ts',
    value: k(
      'https://hooks.sl',
      'ack.com/services/T',
      synth(UPPER + DIGITS, 8, 10),
      '/B',
      synth(UPPER + DIGITS, 10, 11),
      '/',
      synth(ALNUM, 24, 12),
    ),
    line: (v) => `webhook: ${v}`,
  },
  {
    rule: 'stripe-secret-key',
    file: 'src/billing.ts',
    value: k('sk', '_live_', synth(ALNUM, 24, 13)),
    line: (v) => `const stripe = new Stripe('${v}')`,
  },
  {
    rule: 'google-api-key',
    file: 'src/maps.ts',
    value: k('AI', 'za', synth(B64URL, 35, 14)),
    line: (v) => `const maps = '${v}'`,
  },
  {
    rule: 'openai-api-key',
    file: '.env.local',
    value: k('sk-', 'proj-', synth(B64URL, 48, 15)),
    line: (v) => `OPENAI_API_KEY=${v}`,
  },
  {
    rule: 'anthropic-api-key',
    file: '.env.local',
    value: k('sk-', 'ant-', 'api03-', synth(B64URL, 93, 16), 'AA'),
    line: (v) => `ANTHROPIC_API_KEY=${v}`,
  },
  {
    rule: 'jwt',
    file: 'src/client.ts',
    value: k('ey', 'J', synth(B64URL, 20, 17), '.ey', 'J', synth(B64URL, 40, 18), '.', synth(B64URL, 43, 19)),
    line: (v) => `headers.authorization = 'Bearer ${v}'`,
  },
  {
    rule: 'npm-token',
    file: '.npmrc',
    value: k('np', 'm_', synth(ALNUM, 36, 20)),
    line: (v) => `//registry.npmjs.org/:_authToken=${v}`,
  },
  {
    rule: 'pypi-token',
    file: '.pypirc',
    value: k('py', 'pi-', 'AgEIcHlwaS5vcmc', synth(B64URL, 60, 21)),
    line: (v) => `password = ${v}`,
  },
  {
    rule: 'sendgrid-api-key',
    file: '.env',
    value: k('S', 'G.', synth(B64URL, 22, 22), '.', synth(B64URL, 43, 23)),
    line: (v) => `SENDGRID_API_KEY="${v}"`,
  },
  {
    rule: 'twilio-api-key',
    file: 'src/sms.ts',
    value: k('S', 'K', synth(HEX, 32, 24)),
    line: (v) => `const twilioKeySid = '${v}'`,
  },
  {
    rule: 'azure-storage-key',
    file: 'appsettings.json',
    value: azureKey,
    line: (v) =>
      `"Storage": "DefaultEndpointsProtocol=https;AccountName=acct1;AccountKey=${v};EndpointSuffix=core.windows.net"`,
  },
  {
    rule: 'url-credentials',
    file: 'docker-compose.yml',
    value: synth(ALNUM, 18, 26),
    line: (v) => `DATABASE_URL=postgres://admin:${v}@db.internal:5432/app`,
  },
  {
    rule: 'generic-secret',
    file: 'src/db.ts',
    value: synth(ALNUM, 14, 27),
    line: (v) => `const password = "${v}"`,
  },
  {
    rule: 'entropy',
    file: 'config/session.ts',
    value: synth(B64, 40, 28),
    line: (v) => `  signingSalt: '${v}',`,
  },
]

describe('true positives: one per rule family', () => {
  it.each(POSITIVES)('$rule', ({ rule, file, value, line }) => {
    const hits = scanPatchForSecrets(twoHunkPatch(file, line(value)))
    expect(hits.map((h) => h.rule)).toEqual([rule])
    const hit = hits[0]
    expect(hit).toMatchObject({ file, line: 12, rule, masked: maskSecret(value) })
    expect(hit?.confidence).toBe(rule === 'entropy' ? 'entropy' : 'pattern')
    expect(hit?.label).toBe(SECRET_RULES.find((r) => r.id === rule)?.label)
    expectNoLeak(hits, value)
  })

  it('covers every rule the scanner declares', () => {
    expect(new Set(POSITIVES.map((p) => p.rule))).toEqual(new Set(SECRET_RULES.map((r) => r.id)))
  })

  it('flags the other private key headers', () => {
    const lines = [
      k('-----BEGIN ', 'OPENSSH PRIV', 'ATE KEY-----'),
      synth(B64, 64, 40),
      k('-----BEGIN ', 'PGP PRIV', 'ATE KEY BLOCK-----'),
      k('-----BEGIN ', 'PRIV', 'ATE KEY-----'),
      k('-----BEGIN ', 'EC PRIV', 'ATE KEY-----'),
    ]
    const hits = scanPatchForSecrets(newFilePatch('keys/all.pem', lines))
    expect(hits.map((h) => [h.rule, h.line])).toEqual([
      ['private-key', 1],
      ['private-key', 3],
      ['private-key', 4],
      ['private-key', 5],
    ])
  })

  it('flags a high-entropy hex value next to a secret name', () => {
    const v = synth(HEX, 64, 29)
    const hits = scanPatchForSecrets(newFilePatch('config.json', ['{', `  "webhookSignature": "${v}"`, '}']))
    expect(hits).toMatchObject([{ rule: 'entropy', line: 2, confidence: 'entropy' }])
    expectNoLeak(hits, v)
  })

  it('flags an ASIA session key id and a GitHub token of each prefix', () => {
    const asia = k('AS', 'IA', synth(UPPER + DIGITS, 16, 41))
    const lines = ['gho', 'ghu', 'ghs', 'ghr'].map((p, i) => `t${i} = ${k(p, '_', synth(ALNUM, 36, 50 + i))}`)
    const hits = scanPatchForSecrets(newFilePatch('a.cfg', [`id = ${asia}`, ...lines]))
    expect(hits.map((h) => h.rule)).toEqual([
      'aws-access-key-id',
      'github-token',
      'github-token',
      'github-token',
      'github-token',
    ])
  })

  it('a real key in a plain test file is still a leak', () => {
    const hits = scanPatchForSecrets(twoHunkPatch('src/foo.test.ts', `const t = '${githubToken(42)}'`))
    expect(hits).toMatchObject([{ rule: 'github-token', file: 'src/foo.test.ts' }])
  })

  it('keeps only the specific rule when a generic rule matches the same value', () => {
    const v = githubToken(43)
    const hits = scanPatchForSecrets(twoHunkPatch('src/a.ts', `const token = "${v}"`))
    expect(hits.map((h) => h.rule)).toEqual(['github-token'])
  })

  it('reports one hit per rule per line', () => {
    const hits = scanPatchForSecrets(
      twoHunkPatch('src/a.ts', `a = '${githubToken(44)}', b = '${githubToken(45)}'`),
    )
    expect(hits).toHaveLength(1)
  })
})

describe('false positives', () => {
  const sha = synth(HEX, 40, 32)
  const uuid = k(synth(HEX, 8, 33), '-', synth(HEX, 4, 34), '-4', synth(HEX, 3, 35), '-a', synth(HEX, 3, 36))
  const uuidFull = k(uuid, '-', synth(HEX, 12, 37))
  const cases: readonly { name: string; line: string; file?: string }[] = [
    {
      name: 'the AWS documentation key',
      line: `aws_access_key_id = ${k('AK', 'IA', 'IOSFODNN7', 'EXAMPLE')}`,
    },
    {
      name: 'the AWS documentation secret',
      line: `aws_secret_access_key = ${k('wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLE', 'KEY')}`,
    },
    { name: 'an xxxx token', line: `GITHUB_TOKEN=${k('gh', 'p_', 'x'.repeat(36))}` },
    { name: 'a your_ placeholder', line: 'api_key = "your_api_key_here"' },
    { name: 'an angle-bracket placeholder', line: 'const token = "<paste-token-here>"' },
    { name: 'changeme', line: 'password: "changeme123"' },
    { name: 'a dummy OpenAI key', line: `OPENAI_API_KEY=${k('sk-', 'dummy', synth(ALNUM, 40, 38))}` },
    { name: 'a redacted value', line: `secret = "REDACTED-${synth(ALNUM, 10, 39)}"` },
    {
      name: 'a Stripe test key',
      line: `const stripe = new Stripe('${k('sk', '_test_', synth(ALNUM, 24, 30))}')`,
    },
    {
      name: 'a Stripe test key by a key name',
      line: `STRIPE_SECRET_KEY=${k('sk', '_test_', synth(ALNUM, 24, 31))}`,
    },
    {
      name: 'an integrity hash',
      file: 'package.json',
      line: `    "integrity": "sha512-${synth(B64, 86, 31)}=="`,
    },
    { name: 'a UUID by a token name', line: `const tokenId = '${uuidFull}'` },
    { name: 'a git SHA without a secret name', line: `commit: ${sha}` },
    { name: 'a quoted git SHA without a secret name', line: `"rev": "${sha}"` },
    {
      name: 'long base64 without a secret name',
      line: `const logo = "data:image/png;base64,${synth(B64, 200, 33)}"`,
    },
    {
      name: 'a URL without credentials',
      line: 'const authUrl = "https://login.service.io/oauth2/v1/authorize?client=web"',
    },
    { name: 'a URL with a user only', line: 'git clone https://deploy@git.service.io/org/repo.git' },
    {
      name: 'an interpolated URL password',
      line: `const url = \`postgres://${tpl('user')}:${tpl('password')}@db/app\``,
    },
    { name: 'a password word in a URL', line: 'REDIS_URL=redis://user:password@localhost:6379' },
    { name: 'a masked URL password', line: 'postgres://admin:********@db/app' },
    { name: 'an interpolated token', line: `token = "${tpl('GITHUB_TOKEN')}"` },
    { name: 'a template token', line: `api_key: "{{ ${'secrets'}.API_KEY }}"` },
    { name: 'an environment reference', line: 'password: process.env.DB_PASSWORD,' },
    { name: 'an env var name as the value', line: `secret: 'GITHUB_TOKEN_FOR_RELEASES'` },
    {
      name: 'a long identifier by a key name',
      line: 'const apiKey = readConfigurationValueFromEnvironment()',
    },
    { name: 'a file path by a key name', line: `const keyFile = './certs/production/service-account.json'` },
    { name: 'a working directory', line: `pwd = "/home/runner/work/project"` },
  ]

  it.each(cases)('$name', ({ line, file }) => {
    expect(scanPatchForSecrets(twoHunkPatch(file ?? 'src/config.ts', line))).toEqual([])
  })

  it.each([
    'pnpm-lock.yaml',
    'web/PACKAGE-LOCK.JSON',
    'go.sum',
    'Cargo.lock',
    'tests/__fixtures__/a.json',
    'src/fixtures/x.txt',
    'src/__mocks__/x.ts',
    'pkg/testdata/key.txt',
    'pkg/test-data/key.txt',
    'src/__snapshots__/a.ts.snap',
    'src/b.snap',
    'dist/app.min.js',
    'dist/app.js.map',
  ])('skips the allowlisted path %s', (file) => {
    expect(scanPatchForSecrets(twoHunkPatch(file, `GITHUB_TOKEN=${githubToken(60)}`))).toEqual([])
  })

  it('does not read removed or context lines', () => {
    const patch = [
      'diff --git a/a.env b/a.env',
      '--- a/a.env',
      '+++ b/a.env',
      '@@ -1,3 +1,3 @@',
      ` GITHUB_TOKEN=${githubToken(61)}`,
      `-OLD_TOKEN=${githubToken(62)}`,
      '+NEW=1',
      ' X=2',
      '',
    ].join('\n')
    expect(scanPatchForSecrets(patch)).toEqual([])
  })

  it('skips a deleted file', () => {
    const patch = [
      'diff --git a/old.env b/old.env',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/old.env',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      `-GITHUB_TOKEN=${githubToken(63)}`,
      '-X=1',
      '',
    ].join('\n')
    expect(scanPatchForSecrets(patch)).toEqual([])
  })

  it('skips a line longer than 4000 characters', () => {
    const line = `GITHUB_TOKEN=${githubToken(64)} ${'a'.repeat(5000)}`
    expect(scanPatchForSecrets(twoHunkPatch('src/a.ts', line))).toEqual([])
  })
})

describe('patch parsing', () => {
  const gh = githubToken(70)

  it('reads quoted paths, with spaces and octal escapes', () => {
    const spaced = [
      'diff --git "a/dir with space/f.ts" "b/dir with space/f.ts"',
      '--- "a/dir with space/f.ts"',
      '+++ "b/dir with space/f.ts"',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      `+GITHUB_TOKEN=${gh}`,
    ]
    const octal = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -0,0 +1 @@',
      `+GITHUB_TOKEN=${gh}`,
    ]
    const hits = scanPatchForSecrets([...spaced, ...octal, ''].join('\n'))
    expect(hits.map((h) => [h.file, h.line])).toEqual([
      ['café.ts', 1],
      ['dir with space/f.ts', 2],
    ])
  })

  it('reads a quoted path from the header when there is no +++ line', () => {
    const patch = ['diff --git "a/x y.bin" "b/x y.bin"', 'Binary files differ', ''].join('\n')
    expect(scanPatchForSecrets(patch)).toEqual([])
  })

  it('handles CRLF line endings', () => {
    const hits = scanPatchForSecrets(twoHunkPatch('src/a.env', `GITHUB_TOKEN=${gh}`).replace(/\n/g, '\r\n'))
    expect(hits).toEqual([
      {
        file: 'src/a.env',
        line: 12,
        rule: 'github-token',
        label: 'GitHub token',
        masked: maskSecret(gh),
        confidence: 'pattern',
      },
    ])
  })

  it('attributes a renamed file to its new path', () => {
    const patch = [
      'diff --git a/pure/old.ts b/pure/new.ts',
      'similarity index 100%',
      'rename from pure/old.ts',
      'rename to pure/new.ts',
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      'index 1111111..2222222 100644',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -5,3 +5,4 @@',
      ' a',
      ' b',
      `+GITHUB_TOKEN=${gh}`,
      ' c',
      '',
    ].join('\n')
    expect(scanPatchForSecrets(patch).map((h) => [h.file, h.line])).toEqual([['new/name.ts', 7]])
  })

  it('ignores the no-newline marker', () => {
    const patch = [
      'diff --git a/a.env b/a.env',
      '--- a/a.env',
      '+++ b/a.env',
      '@@ -1 +1,2 @@',
      '-OLD=1',
      '\\ No newline at end of file',
      '+NEW=1',
      `+GITHUB_TOKEN=${gh}`,
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(scanPatchForSecrets(patch).map((h) => [h.file, h.line])).toEqual([['a.env', 2]])
  })

  it('moves past a binary file to the next one', () => {
    const patch = [
      'diff --git a/img.png b/img.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/img.png differ',
      newFilePatch('b.env', [`GITHUB_TOKEN=${gh}`]),
    ].join('\n')
    expect(scanPatchForSecrets(patch).map((h) => [h.file, h.line])).toEqual([['b.env', 1]])
  })

  it('ignores text outside a hunk, even lines that start with +', () => {
    const patch = [
      `(summary) dist/bundle.js: 4.2 MB generated, not shown; GITHUB_TOKEN=${githubToken(71)}`,
      newFilePatch('a.env', ['X=1', `GITHUB_TOKEN=${gh}`]),
      `+3 more lines in dist/bundle.js omitted: GITHUB_TOKEN=${githubToken(72)}`,
      ` context-looking note GITHUB_TOKEN=${githubToken(73)}`,
      '',
    ].join('\n')
    const hits = scanPatchForSecrets(patch)
    expect(hits.map((h) => [h.file, h.line, h.masked])).toEqual([['a.env', 2, maskSecret(gh)]])
  })

  it('treats an added line that starts with ++ as content, not a file header', () => {
    const patch = newFilePatch('src/a.ts', ['let i = 0', `++i; const t = '${gh}'`, 'done()'])
    expect(scanPatchForSecrets(patch).map((h) => [h.file, h.line])).toEqual([['src/a.ts', 2]])
  })

  it('reads a plain unified diff without a git header', () => {
    const patch = ['--- a/x.env', '+++ b/x.env\t2026-01-01 00:00:00', '@@ -0,0 +1 @@', `+T=${gh}`, ''].join(
      '\n',
    )
    expect(scanPatchForSecrets(patch).map((h) => [h.file, h.line])).toEqual([['x.env', 1]])
  })
})

describe('maskSecret', () => {
  it('shows the first 4 characters of a long value and its length', () => {
    expect(maskSecret(k('AK', 'IA', 'Q'.repeat(16)))).toBe('AKIA… (20 chars)')
    expect(maskSecret('ABCDEFGHIJKLMNOP')).toBe('ABCD… (16 chars)')
  })

  it('shows 2 characters of a value shorter than 16', () => {
    expect(maskSecret('ABCDEFGHIJ')).toBe('AB… (10 chars)')
    expect(maskSecret('ABCDEFGHIJKLMNO')).toBe('AB… (15 chars)')
  })

  it('never shows more than half of a tiny value', () => {
    expect(maskSecret('')).toBe('… (0 chars)')
    expect(maskSecret('A')).toBe('… (1 chars)')
    expect(maskSecret('ABC')).toBe('A… (3 chars)')
  })

  it('never contains the whole value', () => {
    for (let n = 1; n <= 64; n++) {
      const v = synth(UPPER, n, 100 + n)
      const masked = maskSecret(v)
      expect(masked).not.toContain(v)
      expect(masked.split('…')[0]?.length).toBeLessThanOrEqual(Math.min(4, n / 2))
      expect(masked.split('…')).toHaveLength(2)
    }
  })
})

describe('shannonEntropy', () => {
  it('measures bits per character', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaa')).toBe(0)
    expect(shannonEntropy('ab')).toBeCloseTo(1)
    expect(shannonEntropy('abcd')).toBeCloseTo(2)
    expect(shannonEntropy(HEX)).toBeCloseTo(4)
    const random = shannonEntropy(synth(B64, 64, 7))
    expect(random).toBeGreaterThan(4.5)
    expect(random).toBeLessThanOrEqual(6)
  })
})

describe('isAllowlistedPath', () => {
  it('matches lockfiles and fixtures, case-insensitive, either separator', () => {
    expect(isAllowlistedPath('PNPM-LOCK.YAML')).toBe(true)
    expect(isAllowlistedPath('a\\b\\yarn.lock')).toBe(true)
    expect(isAllowlistedPath('gradle.lockfile')).toBe(true)
    expect(isAllowlistedPath('src\\__Fixtures__\\x.json')).toBe(true)
    expect(isAllowlistedPath('x.snap')).toBe(true)
  })

  it('does not match ordinary sources or test files', () => {
    expect(isAllowlistedPath('src/app.ts')).toBe(false)
    expect(isAllowlistedPath('src/foo.test.ts')).toBe(false)
    expect(isAllowlistedPath('src/fixtures.ts')).toBe(false)
    expect(isAllowlistedPath('yarn.lock.ts')).toBe(false)
  })
})

describe('cap and ordering', () => {
  const patch = [
    newFilePatch(
      'z.env',
      Array.from({ length: 60 }, (_, i) => `K${i}=${awsKeyId(200 + i)}`),
    ),
    newFilePatch(
      'a.env',
      Array.from({ length: 3 }, (_, i) => `K${i}=${awsKeyId(300 + i)}`),
    ),
  ].join('\n')

  it('sorts by file then line and caps at 50 by default', () => {
    const hits = scanPatchForSecrets(patch)
    expect(hits).toHaveLength(50)
    expect(hits.slice(0, 4).map((h) => [h.file, h.line])).toEqual([
      ['a.env', 1],
      ['a.env', 2],
      ['a.env', 3],
      ['z.env', 1],
    ])
  })

  it('honours maxHits', () => {
    expect(scanPatchForSecrets(patch, { maxHits: 5 })).toHaveLength(5)
    expect(scanPatchForSecrets(patch, { maxHits: 0 })).toEqual([])
    expect(scanPatchForSecrets(patch, { maxHits: 1000 })).toHaveLength(63)
  })
})

describe('scanTextForSecrets', () => {
  const gh = githubToken(80)

  it('numbers lines from firstLine, CRLF or LF', () => {
    const text = ['a', 'b', `GITHUB_TOKEN=${gh}`].join('\r\n')
    expect(scanTextForSecrets('src\\x.env', text, 10)).toMatchObject([
      { file: 'src/x.env', line: 12, rule: 'github-token', masked: maskSecret(gh) },
    ])
    expect(scanTextForSecrets('x.env', text.replace(/\r/g, ''))).toMatchObject([{ line: 3 }])
  })

  it('skips an allowlisted path', () => {
    expect(scanTextForSecrets('tests/__fixtures__/x.env', `GITHUB_TOKEN=${gh}`)).toEqual([])
  })
})

describe('rules', () => {
  it('have unique ids and plain ASCII labels', () => {
    const ids = SECRET_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of SECRET_RULES) {
      expect(r.label).toMatch(/^[\x20-\x7e]+$/)
      expect(r.label).not.toContain(String.fromCodePoint(0x2014))
    }
  })
})

describe('performance', () => {
  it('scans a 5 MB patch quickly', () => {
    const templates = [
      (i: number) => `  const apiKey = config.get('service.key.${i}')`,
      (i: number) => `  export function handler${i}(req: Request): Response { return respond(req, ${i}) }`,
      (i: number) => `  "integrity": "sha512-${synth(B64, 86, i)}==",`,
      (i: number) => `  // token refresh for the auth flow number ${i}, see the session module`,
      (i: number) => `  const digest = '${synth(HEX, 40, i)}'`,
    ]
    const lines: string[] = []
    let size = 0
    for (let i = 0; size < 5 * 1024 * 1024; i++) {
      const l = (templates[i % templates.length] ?? templates[0])?.(i) ?? ''
      lines.push(l)
      size += l.length + 2
    }
    lines.splice(1000, 0, `GITHUB_TOKEN=${githubToken(90)}`)
    const patch = newFilePatch('src/big.ts', lines)
    const started = performance.now()
    const hits = scanPatchForSecrets(patch)
    const elapsed = performance.now() - started
    expect(hits.map((h) => [h.rule, h.line])).toEqual([['github-token', 1001]])
    expect(elapsed).toBeLessThan(2000)
  })
})
