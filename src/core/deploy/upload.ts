// "Make an upload file": a zip of a static deliverable's files for drag-and-drop hosting (Netlify Drop, Cloudflare
// Pages' Upload assets, itch.io for a game). The zip is made on this computer, next to the project folder; nothing is
// uploaded and no site is opened. What goes in: the folder a static host would serve (the project itself for a plain
// page, else the build folder the deploy commands use), less hidden files and folders (.git, .env*, ...), node_modules,
// key and credential files, the project's memory and agent notes, Dim Factory's own files, and every symbolic link
// (never followed). A game whose page loads a module from node_modules at run time (the three.js template's import
// map) gets only those files, the relative imports they make inside their package, and the package's licence. The
// files that go in are read by the security advisor's secret scanner first: any hit refuses the zip, with the list (a
// key that is public by design, like a Google browser key, goes in with a warning to restrict it). The raw data files a
// report was made from (data/*.csv and other tables) stay out unless the user asks for them: anyone with the link
// could download them, and they may hold people's details; the result lists what was left out.
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, posix, resolve, sep } from 'node:path'
import { BRAND } from '../../shared/brand.ts'
import { UPLOAD_CLASSES } from '../../shared/deploy.ts'
import type { DeployClass, DeployUploadResult, DeployUploadView } from '../../shared/deploy.ts'
import { realPath } from '../real-path.ts'
import { scanTextForSecrets } from '../security/secrets.ts'
import type { SecretHit } from '../security/secrets.ts'
import { RESTRICT_KEY_ADVICE, isRestrictableKey, secretLine } from './checklist.ts'
import { buildCommandOf } from './build.ts'
import { buildDir } from './commands.ts'
import type { DeploySignals } from './signals.ts'
import { ZipWriter, readZipComment } from './zip.ts'

/** The most files one upload file holds. */
export const UPLOAD_MAX_FILES = 5000
/** The most bytes (before compression) one upload file holds. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024
/** Files larger than this are not read by the secret scanner (generated or binary). */
export const UPLOAD_SCAN_MAX_BYTES = 2 * 1024 * 1024
/** The most node_modules files a game's page may pull in. */
const RUNTIME_MAX_FILES = 64
/** Raw data files (tables) in the served folder's data/: left out of an upload file unless the user includes them. */
const RAW_DATA =
  /^data\/(?:.+\/)?[^/]+\.(?:csv|tsv|xlsx|xlsm|xls|ods|numbers|parquet|sqlite|db|jsonl|ndjson)$/i

/** A raw data file the upload leaves out by default (a path relative to the served folder, `/` separators). */
export function isRawData(rel: string): boolean {
  return RAW_DATA.test(rel)
}

/** The zip comment that marks an upload file (an existing file with it is replaced, any other file is kept). */
export const UPLOAD_ZIP_COMMENT = `${BRAND.displayName} upload file`

/**
 * What to do about a secret in an upload file. Everything in it is served to anyone, so the key comes out (an
 * environment variable would only put it back into the built page); a paid or private API goes through a server
 * function.
 */
export const UPLOAD_SECRET_ADVICE =
  "A website's files are public: anyone can read a key in them. Take each one out (and rotate any real one). To use a paid or private API, call it through a small server function (Netlify or Cloudflare functions) that keeps the key in the host's settings."

/** Why a path is left out (null: it goes in). */
export type UploadSkip = 'hidden' | 'node_modules' | 'notes' | 'internal' | 'key'

/** Memory and agent notes (any folder): what the project told its agents is not part of the site. */
const NOTES = new Set(
  [BRAND.memoryFileName, 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', 'MEMORY.md'].map((n) =>
    n.toLowerCase(),
  ),
)
/** Dim Factory's own files at the served folder's root (the game play-test data, a stray config file). */
const INTERNAL = new Set(['playtest.json', BRAND.configFileName.toLowerCase()])
/** Keys, certificates' private halves, keystores and files named for credentials. */
const KEY_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|htpasswd|npmrc|netrc|pypirc|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|gpg|env)|.*service[-_]?account.*\.json|.*firebase-adminsdk.*\.json|.*secrets?\.(?:json|ya?ml|toml|ini|txt|env)|.*passwords?\.(?:json|ya?ml|toml|ini|txt|csv))$/i
const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|exe|dll|so|dylib|bin|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|webm|ogg|oga|wav|flac|psd|glb|ktx2?)$/i

/** Whether a path (relative to the served folder, `/` separators) is left out of the zip, and why. */
export function uploadSkipReason(rel: string): UploadSkip | null {
  const segs = rel.split('/')
  if (segs.some((s) => s.startsWith('.'))) return 'hidden'
  if (segs.some((s) => s.toLowerCase() === 'node_modules')) return 'node_modules'
  const base = (segs[segs.length - 1] ?? '').toLowerCase()
  if (NOTES.has(base)) return 'notes'
  if (segs.length === 1 && INTERNAL.has(base)) return 'internal'
  if (KEY_FILE.test(base)) return 'key'
  return null
}

function fold(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p
}

/** `child` is `dir` or inside it. */
function inside(child: string, dir: string): boolean {
  const c = fold(resolve(child))
  const d = fold(resolve(dir))
  return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

const where = (dir: string): string => (dir === '.' ? 'the project folder' : `${dir}/`)

/**
 * What "Make an upload file" would zip for a class (undefined: not a static class). `ready` once the folder is there
 * with an index.html in it. A folder its build writes (dist/) names the build command "Get it ready to share" runs.
 */
export async function uploadView(
  folder: string,
  signals: DeploySignals,
  cls: DeployClass,
  o: { game: boolean },
): Promise<DeployUploadView | undefined> {
  if (!UPLOAD_CLASSES.includes(cls)) return undefined
  const dir = buildDir(signals, cls)
  const root = resolve(folder, dir)
  const cmd = dir !== '.' ? await buildCommandOf(folder) : null
  const base = { dir, game: o.game, ...(cmd !== null ? { build: { command: cmd.display } } : {}) }
  if (!inside(root, folder))
    return { ...base, ready: false, problem: 'The build folder is outside the project.' }
  if (!(await isDirectory(root)))
    return {
      ...base,
      ready: false,
      problem:
        cmd !== null
          ? `There is no ${dir}/ folder yet. Get it ready to share first: its build (${cmd.display}) writes the site there.`
          : `There is no ${dir}/ folder yet. Build the project first: its build writes the site there.`,
    }
  if (!(await isFile(join(root, 'index.html'))))
    return {
      ...base,
      ready: false,
      problem: `There is no index.html in ${where(dir)}, so there is no page to open.`,
    }
  return { ...base, ready: true }
}

interface FileEntry {
  rel: string
  abs: string
  size: number
  mtime: Date
}

interface Collected {
  files: FileEntry[]
  skipped: number
  tooMany: boolean
}

/** Every file under `root` that goes in, breadth first; symbolic links (and junctions) are never followed. */
async function collect(root: string, rootReal: string, maxFiles: number): Promise<Collected> {
  const files: FileEntry[] = []
  let skipped = 0
  let level = ['']
  while (level.length > 0) {
    const next: string[] = []
    for (const rel of level) {
      const dirAbs = rel === '' ? root : join(root, ...rel.split('/'))
      // A folder that resolves elsewhere (a link the listing did not show as one) is not read.
      if (rel !== '') {
        const real = await realpath(dirAbs).catch(() => null)
        if (real === null || !inside(real, rootReal)) {
          skipped += 1
          continue
        }
      }
      let entries: Dirent[]
      try {
        entries = await readdir(dirAbs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isSymbolicLink() || uploadSkipReason(r) !== null) {
          skipped += 1
          continue
        }
        if (e.isDirectory()) {
          next.push(r)
          continue
        }
        if (!e.isFile()) {
          skipped += 1
          continue
        }
        const abs = join(dirAbs, e.name)
        const st = await lstat(abs).catch(() => null)
        if (st === null || !st.isFile()) {
          skipped += 1
          continue
        }
        if (files.length >= maxFiles) return { files, skipped, tooMany: true }
        files.push({ rel: r, abs, size: st.size, mtime: st.mtime })
      }
    }
    level = next.sort()
  }
  return { files, skipped, tooMany: false }
}

/** `node_modules/<pkg>` (scoped or not) of a path under node_modules, or null. */
function packageDir(rel: string): string | null {
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(rel)
  return m?.[1] !== undefined ? `node_modules/${m[1]}` : null
}

/** A clean relative path (no `..`, no hidden or empty segment), or null. */
function cleanRel(raw: string): string | null {
  const p = posix.normalize(raw.replace(/^\.\//, ''))
  if (p.startsWith('/') || p.startsWith('../') || p === '..') return null
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null
  return p
}

const MODULE_REF = /node_modules\/[^"'`\s()<>?#]+/g
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g
const LICENCE = /^(?:licen[cs]e|copying|notice)(?:[.-][a-z0-9]+)*$/i

/**
 * A game's run-time modules: the node_modules files its index.html loads (an import map, a script or a link), the
 * relative imports those make inside their own package, and each package's licence. `missing`: files the page loads
 * that are not there (not installed).
 */
export async function runtimeModules(
  root: string,
  rootReal: string,
): Promise<{ files: FileEntry[]; missing: string[] }> {
  let html = ''
  try {
    const h = join(root, 'index.html')
    if ((await stat(h)).size <= UPLOAD_SCAN_MAX_BYTES) html = await readFile(h, 'utf8')
  } catch {
    return { files: [], missing: [] }
  }
  const queue: string[] = []
  for (const m of html.matchAll(MODULE_REF)) {
    const rel = cleanRel(m[0])
    if (rel !== null && packageDir(rel) !== null) queue.push(rel)
  }
  const seen = new Set<string>()
  const files: FileEntry[] = []
  const missing: string[] = []
  const packages = new Set<string>()
  const add = async (rel: string): Promise<FileEntry | null> => {
    const abs = join(root, ...rel.split('/'))
    const st = await lstat(abs).catch(() => null)
    if (st === null || !st.isFile()) return null
    // Its folder may be a link (pnpm links packages from its own store), as long as it stays in the project.
    const real = await realpath(abs).catch(() => null)
    if (real === null || !inside(real, rootReal)) return null
    const f = { rel, abs, size: st.size, mtime: st.mtime }
    files.push(f)
    return f
  }
  while (queue.length > 0 && files.length < RUNTIME_MAX_FILES) {
    const rel = queue.shift() ?? ''
    if (seen.has(rel)) continue
    seen.add(rel)
    const pkg = packageDir(rel)
    if (pkg === null) continue
    const f = await add(rel)
    if (f === null) {
      missing.push(rel)
      continue
    }
    packages.add(pkg)
    if (!/\.m?js$/i.test(rel) || f.size > 16 * UPLOAD_SCAN_MAX_BYTES) continue
    const text = await readFile(f.abs, 'utf8').catch(() => '')
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const next = cleanRel(posix.join(posix.dirname(rel), m[1] ?? ''))
      if (next !== null && next.startsWith(`${pkg}/`) && !seen.has(next)) queue.push(next)
    }
  }
  for (const pkg of [...packages].sort()) {
    const names = await readdir(join(root, ...pkg.split('/'))).catch(() => [] as string[])
    for (const n of names.sort()) {
      const rel = `${pkg}/${n}`
      if (LICENCE.test(n) && !seen.has(rel)) {
        seen.add(rel)
        await add(rel)
      }
    }
  }
  return { files, missing }
}

/** A plain file name stem from the project folder's name. */
function stemOf(baseName: string): string {
  const s = baseName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return s === '' ? 'site' : s
}

/**
 * Where the zip goes: `<outDir>/<name>-site.zip`, replacing an earlier upload file of that name (its comment says so),
 * else the first free `<name>-site-2.zip`, `-3`, ... (a file of the user's is never replaced).
 */
export async function uploadFilePath(outDir: string, baseName: string): Promise<string> {
  const stem = `${stemOf(baseName)}-site`
  for (let i = 1; i <= 50; i++) {
    const p = join(outDir, i === 1 ? `${stem}.zip` : `${stem}-${i}.zip`)
    const st = await lstat(p).catch(() => null)
    if (st === null) return p
    if (st.isFile() && (await readZipComment(p)) === UPLOAD_ZIP_COMMENT) return p
  }
  throw new Error(`Too many files named ${stem}*.zip next to the project.`)
}

const refused = (reason: string, evidence: string[] = []): DeployUploadResult => ({
  status: 'refused',
  reason,
  evidence,
})

export interface MakeUploadOptions {
  /** The folder the files come from (a run's isolated copy while its changes wait). */
  folder: string
  /** The served folder, relative to `folder` ('.' for the folder itself). */
  dir: string
  /** Where the zip goes (the project folder's parent). */
  outDir: string
  /** The project folder's name (the zip's name). */
  baseName: string
  /** A game: the page's run-time modules from node_modules go in. */
  game: boolean
  /** The raw data files in data/ go in too (default: they stay out, and the result lists them). */
  includeData?: boolean
  maxFiles?: number
  maxBytes?: number
}

/** Make the upload file, or refuse (secrets, nothing to zip, too large). */
export async function makeUploadFile(o: MakeUploadOptions): Promise<DeployUploadResult> {
  const maxFiles = o.maxFiles ?? UPLOAD_MAX_FILES
  const maxBytes = o.maxBytes ?? UPLOAD_MAX_BYTES
  const folderReal = await realpath(o.folder).catch(() => null)
  const root = resolve(o.folder, o.dir)
  const rootReal = await realpath(root).catch(() => null)
  if (folderReal === null || rootReal === null)
    return refused(`There is no ${where(o.dir)} to zip. Build the project first.`)
  if (!inside(rootReal, folderReal))
    return refused(`${where(o.dir)} is a link to a folder outside the project.`)
  // Both by their real names (the zip's folder may not exist yet: its nearest existing parent's real name then).
  if (inside(await realPath(o.outDir), rootReal))
    return refused('The upload file cannot be put next to this folder.')
  if (!(await isFile(join(root, 'index.html'))))
    return refused(`There is no index.html in ${where(o.dir)}, so there is no page to open.`)

  const got = await collect(root, rootReal, maxFiles)
  if (got.tooMany)
    return refused(
      `${where(o.dir)} has more than ${maxFiles} files to zip. Hosts that take a dropped file expect a site's built files only.`,
    )
  // Raw data files stay out unless asked for: the page keeps what it shows, and the files may hold people's details.
  const leftOut = o.includeData === true ? [] : got.files.filter((f) => isRawData(f.rel)).map((f) => f.rel)
  const files = got.files.filter((f) => o.includeData === true || !isRawData(f.rel))
  if (o.game) {
    const rt = await runtimeModules(root, rootReal)
    if (rt.missing.length > 0)
      return refused(
        'The page loads files from node_modules that are not installed. Install the project (npm install), then make the upload file again.',
        rt.missing,
      )
    files.push(...rt.files)
  }
  if (files.length > maxFiles) return refused(`${where(o.dir)} has more than ${maxFiles} files to zip.`)
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (bytes > maxBytes)
    return refused(
      `The files come to ${Math.ceil(bytes / (1024 * 1024))} MB, more than the ${Math.floor(maxBytes / (1024 * 1024))} MB an upload file holds.`,
    )
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  // The secret scanner reads every text file that goes in; any hit refuses the zip, except a key that is public by
  // design (a Google browser key), which goes in with a warning to restrict it.
  const hits: SecretHit[] = []
  for (const f of files) {
    if (BINARY_EXT.test(f.rel) || f.size > UPLOAD_SCAN_MAX_BYTES) continue
    const text = await readFile(f.abs, 'utf8').catch(() => null)
    if (text !== null) hits.push(...scanTextForSecrets(f.rel, text))
  }
  const restrictable = hits.filter(isRestrictableKey)
  const secrets = hits.filter((h) => !isRestrictableKey(h))
  if (secrets.length > 0)
    return refused(
      `The secret scanner found ${secrets.length === 1 ? 'a possible secret' : `${secrets.length} possible secrets`} in the files that would go in, so no upload file was made. ${UPLOAD_SECRET_ADVICE} Then make it again.`,
      secrets.slice(0, 20).map(secretLine),
    )

  const path = await uploadFilePath(o.outDir, o.baseName)
  const zip = await ZipWriter.create(path)
  try {
    for (const f of files) {
      const data = await readFile(f.abs)
      await zip.add({ name: f.rel, data, mtime: f.mtime })
    }
    await zip.finish(UPLOAD_ZIP_COMMENT)
  } catch (err) {
    await zip.abort()
    throw err
  }
  return {
    status: 'made',
    path,
    name: basename(path),
    dir: o.dir,
    files: files.length,
    bytes,
    skipped: got.skipped,
    ...(leftOut.length > 0 ? { dataLeftOut: leftOut.sort() } : {}),
    ...(o.includeData === true && got.files.some((f) => isRawData(f.rel)) ? { dataIncluded: true } : {}),
    ...(restrictable.length > 0
      ? {
          warning: `${restrictable.length === 1 ? 'A key in it' : `${restrictable.length} keys in it`} can be read by anyone who opens the site. ${RESTRICT_KEY_ADVICE}`,
          warnings: restrictable.slice(0, 20).map(secretLine),
        }
      : {}),
  }
}
