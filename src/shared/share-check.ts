// "Before I share it": one check of a finished website, app or document before it goes online, with no model and no
// tokens. Main opens the page in a hidden window at a phone's width with no internet and reads what a visitor's phone
// and a link preview would (the title, the preview image, whether anything is wider than the screen, the links on the
// page to the site's own pages); core reads the project's files for secrets (the security advisor's scanner) and for
// people's email addresses and phone numbers, which are only flagged and never sent anywhere. The lines say what was
// checked, in plain words, and what could not be.

/** The most links on the page that are opened to see whether they work. */
export const SHARE_LINKS_MAX = 30

/** Titles a starter template leaves, which say nothing about the page. */
export const SHARE_DEFAULT_TITLES: readonly string[] = [
  'document',
  'untitled',
  'index',
  'home',
  'react app',
  'vite app',
  'vite + react',
  'vite + react + ts',
  'my app',
  'new page',
]

/** What the hidden window saw on the page (main). */
export interface SharePageReport {
  url: string
  loaded: boolean
  error?: string
  /** The page's title ('' none). */
  title: string
  /** The preview image a link preview shows (og:image), when the page names one. */
  image?: {
    src: string
    /** It opened (null: it is on another site, so it was not opened). */
    loads: boolean | null
    /** A full web address (https://...), as sharing sites need. */
    full: boolean
  }
  /** The page has a phone setting (a viewport line). */
  viewport: boolean
  /** At a phone's width: the page is wider than the screen (sideways scrolling), and the first part that sticks out. */
  phone: { width: number; wide: boolean; part?: string }
  /** The links to the site's own pages: how many were opened, which did not work, and how many go elsewhere. */
  links: { checked: number; broken: string[]; otherSites: number; more: boolean }
  /** Files the page asked for that did not load (pictures, scripts, styles). */
  failedFiles: string[]
}

/** One email address or phone number in a file (the value partly hidden). */
export interface SharePersonal {
  file: string
  line: number
  kind: 'email' | 'phone'
  masked: string
}

/** What the project's files hold (core). */
export interface ShareFilesReport {
  /** How many files were read. */
  read: number
  /** The folder has more files than the check reads. */
  truncated: boolean
  /** Possible secrets, as masked evidence lines ("index.html:4 Stripe secret key (sk_li…, 32 chars)"). */
  secrets: string[]
  /** Keys a page may hold when restricted to the site (a Google browser key), as masked evidence lines. */
  publicKeys: string[]
  /** Real .env files among the files (their values are not read out). */
  envFiles: string[]
  personal: SharePersonal[]
  /** A document's links to its own files that do not exist ("guide.md links to setup.md"). */
  brokenFileLinks: string[]
}

export type ShareStatus = 'ok' | 'problem' | 'unknown'

/** One line of the result: what was checked, in plain words. `fix` is what goes to a change (never personal data). */
export interface ShareLine {
  id: 'title' | 'image' | 'phone' | 'links' | 'files' | 'secrets' | 'personal'
  status: ShareStatus
  text: string
  /** Details, one per line (masked values only). */
  details?: string[]
  /** What a change would be asked to fix (absent: nothing to fix, or the person decides themselves). */
  fix?: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The page lines (a website or app): title, preview image, phone width, links and files that did not load. */
export function sharePageLines(p: SharePageReport | null, why: string | null): ShareLine[] {
  if (p === null || !p.loaded) {
    const reason = p?.error ?? why ?? 'The page could not be opened.'
    return [
      {
        id: 'title',
        status: 'unknown',
        text: `The title, preview image, phone width and links were not checked: ${reason}`,
      },
    ]
  }
  const out: ShareLine[] = []
  const title = p.title.trim()
  if (title === '') {
    out.push({
      id: 'title',
      status: 'problem',
      text: 'The page has no title, so a browser tab and a shared link show its address instead.',
      fix: 'Give the page a short title that says what it is.',
    })
  } else if (SHARE_DEFAULT_TITLES.includes(title.toLowerCase())) {
    out.push({
      id: 'title',
      status: 'problem',
      text: `The title is still "${title}", the starter's own. A shared link shows it.`,
      fix: `Replace the starter title "${title}" with a short title that says what the page is.`,
    })
  } else {
    out.push({ id: 'title', status: 'ok', text: `The title is "${title}".` })
  }
  if (p.image === undefined) {
    out.push({
      id: 'image',
      status: 'problem',
      text: 'There is no preview image, so a link shared in a chat or a post shows no picture.',
      fix: 'Add a preview image for shared links (an og:image line pointing to a picture of the page).',
    })
  } else if (p.image.loads === false) {
    out.push({
      id: 'image',
      status: 'problem',
      text: `The preview image does not open: ${p.image.src}`,
      fix: `The preview image (og:image) points to ${p.image.src}, which does not open. Point it to a picture that exists.`,
    })
  } else if (!p.image.full) {
    out.push({
      id: 'image',
      status: 'unknown',
      text: `There is a preview image (${p.image.src}). Once the site is online, sharing sites need its full web address, starting with https://.`,
    })
  } else {
    out.push({
      id: 'image',
      status: p.image.loads === null ? 'unknown' : 'ok',
      text:
        p.image.loads === null
          ? `There is a preview image on another site (${p.image.src}); with no internet here it was not opened.`
          : 'There is a preview image, and it opens.',
    })
  }
  if (p.phone.wide) {
    out.push({
      id: 'phone',
      status: 'problem',
      text: `At a phone's width (${p.phone.width} pixels) the page is wider than the screen, so people have to scroll sideways.${p.phone.part !== undefined ? ` The first part that sticks out: ${p.phone.part}.` : ''}`,
      fix: `At a phone's width (${p.phone.width} pixels) the page is wider than the screen and scrolls sideways${p.phone.part !== undefined ? ` (the first part that sticks out: ${p.phone.part})` : ''}. Make it fit a phone screen.`,
    })
  } else if (!p.viewport) {
    out.push({
      id: 'phone',
      status: 'problem',
      text: 'The page has no phone setting (a viewport line), so phones show it shrunk to fit.',
      fix: 'Add the viewport line so phones show the page at their own width.',
    })
  } else {
    out.push({
      id: 'phone',
      status: 'ok',
      text: `It fits a phone's width (${p.phone.width} pixels) with no sideways scrolling.`,
    })
  }
  const l = p.links
  const elsewhere =
    l.otherSites > 0
      ? ` ${plural(l.otherSites, 'link')} to other sites ${l.otherSites === 1 ? 'was' : 'were'} not opened (no internet here).`
      : ''
  if (l.broken.length > 0) {
    out.push({
      id: 'links',
      status: 'problem',
      text: `${plural(l.broken.length, 'link')} on the page ${l.broken.length === 1 ? 'goes' : 'go'} nowhere.${elsewhere}`,
      details: l.broken,
      fix: `These links on the page go nowhere: ${l.broken.join(', ')}. Point each to a page that exists, or take it out.`,
    })
  } else if (l.checked > 0) {
    out.push({
      id: 'links',
      status: 'ok',
      text: `${plural(l.checked, 'link')} to the site's own pages ${l.checked === 1 ? 'opens' : 'all open'}.${l.more ? ` Only the first ${SHARE_LINKS_MAX} were opened.` : ''}${elsewhere}`,
    })
  } else {
    out.push({
      id: 'links',
      status: l.otherSites > 0 ? 'unknown' : 'ok',
      text: `There are no links to the site's own pages.${elsewhere}`,
    })
  }
  if (p.failedFiles.length > 0) {
    out.push({
      id: 'files',
      status: 'problem',
      text: `${plural(p.failedFiles.length, 'file')} the page asks for ${p.failedFiles.length === 1 ? 'does' : 'do'} not load.`,
      details: p.failedFiles,
      fix: `These files the page asks for do not load: ${p.failedFiles.join(', ')}. Add them or stop asking for them.`,
    })
  }
  return out
}

/** The file lines: a document's own links, secrets, and people's details (flagged only, never sent to a change). */
export function shareFileLines(
  f: ShareFilesReport | null,
  why: string | null,
  document: boolean,
): ShareLine[] {
  if (f === null) {
    return [
      {
        id: 'secrets',
        status: 'unknown',
        text: `The files were not checked for secrets or personal details: ${why ?? 'they could not be read.'}`,
      },
    ]
  }
  const out: ShareLine[] = []
  if (document) {
    out.push(
      f.brokenFileLinks.length > 0
        ? {
            id: 'links',
            status: 'problem',
            text: `${plural(f.brokenFileLinks.length, 'link')} between its files ${f.brokenFileLinks.length === 1 ? 'goes' : 'go'} nowhere.`,
            details: f.brokenFileLinks,
            fix: `These links go to files that do not exist: ${f.brokenFileLinks.join('; ')}. Point each to a file that exists, or take it out.`,
          }
        : { id: 'links', status: 'ok', text: 'Every link between its own files opens a file that is there.' },
    )
  }
  const secrets = [...f.secrets, ...f.envFiles.map((e) => `${e} (a settings file with private values)`)]
  if (secrets.length > 0) {
    out.push({
      id: 'secrets',
      status: 'problem',
      text: `${plural(secrets.length, 'possible secret')} (a password or key) ${secrets.length === 1 ? 'is' : 'are'} in the files. Anyone could read ${secrets.length === 1 ? 'it' : 'them'} once it is online.`,
      details: secrets,
      fix: `The secret scanner found possible secrets in the files that would be shared: ${secrets.join('; ')}. Take each out of the shared files, and say which real ones I should change at their service.`,
    })
  } else {
    out.push({
      id: 'secrets',
      status: 'ok',
      text: `No password or key was found in ${plural(f.read, 'file')}.${f.truncated ? ' The folder is large, so only part of it was read.' : ''}`,
    })
  }
  if (f.publicKeys.length > 0) {
    out.push({
      id: 'secrets',
      status: 'unknown',
      text: `${plural(f.publicKeys.length, 'key')} meant for web pages ${f.publicKeys.length === 1 ? 'is' : 'are'} in the files. Anyone can copy ${f.publicKeys.length === 1 ? 'it' : 'them'}: restrict ${f.publicKeys.length === 1 ? 'it' : 'each'} to your site's address at the service that gave ${f.publicKeys.length === 1 ? 'it' : 'them'}.`,
      details: f.publicKeys,
    })
  }
  if (f.personal.length > 0) {
    const emails = f.personal.filter((p) => p.kind === 'email').length
    const phones = f.personal.length - emails
    const what = [
      emails > 0 ? plural(emails, 'email address', 'email addresses') : '',
      phones > 0 ? plural(phones, 'phone number') : '',
    ]
      .filter((s) => s !== '')
      .join(' and ')
    out.push({
      id: 'personal',
      status: 'unknown',
      text: `${what} ${f.personal.length === 1 ? 'is' : 'are'} in the files. Once it is online anyone can read ${f.personal.length === 1 ? 'it' : 'them'}: keep only what you mean to be public. This was only checked here and sent nowhere.`,
      details: f.personal.map((p) => `${p.file}, line ${p.line}: ${p.masked}`),
    })
  } else {
    out.push({
      id: 'personal',
      status: 'ok',
      text: 'No email address or phone number was found in the files.',
    })
  }
  return out
}

/** The problems a change could fix (personal details are left to the person). */
export const shareFixes = (lines: readonly ShareLine[]): string[] =>
  lines.filter((l) => l.status === 'problem' && l.fix !== undefined).map((l) => l.fix as string)

// ---- in the page ---------------------------------------------------------------------------------------------------

/**
 * Runs in the page at a phone's width: the title, the preview image as named, the phone setting, whether anything is
 * wider than the screen (and the first such part, in plain words), and the page's links: its own site's pages (each
 * address once, the page itself left out) and how many go to other sites. Mail, phone and script links are left out.
 */
export const SHARE_LOOK = `(() => {
  const meta = (sel) => (document.querySelector(sel)?.getAttribute('content') || '').trim()
  const image = meta('meta[property="og:image"]') || meta('meta[name="og:image"]') || meta('meta[name="twitter:image"]')
  const root = document.documentElement
  const screenWidth = root.clientWidth
  const wide = root.scrollWidth > screenWidth + 1
  const sticks = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.right > screenWidth + 1 && getComputedStyle(el).position !== 'fixed'
  }
  const name = (el) => {
    const tag = el.tagName.toLowerCase()
    const text = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    if (tag === 'img') return 'a picture' + (text ? ' ("' + text + '")' : '')
    if (tag === 'table') return 'a table'
    if (tag === 'pre' || tag === 'code') return 'a block of code'
    if (tag === 'iframe' || tag === 'video' || tag === 'canvas') return 'a ' + tag
    return text ? 'the part that reads "' + text + '"' : 'a ' + tag + ' element'
  }
  let part = null
  if (wide && document.body) {
    for (const el of document.body.querySelectorAll('*')) {
      if (!sticks(el)) continue
      if ([...el.children].some(sticks)) continue
      part = name(el)
      break
    }
  }
  const own = []
  const seen = new Set()
  let otherSites = 0
  const here = location.pathname + location.search
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = (a.getAttribute('href') || '').trim()
    if (raw === '' || raw.startsWith('#')) continue
    let u
    try { u = new URL(raw, location.href) } catch { continue }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (u.origin !== location.origin) { otherSites++; continue }
    const key = u.pathname + u.search
    if (key === here || seen.has(key)) continue
    seen.add(key)
    own.push({ href: raw, url: u.origin + key })
  }
  return {
    title: document.title || '',
    image,
    viewport: meta('meta[name="viewport"]') !== '',
    wide,
    screenWidth,
    part,
    own,
    otherSites,
  }
})()`

/** Runs in the page: open each address (the site's own only) and say which answer with an error or not at all. */
export function shareOpenScript(urls: readonly string[]): string {
  return `(async (urls) => {
  const bad = []
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-store', redirect: 'follow' })
      if (!r.ok) bad.push(u)
    } catch { bad.push(u) }
  }
  return bad
})(${JSON.stringify(urls)})`
}
