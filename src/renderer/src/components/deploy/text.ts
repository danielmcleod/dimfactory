// The Deploy helper's words (UI copy standards: no em dashes; every cost and security line keeps core's caveat).
// Everything here formats core's views (DeployReport, DeployRunView, CommitPreview, PrPreview); nothing is worked out
// from the folder.
import type {
  CheckState,
  CommitPreview,
  DeployCheckItem,
  DeployClassGuess,
  DeployRunView,
  PrPreview,
} from '@shared/deploy.ts'

export const DEPLOY_TITLE = 'Deploy'
export const DEPLOY_INTRO =
  'Where this could be deployed, what to check first, and the commands to copy. Dim Factory never deploys, never signs in to a provider and never stores a token.'
export const SHOW_LABEL = 'Deploy'
export const HIDE_LABEL = 'Hide'
export const INSPECTING_TEXT = 'Looking at the folder…'
export const CLASS_PICK_LABEL = 'Not right? Pick what it ships as'
export const TICK_LABEL = 'I checked this'
export const RECOMMENDED_LABEL = 'Suggested'

const SOURCE_TEXT: Readonly<Record<DeployClassGuess['source'], string>> = {
  brief: 'from your brief',
  folder: 'from the folder',
  task: 'from the task, a guess',
  default: 'a guess: nothing in the folder says',
  user: 'as you chose',
}

const CONFIDENCE_TEXT: Readonly<Record<DeployClassGuess['confidence'], string>> = {
  high: 'clear',
  medium: 'likely',
  low: 'not sure',
}

/** "Server app (from the folder, clear)". */
export function classLine(c: DeployClassGuess): string {
  return `${c.label} (${SOURCE_TEXT[c.source]}${c.source === 'user' || c.source === 'default' ? '' : `, ${CONFIDENCE_TEXT[c.confidence]}`})`
}

export const CHECK_STATE_LABEL: Readonly<Record<CheckState, string>> = {
  ok: 'Checked',
  warn: 'Check this',
  problem: 'Problem',
  'not-checked': 'Not checked',
}

/** A checklist row's state word: a manual item the user ticked reads "Ticked by you" (never "Checked"). */
export function checkStateText(item: DeployCheckItem): string {
  if (!item.auto && item.tickedAt !== undefined) return 'Ticked by you'
  return CHECK_STATE_LABEL[item.state]
}

/** What the run's Deploy step did, as one line (null while it has nothing to say). */
export function deployStepLine(v: DeployRunView | undefined): string | null {
  if (v === undefined) return null
  const target = v.target?.label
  if (v.phase === 'planning') return 'The Deploy step is reading the folder to pick a target.'
  if (v.phase === 'generating')
    return `The Deploy step is writing ${v.files.map((f) => f.path).join(', ')}${target !== undefined ? ` for ${target}` : ''}.`
  if (v.written !== undefined && v.written.length > 0)
    return `The Deploy step wrote ${v.written.join(', ')}${target !== undefined ? ` for ${target}` : ''}. Review them in the Diff tab before you deploy.`
  return v.note ?? null
}

/** "Commit the run's 4 files on its run branch dim/…" (or the isolated copy's branch). */
export function commitIntro(p: CommitPreview): string {
  const where = p.where === 'worktree' ? "the isolated copy's branch" : 'its run branch'
  const files = p.paths.length === 1 ? '1 file' : `${p.paths.length} files`
  return p.branch !== null
    ? `Commit the run's changes (${files}) on ${where} ${p.branch}. Your other staged changes stay as they are.`
    : "Commit the run's changes."
}

/** The confirmation card's sentence: names the repository and the branch, and what will be pushed. */
export function prConfirmText(p: PrPreview): string {
  return `Dim Factory will push ${p.branch ?? ''} to ${p.remote ?? ''} (${p.repo ?? ''}) and open a pull request${p.base !== null ? ` into ${p.base}` : ''}. Push and open it?`
}

export const PR_INTRO =
  'Open a pull request on GitHub for this branch. Copy the commands and run them yourself, or let Dim Factory run them after you confirm the repository and branch.'

// ---- the upload file (a zip for drag-and-drop hosting, made on this computer) ----------------------------------------

export const UPLOAD_TITLE = 'Drag and drop'
export const UPLOAD_MAKE = 'Make an upload file'
export const UPLOAD_SHOW = 'Show the file'
export const UPLOAD_SHOW_FIRST = 'Make the upload file first.'
export const UPLOAD_NETLIFY = 'Open Netlify Drop'
export const UPLOAD_PUBLIC = 'Putting it online makes it public.'
export const UPLOAD_LOCAL =
  'The file stays on this computer. Nothing is uploaded and no website opens unless you click.'

/** What the zip holds, in one line. */
export function uploadIntro(dir: string): string {
  const what = dir === '.' ? 'the project folder' : `${dir}/`
  return `A zip of ${what}, put next to the project, to drag onto a hosting site. Hidden files, node_modules, keys and notes for the AI are left out.`
}

/** The plain steps for the zip (itch.io too for a game). */
export function uploadSteps(game: boolean): string[] {
  return [
    'Open Netlify Drop and drag this file (or the folder) onto the page.',
    'Or in Cloudflare Pages: Create, Upload assets, then choose this file.',
    ...(game ? ["For itch.io: Upload the zip and tick 'This file will be played in the browser'."] : []),
  ]
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---- "Get it ready to share": the project's own build ------------------------------------------------------------

export const BUILD_LABEL = 'Get it ready to share'
/** What the button does, before it is pressed. */
export function buildIntro(command: string, dir: string): string {
  return `Runs the project's build (${command}), which writes the files to share into ${dir}/. Nothing is uploaded.`
}
export const BUILD_RUNNING = 'Building it. This can take a minute…'
/** The trust question: the build runs the project's own code. */
export function buildTrustText(command: string): string {
  return `Let it run the project's build (${command})? This runs the project's own code, inside this folder.`
}
export const BUILD_TRUST_OK = 'Build it'
export const BUILD_TRUST_CANCEL = 'Not now'
export const BUILD_TRUST_SHOW = 'Show what will run'
export const BUILD_TRUST_NO_SCRIPT = 'The build script could not be read.'
export const BUILD_CANCELLED = 'Not built. Nothing was run.'

/** "Ready to share: dist/ is up to date (built in 12 seconds)." */
export function buildDoneLine(dir: string, ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return `Ready to share: ${dir}/ is up to date (built in ${s} ${s === 1 ? 'second' : 'seconds'}).`
}

/** "Made shop-site.zip: 12 files, 48 KB." */
export function uploadMadeLine(r: { name: string; files: number; bytes: number }): string {
  return `Made ${r.name}: ${r.files === 1 ? '1 file' : `${r.files} files`}, ${sizeText(r.bytes)}.`
}

/** The raw data files left out of the upload file (they may hold people's details), and putting them in on request. */
export function dataLeftOutText(n: number): string {
  return `Your ${n === 1 ? 'data file was' : `${n} data files were`} left out: the page keeps the figures it shows, and anyone with the link could download the file, which may hold people's details.`
}
export const INCLUDE_DATA = 'Include my data'
export const DATA_INCLUDED = 'Your data files are in the upload file: anyone with the link can download them.'
