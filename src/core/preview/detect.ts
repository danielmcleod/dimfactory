// Run & Preview detection: how a folder can be run, read from its files with no model and no tokens. It reuses Verify's
// discovery (package.json and its package manager, the scripts body trust covers, the uv / poetry runner) and adds:
//   package scripts `dev`, `start`, `preview` (an Electron app's run its own window) · `index.html` served by Dim
//   Factory's static server (the folder, or docs/, dist/, build/, site/, _site/, public/, out/, www/; a Vite project's
//   own index.html is its build's source, so only its dist/ is served) · Python entry
//   points (Django's manage.py, Streamlit, FastAPI through uvicorn, Flask, a plain script) · `docker compose up` ·
//   `cargo run` · `go run` · Electron without a script · notebooks (JupyterLab) · the packs' strategies (data) · Markdown
//   documents Dim Factory renders itself (a top-level `memo.md`, a `docs/` folder of pages; document.ts).
// Every command is argv: no shell ever reads it, and it runs only once the user trusts it (trust.ts).
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Pack, PackPreview } from '../../shared/brief.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { PreviewCommand, PreviewKind, PreviewSource } from '../../shared/preview.ts'
import { displayArgv } from '../verify/argv.ts'
import { cwdRelOf, detectPackageManager } from '../verify/discover.ts'
import { folderPages, topDocuments } from './document.ts'
import { COMPOSE_FILES, previewTrustOf, readPreviewBody } from './trust.ts'

const MAX_READ = 256 * 1024

/** Package scripts that start the project, in the order they are offered. */
export const PREVIEW_SCRIPTS = ['dev', 'start', 'preview'] as const
/** Folders whose index.html is offered to the static server (the folder itself first). */
export const STATIC_DIRS = ['.', 'docs', 'dist', 'build', 'site', '_site', 'public', 'out', 'www'] as const
/** Python files that are often the program's entry. */
export const PYTHON_ENTRIES = ['app.py', 'main.py', 'server.py', 'run.py', 'streamlit_app.py'] as const
const MAX_STATIC = 3
const MAX_PYTHON = 2
/** The most top-level Markdown documents offered (a `docs/` folder is one more). */
const MAX_DOCS = 3
/** Folders whose Markdown pages are offered as one document. */
export const DOC_DIRS = ['docs'] as const
const DOC_NOTE =
  'Dim Factory shows the document itself, read-only, on this computer only. It can be saved as a PDF.'

const APP_NOTE =
  'Opens its own window: there is no page to preview, so watch for the window and its output here.'
const COMMAND_NOTE = 'Runs and prints its output here; it serves no page.'
const COMPOSE_NOTE =
  'Needs Docker. Stop ends the compose command; the containers it started keep running until you press Stop containers too (docker compose down).'

async function readText(p: string): Promise<string | null> {
  try {
    const s = await stat(p)
    if (!s.isFile() || s.size > MAX_READ) return null
    return (await readFile(p, 'utf8')).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

interface PackageInfo {
  scripts: Record<string, string>
  deps: Set<string>
  main?: string
}

function parsePackage(text: string): PackageInfo | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const strings = (x: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (typeof x === 'object' && x !== null && !Array.isArray(x))
      for (const [k, s] of Object.entries(x as Record<string, unknown>)) if (typeof s === 'string') out[k] = s
    return out
  }
  const deps = new Set([
    ...Object.keys(strings(o['dependencies'])),
    ...Object.keys(strings(o['devDependencies'])),
  ])
  const main = typeof o['main'] === 'string' ? o['main'] : undefined
  return { scripts: strings(o['scripts']), deps, ...(main !== undefined ? { main } : {}) }
}

/** A detected command before its trust is read. */
interface Draft {
  id: string
  kind: PreviewKind
  source: PreviewSource
  argv: string[]
  staticRoot?: string
  urlHint?: string
  note?: string
  packId?: string
  label?: string
  docPath?: string
}

async function fromPackage(folder: string, root: string): Promise<Draft[]> {
  const text = await readText(join(folder, 'package.json'))
  const pkg = text === null ? null : parsePackage(text)
  if (pkg === null) return []
  const pm = await detectPackageManager(folder, root)
  const electron = pkg.deps.has('electron')
  const out: Draft[] = []
  for (const name of PREVIEW_SCRIPTS) {
    if (!Object.hasOwn(pkg.scripts, name)) continue
    const runsElectron = electron && /\belectron(?:-vite|-forge)?\b/.test(pkg.scripts[name] ?? '')
    out.push({
      id: `pkg:${name}`,
      kind: runsElectron ? 'app' : 'server',
      source: runsElectron ? 'electron' : 'package.json',
      argv: [pm, 'run', name],
      ...(runsElectron ? { note: APP_NOTE } : {}),
    })
  }
  // An Electron app with no script that starts it: its own electron binary on the package.
  if (electron && !out.some((d) => d.source === 'electron') && pkg.main !== undefined) {
    out.push({ id: 'electron', kind: 'app', source: 'electron', argv: ['electron', '.'], note: APP_NOTE })
  }
  return out
}

/**
 * The folder builds its page with Vite (vite in package.json, or a vite.config): its own index.html is the build's
 * source, which no browser can open as it is, so only the build (dist/) is served.
 */
async function buildsWithVite(folder: string): Promise<boolean> {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'])
    if (await isFile(join(folder, name))) return true
  const text = await readText(join(folder, 'package.json'))
  const pkg = text === null ? null : parsePackage(text)
  return pkg?.deps.has('vite') === true
}

/** Folders whose index.html is a build's source, never served as it is (a Vite project's own folder and public/). */
const VITE_SOURCE_DIRS: ReadonlySet<string> = new Set(['.', 'public'])

async function fromStatic(folder: string): Promise<Draft[]> {
  const out: Draft[] = []
  const vite = await buildsWithVite(folder)
  for (const dir of STATIC_DIRS) {
    if (out.length >= MAX_STATIC) break
    if (vite && VITE_SOURCE_DIRS.has(dir)) continue
    if (!(await isFile(join(folder, dir, 'index.html')))) continue
    out.push({
      id: `static:${dir}`,
      kind: 'static',
      source: 'static',
      argv: [],
      staticRoot: dir,
      label: dir === '.' ? 'Serve index.html' : `Serve ${dir}/index.html`,
      note: 'Dim Factory serves these files itself, read-only, on this computer only.',
    })
  }
  return out
}

/** The Markdown documents (document.ts): each top-level one, then a `docs/` folder of pages as one. */
async function fromDocuments(folder: string): Promise<Draft[]> {
  const out: Draft[] = []
  for (const name of (await topDocuments(folder)).slice(0, MAX_DOCS)) {
    out.push({
      id: `doc:${name}`,
      kind: 'document',
      source: 'document',
      argv: [],
      docPath: name,
      label: `Read ${name}`,
      note: DOC_NOTE,
    })
  }
  for (const dir of DOC_DIRS) {
    const pages = await folderPages(join(folder, dir))
    if (pages.length === 0) continue
    out.push({
      id: `doc:${dir}`,
      kind: 'document',
      source: 'document',
      argv: [],
      docPath: dir,
      label: `Read ${dir}/ (${pages.length} ${pages.length === 1 ? 'page' : 'pages'})`,
      note: DOC_NOTE,
    })
  }
  return out
}

/** `uv run` / `poetry run` when that tool's lockfile is in the folder or a parent up to the scope root. */
async function pythonPrefix(folder: string, root: string): Promise<string[]> {
  let dir = resolve(folder)
  const top = resolve(root)
  for (;;) {
    if (await isFile(join(dir, 'uv.lock'))) return ['uv', 'run']
    if (await isFile(join(dir, 'poetry.lock'))) return ['poetry', 'run']
    if (dir === top) return []
    const parent = resolve(dir, '..')
    if (parent === dir || cwdRelOf(top, parent) === null) return []
    dir = parent
  }
}

const pythonExe = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'python' : 'python3')

/** How a Python entry file runs, from what it imports. */
export function pythonEntry(
  file: string,
  text: string,
  python: string,
): { argv: string[]; kind: PreviewKind; note?: string } {
  const mod = file.replace(/\.py$/, '')
  if (/^\s*(?:import\s+streamlit|from\s+streamlit\s+import)\b/m.test(text)) {
    return { argv: ['streamlit', 'run', file, '--server.headless', 'true'], kind: 'server' }
  }
  const fastapi = /^\s*(\w+)\s*=\s*FastAPI\s*\(/m.exec(text)
  if (fastapi !== null && !/\buvicorn\.run\s*\(/.test(text)) {
    return { argv: ['uvicorn', `${mod}:${fastapi[1] ?? 'app'}`], kind: 'server' }
  }
  const flask = /^\s*(\w+)\s*=\s*Flask\s*\(/m.exec(text)
  if (flask !== null && !/\.run\s*\(/.test(text)) {
    return { argv: ['flask', '--app', mod, 'run'], kind: 'server' }
  }
  const serves =
    /\b(?:flask|fastapi|uvicorn|aiohttp|http\.server|gradio|dash|bottle|tornado|socketserver)\b/i.test(text)
  return {
    argv: [python, file],
    kind: serves ? 'server' : 'command',
    ...(serves ? {} : { note: COMMAND_NOTE }),
  }
}

async function fromPython(folder: string, root: string, platform: NodeJS.Platform): Promise<Draft[]> {
  const out: Draft[] = []
  const python = pythonExe(platform)
  let prefix: string[] | null = null
  const withPrefix = async (argv: string[]): Promise<string[]> => [
    ...(prefix ??= await pythonPrefix(folder, root)),
    ...argv,
  ]
  if (await isFile(join(folder, 'manage.py'))) {
    out.push({
      id: 'python:manage.py',
      kind: 'server',
      source: 'python',
      argv: await withPrefix([python, 'manage.py', 'runserver']),
    })
  }
  for (const f of PYTHON_ENTRIES) {
    if (out.length >= MAX_PYTHON) break
    const text = await readText(join(folder, f))
    if (text === null) continue
    const e = pythonEntry(f, text, python)
    out.push({
      id: `python:${f}`,
      kind: e.kind,
      source: 'python',
      argv: await withPrefix(e.argv),
      ...(e.note !== undefined ? { note: e.note } : {}),
    })
  }
  return out
}

/** The first host port a compose file publishes (`- "8080:80"`, `- 127.0.0.1:3000:3000`), as a loopback URL. */
export function composeUrlHint(text: string): string | undefined {
  const m = /^\s*-\s*["']?(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d{2,5}):\d{1,5}(?:\/tcp)?["']?\s*$/m.exec(text)
  const port = Number(m?.[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}/` : undefined
}

async function fromDocker(folder: string): Promise<Draft[]> {
  for (const name of COMPOSE_FILES) {
    const text = await readText(join(folder, name))
    if (text === null) continue
    const hint = composeUrlHint(text)
    return [
      {
        id: 'docker:compose',
        kind: 'server',
        source: 'docker',
        argv: ['docker', 'compose', 'up'],
        note: COMPOSE_NOTE,
        ...(hint !== undefined ? { urlHint: hint } : {}),
      },
    ]
  }
  return []
}

const RUST_WEB = /^\s*(?:actix-web|axum|rocket|warp|hyper|tide|poem|salvo)\s*=/m
const GO_WEB =
  /"(?:net\/http|github\.com\/gin-gonic\/gin|github\.com\/labstack\/echo[^"]*|github\.com\/gofiber\/fiber[^"]*)"/

async function fromCargo(folder: string): Promise<Draft[]> {
  const toml = await readText(join(folder, 'Cargo.toml'))
  if (toml === null) return []
  const hasBin = /^\s*\[\[bin\]\]/m.test(toml) || (await isFile(join(folder, 'src', 'main.rs')))
  if (!hasBin) return []
  const web = RUST_WEB.test(toml)
  return [
    {
      id: 'cargo:run',
      kind: web ? 'server' : 'command',
      source: 'cargo',
      argv: ['cargo', 'run'],
      ...(web ? {} : { note: COMMAND_NOTE }),
    },
  ]
}

async function fromGo(folder: string): Promise<Draft[]> {
  if (!(await isFile(join(folder, 'go.mod')))) return []
  let target: string | null = null
  let text = await readText(join(folder, 'main.go'))
  if (text !== null) target = '.'
  else {
    const cmds = await readdir(join(folder, 'cmd')).catch((): string[] => [])
    for (const c of cmds.sort()) {
      text = await readText(join(folder, 'cmd', c, 'main.go'))
      if (text !== null) {
        target = `./cmd/${c}`
        break
      }
    }
  }
  if (target === null || text === null) return []
  const web = GO_WEB.test(text)
  return [
    {
      id: `go:${target}`,
      kind: web ? 'server' : 'command',
      source: 'go',
      argv: ['go', 'run', target],
      ...(web ? {} : { note: COMMAND_NOTE }),
    },
  ]
}

async function fromNotebooks(folder: string, root: string, entries: readonly string[]): Promise<Draft[]> {
  if (!entries.some((e) => e.toLowerCase().endsWith('.ipynb'))) return []
  return [
    {
      id: 'notebook:jupyter',
      kind: 'server',
      source: 'notebook',
      argv: [...(await pythonPrefix(folder, root)), 'jupyter', 'lab', '--no-browser'],
      note: 'Opens the notebooks in JupyterLab (it must be installed).',
    },
  ]
}

/** A pack strategy's `when.files` entry against the folder's root entries (a name, or `*.ext`). */
function fileMatches(pattern: string, entries: readonly string[]): boolean {
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1).toLowerCase()
    return entries.some((e) => e.toLowerCase().endsWith(ext))
  }
  return entries.includes(pattern)
}

function fromPacks(packs: readonly Pack[], entries: readonly string[]): Draft[] {
  const out: Draft[] = []
  for (const pack of packs) {
    for (const s of pack.preview ?? ([] as PackPreview[])) {
      if (!s.when.files.every((f) => fileMatches(f, entries))) continue
      out.push({
        id: `pack:${pack.id}:${s.id}`,
        kind: s.kind,
        source: 'pack',
        packId: pack.id,
        argv: [...s.run],
        ...(s.note !== undefined ? { note: s.note } : {}),
        ...(s.url !== undefined ? { urlHint: s.url } : {}),
      })
    }
  }
  return out
}

export interface DetectPreviewOptions {
  /** The folder to run (a run's folder, or its isolated copy). */
  folder: string
  /** The scope root `cwdRel` and the grants are relative to. Default: the folder. */
  scopeRoot?: string
  /** The packs (with the user's and the project's overrides) whose strategies count. Default: none. */
  packs?: readonly Pack[]
  /** The folder's trust grants. Default: none (every command reads untrusted). */
  grants?: TrustGrants
  platform?: NodeJS.Platform
}

/**
 * The ways `folder` can be run, in the order they are offered: package scripts (or Electron), Python, compose, Cargo,
 * Go, notebooks, the packs' strategies, then the static server's index.html folders. A command whose argv an earlier
 * one already has is left out. Each command's trust is read against the grants now.
 */
export async function detectPreviewCommands(o: DetectPreviewOptions): Promise<PreviewCommand[]> {
  const folder = resolve(o.folder)
  const root = resolve(o.scopeRoot ?? o.folder)
  const platform = o.platform ?? process.platform
  const cwdRel = cwdRelOf(root, folder) ?? '.'
  const entries = await readdir(folder).catch((): string[] => [])
  const lists = await Promise.all([
    fromPackage(folder, root),
    fromPython(folder, root, platform),
    fromDocker(folder),
    fromCargo(folder),
    fromGo(folder),
    fromNotebooks(folder, root, entries),
  ])
  const drafts = [
    ...lists.flat(),
    ...fromPacks(o.packs ?? [], entries),
    ...(await fromStatic(folder)),
    ...(await fromDocuments(folder)),
  ]
  const seen = new Set<string>()
  const out: PreviewCommand[] = []
  for (const d of drafts) {
    const key =
      d.kind === 'static'
        ? `static\u0000${d.staticRoot ?? '.'}`
        : d.kind === 'document'
          ? `document\u0000${d.docPath ?? ''}`
          : JSON.stringify(d.argv)
    if (seen.has(key)) continue
    seen.add(key)
    const base: PreviewCommand = {
      id: d.id,
      label: d.label ?? displayArgv(d.argv),
      kind: d.kind,
      source: d.source,
      argv: d.argv,
      cwdRel,
      trust: 'none',
      ...(d.packId !== undefined ? { packId: d.packId } : {}),
      ...(d.staticRoot !== undefined ? { staticRoot: d.staticRoot } : {}),
      ...(d.docPath !== undefined ? { docPath: d.docPath } : {}),
      ...(d.urlHint !== undefined ? { urlHint: d.urlHint } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
    }
    if (d.kind === 'static' || d.kind === 'document') {
      out.push(base)
      continue
    }
    const read = await readPreviewBody(root, { argv: d.argv, cwdRel })
    if (read.error !== undefined) {
      out.push({ ...base, trust: 'untrusted', error: read.error })
      continue
    }
    const t = previewTrustOf({ argv: d.argv, cwdRel }, read.body, o.grants ?? {})
    out.push({ ...base, trust: t.trust, hash: t.hash })
  }
  return out
}

/** RUN.md (any case) in the folder: its text, cut at `max` bytes. */
export async function readRunMd(
  folder: string,
  max: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const entries = await readdir(folder).catch((): string[] => [])
  const name = entries.find((e) => e.toLowerCase() === 'run.md')
  if (name === undefined) return null
  try {
    const p = join(folder, name)
    const s = await stat(p)
    if (!s.isFile()) return null
    const buf = await readFile(p)
    const truncated = buf.length > max
    let text = buf
      .subarray(0, max)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
    // A cut in the middle of a character leaves a replacement character at the end.
    if (truncated) text = text.replace(/\uFFFD$/, '')
    return { text: text.replace(/\r\n/g, '\n'), truncated }
  } catch {
    return null
  }
}
