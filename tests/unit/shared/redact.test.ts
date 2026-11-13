import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { redactJsonValue, redactLine, redactTempFolder, redactText } from '@shared/redact.ts'
import type { RedactMode, RedactOptions } from '@shared/redact.ts'

// Fake secrets are assembled at runtime so this file never contains a scanner-shaped literal.
const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const ANTHROPIC = 'sk-ant-' + 'api03-' + rep('Ab3_', 24)
const OPENAI = 'sk-' + 'proj-' + rep('Zq9', 24)
const GOOGLE = 'AI' + 'za' + rep('Sy7_x', 35)
const XAI = 'xai' + '-' + rep('Kx8', 24)
const AWS = 'AK' + 'IA' + rep('Q7Z', 16)
const GH_TOKEN = 'gh' + 'p_' + rep('aB3', 36)
const GH_PAT = 'github' + '_pat_' + rep('11A_', 30)
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + rep('sig_-', 20)
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const FIX = '<TOKEN>'
const DIAG = '[REDACTED]'

const fixture: RedactOptions = { mode: 'fixture' }
const diagnostics: RedactOptions = { mode: 'diagnostics' }

interface Case {
  rule: string
  input: string
  fixture: string
  diagnostics: string
}

const VALUE_CASES: Case[] = [
  { rule: 'pem', input: `a\n${PEM}\nb`, fixture: `a\n${FIX}\nb`, diagnostics: `a\n${DIAG}\nb` },
  {
    rule: 'anthropic-key',
    input: `ANTHROPIC_API_KEY=${ANTHROPIC}`,
    fixture: `ANTHROPIC_API_KEY=${FIX}`,
    diagnostics: `ANTHROPIC_API_KEY=${DIAG}`,
  },
  {
    rule: 'openai-key',
    input: `key: ${OPENAI} end`,
    fixture: `key: ${FIX} end`,
    diagnostics: `key: ${DIAG} end`,
  },
  { rule: 'google-key', input: `"${GOOGLE}"`, fixture: `"${FIX}"`, diagnostics: `"${DIAG}"` },
  {
    rule: 'xai-key',
    input: `XAI_API_KEY=${XAI}`,
    fixture: `XAI_API_KEY=${FIX}`,
    diagnostics: `XAI_API_KEY=${DIAG}`,
  },
  { rule: 'aws-key', input: `aws ${AWS} x`, fixture: `aws ${FIX} x`, diagnostics: `aws ${DIAG} x` },
  {
    rule: 'github-token',
    input: `GH_TOKEN=${GH_TOKEN}`,
    fixture: `GH_TOKEN=${FIX}`,
    diagnostics: `GH_TOKEN=${DIAG}`,
  },
  { rule: 'github-pat', input: `pat ${GH_PAT}`, fixture: `pat ${FIX}`, diagnostics: `pat ${DIAG}` },
  { rule: 'jwt', input: `jwt=${JWT};`, fixture: `jwt=${FIX};`, diagnostics: `jwt=${DIAG};` },
  {
    rule: 'bearer',
    input: 'Authorization: Bearer abc.DEF_ghi-123~+/=',
    fixture: `Authorization: Bearer ${FIX}`,
    diagnostics: `Authorization: Bearer ${DIAG}`,
  },
  {
    rule: 'url-credentials',
    input: 'git clone https://jane:hunter22@git.example.com/r.git',
    fixture: `git clone https://${FIX}@git.example.com/r.git`,
    diagnostics: `git clone https://${DIAG}@git.example.com/r.git`,
  },
  {
    rule: 'email',
    input: 'mail jane.doe+ci@corp.example.com now',
    fixture: 'mail user@example.invalid now',
    diagnostics: 'mail [email] now',
  },
]

describe('redactText value rules', () => {
  for (const c of VALUE_CASES) {
    it(`${c.rule}: fixture and diagnostics modes`, () => {
      const f = redactText(c.input, fixture)
      expect(f.text).toBe(c.fixture)
      expect(f.counts[c.rule]).toBe(1)
      const d = redactText(c.input, diagnostics)
      expect(d.text).toBe(c.diagnostics)
      expect(d.counts[c.rule]).toBe(1)
    })
  }

  it('heal mode redacts like diagnostics', () => {
    expect(redactText(`k=${OPENAI} jane@corp.example.com`, { mode: 'heal' }).text).toBe(`k=${DIAG} [email]`)
  })

  it('leaves already-safe emails alone and does not count them', () => {
    const r = redactText('from user@example.invalid', fixture)
    expect(r.text).toBe('from user@example.invalid')
    expect(r.counts).toEqual({})
  })

  it('does not treat sk-/xai- inside ordinary words as keys', () => {
    const text =
      'a task-specific-instruction-set and risk-assessment-framework-v2 and taxai-abcdefghijklmnopqrstuvw'
    const r = redactText(text, diagnostics)
    expect(r.text).toBe(text)
    expect(r.counts).toEqual({})
  })

  it('redacts several secrets on one line and counts each rule', () => {
    const r = redactText(`${ANTHROPIC} ${OPENAI} ${OPENAI}`, fixture)
    expect(r.text).toBe(`${FIX} ${FIX} ${FIX}`)
    expect(r.counts).toEqual({ 'anthropic-key': 1, 'openai-key': 2 })
  })
})

describe('redactText path rules', () => {
  it('replaces the home directory in every spelling, case-insensitively', () => {
    const input =
      'a C:\\Users\\jane\\.claude b C:/Users/jane/.codex c "C:\\\\Users\\\\jane\\\\x" d c:\\users\\JANE\\y'
    const expected = 'a ~\\.claude b ~/.codex c "~\\\\x" d ~\\y'
    for (const mode of ['fixture', 'diagnostics'] as const) {
      const r = redactText(input, { mode, home: 'C:\\Users\\jane' })
      expect(r.text).toBe(expected)
      expect(r.counts['home']).toBe(4)
    }
  })

  it('replaces a POSIX home', () => {
    expect(redactText('/home/jane/.config and /home/jane', { ...diagnostics, home: '/home/jane' }).text).toBe(
      '~/.config and ~',
    )
  })

  it('replaces the user name only as a Users/home path segment', () => {
    const input =
      '/home/jane/x /Users/jane/y D:\\Users\\jane\\z "D:\\\\Users\\\\jane\\\\w" "/home/jane" /home/janet/q jane said /tmp/jane/x /home/jane'
    const r = redactText(input, { ...fixture, username: 'jane' })
    expect(r.text).toBe(
      '/home/user/x /Users/user/y D:\\Users\\user\\z "D:\\\\Users\\\\user\\\\w" "/home/user" /home/janet/q jane said /tmp/jane/x /home/user',
    )
    expect(r.counts['username']).toBe(6)
    expect(redactText('/Users/jane/y', { ...diagnostics, username: 'jane' }).text).toBe('/Users/<user>/y')
  })

  it('replaces the host name', () => {
    expect(redactText('on jane-pc1.local', { ...fixture, hostname: 'JANE-PC1' }).text).toBe('on host.local')
    expect(redactText('on jane-pc1.local', { ...diagnostics, hostname: 'JANE-PC1' }).text).toBe(
      'on <host>.local',
    )
  })

  it('replaces cwd in fixture mode only, before home', () => {
    const opts = { home: 'C:\\Users\\jane', cwd: 'C:\\Users\\jane\\proj' }
    const input = 'C:\\Users\\jane\\proj\\src\\a.ts C:/Users/jane/proj/b.ts C:\\Users\\jane\\other'
    expect(redactText(input, { ...opts, mode: 'fixture' }).text).toBe('<CWD>\\src\\a.ts <CWD>/b.ts ~\\other')
    expect(redactText(input, { ...opts, mode: 'diagnostics' }).text).toBe(
      '~\\proj\\src\\a.ts ~/proj/b.ts ~\\other',
    )
  })
})

// Live Codex recordings kept a scratch path's session id where PowerShell cut or wrapped the sandbox
// folder in its tables (no rule saw it whole). The temp folder and what follows it become <TMP>.
describe('redactTempFolder (fixture recordings)', () => {
  const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
  const win = { tmp: 'C:\\Users\\jane\\AppData\\Local\\Temp', home: 'C:\\Users\\jane', caseInsensitive: true }
  const scratch = `AppData\\Local\\Temp\\tool\\C---proj\\${SESSION}`

  it('takes the folder and every segment under it, in each spelling and in the ~ form', () => {
    const cases: [string, string][] = [
      [
        `Directory: C:\\Users\\jane\\${scratch}\\scrat\r\n    chpad\\live\\sbx\\X04`,
        'Directory: <TMP>\r\n    chpad\\live\\sbx\\X04',
      ],
      [`Directory: ~\\${scratch}\\scrat\r\n    chpad\\live`, 'Directory: <TMP>\r\n    chpad\\live'],
      [`~\\${scratch}\\scratchpad\\live\\s...\r\nsrc\\index.ts`, '<TMP>\r\nsrc\\index.ts'],
      [`{"delta":"~\\\\${scratch.replace(/\\/g, '\\\\')}\\\\scrat\\r\\n"}`, '{"delta":"<TMP>\\r\\n"}'],
      [`"c:/users/JANE/appdata/local/temp/x/y.txt" next`, '"<TMP>" next'],
      [
        `{"line":"under \\"C:\\\\\\\\Users\\\\\\\\jane\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\a\\\\\\\\b\\""}`,
        '{"line":"under \\"<TMP>\\""}',
      ],
      // Each line of a listing in JSON text: the second path follows an escaped newline (`\n`), not a word.
      [
        `{"o":"~\\\\${scratch.replace(/\\/g, '\\\\')}\\\\s...\\r\\n~\\\\${scratch.replace(/\\/g, '\\\\')}\\\\s...\\r\\n"}`,
        '{"o":"<TMP>\\r\\n<TMP>\\r\\n"}',
      ],
      // The folder itself, as Codex names it in a warning (its own trailing separator stays).
      [
        `temporary dir "~\\\\AppData\\\\Local\\\\Temp\\\\" (codex_home)`,
        'temporary dir "<TMP>\\\\" (codex_home)',
      ],
    ]
    for (const [input, want] of cases) {
      const r = redactTempFolder(input, win)
      expect({ input, got: r.text }).toEqual({ input, got: want })
      expect(r.count).toBe(want.split('<TMP>').length - 1)
      expect(redactTempFolder(r.text, win)).toEqual({ text: r.text, count: 0 })
      expect(r.text).not.toContain(SESSION)
    }
  })

  it('leaves what only looks like it: a longer folder, another folder named Temp, a URL', () => {
    for (const text of [
      'C:\\Users\\jane\\AppData\\Local\\Temporary\\x',
      'D:\\AppData\\Local\\Temp\\x',
      'see https://example.com/tmp/x and /var/tmp/x',
      '<CWD>\\src\\a.ts and <TMP>\\x',
    ])
      expect(redactTempFolder(text, win)).toEqual({ text, count: 0 })
    const posix = { tmp: '/tmp', home: '/home/jane' }
    expect(redactTempFolder('cd /tmp/dim-factory-x/sbx && ls /var/tmp/y', posix).text).toBe(
      'cd <TMP> && ls /var/tmp/y',
    )
    expect(redactTempFolder('https://example.com/tmp/x /tmpfoo', posix).count).toBe(0)
    // Case is folded only where the file system folds it.
    expect(redactTempFolder('/TMP/x', posix).count).toBe(0)
  })
})

describe('redactJsonValue / redactLine', () => {
  const frame = {
    type: 'system',
    subtype: 'init',
    apiKey: 'plain-value',
    api_key: 'plain',
    token: 'abc',
    access_token: 'xyz',
    authorization: 'Basic Zm9vOmJhcg==',
    password: 'pw',
    usage: { input_tokens: 12, output_tokens: 7, max_tokens: 4096 },
    limits: { max_tokens: '4096', input_tokens: '12', output_tokens: '7', tokens: '99' },
    account: {
      email: 'jane@corp.example.com',
      organization: 'Acme Corp',
      org_name: 'Acme',
      account_uuid: '0000-1111',
      uuid: 'u-1',
      user_id: 'user_123',
    },
    nested: [{ client_secret: 's3', note: 'call me at jane@corp.example.com' }],
    model: 'claude-sonnet',
  }

  const expected = (mode: RedactMode): unknown => {
    const t = mode === 'fixture' ? FIX : DIAG
    const acct = mode === 'fixture' ? '<REDACTED>' : '[REDACTED]'
    return {
      type: 'system',
      subtype: 'init',
      apiKey: t,
      api_key: t,
      token: t,
      access_token: t,
      authorization: t,
      password: t,
      usage: { input_tokens: 12, output_tokens: 7, max_tokens: 4096 },
      limits: { max_tokens: '4096', input_tokens: '12', output_tokens: '7', tokens: '99' },
      account: {
        email: mode === 'fixture' ? 'user@example.invalid' : '[REDACTED]',
        organization: acct,
        org_name: acct,
        account_uuid: acct,
        uuid: acct,
        user_id: acct,
      },
      nested: [
        { client_secret: t, note: `call me at ${mode === 'fixture' ? 'user@example.invalid' : '[email]'}` },
      ],
      model: 'claude-sonnet',
    }
  }

  for (const mode of ['fixture', 'diagnostics'] as const) {
    it(`applies secret-key and account-key rules (${mode})`, () => {
      const r = redactJsonValue(frame, { mode })
      expect(r.value).toEqual(expected(mode))
      expect(r.counts['secret-key']).toBe(7)
      expect(r.counts['account-key']).toBe(6)
      expect(r.counts['email']).toBe(1)
    })

    it(`redactLine parses JSON lines and keeps one line (${mode})`, () => {
      const r = redactLine(JSON.stringify(frame), { mode })
      expect(r.text).not.toContain('\n')
      expect(JSON.parse(r.text)).toEqual(expected(mode))
    })
  }

  it('strips stable install and account ids (Codex remote control, rate limits, workspace routing)', () => {
    const frame = {
      remote: { serverName: 'host', installationId: 'i-1', environmentId: null },
      limits: { accountId: 'a-1', previousAccountId: 'a-0', planType: 'plus' },
      routing: { chatgptAccountId: 'c-1', backendOrigin: 'https://chatgpt.example' },
      config: { forced_chatgpt_workspace_id: 'w-1', chatgpt_account_id: 'c-2', installation_id: 'i-2' },
      user: { userId: 'u-1', creatorAccountUserId: 'u-2' },
      // Not identities: a thread environment, a rate-limit bucket, a turn.
      ids: { environmentId: 'local', limitId: 'codex', turnId: 't-1' },
    }
    for (const mode of ['fixture', 'diagnostics'] as const) {
      const acct = mode === 'fixture' ? '<REDACTED>' : '[REDACTED]'
      const r = redactJsonValue(frame, { mode })
      expect(r.value).toEqual({
        remote: { serverName: 'host', installationId: acct, environmentId: null },
        limits: { accountId: acct, previousAccountId: acct, planType: 'plus' },
        routing: { chatgptAccountId: acct, backendOrigin: 'https://chatgpt.example' },
        config: { forced_chatgpt_workspace_id: acct, chatgpt_account_id: acct, installation_id: acct },
        user: { userId: acct, creatorAccountUserId: acct },
        ids: { environmentId: 'local', limitId: 'codex', turnId: 't-1' },
      })
      expect(r.counts['account-key']).toBe(9)
    }
  })

  it('never redacts token counts, as numbers or strings', () => {
    const r = redactJsonValue(
      { max_tokens: 1, maxTokens: '2', input_tokens: '3', output_tokens: 4, inputTokens: '5' },
      diagnostics,
    )
    expect(r.value).toEqual({
      max_tokens: 1,
      maxTokens: '2',
      input_tokens: '3',
      output_tokens: 4,
      inputTokens: '5',
    })
    expect(r.counts).toEqual({})
  })

  it('redacts JSON-escaped home paths inside JSON lines', () => {
    const line = JSON.stringify({ cwd: 'C:\\Users\\jane\\proj', note: 'see /home/jane/x' })
    const r = redactLine(line, { mode: 'diagnostics', home: 'C:\\Users\\jane', username: 'jane' })
    expect(JSON.parse(r.text)).toEqual({ cwd: '~\\proj', note: 'see /home/<user>/x' })
  })

  it('falls back to text rules for non-JSON lines', () => {
    expect(redactLine(`{not json ${OPENAI}`, fixture).text).toBe(`{not json ${FIX}`)
    expect(redactLine(`plain ${AWS}`, diagnostics).text).toBe(`plain ${DIAG}`)
  })
})

describe('idempotence', () => {
  const fullOpts = (mode: RedactMode): RedactOptions => ({
    mode,
    home: 'C:\\Users\\jane',
    username: 'jane',
    hostname: 'JANE-PC1',
    cwd: 'D:\\work\\proj',
  })

  it('redacting twice changes nothing more (corpus)', () => {
    const inputs = [
      ...VALUE_CASES.map((c) => c.input),
      'C:\\Users\\jane\\x D:\\work\\proj\\y /home/jane/z jane-pc1',
      JSON.stringify({ apiKey: 'k', account: { email: 'jane@corp.example.com' }, n: 'Bearer abcdefgh123' }),
    ]
    for (const mode of ['fixture', 'diagnostics', 'heal'] as const) {
      for (const input of inputs) {
        const once = redactLine(input, fullOpts(mode)).text
        expect(redactLine(once, fullOpts(mode)).text).toBe(once)
      }
    }
  })

  const SECRETS = [ANTHROPIC, OPENAI, GOOGLE, XAI, AWS, GH_TOKEN, GH_PAT, JWT, 'jane@corp.example.com']
  const FRAGMENTS = [
    ...SECRETS,
    'Bearer abcdefgh123',
    'https://u:p4ss@h.example.com/',
    'C:\\Users\\jane',
    'C:/Users/jane/',
    'C:\\\\Users\\\\jane\\\\',
    '/home/jane/',
    'D:\\work\\proj',
    'JANE-PC1',
    'task-specific-words',
    'user@example.invalid',
    '"',
    ':',
    '/',
    '\\',
    'x',
  ]

  it('is idempotent and leaks no separated secret (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 12 }),
        fc.constantFrom<RedactMode>('fixture', 'diagnostics'),
        (parts, mode) => {
          const glued = redactText(parts.join(''), fullOpts(mode)).text
          expect(redactText(glued, fullOpts(mode)).text).toBe(glued)
          const spaced = redactText(parts.join(' '), fullOpts(mode)).text
          expect(redactText(spaced, fullOpts(mode)).text).toBe(spaced)
          for (const s of [...SECRETS, 'p4ss']) expect(spaced).not.toContain(s)
        },
      ),
      { numRuns: 400 },
    )
  })
})
