// Security pass, redaction (storage "raw/ is redacted"; logs "metadata only";
// heal input; diagnostics): one corpus of secrets, in the shapes they come in (a key by its prefix, a key by its
// name only, an env line, a header, a TOML line, a CLI flag, a URL login, a JSON field), goes through every place text
// leaves a run or the app: the raw vendor log, the app log, a heal prompt's evidence, the diagnostics bundle, and the
// fixture recorder's rules (tests/unit/fixtures-redaction.test.ts checks every committed fixture with them). Nothing of
// any secret survives, and what is around it does. The pass found secrets known only by their name (META_API_KEY=…, an
// `api_key = "…"` line, an x-api-key header, `--token …`, Basic auth) passing every sink, and the app log keeping a
// secret-named field whole. A later review found the name rule missing names whose secret word is not last
// (AWS_SECRET_ACCESS_KEY, a Django SECRET_KEY, DB_PASSWORD_PROD, GITHUB_TOKEN_2).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanHealText, filterHealLine } from '../../../src/core/heal/heal-input.ts'
import { redactRaw } from '../../../src/core/heal/classify.ts'
import { createMemoryLogger, sanitizeLogValue } from '../../../src/core/log.ts'
import { RawLog } from '../../../src/core/supervisor/effects.ts'
import { redactDiagnosticLine } from '../../../src/main/diagnostics.ts'
import { redactJsonValue, redactLine, redactText } from '../../../src/shared/redact.ts'
import type { RedactMode } from '../../../src/shared/redact.ts'

// Fake secrets assembled at runtime, so this file never holds a scanner-shaped literal.
const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const S = {
  anthropic: 'sk-ant-' + 'api03-' + rep('Qw7_', 24),
  openai: 'sk-' + 'proj-' + rep('Zq9', 24),
  google: 'AI' + 'za' + rep('Sy7_x', 35),
  xai: 'xai' + '-' + rep('Kx8', 24),
  github: 'gh' + 'p_' + rep('aB3', 36),
  // Shapes no rule knows: only the name around them says they are secret.
  meta: rep('mT4kQ9', 40),
  npm: 'npm_' + rep('R2d2', 9),
  opaque: rep('p4ssW0rd', 18),
  basic: Buffer.from('jane:' + rep('hunter2', 14)).toString('base64'),
  urlPass: rep('s3cr3t', 12),
  // Secret words inside a longer name.
  awsId: 'AK' + 'IA' + rep('IOSFODNN7X', 16),
  awsSecret: 'wJalr' + 'XUtnFEMI/K7MDENG/' + rep('bPxRfiCY', 23),
  django: 'django-' + 'insecure-' + rep('a1b2c3', 30),
  dbPass: rep('Sup3rS3cret', 22),
  stripe: 'rk_' + 'live_' + rep('51Habc', 24),
  clientValue: rep('c1v2x3', 18),
  ghNumbered: rep('ghT0k3n', 18),
  privateKeyId: rep('9f8e7d6c5b4a', 40),
  awsFlag: rep('fLaG7s3c', 40),
}

/** Each secret as it shows up in text a vendor, a command or a log writes. */
const LINES: readonly { what: string; line: string; secret: string; keep?: string }[] = [
  {
    what: 'an Anthropic key',
    line: `ANTHROPIC_API_KEY=${S.anthropic}`,
    secret: S.anthropic,
    keep: 'ANTHROPIC_API_KEY=',
  },
  { what: 'an OpenAI key in prose', line: `using key ${S.openai} now`, secret: S.openai, keep: 'using key' },
  { what: 'a Google key', line: `GEMINI_API_KEY="${S.google}"`, secret: S.google },
  { what: 'an xAI key', line: `export XAI_API_KEY=${S.xai}`, secret: S.xai },
  { what: 'a GitHub token', line: `remote: ${S.github}`, secret: S.github },
  {
    what: 'a Meta key by its env name',
    line: `META_API_KEY=${S.meta}`,
    secret: S.meta,
    keep: 'META_API_KEY=',
  },
  { what: 'a key in a TOML line', line: `api_key = "${S.meta}"`, secret: S.meta, keep: 'api_key' },
  { what: 'an x-api-key header', line: `x-api-key: ${S.meta}`, secret: S.meta, keep: 'x-api-key:' },
  { what: 'a token flag', line: `muse exec --token ${S.meta} --json`, secret: S.meta, keep: '--json' },
  { what: 'an npm auth token', line: `//registry.npmjs.org/:_authToken=${S.npm}`, secret: S.npm },
  { what: 'a password field', line: `password: ${S.opaque}`, secret: S.opaque, keep: 'password:' },
  { what: 'a client secret', line: `CLIENT_SECRET='${S.opaque}'`, secret: S.opaque },
  {
    what: 'Basic auth',
    line: `Authorization: Basic ${S.basic}`,
    secret: S.basic,
    keep: 'Authorization: Basic',
  },
  { what: 'a bearer token', line: `Authorization: Bearer ${S.opaque}`, secret: S.opaque, keep: 'Bearer' },
  {
    what: 'an AWS access key id (its shape)',
    line: `AWS_ACCESS_KEY_ID=${S.awsId}`,
    secret: S.awsId,
    keep: 'AWS_ACCESS_KEY_ID=',
  },
  {
    what: 'an AWS secret access key (the secret word inside the name)',
    line: `AWS_SECRET_ACCESS_KEY=${S.awsSecret}`,
    secret: S.awsSecret,
    keep: 'AWS_SECRET_ACCESS_KEY=',
  },
  {
    what: 'a Django SECRET_KEY',
    line: `SECRET_KEY = '${S.django}'`,
    secret: S.django,
    keep: 'SECRET_KEY = ',
  },
  {
    what: 'a password name with a suffix',
    line: `DB_PASSWORD_PROD=${S.dbPass}`,
    secret: S.dbPass,
    keep: 'DB_PASSWORD_PROD=',
  },
  {
    what: 'a secret key name with a suffix',
    line: `STRIPE_SECRET_KEY_LIVE=${S.stripe}`,
    secret: S.stripe,
    keep: 'STRIPE_SECRET_KEY_LIVE=',
  },
  {
    what: 'a client secret value in YAML',
    line: `CLIENT_SECRET_VALUE: "${S.clientValue}"`,
    secret: S.clientValue,
    keep: 'CLIENT_SECRET_VALUE:',
  },
  {
    what: 'a numbered token',
    line: `GITHUB_TOKEN_2=${S.ghNumbered}`,
    secret: S.ghNumbered,
    keep: 'GITHUB_TOKEN_2=',
  },
  {
    what: 'a private key id in JSON text',
    line: `"private_key_id": "${S.privateKeyId}",`,
    secret: S.privateKeyId,
    keep: '"private_key_id": "',
  },
  {
    what: 'a flag whose secret word is not last',
    line: `aws configure --aws-secret-access-key ${S.awsFlag} --profile dev`,
    secret: S.awsFlag,
    keep: '--profile dev',
  },
  {
    what: 'a URL login',
    line: `git clone https://jane:${S.urlPass}@git.example.com/r.git`,
    secret: S.urlPass,
    keep: 'git.example.com/r.git',
  },
]

/** The same secrets as JSON a vendor frame or a log record carries. */
const JSON_FIELDS: Record<string, string> = {
  apiKey: S.meta,
  api_key: S.meta,
  access_token: S.opaque,
  refreshToken: S.opaque,
  client_secret: S.opaque,
  password: S.opaque,
  Authorization: `Basic ${S.basic}`,
  note: `set META_API_KEY=${S.meta} first`,
}

const NOT_SECRET = [
  'input_tokens: 123456789012',
  'tokens: 4096',
  'Token count 128000 exceeded',
  'the password field is required',
  'secret-scanning is on',
  'max_tokens=8192',
  'task-specific words, risk-based review',
  // The secret word inside a longer name, with a value that is a count, a flag or a short word.
  'max_tokens_to_sample=8192',
  'cache_read_input_tokens: 123456789012',
  'TOKEN_LIMIT=200000',
  '--token-limit 128000',
  'secret_scanning_enabled=true',
  'passwordless: enabled',
  'src/auth/token-store.ts:120:15 - error TS2322',
  'the secret keeper said hello',
]

const all = (text: string, secrets: readonly string[] = Object.values(S)): void => {
  for (const s of secrets) {
    expect(text).not.toContain(s)
    // Not a recognisable half either (a cut that left most of the secret behind).
    expect(text).not.toContain(s.slice(0, Math.ceil(s.length / 2)))
  }
}

describe('the shared rules (every sink is built on them)', () => {
  for (const mode of ['fixture', 'diagnostics', 'heal'] as const satisfies readonly RedactMode[]) {
    it(`redact every secret in a line (${mode})`, () => {
      for (const l of LINES) {
        const out = redactText(l.line, { mode }).text
        expect(out, l.what).not.toContain(l.secret)
        if (l.keep !== undefined) expect(out, l.what).toContain(l.keep)
        // Redacting again changes nothing.
        expect(redactText(out, { mode }).text, l.what).toBe(out)
      }
    })

    it(`redact every secret-named field of a JSON value (${mode})`, () => {
      const r = redactJsonValue({ frame: JSON_FIELDS, list: [JSON_FIELDS] }, { mode })
      all(JSON.stringify(r.value))
      expect(JSON.stringify(redactLine(JSON.stringify(JSON_FIELDS), { mode }).text)).not.toContain(S.meta)
    })
  }

  it('leave token counts and ordinary words alone', () => {
    for (const t of NOT_SECRET) expect(redactText(t, { mode: 'diagnostics' }).text).toBe(t)
  })

  it('redact an agent reading a .env file in a vendor JSON line', () => {
    // An agent's `cat .env` comes back as a tool result: one JSON line, the file's lines in one string.
    const env = [
      `AWS_ACCESS_KEY_ID=${S.awsId}`,
      `AWS_SECRET_ACCESS_KEY=${S.awsSecret}`,
      `SECRET_KEY=${S.django}`,
      `DB_PASSWORD_PROD=${S.dbPass}`,
      'DEBUG=true',
    ].join('\n')
    const line = JSON.stringify({ type: 'tool_result', content: env })
    for (const mode of ['fixture', 'diagnostics', 'heal'] as const) {
      const out = redactLine(line, { mode }).text
      all(out, [S.awsId, S.awsSecret, S.django, S.dbPass])
      expect(out).toContain('AWS_SECRET_ACCESS_KEY=')
      expect(out).toContain('DEBUG=true')
      // The same line seen as text (a log that could not parse it) is redacted too.
      all(redactText(line, { mode }).text, [S.awsId, S.awsSecret, S.django, S.dbPass])
    }
  })

  it('take linear time on a long run of name characters (an email or URL rule took about a minute)', () => {
    // One vendor line of 200 KB: hyphenated or dotted names, an @ at the very end, a run of a secret's name (with
    // and without a name tail after it).
    for (const line of [
      'abcd-'.repeat(40_000),
      'ab.c.'.repeat(40_000),
      `${'a.b+c'.repeat(40_000)}@x`,
      'token='.repeat(33_000),
      'token-'.repeat(33_000),
      'secret_key.'.repeat(18_000),
      '--api-key-'.repeat(20_000),
      'a:b/c'.repeat(40_000),
    ]) {
      const started = performance.now()
      redactText(line, { mode: 'diagnostics' })
      expect(performance.now() - started, line.slice(0, 12)).toBeLessThan(5_000)
    }
  })

  it('still find an email and a URL login of ordinary length inside such a run', () => {
    const run = 'x-'.repeat(5_000)
    const text = `${run} mail jane.doe@corp.example.com ${run} https://jane:${S.urlPass}@git.example.com/r.git`
    const out = redactText(text, { mode: 'diagnostics' }).text
    expect(out).not.toContain('jane.doe@corp.example.com')
    expect(out).not.toContain(S.urlPass)
    expect(out).toContain('[email]')
  })
})

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe('the raw vendor log (runs/<id>/raw)', () => {
  it('writes every line redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dim-factory-raw-'))
    roots.push(dir)
    const file = join(dir, 'implement-1.ndjson')
    const raw = new RawLog(file, 0, 'C:\\Users\\nobody')
    for (const l of LINES) raw.write('err', l.line)
    raw.write('out', JSON.stringify({ type: 'system', ...JSON_FIELDS }))
    raw.write('in', JSON.stringify({ type: 'control_response', response: { token: S.opaque } }))
    await raw.close()
    const text = readFileSync(file, 'utf8')
    all(text)
    expect(text.trim().split('\n')).toHaveLength(LINES.length + 2)
  })

  it("and the failure's raw excerpt is redacted too", () => {
    all(redactRaw(LINES.map((l) => l.line).join('\n')))
  })
})

describe('the app log (logs/main.log)', () => {
  it('redacts strings, and secret-named fields whatever their value looks like', () => {
    const log = createMemoryLogger()
    log.warn(`vendor said ${LINES.map((l) => l.line).join(' | ')}`, {
      ...JSON_FIELDS,
      nested: { env: { META_API_KEY: S.meta }, headers: { 'x-api-key': S.meta } },
      err: new Error(`401 for --token ${S.meta}`),
    })
    all(JSON.stringify(log.records))
    // What is not secret stays readable.
    expect(JSON.stringify(log.records)).toContain('vendor said')
  })

  it('sanitizeLogValue keeps token counts', () => {
    expect(sanitizeLogValue({ input_tokens: 12, maxTokens: '4096', tokens: 3 })).toEqual({
      input_tokens: 12,
      maxTokens: '4096',
      tokens: 3,
    })
  })
})

describe('the heal prompt evidence', () => {
  it('redacts every line it keeps', () => {
    const red = { mode: 'heal' as const }
    const kept = [
      ...LINES.map((l) => cleanHealText(l.line, red, 10_000)),
      ...LINES.map((l) => filterHealLine(`stderr: ${l.line}`, red) ?? ''),
      filterHealLine(JSON.stringify({ dir: 'err', line: LINES.map((l) => l.line).join(' ') }), red) ?? '',
    ]
    all(kept.join('\n'))
  })
})

describe('the diagnostics bundle', () => {
  it('redacts log and raw lines, text and JSON', () => {
    const counts: Record<string, number> = {}
    const out = [
      ...LINES.map((l) => redactDiagnosticLine(l.line, {}, counts)),
      redactDiagnosticLine(JSON.stringify({ msg: 'x', data: JSON_FIELDS }), {}, counts),
      redactDiagnosticLine(JSON.stringify({ env: { META_API_KEY: S.meta }, ...JSON_FIELDS }), {}, counts),
    ]
    all(out.join('\n'))
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(LINES.length)
  })
})
