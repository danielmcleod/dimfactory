// The Deploy helper: what a folder's deliverable is (classified locally, no tokens), where it could go (the packs'
// deploy targets, data), a pre-flight checklist filled in from what Dim Factory can check, the config an optional
// editing pass writes, and the deploy commands as copyable steps. Dim Factory never runs a deploy command, never signs
// in to a provider and never stores a token. Commit and pull request at the end of a run are opt-in per project.
// Every cost or security statement carries a caveat: nothing here claims a deploy is free or secure.
import { z } from 'zod'
import type { ShellKind } from './failure.ts'

// ---- deliverable classes -------------------------------------------------------------------------------------------

export const DEPLOY_CLASSES = [
  'static-site',
  'spa',
  'server-app',
  'container',
  'serverless',
  'package',
  'desktop-installer',
  'mobile-app',
  'docs-site',
] as const
export type DeployClass = (typeof DEPLOY_CLASSES)[number]

export const DEPLOY_CLASS_LABEL: Readonly<Record<DeployClass, string>> = {
  'static-site': 'Static site',
  spa: 'Single-page app',
  'server-app': 'Server app',
  container: 'Container',
  serverless: 'Serverless functions',
  package: 'Package',
  'desktop-installer': 'Desktop installer',
  'mobile-app': 'Mobile app',
  'docs-site': 'Docs site',
}

export function isDeployClass(v: unknown): v is DeployClass {
  return typeof v === 'string' && (DEPLOY_CLASSES as readonly string[]).includes(v)
}

/** How sure the classification is: the brief named it, the folder shows it plainly, or a guess. */
export const DEPLOY_CONFIDENCES = ['high', 'medium', 'low'] as const
export type DeployConfidence = (typeof DEPLOY_CONFIDENCES)[number]

/** Where the classification came from. */
export const DEPLOY_CLASS_SOURCES = ['brief', 'folder', 'task', 'default', 'user'] as const
export type DeployClassSource = (typeof DEPLOY_CLASS_SOURCES)[number]

// ---- caveats (UI copy, no em dashes) -------------------------------------------------------------------------------

/** Under every cost statement. */
export const DEPLOY_COST_CAVEAT =
  "Check the provider's current pricing before you deploy: free tiers, limits and prices change, and usage can cost money."
/** Under the checklist. */
export const DEPLOY_SECURITY_CAVEAT =
  'Dim Factory checked only the items marked as checked. A passing checklist does not make a deploy secure.'
/** Over the commands. */
export const DEPLOY_COMMANDS_CAVEAT =
  'Dim Factory never runs these commands, never signs in to a provider and never stores a token. Read each one, then run it yourself.'

// ---- config files the editing pass may write -------------------------------------------------------------------------

export const DEPLOY_CONFIG_KINDS = [
  'dockerfile',
  'netlify',
  'vercel',
  'fly',
  'github-actions',
  'env-example',
  'firebase',
  'firebaserc',
] as const
export type DeployConfigKind = (typeof DEPLOY_CONFIG_KINDS)[number]

/** Where each config kind lives, relative to the folder (`/` separators). */
export const DEPLOY_CONFIG_PATH: Readonly<Record<DeployConfigKind, string>> = {
  dockerfile: 'Dockerfile',
  netlify: 'netlify.toml',
  vercel: 'vercel.json',
  fly: 'fly.toml',
  'github-actions': '.github/workflows/deploy.yml',
  'env-example': '.env.example',
  firebase: 'firebase.json',
  firebaserc: '.firebaserc',
}

/** The project id a generated .firebaserc names: a placeholder the user replaces, never a real id. */
export const FIREBASE_PROJECT_PLACEHOLDER = 'your-firebase-project-id'

/** What each config file is for (the Deploy step's prompt and the panel's list). */
export const DEPLOY_CONFIG_PURPOSE: Readonly<Record<DeployConfigKind, string>> = {
  dockerfile: 'builds a container image that starts the app',
  netlify: 'tells Netlify how to build the site and where the built files are',
  vercel: 'tells Vercel how to build and route the project',
  fly: 'describes the Fly.io app (its name, internal port and health check)',
  'github-actions': 'a GitHub Actions workflow that builds and publishes on push',
  'env-example': 'lists every environment variable the code reads, with placeholder values only',
  firebase:
    'tells Firebase Hosting which folder to serve (the built files) and, for a single-page app, to answer every address with index.html',
  firebaserc: `names the Firebase project as the placeholder "${FIREBASE_PROJECT_PLACEHOLDER}" for the user to replace (never a real project id)`,
}

// ---- pack data: deploy targets ---------------------------------------------------------------------------------------

/** A target id: lower camel or kebab case (as the Brief's ids). */
export const DEPLOY_TARGET_ID = /^[a-z][a-zA-Z0-9-]{0,39}$/
/** Placeholders a command template may use; core fills each from the folder (or a safe default). */
export const DEPLOY_PLACEHOLDERS = ['name', 'dir', 'branch', 'port', 'version'] as const
export type DeployPlaceholder = (typeof DEPLOY_PLACEHOLDERS)[number]

const TextZ = z.string().trim().min(1).max(240)

/** One step of a target's deploy: a copyable command, or an instruction the user follows (no `run`). */
export const PackDeployStepZ = z.strictObject({
  label: z.string().trim().min(1).max(120),
  /** The command line with `{placeholder}`s. Copied, never run. */
  run: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[^\0\r\n]*$/, 'A command may not hold a line break')
    .optional(),
  note: TextZ.optional(),
})
export type PackDeployStep = z.infer<typeof PackDeployStepZ>

export const PackDeployTargetZ = z.strictObject({
  id: z.string().regex(DEPLOY_TARGET_ID, 'Not a target id (letters, digits and dashes, up to 40)'),
  label: z.string().trim().min(1).max(60),
  /** The deliverable classes this target serves. */
  classes: z.array(z.enum(DEPLOY_CLASSES)).min(1).max(DEPLOY_CLASSES.length),
  /** The Brief's Hosting choices that point at this target (option ids of the pack's `hosting` group). */
  hosting: z.array(z.string().regex(DEPLOY_TARGET_ID)).max(10).optional(),
  /** Plain trade-offs; each is shown with the cost caveat, never as a promise. */
  freeTier: TextZ,
  cost: TextZ,
  coldStarts: TextZ,
  customDomains: TextZ,
  dataResidency: TextZ,
  /** The config files a deploy there uses (the Deploy step writes the missing ones). */
  configs: z.array(z.enum(DEPLOY_CONFIG_KINDS)).max(DEPLOY_CONFIG_KINDS.length),
  /** What the commands need installed (UI copy, "the Netlify CLI (through npx)"). */
  needs: TextZ.optional(),
  steps: z.array(PackDeployStepZ).min(1).max(10),
})
export type PackDeployTarget = z.infer<typeof PackDeployTargetZ>

export const PackDeployZ = z
  .strictObject({ targets: z.array(PackDeployTargetZ).min(1).max(24) })
  .superRefine((d, ctx) => {
    const seen = new Set<string>()
    d.targets.forEach((t, i) => {
      if (seen.has(t.id))
        ctx.addIssue({ code: 'custom', path: ['targets', i, 'id'], message: `Duplicate target "${t.id}"` })
      seen.add(t.id)
      t.steps.forEach((s, j) => {
        for (const m of (s.run ?? '').matchAll(/\{([^}]*)\}/g)) {
          if (!(DEPLOY_PLACEHOLDERS as readonly string[]).includes(m[1] ?? '')) {
            ctx.addIssue({
              code: 'custom',
              path: ['targets', i, 'steps', j, 'run'],
              message: `Unknown placeholder {${m[1] ?? ''}} (allowed: ${DEPLOY_PLACEHOLDERS.join(', ')})`,
            })
          }
        }
      })
    })
  })
export type PackDeploy = z.infer<typeof PackDeployZ>

// ---- the report (deploy.inspect, `dimf deploy`) ----------------------------------------------------------------------

export interface DeployClassGuess {
  id: DeployClass
  label: string
  source: DeployClassSource
  confidence: DeployConfidence
  /** Why, one line each (UI copy): "package.json depends on express". */
  reasons: string[]
  /** Other classes the folder also shows some sign of, most likely first. */
  alternatives: DeployClass[]
}

/** One copyable step (never executed). `command` absent: an instruction the user follows. */
export interface DeployStepView {
  id: string
  label: string
  command?: string
  shell: ShellKind
  note?: string
}

export interface DeployConfigView {
  kind: DeployConfigKind
  path: string
  purpose: string
  /** The file is in the folder already. */
  present: boolean
}

/** One place the deliverable could go. Every cost text is shown with DEPLOY_COST_CAVEAT. */
export interface DeployOptionView {
  id: string
  label: string
  packId: string
  freeTier: string
  cost: string
  coldStarts: string
  customDomains: string
  dataResidency: string
  configs: DeployConfigView[]
  needs?: string
  steps: DeployStepView[]
  /** Dim Factory's pick for the class (the brief's hosting choice, else the pack's first). */
  recommended: boolean
}

/**
 * A checklist item. `checked`: Dim Factory looked (`ok`, `warn`, `problem`); `not-checked`: Dim Factory cannot check it,
 * the user ticks it (`ticked`). Nothing reads "passed" without having been checked.
 */
export const CHECK_STATES = ['ok', 'warn', 'problem', 'not-checked'] as const
export type CheckState = (typeof CHECK_STATES)[number]

export interface DeployCheckItem {
  id: string
  label: string
  state: CheckState
  /** Dim Factory checked it itself (false: a manual item). */
  auto: boolean
  detail: string
  /** What was found, one line each (masked secrets, file names, variable names). */
  evidence?: string[]
  /** A manual item the user ticked for this folder (when). */
  tickedAt?: number
}

/** An environment variable the code reads. */
export interface DeployEnvVar {
  name: string
  /** Files that read it (at most a few). */
  files: string[]
  /** Listed in the folder's .env.example (or .env.sample / .env.template). */
  inExample: boolean
  /** The build puts it into the page (VITE_, NEXT_PUBLIC_, REACT_APP_ ...): anyone can read its value. */
  public?: true
}

export interface DeployReport {
  folder: string
  /** The category (pack) the targets came from. */
  category: string
  cls: DeployClassGuess
  /** Every class with a label, for the class picker. */
  classes: { id: DeployClass; label: string }[]
  options: DeployOptionView[]
  /** The recommended (or chosen) target's id; null when no pack offers one for the class. */
  target: string | null
  checklist: DeployCheckItem[]
  env: DeployEnvVar[]
  caveats: { cost: string; security: string; commands: string }
  /** What the report could not read (UI copy). */
  notes: string[]
  /** "Make an upload file", for the classes a static host serves as they are (absent for the others). */
  upload?: DeployUploadView
}

// ---- the upload file (a zip for drag-and-drop hosting; made on this computer, never uploaded) ------------------------

/** The classes whose files a static host serves as they are: these get "Make an upload file". */
export const UPLOAD_CLASSES: readonly DeployClass[] = ['static-site', 'spa', 'docs-site']

/** The page "Open Netlify Drop" opens (only on a click; the https allowlist has its host). */
export const NETLIFY_DROP_URL = 'https://app.netlify.com/drop'

/** What "Make an upload file" would zip. */
export interface DeployUploadView {
  /** The folder whose files go in the zip, relative to the project, `/` separators ('.' is the project itself). */
  dir: string
  /** The folder is there with an index.html in it (false: `problem` says why, UI copy). */
  ready: boolean
  problem?: string
  /** A game: the steps add itch.io. */
  game: boolean
  /**
   * The project's own build script ("Get it ready to share": it writes `dir`), as it would run (`npm run build`).
   * Absent: the files are served as they are, or there is no build script.
   */
  build?: { command: string }
}

/** deploy.build: "Get it ready to share" runs the project's own build script (trusted first, never on its own). */
export interface DeployBuildRequest extends DeployTarget {
  /** Trust the build script as shown (its hash from a `trust` answer) and run it. */
  trustHash?: string
}

/** What deploy.build did: built, failed (with the output's end), asked for trust first, or had nothing to run. */
export type DeployBuildResult =
  | { status: 'built'; dir: string; durationMs: number }
  | { status: 'failed'; reason: string; excerpt: string }
  | {
      status: 'trust'
      /** The command, one line (`npm run build`). */
      command: string
      /** The script it runs, as package.json has it (null: unread). */
      body: string | null
      /** What the grant covers: send it back as `trustHash` to trust and run it. */
      hash: string
    }
  | { status: 'none'; reason: string }

/** deploy.uploadFile: the zip made, or why not (secrets found, nothing to zip, too large). */
export type DeployUploadResult =
  | {
      status: 'made'
      /** The zip's absolute path (next to the project folder). */
      path: string
      name: string
      dir: string
      files: number
      /** The files' size before compression. */
      bytes: number
      /** Files the rules left out (hidden files, node_modules, keys, notes, links). */
      skipped: number
      /**
       * Raw data files (data/*.csv and other tables) left out because they may hold people's details: the page keeps
       * what it shows. Ask again with `includeData` to put them in. Absent: none.
       */
      dataLeftOut?: string[]
      /** The raw data files went in, as asked (anyone with the link can download them). */
      dataIncluded?: true
      /** Keys that are public by design went in: restrict them (UI copy), and where they are (masked). */
      warning?: string
      warnings?: string[]
    }
  | {
      status: 'refused'
      /** Why, UI copy. */
      reason: string
      /** What was found, one line each (masked secrets, file names). */
      evidence: string[]
    }

/** deploy.inspect: a folder on demand, or a finished run (its folder, or its isolated copy). */
export interface DeployTarget {
  folder?: string
  runId?: string
  /** Override the classification (the class picker). */
  cls?: DeployClass
}

/** deploy.uploadFile: the target, and whether the raw data files in data/ go in (default: they stay out). */
export interface DeployUploadRequest extends DeployTarget {
  includeData?: boolean
}

/** The most manual items a folder keeps ticks for. */
export const DEPLOY_TICKS_MAX = 64

// ---- the Deploy step of a run (StepView.deploy) -----------------------------------------------------------------------

/** One file the Deploy step was asked to write. */
export interface DeployFileView {
  kind: DeployConfigKind
  path: string
  purpose: string
}

/**
 * StepView.deploy. `phase`: `planning` (Dim Factory reads the folder to pick the target and the files) ·
 * `generating` (the editing pass writes them) · `done`. `written`: the files the pass changed, once its end
 * snapshot is in.
 */
export interface DeployRunView {
  phase: 'planning' | 'generating' | 'done'
  cls?: { id: DeployClass; label: string; confidence: DeployConfidence }
  target?: { id: string; label: string }
  files: DeployFileView[]
  /** Config files the target uses that were there already (left alone). */
  present: string[]
  env: string[]
  written?: string[]
  note?: string
}

/** What the Deploy step's planning found (the `deploy-plan-result` event; RunState.deploy.plan). */
export interface DeployPlanFacts {
  cls: { id: DeployClass; label: string; confidence: DeployConfidence }
  target: { id: string; label: string } | null
  files: DeployFileView[]
  present: string[]
  env: string[]
  notes: string[]
}

// ---- commit and pull request (opt-in per project) ---------------------------------------------------------------------

/** The longest commit subject line Dim Factory writes. */
export const COMMIT_SUBJECT_MAX = 72
/** The longest commit message the commit command takes. */
export const COMMIT_MESSAGE_MAX = 8000

/**
 * git.commitPreview: whether "Commit to run branch" is offered for a finished run, the message it would use and the
 * files it would commit. `blocked`: why not (UI copy), with commands to run instead.
 */
export interface CommitPreview {
  runId: string
  /** The project setting is on (`git.commit`). */
  enabled: boolean
  /** Where the commit goes: the run branch in the folder, or the isolated copy's branch. */
  where: 'run-branch' | 'worktree' | null
  branch: string | null
  /** Repository-relative paths the commit would hold (the run's changes only). */
  paths: string[]
  message: string
  blocked?: string
  /** Staged paths of yours that the commit leaves alone (never touched). */
  untouchedStaged?: string[]
  /** The commit this run made already (one per run). */
  committed?: { sha: string; branch: string; at: number }
}

export interface CommitResult {
  sha: string
  branch: string
  paths: string[]
  /** Notes: what was left alone. */
  notes: string[]
}

/** The `gh` check (never blocking): installed, signed in, and a copyable fix when not. */
export interface GhStatus {
  installed: boolean
  version?: string
  authenticated: boolean
  /** Why not, as UI copy. */
  problem?: string
  /** Copyable fixes (install, `gh auth login`). Never run by Dim Factory. */
  fixes: DeployStepView[]
}

/**
 * git.prPreview: what "Create PR" would do. `repo` and `branch` are what the confirmation card names; a create must
 * repeat them exactly (core refuses a create whose repo or branch changed since).
 */
export interface PrPreview {
  runId: string
  enabled: boolean
  remote: string | null
  /** The remote's URL as git reports it (credentials stripped). */
  remoteUrl: string | null
  /** `owner/name` when the remote is on GitHub; null otherwise. */
  repo: string | null
  branch: string | null
  base: string | null
  title: string
  body: string
  /** The copyable commands (push, then gh pr create). Shown whatever the gh check says. */
  commands: DeployStepView[]
  gh: GhStatus
  /** Why Create PR cannot run from Dim Factory now (the commands still can be copied). */
  blocked?: string
  /** The pull request this run opened already. */
  opened?: { url: string; at: number }
}

export interface PrCreateRequest {
  runId: string
  /** Exactly what the confirmation card showed. */
  confirm: { remote: string; repo: string; branch: string }
}

export interface PrResult {
  url: string
  pushed: boolean
  notes: string[]
}
