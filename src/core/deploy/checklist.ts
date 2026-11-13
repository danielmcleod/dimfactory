// The Deploy helper's pre-flight checklist, filled in from what Dim Factory can actually check, with no model and no
// network: no secret in the files the repository tracks (the security advisor's secret scanner over each file; a key
// that is public by design, like a Google browser key, is a warning to restrict it instead), no .env file committed,
// the environment variables the code reads and whether .env.example lists them (those a build puts into the page,
// VITE_ and the like, flagged as public), and a licence file. Everything else (HTTPS, sign-in on admin routes, error pages, logging, backups, a privacy policy, ...) is a
// manual item the user ticks; its state reads "not checked" until then, and a tick is the user's, never a pass.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeployCheckItem, DeployClass, DeployEnvVar } from '../../shared/deploy.ts'
import { NPM_PACKAGE_PATTERN } from '../../shared/templates.ts'
import { runGit, splitNul } from '../git/exec.ts'
import { detectRepo } from '../git/repo.ts'
import { scanTextForSecrets } from '../security/secrets.ts'
import type { SecretHit } from '../security/secrets.ts'

/** The most files the checklist reads (a larger folder is read in part, with a note). */
export const CHECK_FILES_MAX = 4000
/** One file larger than this is not read (generated or binary). */
export const CHECK_FILE_MAX_BYTES = 512 * 1024
/** The most bytes read in all. */
export const CHECK_TOTAL_MAX_BYTES = 48 * 1024 * 1024

const PRUNE = new Set([
  '.git',
  'node_modules',
  'bower_components',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  'dist',
  'build',
  'out',
  'coverage',
])

export const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|psd|sqlite|db)$/i

/** Source files whose environment reads are listed. */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|go|rs|rb|cs|php|java|kt|kts|ex|exs)$/i

const SECRETS_LABEL = 'No secrets committed'

// ---- keys and variables a page makes public ----------------------------------------------------------------------

/**
 * Secret-scanner rules whose keys are public by design when they are restricted (a Google API key such as a Maps or
 * Firebase browser key): a page may hold one, so it is a warning to restrict it, not a secret to refuse.
 */
export const RESTRICTABLE_KEY_RULES: ReadonlySet<string> = new Set(['google-api-key'])

export function isRestrictableKey(h: Pick<SecretHit, 'rule'>): boolean {
  return RESTRICTABLE_KEY_RULES.has(h.rule)
}

/** What to do about a key a page holds that is public by design. */
export const RESTRICT_KEY_ADVICE =
  "A key like this is meant to be in a web page, but anyone can copy it from there. Restrict it to your site's address (for a Google key: in the Google Cloud console, open Credentials, edit the key and set Website restrictions, and allow only the APIs it needs) so nobody else can use it on your account."

/** Prefixes of the variables a build puts into the page (Vite, Next.js, Create React App, Astro, Expo, Gatsby, Nuxt). */
export const PUBLIC_ENV_PREFIXES: readonly string[] = [
  'VITE_',
  'NEXT_PUBLIC_',
  'REACT_APP_',
  'PUBLIC_',
  'EXPO_PUBLIC_',
  'GATSBY_',
  'NUXT_PUBLIC_',
]

/** A variable the build puts into the page: anyone who opens the page can read its value. */
export function isPublicEnvName(name: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((p) => name.startsWith(p))
}

/** A variable name that says it holds a secret (not one that is public by design, like an anon or publishable key). */
export function looksSecretName(name: string): boolean {
  if (/(?:ANON|PUBLISHABLE|PUBLIC|SITE)_?KEY\b|MAPS?_/.test(name)) return false
  return /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|SERVICE_?ROLE|API_?KEY|_KEY$/.test(name)
}

/** Classes whose files a static host serves as they are: everything in them is public. */
const STATIC_CLASSES: ReadonlySet<DeployClass> = new Set(['static-site', 'spa', 'docs-site'])

/**
 * What to do about a secret the scanner found. A site whose files are served as they are has no private place for a
 * key ("move it to an environment variable" would put it in the page again): it comes out, and a paid or private API
 * goes through a small server function.
 */
export function secretAdvice(cls: DeployClass): string {
  return STATIC_CLASSES.has(cls)
    ? "A website's files are public: anyone can read a key in them. Take each one out, and rotate any real one (it may already have leaked). To use a paid or private API, call it through a small server function (Netlify or Cloudflare functions) that keeps the key in the host's settings."
    : 'Move each to an environment variable, and rotate any real one: it may already have leaked.'
}

/** The folder's files the checklist reads: the repository's tracked files, or a bounded walk outside git. */
export interface FolderFiles {
  /** Relative to the folder, `/` separators. */
  files: string[]
  /** Read from git: the files it tracks plus those it would add (untracked, not ignored). */
  tracked: boolean
  truncated: boolean
}

async function walk(folder: string): Promise<FolderFiles> {
  const files: string[] = []
  let truncated = false
  let level = ['']
  while (level.length > 0 && !truncated) {
    const next: string[] = []
    for (const rel of level) {
      let entries
      try {
        entries = await readdir(join(folder, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (!PRUNE.has(e.name)) next.push(r)
        } else if (e.isFile()) {
          if (files.length >= CHECK_FILES_MAX) {
            truncated = true
            break
          }
          files.push(r)
        }
      }
      if (truncated) break
    }
    level = next
  }
  return { files: files.sort(), tracked: false, truncated }
}

/** The files to check: `git ls-files` in a repository (the folder's part of it), else a walk. */
export async function folderFiles(folder: string): Promise<FolderFiles> {
  const repo = await detectRepo(folder).catch(() => null)
  if (repo?.isRepo === true && repo.dubiousOwnership !== true) {
    try {
      // What git tracks, plus what it would add (untracked and not ignored): what a commit could carry.
      const r = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: folder,
        noOptionalLocks: true,
        timeoutMs: 30_000,
        category: 'git_state',
      })
      const all = [...new Set(splitNul(r.stdout).map((p) => p.replace(/\\/g, '/')))]
      return {
        files: all.slice(0, CHECK_FILES_MAX).sort(),
        tracked: true,
        truncated: all.length > CHECK_FILES_MAX,
      }
    } catch {
      // Fall through: a walk still checks the files.
    }
  }
  return walk(folder)
}

// ---- pure parts ----------------------------------------------------------------------------------------------------

const ENV_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /env::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /ENV(?:\.fetch\(\s*|\[\s*)['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
]

/** Names every runtime sets itself (or a build tool injects): not something to list in .env.example. */
const RUNTIME_ENV = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'CI',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'SHELL',
  'USER',
  'USERNAME',
  'LANG',
  'TZ',
])

/** The environment variable names a source file reads (pure). */
export function envReadsIn(text: string): string[] {
  const out = new Set<string>()
  for (const re of ENV_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const n = m[1]
      if (n !== undefined && !RUNTIME_ENV.has(n)) out.add(n)
    }
  }
  return [...out].sort()
}

/** The keys an .env.example lists (`KEY=…`, `export KEY=…`; comments and blank lines skipped). */
export function exampleKeys(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
    if (m?.[1] !== undefined) out.add(m[1])
  }
  return [...out].sort()
}

/** Example env files (their values are placeholders by convention). */
export function isEnvExample(path: string): boolean {
  return /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults)$/i.test(path)
}

/** A real env file (`.env`, `.env.local`, `.env.production`, …), not an example. */
export function isEnvFile(path: string): boolean {
  return /(?:^|\/)\.env(?:\.[^/]+)?$/i.test(path) && !isEnvExample(path)
}

/** A licence file at the folder's root. */
export function licenceFile(files: readonly string[]): string | undefined {
  return files.find((f) => !f.includes('/') && /^(?:licen[cs]e|copying|unlicense)(?:[.-][\w.]+)?$/i.test(f))
}

/** The third-party licences a template copied with bundled libraries (`lib/LICENSES/<name>`), sorted. */
export function vendoredLicences(files: readonly string[]): string[] {
  return files.filter((f) => /^lib\/LICEN[CS]ES\/[^/]+$/i.test(f)).sort()
}

/** "lib/LICENSES holds 2 third-party licences." (empty for none). */
export function vendoredLicencesText(n: number): string {
  return n === 0
    ? ''
    : ` lib/LICENSES holds ${n === 1 ? 'one third-party licence' : `${n} third-party licences`}.`
}

/** A secret hit as one evidence line (masked: never the value). */
export function secretLine(h: SecretHit): string {
  return `${h.file}:${h.line} ${h.label} (${h.masked})`
}

/** The manual items for a class, in order (Dim Factory cannot check these). */
export function manualItems(cls: DeployClass): { id: string; label: string; detail: string }[] {
  const web = cls !== 'package' && cls !== 'desktop-installer' && cls !== 'mobile-app'
  const backend = cls === 'server-app' || cls === 'container' || cls === 'serverless'
  const out: { id: string; label: string; detail: string }[] = []
  if (web)
    out.push({
      id: 'https',
      label: 'Served over HTTPS',
      detail: 'Every page and API call uses HTTPS, and plain HTTP redirects to it.',
    })
  if (backend)
    out.push({
      id: 'admin-auth',
      label: 'Admin routes need sign-in',
      detail: 'Admin pages, debug endpoints and internal APIs are not reachable without signing in.',
    })
  if (web)
    out.push({
      id: 'error-pages',
      label: 'Error pages',
      detail: 'Not-found and server-error pages say something useful and leak no stack traces.',
    })
  if (backend || cls === 'mobile-app' || cls === 'desktop-installer')
    out.push({
      id: 'logging',
      label: 'Logging and error reports',
      detail:
        'Errors are logged somewhere you will look, without passwords, tokens or personal data in them.',
    })
  if (backend)
    out.push({
      id: 'backups',
      label: 'Backups',
      detail: 'Stored data is backed up, and you have tried restoring a backup once.',
    })
  if (cls === 'package')
    out.push({
      id: 'package-contents',
      label: 'Only the intended files are published',
      detail: 'The package holds no tests data, local config or secrets (check the dry-run list).',
    })
  if (cls === 'desktop-installer' || cls === 'mobile-app')
    out.push({
      id: 'signing',
      label: 'Builds are signed',
      detail: 'Installers and app bundles are code-signed, with the signing keys kept out of the repository.',
    })
  if (cls !== 'package')
    out.push({
      id: 'privacy',
      label: 'Privacy policy if you collect data',
      detail:
        'If it collects personal data (accounts, analytics, contact forms), a privacy policy says what and why.',
    })
  return out
}

// ---- the checklist -------------------------------------------------------------------------------------------------

export interface ChecklistResult {
  items: DeployCheckItem[]
  env: DeployEnvVar[]
  notes: string[]
}

/** A text file's content within the per-file and total budgets (undefined: too large, binary or unreadable). */
export async function readSmall(path: string, budget: { left: number }): Promise<string | undefined> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > CHECK_FILE_MAX_BYTES || st.size > budget.left) return undefined
    budget.left -= st.size
    const buf = await readFile(path)
    if (buf.subarray(0, 8000).includes(0)) return undefined
    const text = buf.toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return undefined
  }
}

/** The most dependencies whose licence is read from node_modules. */
export const INSTALLED_LICENCES_MAX = 100

/** A dependency package.json names, as node_modules holds it (version and licence null: not installed, or unread). */
export interface InstalledLicence {
  name: string
  version: string | null
  license: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** A package.json's licence: the SPDX string, or the old `{ type }` form. */
function licenceOf(pkg: Record<string, unknown>): string | null {
  const l = pkg['license']
  if (typeof l === 'object' && l !== null) return str((l as Record<string, unknown>)['type'])
  return str(l)
}

/**
 * The licences of the packages the project installs to run (package.json `dependencies`, which ship with it; a game's
 * three.js among them), each read from its own node_modules/<name>/package.json. Sorted by name; at most
 * INSTALLED_LICENCES_MAX. Never throws.
 */
export async function installedLicences(folder: string): Promise<InstalledLicence[]> {
  const budget = { left: CHECK_FILE_MAX_BYTES * 4 }
  let deps: string[]
  try {
    const pkg = JSON.parse((await readSmall(join(folder, 'package.json'), budget)) ?? 'null') as unknown
    const d =
      typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>)['dependencies'] : null
    deps =
      typeof d === 'object' && d !== null
        ? Object.keys(d)
            .filter((n) => NPM_PACKAGE_PATTERN.test(n))
            .sort()
        : []
  } catch {
    return []
  }
  const out: InstalledLicence[] = []
  for (const name of deps.slice(0, INSTALLED_LICENCES_MAX)) {
    const text = await readSmall(join(folder, 'node_modules', ...name.split('/'), 'package.json'), {
      left: CHECK_FILE_MAX_BYTES,
    })
    let pkg: Record<string, unknown> | null = null
    try {
      const v = JSON.parse(text ?? 'null') as unknown
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) pkg = v as Record<string, unknown>
    } catch {
      pkg = null
    }
    out.push({
      name,
      version: pkg !== null ? str(pkg['version']) : null,
      license: pkg !== null ? licenceOf(pkg) : null,
    })
  }
  return out
}

/** One installed package as an evidence line: "three 0.186.1: MIT (node_modules/three/package.json)". */
export function installedLicenceLine(i: InstalledLicence): string {
  if (i.version === null) return `${i.name}: not installed yet (npm install), so its licence was not read`
  return `${i.name} ${i.version}: ${i.license ?? 'no licence named'} (node_modules/${i.name}/package.json)`
}

/** " It installs 2 packages to run; their licences are listed." (empty for none). */
export function installedLicencesText(n: number): string {
  return n === 0
    ? ''
    : ` It installs ${n === 1 ? 'one package' : `${n} packages`} to run, with ${n === 1 ? 'its licence' : 'their licences'} in node_modules.`
}

/** Run the checks over `folder`. `ticks`: the manual items the user ticked for this folder (id → when). */
export async function runChecklist(
  folder: string,
  cls: DeployClass,
  ticks: Readonly<Record<string, number>> = {},
  o: { files?: FolderFiles } = {},
): Promise<ChecklistResult> {
  const listing = o.files ?? (await folderFiles(folder))
  const notes: string[] = []
  if (listing.truncated)
    notes.push(
      `The folder has more than ${CHECK_FILES_MAX} files; the checks read the first ${CHECK_FILES_MAX}.`,
    )
  const budget = { left: CHECK_TOTAL_MAX_BYTES }
  let hits: SecretHit[] = []
  const reads = new Map<string, Set<string>>()
  const exampleFiles: string[] = []
  let skipped = 0
  for (const rel of listing.files) {
    if (BINARY_EXT.test(rel)) continue
    if (isEnvExample(rel)) exampleFiles.push(rel)
    const text = await readSmall(join(folder, ...rel.split('/')), budget)
    if (text === undefined) {
      skipped += 1
      continue
    }
    // A real .env file is reported on its own (committed at all is the problem); its values are not read out.
    if (!isEnvFile(rel)) for (const h of scanTextForSecrets(rel, text)) hits.push(h)
    if (SOURCE_EXT.test(rel)) {
      for (const name of envReadsIn(text)) {
        const set = reads.get(name) ?? new Set<string>()
        if (set.size < 3) set.add(rel)
        reads.set(name, set)
      }
    }
  }
  if (budget.left <= 0) notes.push('The folder is large; the checks stopped reading after 48 MB.')
  if (skipped > 0)
    notes.push(
      `${skipped} file${skipped === 1 ? ' was' : 's were'} not read (too large, binary or unreadable).`,
    )

  const listed = new Set<string>()
  for (const f of exampleFiles) {
    const text = await readSmall(join(folder, ...f.split('/')), { left: CHECK_FILE_MAX_BYTES })
    for (const k of exampleKeys(text ?? '')) listed.add(k)
  }
  const env: DeployEnvVar[] = [...reads.entries()]
    .map(([name, files]) => ({
      name,
      files: [...files].sort(),
      inExample: listed.has(name),
      ...(isPublicEnvName(name) ? { public: true as const } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const items: DeployCheckItem[] = []
  const where = listing.tracked
    ? 'the files git tracks or would add'
    : "the folder's files (not a git repository)"
  // Keys a page may hold when restricted (a Google browser key) are their own item; every other hit is a secret.
  const restrictable = hits.filter(isRestrictableKey)
  hits = hits.filter((h) => !isRestrictableKey(h))
  // Secrets.
  if (hits.length === 0) {
    items.push({
      id: 'secrets',
      label: SECRETS_LABEL,
      state: 'ok',
      auto: true,
      detail: `The secret scanner found no key, token or password in ${where}.`,
    })
  } else {
    items.push({
      id: 'secrets',
      label: SECRETS_LABEL,
      state: 'problem',
      auto: true,
      detail: `The secret scanner found ${hits.length === 1 ? 'a possible secret' : `${hits.length} possible secrets`} in ${where}. ${secretAdvice(cls)}`,
      evidence: hits.slice(0, 20).map(secretLine),
    })
  }
  if (restrictable.length > 0) {
    items.push({
      id: 'public-keys',
      label: 'Browser keys restricted',
      state: 'warn',
      auto: true,
      detail: `${restrictable.length === 1 ? 'A key' : `${restrictable.length} keys`} in ${where} can be read by anyone who opens the page. ${RESTRICT_KEY_ADVICE}`,
      evidence: restrictable.slice(0, 20).map(secretLine),
    })
  }
  // A real .env in the files.
  const envFiles = listing.files.filter(isEnvFile)
  if (envFiles.length > 0 && listing.tracked) {
    items.push({
      id: 'env-file',
      label: '.env files not committed',
      state: 'problem',
      auto: true,
      detail:
        'git tracks an environment file, or would add one (it is not ignored). Add it to .gitignore, remove it from git if it is tracked (git rm --cached), and rotate what it held.',
      evidence: envFiles.slice(0, 10),
    })
  } else if (envFiles.length > 0) {
    items.push({
      id: 'env-file',
      label: '.env files not committed',
      state: 'warn',
      auto: true,
      detail:
        'The folder has an environment file and is not a git repository, so nothing keeps it out of an upload. Keep it out of what you deploy or publish.',
      evidence: envFiles.slice(0, 10),
    })
  } else {
    items.push({
      id: 'env-file',
      label: '.env files not committed',
      state: 'ok',
      auto: true,
      detail: listing.tracked
        ? 'git tracks no .env file and would add none.'
        : 'The folder has no .env file.',
    })
  }
  // Environment variables.
  const missing = env.filter((v) => !v.inExample)
  if (env.length === 0) {
    items.push({
      id: 'env-vars',
      label: 'Environment variables listed',
      state: 'ok',
      auto: true,
      detail: 'The code reads no environment variables Dim Factory could find.',
    })
  } else if (missing.length === 0) {
    items.push({
      id: 'env-vars',
      label: 'Environment variables listed',
      state: 'ok',
      auto: true,
      detail: `.env.example lists every variable the code reads (${env.length}).`,
      evidence: env.map((v) => v.name),
    })
  } else {
    items.push({
      id: 'env-vars',
      label: 'Environment variables listed',
      state: 'warn',
      auto: true,
      detail:
        exampleFiles.length === 0
          ? `The code reads ${env.length === 1 ? 'a variable' : `${env.length} variables`} and there is no .env.example to list ${env.length === 1 ? 'it' : 'them'}. Set each where you deploy.`
          : `.env.example leaves out ${missing.length === 1 ? 'a variable' : `${missing.length} variables`} the code reads.`,
      evidence: missing.map((v) => `${v.name} (${v.files.join(', ')})`),
    })
  }
  // Variables the build puts into the page are public: never a secret in one.
  const visible = env.filter((v) => v.public === true)
  if (visible.length > 0) {
    const secretLooking = visible.filter((v) => looksSecretName(v.name))
    items.push({
      id: 'env-public',
      label: 'Browser-visible variables hold no secrets',
      state: secretLooking.length > 0 ? 'problem' : 'warn',
      auto: true,
      detail:
        secretLooking.length > 0
          ? `The build puts ${visible.length === 1 ? 'this variable' : 'these variables'} into the page, so anyone can read ${visible.length === 1 ? 'its value' : 'their values'}, and ${secretLooking.length === 1 ? 'one is named like a secret' : `${secretLooking.length} are named like secrets`}. Never put a secret key in one: call a paid or private API through a small server function (Netlify or Cloudflare functions) that keeps the key in the host's settings.`
          : `The build puts ${visible.length === 1 ? 'this variable' : 'these variables'} into the page, so anyone can read ${visible.length === 1 ? 'its value' : 'their values'}. That is fine for a public address or a key that is public by design and restricted; never put a secret key in one.`,
      evidence: visible.map(
        (v) =>
          `${v.name} (public: built into the page${looksSecretName(v.name) ? '; named like a secret' : ''})`,
      ),
    })
  }
  // Licence.
  // Licence: the project's own at the root, and the third-party ones bundled libraries brought (lib/LICENSES).
  const lic = licenceFile(listing.files)
  // Packages installed from npm (never bundled) bring theirs in node_modules: each is named with its licence.
  const bundled = vendoredLicences(listing.files)
  const installed = await installedLicences(folder)
  const also = vendoredLicencesText(bundled.length) + installedLicencesText(installed.length)
  const lines = [...bundled, ...installed.map(installedLicenceLine)]
  const evidence = lines.length > 0 ? { evidence: lines } : {}
  items.push(
    lic !== undefined
      ? {
          id: 'license',
          label: 'Licence file',
          state: 'ok',
          auto: true,
          detail: `${lic} is at the root.${also}`,
          ...evidence,
        }
      : {
          id: 'license',
          label: 'Licence file',
          state: 'warn',
          auto: true,
          detail:
            (cls === 'package'
              ? 'No licence file: without one, others may not legally use the package. Add one before publishing.'
              : 'No licence file at the root. Add one if others may use or copy the code.') + also,
          ...evidence,
        },
  )
  for (const m of manualItems(cls)) {
    const at = ticks[m.id]
    items.push({
      id: m.id,
      label: m.label,
      state: 'not-checked',
      auto: false,
      detail: m.detail,
      ...(at !== undefined ? { tickedAt: at } : {}),
    })
  }
  return { items, env, notes }
}
