// Project templates ("New project"). The built-in templates are JSON files next to this module; a user file
// `<home>/templates/<id>.json` replaces the built-in of its id, and a new id adds a template. There is no project
// layer: the project does not exist yet. Every template is checked against its pack (the packs as the user's
// overrides leave them): a template whose pack is missing, or whose Brief names a group or option the pack does not
// have, is reported as an issue and left out, never fatal.
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodError } from 'zod'
import type { Pack } from '../../shared/brief.ts'
import { TemplateZ, templateBrief } from '../../shared/templates.ts'
import type { Template, TemplateIssue, TemplatesList, TemplateView } from '../../shared/templates.ts'
import { checkBrief } from '../brief/brief.ts'
import { loadPacks } from '../packs/load.ts'
import { normalizeText } from '../prompts/template.ts'

/** The built-in templates, in the order "New project" lists them within a pack. */
export const BUILTIN_TEMPLATE_IDS = [
  'vite-react',
  'nextjs',
  'fastapi',
  'static-site',
  'react-site',
  'electron',
  'node-cli',
  'docs-site',
  'docs-simple',
  'data-report',
  'data-report-web',
  'landing-page',
  'landing-react',
  'decision-memo',
  'explainer-memo',
  'runbook',
  'checklist',
  'game-canvas',
  'game-board',
  'game-story',
  'game-phaser',
  'game-tool',
  'game-vite',
  'game-3d-lite',
  'game-online',
] as const

/** A user template file larger than this is refused (templates are small). */
export const TEMPLATE_FILE_MAX_BYTES = 64 * 1024

/**
 * Where the built-in templates live: beside this module in the source tree, or in `templates/` beside the bundled
 * main module. The first directory holding `vite-react.json` wins.
 */
function defaultBuiltinDir(): string {
  const candidates = [
    fileURLToPath(new URL('./', import.meta.url)),
    fileURLToPath(new URL('./templates/', import.meta.url)),
  ]
  return candidates.find((d) => existsSync(join(d, 'vite-react.json'))) ?? (candidates[0] as string)
}

let builtinDirMemo: string | undefined
let builtinMemo: Template[] | undefined

export function builtinTemplatesDir(): string {
  builtinDirMemo ??= defaultBuiltinDir()
  return builtinDirMemo
}

function describeZodError(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

type Parsed = { ok: true; template: Template } | { ok: false; message: string }

/** Parse and validate one template file's text; the stem must be the template's id. */
export function parseTemplateText(raw: string, stem: string): Parsed {
  let json: unknown
  try {
    json = JSON.parse(normalizeText(raw))
  } catch (err) {
    return { ok: false, message: `Not valid JSON: ${(err as Error).message}` }
  }
  const r = TemplateZ.safeParse(json)
  if (!r.success) return { ok: false, message: `Not a valid template: ${describeZodError(r.error)}` }
  if (r.data.id !== stem) {
    return { ok: false, message: `The file name must match the template id ("${r.data.id}.json")` }
  }
  return { ok: true, template: r.data }
}

/** The built-in templates in their fixed order. A broken built-in is a packaging bug, so it throws. */
export function readBuiltinTemplates(dir?: string): Template[] {
  if (dir === undefined && builtinMemo !== undefined) return builtinMemo
  const base = dir ?? builtinTemplatesDir()
  const out = BUILTIN_TEMPLATE_IDS.map((id) => {
    const file = join(base, `${id}.json`)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(`Cannot read the built-in template ${file}: ${(err as Error).message}`, { cause: err })
    }
    const r = parseTemplateText(raw, id)
    if (!r.ok) throw new Error(`The built-in template ${file} is broken. ${r.message}`)
    return r.template
  })
  if (dir === undefined) builtinMemo = out
  return out
}

/** Why a template does not fit its pack (null: it fits). */
export function templatePackProblem(t: Template, packs: readonly Pack[]): string | null {
  const pack = packs.find((p) => p.id === t.pack)
  if (pack === undefined) return `There is no "${t.pack}" category for this template.`
  const checked = checkBrief(templateBrief(t), pack, [])
  return checked.ok
    ? null
    : `Its Brief does not fit the ${pack.label} category: ${checked.problems.join(' ')}`
}

async function readUserTemplates(dir: string, issues: TemplateIssue[]): Promise<Template[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      issues.push({ file: dir, message: `Cannot list the templates folder: ${(err as Error).message}` })
    }
    return []
  }
  const out: Template[] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, name)
    try {
      const st = await stat(file)
      if (!st.isFile()) continue
      if (st.size > TEMPLATE_FILE_MAX_BYTES) {
        issues.push({
          file,
          message: `Too large (${st.size} bytes; the limit is ${TEMPLATE_FILE_MAX_BYTES})`,
        })
        continue
      }
      const r = parseTemplateText(await readFile(file, 'utf8'), name.slice(0, -'.json'.length))
      if (!r.ok) issues.push({ file, message: r.message })
      else out.push(r.template)
    } catch (err) {
      issues.push({ file, message: `Cannot read: ${(err as Error).message}` })
    }
  }
  return out
}

export interface LoadTemplatesOptions {
  /** DIM_FACTORY_HOME (the user layer is `<home>/templates/`; the packs' user layer is `<home>/packs/`). */
  home: string
  /** Test seams. */
  builtinDir?: string
  packsBuiltinDir?: string
}

/**
 * Every usable template: a user file beats the built-in of its id. Grouped by pack in the packs' order, built-ins in
 * their fixed order within a pack, added ids after them (sorted). Problems (unreadable files, templates that do not
 * fit their pack) become issues.
 */
export async function loadTemplates(o: LoadTemplatesOptions): Promise<TemplatesList> {
  const issues: TemplateIssue[] = []
  const { packs: packViews } = await loadPacks({
    home: o.home,
    ...(o.packsBuiltinDir !== undefined ? { builtinDir: o.packsBuiltinDir } : {}),
  })
  const packs = packViews.map((v) => v.pack)
  const byId = new Map<string, TemplateView>()
  const fileOf = new Map<string, string>()
  const builtinDir = o.builtinDir ?? builtinTemplatesDir()
  for (const t of readBuiltinTemplates(o.builtinDir)) {
    byId.set(t.id, { template: t, layer: 'builtin' })
    fileOf.set(t.id, join(builtinDir, `${t.id}.json`))
  }
  const builtinIds = [...byId.keys()]
  const userDir = join(o.home, 'templates')
  for (const t of await readUserTemplates(userDir, issues)) {
    // Copying files into a project is for the built-in templates alone (their files are bundled and hash-checked).
    if (t.files !== undefined && t.files.length > 0) {
      issues.push({
        file: join(userDir, `${t.id}.json`),
        message:
          'Only built-in templates can copy files into a project. Remove "files" to use this template.',
      })
      continue
    }
    byId.set(t.id, { template: t, layer: 'user' })
    fileOf.set(t.id, join(userDir, `${t.id}.json`))
  }
  const added = [...byId.keys()].filter((id) => !builtinIds.includes(id)).sort()
  const usable: TemplateView[] = []
  for (const id of [...builtinIds, ...added]) {
    const v = byId.get(id) as TemplateView
    const problem = templatePackProblem(v.template, packs)
    if (problem !== null) {
      issues.push({ file: fileOf.get(id) ?? id, message: problem })
      continue
    }
    usable.push(v)
  }
  const packOrder = packs.map((p) => p.id)
  const templates = packOrder.flatMap((pid) => usable.filter((v) => v.template.pack === pid))
  const used = new Set(templates.map((v) => v.template.pack))
  return {
    templates,
    packs: packs.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, label: p.label })),
    issues,
  }
}

export function templateById(list: TemplatesList, id: string): TemplateView | undefined {
  return list.templates.find((v) => v.template.id === id)
}
