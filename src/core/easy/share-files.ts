// "Before I share it", the files' half (the page's is main's): what the project's files would put online, read on this
// computer with no model and no network. The files are those the Deploy checklist reads (what git tracks or would add,
// else a bounded walk), hidden files left out as an upload leaves them out. Secrets come from the security advisor's
// scanner (a key meant for web pages is its own line), a real .env file is named without reading it out, and people's
// email addresses and phone numbers are found with plain patterns that skip the made-up ones (example.com, 555-01xx).
// Personal details are only flagged, with their values partly hidden: they are never sent anywhere. A document's links
// between its own files are checked too.
import { existsSync } from 'node:fs'
import { join, posix, relative, resolve, isAbsolute } from 'node:path'
import type { ShareFilesReport, SharePersonal } from '../../shared/share-check.ts'
import {
  BINARY_EXT,
  CHECK_TOTAL_MAX_BYTES,
  folderFiles,
  isEnvFile,
  isRestrictableKey,
  readSmall,
  secretLine,
} from '../deploy/checklist.ts'
import { scanTextForSecrets } from '../security/secrets.ts'

/** The most personal details and broken links listed (the rest are counted in the first). */
const LIST_MAX = 40

/** Files whose contents are tooling, not what a visitor reads. */
const SKIP_FILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$|\.(?:map|min\.js)$/i

/** Domains and names that stand for an address rather than being one. */
const PLACEHOLDER_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|domain\.com|yourdomain\.com|your-domain\.com|yoursite\.com|yourcompany\.com|company\.com|email\.com|mail\.com|users\.noreply\.github\.com)$/i
const PLACEHOLDER_LOCAL =
  /^(?:you|your\.?name|name|user|username|someone|somebody|email|noreply|no-reply|git)$/i
/** What follows an `@` in a file name or a package spec, not an address. */
const FILE_TLD =
  /\.(?:png|jpe?g|gif|webp|svg|avif|ico|js|mjs|cjs|ts|tsx|jsx|css|json|html?|md|woff2?|ttf|mp[34]|webm)$/i

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g
/** A tel: link always holds a phone number. */
const TEL = /tel:([+\d][\d\s().-]{5,24}\d)/gi
/** Shapes a written phone number takes: international (+44 ...), (415) 555-0100, 415-555-0100, 020 7946 0000. */
const PHONE =
  /(?<![\w.+-])(?:\+\d{1,3}[ .-]?(?:\(\d{1,5}\)[ .-]?)?\d{1,5}(?:[ .-]\d{2,5}){1,4}|\(\d{3}\) ?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|0\d{2,4} \d{3,4} ?\d{3,4})(?![\w-])/g
/** Numbers set aside for films and examples: US 555-01xx, UK drama numbers. */
const FICTIONAL_PHONE = /555[ .)-]*01\d\d$|^\+?4?4?\s*0?7700\s*900|^\+?4?4?\s*0?20\s*7946\s*0/

function maskEmail(e: string): string {
  const at = e.indexOf('@')
  return `${e.slice(0, 1)}***${e.slice(at)}`
}

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, '').length
  let seen = 0
  return p.replace(/\d/g, (d) => (++seen > digits - 2 ? d : '*'))
}

/** The email addresses and phone numbers in one file's text (made-up ones left out), at most one of each per line. */
export function personalDataIn(file: string, text: string): SharePersonal[] {
  const out: SharePersonal[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.length > 4000) return
    const seen = new Set<string>()
    for (const m of line.matchAll(EMAIL)) {
      const e = m[0]
      const [local = '', domain = ''] = e.split('@')
      if (PLACEHOLDER_DOMAIN.test(domain) || PLACEHOLDER_LOCAL.test(local) || FILE_TLD.test(e)) continue
      if (seen.has(e.toLowerCase())) continue
      seen.add(e.toLowerCase())
      out.push({ file, line: i + 1, kind: 'email', masked: maskEmail(e) })
    }
    const phones = [...line.matchAll(TEL)]
      .map((m) => m[1] ?? '')
      .concat([...line.matchAll(PHONE)].map((m) => m[0]))
    for (const raw of phones) {
      const p = raw.trim()
      const digits = p.replace(/\D/g, '')
      if (digits.length < 9 || digits.length > 15 || FICTIONAL_PHONE.test(p)) continue
      if (seen.has(digits)) continue
      seen.add(digits)
      out.push({ file, line: i + 1, kind: 'phone', masked: maskPhone(p) })
    }
  })
  return out
}

const MD_LINK = /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g
const HTML_LINK = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi

/** The links in a Markdown or HTML file to the project's own files (another site, a mail link or an anchor left out). */
export function fileLinksIn(file: string, text: string): string[] {
  const re = /\.(?:md|markdown)$/i.test(file) ? MD_LINK : /\.html?$/i.test(file) ? HTML_LINK : null
  if (re === null) return []
  const out = new Set<string>()
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? '').trim()
    if (raw === '' || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw))
      continue
    if (raw.includes('{') || raw.includes('$')) continue
    const path = raw.replace(/[?#].*$/, '')
    if (path !== '') out.add(path)
  }
  return [...out]
}

/** Where a link from `file` points, relative to the project ('' for its top; null: outside it or unreadable). */
export function linkTarget(file: string, link: string): string | null {
  let p: string
  try {
    p = decodeURI(link)
  } catch {
    p = link
  }
  const joined = p.startsWith('/') ? posix.normalize(p.slice(1)) : posix.join(posix.dirname(file), p)
  if (joined === '..' || joined.startsWith('../')) return null
  return joined === '.' ? '' : joined.replace(/\/$/, '')
}

const hidden = (rel: string): boolean => rel.split('/').some((s) => s.startsWith('.'))

/** Read the project's files (see the header). Never throws for a file it cannot read. */
export async function shareFiles(folder: string): Promise<ShareFilesReport> {
  const listing = await folderFiles(folder)
  const have = new Set(listing.files)
  const report: ShareFilesReport = {
    read: 0,
    truncated: listing.truncated,
    secrets: [],
    publicKeys: [],
    envFiles: listing.files.filter(isEnvFile),
    personal: [],
    brokenFileLinks: [],
  }
  const budget = { left: CHECK_TOTAL_MAX_BYTES }
  for (const rel of listing.files) {
    if (hidden(rel) || BINARY_EXT.test(rel) || SKIP_FILE.test(rel)) continue
    const text = await readSmall(join(folder, ...rel.split('/')), budget)
    if (text === undefined) continue
    report.read += 1
    for (const h of scanTextForSecrets(rel, text)) {
      if (isRestrictableKey(h)) report.publicKeys.push(secretLine(h))
      else report.secrets.push(secretLine(h))
    }
    if (report.personal.length < LIST_MAX) report.personal.push(...personalDataIn(rel, text))
    for (const link of fileLinksIn(rel, text)) {
      const to = linkTarget(rel, link)
      if (to === null || to === '' || have.has(to)) continue
      const abs = resolve(folder, ...to.split('/'))
      const inside = relative(folder, abs)
      if (inside.startsWith('..') || isAbsolute(inside) || existsSync(abs)) continue
      if (report.brokenFileLinks.length < LIST_MAX) report.brokenFileLinks.push(`${rel} links to ${link}`)
    }
  }
  report.personal = report.personal.slice(0, LIST_MAX)
  return report
}
