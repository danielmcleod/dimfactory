// Where folder-scoped recovery actions are looked up (every action executes
// through `recovery.execute{actionId, runId?, folder?}`, and core is the authority). The composer got its actions
// from the latest live (or blocked authoritative) preflight report of a folder, so core keeps that report's actions
// per folder, and the app- and vendor-scope ones of the latest report of any folder (the setup card and vendor rows).
import { resolve } from 'node:path'
import type { RecoveryAction } from '../../shared/failure.ts'
import type { CheckResult, CheckScope, PreflightReport } from '../../shared/preflight.ts'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { PASS_NAMES } from '../../shared/run.ts'
import type { Mode, PassName } from '../../shared/run.ts'

/** Folders whose last report is kept (least recently used dropped first). */
export const RECOVERY_FOLDERS_MAX = 32

/** What a check said (a run-less "Diagnose with AI" diagnoses it). */
export type CheckFacts = Pick<CheckResult, 'title' | 'detail'> & { category?: CheckResult['category'] }

/**
 * The passes of the config a folder's report was checked with (the composer's, its run overrides included):
 * a run-less switch_vendor turns into run overrides for exactly the passes it moves.
 */
export type FolderPasses = Readonly<Record<PassName, { vendor: string; enabled: boolean; mode: Mode }>>

/** The FolderPasses of a resolved config. */
export function folderPassesOf(config: Pick<ResolvedConfig, 'passes'>): FolderPasses {
  const out = {} as Record<PassName, { vendor: string; enabled: boolean; mode: Mode }>
  for (const p of PASS_NAMES) {
    const c = config.passes[p]
    out[p] = { vendor: c.vendor, enabled: c.enabled, mode: c.mode }
  }
  return out
}

/** An action and the check that offered it. */
export interface StoredAction {
  action: RecoveryAction
  checkId: string
  scope: CheckScope
  check?: CheckFacts
}

/** Every action of a report's results, first occurrence of an id wins (checks repeat shared fixes). */
export function reportActions(report: PreflightReport): StoredAction[] {
  return resultActions([...report.blocking, ...report.warnings, ...report.info])
}

export function resultActions(results: readonly CheckResult[]): StoredAction[] {
  const seen = new Set<string>()
  const out: StoredAction[] = []
  for (const r of results) {
    for (const a of r.recovery) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push({ action: a, checkId: r.id, scope: r.scope })
    }
  }
  return out
}

/** Each action with what its check said (a run-less "Diagnose with AI" diagnoses that). */
function withChecks(results: readonly CheckResult[], actions: StoredAction[]): StoredAction[] {
  const facts = new Map<string, CheckFacts>()
  for (const r of results) {
    if (facts.has(r.id)) continue
    const f: CheckFacts = { title: r.title, detail: r.detail }
    if (r.category !== undefined) f.category = r.category
    facts.set(r.id, f)
  }
  return actions.map((a) => {
    const f = facts.get(a.checkId)
    return f !== undefined ? { ...a, check: f } : a
  })
}

/** The folder key a report is filed under (case-folded where the file system folds case). */
export function folderStoreKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(folder).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r
}

export class RecoveryActionStore {
  readonly #folders = new Map<string, Map<string, StoredAction>>()
  readonly #global = new Map<string, StoredAction>()
  readonly #passes = new Map<string, FolderPasses>()
  readonly #max: number

  constructor(o: { maxFolders?: number } = {}) {
    this.#max = Math.max(1, o.maxFolders ?? RECOVERY_FOLDERS_MAX)
  }

  /**
   * Replace the folder's actions with this report's; its app/vendor actions become the global ones. `passes`: the
   * config the report was checked with (absent: none kept for the folder).
   */
  record(folder: string, report: PreflightReport, passes?: FolderPasses): void {
    const key = folderStoreKey(folder)
    if (passes !== undefined) this.#passes.set(key, passes)
    else this.#passes.delete(key)
    const actions = withChecks(
      [...report.blocking, ...report.warnings, ...report.info],
      reportActions(report),
    )
    this.#folders.delete(key)
    this.#folders.set(key, new Map(actions.map((s) => [s.action.id, s])))
    while (this.#folders.size > this.#max) {
      const oldest = this.#folders.keys().next().value
      if (oldest === undefined) break
      this.#folders.delete(oldest)
      this.#passes.delete(oldest)
    }
    this.#global.clear()
    for (const s of actions) if (s.scope === 'app' || s.scope === 'vendor') this.#global.set(s.action.id, s)
  }

  /**
   * The app-scope results of a folder-less check (the Dashboard's setup card): their actions replace the app-scope
   * global ones (the vendor ones and every folder's stay).
   */
  recordApp(results: readonly CheckResult[]): void {
    for (const [id, s] of this.#global) if (s.scope === 'app') this.#global.delete(id)
    for (const s of withChecks(results, resultActions(results))) {
      if (s.scope === 'app') this.#global.set(s.action.id, s)
    }
  }

  /** The folder's last report action with this id. */
  folder(folder: string, actionId: string): StoredAction | undefined {
    return this.#folders.get(folderStoreKey(folder))?.get(actionId)
  }

  /** The passes of the config the folder's last report was checked with. */
  passes(folder: string): FolderPasses | undefined {
    return this.#passes.get(folderStoreKey(folder))
  }

  /** An app- or vendor-scope action of the latest report. */
  global(actionId: string): StoredAction | undefined {
    return this.#global.get(actionId)
  }

  /**
   * Actions a check's AI diagnosis suggested, executable from where the check was (its folder's report, else the
   * global ones) until that report is replaced. An id already stored is never taken over (a click on a
   * button showing one diagnosis must never run another one's fix); the ids it kept out are returned.
   */
  addSuggested(
    folder: string | undefined,
    from: Pick<StoredAction, 'checkId' | 'scope'>,
    actions: readonly RecoveryAction[],
  ): string[] {
    const target =
      folder !== undefined && from.scope !== 'app' && from.scope !== 'vendor'
        ? this.#folders.get(folderStoreKey(folder))
        : this.#global
    if (target === undefined) return actions.map((a) => a.id)
    const refused: string[] = []
    for (const a of actions) {
      if (target.has(a.id)) refused.push(a.id)
      else target.set(a.id, { action: a, checkId: from.checkId, scope: from.scope })
    }
    return refused
  }

  /** Forget a folder (its report described a state that no longer holds, e.g. after `git init`). */
  forget(folder: string): void {
    this.#folders.delete(folderStoreKey(folder))
    this.#passes.delete(folderStoreKey(folder))
  }

  get folderCount(): number {
    return this.#folders.size
  }
}
