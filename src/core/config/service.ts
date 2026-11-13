// The config system as the core uses it: load + resolve per run folder, the inputs of the config
// preflight checks, the `config.*` / `prompts.*` / `trust.*` commands, first launch, the editor schema and the file
// watcher (→ `config-changed`). app-core owns one instance; handlers.ts calls it.
//
// Layer 0's `profile` is the one first launch would pick for the vendors that are ready (claude-only on a machine
// without a usable Codex), so a home with no `profile` anywhere runs exactly as the first builds did.
import { statSync } from 'node:fs'
import type {
  ConfigScope,
  ProvenanceMap,
  ResolvedConfig,
  RunOverrides,
  SemanticOptions,
  Timeouts,
} from '../../shared/config-schema.ts'
import type { JsonPatchOp } from '../../shared/failure.ts'
import type {
  ConfigReadResult,
  ConfigSaveRequest,
  EditablePromptName,
  PromptName,
  PromptView,
  ResolvedWithProvenance,
  TrustGrantInput,
  TrustGrants,
  TrustState,
} from '../../shared/ipc.ts'
import { PASS_NAMES } from '../../shared/run.ts'
import { recipeOverrides } from '../../shared/recipes.ts'
import type { RecipeView } from '../../shared/recipes.ts'
import type { PassName } from '../../shared/run.ts'
import { projectRecipeSha } from '../recipes/load.ts'
import type { ProbeResult } from '../../shared/vendors.ts'
import type { AdapterRegistry } from '../adapters/registry.ts'
import { PRIMARY_VENDORS } from '../adapters/registry.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import type { Logger } from '../log.ts'
import type { ConfigFileState, PreflightConfigFiles } from '../preflight/engine.ts'
import { isPlainObject, readVersionedJson } from '../store/versions.ts'
import { configLocation, listBackups, restoreBackup, restoreLastGood } from './backups.ts'
import type { ConfigLocation, ConfigWriteOutcome, FolderScope } from './backups.ts'
import { BUILTIN_DEFAULTS, builtinLayerWith } from './defaults.ts'
import type { BuiltinLayer, BuiltinProfileName } from './defaults.ts'
import { isVendorReady, readinessOf, runFirstLaunch, selectFirstLaunchProfile } from './firstLaunch.ts'
import { composerSuggestions } from './suggestions.ts'
import type { ReadyVendorInfo } from './suggestions.ts'
import type { FirstLaunchOutcome, FirstLaunchReadiness } from './firstLaunch.ts'
import { loadConfigFile, parseConfigText, toConfigLayer } from './load.ts'
import type { ConfigLayer, LoadResult } from './load.ts'
import { locateProjectConfig, writeConfigSchema } from './paths.ts'
import { getPromptView, savePrompt } from './prompt-files.ts'
import { deepMerge } from './merge.ts'
import { parseJsonPointer } from './provenance.ts'
import { loadAndResolve, resolve } from './resolve.ts'
import type { ConfigResolveError, LoadedConfig } from './resolve.ts'
import { patchConfig, saveOverrides } from './save.ts'
import type { ConfigTextValidator } from './save.ts'
import { getTrust, isLargeFolderGranted, setTrust, trustGrantsFor } from './trust.ts'
import { ConfigWatcher, PROJECT_POLL_MS } from './watch.ts'
import { withDirect } from '../depth/decide.ts'
import type { ConfigChangedEvent, ConfigWatchTarget } from './watch.ts'

/** Project folders watched at once (least recently resolved dropped first). */
export const MAX_WATCHED_FOLDERS = 16

export interface ConfigServiceDeps {
  paths: HomePaths
  /** No writes at all: no last-good, no schema, no watcher, every write command FORBIDDEN. */
  readOnly: boolean
  log: Logger
  adapters: AdapterRegistry
  /** The launch-probe store (preflight cache): vendor readiness for first launch and the default profile. */
  probeOf: (vendor: string) => ProbeResult | undefined
  /** Stores a launch probe so preflight reuses it. */
  recordProbe: (probe: ProbeResult) => void
  /** The folder's scope (git top level and folderKey); cached by the caller. */
  scopeOf: (folder: string) => Promise<FolderScope>
  /** Untracked size for a largeFolder grant (folder.size's numbers). */
  folderSize?: (folder: string) => Promise<{ files: number; bytes: number }>
  /** A config file changed on disk or through a command: invalidate caches, emit `config-changed`. */
  onChange: (ev: ConfigChangedEvent) => void
  now: () => number
}

/** One load + resolve for a folder and a run layer. */
export interface ConfigSnapshot {
  folder?: string
  scopeRoot: string | null
  folderKey: string | null
  /** The recipe the snapshot resolved with (its config layer sits between the project file and `run`). */
  recipe?: RecipeView
  run?: unknown
  loaded: LoadedConfig
  /** Present when the resolve succeeded. */
  config?: ResolvedConfig
  provenance: ProvenanceMap
  /** Profile names every layer defines (run.profile). */
  profiles: string[]
  error?: ConfigResolveError
}

/** The user layer's vendor settings at boot (adapters are created from them). */
export interface UserVendorSettings {
  profile?: string
  vendors: ResolvedConfig['vendors']
  /** `file:line:col message` for each error in the user file. */
  issues: string[]
  load: LoadResult
}

const issueLine = (i: { file: string; line: number; col: number; message: string }): string =>
  `${i.file}:${i.line}:${i.col} ${i.message}`

/** `segs` removed from a plain-object tree (in place); empty parents stay (resolve treats `{}` as "inherit"). */
function deleteAt(root: Record<string, unknown>, segs: readonly string[]): void {
  let cur: unknown = root
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isPlainObject(cur)) return
    cur = cur[segs[i] as string]
  }
  const last = segs[segs.length - 1]
  if (isPlainObject(cur) && last !== undefined) delete cur[last]
}

function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function valueAt(root: unknown, segs: readonly string[]): unknown {
  let cur: unknown = root
  for (const s of segs) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[s]
  }
  return cur
}

export class ConfigService {
  readonly #d: ConfigServiceDeps
  #watcher: ConfigWatcher | undefined
  /** folder (case-folded key) → disposer, in resolve order (oldest first). */
  readonly #watchedFolders = new Map<string, () => void>()
  #user: LoadResult | undefined

  constructor(d: ConfigServiceDeps) {
    this.#d = d
  }

  get readOnly(): boolean {
    return this.#d.readOnly
  }

  // ---- boot ------------------------------------------------------------------------------------------------------

  /**
   * Boot: the editor schema (writable cores) and the user file (vendors for the adapters; an invalid file gives the
   * builtins, and app.config.user blocks runs).
   */
  async init(): Promise<UserVendorSettings> {
    const { paths, readOnly, log } = this.#d
    if (!readOnly) {
      await writeConfigSchema(paths).catch((err: unknown) =>
        log.warn('could not write the dimfactory.json schema', { err }),
      )
    }
    const load = await this.reloadUser()
    for (const i of load.issues.filter((x) => x.severity === 'error')) {
      log.warn('user config problem', { issue: issueLine(i) })
    }
    return { ...vendorSettings(load), load }
  }

  /** Watch the user file (and, from then on, the project file of every resolved folder). Writable cores only. */
  async startWatching(): Promise<void> {
    const { paths, readOnly, log } = this.#d
    if (readOnly || this.#watcher !== undefined) return
    this.#watcher = new ConfigWatcher((ev) => this.#d.onChange(ev), {
      onError: (err, target) => log.warn('config watch failed', { err, path: target.path }),
    })
    await this.#watcher
      .add({ scope: 'user', path: paths.userConfig })
      .catch((err: unknown) => log.warn('could not watch the user config', { err }))
  }

  /** Re-read the user file (stores last-good when valid on writable cores). */
  async reloadUser(): Promise<LoadResult> {
    const { paths, readOnly } = this.#d
    const load = await loadConfigFile(paths.userConfig, {
      scope: 'user',
      managedFlags: this.managedFlags(),
      forbiddenFlags: this.forbiddenFlags(),
      ...(readOnly ? {} : { paths }),
    })
    this.#user = load
    return load
  }

  /** The user file as last loaded. */
  get user(): LoadResult | undefined {
    return this.#user
  }

  dispose(): void {
    this.#watcher?.dispose()
    this.#watcher = undefined
    this.#watchedFolders.clear()
  }

  // ---- readiness and the default profile ---------------------------------------------------------------------------

  /** Claude / Codex readiness from the launch-probe store (Codex also needs autoedit support). */
  readiness(): FirstLaunchReadiness {
    const out: FirstLaunchReadiness = {}
    for (const v of PRIMARY_VENDORS) {
      const entry = this.#d.adapters.list().find((e) => e.id === v)
      out[v] = readinessOf(entry?.adapter, this.#d.probeOf(v), entry?.built === true)
    }
    return out
  }

  /**
   * The profile used while no layer sets one: first launch's choice once Claude has been probed; before that, the
   * original rule (balanced only when Codex can run Implement in autoedit, else claude-only). With Codex built,
   * "can run Implement in autoedit" also needs its probe to have passed (Codex counts as ready only when it
   * is ready and `support({mode:'autoedit'}) ≠ unsupported`); an adapter that was never probed has not said yet.
   */
  defaultProfile(): BuiltinProfileName {
    const r = this.readiness()
    if (this.#d.probeOf('claude') !== undefined) return selectFirstLaunchProfile(r).profile
    return isVendorReady(r.codex, { requireAutoedit: true }) ? 'balanced' : 'claude-only'
  }

  builtinLayer(): BuiltinLayer {
    return builtinLayerWith(this.defaultProfile())
  }

  /** `vendors.<id>.flagMap` / `extraArgs` are checked against the built adapters' managed flags. */
  managedFlags(): Record<string, readonly string[]> {
    const out: Record<string, readonly string[]> = {}
    for (const e of this.#d.adapters.list()) if (e.built) out[e.id] = e.adapter.managedFlags
    return out
  }

  /**
   * `vendors.<id>.extraArgs` may not carry a built adapter's forbidden flags either (alone or as a
   * letter of a combined short flag), so the load check refuses what the spawn check would.
   */
  forbiddenFlags(): Record<string, readonly string[]> {
    const out: Record<string, readonly string[]> = {}
    for (const e of this.#d.adapters.list()) {
      if (e.built && e.adapter.forbiddenFlags !== undefined) out[e.id] = e.adapter.forbiddenFlags
    }
    return out
  }

  // ---- load + resolve ----------------------------------------------------------------------------------------------

  /** Load the user and project files for `folder` and resolve with the run layer. Never throws for config problems. */
  /**
   * The folder's config as a run would take it. A config whose `depth` is `direct` (Quick: from a file, or the run's
   * choice or decision) is resolved again with the Quick shape under the run's own overrides (depth/decide.ts
   * withDirect), so the composer's pass rows, the checks, the estimate and the run all see the same passes.
   */
  async snapshot(
    o: { folder?: string; overrides?: unknown; profile?: string; recipe?: RecipeView } = {},
  ): Promise<ConfigSnapshot> {
    const first = await this.#snapshotOnce(o)
    if (first.config?.depth !== 'direct') return first
    const ready = this.readyVendors().map((v) => v.id)
    return this.#snapshotOnce({
      ...o,
      overrides: withDirect(first.config, ready, o.overrides as RunOverrides | undefined),
    })
  }

  async #snapshotOnce(
    o: { folder?: string; overrides?: unknown; profile?: string; recipe?: RecipeView } = {},
  ): Promise<ConfigSnapshot> {
    const { paths, readOnly } = this.#d
    let scope: FolderScope | null = null
    if (o.folder !== undefined) scope = await this.#d.scopeOf(o.folder).catch(() => null)
    const loaded = await loadAndResolve({
      paths,
      ...(o.folder !== undefined ? { folder: o.folder } : {}),
      scopeRoot: scope?.scopeRoot ?? null,
      folderKey: scope?.folderKey ?? null,
      ...(o.recipe !== undefined
        ? {
            recipe: {
              id: o.recipe.recipe.id,
              // A user or project recipe's file (the badge's link); a built-in one has none to open.
              ...(o.recipe.layer !== 'builtin' ? { file: o.recipe.path } : {}),
              value: recipeOverrides(o.recipe.recipe),
            },
          }
        : {}),
      ...(o.overrides !== undefined ? { run: o.overrides } : {}),
      ...(o.profile !== undefined ? { profile: o.profile } : {}),
      managedFlags: this.managedFlags(),
      forbiddenFlags: this.forbiddenFlags(),
      builtin: this.builtinLayer(),
      storeLastGood: !readOnly,
    })
    this.#user = loaded.user
    // Armed before returning: once a folder has resolved, edits to its project file are noticed.
    if (o.folder !== undefined && loaded.project !== null) {
      await this.#watchProject(o.folder, loaded.project.file)
    }
    return {
      ...(o.folder !== undefined ? { folder: o.folder } : {}),
      scopeRoot: scope?.scopeRoot ?? null,
      folderKey: scope?.folderKey ?? null,
      ...(o.recipe !== undefined ? { recipe: o.recipe } : {}),
      ...(o.overrides !== undefined ? { run: o.overrides } : {}),
      loaded,
      ...(loaded.result !== undefined ? { config: loaded.result.config } : {}),
      provenance: loaded.result?.provenance ?? {},
      profiles: loaded.result?.profiles ?? knownProfileNames(loaded, this.builtinLayer()),
      ...(loaded.error !== undefined ? { error: loaded.error } : {}),
    }
  }

  /** Watch a resolved folder's project file (an existing folder only; the 16 most recent folders). */
  async #watchProject(folder: string, path: string): Promise<void> {
    const w = this.#watcher
    if (w === undefined) return
    if (!isDirectorySync(folder)) return
    const key = process.platform === 'win32' ? `${folder}|${path}`.toLowerCase() : `${folder}|${path}`
    const existing = this.#watchedFolders.get(key)
    if (existing !== undefined) {
      // Most recently used goes last.
      this.#watchedFolders.delete(key)
      this.#watchedFolders.set(key, existing)
      return
    }
    // On Windows a directory watch would stop the user renaming or moving the project folder (watch.ts header).
    const target: ConfigWatchTarget = {
      scope: 'project',
      folder,
      path,
      ...(process.platform === 'win32' ? { pollMs: PROJECT_POLL_MS } : {}),
    }
    this.#watchedFolders.set(key, () => w.remove(target))
    for (const [oldest, remove] of this.#watchedFolders) {
      if (this.#watchedFolders.size <= MAX_WATCHED_FOLDERS) break
      remove()
      this.#watchedFolders.delete(oldest)
    }
    await w.add(target).then(
      () => undefined,
      (err: unknown) => this.#d.log.warn('could not watch a project config', { err, path }),
    )
  }

  /** PreflightInput.configFiles for a snapshot (`restorable` is looked up only for a file with errors). */
  async preflightFiles(s: ConfigSnapshot): Promise<PreflightConfigFiles> {
    const { user, project } = s.loaded
    const state = async (r: LoadResult): Promise<ConfigFileState> => ({
      scope: r.scope,
      path: r.file,
      exists: r.exists,
      sha256: r.sha256,
      issues: r.issues,
      restorable: r.issues.some((i) => i.severity === 'error')
        ? await this.#restorable(r.scope, s.folder, s)
        : false,
    })
    const runAuto = isPlainObject(s.run) ? s.run['auto'] : undefined
    // A recipe that says whether Auto is on decides it over the project file (its own grant is folder.trust.recipeAuto).
    const recipeAuto = s.recipe?.recipe.auto
    const out: PreflightConfigFiles = {
      user: await state(user),
      project:
        project !== null
          ? {
              ...(await state(project)),
              // The project file is what turns Auto on: neither the run nor the user decided it.
              setsAuto:
                project.value?.auto === true &&
                runAuto === undefined &&
                recipeAuto === undefined &&
                user.value?.auto !== true,
            }
          : null,
    }
    if (s.error !== undefined) {
      out.error = { code: s.error.code, message: s.error.message, issues: s.error.issues }
    }
    return out
  }

  async #restorable(scope: ConfigScope, folder: string | undefined, s: ConfigSnapshot): Promise<boolean> {
    try {
      const loc = await this.#location(scope, folder, s)
      return (await listBackups(loc)).length > 0
    } catch {
      return false
    }
  }

  async #folderScope(
    folder: string,
    s?: Pick<ConfigSnapshot, 'scopeRoot' | 'folderKey'>,
  ): Promise<FolderScope> {
    if (s?.scopeRoot != null && s.folderKey != null) return { scopeRoot: s.scopeRoot, folderKey: s.folderKey }
    return this.#d.scopeOf(folder)
  }

  async #location(
    scope: ConfigScope,
    folder: string | undefined,
    s?: Pick<ConfigSnapshot, 'scopeRoot' | 'folderKey'>,
  ): Promise<ConfigLocation> {
    if (scope === 'project') {
      if (folder === undefined || folder === '') {
        throw new DimFactoryError('VALIDATION', 'A project config needs a folder')
      }
      return configLocation('project', folder, {
        home: this.#d.paths.home,
        folderScope: await this.#folderScope(folder, s),
      })
    }
    return configLocation('user', undefined, { home: this.#d.paths.home })
  }

  // ---- config.* --------------------------------------------------------------------------------------------------------

  /** `config.resolve`: VALIDATION (with the issues) when the layers do not resolve. */
  async resolveView(req: {
    folder?: string
    overrides?: RunOverrides
    recipe?: RecipeView
  }): Promise<ResolvedWithProvenance> {
    const s = await this.snapshot({
      ...(req.folder !== undefined ? { folder: req.folder } : {}),
      ...(req.recipe !== undefined ? { recipe: req.recipe } : {}),
      ...(req.overrides !== undefined ? { overrides: req.overrides } : {}),
    })
    if (s.config === undefined) {
      throw new DimFactoryError('VALIDATION', s.error?.message ?? 'The config could not be resolved', {
        details: { code: s.error?.code, issues: s.error?.issues ?? [], configIssues: s.loaded.issues },
      })
    }
    return {
      config: s.config,
      provenance: s.provenance,
      issues: s.loaded.issues,
      layers: s.loaded.layers,
      scopeRoot: s.scopeRoot,
      folderKey: s.folderKey,
      profiles: s.profiles,
      suggestions: composerSuggestions(s.config, this.readyVendors(), (v) => this.#d.adapters.resolveId(v)),
    }
  }

  /** Built vendors whose launch probe (with any auth re-check) passed, in picker order (Claude, Codex, …). */
  readyVendors(): ReadyVendorInfo[] {
    return this.#d.adapters
      .list()
      .filter((e) => e.built && this.#d.probeOf(e.id)?.ok === true)
      .map((e): ReadyVendorInfo => {
        const caps = this.#d.probeOf(e.id)?.capabilities
        return {
          id: e.id,
          support: (pass, mode) =>
            e.adapter.support({ pass, mode, planNative: false, trustFolder: false }).status,
          // decideSession's resume / model-switch rules (suggestions.ts, the same as `pass.fix.resume`).
          ...(caps !== undefined
            ? { capabilities: { resume: caps.resume, resumeModelSwitch: caps.resumeModelSwitch } }
            : {}),
          // An Experimental vendor is never suggested (suggestions.ts).
          ...(e.experimental ? { experimental: true } : {}),
        }
      })
  }

  /** `config.read`: the file text, its issues and its backups. */
  async read(req: { scope: ConfigScope; folder?: string }): Promise<ConfigReadResult> {
    const loc = await this.#location(req.scope, req.folder)
    const r = await loadConfigFile(loc.path, {
      scope: req.scope,
      managedFlags: this.managedFlags(),
      forbiddenFlags: this.forbiddenFlags(),
      ...(req.scope === 'project' ? { inheritedTimeouts: this.#userTimeouts() } : {}),
      ...(this.#d.readOnly
        ? {}
        : {
            paths: this.#d.paths,
            ...(loc.folderScope !== undefined
              ? { folderKey: loc.folderScope.folderKey, scopeRoot: loc.folderScope.scopeRoot }
              : {}),
          }),
    })
    const raw = r.raw
    const version = isPlainObject(raw) && typeof raw['version'] === 'number' ? raw['version'] : 1
    // Listed after the load: a load without errors stores the last-good copy.
    const list = await listBackups(loc)
    return {
      path: loc.path,
      exists: r.exists,
      text: r.text,
      value: raw ?? null,
      issues: r.issues,
      version,
      backups: list,
      // Settings → Config file: whether "Restore last good" has a copy to restore.
      lastGood: list.some((b) => b.kind === 'last-good'),
      restorable: list.length > 0,
    }
  }

  #writable(): void {
    if (this.#d.readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }

  /** The loader's validator (did-you-mean suggestions) for writes. */
  #validator(): ConfigTextValidator {
    return (text, ctx) =>
      parseConfigText(text, {
        file: ctx.file,
        scope: ctx.scope,
        ...(ctx.semantic?.inheritedTimeouts !== undefined
          ? { inheritedTimeouts: ctx.semantic.inheritedTimeouts }
          : {}),
        ...(ctx.semantic?.managedFlags !== undefined ? { managedFlags: ctx.semantic.managedFlags } : {}),
        ...(ctx.semantic?.forbiddenFlags !== undefined
          ? { forbiddenFlags: ctx.semantic.forbiddenFlags }
          : {}),
      }).issues
  }

  /** Semantic inputs for writes: managed flags, and the user's timeouts under a project file. */
  #semantic(): Omit<SemanticOptions, 'scope'> {
    return {
      managedFlags: this.managedFlags(),
      forbiddenFlags: this.forbiddenFlags(),
      inheritedTimeouts: this.#userTimeouts(),
    }
  }

  /** The timeouts below a project file: the builtin defaults under the user file's. */
  #userTimeouts(): Timeouts {
    return deepMerge<Timeouts>(BUILTIN_DEFAULTS.timeouts, this.#user?.value?.timeouts)
  }

  #changed(scope: ConfigScope, folder?: string): void {
    this.#d.onChange({ scope, ...(scope === 'project' && folder !== undefined ? { folder } : {}) })
  }

  /** `config.save`: the composer's "Save to project" (one row) / "Save as project default" (minimal diff). */
  async save(req: ConfigSaveRequest): Promise<ConfigWriteOutcome> {
    this.#writable()
    const folder = req.folder
    const s = await this.snapshot(folder !== undefined ? { folder } : {})
    const folderScope =
      req.scope === 'project' && folder !== undefined ? await this.#folderScope(folder, s) : undefined
    const target =
      req.scope === 'user'
        ? toConfigLayer(s.loaded.user)
        : s.loaded.project !== null
          ? toConfigLayer(s.loaded.project)
          : undefined
    // "Save as project default" writes the composer's profile (never pruned, save.ts): it is the profile in effect
    // for the target file after the save, so pass values are compared with that profile's.
    const profile = req.mode === 'projectDefault' ? req.overrides.profile : undefined
    const inherited = (pointer: string): unknown =>
      this.#inheritedAt(req.scope, pointer, {
        layer: target,
        ...(profile !== undefined ? { profile } : {}),
        ...(s.loaded.projectRoot !== null ? { folder: s.loaded.projectRoot } : {}),
      })
    const out = await saveOverrides({
      scope: req.scope,
      ...(folder !== undefined ? { folder } : {}),
      mode: req.mode,
      ...(req.mode === 'row' ? { pass: req.pass } : {}),
      overrides: req.overrides,
      resolveInherited: inherited,
      home: this.#d.paths.home,
      ...(folderScope !== undefined ? { folderScope } : {}),
      semantic: this.#semantic(),
      validate: this.#validator(),
    })
    if (out.changed) this.#changed(req.scope, folder)
    return out
  }

  /**
   * The value the target file inherits at `pointer`: the builtin layer under the target file without its own key
   * there. The other file layer is left out — a project file is committed and shared, and teammates do not have this
   * user's dimfactory.json, so a project key is never pruned for matching the saver's personal settings (and the
   * user file does not depend on any one project). `profile` is the profile the save writes (in effect after it).
   * An override equal to the result is redundant. `undefined` when the layers do not resolve (nothing is pruned).
   */
  #inheritedAt(
    scope: ConfigScope,
    pointer: string,
    l: { layer: ConfigLayer | undefined; profile?: string; folder?: string },
  ): unknown {
    let segs: string[]
    try {
      segs = parseJsonPointer(pointer)
    } catch {
      return undefined
    }
    const value = structuredClone(l.layer?.value ?? {}) as Record<string, unknown>
    if (l.profile !== undefined) value['profile'] = l.profile
    deleteAt(value, segs)
    const below: ConfigLayer = { ...l.layer, value }
    try {
      const r = resolve({
        builtin: this.builtinLayer(),
        ...(scope === 'user' ? { user: below } : { project: below }),
        ...(l.folder !== undefined ? { folder: l.folder } : {}),
        home: this.#d.paths.home,
      })
      const v = valueAt(r.config, segs)
      const [top, pass, key] = segs
      if (top === 'passes' && segs.length === 3 && PASS_NAMES.includes(pass as PassName)) {
        // A template override names a template; the resolved value is the file it found.
        if (key === 'promptTemplate') {
          const name = isPlainObject(v) ? v['name'] : undefined
          return name === pass ? null : name
        }
        // A model (an effort) filled from vendors.<v>.defaultModel (defaultEffort), or left to the CLI, was null in the
        // layers.
        const src = r.provenance[pointer]?.source
        if ((key === 'model' || key === 'effort') && (src === 'vendor' || src === 'cli')) return null
      }
      return v
    } catch {
      return undefined
    }
  }

  /**
   * `config.patch` (Settings sections, the PlanGate "don't stop" checkbox): any schema-valid path; user-only paths
   * always go to the user file. A persisted recovery `config_patch` passes `allowlist: true` (the `config_patch`
   * allowlist, with the adapters' managed flags).
   */
  async patch(req: {
    scope: ConfigScope
    folder?: string
    ops: readonly JsonPatchOp[]
    allowlist?: boolean
  }): Promise<ConfigWriteOutcome> {
    this.#writable()
    const folderScope =
      req.scope === 'project' && req.folder !== undefined ? await this.#folderScope(req.folder) : undefined
    const out = await patchConfig({
      scope: req.scope,
      ...(req.folder !== undefined ? { folder: req.folder } : {}),
      ops: req.ops,
      allowlist: req.allowlist === true,
      home: this.#d.paths.home,
      ...(folderScope !== undefined ? { folderScope } : {}),
      semantic: this.#semantic(),
      validate: this.#validator(),
    })
    for (const w of out.writes) if (w.changed) this.#changed(w.scope, w.folder ?? req.folder)
    return out
  }

  /** `config.restoreBackup`: a write backup, or `last-good` ("Restore last good": last-good, else the newest backup). */
  async restoreBackup(req: {
    scope: ConfigScope
    folder?: string
    backupId: string
  }): Promise<ConfigWriteOutcome> {
    this.#writable()
    const opts = {
      home: this.#d.paths.home,
      ...(req.scope === 'project' && req.folder !== undefined
        ? { folderScope: await this.#folderScope(req.folder) }
        : {}),
    }
    const out =
      req.backupId === 'last-good'
        ? await restoreLastGood(req.scope, req.folder, opts)
        : await restoreBackup(req.scope, req.folder, req.backupId, opts)
    if (out.changed) this.#changed(req.scope, req.folder)
    return out
  }

  // ---- prompts.* ---------------------------------------------------------------------------------------------------------

  /** Prompt lookup roots for a folder: the project root is the folder holding the project's `.dimfactory/`. */
  async #promptOptions(
    folder: string | undefined,
  ): Promise<{ home: string; projectRoot?: string; folderKey?: string; scopeRoot?: string }> {
    const home = this.#d.paths.home
    if (folder === undefined) return { home }
    const fs = await this.#d.scopeOf(folder).catch(() => null)
    const loc = await locateProjectConfig(folder, fs?.scopeRoot ?? null)
    return {
      home,
      projectRoot: loc.root,
      ...(fs !== null ? { folderKey: fs.folderKey, scopeRoot: fs.scopeRoot } : {}),
    }
  }

  /** `prompts.get`: the pass prompt as it resolves for `folder` (project → user → builtin), with its overrides. */
  async promptGet(req: { name: PromptName; folder?: string }): Promise<PromptView> {
    return getPromptView(req.name, await this.#promptOptions(req.folder))
  }

  /** `prompts.save`: write (or with `text: null` remove) the user or project override, with a backup. */
  async promptSave(req: {
    name: EditablePromptName
    scope: ConfigScope
    folder?: string
    text: string | null
  }): Promise<PromptView> {
    this.#writable()
    if (req.scope === 'project' && req.folder === undefined) {
      throw new DimFactoryError('VALIDATION', 'A project prompt needs a folder')
    }
    const o = await this.#promptOptions(req.folder)
    const { backupId: _backup, ...view } = await savePrompt({
      ...o,
      name: req.name,
      scope: req.scope,
      text: req.text,
    })
    this.#changed(req.scope, req.folder)
    return view
  }

  // ---- trust.* -------------------------------------------------------------------------------------------------------------

  /** The folder's grants as stored (stale ones included), with `projectAuto` for the project file it uses. */
  async trustGrants(folder: string): Promise<TrustGrants> {
    return trustGrantsFor(folder, { home: this.#d.paths.home, folderScope: await this.#d.scopeOf(folder) })
  }

  async hasLargeFolderGrant(folder: string, size: { files: number; bytes: number }): Promise<boolean> {
    return isLargeFolderGranted(await this.trustGrants(folder), size)
  }

  async trustGet(folder: string): Promise<TrustState> {
    return getTrust(folder, { home: this.#d.paths.home, folderScope: await this.#d.scopeOf(folder) })
  }

  /** `trust.set`; a recovery `grant` of a command passes the script `body` its hash covers. */
  async trustSet(req: {
    folder: string
    grant: TrustGrantInput
    trusted: boolean
    body?: string
  }): Promise<TrustState> {
    this.#writable()
    const folderScope = await this.#d.scopeOf(req.folder)
    let size: { files: number; bytes: number } | undefined
    if (req.grant.kind === 'largeFolder' && req.trusted) {
      if (this.#d.folderSize === undefined) {
        throw new DimFactoryError('UNSUPPORTED', 'The folder size cannot be measured here.')
      }
      const r = await this.#d.folderSize(req.folder)
      size = { files: r.files, bytes: r.bytes }
    }
    // A project recipe's Auto grant covers the recipe file as it is now (and only the version the user was shown).
    const recipeSha =
      req.grant.kind === 'recipeAuto' && req.trusted
        ? await projectRecipeSha(req.folder, req.grant.recipeId)
        : undefined
    const state = await setTrust(req.folder, req.grant, req.trusted, {
      home: this.#d.paths.home,
      folderScope,
      ...(size !== undefined ? { size } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(recipeSha !== undefined ? { recipeSha } : {}),
    })
    this.#changed('project', req.folder)
    return state
  }

  // ---- first launch --------------------------------------------------------------------------------------------------------

  /**
   * First launch: once per home. Probes the built primary vendors not probed yet (recorded for preflight),
   * picks a profile from the readiness matrix and writes it to the user dimfactory.json when that file has none.
   * Read-only cores do nothing (null).
   */
  async firstLaunch(): Promise<FirstLaunchOutcome | null> {
    if (this.#d.readOnly) return null
    const { paths, adapters, log } = this.#d
    const state = await readVersionedJson<Record<string, unknown>>(paths.state).catch(() => null)
    if (state?.kind === 'ok') {
      const at = state.value['firstLaunchCompletedAt']
      if (typeof at === 'number') return { status: 'already-done', at }
    }
    // An invalid user file cannot take a profile, and its `vendors` section cannot be trusted to name the binaries
    // to probe: wait for a launch where it is valid.
    const user = await this.reloadUser()
    if (user.exists && user.value === undefined) {
      return {
        status: 'deferred',
        reason: 'user-config-invalid',
        selection: selectFirstLaunchProfile(this.readiness()),
      }
    }
    for (const v of PRIMARY_VENDORS) {
      const entry = adapters.list().find((e) => e.id === v)
      if (entry?.built !== true || this.#d.probeOf(v) !== undefined) continue
      try {
        this.#d.recordProbe(await entry.adapter.probe({}))
      } catch (err) {
        log.warn('first-launch probe failed', { vendor: v, err: errorMessage(err) })
      }
    }
    const outcome = await runFirstLaunch({
      paths,
      readiness: this.readiness(),
      now: this.#d.now,
      writeProfile: async (profile) => {
        await patchConfig({
          scope: 'user',
          ops: [{ op: 'add', path: '/profile', value: profile }],
          allowlist: false,
          home: paths.home,
          validate: this.#validator(),
        })
        this.#changed('user')
      },
    })
    if (outcome.status === 'completed' && outcome.wroteProfile) {
      log.info('first launch chose a profile', { profile: outcome.selection.profile })
    }
    return outcome
  }
}

/** The vendor settings in a loaded user file (empty when the file is invalid: builtins apply). */
export function vendorSettings(load: LoadResult): Omit<UserVendorSettings, 'load'> {
  const issues = load.issues.filter((i) => i.severity === 'error').map(issueLine)
  const cfg = load.value
  const vendors: ResolvedConfig['vendors'] = {}
  for (const [id, v] of Object.entries(cfg?.vendors ?? {})) {
    vendors[id] = {
      path: v.path ?? null,
      defaultModel: v.defaultModel ?? null,
      defaultEffort: v.defaultEffort ?? null,
      extraArgs: v.extraArgs ?? [],
      env: v.env ?? {},
      flagMap: v.flagMap ?? {},
    }
  }
  return { ...(cfg?.profile !== undefined ? { profile: cfg.profile } : {}), vendors, issues }
}

/** Profile names from the layers that loaded (the resolve failed, so it did not list them). */
function knownProfileNames(loaded: LoadedConfig, builtin: BuiltinLayer): string[] {
  const out: string[] = Object.keys(builtin.profiles)
  for (const r of [loaded.user, loaded.project]) {
    for (const name of Object.keys(r?.value?.profiles ?? {})) if (!out.includes(name)) out.push(name)
  }
  return out
}
