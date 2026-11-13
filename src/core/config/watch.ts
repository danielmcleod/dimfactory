// dimfactory.json watcher: the file watcher watches the parent directory, filtering by basename.
// Atomic saves replace the file by rename, which breaks a watch on the file itself, so each target is watched through
// its directory. When that directory does not exist yet (a project without `.dimfactory/`), the nearest existing
// ancestor is watched until it appears. Rename events re-arm the watch. Events are debounced (250 ms) and emitted
// only when the file's content hash changed, as `config-changed {scope, folder?}`.
//
// Trade-off on Windows: a directory watch holds an open handle on that directory, and Windows refuses to rename or
// move a directory while a handle inside it is open. That is fine for DIM_FACTORY_HOME, but not for the user's project
// folders, so a target with `pollMs` (the service uses it for project files on win32) polls the file's stat instead:
// no handle is held between polls, at the cost of noticing an edit up to `pollMs` later.
import { unwatchFile, watch, watchFile } from 'node:fs'
import type { FSWatcher, Stats, StatsListener } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { ConfigScope } from '../../shared/config-schema.ts'
import { realPath } from '../real-path.ts'
import { readConfigText } from './backups.ts'

export const CONFIG_WATCH_DEBOUNCE_MS = 250

export interface ConfigWatchTarget {
  scope: ConfigScope
  /** Project scope: the folder (passed through to the event). */
  folder?: string
  /** The dimfactory.json to watch. */
  path: string
  /** Poll the file's stat every `pollMs` instead of watching its directory (no directory handle is held). */
  pollMs?: number
}

/** Poll interval for project files on Windows (see the header). */
export const PROJECT_POLL_MS = 1000

/** Payload of the `config-changed` AppEvent. */
export interface ConfigChangedEvent {
  scope: ConfigScope
  folder?: string
}

export interface ConfigWatchOptions {
  debounceMs?: number
  /** Emit even when the content hash did not change (default false). */
  emitUnchanged?: boolean
  /** Watch errors that could not be recovered by re-arming (default: ignored). */
  onError?: (err: unknown, target: ConfigWatchTarget) => void
}

export interface Disposable {
  dispose(): void
}

const sameName = (a: string, b: string): boolean =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

type WatchSettings = Required<Pick<ConfigWatchOptions, 'debounceMs' | 'emitUnchanged'>> &
  Pick<ConfigWatchOptions, 'onError'>

/** One watched file. */
class FileWatch implements Disposable {
  private readonly file: string
  private watcher: FSWatcher | null = null
  /** The directory being watched and the child name (toward the file) that matters in it. */
  private watched: { dir: string; name: string } | null = null
  private timer: NodeJS.Timeout | null = null
  private rearmTimer: NodeJS.Timeout | null = null
  /** Poll mode (`target.pollMs`): the watchFile listener. */
  private poller: StatsListener | null = null
  private lastSha: string | null | undefined = undefined
  private disposed = false
  private arming: Promise<void> = Promise.resolve()
  private readonly target: ConfigWatchTarget
  private readonly emit: (ev: ConfigChangedEvent) => void
  private readonly opts: WatchSettings

  constructor(target: ConfigWatchTarget, emit: (ev: ConfigChangedEvent) => void, opts: WatchSettings) {
    this.target = target
    this.emit = emit
    this.opts = opts
    this.file = resolve(target.path)
  }

  /** Start watching; resolves once the first watch is armed and the baseline hash is read. */
  async start(): Promise<void> {
    this.lastSha = (await readConfigText(this.file).catch(() => null))?.sha256 ?? null
    if (this.target.pollMs !== undefined) {
      if (this.disposed) return
      // watchFile calls back only when the stat changed (an atomic save changes mtime/ino; appearing/vanishing too).
      const listener = (cur: Stats, prev: Stats): void => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) this.schedule()
      }
      this.poller = listener
      watchFile(this.file, { persistent: false, interval: this.target.pollMs }, listener)
      return
    }
    await this.rearm()
  }

  private rearm(): Promise<void> {
    this.arming = this.arming
      .then(() => this.arm())
      .catch((err: unknown) => this.opts.onError?.(err, this.target))
    return this.arming
  }

  private async arm(): Promise<void> {
    if (this.disposed) return
    // Nearest existing directory on the way to the file, and the child name to look for in it.
    let dir = dirname(this.file)
    let name = basename(this.file)
    while (!(await isDirectory(dir))) {
      const parent = dirname(dir)
      if (parent === dir) return
      name = basename(dir)
      dir = parent
    }
    if (this.disposed) return
    if (this.watcher && this.watched?.dir === dir && this.watched.name === name) return
    // Watch the folder by its real name: libuv asserts (and kills the process) when a watched Windows folder is
    // spelled with an 8.3 short name and a change inside it reports the long one.
    const real = await realPath(dir)
    if (this.disposed) return
    this.close()
    let w: FSWatcher
    try {
      w = watch(real, { persistent: false }, (event, filename) => this.onEvent(event, filename))
    } catch (err) {
      this.opts.onError?.(err, this.target)
      return
    }
    w.on('error', () => {
      // The directory went away or the handle broke (EPERM on Windows when a watched folder is deleted).
      this.scheduleRearm(true)
    })
    this.watcher = w
    this.watched = { dir, name }
    // The file may have appeared while nothing was watching it.
    if (name !== basename(this.file) || dir !== dirname(this.file)) return
    this.schedule()
  }

  private onEvent(event: string, filename: string | Buffer | null): void {
    if (this.disposed || this.watched === null) return
    const name = filename === null ? null : filename.toString()
    if (name !== null && !sameName(name, this.watched.name)) return
    // A rename (atomic save, folder created or removed) re-arms on a fresh handle; content changes just debounce.
    if (event === 'rename') this.scheduleRearm(true)
    this.schedule()
  }

  private scheduleRearm(fresh: boolean): void {
    if (this.disposed) return
    if (fresh) this.close()
    if (this.rearmTimer) return
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = null
      void this.rearm().then(() => this.schedule())
    }, 20)
    this.rearmTimer.unref()
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
    }, this.opts.debounceMs)
    this.timer.unref()
  }

  private async check(): Promise<void> {
    if (this.disposed) return
    let sha: string | null
    try {
      sha = (await readConfigText(this.file))?.sha256 ?? null
    } catch (err) {
      this.opts.onError?.(err, this.target)
      return
    }
    if (this.disposed) return
    if (!this.opts.emitUnchanged && sha === this.lastSha) return
    this.lastSha = sha
    this.emit({
      scope: this.target.scope,
      ...(this.target.folder !== undefined ? { folder: this.target.folder } : {}),
    })
  }

  private close(): void {
    this.watcher?.close()
    this.watcher = null
    this.watched = null
  }

  dispose(): void {
    this.disposed = true
    this.close()
    if (this.poller !== null) unwatchFile(this.file, this.poller)
    this.poller = null
    if (this.timer) clearTimeout(this.timer)
    if (this.rearmTimer) clearTimeout(this.rearmTimer)
    this.timer = null
    this.rearmTimer = null
  }
}

/**
 * Watch config files and call `onChange` (debounced, content-changed only). `add` returns a disposer for one target;
 * `dispose()` stops everything.
 */
export class ConfigWatcher implements Disposable {
  private readonly watches = new Map<string, FileWatch>()
  private readonly opts: WatchSettings
  private readonly onChange: (ev: ConfigChangedEvent) => void
  private disposed = false

  constructor(onChange: (ev: ConfigChangedEvent) => void, opts: ConfigWatchOptions = {}) {
    this.onChange = onChange
    this.opts = {
      debounceMs: opts.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS,
      emitUnchanged: opts.emitUnchanged ?? false,
      ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
    }
  }

  private static key(t: ConfigWatchTarget): string {
    const p = resolve(t.path)
    const mode = t.pollMs !== undefined ? `poll:${t.pollMs}` : 'dir'
    return `${t.scope}|${t.folder ?? ''}|${mode}|${process.platform === 'win32' ? p.toLowerCase() : p}`
  }

  /** Start watching `target` (idempotent per scope + folder + path). Resolves once armed. */
  async add(target: ConfigWatchTarget): Promise<() => void> {
    if (this.disposed) throw new Error('ConfigWatcher is disposed')
    const key = ConfigWatcher.key(target)
    let fw = this.watches.get(key)
    if (!fw) {
      fw = new FileWatch(target, (ev) => this.onChange(ev), this.opts)
      this.watches.set(key, fw)
      await fw.start()
    }
    return () => this.remove(target)
  }

  remove(target: ConfigWatchTarget): void {
    const key = ConfigWatcher.key(target)
    this.watches.get(key)?.dispose()
    this.watches.delete(key)
  }

  dispose(): void {
    this.disposed = true
    for (const w of this.watches.values()) w.dispose()
    this.watches.clear()
  }
}

/** Watch a single config file. */
export async function watchConfigFile(
  target: ConfigWatchTarget,
  onChange: (ev: ConfigChangedEvent) => void,
  opts: ConfigWatchOptions = {},
): Promise<Disposable> {
  const w = new ConfigWatcher(onChange, opts)
  await w.add(target)
  return w
}
