// Project templates: what "New project" starts from. A template is data (src/core/templates/*.json, overridable per
// user): the category (a pack id) and the Brief choices it seeds, the scaffold task the normal pipeline builds, the
// recipe it suggests, and the official create command shown as a copyable step (never run by Dim Factory).
import { z } from 'zod'
import { BRIEF_ID_PATTERN, BRIEF_LABEL_MAX, BriefFieldZ } from './brief.ts'
import type { BriefInput } from './brief.ts'

/** A template id (and a recipe id): lower kebab case. */
export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const TEMPLATE_DESCRIPTION_MAX = 300
/** The scaffold task text. */
export const TEMPLATE_TASK_MAX = 4000
/** The optional "What should it do?" text appended to the task. */
export const PROJECT_GOAL_MAX = 4000
export const TEMPLATE_COMMAND_MAX = 300
export const TEMPLATE_TAGS_MAX = 10

const TemplateIdZ = z
  .string()
  .regex(TEMPLATE_ID_PATTERN, 'Not a template id (lower case letters, digits and dashes)')
const PackIdZ = z.string().regex(BRIEF_ID_PATTERN, 'Not a pack id')
const BriefGroupIdZ = z.string().regex(BRIEF_ID_PATTERN, 'Not a brief group id')

/** Where the copyable create command runs: a POSIX shell, PowerShell, or either. */
export const TEMPLATE_SHELLS = ['sh', 'powershell', 'any'] as const
export type TemplateShell = (typeof TEMPLATE_SHELLS)[number]

export const TemplateCreateZ = z.strictObject({
  /** The vendor's own scaffolding command, run by the user in the new folder if they prefer it. One line. */
  command: z
    .string()
    .trim()
    .min(1)
    .max(TEMPLATE_COMMAND_MAX)
    .regex(/^[^\0\r\n]*$/, 'The command is one line'),
  shell: z.enum(TEMPLATE_SHELLS).optional(),
  note: z.string().trim().min(1).max(200).optional(),
})
export type TemplateCreate = z.infer<typeof TemplateCreateZ>

// ---- files a template copies into the new project ------------------------------------------------------------------

/** The most files one template copies. */
export const TEMPLATE_FILES_MAX = 32
/** An id in the bundled manifest (src/core/templates/vendor/manifest.json). */
export const TEMPLATE_FILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
/** The top folders of the project a template may copy files into. */
export const TEMPLATE_FILE_ROOTS: readonly string[] = ['lib', 'src', 'docs']
/** The few files a template may put at the project's root (an online game's server, run as `node server.js`). */
export const TEMPLATE_ROOT_FILES: readonly string[] = ['server.js']
/**
 * A web starter (a template marked `webStarter`) runs as it is, so it may also write these at the project's root (its
 * manifest, page and build settings) and into public/ (files served as they are) and assets/ (the owner's pictures).
 */
export const WEB_STARTER_ROOT_FILES: readonly string[] = [
  'package.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
]
export const WEB_STARTER_FILE_ROOTS: readonly string[] = ['public', 'assets']
const TARGET_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/

/**
 * Why a template file's `to` is refused (null: it is fine). It is a relative path with forward slashes under lib/, src/
 * or docs/ (a file, not the folder itself), or one of TEMPLATE_ROOT_FILES (a web starter: also WEB_STARTER_ROOT_FILES
 * and under WEB_STARTER_FILE_ROOTS); no segment may be empty, `.`, `..`, hidden or hold a drive colon, a backslash or a
 * NUL, so the file always lands inside the project.
 */
export function templateTargetProblem(to: string, o: { web?: boolean } = {}): string | null {
  if (to.length === 0 || to.length > 200) return 'The target path is empty or too long.'
  if (TEMPLATE_ROOT_FILES.includes(to)) return null
  if (o.web === true && WEB_STARTER_ROOT_FILES.includes(to)) return null
  if (/[\\:\0]/.test(to) || to.startsWith('/'))
    return 'The target is not a relative path with forward slashes.'
  const segs = to.split('/')
  if (segs.some((s) => s === '.' || s === '..')) return 'The target may not hold "." or "..".'
  const roots = o.web === true ? [...TEMPLATE_FILE_ROOTS, ...WEB_STARTER_FILE_ROOTS] : TEMPLATE_FILE_ROOTS
  if (segs.length < 2 || !roots.includes(segs[0] ?? ''))
    return `The target must be a file under ${roots.map((r) => `${r}/`).join(', ')}.`
  if (!segs.every((s) => TARGET_SEGMENT.test(s)))
    return 'A part of the target path is empty, hidden or not plain.'
  return null
}

export const TemplateFileZ = z.strictObject({
  /** The id of a bundled file (the vendor manifest's entry). */
  from: z.string().regex(TEMPLATE_FILE_ID_PATTERN, 'Not a bundled file id'),
  /** Where it goes in the new project (see templateTargetProblem; checked with the template's `webStarter`). */
  to: z.string(),
})
export type TemplateFile = z.infer<typeof TemplateFileZ>

// ---- libraries a project installs itself ----------------------------------------------------------------------------

/** The most libraries one template names as installed by the project. */
export const TEMPLATE_INSTALLS_MAX = 5
/** An npm package name (optionally scoped), lower case. */
export const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/

/**
 * A library the project installs into its own node_modules with npm (listed in its package.json), never bundled with
 * Dim Factory: optional, chosen only with the template, and it needs Node.js. Said on Easy's confirm screen.
 */
export const TemplateInstallZ = z.strictObject({
  /** The npm package. */
  package: z.string().regex(NPM_PACKAGE_PATTERN, 'Not an npm package name'),
  /** What people call it ("three.js"). */
  name: z.string().trim().min(1).max(40),
  license: z.string().trim().min(1).max(40),
})
export type TemplateInstall = z.infer<typeof TemplateInstallZ>

// ---- the checks a project made from the template runs ---------------------------------------------------------------

/** The most checks one template names. */
export const TEMPLATE_CHECKS_MAX = 4

/**
 * A check the project made from this template runs when Verify runs, known before the project exists: its own test or
 * build script (run through Verify's trusted-command runner: trusted by Easy's project permission, or asked for on the
 * trust card), or Dim Factory's own page-load check (`dimf:pageload <page>`, which spawns nothing). `needs: 'node'`:
 * left out when Node.js is not ready.
 */
export const TemplateCheckZ = z.strictObject({
  name: z.string().trim().min(1).max(60),
  run: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\0\r\n]*$/, 'An argument may not hold a line break'),
    )
    .min(1)
    .max(8),
  needs: z.literal('node').optional(),
})
export type TemplateCheck = z.infer<typeof TemplateCheckZ>

export const TemplateZ = z
  .strictObject({
    $schema: z.string().max(2048).optional(),
    id: TemplateIdZ,
    version: z.literal(1),
    /** The category (a pack id): the Brief's category, and the group the template is listed under. */
    pack: PackIdZ,
    label: z.string().trim().min(1).max(BRIEF_LABEL_MAX),
    description: z.string().trim().min(1).max(TEMPLATE_DESCRIPTION_MAX),
    /** The Brief choices the template seeds (groups and options of its pack; checked against it). */
    brief: z.strictObject({ fields: z.record(BriefGroupIdZ, BriefFieldZ) }),
    /** The scaffold task: what to create (files, scripts, a test setup, a README with how to run it). */
    task: z.string().trim().min(1).max(TEMPLATE_TASK_MAX),
    /** The recipe the template suggests (a recipe id). */
    recipe: TemplateIdZ,
    create: TemplateCreateZ.optional(),
    /**
     * Files copied into the new folder before the run starts (built-in templates only): each from the bundled manifest,
     * checked against its sha256 first. Targets are unique.
     */
    files: z
      .array(TemplateFileZ)
      .max(TEMPLATE_FILES_MAX)
      .superRefine((list, ctx) => {
        const seen = new Set<string>()
        list.forEach((f, i) => {
          const key = f.to.toLowerCase()
          if (seen.has(key))
            ctx.addIssue({ code: 'custom', path: [i, 'to'], message: `"${f.to}" is listed twice` })
          seen.add(key)
        })
      })
      .optional(),
    /** Libraries the project installs itself with npm (needs Node.js); Dim Factory never bundles or copies them. */
    installs: z.array(TemplateInstallZ).max(TEMPLATE_INSTALLS_MAX).optional(),
    /** The checks a project made from it runs (its tests, its build, its page loading), in order. */
    checks: z.array(TemplateCheckZ).max(TEMPLATE_CHECKS_MAX).optional(),
    tags: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'Not a tag'))
      .max(TEMPLATE_TAGS_MAX)
      .optional(),
    /**
     * Full mode only: Easy mode never offers or starts from it (an online game needs a server the user hosts, which a
     * beginner's one-shot project should not quietly depend on).
     */
    fullOnly: z.literal(true).optional(),
    /**
     * A web starter: its files make a project that runs as it is, so they may also go to the project's root and to
     * public/ and assets/ (WEB_STARTER_ROOT_FILES, WEB_STARTER_FILE_ROOTS).
     */
    webStarter: z.literal(true).optional(),
  })
  .superRefine((t, ctx) => {
    t.files?.forEach((f, i) => {
      const problem = templateTargetProblem(f.to, { web: t.webStarter === true })
      if (problem !== null) ctx.addIssue({ code: 'custom', path: ['files', i, 'to'], message: problem })
    })
  })
export type Template = z.infer<typeof TemplateZ>

/** Where a template came from: built in, or a user file (which replaces the built-in of its id). */
export const TEMPLATE_LAYERS = ['builtin', 'user'] as const
export type TemplateLayer = (typeof TEMPLATE_LAYERS)[number]

export interface TemplateView {
  template: Template
  layer: TemplateLayer
}

/** A user template file that could not be used (its built-in, if any, stays). */
export interface TemplateIssue {
  file: string
  message: string
}

/** `templates.list`: every usable template, the packs they belong to (in the packs' order), and the issues. */
export interface TemplatesList {
  templates: TemplateView[]
  packs: { id: string; label: string }[]
  issues: TemplateIssue[]
}

/** `project.create`: an absolute folder (new, or an existing empty one) and the template to start from. */
export interface ProjectCreateRequest {
  folder: string
  templateId: string
  /** "What should it do?": appended to the template's task. */
  goal?: string
}

/** What `project.create` made, for the composer (or `dimf new`) to start the run with. */
export interface ProjectCreated {
  folder: string
  template: { id: string; label: string }
  brief: BriefInput
  task: string
  recipe: string
  create?: TemplateCreate
}

/** The Brief a template seeds: its pack, and its fields as the user's own choices. */
export function templateBrief(t: Template): BriefInput {
  const fields: BriefInput['fields'] = {}
  for (const [group, field] of Object.entries(t.brief.fields)) fields[group] = { ...field, source: 'user' }
  return { category: t.pack, fields }
}

/**
 * In an Easy project's task, the line between the user's own request (above it) and the template's outline (below
 * it): what the request says wins.
 */
export const OUTLINE_INTRO =
  'Make it in this empty folder. Start from this outline and adapt it to the request above; where they differ, the request wins:'

/** The user's own words of a task: an Easy task's part above OUTLINE_INTRO, else the whole task. */
export function requestPartOf(task: string): string {
  const at = task.indexOf(OUTLINE_INTRO)
  return at === -1 ? task : task.slice(0, at)
}

/** Said after every scaffold task: a folder the user already scaffolded is built on, not replaced. */
export const SCAFFOLD_EXISTING_NOTE =
  'If the folder already holds a scaffold (for example from the official create command), build on it instead of starting over.'

/** The run's task: the template's task, the existing-scaffold note, and the user's "What should it do?" text. */
export function projectTask(t: Template, goal?: string): string {
  const parts = [t.task.trim(), SCAFFOLD_EXISTING_NOTE]
  const g = goal?.trim() ?? ''
  if (g !== '') parts.push(`What it should do: ${g}`)
  return parts.join('\n\n')
}
