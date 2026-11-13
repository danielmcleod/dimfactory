// Run & Preview commands (preview.detect / start / stop / list). The folder is the request's, or a finished run's: its
// folder, or its isolated copy while the run's changes are not applied yet (the copy is run with the folder's grants,
// as Verify runs a worktree's commands). Detection costs no tokens (preview/detect.ts); a start is checked against
// trust again by the service. A finished Easy run's own preview command counts as trusted while its project's
// permission holds (easy/permission.ts; read again for every detect and start, each start logged as a use).
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Pack } from '../shared/brief.ts'
import type { RunRecipe } from '../shared/recipes.ts'
import { withProjectPermission } from './config/trust.ts'
import type { PermitRun } from './easy/permission.ts'
import type { PreviewTarget, TrustGrants } from '../shared/ipc.ts'
import type { CheckResult } from '../shared/preflight.ts'
import type { PreviewCommand, PreviewInfo, PreviewOpenTarget, PreviewSmokeView } from '../shared/preview.ts'
import { PREVIEW_RUN_MD_MAX } from '../shared/preview.ts'
import { DimFactoryError } from './errors.ts'
import type { HandlerContext, HandlerMap } from './handlers.ts'
import { resolvePathEnv, splitPathList } from './proc/path-env.ts'
import { detectPreviewCommands, readRunMd } from './preview/detect.ts'
import type { PreviewService } from './preview/service.ts'
import { readRunSmoke } from './preview/smoke.ts'
import { isGameFolder } from './preview/game.ts'
import { otherPreviewGrantBodies, previewHash, readPreviewBody } from './preview/trust.ts'
import { programName } from './verify/discover.ts'
import { resolveCommand } from './verify/resolve-cmd.ts'

/** What the preview commands need beyond the handler context. */
export interface PreviewHost {
  service: PreviewService
  /** The packs (with the user's and the folder's overrides) for a folder. */
  packs(folder: string): Promise<Pack[]>
  /** Settings → Preview (`preview.openIn`). */
  openIn(): PreviewOpenTarget
  /** The resolved PATH entries (default: resolvePathEnv). */
  pathEntries?: () => Promise<string[]>
  /** Easy mode's project permission (absent: it never applies to a preview). */
  permission?: {
    covers(r: PermitRun): boolean
    record(use: { folder: string; runId: string; what: 'command'; label: string }): void
  }
}

interface Target {
  folder: string
  /** The folder whose grants apply (trust.set's). */
  trustFolder: string
  runId?: string
  /** The run's recipe (a run target): an Easy run's project permission may cover its preview. */
  recipe?: RunRecipe
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** The folder a preview command is about (see the header). */
export async function previewTarget(ctx: HandlerContext, req: PreviewTarget): Promise<Target> {
  if (req.runId !== undefined) {
    const doc = await ctx.readDoc(req.runId)
    if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${req.runId} not found.`)
    const summary = ctx.summarize(doc.state)
    const source = doc.scope.folder
    const copy = doc.work?.folder
    const inCopy = copy !== undefined && summary.worktree?.notApplied === true && existsSync(copy)
    return {
      folder: inCopy ? copy : source,
      trustFolder: source,
      runId: req.runId,
      ...(doc.state.recipe !== undefined ? { recipe: doc.state.recipe } : {}),
    }
  }
  const f = req.folder
  if (f === undefined || f.trim() === '') throw new DimFactoryError('VALIDATION', 'folder is required')
  const folder = isAbsolute(f) ? f : resolve(f)
  if (!(await isDir(folder))) throw new DimFactoryError('NOT_FOUND', `The folder ${folder} does not exist`)
  return { folder, trustFolder: folder }
}

/** A non-blocking check per command whose program is not installed (never a failure: it may still run elsewhere). */
export function missingToolChecks(
  commands: readonly PreviewCommand[],
  o: { folder: string; scopeRoot: string; pathEntries: readonly string[]; now: number },
): CheckResult[] {
  const out: CheckResult[] = []
  for (const c of commands) {
    const argv0 = c.argv[0]
    if (c.kind === 'static' || argv0 === undefined) continue
    const cwd = resolve(o.scopeRoot, c.cwdRel)
    if (resolveCommand(argv0, { cwd, root: o.scopeRoot, pathEntries: o.pathEntries }) !== null) continue
    const prog = programName(argv0)
    out.push({
      id: `preview.tool.${c.id}`,
      scope: 'folder',
      status: 'warn',
      blocking: false,
      title: `${prog} is not installed`,
      detail: `${c.label} needs ${prog}, which Dim Factory could not find on this computer. Install it to run the project this way, or pick another way.`,
      recovery: [],
      at: o.now,
      ttlMs: 0,
    })
  }
  return out
}

/**
 * The body a preview command grant covers, read under the scope root as a start will read it. Granting with the hash
 * the user was shown refuses a body that changed since (CONFLICT): a grant only ever trusts text the user saw.
 */
export async function previewGrantBody(
  scopeRoot: string,
  cmd: { argv: readonly string[]; cwdRel: string; hash?: string },
  granting: boolean,
): Promise<string | undefined> {
  const read = await readPreviewBody(scopeRoot, cmd)
  if (granting && read.error !== undefined) throw new DimFactoryError('VALIDATION', read.error)
  if (granting && cmd.hash !== undefined && previewHash(cmd, read.body) !== cmd.hash) {
    throw new DimFactoryError(
      'CONFLICT',
      'This command changed since it was shown (what it runs is different now); review it and trust it again',
    )
  }
  return read.body ?? undefined
}

export function previewHandlers(ctx: HandlerContext, host: PreviewHost | undefined): HandlerMap {
  if (host === undefined) return {}
  const pathEntries = host.pathEntries ?? (async () => splitPathList((await resolvePathEnv()).path))

  /** Whether an Easy run's project permission covers this target's preview now. */
  const covered = (t: Target): boolean =>
    t.runId !== undefined &&
    host.permission?.covers({ runId: t.runId, folder: t.trustFolder, cwd: t.folder, recipe: t.recipe }) ===
      true
  const grantsOf = (t: Target, g: TrustGrants): TrustGrants => (covered(t) ? withProjectPermission(g) : g)

  const detect = async (t: Target): Promise<{ info: PreviewInfo; commands: PreviewCommand[] }> => {
    const [trust, packs, entries] = await Promise.all([
      ctx.config.trustGet(t.trustFolder),
      host.packs(t.trustFolder),
      pathEntries(),
    ])
    // The copy's own root, so its commands' cwdRel read as the folder's do (the copy mirrors the scope root).
    const scopeRoot = t.folder === t.trustFolder ? trust.scopeRoot : t.folder
    const commands = await detectPreviewCommands({
      folder: t.folder,
      scopeRoot,
      packs,
      grants: grantsOf(t, trust.grants),
    })
    const sessions = host.service.forFolder(t.folder)
    let smoke: PreviewSmokeView | null = null
    if (t.runId !== undefined) smoke = await readRunSmoke(ctx.paths, t.runId)
    else {
      for (const s of sessions) {
        const v = host.service.smokeOf(s.id)
        if (v !== undefined && (smoke === null || v.at > smoke.at)) smoke = v
      }
    }
    const info: PreviewInfo = {
      folder: t.folder,
      scopeRoot,
      trustFolder: t.trustFolder,
      ...(t.runId !== undefined ? { runId: t.runId } : {}),
      commands,
      checks: missingToolChecks(commands, {
        folder: t.folder,
        scopeRoot,
        pathEntries: entries,
        now: ctx.now(),
      }),
      runMd: await readRunMd(t.folder, PREVIEW_RUN_MD_MAX),
      sessions,
      smoke,
      openIn: host.openIn(),
    }
    return { info, commands }
  }

  return {
    'preview.detect': async (req) => (await detect(await previewTarget(ctx, req))).info,
    'preview.start': async (req) => {
      if (ctx.readOnly && ctx.kind === 'app') {
        throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      }
      const t = await previewTarget(ctx, req)
      const { info, commands } = await detect(t)
      const command = commands.find((c) => c.id === req.commandId)
      if (command === undefined) {
        throw new DimFactoryError('NOT_FOUND', 'That way of running the project is not offered any more.')
      }
      const own = (await ctx.config.trustGet(t.trustFolder)).grants
      const grants = grantsOf(t, own)
      // A game's preview reaches this computer only until the user allows the internet for it.
      const game =
        (await isGameFolder(ctx.paths.home, t.trustFolder)) ||
        (t.folder !== t.trustFolder && (await isGameFolder(ctx.paths.home, t.folder)))
      const view = await host.service.start({
        folder: t.folder,
        scopeRoot: info.scopeRoot,
        ...(t.runId !== undefined ? { runId: t.runId } : {}),
        command,
        grants,
        game,
      })
      // A command trusted by the project permission alone: one use.
      if (
        grants !== own &&
        t.runId !== undefined &&
        command.argv.length > 0 &&
        (command.hash === undefined || own.commands?.[command.hash] === undefined)
      ) {
        host.permission?.record({
          folder: t.trustFolder,
          runId: t.runId,
          what: 'command',
          label: command.label,
        })
      }
      return view
    },
    'preview.trust': async (req) => {
      const t = await previewTarget(ctx, req)
      const { info, commands } = await detect(t)
      const c = commands.find((x) => x.id === req.commandId)
      if (c === undefined) {
        throw new DimFactoryError('NOT_FOUND', 'That way of running the project is not offered any more.')
      }
      if (c.kind === 'static' || c.kind === 'document')
        throw new DimFactoryError('VALIDATION', 'Dim Factory shows this itself: it needs no trust.')
      const cmd = { argv: c.argv, cwdRel: c.cwdRel }
      const body = await previewGrantBody(
        info.scopeRoot,
        { ...cmd, ...(req.hash !== undefined ? { hash: req.hash } : {}) },
        req.trusted,
      )
      const grant = {
        kind: 'command' as const,
        command: { kind: 'preview' as const, argv: [...c.argv], cwdRel: c.cwdRel },
      }
      if (!req.trusted) {
        // Untrust: the grants for older bodies of the same command go too (else it reads "changed").
        const { grants } = await ctx.config.trustGet(t.trustFolder)
        for (const old of otherPreviewGrantBodies(grants, cmd, body)) {
          await ctx.config.trustSet({
            folder: t.trustFolder,
            grant,
            trusted: false,
            ...(old !== undefined ? { body: old } : {}),
          })
        }
      }
      await ctx.config.trustSet({
        folder: t.trustFolder,
        grant,
        trusted: req.trusted,
        ...(body !== undefined ? { body } : {}),
      })
    },
    'preview.stop': async (req) => {
      if (req.containers !== true) return host.service.stop(req.sessionId)
      // "Stop containers too": the compose command stops, then its `docker compose down` runs, checked against the
      // folder's grants as they are now (the service reads the compose files again).
      if (ctx.readOnly && ctx.kind === 'app') {
        throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
      }
      const v = host.service.get(req.sessionId)
      if (v === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not listed any more.')
      const t = await previewTarget(ctx, v.runId !== undefined ? { runId: v.runId } : { folder: v.folder })
      const own = (await ctx.config.trustGet(t.trustFolder)).grants
      await host.service.composeDown(req.sessionId, grantsOf(t, own))
    },
    'preview.list': () => Promise.resolve(host.service.list()),
    // "Allow internet for this preview" (one click), or back to this computer only.
    'preview.network': (req) =>
      Promise.resolve(host.service.setNetwork(req.sessionId, req.internet ? 'internet' : 'loopback')),
  }
}
