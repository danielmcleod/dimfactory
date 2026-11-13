// Easy mode's "Add files": what the user picked on Easy's home, checked (easy.attachCheck) and then copied into the new
// project when it is made (easy.create): tables and data into data/, everything else into assets/. An Excel workbook
// (.xlsx) also gets its first sheet copied as a CSV file beside it (read offline, xlsx.ts), since that is what the
// report reads; an older or other spreadsheet kind (.xls, .ods, .numbers) is noted as unreadable (save it as CSV), and a
// data file too large for the AI to read in full is noted too.
//
// Refused: a path that is not absolute or not there; a link (it could point anywhere); a file over
// EASY_ATTACH_MAX_BYTES, or more than EASY_ATTACH_MAX_FILES, or all of them over EASY_ATTACH_TOTAL_MAX_BYTES; anything
// inside Dim Factory's own data folder, a .git folder or a system folder (preflight/guard.ts); anything inside a hidden
// folder (`.ssh`, `.aws`, `.claude`, `.codex`, `.config`...) or itself hidden (`.env`, `.npmrc`); and files that look
// like keys or credentials. A folder is copied only when it is clearly safe: plain files only (no links, nothing
// hidden, nothing refused above), at most EASY_ATTACH_FOLDER_MAX_FILES of them, EASY_ATTACH_FOLDER_MAX_DEPTH levels
// deep, within the size caps. Nothing is ever moved or changed where it came from; a name taken in the project gets
// " (2)" and so on.
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EasyAttachDest, EasyAttachNote, EasyAttachment } from '../../shared/easy.ts'
import {
  EASY_ATTACH_FOLDER_MAX_DEPTH,
  EASY_ATTACH_FOLDER_MAX_FILES,
  EASY_ATTACH_MAX_BYTES,
  EASY_ATTACH_MAX_FILES,
  EASY_ATTACH_READ_MAX_BYTES,
  EASY_ATTACH_TOTAL_MAX_BYTES,
} from '../../shared/easy.ts'
import { checkGuard } from '../preflight/guard.ts'
import type { GuardContext } from '../preflight/guard.ts'
import { xlsxToCsv } from './xlsx.ts'

/** Extensions that go to data/ (tables and data files); everything else goes to assets/. */
const DATA_EXTS: ReadonlySet<string> = new Set([
  '.csv',
  '.tsv',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.ods',
  '.json',
  '.jsonl',
  '.ndjson',
  '.xml',
  '.parquet',
  '.txt',
  '.sqlite',
  '.db',
])

/** Workbooks whose first sheet is also copied as a CSV file (read offline, xlsx.ts). */
const CONVERTED_EXTS: ReadonlySet<string> = new Set(['.xlsx', '.xlsm'])
/** Spreadsheet kinds that cannot be read here: the user is told to save them as CSV. */
const UNREADABLE_EXTS: ReadonlySet<string> = new Set(['.xls', '.ods', '.numbers'])

/** File names that look like keys, certificates, password stores or credentials. */
const SECRET_NAME =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|keychain|ppk|gpg|asc)|credentials(?:\.\w+)?|known_hosts|authorized_keys)$/i

const MB = 1024 * 1024
const sizeText = (bytes: number): string => `${Math.round((bytes / MB) * 10) / 10} MB`

export const ATTACH_TEXT = {
  notAbsolute: 'Choose the file again: its location is not complete.',
  missing: 'This file is not there any more.',
  link: 'This is a shortcut or link to somewhere else, so it is not added. Add the file itself.',
  notFile: 'Only files and small folders can be added.',
  hidden:
    'This is a hidden file or is in a hidden folder, which can hold passwords and keys, so it is not added.',
  secret: 'This looks like a key or a password file, so it is not added.',
  guarded: 'This is in a system folder or in the app data folder, so it is not added.',
  tooBig: (bytes: number) =>
    `This file is ${sizeText(bytes)}; files up to ${sizeText(EASY_ATTACH_MAX_BYTES)} can be added.`,
  tooMany: `Up to ${EASY_ATTACH_MAX_FILES} files can be added to a new project.`,
  tooMuch: `All the files together can be up to ${sizeText(EASY_ATTACH_TOTAL_MAX_BYTES)}.`,
  folder: `Only small folders of plain files can be added (up to ${EASY_ATTACH_FOLDER_MAX_FILES} files, nothing hidden, no links).`,
  duplicate: 'This file is added already.',
} as const

export type AttachContext = GuardContext

/**
 * What to know about a file that is added: a workbook whose first sheet becomes a CSV (or cannot be read), a
 * spreadsheet kind that cannot be read here, or a data file too large for the AI to read in full.
 */
export async function noteOf(file: string, bytes: number): Promise<EasyAttachNote | undefined> {
  const ext = path.extname(file).toLowerCase()
  if (CONVERTED_EXTS.has(ext)) {
    try {
      xlsxToCsv(await readFile(file))
      return bytes > EASY_ATTACH_READ_MAX_BYTES ? 'large' : 'converted'
    } catch {
      return 'unreadable'
    }
  }
  if (UNREADABLE_EXTS.has(ext)) return 'unreadable'
  if (destOf(file) === 'data' && bytes > EASY_ATTACH_READ_MAX_BYTES) return 'large'
  return undefined
}

/** Where a file goes in the new project. */
export function destOf(name: string): EasyAttachDest {
  return DATA_EXTS.has(path.extname(name).toLowerCase()) ? 'data' : 'assets'
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Why a path (file or folder, absolute) is refused by where it is and what it is called; undefined when it is not. */
export function refusedBy(p: string, ctx: AttachContext): string | undefined {
  const P = pathFor(ctx.platform)
  const parts = P.resolve(p)
    .split(/[\\/]/)
    .filter((s) => s !== '')
  if (parts.some((s) => s.startsWith('.'))) return ATTACH_TEXT.hidden
  if (SECRET_NAME.test(parts[parts.length - 1] ?? '')) return ATTACH_TEXT.secret
  const g = checkGuard(p, ctx)
  if (g.guarded && (g.reason === 'dimFactoryHome' || g.reason === 'gitDir' || g.reason === 'system'))
    return ATTACH_TEXT.guarded
  // A file at a drive root, or in the home folder itself, is fine; the folders themselves are not.
  return undefined
}

/** A folder's plain files (relative paths, sizes), or why it is not clearly safe to copy. */
async function walkFolder(
  root: string,
  ctx: AttachContext,
): Promise<{ files: { rel: string; bytes: number }[] } | { error: string }> {
  const files: { rel: string; bytes: number }[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<string | undefined> => {
    if (depth > EASY_ATTACH_FOLDER_MAX_DEPTH) return ATTACH_TEXT.folder
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.name.startsWith('.') || SECRET_NAME.test(e.name)) return ATTACH_TEXT.folder
      if (e.isSymbolicLink()) return ATTACH_TEXT.folder
      if (e.isDirectory()) {
        const why = await walk(abs, r, depth + 1)
        if (why !== undefined) return why
        continue
      }
      if (!e.isFile()) return ATTACH_TEXT.folder
      const st = await lstat(abs)
      if (st.size > EASY_ATTACH_MAX_BYTES) return ATTACH_TEXT.tooBig(st.size)
      files.push({ rel: r, bytes: st.size })
      if (files.length > EASY_ATTACH_FOLDER_MAX_FILES) return ATTACH_TEXT.folder
    }
    return undefined
  }
  try {
    const why = await walk(root, '', 1)
    if (why !== undefined) return { error: why }
  } catch {
    return { error: ATTACH_TEXT.folder }
  }
  if (refusedBy(root, ctx) !== undefined) return { error: ATTACH_TEXT.folder }
  return { files }
}

/** Each path as it would be copied, or why not (see the header). Never throws for a path's problem. */
export async function checkAttachments(
  paths: readonly string[],
  ctx: AttachContext,
): Promise<EasyAttachment[]> {
  const P = pathFor(ctx.platform)
  const out: EasyAttachment[] = []
  const seen = new Set<string>()
  let total = 0
  let count = 0
  for (const raw of paths) {
    const name = P.basename(raw) || raw
    const base: EasyAttachment = { path: raw, name, bytes: 0, folder: false, dest: destOf(name) }
    const refuse = (error: string, extra: Partial<EasyAttachment> = {}): void => {
      out.push({ ...base, ...extra, error })
    }
    if (!P.isAbsolute(raw)) {
      refuse(ATTACH_TEXT.notAbsolute)
      continue
    }
    const key =
      ctx.platform === 'win32' || ctx.platform === 'darwin' ? P.resolve(raw).toLowerCase() : P.resolve(raw)
    if (seen.has(key)) {
      refuse(ATTACH_TEXT.duplicate)
      continue
    }
    seen.add(key)
    const st = await lstat(raw).catch(() => null)
    if (st === null) {
      refuse(ATTACH_TEXT.missing)
      continue
    }
    if (st.isSymbolicLink()) {
      refuse(ATTACH_TEXT.link)
      continue
    }
    // Where it really is counts too (a folder on the way may be a junction into a guarded place).
    const real = await realpath(raw).catch(() => raw)
    const where = refusedBy(raw, ctx) ?? refusedBy(real, ctx)
    if (where !== undefined) {
      refuse(where)
      continue
    }
    if (st.isDirectory()) {
      const w = await walkFolder(raw, ctx)
      if ('error' in w) {
        refuse(w.error, { folder: true, dest: 'assets' })
        continue
      }
      const bytes = w.files.reduce((n, f) => n + f.bytes, 0)
      const dest: EasyAttachDest =
        w.files.length > 0 && w.files.every((f) => destOf(f.rel) === 'data') ? 'data' : 'assets'
      if (count + w.files.length > EASY_ATTACH_FOLDER_MAX_FILES + EASY_ATTACH_MAX_FILES) {
        refuse(ATTACH_TEXT.tooMany, { folder: true, bytes, dest })
        continue
      }
      if (total + bytes > EASY_ATTACH_TOTAL_MAX_BYTES) {
        refuse(ATTACH_TEXT.tooMuch, { folder: true, bytes, dest })
        continue
      }
      total += bytes
      count += 1
      out.push({ ...base, bytes, folder: true, dest })
      continue
    }
    if (!st.isFile()) {
      refuse(ATTACH_TEXT.notFile)
      continue
    }
    if (st.size > EASY_ATTACH_MAX_BYTES) {
      refuse(ATTACH_TEXT.tooBig(st.size), { bytes: st.size })
      continue
    }
    if (count >= EASY_ATTACH_MAX_FILES) {
      refuse(ATTACH_TEXT.tooMany, { bytes: st.size })
      continue
    }
    if (total + st.size > EASY_ATTACH_TOTAL_MAX_BYTES) {
      refuse(ATTACH_TEXT.tooMuch, { bytes: st.size })
      continue
    }
    total += st.size
    count += 1
    const note = await noteOf(raw, st.size)
    out.push({ ...base, bytes: st.size, ...(note !== undefined ? { note } : {}) })
  }
  return out
}

/** A workbook's first sheet as CSV text (null: it cannot be read; the file itself is still copied). */
async function sheetCsv(file: string): Promise<string | null> {
  try {
    const r = xlsxToCsv(await readFile(file))
    return r.rows > 0 ? r.csv : null
  } catch {
    return null
  }
}

/** A free name in `dir`: `name`, then `name (2).ext` and so on. */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if ((await lstat(path.join(dir, candidate)).catch(() => null)) === null) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/**
 * Copy the checked attachments into the new project (each checked again first, so nothing that changed since is
 * copied). Answers the project-relative paths written (`data/sales.csv`, `assets/logo.png`); throws on a refusal.
 */
export async function copyAttachments(
  paths: readonly string[],
  project: string,
  ctx: AttachContext,
): Promise<string[]> {
  const checked = await checkAttachments(paths, ctx)
  const bad = checked.find((a) => a.error !== undefined)
  if (bad !== undefined) throw new Error(`${bad.name}: ${bad.error ?? ''}`)
  const written: string[] = []
  for (const a of checked) {
    const dir = path.join(project, a.dest)
    await mkdir(dir, { recursive: true })
    const name = await freeName(dir, a.name)
    if (!a.folder) {
      // COPYFILE_EXCL: never overwrite (the name was free a moment ago).
      await copyFile(a.path, path.join(dir, name), constants.COPYFILE_EXCL)
      written.push(`${a.dest}/${name}`)
      // A workbook's first sheet also goes in as a CSV file beside it, which the report reads.
      if (CONVERTED_EXTS.has(path.extname(name).toLowerCase())) {
        const csv = await sheetCsv(a.path)
        if (csv !== null) {
          const csvName = await freeName(dir, `${name.slice(0, -path.extname(name).length)}.csv`)
          await writeFile(path.join(dir, csvName), csv, { flag: 'wx' })
          written.push(`${a.dest}/${csvName}`)
        }
      }
      continue
    }
    const w = await walkFolder(a.path, ctx)
    if ('error' in w) throw new Error(`${a.name}: ${w.error}`)
    for (const f of w.files) {
      const to = path.join(dir, name, ...f.rel.split('/'))
      await mkdir(path.dirname(to), { recursive: true })
      await copyFile(path.join(a.path, ...f.rel.split('/')), to, constants.COPYFILE_EXCL)
    }
    written.push(`${a.dest}/${name}/`)
  }
  return written
}
