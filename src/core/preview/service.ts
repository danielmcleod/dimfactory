// Run & Preview sessions: the previews Dim Factory started, each a tracked child process (a dev server, a script) or
// Dim Factory's own static server.
//
// A command runs only as a trusted command, as Verify's do: its body is read again and checked against the folder's
// grants right before the spawn (Auto never implies trust), argv[0] is resolved the same way (resolve-cmd.ts), it is
// spawned without a shell (a win32 .cmd/.bat through cmd.exe with every argument escaped), with the sanitized env
// (NO_COLOR, BROWSER=none so a dev server opens no browser of its own), stdin ignored, and no timeout: a preview runs
// until Stop, its own exit, or the app's quit. Stop and quit kill its process tree (proc/kill.ts). Each child is
// recorded in DIM_FACTORY_HOME/preview/procs.json (touched while previews run), so a crash's leftovers are swept at the
// next launch. Output goes to preview/logs/<id>.log (first 1 MB + last 4 MB) and its newest lines to the session view,
// where the page's loopback URL is read from it (url.ts). Nothing starts on its own.
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { newRequestId } from '../../shared/ids.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { PreviewCommand, PreviewSessionView, PreviewSmokeView } from '../../shared/preview.ts'
import { PREVIEW_BLOCKED_HOSTS_MAX, PREVIEW_LINE_MAX, PREVIEW_TAIL_LINES } from '../../shared/preview.ts'
import type { PreviewNetworkMode } from '../../shared/playtest.ts'
import { DimFactoryError } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import type { Logger } from '../log.ts'
import { sanitizeEnv } from '../proc/env.ts'
import type { EnvInput } from '../proc/env.ts'
import { stopChild } from '../proc/kill.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { ProcTable, procRecordFor } from '../proc/proc-table.ts'
import { SpawnError, spawnChild } from '../proc/spawn.ts'
import type { ChildHandle, StdStream } from '../proc/spawn.ts'
import { batchInvocation } from '../proc/win-cmd.ts'
import { displayArgv } from '../verify/argv.ts'
import { cwdRelOf } from '../verify/discover.ts'
import { cleanLine } from '../verify/excerpt.ts'
import { CappedLog } from '../verify/log.ts'
import { localBinDirs, resolveCommand } from '../verify/resolve-cmd.ts'
import { startDocumentServer } from './document.ts'
import { startStaticServer } from './static-server.ts'
import type { StaticServer } from './static-server.ts'
import { composeArgs, composeDownArgv, previewTrustOf, readPreviewBody } from './trust.ts'
import { parsePreviewUrl } from './url.ts'

/** Ended sessions kept in the list (the newest), so a panel can still show how one ended. */
export const ENDED_KEPT = 20
/** Session updates are sent at most this often (status changes go at once). */
export const EMIT_EVERY_MS = 200
/** procs.json is rewritten this often while previews run (the relaunch sweep's sign of life). */
export const TOUCH_EVERY_MS = 5000

export interface PreviewServiceDeps {
  paths: HomePaths
  log: Logger
  now?: () => number
  /** A session changed (the `preview` event). */
  emit?: (view: PreviewSessionView) => void
  /** The env a child's is built from (sanitized). Default: process.env. */
  env?: EnvInput
  /** The resolved PATH. Default: resolvePathEnv(). */
  pathEnv?: () => Promise<string>
  /** Record children in `<home>/preview/procs.json` (the app; the CLI's preview is gone with its process). */
  recordProcs?: boolean
  emitEveryMs?: number
}

export interface PreviewStartRequest {
  /** The folder it runs for (a run's folder, or its isolated copy). */
  folder: string
  /** The root `command.cwdRel` and the grants are relative to. */
  scopeRoot: string
  runId?: string
  command: PreviewCommand
  /** The folder's grants, read now. */
  grants: TrustGrants
  /** A game's preview: loopback-only network by default (its page may reach this computer only). */
  game?: boolean
}

interface Session {
  view: PreviewSessionView
  child?: ChildHandle
  server?: StaticServer
  log?: CappedLog
  stopping?: Promise<void>
  /** Resolves once the child exited (or the server closed) and its log is closed. */
  ended: Promise<void>
  markEnded: () => void
  /** The URL shown is the command's hint, until the output names the real one. */
  urlFromHint?: boolean
  /** `document`: the Markdown shown (relative to the folder). */
  docPath?: string
  smoke?: PreviewSmokeView
  /** A compose preview's command and roots, for its `docker compose down` (checked against trust again then). */
  compose?: { argv: string[]; cwdRel: string; scopeRoot: string; runId?: string }
  /** The `docker compose down` in flight, and its process (quit stops it like a preview's). */
  downing?: Promise<void>
  downChild?: ChildHandle
}

/** The child's env: sanitized, project bins first on PATH, no colours, no browser of its own. */
export function previewChildEnv(base: EnvInput, path: string, cwd: string): Record<string, string> {
  const env = sanitizeEnv(base, {
    purpose: 'verify',
    path,
    pathPrepend: localBinDirs(cwd).filter((d) => existsSync(d)),
    extra: { NO_COLOR: '1', TERM: 'dumb', BROWSER: 'none' },
  })
  for (const k of Object.keys(env)) {
    if (/^(?:FORCE_COLOR|CLICOLOR_FORCE)$/i.test(k)) delete env[k]
  }
  return env
}

const cut = (line: string): string =>
  line.length <= PREVIEW_LINE_MAX ? line : `${line.slice(0, PREVIEW_LINE_MAX)}…`

const isLive = (v: PreviewSessionView): boolean =>
  v.status === 'starting' || v.status === 'running' || v.status === 'stopping'

export class PreviewService {
  readonly #d: PreviewServiceDeps
  readonly #sessions = new Map<string, Session>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #table: Promise<ProcTable | undefined> | undefined
  #touch: ReturnType<typeof setInterval> | undefined
  #closed = false

  constructor(d: PreviewServiceDeps) {
    this.#d = d
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  #dir(): string {
    return join(this.#d.paths.home, 'preview')
  }

  /** Every listed session, newest first. */
  list(): PreviewSessionView[] {
    return [...this.#sessions.values()].map((s) => copy(s.view)).reverse()
  }

  get(id: string): PreviewSessionView | undefined {
    const s = this.#sessions.get(id)
    return s === undefined ? undefined : copy(s.view)
  }

  /** The sessions for a folder (and, when given, a run), newest first. */
  forFolder(folder: string, runId?: string): PreviewSessionView[] {
    const f = resolve(folder)
    return this.list().filter((v) => resolve(v.folder) === f && (runId === undefined || v.runId === runId))
  }

  /** A session's latest smoke check (an on-demand one is kept only in memory). */
  smokeOf(id: string): PreviewSmokeView | undefined {
    return this.#sessions.get(id)?.smoke
  }

  setSmoke(id: string, smoke: PreviewSmokeView): void {
    const s = this.#sessions.get(id)
    if (s !== undefined) s.smoke = smoke
  }

  /** Start a preview (see the header). A command already running for the folder answers its session. */
  async start(r: PreviewStartRequest): Promise<PreviewSessionView> {
    if (this.#closed) throw new DimFactoryError('CONFLICT', 'Dim Factory is closing.')
    const folder = resolve(r.folder)
    const live = [...this.#sessions.values()].find(
      (s) =>
        resolve(s.view.folder) === folder &&
        s.view.commandId === r.command.id &&
        (s.view.status === 'starting' || s.view.status === 'running'),
    )
    if (live !== undefined) return copy(live.view)
    const id = newRequestId('pv')
    const view: PreviewSessionView = {
      id,
      folder,
      ...(r.runId !== undefined ? { runId: r.runId } : {}),
      commandId: r.command.id,
      label: r.command.label,
      kind: r.command.kind,
      status: 'starting',
      url: null,
      startedAt: this.#now(),
      tail: [],
      lines: 0,
      // A page a window shows: a game's reaches this computer only until the user allows the internet for it.
      ...(r.command.kind === 'server' || r.command.kind === 'static'
        ? r.game === true
          ? { game: true as const, network: 'loopback' as const }
          : { network: 'internet' as const }
        : {}),
    }
    let markEnded: () => void = () => undefined
    const ended = new Promise<void>((res) => (markEnded = res))
    const session: Session = { view, ended, markEnded: () => markEnded() }
    if (r.command.kind === 'server' && composeArgs(r.command.argv) !== null) {
      view.compose = true
      session.compose = {
        argv: [...r.command.argv],
        cwdRel: r.command.cwdRel,
        scopeRoot: resolve(r.scopeRoot),
        ...(r.runId !== undefined ? { runId: r.runId } : {}),
      }
    }
    this.#sessions.set(id, session)
    this.#prune()
    try {
      if (r.command.kind === 'static') await this.#startStatic(session, folder, r.command)
      else if (r.command.kind === 'document') await this.#startDocument(session, folder, r.command)
      else await this.#startProcess(session, r)
    } catch (err) {
      if (err instanceof DimFactoryError) {
        session.markEnded()
        this.#sessions.delete(id)
        throw err
      }
      this.#end(session, 'failed', err instanceof Error ? err.message : String(err))
      session.markEnded()
    }
    this.#emitNow(session)
    return copy(session.view)
  }

  async #startStatic(s: Session, folder: string, cmd: PreviewCommand): Promise<void> {
    const dir = resolve(folder, cmd.staticRoot ?? '.')
    if (cwdRelOf(folder, dir) === null)
      throw new DimFactoryError('VALIDATION', 'That folder is outside the project')
    const server = await startStaticServer(dir, { onRequest: (line) => this.#line(s, line) })
    // The server has no exit of its own: Stop (or quit) closes it.
    s.server = server
    s.view.status = 'running'
    s.view.url = server.url
    this.#line(s, `Serving ${dir} at ${server.url} (read-only, this computer only)`)
  }

  /** The rendered document view (document.ts): Dim Factory's own read-only loopback server, nothing spawned. */
  async #startDocument(s: Session, folder: string, cmd: PreviewCommand): Promise<void> {
    const doc = (cmd.docPath ?? '').replace(/\\/g, '/')
    const abs = resolve(folder, doc)
    if (doc === '' || cwdRelOf(folder, abs) === null)
      throw new DimFactoryError('VALIDATION', 'That document is outside the project')
    const server = await startDocumentServer(folder, doc, { onRequest: (line) => this.#line(s, line) })
    s.server = server
    s.docPath = doc
    s.view.status = 'running'
    s.view.url = server.url
    this.#line(s, `Showing ${doc} at ${server.url} (read-only, this computer only)`)
  }

  /** The document a running `document` session shows (its folder and path), for Save as PDF. */
  documentOf(id: string): { folder: string; docPath: string } | undefined {
    const s = this.#sessions.get(id)
    if (s === undefined || s.view.kind !== 'document' || s.docPath === undefined) return undefined
    return { folder: s.view.folder, docPath: s.docPath }
  }

  async #startProcess(s: Session, r: PreviewStartRequest): Promise<void> {
    const cmd = r.command
    const root = resolve(r.scopeRoot)
    const argv = [...cmd.argv]
    const argv0 = argv[0] ?? ''
    if (argv0 === '') throw new DimFactoryError('VALIDATION', 'This preview has no command to run')
    const cwd = resolve(root, cmd.cwdRel)
    if (cwdRelOf(root, cwd) === null)
      throw new DimFactoryError('VALIDATION', 'Its folder is outside the project')
    // Trust, against the body as it is now (a run may have changed the script since it was shown).
    const read = await readPreviewBody(root, { argv, cwdRel: cmd.cwdRel })
    if (read.error !== undefined) throw new DimFactoryError('VALIDATION', read.error)
    const t = previewTrustOf({ argv, cwdRel: cmd.cwdRel }, read.body, r.grants)
    if (t.trust !== 'trusted') {
      throw new DimFactoryError(
        'FORBIDDEN',
        t.trust === 'changed'
          ? `${cmd.label} changed since you trusted it; review it and trust it again`
          : `${cmd.label} is not trusted yet; trust it first`,
        { details: { trust: t.trust, hash: t.hash } },
      )
    }
    const pathValue = await (this.#d.pathEnv ?? (async () => (await resolvePathEnv()).path))()
    const resolved = resolveCommand(argv0, { cwd, root, pathEntries: splitPathList(pathValue) })
    if (resolved === null) {
      this.#end(
        s,
        'failed',
        existsSync(cwd)
          ? `Dim Factory could not find ${argv0}. Install it, or run the project another way.`
          : 'Its working folder does not exist',
      )
      s.markEnded()
      return
    }
    const env = previewChildEnv(this.#d.env ?? process.env, pathValue, cwd)
    await mkdir(join(this.#dir(), 'logs'), { recursive: true })
    const log = await CappedLog.open(join(this.#dir(), 'logs', `${s.view.id}.log`))
    s.log = log
    s.view.logPath = log.path
    log.write(`$ ${displayArgv(argv)}${cmd.cwdRel !== '.' ? `   (in ${cmd.cwdRel})` : ''}\n`)
    let inv = {
      command: resolved.path,
      args: argv.slice(1),
      windowsVerbatimArguments: false,
    }
    let child: ChildHandle
    try {
      if (resolved.batch) inv = batchInvocation(resolved.path, argv.slice(1), { env })
      child = await spawnChild({
        command: inv.command,
        args: inv.args,
        cwd,
        env,
        label: { purpose: 'preview', ...(r.runId !== undefined ? { runId: r.runId } : {}), step: 'preview' },
        stdin: 'ignore',
        maxLineBytes: 1024 * 1024,
        ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (err) {
      const e = SpawnError.from(err, inv.command)
      this.#end(s, 'failed', `It could not start: ${e.message}`)
      await log.close().catch(() => undefined)
      s.markEnded()
      return
    }
    s.child = child
    // Stop came while it was starting: the tree goes at once.
    if (s.stopping !== undefined) void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    else s.view.status = 'running'
    if (cmd.urlHint !== undefined) {
      s.view.url = cmd.urlHint
      s.urlFromHint = true
    }
    this.#d.log.info('preview started', { id: s.view.id, pid: child.pid, kind: cmd.kind })
    const table = await this.#procTable()
    const rec = await table?.add(procRecordFor(child, 'preview', 'preview')).catch(() => undefined)
    this.#armTouch()
    const pump = async (stream: StdStream): Promise<void> => {
      for await (const one of child.records(stream)) {
        this.#line(s, one.kind === 'line' ? one.line : `${one.head}… [a line of ${one.bytes} bytes]`)
      }
    }
    void (async () => {
      const pumps = Promise.all([pump('stdout'), pump('stderr')])
      const exit = await child.exited
      await pumps.catch(() => undefined)
      const stopped = s.stopping !== undefined
      if (rec !== undefined) {
        await table
          ?.markExit(rec.id, {
            code: exit.code,
            signal: exit.signal,
            at: Date.now(),
            how: stopped ? 'killed' : 'exited',
          })
          .catch(() => undefined)
      }
      if (stopped) this.#end(s, 'stopped', 'Stopped')
      else if (exit.code === 0) this.#end(s, 'exited', 'It finished', 0)
      else {
        const how = exit.code !== null ? `with code ${exit.code}` : `by ${exit.signal ?? 'a signal'}`
        this.#end(s, 'failed', `It ended ${how}`, exit.code)
      }
      log.write(`[${s.view.reason ?? s.view.status}]\n`)
      await log.close().catch(() => undefined)
      this.#armTouch()
      s.markEnded()
    })()
  }

  /** One line of output (or of the static server's requests): the log, the tail, the URL. */
  #line(s: Session, raw: string): void {
    const line = cleanLine(raw)
    s.log?.write(`${raw}\n`)
    s.view.lines++
    s.view.tail.push(cut(line))
    if (s.view.tail.length > PREVIEW_TAIL_LINES)
      s.view.tail.splice(0, s.view.tail.length - PREVIEW_TAIL_LINES)
    if (s.view.kind === 'server' && (s.view.url === null || s.urlFromHint === true)) {
      const url = parsePreviewUrl(line)
      if (url !== null) {
        s.view.url = url
        s.urlFromHint = false
        this.#emitNow(s)
        return
      }
    }
    this.#emitSoon(s)
  }

  #end(s: Session, status: 'stopped' | 'exited' | 'failed', reason: string, code?: number | null): void {
    s.view.status = status
    s.view.reason = reason
    s.view.endedAt = this.#now()
    if (code !== undefined) s.view.exitCode = code
    this.#emitNow(s)
  }

  /** Stop a preview: its process tree is killed (the static server closes). Resolves once it has ended. */
  async stop(id: string): Promise<void> {
    const s = this.#sessions.get(id)
    if (s === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
    if (!isLive(s.view)) return
    s.stopping ??= this.#stopSession(s)
    await s.stopping
  }

  async #stopSession(s: Session): Promise<void> {
    s.view.status = 'stopping'
    this.#emitNow(s)
    if (s.server !== undefined) {
      await s.server.close()
      this.#line(s, 'Stopped serving')
      this.#end(s, 'stopped', 'Stopped')
      s.markEnded()
      return
    }
    if (s.child !== undefined) {
      await stopChild(s.child, { stdinWaitMs: 0 }).catch((err: unknown) =>
        this.#d.log.warn('preview stop failed', { id: s.view.id, err }),
      )
    }
    await s.ended
  }

  /**
   * "Stop containers too" (a compose preview, on the user's click only): stop the compose command if it still runs,
   * then `docker compose down` for the same compose files, through the same trusted runner as the preview (its compose
   * files read again and checked against `grants`, argv[0] resolved, no shell, the sanitized env, recorded in
   * procs.json). Its output joins the session's; the view's `composeDown` says how it went. Resolves once it ended.
   */
  async composeDown(id: string, grants: TrustGrants): Promise<void> {
    const s = this.#sessions.get(id)
    if (s === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not listed any more.')
    const c = s.compose
    if (c === undefined) {
      throw new DimFactoryError('VALIDATION', 'Only a docker compose preview has containers to stop.')
    }
    if (this.#closed) throw new DimFactoryError('CONFLICT', 'Dim Factory is closing.')
    s.downing ??= this.#composeDown(s, c, grants).finally(() => {
      delete s.downing
      delete s.downChild
    })
    await s.downing
  }

  async #composeDown(s: Session, c: NonNullable<Session['compose']>, grants: TrustGrants): Promise<void> {
    const down = composeDownArgv(c.argv)
    if (down === null)
      throw new DimFactoryError('VALIDATION', 'Only a docker compose preview has containers to stop.')
    // Trust first: the compose files as they are now must still be the ones the user trusted.
    const read = await readPreviewBody(c.scopeRoot, { argv: c.argv, cwdRel: c.cwdRel })
    if (read.error !== undefined) throw new DimFactoryError('VALIDATION', read.error)
    const t = previewTrustOf({ argv: c.argv, cwdRel: c.cwdRel }, read.body, grants)
    if (t.trust !== 'trusted') {
      throw new DimFactoryError(
        'FORBIDDEN',
        t.trust === 'changed'
          ? `${s.view.label} changed since you trusted it; review it and trust it again`
          : `${s.view.label} is not trusted yet; trust it first`,
        { details: { trust: t.trust, hash: t.hash } },
      )
    }
    if (isLive(s.view)) await this.stop(s.view.id)
    s.view.composeDown = { status: 'running' }
    this.#emitNow(s)
    const finish = (status: 'done' | 'failed', reason?: string): void => {
      s.view.composeDown = { status, ...(reason !== undefined ? { reason } : {}) }
      this.#emitNow(s)
    }
    const cwd = resolve(c.scopeRoot, c.cwdRel)
    if (cwdRelOf(c.scopeRoot, cwd) === null) return finish('failed', 'Its folder is outside the project')
    const pathValue = await (this.#d.pathEnv ?? (async () => (await resolvePathEnv()).path))()
    const argv0 = down[0] ?? ''
    const resolved = resolveCommand(argv0, { cwd, root: c.scopeRoot, pathEntries: splitPathList(pathValue) })
    if (resolved === null) return finish('failed', `Dim Factory could not find ${argv0}.`)
    const env = previewChildEnv(this.#d.env ?? process.env, pathValue, cwd)
    this.#line(s, `$ ${displayArgv(down)}${c.cwdRel !== '.' ? `   (in ${c.cwdRel})` : ''}`)
    let inv = { command: resolved.path, args: down.slice(1), windowsVerbatimArguments: false }
    let child: ChildHandle
    try {
      if (resolved.batch) inv = batchInvocation(resolved.path, down.slice(1), { env })
      child = await spawnChild({
        command: inv.command,
        args: inv.args,
        cwd,
        env,
        label: { purpose: 'preview', ...(c.runId !== undefined ? { runId: c.runId } : {}), step: 'preview' },
        stdin: 'ignore',
        maxLineBytes: 1024 * 1024,
        ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (err) {
      return finish('failed', `It could not start: ${SpawnError.from(err, inv.command).message}`)
    }
    s.downChild = child
    this.#d.log.info('preview compose down started', { id: s.view.id, pid: child.pid })
    const table = await this.#procTable()
    const rec = await table?.add(procRecordFor(child, 'preview', 'preview')).catch(() => undefined)
    this.#armTouch()
    const pump = async (stream: StdStream): Promise<void> => {
      for await (const one of child.records(stream)) {
        this.#line(s, one.kind === 'line' ? one.line : `${one.head}… [a line of ${one.bytes} bytes]`)
      }
    }
    const pumps = Promise.all([pump('stdout'), pump('stderr')])
    const exit = await child.exited
    await pumps.catch(() => undefined)
    if (rec !== undefined) {
      await table
        ?.markExit(rec.id, { code: exit.code, signal: exit.signal, at: Date.now(), how: 'exited' })
        .catch(() => undefined)
    }
    this.#armTouch()
    if (exit.code === 0) finish('done', 'Containers stopped')
    else {
      const how = exit.code !== null ? `with code ${exit.code}` : `by ${exit.signal ?? 'a signal'}`
      finish('failed', `docker compose down ended ${how}`)
    }
  }

  /** Quit: every running preview is stopped (process trees killed, servers closed); nothing new starts. */
  async stopAll(): Promise<void> {
    this.#closed = true
    const running = [...this.#sessions.values()].filter((s) => isLive(s.view))
    await Promise.all(running.map((s) => this.stop(s.view.id).catch(() => undefined)))
    const downs = [...this.#sessions.values()].flatMap((s) =>
      s.downChild !== undefined ? [s.downChild] : [],
    )
    await Promise.all(downs.map((c) => stopChild(c, { stdinWaitMs: 0 }).catch(() => undefined)))
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#timers.clear()
    if (this.#touch !== undefined) clearInterval(this.#touch)
    this.#touch = undefined
  }

  /**
   * Launch: preview processes a previous session left running (it crashed, or was killed) are killed, their records
   * settled. Only processes Dim Factory recorded (pid, start time and executable all match) and their children.
   */
  async sweepOrphans(): Promise<number> {
    const table = await this.#procTable()
    if (table === undefined || table.records().length === 0) return 0
    const r = await table.sweep()
    // Settled records are history; the file keeps only what may still need a sweep.
    await table.replace(r.records.filter((x) => x.exit === undefined))
    if (r.killed.length > 0) this.#d.log.warn('preview: killed leftovers', { pids: r.killed })
    return r.killed.length
  }

  #procTable(): Promise<ProcTable | undefined> {
    if (this.#d.recordProcs !== true) return Promise.resolve(undefined)
    this.#table ??= (async () => {
      try {
        await mkdir(this.#dir(), { recursive: true })
        return await ProcTable.open(join(this.#dir(), 'procs.json'))
      } catch (err) {
        this.#d.log.warn('preview procs.json unavailable', { err })
        return undefined
      }
    })()
    return this.#table
  }

  /** procs.json's mtime is the session's sign of life while children run (the relaunch sweep's bound). */
  #armTouch(): void {
    const running = [...this.#sessions.values()].some(
      (s) => s.child !== undefined && s.view.endedAt === undefined,
    )
    if (running && this.#touch === undefined && this.#d.recordProcs === true) {
      this.#touch = setInterval(() => {
        void this.#table?.then((t) => t?.touch()).catch(() => undefined)
      }, TOUCH_EVERY_MS)
      this.#touch.unref?.()
    } else if (!running && this.#touch !== undefined) {
      clearInterval(this.#touch)
      this.#touch = undefined
    }
  }

  /** Keep the running sessions and the newest ENDED_KEPT ended ones. */
  #prune(): void {
    const ended = [...this.#sessions.values()].filter((s) => s.view.endedAt !== undefined)
    for (const s of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) this.#sessions.delete(s.view.id)
  }

  /** "Allow internet for this preview" (or back to this computer only): what its windows' pages may reach. */
  setNetwork(id: string, mode: PreviewNetworkMode): PreviewSessionView {
    const s = this.#sessions.get(id)
    if (s === undefined || s.view.network === undefined)
      throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
    if (s.view.network !== mode) {
      s.view.network = mode
      this.#d.log.info('preview network', { id, mode })
      this.#emitNow(s)
    }
    return copy(s.view)
  }

  /** Phone size on or off for a game's preview window (main sizes the window; the view says so for the panels). */
  setPhone(id: string, on: boolean): void {
    const s = this.#sessions.get(id)
    if (s === undefined || s.view.game !== true) return
    if ((s.view.phone === true) === on) return
    if (on) s.view.phone = true
    else delete s.view.phone
    this.#emitNow(s)
  }

  /** A request to another computer its page made while loopback-only: counted, its host kept (the first few). */
  recordBlocked(id: string, url: string): void {
    const s = this.#sessions.get(id)
    if (s === undefined) return
    let host: string
    try {
      host = new URL(url).host
    } catch {
      host = '?'
    }
    const b = s.view.blocked ?? { count: 0, hosts: [] }
    const hosts =
      b.hosts.includes(host) || b.hosts.length >= PREVIEW_BLOCKED_HOSTS_MAX ? b.hosts : [...b.hosts, host]
    s.view.blocked = { count: b.count + 1, hosts }
    this.#emitSoon(s)
  }

  #emitNow(s: Session): void {
    const t = this.#timers.get(s.view.id)
    if (t !== undefined) clearTimeout(t)
    this.#timers.delete(s.view.id)
    try {
      this.#d.emit?.(copy(s.view))
    } catch {
      // a listener's failure never stops a preview
    }
  }

  #emitSoon(s: Session): void {
    if (this.#timers.has(s.view.id)) return
    const t = setTimeout(() => {
      this.#timers.delete(s.view.id)
      this.#emitNow(s)
    }, this.#d.emitEveryMs ?? EMIT_EVERY_MS)
    t.unref?.()
    this.#timers.set(s.view.id, t)
  }
}

function copy(v: PreviewSessionView): PreviewSessionView {
  return {
    ...v,
    tail: [...v.tail],
    ...(v.blocked !== undefined ? { blocked: { count: v.blocked.count, hosts: [...v.blocked.hosts] } } : {}),
  }
}

/** Remove the logs of previews from earlier sessions (launch). */
export async function clearPreviewLogs(paths: HomePaths): Promise<void> {
  await rm(join(paths.home, 'preview', 'logs'), { recursive: true, force: true }).catch(() => undefined)
}
