// Security pass, shell.open / openExternal allowlists (executor open_docs "https only, and only
// allowlisted hosts"; boot hardening "https opens externally"; src/shared/external-links.ts is "the one https
// host allowlist"): the allowlist is plain https hosts; every place main hands a URL to the OS browser checks it
// first; and every documentation link core can offer passes it. The pass found Muse's docs link (dev.meta.ai, allowed for
// open_docs by the commands table) dropped because only a second, unused list in heal/commands.ts had the host.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_HOSTS, docsUrlFor, isAllowedDocsUrl } from '../../../src/core/heal/commands.ts'
import { docsLink } from '../../../src/core/recovery/docs.ts'
import type { DocTopic } from '../../../src/core/recovery/docs.ts'
import { EXTERNAL_HOSTS, allowedExternalUrl } from '../../../src/shared/external-links.ts'
import { KNOWN_VENDORS } from '../../../src/shared/vendors.ts'

describe('the allowlist', () => {
  it('is plain lower-case host names: no scheme, port, path, wildcard or IP address', () => {
    for (const h of EXTERNAL_HOSTS) {
      expect(h).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      expect(h).not.toMatch(/^\d+(\.\d+){3}$/)
    }
    expect(new Set(EXTERNAL_HOSTS).size).toBe(EXTERNAL_HOSTS.length)
  })

  it.each([
    ['http, not https', 'http://github.com/openai/codex'],
    ['a look-alike suffix', 'https://evilgithub.com/'],
    ['the host as a subdomain of another', 'https://github.com.evil.example/'],
    ['credentials in the URL', 'https://user:pass@github.com/'],
    ['a custom port', 'https://github.com:444/'],
    ['an IP address', 'https://140.82.112.3/'],
    ['javascript:', 'javascript:alert(1)'],
    ['file:', 'file:///C:/Windows/System32/calc.exe'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a UNC-style host', 'https://\\\\evil\\share'],
    ['not a URL', 'github.com/openai'],
  ])('refuses %s', (_what, url) => {
    expect(allowedExternalUrl(url)).toBeNull()
  })

  it('normalizes what it lets through (case, trailing dot) and keeps the path', () => {
    expect(allowedExternalUrl('https://GitHub.com/openai/codex?tab=readme')).toBe(
      'https://github.com/openai/codex?tab=readme',
    )
    expect(allowedExternalUrl('https://docs.github.com./en')).toBe('https://docs.github.com./en')
  })
})

describe('the links core offers', () => {
  it("every vendor's setup guide passes the allowlist (Muse's had been dropped)", () => {
    for (const v of KNOWN_VENDORS) {
      const url = docsUrlFor(v)
      expect(url, v).not.toBeNull()
      expect(allowedExternalUrl(url ?? ''), v).toBe(url)
      expect(docsLink(v, 'install'), v).toBe(url)
    }
  })

  it('every docs topic link core has passes it (a link the allowlist refused would vanish from its card)', () => {
    const topics: DocTopic[] = ['install', 'billing', 'limits', 'proxy']
    for (const v of KNOWN_VENDORS)
      for (const t of topics) {
        const link = docsLink(v, t)
        if (link !== null) expect(allowedExternalUrl(link), `${v} ${t}`).toBe(link)
      }
    // The topics Dim Factory has pages for are all there (none silently refused).
    expect(docsLink('claude', 'billing')).not.toBeNull()
    expect(docsLink('codex', 'limits')).not.toBeNull()
    expect(docsLink('gemini', 'proxy')).not.toBeNull()
  })

  it("heal/commands.ts's docs hosts are all on the one allowlist", () => {
    for (const h of DOCS_HOSTS) expect(allowedExternalUrl(`https://${h}/`), h).not.toBeNull()
    for (const v of KNOWN_VENDORS) expect(isAllowedDocsUrl(docsUrlFor(v) ?? ''), v).toBe(true)
  })
})

// ---- every hand-off to the OS checks the list -----------------------------------------------------------------------

function mainFiles(): string[] {
  return readdirSync(resolve('src'), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}
const rel = (f: string): string => relative(resolve('.'), f).split(sep).join('/')
const code = (f: string): string =>
  readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

describe('the hand-offs to the OS', () => {
  it("Electron's shell is called from src/main/index.ts alone (everything else gets it injected)", () => {
    const using = mainFiles().filter((f) =>
      /\bshell\.(openExternal|openPath|showItemInFolder)\(/.test(code(f)),
    )
    expect(using.map(rel)).toEqual(['src/main/index.ts'])
  })

  it('each module index.ts hands openExternal to checks the allowlist before calling it', () => {
    for (const f of ['src/main/security.ts', 'src/main/main-handlers.ts', 'src/main/recovery-host.ts']) {
      const text = code(resolve(f))
      expect(text, f).toMatch(/allowedExternalUrl\(/)
    }
    // Run & Preview's Open in browser hands over only a loopback http URL (preview-model.ts openableUrl).
    expect(code(resolve('src/main/preview.ts'))).toMatch(/const url = openableUrl\(/)
    // index.ts wires openExternal into exactly those four (hardening, main handlers, the recovery host, previews).
    const index = code(resolve('src/main/index.ts'))
    expect(index.match(/shell\s*\n?\s*\.openExternal\(|shell\.openExternal\(/g)).toHaveLength(4)
  })

  it('shell.openPath opens only folders Dim Factory resolves (never a URL, never a file the renderer names)', () => {
    const text = code(resolve('src/main/main-handlers.ts'))
    // The one openPath call follows resolveShellOpen, whose `folder` target requires an existing directory.
    expect(text.match(/d\.openPath\(/g)).toHaveLength(1)
    expect(text).toMatch(
      /case 'folder':\s*\n\s*if \(!isAbsolute\(req\.path\) \|\| !\(await isDirectory\(req\.path\)\)\)/,
    )
  })
})
