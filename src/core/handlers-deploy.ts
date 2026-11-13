// The Deploy helper's commands: deploy.inspect / deploy.tick (a folder on demand, or a finished run's folder or its
// isolated copy while its changes are not applied), and a finished run's commit and pull request (git.commitPreview,
// git.commit, git.prPreview, git.prCreate; opt-in per project, deploy/run-git.ts). Nothing here runs a deploy
// command: the report's steps are copied by the user. deploy.uploadFile zips a static deliverable next to the project
// folder for drag-and-drop hosting (deploy/upload.ts); it uploads nothing and opens nothing. deploy.build ("Get it ready
// to share") runs the project's own build script, trusted as Verify trusts it (or by an Easy run's project permission),
// after the user trusted it as shown (deploy/build.ts).
import { basename, dirname } from 'node:path'
import type { BriefInput, Pack } from '../shared/brief.ts'
import type {
  DeployBuildRequest,
  DeployBuildResult,
  DeployReport,
  DeployTarget,
  DeployUploadRequest,
  DeployUploadResult,
} from '../shared/deploy.ts'
import type { RunRecipe } from '../shared/recipes.ts'
import type { TrustGrants } from '../shared/ipc.ts'
import type { VerifyCommandResult } from '../shared/verify.ts'
import { withProjectPermission } from './config/trust.ts'
import type { PermitRun } from './easy/permission.ts'
import { BUILD_COMMAND_NAME, buildCommandOf, buildResultOf, buildTrust } from './deploy/build.ts'
import { buildDir } from './deploy/commands.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import { previewTarget } from './handlers-preview.ts'
import { classifyDeploy } from './deploy/classify.ts'
import { inspectDeploy } from './deploy/report.ts'
import { readDeploySignals } from './deploy/signals.ts'
import { makeUploadFile, uploadView } from './deploy/upload.ts'
import { commitPreview, commitRun, prCreate, prPreview } from './deploy/run-git.ts'
import type { RunGitDeps } from './deploy/run-git.ts'
import { readDeployTicks, setDeployTick } from './deploy/store.ts'

/** What the deploy commands need beyond the handler context (app-core.ts). */
export interface DeployHost {
  /** The packs (with the user's and the folder's overrides) for a folder. */
  packs(folder: string): Promise<Pack[]>
  /** The brief: a run's (its resolved.json record), else the folder's saved one. */
  brief(o: { folder: string; runId?: string }): Promise<BriefInput | null>
  /** A run's Deploy target and task (its config), for the report's recommendation. */
  runFacts?(runId: string): Promise<{ target: string | null; task: string } | null>
  /** The commit and pull request machinery (absent: those commands answer UNSUPPORTED). */
  runGit?: RunGitDeps
  platform?: NodeJS.Platform
  /**
   * Run the project's build as one trusted Verify command (its own log, outside any run's folder). Absent: "Get it
   * ready to share" answers UNSUPPORTED.
   */
  runBuild?: (o: {
    folder: string
    scopeRoot: string
    argv: string[]
    grants: TrustGrants
    runId?: string
  }) => Promise<VerifyCommandResult>
  /** Easy mode's project permission (absent: it never covers a build). */
  permission?: {
    covers(r: PermitRun): boolean
    record(use: { folder: string; runId: string; what: 'command'; label: string }): void
  }
  /** A run's recipe (an Easy run's project permission may cover its build). */
  runRecipe?: (runId: string) => Promise<RunRecipe | undefined>
}

function writable(ctx: HandlerContext): void {
  if (ctx.readOnly && ctx.kind === 'app')
    throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
}

export function deployHandlers(ctx: HandlerContext, host: DeployHost | undefined): HandlerMap {
  if (host === undefined) return {}
  const report = async (req: DeployTarget): Promise<DeployReport> => {
    const t = await previewTarget(ctx, req)
    const [packs, brief, ticks, facts] = await Promise.all([
      host.packs(t.trustFolder),
      host.brief({ folder: t.trustFolder, ...(t.runId !== undefined ? { runId: t.runId } : {}) }),
      readDeployTicks(ctx.paths.home, t.trustFolder),
      t.runId !== undefined && host.runFacts !== undefined ? host.runFacts(t.runId) : Promise.resolve(null),
    ])
    return inspectDeploy({
      folder: t.folder,
      packs,
      brief,
      ticks,
      ...(req.cls !== undefined ? { cls: req.cls } : {}),
      ...(facts !== null ? { task: facts.task, target: facts.target } : {}),
      ...(host.platform !== undefined ? { platform: host.platform } : {}),
    })
  }
  const upload = async (req: DeployUploadRequest): Promise<DeployUploadResult> => {
    writable(ctx)
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const t = await previewTarget(ctx, req)
    const [brief, facts, signals] = await Promise.all([
      host.brief({ folder: t.trustFolder, ...(t.runId !== undefined ? { runId: t.runId } : {}) }),
      t.runId !== undefined && host.runFacts !== undefined ? host.runFacts(t.runId) : Promise.resolve(null),
      readDeploySignals(t.folder),
    ])
    const cls = classifyDeploy(signals, { brief, ...(facts !== null ? { task: facts.task } : {}) }, req.cls)
    const game = (brief?.category ?? 'software') === 'games'
    const view = await uploadView(t.folder, signals, cls.id, { game })
    if (view === undefined)
      return {
        status: 'refused',
        reason: `An upload file is for a site whose files are served as they are. This is a ${cls.label.toLowerCase()}.`,
        evidence: [],
      }
    if (!view.ready)
      return { status: 'refused', reason: view.problem ?? 'There is nothing to zip.', evidence: [] }
    // The zip goes next to the project folder (the user's, also while a run's changes wait in its isolated copy).
    return makeUploadFile({
      folder: t.folder,
      dir: view.dir,
      outDir: dirname(t.trustFolder),
      baseName: basename(t.trustFolder),
      game,
      ...(req.includeData === true ? { includeData: true } : {}),
    })
  }
  /** "Get it ready to share": the project's build script, trusted first (see the header). */
  const build = async (req: DeployBuildRequest): Promise<DeployBuildResult> => {
    writable(ctx)
    if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const run = host.runBuild
    if (run === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'Building is not available in this process.')
    const t = await previewTarget(ctx, req)
    const cmd = await buildCommandOf(t.folder)
    if (cmd === null)
      return {
        status: 'none',
        reason: 'This project has no build script: its files are shared as they are.',
      }
    const trust = await ctx.config.trustGet(t.trustFolder)
    // The copy's own root, as Verify runs a worktree's commands (the grants are the folder's).
    const scopeRoot = t.folder === t.trustFolder ? trust.scopeRoot : t.folder
    const recipe = t.runId !== undefined ? await host.runRecipe?.(t.runId) : undefined
    const covered =
      t.runId !== undefined &&
      host.permission?.covers({ runId: t.runId, folder: t.trustFolder, cwd: t.folder, recipe }) === true
    const grants = covered ? withProjectPermission(trust.grants) : trust.grants
    const command = { argv: cmd.argv, cwdRel: '.' }
    let check = await buildTrust(scopeRoot, command, grants)
    if (check.error !== undefined) return { status: 'failed', reason: check.error, excerpt: '' }
    if (check.trust !== 'trusted') {
      if (req.trustHash === undefined || req.trustHash !== check.hash)
        return { status: 'trust', command: cmd.display, body: check.body, hash: check.hash }
      // Trusted as shown: Verify's own grant for the command, covering this script body.
      await ctx.config.trustSet({
        folder: t.trustFolder,
        grant: { kind: 'command', command: { kind: 'verify', argv: [...cmd.argv], cwdRel: '.' } },
        trusted: true,
        ...(check.body !== null ? { body: check.body } : {}),
      })
      const after = await ctx.config.trustGet(t.trustFolder)
      check = await buildTrust(scopeRoot, command, after.grants)
      if (check.trust !== 'trusted')
        return { status: 'trust', command: cmd.display, body: check.body, hash: check.hash }
    } else if (check.via === 'project' && t.runId !== undefined) {
      host.permission?.record({ folder: t.trustFolder, runId: t.runId, what: 'command', label: cmd.display })
    }
    const signals = await readDeploySignals(t.folder)
    const result = await run({
      folder: t.folder,
      scopeRoot,
      argv: cmd.argv,
      grants: check.via === 'project' ? grants : (await ctx.config.trustGet(t.trustFolder)).grants,
      ...(t.runId !== undefined ? { runId: t.runId } : {}),
    })
    return buildResultOf({ ...result, name: BUILD_COMMAND_NAME }, buildDir(signals, 'spa'))
  }
  const git = (): RunGitDeps => {
    if (host.runGit === undefined)
      throw new DimFactoryError('UNSUPPORTED', 'Commit and pull request are not available in this process.')
    return host.runGit
  }
  return {
    'deploy.inspect': (req) => report(req),
    'deploy.tick': async (req) => {
      writable(ctx)
      const t = await previewTarget(ctx, req)
      return {
        ticks: await setDeployTick(ctx.paths.home, t.trustFolder, req.item, req.ticked ? ctx.now() : null),
      }
    },
    'deploy.uploadFile': (req) => upload(req),
    'deploy.build': (req) => build(req),
    'git.commitPreview': (req) => commitPreview(git(), req.runId),
    'git.commit': (req) => {
      writable(ctx)
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return commitRun(git(), req.runId, req.message)
    },
    'git.prPreview': (req) => prPreview(git(), req.runId),
    'git.prCreate': (req) => {
      writable(ctx)
      if (ctx.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      return prCreate(git(), req)
    },
  }
}
