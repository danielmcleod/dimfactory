// A deterministic secret scanner over a run's git diff: no model, no network, no file access. Only lines the diff
// ADDS are read (removed and context lines are not the run's doing), with their line numbers in the new file. Two
// kinds of hit: a `pattern` hit is a well-known token format (AWS, GitHub, Slack, Stripe, private key blocks, a
// password in a URL, a quoted password assignment, ...), and an `entropy` hit is a long random-looking string on a
// line that names a key, secret, token or password. Lockfiles, obvious test fixtures, snapshots, minified bundles,
// source maps and very long lines are skipped, and so are values that read as placeholders (`your_key_here`,
// `${TOKEN}`, `xxxx`, the AWS documentation key). A hit carries only a masked prefix of the value and its length: the
// full value is never returned, so findings built from hits can be shown and sent on without leaking the secret.

export type SecretConfidence = 'pattern' | 'entropy'

export interface SecretHit {
  /** Path as in the diff's new side (`b/` stripped), '/' separators. */
  file: string
  /** 1-based line number in the NEW file. */
  line: number
  /** Stable rule id, e.g. 'aws-access-key-id', 'github-token', 'private-key', 'entropy'. */
  rule: string
  /** UI copy for the kind, e.g. 'AWS access key ID'. */
  label: string
  /** maskSecret(value): never the full value. */
  masked: string
  confidence: SecretConfidence
}

export interface SecretScanOptions {
  /** At most this many hits, after sorting (default 50). */
  maxHits?: number
}

const DEFAULT_MAX_HITS = 50
/** Longer added lines are minified or generated output: not scanned. */
const MAX_LINE_LENGTH = 4000

interface PatternRule {
  id: string
  label: string
  /** Global, with indices (`dg`); the value is the named group `v` when present, else the whole match. */
  re: RegExp
  /** A further check on the value, after the placeholder guard. */
  accept?: (value: string) => boolean
}

const hasDigit = (s: string): boolean => /[0-9]/.test(s)
const hasUpper = (s: string): boolean => /[A-Z]/.test(s)
const hasLower = (s: string): boolean => /[a-z]/.test(s)

/** Words that stand for a password in a URL template rather than one: `postgres://user:password@host`. */
const URL_PASSWORD_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'pw',
  'secret',
  'user',
  'username',
  'token',
])

function acceptUrlPassword(value: string): boolean {
  if (URL_PASSWORD_WORDS.has(value.toLowerCase())) return false
  if (value.includes('*')) return false
  return !/^[$%]/.test(value)
}

function acceptGenericValue(value: string): boolean {
  // An environment or template reference, a path or URL, an UPPER_CASE name, a dotted key: not a literal secret.
  if (/^[$%]/.test(value) || value.startsWith('process.env')) return false
  if (/^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(value) || value.includes('://')) return false
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/i.test(value)) return false
  if (value.includes('*')) return false
  return new Set(value).size >= 4
}

/** Most specific first: when two rules match the same value, the earlier rule keeps it. */
const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: 'private-key',
    label: 'Private key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/dg,
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key ID',
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  },
  {
    id: 'aws-secret-access-key',
    label: 'AWS secret access key',
    re: /aws[A-Za-z0-9_.-]{0,40}?secret[A-Za-z0-9_.-]{0,40}["']?\s{0,5}(?::=|=>|[:=])\s{0,5}["']?(?<v>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi,
    accept: (v) => hasDigit(v) && hasUpper(v) && hasLower(v),
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9])/dg,
  },
  {
    id: 'github-fine-grained-token',
    label: 'GitHub fine-grained token',
    re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82,240}(?![A-Za-z0-9_])/dg,
  },
  {
    id: 'gitlab-token',
    label: 'GitLab personal access token',
    re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,250}/dg,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9]{8,40}-[A-Za-z0-9-]{8,250}/dg,
  },
  {
    id: 'slack-webhook',
    label: 'Slack webhook URL',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{6,12}\/B[A-Za-z0-9]{6,12}\/[A-Za-z0-9]{20,32}/dg,
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe live secret key',
    re: /(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{24,247}/dg,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    re: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/dg,
  },
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API key',
    re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{80,300}/dg,
  },
  {
    id: 'openai-api-key',
    label: 'OpenAI API key',
    re: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{40,300}/dg,
    accept: (v) => hasDigit(v.slice(3)) && hasUpper(v.slice(3)) && hasLower(v.slice(3)),
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}/dg,
  },
  {
    id: 'npm-token',
    label: 'npm access token',
    re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/dg,
  },
  {
    id: 'pypi-token',
    label: 'PyPI API token',
    re: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000}/dg,
  },
  {
    id: 'sendgrid-api-key',
    label: 'SendGrid API key',
    re: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/dg,
  },
  {
    id: 'twilio-api-key',
    label: 'Twilio API key',
    re: /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/dg,
  },
  {
    id: 'azure-storage-key',
    label: 'Azure storage account key',
    re: /AccountKey=(?<v>[A-Za-z0-9+/]{80,200}={0,2})/dg,
  },
  {
    id: 'url-credentials',
    label: 'Password in a URL',
    re: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:/@'"<>]{0,100}:(?<v>[^\s:/@'"]{1,200})@[A-Za-z0-9.-]{1,253}/dg,
    accept: acceptUrlPassword,
  },
  {
    id: 'generic-secret',
    label: 'Hardcoded password or secret',
    re: /(?:password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|client[_-]?secret)["']?\s{0,10}(?::=|=>|[:=])\s{0,10}["'](?<v>[^"'\s]{8,200})["']/dgi,
    accept: acceptGenericValue,
  },
]

const ENTROPY_RULE = { id: 'entropy', label: 'High-entropy string near a secret name' } as const

/** Every rule the scanner can report, in priority order. */
export const SECRET_RULES: readonly { id: string; label: string }[] = [
  ...PATTERN_RULES.map(({ id, label }) => ({ id, label })),
  { id: ENTROPY_RULE.id, label: ENTROPY_RULE.label },
]

const RULE_ORDER: ReadonlyMap<string, number> = new Map(SECRET_RULES.map((r, i) => [r.id, i]))

// --- placeholders -----------------------------------------------------------------------------------------------

const PLACEHOLDER_PARTS: readonly string[] = [
  'example',
  'sample',
  'dummy',
  'fake',
  'placeholder',
  'changeme',
  'change_me',
  'your_',
  'your-',
  '<',
  '>',
  '${',
  '{{',
  'xxxx',
  '0000000000',
  'redacted',
  'test_key',
  'insert',
]

/** A value that stands in for a secret rather than being one (AWS's documented example key included). */
function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase()
  return PLACEHOLDER_PARTS.some((p) => lower.includes(p))
}

// --- masking and entropy ----------------------------------------------------------------------------------------

/**
 * A value safe to show: its first 4 characters (2 when it is shorter than 16, and never more than half of it), an
 * ellipsis and its length, e.g. `AKIA… (20 chars)`.
 */
export function maskSecret(value: string): string {
  const chars = Array.from(value)
  const n = chars.length
  const shown = Math.min(n < 16 ? 2 : 4, Math.floor(n / 2))
  return `${chars.slice(0, shown).join('')}\u2026 (${n} chars)`
}

/** Shannon entropy in bits per character, over the string's own character frequencies (0 for ''). */
export function shannonEntropy(value: string): number {
  const chars = Array.from(value)
  if (chars.length === 0) return 0
  const freq = new Map<string, number>()
  for (const c of chars) freq.set(c, (freq.get(c) ?? 0) + 1)
  let bits = 0
  for (const count of freq.values()) {
    const p = count / chars.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// --- allowlisted paths ------------------------------------------------------------------------------------------

const LOCKFILES: ReadonlySet<string> = new Set(
  [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'go.sum',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'composer.lock',
    'Gemfile.lock',
    'packages.lock.json',
    'gradle.lockfile',
  ].map((name) => name.toLowerCase()),
)

const FIXTURE_DIRS: ReadonlySet<string> = new Set([
  '__fixtures__',
  'fixtures',
  '__mocks__',
  'testdata',
  'test-data',
  '__snapshots__',
])

/**
 * Paths whose contents are not scanned: lockfiles, test fixture folders, snapshot files, minified bundles and source
 * maps. Case-insensitive; '/' or '\' separators. A plain test file is not allowlisted: a real key there still leaks.
 */
export function isAllowlistedPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').toLowerCase().split('/')
  const base = segments[segments.length - 1] ?? ''
  if (LOCKFILES.has(base)) return true
  if (base.endsWith('.snap') || base.endsWith('.min.js') || base.endsWith('.map')) return true
  return segments.slice(0, -1).some((s) => FIXTURE_DIRS.has(s))
}

// --- one line ---------------------------------------------------------------------------------------------------

interface Candidate {
  rule: string
  label: string
  confidence: SecretConfidence
  start: number
  end: number
  value: string
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end && b.start < a.end

function patternCandidates(text: string): Candidate[] {
  const kept: Candidate[] = []
  for (const rule of PATTERN_RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      const value = m.groups?.['v'] ?? m[0]
      const span = m.indices?.groups?.['v'] ?? m.indices?.[0] ?? [m.index, m.index + m[0].length]
      if (isPlaceholder(value)) continue
      if (rule.accept && !rule.accept(value)) continue
      const c: Candidate = {
        rule: rule.id,
        label: rule.label,
        confidence: 'pattern',
        start: span[0],
        end: span[1],
        value,
      }
      // An earlier (more specific) rule already holds this value: the later one adds nothing.
      if (kept.some((k) => overlaps(k, c))) continue
      kept.push(c)
      break
    }
  }
  return kept
}

/** Cheap first look: a line with none of these cannot name a secret. */
const SECRETISH_HINT = /key|secret|token|passw|pwd|credential|auth|api|private|signature|salt/i
const SECRETISH_PARTS: ReadonlySet<string> = new Set([
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'creds',
  'auth',
  'authorization',
  'api',
  'private',
  'signature',
  'salt',
])
const SECRETISH_SUFFIX =
  /(?:key|keys|secret|secrets|token|tokens|password|passwd|pwd|credential|credentials|signature|salt)$/

/** Whether `text` names a secret: one of the words as an identifier part (`apiKey`, `DB_PASSWORD`, `signingSalt`). */
function namesSecret(text: string): boolean {
  if (!SECRETISH_HINT.test(text)) return false
  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    if (SECRETISH_SUFFIX.test(word.toLowerCase())) return true
    for (const part of word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []) {
      if (SECRETISH_PARTS.has(part.toLowerCase())) return true
    }
  }
  return false
}

const TOKEN_RUN = /[A-Za-z0-9+/=_.-]{24,}/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^[0-9a-f]+$/i
const INTEGRITY_PREFIX = /^sha(?:1|256|384|512)-/i
/** Stripe test and publishable keys: not secrets. */
const NOT_SECRET_PREFIX = /^(?:sk|rk|pk)_test_|^pk_live_/
const DOMAIN_START = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\//

function looksLikeUrlOrPath(token: string): boolean {
  if (/^(?:\.{1,2}\/|\/|~\/|https?)/i.test(token)) return true
  if (!token.includes('/')) return false
  if (DOMAIN_START.test(token)) return true
  // A lower-case path like `src/core/a.ts` (base64 has upper case or '+').
  return !token.includes('+') && /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/.test(token)
}

/** One character class only (all digits, all lower, all upper): an id or a word, not a key. */
function singleClass(token: string): boolean {
  let classes = 0
  if (hasDigit(token)) classes++
  if (hasUpper(token)) classes++
  if (hasLower(token)) classes++
  return classes <= 1
}

function entropyCandidate(text: string, pattern: readonly Candidate[]): Candidate | null {
  if (!SECRETISH_HINT.test(text)) return null
  const found: { start: number; end: number; value: string }[] = []
  TOKEN_RUN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RUN.exec(text)) !== null) {
    // Split `NAME=value` inside one run at an '=' that is not base64 padding.
    const run = m[0]
    let pieceStart = 0
    for (let i = 0; i <= run.length; i++) {
      const atSplit = i < run.length && run[i] === '=' && i + 1 < run.length && run[i + 1] !== '='
      if (i < run.length && !atSplit) continue
      const piece = run.slice(pieceStart, i)
      const start = m.index + pieceStart
      pieceStart = i + 1
      if (piece.length < 24) continue
      if (!quotedOrAssigned(text, start)) continue
      if (!entropyWorthy(piece)) continue
      const c = { start, end: start + piece.length, value: piece }
      if (pattern.some((p) => overlaps(p, c))) continue
      found.push(c)
    }
  }
  const first = found[0]
  if (!first) return null
  // The secret name must be on the line itself, not inside the candidate strings.
  let rest = text
  for (const f of [...found].reverse()) rest = rest.slice(0, f.start) + ' ' + rest.slice(f.end)
  if (!namesSecret(rest)) return null
  return { rule: ENTROPY_RULE.id, label: ENTROPY_RULE.label, confidence: 'entropy', ...first }
}

/** The token is quoted, or follows `=` or `:` (spaces allowed). */
function quotedOrAssigned(text: string, start: number): boolean {
  let i = start - 1
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--
  const before = i >= 0 ? text[i] : undefined
  return before === '"' || before === "'" || before === '`' || before === '=' || before === ':'
}

function entropyWorthy(token: string): boolean {
  if (UUID.test(token) || singleClass(token)) return false
  if (INTEGRITY_PREFIX.test(token) || NOT_SECRET_PREFIX.test(token)) return false
  if (looksLikeUrlOrPath(token) || isPlaceholder(token)) return false
  // Hex has only 16 symbols, so its bar is lower; a token with no digit is more often a long identifier, so higher.
  const threshold = HEX.test(token) && token.length >= 32 ? 3.0 : hasDigit(token) ? 4.0 : 4.5
  return shannonEntropy(token) >= threshold
}

function scanLine(file: string, line: number, text: string, out: SecretHit[]): void {
  if (text.length > MAX_LINE_LENGTH) return
  const pattern = patternCandidates(text)
  const entropy = entropyCandidate(text, pattern)
  const all = entropy ? [...pattern, entropy] : pattern
  for (const c of all) {
    out.push({
      file,
      line,
      rule: c.rule,
      label: c.label,
      masked: maskSecret(c.value),
      confidence: c.confidence,
    })
  }
}

// --- the patch --------------------------------------------------------------------------------------------------

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 10,
  t: 9,
  r: 13,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  '"': 34,
  '\\': 92,
}

/** A git C-style quoted path (`"b/caf\303\251 x.ts"`): its text and the index just past the closing quote. */
function unquote(s: string, from: number): { text: string; end: number } {
  const bytes: number[] = []
  const encoder = new TextEncoder()
  let i = from + 1
  while (i < s.length && s[i] !== '"') {
    const ch = s[i] ?? ''
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1] ?? ''
      if (/[0-7]/.test(next)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0] ?? next
        bytes.push(parseInt(oct, 8) & 0xff)
        i += 1 + oct.length
        continue
      }
      const code = SIMPLE_ESCAPES[next]
      if (code !== undefined) bytes.push(code)
      else bytes.push(...encoder.encode(next))
      i += 2
      continue
    }
    const cp = s.codePointAt(i) ?? 0
    const one = String.fromCodePoint(cp)
    bytes.push(...encoder.encode(one))
    i += one.length
  }
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 }
}

/** A path from a `+++`, `rename to` or header field: unquoted, a trailing tab and timestamp dropped. */
function parsePathField(field: string): string {
  if (field.startsWith('"')) return unquote(field, 0).text
  const tab = field.indexOf('\t')
  return tab >= 0 ? field.slice(0, tab) : field
}

const stripB = (path: string): string => (path.startsWith('b/') ? path.slice(2) : path)

/** The new-side path of a `diff --git a/x b/x` header (null when it cannot be read). */
function parseGitHeader(rest: string): string | null {
  if (rest.startsWith('"')) {
    const a = unquote(rest, 0)
    const tail = rest.slice(a.end).replace(/^ /, '')
    return stripB(parsePathField(tail))
  }
  const quotedB = rest.indexOf(' "')
  if (quotedB >= 0) return stripB(unquote(rest, quotedB + 1).text)
  // `a/<p> b/<p>`: the two halves are the same path unless the file was renamed.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2
    const a = rest.slice(0, half)
    const b = rest.slice(half + 1)
    if (rest[half] === ' ' && a.replace(/^a\//, '') === b.replace(/^b\//, '')) return stripB(b)
  }
  const at = rest.lastIndexOf(' b/')
  return at >= 0 ? rest.slice(at + 3) : null
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Calls `onAdded` for every added line of every file the scan should read. */
function walkPatch(patch: string, onAdded: (file: string, line: number, text: string) => void): void {
  let file: string | null = null
  let skip = true
  let oldLeft = 0
  let newLeft = 0
  let newLine = 0
  const setFile = (path: string | null): void => {
    file = path === null ? null : path.replace(/\\/g, '/')
    skip = file === null || isAllowlistedPath(file)
  }
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0]
      if (c === '+' && newLeft > 0) {
        if (!skip && file !== null) onAdded(file, newLine, line.slice(1))
        newLine++
        newLeft--
        continue
      }
      if ((c === ' ' || line === '') && newLeft > 0) {
        newLine++
        newLeft--
        if (oldLeft > 0) oldLeft--
        continue
      }
      if (c === '-' && oldLeft > 0) {
        oldLeft--
        continue
      }
      if (c === '\\') continue
      // Anything else ends the hunk early (counts that did not add up).
      oldLeft = 0
      newLeft = 0
    }
    if (line.startsWith('diff --git ')) {
      setFile(parseGitHeader(line.slice('diff --git '.length)))
    } else if (line.startsWith('+++ ')) {
      const path = parsePathField(line.slice(4))
      setFile(path === '/dev/null' ? null : stripB(path))
    } else if (line.startsWith('rename to ')) {
      setFile(parsePathField(line.slice('rename to '.length)))
    } else if (line.startsWith('deleted file mode')) {
      skip = true
    } else if (line.startsWith('@@ ')) {
      const h = HUNK_HEADER.exec(line)
      if (h) {
        oldLeft = Number(h[1] ?? '1')
        newLine = Number(h[2])
        newLeft = Number(h[3] ?? '1')
      }
    }
    // Everything else outside a hunk (index lines, mode lines, `Binary files ... differ`, notes) is not read.
  }
}

function finish(hits: SecretHit[], maxHits: number): SecretHit[] {
  const seen = new Set<string>()
  const unique = hits.filter((h) => {
    const key = `${h.file}\n${h.line}\n${h.rule}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (RULE_ORDER.get(a.rule) ?? 0) - (RULE_ORDER.get(b.rule) ?? 0),
  )
  return unique.slice(0, Math.max(0, maxHits))
}

/** Secrets on the lines a unified `git diff` adds, sorted by file then line, at most `maxHits` (default 50). */
export function scanPatchForSecrets(patch: string, o: SecretScanOptions = {}): SecretHit[] {
  const hits: SecretHit[] = []
  walkPatch(patch, (file, line, text) => scanLine(file, line, text, hits))
  return finish(hits, o.maxHits ?? DEFAULT_MAX_HITS)
}

/** Every line of `text` counts as added; line numbers start at `firstLine` (default 1). Same skips and cap. */
export function scanTextForSecrets(file: string, text: string, firstLine = 1): SecretHit[] {
  const path = file.replace(/\\/g, '/')
  if (isAllowlistedPath(path)) return []
  const hits: SecretHit[] = []
  text.split('\n').forEach((raw, i) => {
    scanLine(path, firstLine + i, raw.endsWith('\r') ? raw.slice(0, -1) : raw, hits)
  })
  return finish(hits, DEFAULT_MAX_HITS)
}
