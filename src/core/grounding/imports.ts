// Imports in the lines a run added (JavaScript/TypeScript, Python, Go, Rust), checked against what the project has:
// its manifest and lockfile, its installed packages (node_modules), the language's standard library, and for a
// relative import a file. An import none of them knows is likely made up. Pure: the caller gives the project's facts.
import { builtinModules } from 'node:module'

export type ImportLang = 'js' | 'python' | 'go' | 'rust'

export interface ImportRef {
  lang: ImportLang
  /** The file that imports it (relative to the run's folder). */
  file: string
  /** As written (`./util.js`, `lodash/fp`, `yaml`, `github.com/x/y`, `serde`). */
  spec: string
  /** A relative import (a file of the project) rather than a package. */
  relative: boolean
}

const JS_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i
const PY_EXT = /\.pyi?$/i
const GO_EXT = /\.go$/i
const RS_EXT = /\.rs$/i

export function langOf(file: string): ImportLang | undefined {
  if (JS_EXT.test(file)) return 'js'
  if (PY_EXT.test(file)) return 'python'
  if (GO_EXT.test(file)) return 'go'
  if (RS_EXT.test(file)) return 'rust'
  return undefined
}

const JS_IMPORT =
  /(?:^|[\s;{}(])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]|(?:^|[\s;{}(])import\s*['"]([^'"\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/
const GO_IMPORT_ONE = /^\s*import\s+(?:[\w.]+\s+)?"([^"\s]+)"\s*$/
const GO_IMPORT_IN_BLOCK = /^\s*(?:[\w.]+\s+)?"([^"\s]+)"\s*$/
const RS_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use\s+(?:::)?([A-Za-z_]\w*)|extern\s+crate\s+([A-Za-z_]\w*))/

/** The imports in one file's added lines. */
export function importsOf(file: string, lines: readonly string[]): ImportRef[] {
  const lang = langOf(file)
  if (lang === undefined) return []
  const out: ImportRef[] = []
  const add = (spec: string, relative: boolean): void => {
    if (spec === '' || out.some((r) => r.spec === spec)) return
    out.push({ lang, file, spec, relative })
  }
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '')
    if (lang === 'js') {
      for (const m of line.matchAll(JS_IMPORT)) {
        const spec = (m[1] ?? m[2] ?? m[3] ?? '').trim()
        add(spec, spec.startsWith('.'))
      }
    } else if (lang === 'python') {
      const m = PY_IMPORT.exec(raw.replace(/#.*$/, ''))
      if (m === null) continue
      if (m[1] !== undefined) add(m[1], m[1].startsWith('.'))
      else for (const part of (m[2] ?? '').split(',')) add(part.trim(), false)
    } else if (lang === 'go') {
      const m = GO_IMPORT_ONE.exec(line) ?? GO_IMPORT_IN_BLOCK.exec(line)
      if (m !== null && /^[\w.\-/~]+$/.test(m[1] ?? '')) add(m[1] ?? '', false)
    } else {
      const m = RS_USE.exec(line)
      if (m !== null) add(m[1] ?? m[2] ?? '', false)
    }
  }
  return out
}

/** The package a JavaScript specifier names (`@scope/name`, `name`), or undefined for one that is not a package. */
export function npmPackageOf(spec: string): string | undefined {
  if (
    spec === '' ||
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('#') ||
    spec.startsWith('~')
  )
    return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.includes('!') || spec.includes('$') || spec.includes('?'))
    return undefined
  const parts = spec.split('/')
  if (spec.startsWith('@'))
    return parts.length >= 2 && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0]
}

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))

/** Python's standard library (top-level modules), enough to tell it from a third-party import. */
export const PYTHON_STDLIB: ReadonlySet<string> = new Set(
  (
    '__future__ _thread abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect ' +
    'builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent ' +
    'configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal ' +
    'difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch ' +
    'fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib ' +
    'imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma ' +
    'mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib ntpath ' +
    'numbers operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib ' +
    'posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib ' +
    'resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr ' +
    'socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symtable sys ' +
    'sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize ' +
    'tomllib trace traceback tracemalloc tty turtle turtledemo types typing typing_extensions unicodedata unittest ' +
    'urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile ' +
    'zipimport zlib zoneinfo'
  ).split(' '),
)

/** Import names whose package is published under another name (import name -> distribution names). */
export const PYTHON_DIST_NAMES: Readonly<Record<string, readonly string[]>> = {
  yaml: ['pyyaml'],
  PIL: ['pillow'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv-contrib-python'],
  sklearn: ['scikit-learn'],
  skimage: ['scikit-image'],
  bs4: ['beautifulsoup4'],
  dateutil: ['python-dateutil'],
  dotenv: ['python-dotenv'],
  jwt: ['pyjwt'],
  serial: ['pyserial'],
  Crypto: ['pycryptodome', 'pycrypto'],
  attr: ['attrs'],
  magic: ['python-magic'],
  docx: ['python-docx'],
  pptx: ['python-pptx'],
  OpenSSL: ['pyopenssl'],
  zmq: ['pyzmq'],
  usb: ['pyusb'],
  gi: ['pygobject'],
  MySQLdb: ['mysqlclient'],
  psycopg2: ['psycopg2', 'psycopg2-binary'],
  fitz: ['pymupdf'],
  telegram: ['python-telegram-bot'],
  discord: ['discord-py'],
  win32api: ['pywin32'],
  win32con: ['pywin32'],
  pkg_resources: ['setuptools'],
  google: ['protobuf'],
}

/** pip's name normalization (PEP 503). */
export const pipName = (n: string): string =>
  n
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-')

const RUST_ROOTS: ReadonlySet<string> = new Set([
  'std',
  'core',
  'alloc',
  'proc_macro',
  'test',
  'crate',
  'self',
  'super',
  'Self',
])

/** What the project has, for resolving imports (the caller reads it from the run's end commit and its folder). */
export interface ImportFacts {
  /** Every file of the project at the run's end (relative, `/`). */
  files: ReadonlySet<string>
  npm: {
    /** A package.json was found (else package imports are not checked). */
    manifest: boolean
    /** Dependencies the manifests and lockfiles name. */
    names: ReadonlySet<string>
    /** tsconfig `paths` and bundler alias prefixes (`@/`, `@shared/`). */
    aliases: readonly string[]
    /** node_modules/<name> exists. */
    installed: (name: string) => boolean
  }
  python: { manifest: boolean; names: ReadonlySet<string> }
  go: { module?: string; requires: readonly string[] }
  rust: { manifest: boolean; crates: ReadonlySet<string> }
}

const JS_RESOLVE_EXT = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.d.ts',
  '.vue',
  '.svelte',
]

function dirOf(file: string): string {
  const i = file.lastIndexOf('/')
  return i < 0 ? '' : file.slice(0, i)
}

/** `a/b/../c` → `a/c`; undefined when it climbs out of the project. */
export function joinRel(dir: string, rel: string): string | undefined {
  const out: string[] = dir === '' ? [] : dir.split('/')
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

const hasDir = (files: ReadonlySet<string>, dir: string): boolean => {
  const pre = `${dir}/`
  for (const f of files) if (f.startsWith(pre)) return true
  return false
}

function jsRelativeResolves(file: string, spec: string, files: ReadonlySet<string>): boolean {
  const target = joinRel(dirOf(file), spec.replace(/[?#].*$/, ''))
  if (target === undefined) return true // outside the project: not ours to judge
  const stems = [target]
  // TypeScript's ESM style imports `./x.js` for `x.ts`.
  const swapped = target.replace(/\.(?:[cm]?js|jsx)$/, '')
  if (swapped !== target) stems.push(swapped)
  for (const s of stems) {
    if (files.has(s)) return true
    for (const ext of JS_RESOLVE_EXT) {
      if (files.has(`${s}${ext}`) || files.has(`${s}/index${ext}`)) return true
    }
  }
  return false
}

function pythonResolves(ref: ImportRef, f: ImportFacts): boolean {
  if (ref.relative) {
    const dots = /^\.+/.exec(ref.spec)?.[0].length ?? 1
    let dir = dirOf(ref.file)
    for (let i = 1; i < dots; i++) dir = dirOf(dir)
    const rest = ref.spec.slice(dots).split('.').filter(Boolean).join('/')
    if (rest === '') return true
    const base = dir === '' ? rest : `${dir}/${rest}`
    return f.files.has(`${base}.py`) || f.files.has(`${base}.pyi`) || hasDir(f.files, base)
  }
  const top = ref.spec.split('.')[0] ?? ref.spec
  if (top === '' || PYTHON_STDLIB.has(top)) return true
  // The project's own package or module (at the root, under src/, or beside the importing file).
  const local = [top, `src/${top}`, dirOf(ref.file) === '' ? top : `${dirOf(ref.file)}/${top}`]
  if (local.some((p) => f.files.has(`${p}.py`) || hasDir(f.files, p))) return true
  if (!f.python.manifest) return true
  const names = f.python.names
  if (names.has(pipName(top))) return true
  for (const d of PYTHON_DIST_NAMES[top] ?? []) if (names.has(pipName(d))) return true
  // A namespace (google.cloud, azure.storage): any distribution that starts with it.
  const pre = `${pipName(top)}-`
  for (const n of names) if (n.startsWith(pre)) return true
  return false
}

function goResolves(spec: string, f: ImportFacts): boolean {
  const first = spec.split('/')[0] ?? spec
  if (!first.includes('.')) return true // the standard library (and `C`)
  if (f.go.module !== undefined && (spec === f.go.module || spec.startsWith(`${f.go.module}/`))) return true
  if (f.go.module === undefined && f.go.requires.length === 0) return true // no go.mod: not ours to judge
  return f.go.requires.some((r) => spec === r || spec.startsWith(`${r}/`))
}

function rustResolves(spec: string, f: ImportFacts): boolean {
  if (RUST_ROOTS.has(spec) || !f.rust.manifest) return true
  if (f.rust.crates.has(spec.replace(/-/g, '_'))) return true
  // A module of the crate (2018 edition `use config::X` after `mod config;`).
  for (const file of f.files) {
    if (file.endsWith(`/${spec}.rs`) || file.endsWith(`/${spec}/mod.rs`) || file === `${spec}.rs`) return true
  }
  return false
}

/** Whether one import resolves to something the project has. */
export function importResolves(ref: ImportRef, f: ImportFacts): boolean {
  switch (ref.lang) {
    case 'js': {
      if (ref.relative) return jsRelativeResolves(ref.file, ref.spec, f.files)
      if (ref.spec.startsWith('node:') || ref.spec.startsWith('bun:')) return true
      if (f.npm.aliases.some((a) => ref.spec === a.replace(/\/$/, '') || ref.spec.startsWith(a))) return true
      const pkg = npmPackageOf(ref.spec)
      if (pkg === undefined || NODE_BUILTINS.has(pkg) || NODE_BUILTINS.has(ref.spec)) return true
      if (!f.npm.manifest) return true
      // A project-root-relative import some bundlers allow (`src/x`): a folder of the project.
      if (f.files.has(pkg) || hasDir(f.files, pkg)) return true
      return f.npm.names.has(pkg) || f.npm.installed(pkg)
    }
    case 'python':
      return pythonResolves(ref, f)
    case 'go':
      return goResolves(ref.spec, f)
    case 'rust':
      return rustResolves(ref.spec, f)
  }
}

/** The imports in the run's added lines that resolve to nothing the project has. */
export function unresolvedImports(
  added: ReadonlyMap<string, readonly string[]>,
  f: ImportFacts,
): ImportRef[] {
  const out: ImportRef[] = []
  for (const [file, lines] of added) {
    for (const ref of importsOf(file, lines)) if (!importResolves(ref, f)) out.push(ref)
  }
  return out
}

/** The top-level module names the added lines import (for the verify "Cannot find module" rule). */
export function importedNames(added: ReadonlyMap<string, readonly string[]>): Set<string> {
  const out = new Set<string>()
  for (const [file, lines] of added) {
    for (const ref of importsOf(file, lines)) {
      if (ref.relative) continue
      if (ref.lang === 'js') {
        const pkg = npmPackageOf(ref.spec)
        if (pkg !== undefined) out.add(pkg)
      } else if (ref.lang === 'python') out.add(ref.spec.split('.')[0] ?? ref.spec)
      else out.add(ref.spec)
    }
  }
  return out
}
