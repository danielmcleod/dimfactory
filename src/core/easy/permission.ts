// Easy mode's project permission ("Allow these for this project" on the confirm screen): the one standing answer a
// user can give, for one new project folder Dim Factory created.
//
// - Stored as trust.json's `easyProject` grant on that folder (config/trust.ts), with the folder's path and file id as
//   created, and only by Easy's create, right after it made the folder. Nothing over IPC can grant it.
// - Held here in memory too, so every check is synchronous and current: an ask is checked when it comes (allow-cache's
//   AllowSource), and a revoke drops the folder from memory before anything is written, so it takes effect at once,
//   during a run as well.
// - Covers only Easy runs (the run's recipe is a built-in Easy recipe) whose pass works in that very folder (not a
//   subfolder, not an isolated copy), while the folder is still the one it was given for (same file id). What it
//   covers within that is core/easy/ask-tier.ts, and the run's own verify, install and preview commands.
// - Every use is logged to `<home>/easy/permission-uses.jsonl` and counted (per project and per run); every grant, use
//   and revoke is announced (`easy-permission`), so the screens show the count as it changes.
import { readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AllowRule } from '../../shared/events.ts'
import type { EasyPermissionView } from '../../shared/easy.ts'
import { EASY_RECIPES } from '../../shared/easy.ts'
import type { EasyProjectGrant } from '../../shared/ipc.ts'
import type { RunRecipe } from '../../shared/recipes.ts'
import type { AllowQuery, AllowSource } from '../adapters/allow-cache.ts'
import type { Logger } from '../log.ts'
import { realPathSync } from '../real-path.ts'
import { classifyAsk } from './ask-tier.ts'
import type { CoveredUse, ProjectFacts } from './ask-tier.ts'

/** The log of uses, in `<home>/easy/`. */
const USES_LOG_NAME = 'permission-uses.jsonl'

export interface PermissionUse {
  at: number
  folder: string
  runId: string
  /** `install` / `script` / `registry` (an ask), or `command` (a verify, install or preview command Dim Factory ran). */
  what: CoveredUse | 'command'
  /** What was allowed, one line. */
  label: string
}

export interface PermissionDeps {
  home: string
  log: Logger
  now: () => number
  /** Every folder trust.json holds an `easyProject` grant for. */
  readGrants(): Promise<EasyProjectGrant[]>
  /** Write the grant (trust.json, on the folder's own scope). */
  writeGrant(folder: string, ino: string | undefined): Promise<EasyProjectGrant>
  /** Remove the grant from trust.json. */
  removeGrant(folder: string): Promise<void>
  /** Something changed for a folder (a grant, a use, a revoke). */
  changed(folder: string): void
  /** The folder's file id now (absent: unknown); the default reads it with stat. */
  fileId?: (folder: string) => string | undefined
  /** What the folder holds (package.json scripts and the Python manifests); the default reads them. */
  facts?: (folder: string) => ProjectFacts
}

/** What a run is, for the permission. */
export interface PermitRun {
  runId: string
  /** The run's folder. */
  folder: string
  /** Where the pass (or the command) works. */
  cwd: string
  recipe: RunRecipe | undefined
}

/**
 * Folders compare by their real names (an 8.3 short name or a linked temp folder is the folder it names; a folder that
 * is gone by its nearest existing parent), without case on Windows and macOS, and without a trailing separator.
 */
export function folderKey(folder: string): string {
  const f = realPathSync(folder).replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? f.toLowerCase() : f
}

/** A built-in Easy recipe (a user or project recipe of the same name never counts). */
export function isEasyRun(recipe: RunRecipe | undefined): boolean {
  return recipe !== undefined && recipe.layer === 'builtin' && EASY_RECIPES.includes(recipe.id)
}

/** The folder's file id (stat's `ino` as text); undefined when it cannot be read or the file system has none. */
export function fileIdOf(folder: string): string | undefined {
  try {
    const ino = statSync(folder, { bigint: true }).ino
    return ino > 0n ? ino.toString() : undefined
  } catch {
    return undefined
  }
}

/** package.json's scripts and the Python manifests at the folder's top, read now. */
export function readProjectFacts(folder: string): ProjectFacts {
  const exists = (name: string): boolean => {
    try {
      return statSync(join(folder, name)).isFile()
    } catch {
      return false
    }
  }
  let scripts: Record<string, string> | null = null
  try {
    // A small read on an ask, never more than a manifest's size.
    const st = statSync(join(folder, 'package.json'))
    if (st.isFile() && st.size <= 1024 * 1024) {
      const raw = JSON.parse(
        readFileSync(join(folder, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
      ) as unknown
      scripts = {}
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const s = (raw as Record<string, unknown>)['scripts']
        if (s !== null && typeof s === 'object' && !Array.isArray(s))
          for (const [k, v] of Object.entries(s as Record<string, unknown>))
            if (typeof v === 'string') scripts[k] = v
      }
    }
  } catch {
    scripts = null
  }
  return { scripts, requirements: exists('requirements.txt'), pyproject: exists('pyproject.toml') }
}

export class ProjectPermissions {
  readonly #d: PermissionDeps
  readonly #grants = new Map<string, EasyProjectGrant>()
  readonly #uses = new Map<string, number>()
  readonly #runUses = new Map<string, number>()
  #loaded: Promise<void> | undefined
  #chain: Promise<void> = Promise.resolve()

  constructor(d: PermissionDeps) {
    this.#d = d
  }

  #file(): string {
    return join(this.#d.home, 'easy', USES_LOG_NAME)
  }

  /** Read the grants and the counts once (core start); later calls wait on the same read. */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      const grants = await this.#d.readGrants().catch((err: unknown) => {
        this.#d.log.warn('easy project permissions could not be read; none apply', { err })
        return []
      })
      for (const g of grants) this.#grants.set(folderKey(g.folder), g)
      const text = await readFile(this.#file(), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const u = JSON.parse(line) as Partial<PermissionUse>
          if (typeof u.folder !== 'string' || typeof u.runId !== 'string') continue
          this.#count(u.folder, u.runId)
        } catch {
          // a torn last line is skipped
        }
      }
    })()
    return this.#loaded
  }

  #count(folder: string, runId: string): void {
    const k = folderKey(folder)
    this.#uses.set(k, (this.#uses.get(k) ?? 0) + 1)
    this.#runUses.set(runId, (this.#runUses.get(runId) ?? 0) + 1)
  }

  /** The grant for exactly this folder, now (undefined: none). */
  grantOf(folder: string): EasyProjectGrant | undefined {
    return this.#grants.get(folderKey(folder))
  }

  /** Give the permission to a folder Easy just created (its file id now binds the grant to it). */
  async grant(folder: string): Promise<EasyProjectGrant> {
    await this.load()
    const ino = (this.#d.fileId ?? fileIdOf)(folder)
    const g = await this.#d.writeGrant(folder, ino)
    this.#grants.set(folderKey(g.folder), g)
    this.#d.log.info('easy project permission given', { folder: g.folder })
    this.#d.changed(g.folder)
    return g
  }

  /** Take it back: it stops covering anything at once (memory first), then trust.json is written. */
  async revoke(folder: string): Promise<void> {
    await this.load()
    const had = this.#grants.delete(folderKey(folder))
    if (had) this.#d.changed(folder)
    try {
      await this.#d.removeGrant(folder)
    } finally {
      this.#d.log.info('easy project permission revoked', { folder })
    }
  }

  /** Every folder with the permission now, newest first, with its uses. */
  list(): EasyPermissionView[] {
    return [...this.#grants.values()]
      .map((g) => ({ folder: g.folder, at: g.at, uses: this.#uses.get(folderKey(g.folder)) ?? 0 }))
      .sort((a, b) => b.at - a.at)
  }

  /** The permission as a folder and a run read it (`granted` false: none, or revoked). */
  view(folder: string, runId?: string): EasyPermissionView & { granted: boolean; runUses: number } {
    const g = this.grantOf(folder)
    return {
      folder,
      at: g?.at ?? 0,
      granted: g !== undefined,
      uses: this.#uses.get(folderKey(folder)) ?? 0,
      runUses: runId !== undefined ? (this.#runUses.get(runId) ?? 0) : 0,
    }
  }

  /**
   * Whether the permission covers this run working in `cwd` now: an Easy run, in the very folder that holds the
   * grant, which is still the folder it was given for.
   */
  covers(r: PermitRun): boolean {
    if (!isEasyRun(r.recipe)) return false
    const g = this.grantOf(r.folder)
    if (g === undefined) return false
    if (folderKey(g.folder) !== folderKey(r.folder) || folderKey(r.cwd) !== folderKey(g.folder)) return false
    if (g.ino !== undefined) {
      const now = (this.#d.fileId ?? fileIdOf)(g.folder)
      if (now !== g.ino) return false
    }
    return true
  }

  /** Log one use (and announce it). */
  record(use: Omit<PermissionUse, 'at'>): void {
    const u: PermissionUse = { at: this.#d.now(), ...use }
    this.#count(u.folder, u.runId)
    this.#d.log.info('allowed under the easy project permission', {
      runId: u.runId,
      what: u.what,
      label: u.label,
    })
    const file = this.#file()
    this.#chain = this.#chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, `${JSON.stringify(u)}\n`, { mode: 0o600 })
      })
      .catch((err: unknown) => this.#d.log.warn('easy permission use could not be logged', { err }))
    this.#d.changed(u.folder)
  }

  /** Waits for the use log's writes (tests, shutdown). */
  flushed(): Promise<void> {
    return this.#chain
  }

  /**
   * The live allow-rule source for one pass of a run (StartOptions.permit), or undefined when the run is no Easy run
   * in a folder with the permission. Each ask is checked when it comes: the grant (a revoke since counts), the folder
   * binding, then ask-tier.ts; a covered ask is logged and answered with a rule made for it alone.
   */
  permitFor(r: PermitRun): AllowSource | undefined {
    if (!this.covers(r)) return undefined
    return (q: AllowQuery): AllowRule | undefined => {
      if (!this.covers(r)) return undefined
      const facts = (this.#d.facts ?? readProjectFacts)(r.folder)
      const c = classifyAsk(q, { folder: r.folder, cwd: r.cwd, facts })
      if (!c.covered || c.what === undefined) return undefined
      this.record({ folder: r.folder, runId: r.runId, what: c.what, label: c.label })
      return {
        vendor: q.vendor,
        kind: q.kind,
        tool: q.tool,
        match: q.argv !== undefined ? { argv: [...q.argv] } : q.host !== undefined ? { host: q.host } : {},
        source: 'project-permission',
      }
    }
  }
}
