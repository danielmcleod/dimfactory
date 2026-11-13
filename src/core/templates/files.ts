// The files a built-in template copies into a new project before its run starts (the game templates' starter engine).
// Every source is an entry of the bundled manifest (vendor/manifest.json beside the templates): Dim Factory's own
// starter files, or a third-party library with its licence. Nothing is downloaded. Before anything is written:
// - only a built-in template copies anything (a user template with `files` is refused when templates load, and the
//   built-in of the chosen id must be the one in use);
// - each `from` must be a manifest id, each `to` a plain relative path under lib/, src/ or docs/ that stays inside the
//   project (no `..`, no absolute path, no drive, nothing hidden);
// - each source's sha256 must match the manifest, so a changed or damaged bundle copies nothing.
// Files are written only where nothing exists yet (never overwritten). lib/VENDORED.md lists what was copied, where
// from, its licence and its hash; a third-party entry's licence goes to lib/LICENSES/<id>.txt.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { TemplateView } from '../../shared/templates.ts'
import { TEMPLATE_FILE_ID_PATTERN, templateTargetProblem } from '../../shared/templates.ts'
import { BRAND } from '../../shared/brand.ts'
import { builtinTemplatesDir, readBuiltinTemplates } from './load.ts'

/** Where the manifest's paths start: `vendor/` beside the built-in templates. */
export const VENDOR_DIR = 'vendor'
export const VENDOR_MANIFEST = 'manifest.json'
/** What lib/VENDORED.md is called in the project, and the folder third-party licences go to. */
export const VENDORED_FILE = 'lib/VENDORED.md'
export const LICENSES_DIR = 'lib/LICENSES'

const Sha256Z = z.string().regex(/^[0-9a-f]{64}$/, 'A sha256 in lower-case hex')
/** A path inside vendor/: forward slashes, plain segments, no `..`. */
const VendorPathZ = z
  .string()
  .max(200)
  .regex(
    /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/,
    'A plain relative path in vendor/',
  )
  .refine((p) => !p.split('/').includes('..'), 'No ".." in a vendor path')

const VendorEntryZ = z.discriminatedUnion('origin', [
  z.strictObject({
    id: z.string().regex(TEMPLATE_FILE_ID_PATTERN),
    origin: z.literal('starter'),
    name: z.string().trim().min(1).max(80),
    path: VendorPathZ,
    sha256: Sha256Z,
    license: z.literal('MIT'),
  }),
  z.strictObject({
    id: z.string().regex(TEMPLATE_FILE_ID_PATTERN),
    origin: z.literal('third-party'),
    name: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).max(40),
    homepage: z.string().regex(/^https:\/\/[^\s]+$/),
    path: VendorPathZ,
    sha256: Sha256Z,
    license: z.string().trim().min(1).max(40),
    licenseFile: VendorPathZ,
    licenseSha256: Sha256Z,
  }),
])
export type VendorEntry = z.infer<typeof VendorEntryZ>

export const VendorManifestZ = z
  .strictObject({
    $schema: z.string().max(2048).optional(),
    version: z.literal(1),
    entries: z.array(VendorEntryZ).max(200),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>()
    m.entries.forEach((e, i) => {
      if (seen.has(e.id))
        ctx.addIssue({ code: 'custom', path: ['entries', i, 'id'], message: `Duplicate id "${e.id}"` })
      seen.add(e.id)
    })
  })
export type VendorManifest = z.infer<typeof VendorManifestZ>

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The bundled manifest (a broken one is a packaging bug: it throws). */
export async function readVendorManifest(templatesDir = builtinTemplatesDir()): Promise<VendorManifest> {
  const file = path.join(templatesDir, VENDOR_DIR, VENDOR_MANIFEST)
  const text = await readFile(file, 'utf8')
  const r = VendorManifestZ.safeParse(JSON.parse(text))
  if (!r.success)
    throw new Error(`The bundled file list ${file} is broken: ${r.error.issues[0]?.message ?? ''}`)
  return r.data
}

/** A bundled file's bytes, refused unless its sha256 is the manifest's. */
async function readChecked(templatesDir: string, rel: string, want: string, id: string): Promise<Buffer> {
  const bytes = await readFile(path.join(templatesDir, VENDOR_DIR, ...rel.split('/')))
  const got = sha256(bytes)
  if (got !== want) {
    throw new Error(
      `The bundled file "${id}" is not the one ${BRAND.displayName} shipped (its sha256 is ${got.slice(0, 12)}..., not ${want.slice(0, 12)}...). Reinstall ${BRAND.displayName}.`,
    )
  }
  return bytes
}

/** One file to write: where (project-relative) and what. */
interface Planned {
  to: string
  bytes: Buffer
  entry?: VendorEntry
}

/** `to` as an absolute path inside the project, or a refusal (`web`: the template is a web starter). */
function targetIn(project: string, to: string, web = false): string {
  const problem = templateTargetProblem(to, { web })
  if (problem !== null) throw new Error(`${to}: ${problem}`)
  const abs = path.resolve(project, ...to.split('/'))
  const rel = path.relative(path.resolve(project), abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`${to} is outside the project.`)
  return abs
}

/** Which of Dim Factory's starters a starter file is part of: the web starter (starter/react/), else the game's. */
function starterKind(e: VendorEntry): 'game' | 'web' {
  return e.path.startsWith('starter/react/') ? 'web' : 'game'
}

/** lib/VENDORED.md: what was copied, where from, its licence and its hash. */
export function vendoredText(planned: readonly { to: string; entry: VendorEntry }[]): string {
  const lines = [
    '# Bundled files',
    '',
    `${BRAND.displayName} copied these files into the project when it was made. Nothing was downloaded. Each one was checked against its sha256 first.`,
    '',
    '| File | What it is | Licence | sha256 |',
    '| --- | --- | --- | --- |',
  ]
  for (const p of planned) {
    const e = p.entry
    const what =
      e.origin === 'starter'
        ? `${e.name} (${BRAND.displayName} ${starterKind(e)} starter)`
        : `${e.name} ${e.version} (${e.homepage})`
    const licence = e.origin === 'starter' ? e.license : `${e.license}, see ${LICENSES_DIR}/${e.id}.txt`
    lines.push(`| ${p.to} | ${what} | ${licence} | ${e.sha256} |`)
  }
  const kinds = new Set(planned.filter((p) => p.entry.origin === 'starter').map((p) => starterKind(p.entry)))
  // A template that bundles only third-party files still names the game starter's licence, as it always has.
  if (kinds.size === 0) kinds.add('game')
  lines.push('')
  if (kinds.has('game'))
    lines.push(
      `The ${BRAND.displayName} game starter is under the MIT License: you may use, copy, change and share it, in free or paid games, as long as this notice stays with it. It comes with no warranty.`,
    )
  if (kinds.has('web'))
    lines.push(
      `The ${BRAND.displayName} web starter is under the MIT License: you may use, copy, change and share it, in free or paid projects, as long as this notice stays with it. It comes with no warranty.`,
    )
  lines.push('')
  return lines.join('\n')
}

export interface CopyTemplateFilesOptions {
  /** Test seam: the built-in templates' directory (vendor/ is inside it). */
  builtinDir?: string
}

/**
 * Copy the chosen template's files into `project` (a folder New project or Easy just made). Answers the
 * project-relative paths written (none for a template without files, or one that is not the built-in). Throws, with
 * nothing written, for an unknown id, a refused target or a hash that does not match.
 */
export async function copyTemplateFiles(
  view: TemplateView,
  project: string,
  o: CopyTemplateFilesOptions = {},
): Promise<string[]> {
  if (view.layer !== 'builtin') return []
  const builtin = readBuiltinTemplates(o.builtinDir).find((t) => t.id === view.template.id)
  const files = builtin?.files ?? []
  if (files.length === 0) return []
  const web = builtin?.webStarter === true
  const dir = o.builtinDir ?? builtinTemplatesDir()
  const manifest = await readVendorManifest(dir)
  const byId = new Map(manifest.entries.map((e) => [e.id, e]))

  // Everything is checked and read first; only then is anything written.
  const planned: Planned[] = []
  const copied: { to: string; entry: VendorEntry }[] = []
  for (const f of files) {
    const entry = byId.get(f.from)
    if (entry === undefined) throw new Error(`"${f.from}" is not a bundled file.`)
    targetIn(project, f.to, web)
    planned.push({ to: f.to, bytes: await readChecked(dir, entry.path, entry.sha256, entry.id), entry })
    copied.push({ to: f.to, entry })
  }
  for (const e of new Map(copied.map((c) => [c.entry.id, c.entry])).values()) {
    if (e.origin !== 'third-party') continue
    planned.push({
      to: `${LICENSES_DIR}/${e.id}.txt`,
      bytes: await readChecked(dir, e.licenseFile, e.licenseSha256, `${e.id} licence`),
    })
  }
  planned.push({ to: VENDORED_FILE, bytes: Buffer.from(vendoredText(copied), 'utf8') })

  const seen = new Set<string>()
  for (const p of planned) {
    const key = p.to.toLowerCase()
    if (seen.has(key)) throw new Error(`${p.to} would be written twice.`)
    seen.add(key)
    if (existsSync(targetIn(project, p.to, web))) throw new Error(`${p.to} is already in the project.`)
  }
  const written: string[] = []
  for (const p of planned) {
    const abs = targetIn(project, p.to, web)
    await mkdir(path.dirname(abs), { recursive: true })
    // `wx`: never overwrite (the folder was new a moment ago).
    await writeFile(abs, p.bytes, { flag: 'wx' })
    written.push(p.to)
  }
  return written
}
