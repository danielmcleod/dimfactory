// The name check for a game (a built-in `[should]` check, no model): the game's page title (index.html's <title>), its
// README's title (the first `# ` heading) and its file names are compared with the Games pack's `namesToAvoid`, a short
// list of famous games' names. Wording only: it never looks at pictures. Mechanics may be familiar; a game Dim Factory
// makes uses an original name, so a match is a finding to rename it. Deterministic: names are compared as words (any
// case, accents and punctuation left out, "PacMan", "pac-man" and "pac_man.js" all read "pac man"), never as parts of
// other words ("scenario" never matches "mario"). Reads only; never throws.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameCheck } from '../../shared/playtest.ts'

/** Folders whose files are not the game's own (dependencies, builds, Dim Factory's own data, the bundled libraries). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.dimfactory',
  'dist',
  'build',
  'out',
  'coverage',
  'LICENSES',
])
/** At most this many files are looked at, this many folders deep. */
const MAX_FILES = 2000
const MAX_DEPTH = 6
const MAX_READ = 256 * 1024

/** The words of a text: camelCase and digits split, accents and punctuation left out, lower case. */
export function nameWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')
}

/**
 * The famous name `text` uses, or null. A name matches when its words come one after another in the text, or when
 * consecutive words of the text join up to it ("pacman" for "Pac-Man", "super mario" for "SuperMario").
 */
export function famousNameIn(text: string, names: readonly string[]): string | null {
  const words = nameWords(text)
  if (words.length === 0) return null
  for (const name of names) {
    const want = nameWords(name)
    if (want.length === 0) continue
    const joined = want.join('')
    for (let i = 0; i < words.length; i++) {
      if (want.every((w, k) => words[i + k] === w)) return name
      let run = ''
      for (let j = i; j < words.length && run.length < joined.length; j++) {
        run += words[j]
        if (run === joined) return name
      }
    }
  }
  return null
}

/** index.html's <title> text (null: none). */
export function pageTitleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (m === null) return null
  const t = (m[1] ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return t === '' ? null : t
}

/** A README's title: its first `# ` heading (null: none). */
export function readmeTitleOf(md: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(md.replace(/^\uFEFF/, ''))
  return m === null ? null : (m[1] ?? '').trim() || null
}

async function readSmall(p: string): Promise<string | null> {
  try {
    const s = await stat(p)
    if (!s.isFile() || s.size > MAX_READ) return null
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** The project's file paths (relative, `/` separators), skipping dependencies and builds; capped. */
async function filesOf(folder: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), path, depth + 1)
      } else if (e.isFile()) out.push(path)
    }
  }
  await walk(folder, '', 0)
  return out
}

/** One place a famous name turned up. */
export interface NameHit {
  where: 'title' | 'readme' | 'file'
  /** The text it was found in (the title, or the file's path). */
  text: string
  name: string
}

/** Where the game's title, README title and file names use a famous name (empty: nowhere). */
export async function findFamousNames(folder: string, names: readonly string[]): Promise<NameHit[]> {
  const hits: NameHit[] = []
  if (names.length === 0) return hits
  const html = await readSmall(join(folder, 'index.html'))
  const title = html === null ? null : pageTitleOf(html)
  if (title !== null) {
    const n = famousNameIn(title, names)
    if (n !== null) hits.push({ where: 'title', text: title, name: n })
  }
  const readmes = (await readdir(folder).catch((): string[] => [])).filter((f) =>
    /^readme(?:\.md)?$/i.test(f),
  )
  for (const r of readmes.slice(0, 1)) {
    const md = await readSmall(join(folder, r))
    const t = md === null ? null : readmeTitleOf(md)
    if (t === null) continue
    const n = famousNameIn(t, names)
    if (n !== null) hits.push({ where: 'readme', text: t, name: n })
  }
  for (const f of await filesOf(folder)) {
    if (f.startsWith('lib/')) continue
    const n = famousNameIn(f, names)
    if (n !== null) hits.push({ where: 'file', text: f, name: n })
    if (hits.length >= 20) break
  }
  return hits
}

const WHERE: Readonly<Record<NameHit['where'], string>> = {
  title: 'the page title',
  readme: "the README's title",
  file: 'the file',
}

/** The built-in name check's verdict from what was found. */
export function namesCheck(hits: readonly NameHit[]): GameCheck {
  if (hits.length === 0) return { id: 'names', status: 'pass', title: "The game's names are its own" }
  const famous = [...new Set(hits.map((h) => h.name))]
  return {
    id: 'names',
    status: 'fail',
    title: `The game uses a famous game's name (${famous.slice(0, 3).join(', ')}): give it an original name`,
    detail: hits
      .slice(0, 5)
      .map((h) => `${WHERE[h.where]} "${h.text}"`)
      .join('; '),
  }
}

/** The name check for a game folder (see the header). */
export async function checkGameNames(folder: string, names: readonly string[]): Promise<GameCheck> {
  try {
    return namesCheck(await findFamousNames(folder, names))
  } catch {
    return { id: 'names', status: 'skipped', title: "The game's names could not be read" }
  }
}
