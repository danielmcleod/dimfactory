// The Brief's packs (use-case categories). The built-in packs are JSON files next to this module; a user file
// `<home>/packs/<id>.json` replaces the built-in of its id, and a project file `<folder>/.dimfactory/packs/<id>.json`
// replaces both. An override with a new id adds a category. A broken override is reported and skipped, never fatal.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodError } from 'zod'
import { PackZ } from '../../shared/brief.ts'
import type { Pack, PackIssue, PackLayer, PackView } from '../../shared/brief.ts'
import { normalizeText } from '../prompts/template.ts'
import { BRAND } from '../../shared/brand.ts'

export const BUILTIN_PACK_IDS = [
  'software',
  'documents',
  'data',
  'design',
  'operations',
  'research-writing',
  'games',
] as const
export type BuiltinPackId = (typeof BUILTIN_PACK_IDS)[number]

/** An override file larger than this is refused (packs are small). */
export const PACK_FILE_MAX_BYTES = 256 * 1024

/**
 * Where the built-in packs live: beside this module in the source tree, or in `packs/` beside the bundled main
 * module. The first directory holding `software.json` wins.
 */
function defaultBuiltinDir(): string {
  const candidates = [
    fileURLToPath(new URL('./', import.meta.url)),
    fileURLToPath(new URL('./packs/', import.meta.url)),
  ]
  return candidates.find((d) => existsSync(join(d, 'software.json'))) ?? (candidates[0] as string)
}

let builtinDirMemo: string | undefined
let builtinMemo: PackView[] | undefined

/** The directory the built-in packs (and the generic research lenses) are read from. */
export function builtinDir(): string {
  builtinDirMemo ??= defaultBuiltinDir()
  return builtinDirMemo
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function describeZodError(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

type Parsed = { ok: true; pack: Pack; sha256: string } | { ok: false; message: string }

/** Parse and validate one pack file's text; the stem must be the pack's id. */
function parsePackText(raw: string, stem: string): Parsed {
  const text = normalizeText(raw)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `Not valid JSON: ${(err as Error).message}` }
  }
  const r = PackZ.safeParse(json)
  if (!r.success) return { ok: false, message: `Not a valid pack: ${describeZodError(r.error)}` }
  if (r.data.id !== stem) {
    return { ok: false, message: `The file name must match the pack id ("${r.data.id}.json")` }
  }
  return { ok: true, pack: r.data, sha256: sha256(text) }
}

/** The built-in packs in their fixed order. A broken built-in is a packaging bug, so it throws. */
export function readBuiltinPacks(dir?: string): PackView[] {
  if (dir === undefined && builtinMemo !== undefined) return builtinMemo
  const base = dir ?? builtinDir()
  const views = BUILTIN_PACK_IDS.map((id): PackView => {
    const file = join(base, `${id}.json`)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(`Cannot read the built-in pack ${file}: ${(err as Error).message}`, { cause: err })
    }
    const r = parsePackText(raw, id)
    if (!r.ok) throw new Error(`The built-in pack ${file} is broken. ${r.message}`)
    return { pack: r.pack, layer: 'builtin', sha256: r.sha256 }
  })
  if (dir === undefined) builtinMemo = views
  return views
}

/** The override files of one layer directory, sorted by name; a missing directory has none. */
async function readOverrides(dir: string, layer: PackLayer, issues: PackIssue[]): Promise<PackView[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      issues.push({ file: dir, message: `Cannot list the packs folder: ${(err as Error).message}` })
    }
    return []
  }
  const views: PackView[] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, name)
    const stem = name.slice(0, -'.json'.length)
    try {
      const st = await stat(file)
      if (!st.isFile()) continue
      if (st.size > PACK_FILE_MAX_BYTES) {
        issues.push({ file, message: `Too large (${st.size} bytes; the limit is ${PACK_FILE_MAX_BYTES})` })
        continue
      }
      const r = parsePackText(await readFile(file, 'utf8'), stem)
      if (!r.ok) {
        issues.push({ file, message: r.message })
        continue
      }
      views.push({ pack: r.pack, layer, sha256: r.sha256 })
    } catch (err) {
      issues.push({ file, message: `Cannot read: ${(err as Error).message}` })
    }
  }
  return views
}

export interface LoadPacksOptions {
  /** DIM_FACTORY_HOME (the user layer is `<home>/packs/`). */
  home: string
  /** The run folder (the project layer is `<folder>/.dimfactory/packs/`); omitted: no project layer. */
  folder?: string
  /** Test seam for the built-in directory. */
  builtinDir?: string
}

/**
 * Every pack with overrides applied: project beats user beats built-in, per id. Built-ins keep their order (an
 * override replaces its built-in in place); added ids follow, sorted. Override problems become issues.
 */
export async function loadPacks(o: LoadPacksOptions): Promise<{ packs: PackView[]; issues: PackIssue[] }> {
  const issues: PackIssue[] = []
  const byId = new Map<string, PackView>()
  for (const v of readBuiltinPacks(o.builtinDir)) byId.set(v.pack.id, v)
  const builtinIds = [...byId.keys()]
  for (const v of await readOverrides(join(o.home, 'packs'), 'user', issues)) byId.set(v.pack.id, v)
  if (o.folder !== undefined) {
    const dir = join(o.folder, BRAND.projectDirName, 'packs')
    for (const v of await readOverrides(dir, 'project', issues)) byId.set(v.pack.id, v)
  }
  const added = [...byId.keys()].filter((id) => !builtinIds.includes(id)).sort()
  const packs = [...builtinIds, ...added].map((id) => byId.get(id) as PackView)
  return { packs, issues }
}

export function packById(packs: readonly PackView[], id: string): PackView | undefined {
  return packs.find((v) => v.pack.id === id)
}
