// Classify a folder's deliverable for the Deploy helper, with local heuristics only (no tokens): the brief's choices
// first (the user said what it is), then what the folder shows (manifests, dependencies, the config files of the
// usual hosts and doc tools), then words in the task text, else a low-confidence default. Pure: it reads the signals
// signals.ts gathered, so the corpus of folders is unit-tested without touching the disk.
import type { BriefInput } from '../../shared/brief.ts'
import { DEPLOY_CLASSES, DEPLOY_CLASS_LABEL } from '../../shared/deploy.ts'
import type { DeployClass, DeployClassGuess, DeployConfidence } from '../../shared/deploy.ts'
import type { DeploySignals } from './signals.ts'

interface Evidence {
  cls: DeployClass
  weight: number
  reason: string
}

/** When two classes have the same weight, the more specific one wins. */
const TIE_ORDER: readonly DeployClass[] = [
  'mobile-app',
  'desktop-installer',
  'docs-site',
  'serverless',
  'container',
  'server-app',
  'package',
  'spa',
  'static-site',
]

/** The brief's options that say what the deliverable is, per pack and group (strongest group first). */
const BRIEF_MAP: Readonly<
  Record<string, readonly { group: string; options: Record<string, DeployClass> }[]>
> = {
  software: [
    {
      group: 'deliverable',
      options: {
        'static-html': 'static-site',
        'spa-bundle': 'spa',
        pwa: 'spa',
        'server-app': 'server-app',
        'docker-image': 'container',
        package: 'package',
        executable: 'desktop-installer',
      },
    },
    {
      group: 'projectType',
      options: {
        spa: 'spa',
        'multi-page': 'static-site',
        'static-site': 'static-site',
        'full-stack': 'server-app',
        api: 'server-app',
        cli: 'package',
        library: 'package',
        desktop: 'desktop-installer',
        mobile: 'mobile-app',
      },
    },
    { group: 'platform', options: { ios: 'mobile-app', android: 'mobile-app' } },
    { group: 'hosting', options: { container: 'container', 'app-stores': 'mobile-app' } },
  ],
  documents: [{ group: 'format', options: { 'html-site': 'docs-site' } }],
  data: [{ group: 'outputs', options: { dashboard: 'server-app', 'html-report': 'static-site' } }],
  design: [{ group: 'output', options: { 'html-css': 'static-site', components: 'spa' } }],
  // A light web game is a static site: its page and files, served as they are (a Vite build makes a single-page app).
  games: [
    {
      group: 'deliverable',
      options: { 'single-page': 'static-site', 'itch-zip': 'static-site', 'installable-app': 'spa' },
    },
    { group: 'engine', options: { canvas: 'static-site', dom: 'static-site', 'vite-ts': 'spa' } },
  ],
}

/** Words in the task text that point at a class (whole words, any case). Weak: a hint, never more. */
const TASK_WORDS: readonly [RegExp, DeployClass][] = [
  [/\b(?:mobile app|ios app|android app|react native|flutter|expo)\b/i, 'mobile-app'],
  [/\b(?:desktop app|electron|tauri|installer)\b/i, 'desktop-installer'],
  [/\b(?:docs site|documentation site|mkdocs|docusaurus|vitepress)\b/i, 'docs-site'],
  [/\b(?:serverless|lambda|cloudflare workers?|edge functions?)\b/i, 'serverless'],
  [/\b(?:docker(?:file|ize)?|container image|kubernetes)\b/i, 'container'],
  [/\b(?:npm package|pypi|python package|library|sdk|crate)\b/i, 'package'],
  [/\b(?:api|backend|web server|rest service|full-stack|full stack)\b/i, 'server-app'],
  [/\b(?:single-page app|spa|react app|vue app|svelte app)\b/i, 'spa'],
  [/\b(?:static site|landing page|portfolio site|html page)\b/i, 'static-site'],
]

const NODE_SERVER: readonly [string, number][] = [
  ['express', 3],
  ['fastify', 3],
  ['koa', 3],
  ['@nestjs/core', 3],
  ['@hapi/hapi', 3],
  ['next', 3],
  ['nuxt', 3],
  ['@remix-run/node', 3],
  ['@remix-run/serve', 3],
  ['@astrojs/node', 3],
  ['hono', 2],
  ['@sveltejs/kit', 2],
]
const PY_SERVER: readonly string[] = [
  'fastapi',
  'flask',
  'django',
  'uvicorn',
  'gunicorn',
  'starlette',
  'aiohttp',
  'streamlit',
  'dash',
  'gradio',
]
const RUST_SERVER: readonly string[] = ['actix-web', 'axum', 'rocket', 'warp', 'poem']
const GO_SERVER: readonly string[] = [
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'github.com/go-chi/chi',
  'github.com/gorilla/mux',
]
const UI_FRAMEWORKS: readonly string[] = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js',
  '@angular/core',
  'preact',
  'lit',
]
const BUNDLERS: readonly string[] = ['vite', 'webpack', 'parcel', 'react-scripts', '@angular/cli', 'rollup']
const STATIC_GENERATORS: readonly [string, string][] = [
  ['gatsby', 'Gatsby builds static pages'],
  ['@11ty/eleventy', 'Eleventy builds static pages'],
  ['@sveltejs/adapter-static', 'SvelteKit uses the static adapter'],
  ['astro', 'Astro builds static pages by default'],
]
const DOC_DEPS: readonly [string, string][] = [
  ['@docusaurus/core', 'package.json depends on Docusaurus'],
  ['vitepress', 'package.json depends on VitePress'],
  ['vuepress', 'package.json depends on VuePress'],
  ['@astrojs/starlight', 'package.json depends on Starlight'],
]
const MOBILE_DEPS: readonly string[] = [
  'react-native',
  'expo',
  '@capacitor/core',
  '@ionic/react',
  '@ionic/angular',
]
const DESKTOP_DEPS: readonly string[] = ['electron', '@tauri-apps/cli', '@tauri-apps/api', 'electron-builder']

export interface ClassifyHints {
  /** The brief's category and fields (what the user chose). */
  brief?: BriefInput | null
  /** The task text (weak hints only). */
  task?: string
}

/** The folder's evidence for each class (pure). */
export function folderEvidence(s: DeploySignals): Evidence[] {
  const out: Evidence[] = []
  const add = (cls: DeployClass, weight: number, reason: string): void => {
    out.push({ cls, weight, reason })
  }
  const lower = new Set(s.files.map((f) => f.toLowerCase()))
  const dirs = new Set(s.dirs.map((d) => d.toLowerCase()))
  const has = (f: string): boolean => lower.has(f.toLowerCase())
  const hasAny = (...fs: string[]): string | undefined => fs.find(has)
  const deps = new Set(s.pkg?.deps ?? [])
  const dep = (n: string): boolean => deps.has(n)
  const py = new Set(s.python?.deps ?? [])

  // Mobile.
  for (const d of MOBILE_DEPS) if (dep(d)) add('mobile-app', 3, `package.json depends on ${d}`)
  if (s.expo) add('mobile-app', 3, 'app.json configures Expo')
  if (has('pubspec.yaml')) add('mobile-app', 3, 'pubspec.yaml (a Flutter app)')
  if (dirs.has('android') && dirs.has('ios')) add('mobile-app', 2, 'android/ and ios/ folders')
  if (s.dirs.some((d) => d.toLowerCase().endsWith('.xcodeproj'))) add('mobile-app', 2, 'an Xcode project')
  if (hasAny('capacitor.config.ts', 'capacitor.config.json')) add('mobile-app', 3, 'a Capacitor config')

  // Desktop.
  for (const d of DESKTOP_DEPS) if (dep(d)) add('desktop-installer', 3, `package.json depends on ${d}`)
  if (dirs.has('src-tauri')) add('desktop-installer', 3, 'a src-tauri folder (a Tauri app)')
  const builderCfg = hasAny(
    'electron-builder.yml',
    'electron-builder.json',
    'forge.config.js',
    'forge.config.ts',
  )
  if (builderCfg !== undefined) add('desktop-installer', 3, `${builderCfg} packages a desktop app`)
  if (py.has('pyinstaller') || py.has('briefcase')) add('desktop-installer', 2, 'a Python app packager')

  // Docs sites.
  const docsCfg = hasAny(
    'mkdocs.yml',
    'mkdocs.yaml',
    'docusaurus.config.js',
    'docusaurus.config.ts',
    'docusaurus.config.mjs',
    'book.toml',
    'antora.yml',
    'hugo.toml',
    'hugo.yaml',
  )
  if (docsCfg !== undefined) add('docs-site', 3, `${docsCfg} configures a documentation site`)
  if (dirs.has('.vitepress')) add('docs-site', 3, 'a .vitepress folder')
  if (has('conf.py') && (has('index.rst') || has('index.md'))) add('docs-site', 3, 'a Sphinx conf.py')
  for (const [d, why] of DOC_DEPS) if (dep(d)) add('docs-site', 3, why)
  if (py.has('mkdocs') || py.has('mkdocs-material') || py.has('sphinx'))
    add('docs-site', 3, 'a Python docs tool')
  if (has('_config.yml') && (dirs.has('_posts') || dirs.has('_layouts') || has('Gemfile')))
    add('docs-site', 2, '_config.yml (a Jekyll site)')

  // Serverless.
  const slsCfg = hasAny('serverless.yml', 'serverless.yaml', 'serverless.ts')
  if (slsCfg !== undefined) add('serverless', 3, `${slsCfg} (the Serverless Framework)`)
  const wrangler = hasAny('wrangler.toml', 'wrangler.json', 'wrangler.jsonc')
  if (wrangler !== undefined) add('serverless', 3, `${wrangler} (Cloudflare Workers)`)
  if (has('template.yaml') && has('samconfig.toml')) add('serverless', 3, 'an AWS SAM template')
  if (s.netlifyFunctions) add('serverless', 2, 'a netlify/functions folder')

  // Containers.
  if (has('Dockerfile')) add('container', 3, 'a Dockerfile')
  const compose = hasAny('compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml')
  if (compose !== undefined) add('container', 2, `${compose} runs it with Docker`)

  // Server apps.
  let server = false
  for (const [d, w] of NODE_SERVER) {
    if (!dep(d)) continue
    // Hono on Workers is serverless; SvelteKit with the static adapter is a static site.
    if (d === 'hono' && wrangler !== undefined) continue
    if (d === '@sveltejs/kit' && dep('@sveltejs/adapter-static')) continue
    add('server-app', w, `package.json depends on ${d}`)
    server = true
  }
  for (const d of PY_SERVER) {
    if (!py.has(d)) continue
    add('server-app', 3, `the Python project uses ${d}`)
    server = true
  }
  if (has('manage.py')) {
    add('server-app', 3, 'manage.py (a Django project)')
    server = true
  }
  for (const d of RUST_SERVER) {
    if (!(s.rust?.deps ?? []).includes(d)) continue
    add('server-app', 3, `Cargo.toml depends on ${d}`)
    server = true
  }
  for (const d of GO_SERVER) {
    if (!(s.go?.deps ?? []).some((x) => x.startsWith(d))) continue
    add('server-app', 3, `go.mod requires ${d}`)
    server = true
  }
  if (s.go?.main === true && !server) add('server-app', 1, 'a Go program')
  if (hasAny('config.ru') !== undefined) {
    add('server-app', 3, 'config.ru (a Rack app)')
    server = true
  }
  if (has('Procfile')) add('server-app', 2, 'a Procfile')
  if (has('composer.json') || has('index.php')) add('server-app', 2, 'a PHP project')
  if (s.apiFunctions && !server) add('serverless', 2, 'source files in api/ (serverless functions)')

  // Packages.
  const pkg = s.pkg
  const runs =
    pkg !== undefined && ['dev', 'start', 'preview', 'serve'].some((k) => pkg.scripts[k] !== undefined)
  if (pkg !== undefined && !pkg.private && (pkg.library || pkg.bin) && !server && !runs)
    add('package', 3, `package.json describes a ${pkg.bin ? 'command-line tool' : 'library'} to publish`)
  if (s.python?.buildSystem === true && !server)
    add('package', s.python.scripts ? 3 : 2, 'pyproject.toml builds a Python package')
  if (s.rust !== undefined && !server)
    add('package', s.rust.lib && !s.rust.bin ? 3 : 2, s.rust.lib ? 'a Rust library crate' : 'a Rust program')

  // Single-page apps and static sites.
  const ui = UI_FRAMEWORKS.filter((d) => dep(d))
  const bundler = BUNDLERS.find((d) => dep(d))
  let generator = false
  for (const [d, why] of STATIC_GENERATORS) {
    if (!dep(d) || (d === 'astro' && dep('@astrojs/node'))) continue
    add('static-site', 3, why)
    generator = true
  }
  if (ui.length > 0 && !server && !generator)
    add(
      'spa',
      bundler !== undefined ? 3 : 2,
      `${ui[0] ?? 'a UI framework'}${bundler !== undefined ? ` built with ${bundler}` : ''}`,
    )
  if (s.html && pkg === undefined) add('static-site', 3, 'index.html with no build step')
  else if (s.html && ui.length === 0 && !server) add('static-site', 2, 'an index.html page')
  return out
}

/** The brief's evidence: the first mapped choice, strongest group first. */
export function briefEvidence(brief: BriefInput | null | undefined): Evidence | undefined {
  if (brief === null || brief === undefined) return undefined
  for (const m of BRIEF_MAP[brief.category] ?? []) {
    const field = brief.fields[m.group]
    for (const choice of field?.choices ?? []) {
      const cls = m.options[choice]
      if (cls !== undefined) return { cls, weight: 4, reason: `The brief chooses ${choice} (${m.group})` }
    }
  }
  return undefined
}

function taskEvidence(task: string | undefined): Evidence | undefined {
  if (task === undefined || task.trim() === '') return undefined
  for (const [re, cls] of TASK_WORDS) {
    const m = re.exec(task)
    if (m !== null) return { cls, weight: 1, reason: `The task mentions "${m[0]}"` }
  }
  return undefined
}

/** Sum the weights per class; the best class first (ties by TIE_ORDER). */
function rank(evidence: readonly Evidence[]): { cls: DeployClass; weight: number; reasons: string[] }[] {
  const by = new Map<DeployClass, { weight: number; reasons: string[] }>()
  for (const e of evidence) {
    const cur = by.get(e.cls) ?? { weight: 0, reasons: [] }
    // The strongest single sign counts fully; more signs add a little (several weak signs never beat a strong one).
    cur.weight = Math.max(cur.weight, e.weight) + (cur.reasons.length > 0 ? 0.1 : 0)
    if (!cur.reasons.includes(e.reason)) cur.reasons.push(e.reason)
    by.set(e.cls, cur)
  }
  return [...by.entries()]
    .map(([cls, v]) => ({ cls, ...v }))
    .sort((a, b) => b.weight - a.weight || TIE_ORDER.indexOf(a.cls) - TIE_ORDER.indexOf(b.cls))
}

function confidenceOf(weight: number): DeployConfidence {
  if (weight >= 3) return 'high'
  if (weight >= 2) return 'medium'
  return 'low'
}

/** The deliverable's class (pure). `override`: the user picked it. */
export function classifyDeploy(
  signals: DeploySignals,
  hints: ClassifyHints = {},
  override?: DeployClass,
): DeployClassGuess {
  const ranked = rank(folderEvidence(signals))
  const alternativesOf = (cls: DeployClass): DeployClass[] =>
    ranked
      .map((r) => r.cls)
      .filter((c) => c !== cls)
      .slice(0, 3)
  if (override !== undefined) {
    return {
      id: override,
      label: DEPLOY_CLASS_LABEL[override],
      source: 'user',
      confidence: 'high',
      reasons: ['You chose it'],
      alternatives: alternativesOf(override),
    }
  }
  const brief = briefEvidence(hints.brief)
  if (brief !== undefined) {
    const agree = ranked.find((r) => r.cls === brief.cls)
    return {
      id: brief.cls,
      label: DEPLOY_CLASS_LABEL[brief.cls],
      source: 'brief',
      confidence: 'high',
      reasons: [brief.reason, ...(agree?.reasons ?? []).slice(0, 2)],
      alternatives: alternativesOf(brief.cls),
    }
  }
  const best = ranked[0]
  if (best !== undefined && best.weight >= 2) {
    return {
      id: best.cls,
      label: DEPLOY_CLASS_LABEL[best.cls],
      source: 'folder',
      confidence: confidenceOf(best.weight),
      reasons: best.reasons.slice(0, 4),
      alternatives: alternativesOf(best.cls),
    }
  }
  const task = taskEvidence(hints.task)
  if (task !== undefined) {
    return {
      id: task.cls,
      label: DEPLOY_CLASS_LABEL[task.cls],
      source: 'task',
      confidence: 'low',
      reasons: [task.reason, ...(best?.reasons ?? []).slice(0, 1)],
      alternatives: alternativesOf(task.cls),
    }
  }
  if (best !== undefined) {
    return {
      id: best.cls,
      label: DEPLOY_CLASS_LABEL[best.cls],
      source: 'folder',
      confidence: 'low',
      reasons: best.reasons.slice(0, 4),
      alternatives: alternativesOf(best.cls),
    }
  }
  return {
    id: 'static-site',
    label: DEPLOY_CLASS_LABEL['static-site'],
    source: 'default',
    confidence: 'low',
    reasons: [
      'Nothing in the folder, the brief or the task says how it ships. Pick the class if this is wrong.',
    ],
    alternatives: [],
  }
}

/** Every class with its label (the class picker). */
export function deployClassList(): { id: DeployClass; label: string }[] {
  return DEPLOY_CLASSES.map((id) => ({ id, label: DEPLOY_CLASS_LABEL[id] }))
}
