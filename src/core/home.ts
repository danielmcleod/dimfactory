// DIM_FACTORY_HOME resolution and every path under it (the home layout).
// Paths built from a step key or label go through fileSafe() (`:` would open an NTFS alternate data stream).
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileSafe } from '../shared/ids.ts'
import type { Result } from '../shared/ipc.ts'
import { DimFactoryError, fail, ok, storageError } from './errors.ts'
import { BRAND, HOME_ENV as BRAND_HOME_ENV } from '../shared/brand.ts'

export const HOME_ENV = BRAND_HOME_ENV
export const DEFAULT_HOME_DIRNAME = BRAND.homeDirName
/** POSIX mode for directories Dim Factory creates under home. */
export const HOME_DIR_MODE = 0o700

export interface ResolveHomeOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** The OS user's home directory (default `os.homedir()`). */
  userHome?: string
  /** Base for a relative DIM_FACTORY_HOME (default `process.cwd()`). */
  cwd?: string
}

/** `DIM_FACTORY_HOME` (`~` expanded, made absolute), else `<user home>/.dimfactory`. */
export function resolveHome(opts: ResolveHomeOptions = {}): string {
  const env = opts.env ?? process.env
  const userHome = opts.userHome ?? homedir()
  const raw = env[HOME_ENV]?.trim()
  if (raw === undefined || raw === '') return join(userHome, DEFAULT_HOME_DIRNAME)
  let p = raw
  if (p === '~') p = userHome
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(userHome, p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(opts.cwd ?? process.cwd(), p)
}

/** Windows device names, which name a device in any folder (with or without an extension). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i

/**
 * A single path segment taken from data (run id, folder key, heal id, prompt name). Rejects separators, `..`,
 * drive/stream colons and control characters so a crafted id can never escape its directory. Path handling:
 * also a trailing dot or space (Windows drops them, so `<id>.` would be another run's folder) and a Windows device
 * name (`NUL`, `CON.json`), on every platform, so a run folder means the same thing everywhere.
 */
export function assertSafeSegment(value: string, what = 'path segment'): string {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    // eslint-disable-next-line no-control-regex
    /[\\/:\u0000-\u001f<>"|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    WINDOWS_DEVICE.test(value)
  ) {
    throw new DimFactoryError('VALIDATION', `invalid ${what}: ${JSON.stringify(value)}`)
  }
  return value
}

export type RunTextOutput =
  | 'plan'
  | 'plan.original'
  | 'review'
  | 'critic'
  | 'security'
  | 'recheck'
  | 'clarify'
  | 'research'
  | 'research.json'
  | 'deploy'
  | 'acceptance'
  | 'explain'
export type LogKind = 'main' | 'cli'

/** Every path inside `runs/<id>/`. Step-keyed builders take a StepKey (or label) and pass it through fileSafe(). */
export interface RunPaths {
  runId: string
  dir: string
  runJson: string
  resolvedJson: string
  eventsJsonl: string
  findingsJson: string
  snapshotsJson: string
  procsJson: string
  reviewStateJson: string
  planMd: string
  planOriginalMd: string
  reviewMd: string
  criticMd: string
  diffsDir: string
  rawDir: string
  promptsDir: string
  outDir: string
  verifyDir: string
  healDir: string
  /** `<text>.md` for a pass output. */
  output(name: RunTextOutput): string
  /** `diffs/<fileSafe(label)>.patch`. */
  diffPatch(label: string): string
  /** `raw/<fileSafe(step)>-<attempt>.ndjson` (redacted raw vendor I/O). */
  raw(step: string, attempt: number): string
  /** `prompts/<fileSafe(step)>-<attempt>.md` (the rendered prompt sent over stdin). */
  prompt(step: string, attempt: number): string
  /** `out/<fileSafe(step)>-<attempt>.<ext>` (vendor output files, e.g. Codex `-o`). */
  out(step: string, attempt: number, ext?: string): string
  /** `verify/<fileSafe(step)>/` (one directory per verify round). */
  verify(step: string): string
  /** `heal/<fileSafe(step)>-<attempt>/` */
  heal(step: string, attempt: number): string
}

/** Every path under DIM_FACTORY_HOME. */
export interface HomePaths {
  home: string
  userConfig: string
  promptsDir: string
  /** `recipes/` (user recipe files, `<id>.json`). */
  recipesDir: string
  runsDir: string
  runIndex: string
  shadowDir: string
  worktreesDir: string
  catalogDir: string
  catalogModels: string
  catalogPricing: string
  catalogHistoryDir: string
  catalogJobsDir: string
  trust: string
  state: string
  probeCache: string
  /** Home-level procs.json: non-run children (catalog refresh, ad-hoc probes). */
  procs: string
  healDir: string
  healCache: string
  tmpDir: string
  probeCwd: string
  healTmpDir: string
  backupsDir: string
  lastGoodUserConfig: string
  projectBackupsDir: string
  schemaDir: string
  schemaFile: string
  emptyHooksDir: string
  logsDir: string
  instanceLock: string
  session: string
  /** Electron userData when DIM_FACTORY_HOME is set (boot step 1). */
  electronUserData: string
  /** `prompts/<name>.md` (user prompt override). */
  userPrompt(name: string): string
  run(runId: string): RunPaths
  /** `shadow/<folderKey>/repo.git` */
  shadowRepo(folderKey: string): string
  /** `worktrees/<runId>/` */
  worktree(runId: string): string
  /** `tmp/heal/<id>/` (run-less heal working directory). */
  healTmp(id: string): string
  /** `backups/project/<folderKey>/` */
  projectBackups(folderKey: string): string
  /** `backups/project/<folderKey>/last-good.jsonc` */
  lastGoodProjectConfig(folderKey: string): string
  /** `logs/<kind>.log` */
  log(kind: LogKind): string
}

export function runPaths(runsDir: string, runId: string): RunPaths {
  const dir = join(runsDir, assertSafeSegment(runId, 'run id'))
  const stepFile = (step: string, attempt: number, ext: string): string =>
    `${fileSafe(step)}-${Math.trunc(attempt)}${ext}`
  const outputs: Record<RunTextOutput, string> = {
    plan: join(dir, 'plan.md'),
    'plan.original': join(dir, 'plan.original.md'),
    review: join(dir, 'review.md'),
    critic: join(dir, 'critic.md'),
    security: join(dir, 'security.md'),
    recheck: join(dir, 'recheck.md'),
    clarify: join(dir, 'clarify.md'),
    research: join(dir, 'research.md'),
    'research.json': join(dir, 'research.json'),
    deploy: join(dir, 'deploy.md'),
    acceptance: join(dir, 'acceptance.json'),
    explain: join(dir, 'explain.md'),
  }
  return {
    runId,
    dir,
    runJson: join(dir, 'run.json'),
    resolvedJson: join(dir, 'resolved.json'),
    eventsJsonl: join(dir, 'events.jsonl'),
    findingsJson: join(dir, 'findings.json'),
    snapshotsJson: join(dir, 'snapshots.json'),
    procsJson: join(dir, 'procs.json'),
    reviewStateJson: join(dir, 'review-state.json'),
    planMd: outputs.plan,
    planOriginalMd: outputs['plan.original'],
    reviewMd: outputs.review,
    criticMd: outputs.critic,
    diffsDir: join(dir, 'diffs'),
    rawDir: join(dir, 'raw'),
    promptsDir: join(dir, 'prompts'),
    outDir: join(dir, 'out'),
    verifyDir: join(dir, 'verify'),
    healDir: join(dir, 'heal'),
    output: (name) => outputs[name],
    diffPatch: (label) => join(dir, 'diffs', `${fileSafe(label)}.patch`),
    raw: (step, attempt) => join(dir, 'raw', stepFile(step, attempt, '.ndjson')),
    prompt: (step, attempt) => join(dir, 'prompts', stepFile(step, attempt, '.md')),
    out: (step, attempt, ext = '.txt') =>
      join(dir, 'out', stepFile(step, attempt, ext.startsWith('.') ? ext : `.${ext}`)),
    verify: (step) => join(dir, 'verify', fileSafe(step)),
    heal: (step, attempt) => join(dir, 'heal', stepFile(step, attempt, '')),
  }
}

export function homePaths(home: string): HomePaths {
  const h = resolve(home)
  const runsDir = join(h, 'runs')
  const backupsDir = join(h, 'backups')
  const projectBackupsDir = join(backupsDir, 'project')
  return {
    home: h,
    userConfig: join(h, BRAND.configFileName),
    promptsDir: join(h, 'prompts'),
    recipesDir: join(h, 'recipes'),
    runsDir,
    runIndex: join(runsDir, 'index.jsonl'),
    shadowDir: join(h, 'shadow'),
    worktreesDir: join(h, 'worktrees'),
    catalogDir: join(h, 'catalog'),
    catalogModels: join(h, 'catalog', 'models.json'),
    catalogPricing: join(h, 'catalog', 'pricing.json'),
    catalogHistoryDir: join(h, 'catalog', 'history'),
    catalogJobsDir: join(h, 'catalog', 'jobs'),
    trust: join(h, 'trust.json'),
    state: join(h, 'state.json'),
    probeCache: join(h, 'probe-cache.json'),
    procs: join(h, 'procs.json'),
    healDir: join(h, 'heal'),
    healCache: join(h, 'heal', 'cache.json'),
    tmpDir: join(h, 'tmp'),
    probeCwd: join(h, 'tmp', 'probe-cwd'),
    healTmpDir: join(h, 'tmp', 'heal'),
    backupsDir,
    lastGoodUserConfig: join(backupsDir, 'last-good-user.jsonc'),
    projectBackupsDir,
    schemaDir: join(h, 'schema'),
    schemaFile: join(h, 'schema', BRAND.schemaFileName),
    emptyHooksDir: join(h, 'empty-hooks'),
    logsDir: join(h, 'logs'),
    instanceLock: join(h, 'instance.lock'),
    session: join(h, 'session.json'),
    electronUserData: join(h, 'electron-user-data'),
    userPrompt: (name) => join(h, 'prompts', `${fileSafe(assertSafeSegment(name, 'prompt name'))}.md`),
    run: (runId) => runPaths(runsDir, runId),
    shadowRepo: (folderKey) => join(h, 'shadow', assertSafeSegment(folderKey, 'folder key'), 'repo.git'),
    worktree: (runId) => join(h, 'worktrees', assertSafeSegment(runId, 'run id')),
    healTmp: (id) => join(h, 'tmp', 'heal', fileSafe(assertSafeSegment(id, 'heal id'))),
    projectBackups: (folderKey) => join(projectBackupsDir, assertSafeSegment(folderKey, 'folder key')),
    lastGoodProjectConfig: (folderKey) =>
      join(projectBackupsDir, assertSafeSegment(folderKey, 'folder key'), 'last-good.jsonc'),
    log: (kind) => join(h, 'logs', `${kind}.log`),
  }
}

/** Project-level paths inside a user folder (committed config and prompts). */
export interface ProjectPaths {
  dir: string
  config: string
  promptsDir: string
  /** `recipes/` (project recipe files, shareable by committing them). */
  recipesDir: string
  prompt(name: string): string
}

export function projectPaths(folder: string): ProjectPaths {
  const dir = join(resolve(folder), BRAND.projectDirName)
  return {
    dir,
    config: join(dir, BRAND.configFileName),
    promptsDir: join(dir, 'prompts'),
    recipesDir: join(dir, 'recipes'),
    prompt: (name) => join(dir, 'prompts', `${fileSafe(assertSafeSegment(name, 'prompt name'))}.md`),
  }
}

/** mkdir -p with 0o700 on POSIX (Windows ignores the mode). */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: HOME_DIR_MODE })
  } catch (err) {
    throw storageError(`cannot create ${dir}`, err)
  }
}

/** Create home and the directories every session needs (runs, logs, tmp). */
export async function ensureHome(paths: HomePaths): Promise<void> {
  for (const dir of [paths.home, paths.runsDir, paths.logsDir, paths.tmpDir]) await ensureDir(dir)
}

/** Boot writability probe: create, then remove, a file in home. STORAGE with the path on failure. */
export async function probeHomeWritable(paths: HomePaths): Promise<Result<void>> {
  const probe = join(paths.home, `.write-probe-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await ensureDir(paths.home)
    await writeFile(probe, 'ok', { mode: 0o600 })
    await rm(probe, { force: true })
    return ok(undefined)
  } catch (err) {
    await rm(probe, { force: true }).catch(() => undefined)
    return fail('STORAGE', `Dim Factory cannot write to its home folder ${paths.home}`, {
      path: paths.home,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
