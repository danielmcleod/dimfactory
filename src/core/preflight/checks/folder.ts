// Folder-scope checks (the guard, branch prep): folder.exists, folder.guard, folder.size,
// folder.git, folder.project.config, folder.project.former, folder.trust.projectAuto, folder.trust.recipeAuto,
// run.recipe (the recipe's info line), folder.lock, folder.disk.
// They run only for owners `run` and `worktree`; Dim Factory-owned cwds
// (heal, catalog, probe) skip folder.* entirely. Git state, untracked size and the scheduler query are injected
// (git agent: repo.ts / shadow size preflight; scheduler).
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BRAND, FORMER_PROJECT_DIRNAME } from '../../../shared/brand.ts'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { TrustGrants } from '../../../shared/ipc.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import type { RunStatus } from '../../../shared/run.ts'
import { isProjectAutoGranted, isRecipeAutoGranted } from '../../config/trust.ts'
import { repairCommand } from '../../heal/commands.ts'
import type { CheckContext, PreflightCheckDef } from '../engine.ts'
import { isGuarded, sameGuardPath, scopeRootGuardDetail } from '../guard.ts'
import type { GuardOptions, GuardResult } from '../guard.ts'
import { configFileResult, defaultDiskFree, formatBytes } from './app.ts'

const MB = 1024 * 1024
const GB = 1024 * MB

export const FOLDER_DISK_BLOCK_BYTES = 200 * MB
export const FOLDER_DISK_WARN_BYTES = 1 * GB
/** Guard "Size": more than 20k untracked files or 1 GB blocks until the `largeFolder` grant. */
export const SIZE_MAX_FILES = 20_000
export const SIZE_MAX_BYTES = 1 * GB
/** Files over this are auto-excluded from snapshots, with a note. */
export const LARGE_FILE_BYTES = 100 * MB

export type { GuardOptions, GuardResult } from '../guard.ts'
/** guard.ts `isGuarded(path, {owner, dimFactoryHome, platform})` (injectable for tests). */
export type GuardFn = (path: string, o: GuardOptions) => GuardResult | Promise<GuardResult>

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | 'bisect'

/** Repo state for `folder.git` (git reads use `--no-optional-locks`). */
export interface FolderGitFacts {
  isRepo: boolean
  /** git refuses the repo ("detected dubious ownership"). */
  dubiousOwnership?: boolean
  /** `index.lock` exists. */
  indexLock?: boolean
  /** An operation in progress, from `rev-parse --git-path` markers. */
  operation?: GitOperation | null
  unmergedPaths?: boolean
  /** HEAD points at a branch with no commits yet. */
  unbornHead?: boolean
  detachedHead?: boolean
  /** Current branch, when on one. */
  branch?: string | null
}

/** Untracked content a snapshot would add (shadow size preflight). */
export interface FolderSizeResult {
  files: number
  bytes: number
  /** Files over 100 MB; auto-excluded from snapshots. */
  largeFiles?: { path: string; bytes: number }[]
}

/** The run this folder would queue behind. */
export interface FolderLockInfo {
  runId: string
  displayNo: number
  status: RunStatus
  /** When it entered `status` (for "paused 2d"). */
  since?: number
}

const appliesToFolder = (ctx: CheckContext): boolean => {
  const owner = ctx.input.owner ?? 'run'
  return ctx.folder !== undefined && (owner === 'run' || owner === 'worktree')
}

const folderKeyOf = (ctx: CheckContext): string => {
  const f = ctx.folder ?? ''
  return ctx.platform === 'win32' || ctx.platform === 'darwin' ? f.toLowerCase() : f
}

/** Branch prep or an isolated run needs a sound repo: folder.git problems block instead of warn. */
function strictGit(ctx: CheckContext): boolean {
  const iso = ctx.config?.isolation
  return iso !== undefined && (iso.branch === 'runBranch' || iso.mode === 'worktree')
}

const sinceText = (now: number, since: number | undefined): string => {
  if (since === undefined) return ''
  const mins = Math.max(0, Math.floor((now - since) / 60_000))
  if (mins < 60) return ` ${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 48 ? ` ${hours}h` : ` ${Math.floor(hours / 24)}d`
}

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code

export function folderCheckDefs(): PreflightCheckDef[] {
  return [
    {
      id: 'folder.exists',
      scope: 'folder',
      title: 'Folder',
      dependsOn: [],
      cost: 'io',
      ttlMs: 30_000,
      authoritativeTtlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: appliesToFolder,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const missing = (title: string, detail: string) =>
          ctx.result({ status: 'fail', title, detail, category: 'folder_guard' })
        try {
          const s = await stat(folder)
          if (!s.isDirectory()) return missing('Not a folder', `${folder} is a file. Choose a folder.`)
          await readdir(folder)
        } catch (err) {
          const code = errCode(err)
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return missing('Folder not found', `${folder} does not exist. Choose another folder.`)
          }
          return missing('Folder cannot be read', `${folder}: ${code ?? (err as Error).message}`)
        }
        return ctx.result({ status: 'pass', detail: folder })
      },
    },
    {
      id: 'folder.guard',
      scope: 'folder',
      title: 'Folder is safe to run in',
      dependsOn: ['folder.exists'],
      // resolving the scope root reads git (rev-parse; shared with the other folder checks through the scope cache)
      cost: 'spawn',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: appliesToFolder,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const guard = ctx.deps.isGuarded ?? isGuarded
        const folder = ctx.folder ?? ''
        const o: GuardOptions = {
          owner: ctx.input.owner === 'worktree' ? 'worktree' : 'run',
          dimFactoryHome: ctx.home,
          platform: ctx.platform,
        }
        const refuse = (detail: string): CheckResult =>
          ctx.result({
            status: 'fail',
            title: 'Dim Factory does not run in this folder',
            detail,
            category: 'folder_guard',
          })
        const g = await guard(folder, o)
        if (g.guarded) return refuse(g.detail)
        // The guard refuses scope roots: snapshots, the size check and the folder lock cover the git top level, which
        // may be a guarded folder even when the chosen folder is not (a dotfiles repo at ~, a repo at D:\).
        const root =
          ctx.deps.scopeRoot === undefined ? null : await ctx.deps.scopeRoot(folder).catch(() => null)
        if (root !== null && !sameGuardPath(root, g.path, ctx.platform)) {
          const r = await guard(root, o)
          if (r.guarded) return refuse(scopeRootGuardDetail(folder, root, r))
        }
        return ctx.result({ status: 'pass', detail: folder })
      },
    },
    {
      id: 'folder.size',
      scope: 'folder',
      title: 'Folder size',
      dependsOn: ['app.git', 'folder.guard'],
      cost: 'spawn',
      ttlMs: 10 * 60_000,
      authoritativeTtlMs: 0,
      timeoutMs: { live: 2000 },
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.deps.folderSize !== undefined,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const size = await ctx.deps.folderSize!(folder, {
          ...(ctx.mode === 'live' ? { timeoutMs: 2000 } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        const summary = `${size.files.toLocaleString('en-US')} new files, ${formatBytes(size.bytes)}`
        const tooBig = size.files > SIZE_MAX_FILES || size.bytes > SIZE_MAX_BYTES
        const granted = tooBig && (await ctx.deps.hasLargeFolderGrant?.(folder, size)) === true
        if (tooBig && !granted) {
          return ctx.result({
            status: 'fail',
            title: 'This folder is very large',
            detail:
              `${summary} would go into the first snapshot (limit: 20,000 files or 1 GB). ` +
              'Add build output to .gitignore, or allow snapshots of this folder.',
            category: 'folder_guard',
            recovery: [
              {
                id: 'folder.size.grant',
                label: 'Snapshot this large folder anyway',
                kind: 'grant',
                grant: 'largeFolder',
                detail: summary,
              },
            ],
          })
        }
        const large = size.largeFiles ?? []
        if (large.length > 0) {
          const names = large
            .slice(0, 3)
            .map((f) => `${f.path} (${formatBytes(f.bytes)})`)
            .join(', ')
          return ctx.result({
            status: 'warn',
            title: `${large.length} file${large.length === 1 ? '' : 's'} over 100 MB left out of snapshots`,
            detail: `${names}${large.length > 3 ? ', …' : ''}. Changes to them will not appear in diffs.`,
          })
        }
        return ctx.result({ status: 'pass', detail: `${summary}${granted && tooBig ? ' (allowed)' : ''}` })
      },
    },
    {
      id: 'folder.git',
      scope: 'folder',
      title: 'Git repository',
      dependsOn: ['app.git', 'folder.exists'],
      cost: 'spawn',
      ttlMs: 30_000,
      authoritativeTtlMs: 0,
      timeoutMs: { live: 2000 },
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.deps.gitFacts !== undefined,
      subjectKey: (ctx) =>
        `${folderKeyOf(ctx)}|${ctx.config?.isolation.mode ?? ''}|${ctx.config?.isolation.branch ?? ''}`,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const facts = await ctx.deps.gitFacts!(folder, {
          ...(ctx.mode === 'live' ? { timeoutMs: 2000 } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        const strict = strictGit(ctx)
        // A copy written from a snapshot needs no repository (the worktree check below is for `git worktree add`).
        const worktree = ctx.config?.isolation.mode === 'worktree' && ctx.input.snapshotCopy !== true
        if (!facts.isRepo) {
          if (worktree) {
            return ctx.result({
              status: 'fail',
              title: 'Isolated runs need a git repository',
              detail: `${folder} is not a git repository. Run in place, or initialize git first.`,
              category: 'git_state',
              recovery: [isolationLink],
            })
          }
          // A run branch is a branch of the folder's repository.
          if (ctx.config?.isolation.branch === 'runBranch') {
            return ctx.result({
              status: 'fail',
              title: 'A run branch needs a git repository',
              detail: `${folder} is not a git repository. Run without a run branch, or initialize git first.`,
              category: 'git_state',
              recovery: [branchLink],
            })
          }
          return ctx.result({
            status: 'pass',
            title: 'Not a git repository',
            detail: 'Dim Factory still snapshots and diffs every run in its own shadow repository.',
          })
        }
        const sev = strict ? ('fail' as const) : ('warn' as const)
        const why = strict ? ' Branch prep and isolated runs need this fixed.' : ''
        const out: CheckResult[] = []
        if (facts.dubiousOwnership === true) {
          const fix = repairCommand('safeDirectory', ctx.os, folder)
          out.push(
            ctx.result({
              id: 'folder.git.ownership',
              status: sev,
              title: 'Git does not trust this folder (dubious ownership)',
              detail: `The folder belongs to another user account, so git refuses to use it.${why}`,
              category: 'git_state',
              recovery:
                fix === null
                  ? []
                  : [
                      shellCopy(
                        'folder.git.safe-directory',
                        'Copy the safe.directory command',
                        fix,
                        'folder.git',
                      ),
                    ],
            }),
          )
        }
        if (facts.operation !== undefined && facts.operation !== null) {
          const fix = repairCommand('abort', ctx.os, facts.operation)
          out.push(
            ctx.result({
              id: 'folder.git.operation',
              status: sev,
              title: `A git ${facts.operation} is in progress`,
              detail: `Finish or abort the ${facts.operation} first.${why}`,
              category: 'git_state',
              recovery:
                fix === null
                  ? []
                  : [shellCopy('folder.git.abort', `Copy "${fix.command}"`, fix, 'folder.git')],
            }),
          )
        } else if (facts.unmergedPaths === true) {
          out.push(
            ctx.result({
              id: 'folder.git.unmerged',
              status: sev,
              title: 'The folder has unresolved merge conflicts',
              detail: `Resolve the conflicted files first.${why}`,
              category: 'git_state',
            }),
          )
        }
        if (facts.indexLock === true) {
          out.push(
            ctx.result({
              id: 'folder.git.lock',
              status: sev,
              title: 'Another git process holds the index lock',
              detail:
                'index.lock exists. Wait for the other git command to finish; if none is running, delete .git/index.lock.' +
                why,
              category: 'git_state',
            }),
          )
        }
        if (facts.unbornHead === true) {
          // A copy written from a snapshot starts from the folder as it is, not from a commit; a run branch still
          // needs one to branch from.
          const copied = ctx.input.snapshotCopy === true && ctx.config?.isolation.branch !== 'runBranch'
          const needsCommit = strict && !copied
          out.push(
            ctx.result({
              id: 'folder.git.head',
              status: needsCommit ? 'fail' : 'warn',
              title: 'The repository has no commits yet',
              detail: needsCommit
                ? 'Branch prep and isolated runs need at least one commit. Run in place, or commit first.'
                : copied
                  ? 'The copy is made from the folder as it is now, so no commit is needed.'
                  : 'Dim Factory runs in place; diffs still work.',
              category: 'git_state',
              ...(needsCommit ? { recovery: [isolationLink] } : {}),
            }),
          )
        } else if (facts.detachedHead === true) {
          out.push(
            ctx.result({
              id: 'folder.git.detached',
              status: 'pass',
              title: 'Detached HEAD',
              detail: 'HEAD is not on a branch. Dim Factory never commits, so this is fine.',
            }),
          )
        }
        if (out.length === 0) {
          out.push(
            ctx.result({
              status: 'pass',
              detail: facts.branch !== undefined && facts.branch !== null ? `On ${facts.branch}` : folder,
            }),
          )
        }
        return out
      },
    },
    {
      id: 'folder.project.config',
      scope: 'folder',
      title: "The project's settings (.dimfactory/dimfactory.json)",
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.input.configFiles?.project != null,
      subjectKey: (ctx) => ctx.input.configFiles?.project?.path ?? '',
      run(ctx) {
        const file = ctx.input.configFiles?.project
        if (file === null || file === undefined) return Promise.resolve([])
        if (!file.exists) {
          return Promise.resolve(
            ctx.result({
              status: 'pass',
              title: 'No project settings',
              detail: `${file.path} does not exist.`,
            }),
          )
        }
        return Promise.resolve(
          configFileResult(ctx, 'folder.project.config', file, {
            name: "The project's dimfactory.json",
            blocked: 'Runs in this folder are blocked until it is fixed.',
            ...(ctx.folder !== undefined ? { folder: ctx.folder } : {}),
          }),
        )
      },
    },
    {
      id: 'folder.project.former',
      scope: 'folder',
      title: 'Project folder from before the rename',
      dependsOn: ['folder.exists'],
      cost: 'io',
      ttlMs: 30_000,
      authoritativeTtlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: appliesToFolder,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const isDir = async (p: string): Promise<boolean> => {
          try {
            return (await stat(p)).isDirectory()
          } catch {
            return false
          }
        }
        if (!(await isDir(join(folder, FORMER_PROJECT_DIRNAME)))) return []
        const former = FORMER_PROJECT_DIRNAME
        const now = BRAND.projectDirName
        if (await isDir(join(folder, now))) {
          return ctx.result({
            status: 'warn',
            detail: `${former} is from before the rename to ${BRAND.displayName} and is not read; ${now} is. Delete ${former} when you no longer need it.`,
          })
        }
        const win = ctx.platform === 'win32'
        const command = win ? `Rename-Item -LiteralPath '${former}' -NewName '${now}'` : `mv ${former} ${now}`
        return ctx.result({
          status: 'warn',
          detail: `${former} is from before the rename to ${BRAND.displayName} and is not read. Rename it to ${now} to keep its settings.`,
          recovery: [
            shellCopy(
              'folder.project.former.rename',
              `Copy "${command}"`,
              { command, shell: win ? 'powershell' : 'sh' },
              'folder.project.former',
            ),
          ],
        })
      },
    },
    {
      id: 'folder.trust.projectAuto',
      scope: 'folder',
      title: 'Auto mode from the project',
      dependsOn: ['folder.project.config'],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.input.configFiles?.project?.setsAuto === true,
      subjectKey: (ctx) => `${folderKeyOf(ctx)}|${ctx.input.configFiles?.project?.sha256 ?? ''}`,
      async run(ctx) {
        const file = ctx.input.configFiles?.project
        const folder = ctx.folder ?? ''
        const sha = file?.sha256 ?? null
        const grants: TrustGrants = (await ctx.deps.trustGrants?.(folder)) ?? {}
        if (isProjectAutoGranted(grants, sha)) {
          return ctx.result({
            status: 'pass',
            detail: `You allowed ${file?.path ?? 'the project file'} to turn on Auto mode.`,
          })
        }
        const changed =
          grants.projectAuto !== undefined
            ? ' The file changed since you allowed it, so Dim Factory asks again.'
            : ''
        return ctx.result({
          status: 'fail',
          title: 'This project turns on Auto mode',
          detail:
            `${file?.path ?? 'The project dimfactory.json'} sets "auto": true: Implement and Fix would run with ` +
            `full permissions and the gates would be skipped.${changed} Allow it for this version of the file, ` +
            'or run without Auto mode.',
          category: 'trust_required',
          recovery: [
            {
              id: 'folder.trust.projectAuto.grant',
              label: "Allow this project's Auto mode",
              kind: 'grant',
              grant: 'projectAuto',
              // The grant covers the version shown here; trust.set refuses it once the file changed.
              ...(sha !== null ? { projectSha: sha } : {}),
              detail: file?.path ?? '',
            },
            {
              id: 'folder.trust.projectAuto.off',
              label: 'Run without Auto mode',
              kind: 'config_patch',
              target: 'runOverrides',
              ops: [{ op: 'add', path: '/auto', value: false }],
              preview: 'auto: false (this run only)',
            },
          ],
        })
      },
    },
    {
      // A recipe from the folder's own `.dimfactory/recipes/` (a committed file anyone can change) that turns Auto on
      // needs the user's grant for that version of the file, as a project dimfactory.json that does. Built-in and user
      // recipes need none.
      id: 'folder.trust.recipeAuto',
      scope: 'folder',
      title: 'Auto mode from a project recipe',
      dependsOn: [],
      cost: 'io',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.input.recipe?.setsAuto === true,
      subjectKey: (ctx) =>
        `${folderKeyOf(ctx)}|${ctx.input.recipe?.id ?? ''}|${ctx.input.recipe?.sha256 ?? ''}`,
      async run(ctx) {
        const recipe = ctx.input.recipe
        if (recipe === undefined) return []
        const folder = ctx.folder ?? ''
        const grants: TrustGrants = (await ctx.deps.trustGrants?.(folder)) ?? {}
        if (isRecipeAutoGranted(grants, recipe.id, recipe.sha256)) {
          return ctx.result({
            status: 'pass',
            detail: `You allowed the recipe "${recipe.label}" (${recipe.path}) to turn on Auto mode.`,
          })
        }
        const changed =
          grants.recipeAuto?.[recipe.id] !== undefined
            ? ' The file changed since you allowed it, so Dim Factory asks again.'
            : ''
        return ctx.result({
          status: 'fail',
          title: 'This project recipe turns on Auto mode',
          detail:
            `The recipe "${recipe.label}" (${recipe.path}) sets "auto": true: Implement and Fix would run with full ` +
            `permissions and the gates would be skipped.${changed} Allow it for this version of the file, or run ` +
            'without Auto mode. Verify commands a recipe adds still ask for your trust before they first run.',
          category: 'trust_required',
          recovery: [
            {
              id: 'folder.trust.recipeAuto.grant',
              label: "Allow this recipe's Auto mode",
              kind: 'grant',
              grant: 'recipeAuto',
              recipeId: recipe.id,
              // The grant covers the version shown here; trust.set refuses it once the file changed.
              recipeSha: recipe.sha256,
              detail: recipe.path,
            },
            {
              id: 'folder.trust.recipeAuto.off',
              label: 'Run without Auto mode',
              kind: 'config_patch',
              target: 'runOverrides',
              ops: [{ op: 'add', path: '/auto', value: false }],
              preview: 'auto: false (this run only)',
            },
          ],
        })
      },
    },
    {
      // The recipe the run uses, named in the checks (an info line), with what it turns on and where it came from.
      id: 'run.recipe',
      scope: 'run',
      title: 'Recipe',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.input.recipe !== undefined,
      subjectKey: (ctx) => `${ctx.input.recipe?.id ?? ''}|${ctx.input.recipe?.sha256 ?? ''}`,
      run(ctx) {
        const recipe = ctx.input.recipe
        if (recipe === undefined) return Promise.resolve([])
        const from =
          recipe.layer === 'builtin'
            ? 'Built in.'
            : `${recipe.layer === 'user' ? 'Your' : "The project's"} recipe file ${recipe.path}.`
        const commands =
          recipe.verifyCommands > 0
            ? ` It adds ${recipe.verifyCommands} verify command${recipe.verifyCommands === 1 ? '' : 's'}; each asks for your trust before it first runs.`
            : ''
        return Promise.resolve(
          ctx.result({
            status: 'pass',
            title: `Recipe: ${recipe.label}`,
            detail: `${from} ${recipe.summary}${commands}`,
          }),
        )
      },
    },
    {
      id: 'folder.lock',
      scope: 'folder',
      title: 'Folder availability',
      dependsOn: ['folder.exists'],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => appliesToFolder(ctx) && ctx.deps.lockQuery !== undefined,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const held = await ctx.deps.lockQuery!(ctx.folder ?? '')
        if (held === null) return ctx.result({ status: 'pass', detail: 'No other run is using this folder.' })
        // An isolated run locks its own worktree path and leases the folder only to apply: it does not
        // wait for the run holding the folder, so it is not "queued behind" it.
        if (ctx.config?.isolation.mode === 'worktree') {
          return ctx.result({
            status: 'pass',
            title: `Runs alongside run #${held.displayNo} (${held.status}${sinceText(ctx.now(), held.since)})`,
            detail: `Run #${held.displayNo} is using this folder. An isolated run works in its own copy, so it starts now; applying its changes to the folder waits until the folder is free.`,
          })
        }
        return ctx.result({
          status: 'pass',
          title: `Queues behind run #${held.displayNo} (${held.status}${sinceText(ctx.now(), held.since)})`,
          detail: `Run #${held.displayNo} is using this folder; this run starts when it finishes.`,
        })
      },
    },
    {
      id: 'folder.disk',
      scope: 'folder',
      title: 'Free space in the folder',
      dependsOn: ['folder.exists'],
      cost: 'io',
      ttlMs: 60_000,
      authoritativeTtlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: appliesToFolder,
      subjectKey: folderKeyOf,
      async run(ctx) {
        const folder = ctx.folder ?? ''
        const free = await (ctx.deps.diskFree ?? defaultDiskFree)(folder)
        if (free === null) return ctx.result({ status: 'skip', detail: 'Free space could not be read.' })
        const detail = `${formatBytes(free)} free on the drive holding ${folder}.`
        if (free < FOLDER_DISK_BLOCK_BYTES) {
          return ctx.result({
            status: 'fail',
            title: 'The folder’s drive is almost full',
            detail: `${detail} The agents need room to write files.`,
            category: 'disk_full',
          })
        }
        if (free < FOLDER_DISK_WARN_BYTES) {
          return ctx.result({
            status: 'warn',
            title: 'The folder’s drive is low on space',
            detail,
            category: 'disk_full',
          })
        }
        return ctx.result({ status: 'pass', detail })
      },
    },
  ]
}

const isolationLink: RecoveryAction = {
  id: 'folder.git.isolation',
  label: 'Run in place instead',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/isolation',
}

const branchLink: RecoveryAction = {
  id: 'folder.git.branch',
  label: 'Run without a run branch',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/isolation/branch',
}

function shellCopy(
  id: string,
  label: string,
  cmd: { command: string; shell: 'powershell' | 'sh'; elevated?: boolean },
  recheck: string,
): RecoveryAction {
  return {
    id,
    label,
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason: label,
    recheck,
    ...(cmd.elevated === true ? { elevated: true } : {}),
  }
}
