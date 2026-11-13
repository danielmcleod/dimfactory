// The Deploy helper's options and copyable steps, from the packs' deploy targets (data). Placeholders in a step's
// command (`{name}`, `{dir}`, `{branch}`, `{port}`, `{version}`) are filled from the folder, each value checked against
// a plain character set (a value that is not plain falls back to a safe default), so a copied command never carries
// anything a folder's files could smuggle in. Pure: nothing here runs a command; the steps are only ever copied.
import type { Pack } from '../../shared/brief.ts'
import { DEPLOY_CONFIG_PATH, DEPLOY_CONFIG_PURPOSE } from '../../shared/deploy.ts'
import type {
  DeployClass,
  DeployConfigKind,
  DeployOptionView,
  DeployPlaceholder,
  DeployStepView,
  PackDeployTarget,
} from '../../shared/deploy.ts'
import type { ShellKind } from '../../shared/failure.ts'
import type { DeploySignals } from './signals.ts'

export type PlaceholderValues = Readonly<Record<DeployPlaceholder, string>>

/** A placeholder value must be plain (a name, a path, a version): nothing a shell would read specially. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,99}$/
const DEFAULTS: PlaceholderValues = { name: 'app', dir: '.', branch: 'main', port: '8080', version: '0.1.0' }

/** `@scope/My App` → `my-app` (a name every provider and Docker accept). */
export function slugName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const s = raw
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '')
  return s === '' || !/^[a-z]/.test(s) ? undefined : s
}

/** Where the build writes the files a static host serves (best guess from the tools the folder uses). */
export function buildDir(s: DeploySignals, cls: DeployClass): string {
  const deps = new Set(s.pkg?.deps ?? [])
  const dirs = new Set(s.dirs)
  const py = new Set(s.python?.deps ?? [])
  if (s.files.includes('mkdocs.yml') || s.files.includes('mkdocs.yaml') || py.has('mkdocs')) return 'site'
  if (deps.has('@docusaurus/core')) return 'build'
  if (deps.has('vitepress')) return dirs.has('docs') ? 'docs/.vitepress/dist' : '.vitepress/dist'
  if (deps.has('gatsby')) return 'public'
  if (deps.has('@11ty/eleventy') || s.files.includes('_config.yml')) return '_site'
  if (s.files.includes('hugo.toml') || s.files.includes('hugo.yaml')) return 'public'
  if (deps.has('react-scripts')) return 'build'
  if (deps.has('@sveltejs/adapter-static')) return 'build'
  if (deps.has('next')) return 'out'
  if (deps.has('vite') || deps.has('astro') || deps.has('parcel') || deps.has('@angular/cli')) return 'dist'
  if (s.html && s.pkg === undefined) return '.'
  for (const d of ['dist', 'build', 'out', 'public', 'site', '_site']) if (dirs.has(d)) return d
  return cls === 'static-site' ? '.' : 'dist'
}

/** The port the app listens on (the Dockerfile's EXPOSE, else the stack's usual one). */
export function appPort(s: DeploySignals): string {
  if (s.exposePort !== undefined) return String(s.exposePort)
  if (s.pkg !== undefined) return '3000'
  if (s.python !== undefined) return '8000'
  return '8080'
}

/** The placeholder values for a folder (each plain, else its default). */
export function placeholderValues(
  s: DeploySignals,
  cls: DeployClass,
  o: { branch?: string | null } = {},
): PlaceholderValues {
  const raw: Record<DeployPlaceholder, string | undefined> = {
    name: slugName(s.pkg?.name ?? s.python?.name ?? s.rust?.name) ?? slugName(s.folderName),
    dir: buildDir(s, cls),
    branch: o.branch ?? undefined,
    port: appPort(s),
    version: s.pkg?.version ?? s.python?.version ?? s.rust?.version,
  }
  const out = { ...DEFAULTS }
  for (const k of Object.keys(raw) as DeployPlaceholder[]) {
    const v = raw[k]
    if (v !== undefined && (PLAIN.test(v) || (k === 'dir' && v === '.'))) out[k] = v
  }
  return out
}

/** Fill a command template's placeholders (an unknown one is left as written; the pack check refuses those). */
export function fillCommand(template: string, values: PlaceholderValues): string {
  return template.replace(/\{([a-z]+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(values, k) ? values[k as DeployPlaceholder] : m,
  )
}

export function shellOf(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === 'win32' ? 'powershell' : 'sh'
}

/** A target's steps as copyable views (ids `<target>:<n>`). */
export function stepViews(
  t: PackDeployTarget,
  values: PlaceholderValues,
  shell: ShellKind,
): DeployStepView[] {
  return t.steps.map((s, i) => ({
    id: `${t.id}:${i + 1}`,
    label: s.label,
    ...(s.run !== undefined ? { command: fillCommand(s.run, values) } : {}),
    shell,
    ...(s.note !== undefined ? { note: s.note } : {}),
  }))
}

/** The targets for a class: the category's pack first; the software pack's when the category has none for it. */
export function targetsFor(
  packs: readonly Pack[],
  category: string,
  cls: DeployClass,
): { pack: Pack; targets: PackDeployTarget[] } | undefined {
  const find = (id: string): { pack: Pack; targets: PackDeployTarget[] } | undefined => {
    const pack = packs.find((p) => p.id === id)
    const all = (pack?.deploy?.targets ?? []).filter((t) => t.classes.includes(cls))
    // Targets made for the class (it is their first) come before those that also serve it, in pack order.
    const targets = [...all.filter((t) => t.classes[0] === cls), ...all.filter((t) => t.classes[0] !== cls)]
    return pack !== undefined && targets.length > 0 ? { pack, targets } : undefined
  }
  return find(category) ?? (category !== 'software' ? find('software') : undefined)
}

/**
 * The recommended target: the one the run or the user named (when it serves the class), else the brief's hosting
 * choice, else the pack's first for the class.
 */
export function recommendedTarget(
  targets: readonly PackDeployTarget[],
  o: { chosen?: string | null; hosting?: readonly string[] } = {},
): PackDeployTarget | undefined {
  if (o.chosen !== undefined && o.chosen !== null) {
    const t = targets.find((x) => x.id === o.chosen)
    if (t !== undefined) return t
  }
  for (const h of o.hosting ?? []) {
    const t = targets.find((x) => (x.hosting ?? []).includes(h))
    if (t !== undefined) return t
  }
  return targets[0]
}

/**
 * A single-page app's routing on each host: a link to an inner page (`/about`) must open the app, whose own router then
 * shows the page. What each host needs, as one more step (the web starter ships the first two files).
 */
export const SPA_ROUTING_STEP: Readonly<Record<string, string>> = {
  netlify:
    'Inner pages: public/_redirects (/* /index.html 200) sends every address to the app. Keep it: the build copies it into the folder you deploy.',
  'cloudflare-pages':
    'Inner pages: public/_redirects (/* /index.html 200) sends every address to the app; Cloudflare Pages reads it too. Keep it: the build copies it into the folder you deploy.',
  'github-pages':
    "Inner pages: the build copies index.html to 404.html, which GitHub Pages shows for an address it does not know, so the app opens there. For a project site (user.github.io/name/), set base: '/name/' in vite.config.ts first.",
  vercel:
    'Inner pages: add a vercel.json with a rewrite of every path to /index.html (rewrites: [{ source: "/(.*)", destination: "/index.html" }]).',
}

/** A target's steps for a class, with the single-page routing step for a single-page app on a host that needs one. */
export function classSteps(
  t: PackDeployTarget,
  cls: DeployClass | undefined,
  values: PlaceholderValues,
  shell: ShellKind,
): DeployStepView[] {
  const steps = stepViews(t, values, shell)
  const spa = cls === 'spa' ? SPA_ROUTING_STEP[t.id] : undefined
  if (spa === undefined) return steps
  return [...steps, { id: `${t.id}:spa`, label: 'Make links to inner pages work', shell, note: spa }]
}

/** The option views for a class, recommended one marked. `present`: config paths already in the folder. */
export function optionViews(o: {
  pack: Pack
  targets: readonly PackDeployTarget[]
  recommended: string | undefined
  values: PlaceholderValues
  shell: ShellKind
  present: ReadonlySet<string>
  /** The class the options are for (a single-page app gets each host's routing step). */
  cls?: DeployClass
}): DeployOptionView[] {
  return o.targets.map((t) => ({
    id: t.id,
    label: t.label,
    packId: o.pack.id,
    freeTier: t.freeTier,
    cost: t.cost,
    coldStarts: t.coldStarts,
    customDomains: t.customDomains,
    dataResidency: t.dataResidency,
    configs: t.configs.map((kind) => configView(kind, o.present)),
    ...(t.needs !== undefined ? { needs: t.needs } : {}),
    steps: classSteps(t, o.cls, o.values, o.shell),
    recommended: t.id === o.recommended,
  }))
}

export function configView(
  kind: DeployConfigKind,
  present: ReadonlySet<string>,
): { kind: DeployConfigKind; path: string; purpose: string; present: boolean } {
  const path = DEPLOY_CONFIG_PATH[kind]
  return { kind, path, purpose: DEPLOY_CONFIG_PURPOSE[kind], present: present.has(path) }
}
