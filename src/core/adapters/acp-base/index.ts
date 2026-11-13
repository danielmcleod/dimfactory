// The ACP base adapter: createAcpAdapter(config) turns a
// vendor's AcpVendorConfig into the registry's Adapter contract. Gemini is gemini/index.ts; Grok and the
// on-request Cursor, OpenCode and Copilot vendors are configs on top of this base.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CheckResult } from '../../../shared/preflight.ts'
import type { ModelInfo, ProbeResult, ReadinessNeed, Support } from '../../../shared/vendors.ts'
import { resolveHome } from '../../home.ts'
import { registerSignalTable, signalTableFor } from '../../heal/classify.ts'
import { acpSignals, exitRulesOf } from '../../heal/signals/acp-gemini.ts'
import type { EnvInput } from '../../proc/env.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import type { ResolveResult, ResolvedCli } from '../../proc/resolve-cli.ts'
import { resolveCli, toResolvedBinary } from '../../proc/resolve-cli.ts'
import { AdapterError, makeFailure } from '../errors.ts'
import type {
  Adapter,
  CanResumeResult,
  ListModelsOptions,
  ProbeOptions,
  RunHandle,
  StartOptions,
  StopReason,
} from '../types.ts'
import { PURPOSE_LABEL, readonlyAllowRulesCopy } from './allow-rules.ts'
import type { SessionInfo } from './client.ts'
import type { AcpFacts, AcpHandshake, AcpTiming, AcpVendorConfig } from './config.ts'
import { acpEnv, acpExtraArgsProblem, acpFlagMapProblem } from './launch.ts'
import {
  acpCapabilities,
  acpSupport,
  binCheck,
  factsFrom,
  planCheck,
  probeHandshake,
  protocolCheck,
  protocolConfigCheck,
  runHelp,
  versionCheck,
} from './probe.ts'
import type { HelpText } from './probe.ts'
import { AcpRun, DEFAULT_ACP_TIMING, effectiveMode } from './run.ts'
import type { SpawnHook } from './run.ts'
import { folderTrust, isDimFactoryOwnedCwd } from './trust.ts'

export type {
  AcpFacts,
  AcpHandshake,
  AcpLaunch,
  AcpLaunchInput,
  AcpModeSpec,
  AcpTiming,
  AcpVendorConfig,
} from './config.ts'
export { AcpNormalizer } from './normalize.ts'
export { AcpRun } from './run.ts'
export type { SpawnHook } from './run.ts'

export interface AcpAdapterOptions {
  /** `vendors.<id>.path`. */
  configuredPath?: string | null
  /** `vendors.<id>.env` (user config). */
  vendorEnv?: Record<string, string>
  /** `vendors.<id>.{extraArgs,flagMap}`: the probe's agent uses them like a pass does. */
  extraArgs?: string[]
  flagMap?: Record<string, string>
  /** Dim Factory's own env (default process.env). */
  env?: EnvInput
  /** The user's home folder (credential files are checked for existence only). */
  home?: string
  /** DIM_FACTORY_HOME (default from the env): its working folders need no trust grant. */
  dimFactoryHome?: string
  /** A fixed PATH for search and children (tests); default: path-env. */
  pathEnv?: string
  /** Working directory of the probe (default `<DIM_FACTORY_HOME>/tmp/probe-cwd`). Dim Factory's own: trusted. */
  probeCwd?: string
  now?: () => number
  timing?: Partial<AcpTiming>
  /** Test seam: replaces binary resolution. */
  resolve?: (force: boolean) => Promise<ResolveResult>
  /** `configured`: look only at `configuredPath` (E2E hosts, never a real install); default the full search. */
  search?: 'all' | 'configured'
  /** Test seam: what a probe would have found before any probe ran. */
  initialFacts?: Partial<AcpFacts>
  /** After spawn, before the first stdin write (procs.json). */
  onSpawn?: SpawnHook
  /**
   * An extra trust.json lookup for a folder (the engine already answers it for a run's folder through
   * StartOptions.trustFolder, preflight through ReadinessNeed.trustFolder). A lookup that throws grants nothing.
   */
  folderGranted?: (cwd: string, vendor: string) => Promise<boolean>
}

/** The registry's adapter plus what the executor and the tests reach for. */
export interface AcpAdapter extends Adapter {
  readonly config: AcpVendorConfig
  resolveBinary(force?: boolean): Promise<ResolveResult>
  /** What the last probe found (modes, load/resume): support(), start() and canResume() read it. */
  facts(): AcpFacts
}

const READINESS_TTL_MS = 60_000

/**
 * The classifier's table for an ACP vendor without its own: the ACP rows, the config's exit codes and its own
 * failure texts (`signalRegex`, checked first).
 */
function ensureSignalTable(cfg: AcpVendorConfig): void {
  if (signalTableFor(cfg.id) !== undefined) return
  registerSignalTable(
    acpSignals(cfg.id, {
      exit: exitRulesOf(cfg.id, cfg.exitCodes),
      ...(cfg.signalRegex !== undefined ? { regex: cfg.signalRegex } : {}),
    }),
  )
}

export function defaultAcpFacts(cfg: AcpVendorConfig, initial: Partial<AcpFacts> = {}): AcpFacts {
  return { probed: false, loadSession: false, resume: false, plan: cfg.planMode === 'native', ...initial }
}

export function createAcpAdapter(cfg: AcpVendorConfig, opts: AcpAdapterOptions = {}): AcpAdapter {
  ensureSignalTable(cfg)
  const baseEnv: EnvInput = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const dimFactoryHome = opts.dimFactoryHome ?? resolveHome({ env: baseEnv, userHome: home })
  const now = opts.now ?? Date.now
  const timing: AcpTiming = { ...DEFAULT_ACP_TIMING, ...cfg.timing, ...opts.timing }
  const childEnvInput = (): EnvInput => ({ ...baseEnv, ...opts.vendorEnv })
  let facts: AcpFacts = defaultAcpFacts(cfg, opts.initialFacts)
  let models: ModelInfo[] = []
  let resolved: Promise<ResolveResult> | undefined
  let probed: Promise<ProbeResult> | undefined

  const pathEnv = async (): Promise<string | undefined> =>
    opts.pathEnv ?? (await resolvePathEnv({ env: baseEnv })).path

  const resolveBinary = (force = false): Promise<ResolveResult> => {
    if (resolved === undefined || force) {
      const p = opts.resolve
        ? opts.resolve(force)
        : pathEnv().then((path) =>
            resolveCli(cfg.cliSpec, {
              configuredPath: opts.configuredPath ?? null,
              env: baseEnv,
              home,
              ...(path !== undefined ? { pathEnv: path } : {}),
              ...(opts.vendorEnv !== undefined ? { vendorEnv: opts.vendorEnv } : {}),
              ...(opts.search === 'configured' ? { candidates: 'configured' as const } : {}),
            }),
          )
      resolved = p
      p.catch(() => {
        if (resolved === p) resolved = undefined
      })
    }
    return resolved
  }

  const cliForRun = async (): Promise<ResolvedCli> => {
    const r = await resolveBinary()
    if (r.ok) return r.cli
    throw new AdapterError(
      makeFailure('cli_missing', `${cfg.displayName} is not installed or could not be started.`, {
        raw: r.rejected.map((x) => `${x.path}: ${x.detail}`).join('\n'),
        classifiedBy: 'app',
      }),
    )
  }

  const probeCwd = (): string => {
    const dir = opts.probeCwd ?? join(dimFactoryHome, 'tmp', 'probe-cwd')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const staticModels = (): ModelInfo[] =>
    (cfg.staticModels ?? []).map((m) => ({
      id: m.id,
      source: 'static' as const,
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.isDefault === true ? { isDefault: true } : {}),
    }))

  const runProbe = async (force: boolean): Promise<ProbeResult> => {
    const at = now()
    const r = await resolveBinary(force)
    const base = { vendor: cfg.id, at, route: 'acp' as const, transport: 'acp' as const }
    if (!r.ok) {
      facts = defaultAcpFacts(cfg, opts.initialFacts)
      models = []
      return {
        ...base,
        ok: false,
        checks: [binCheck(cfg, undefined, r.rejected, at)],
        capabilities: acpCapabilities(cfg, facts, 0),
        models: [],
      }
    }
    const cli = r.cli
    const env = acpEnv(baseEnv, {
      vendor: cfg.id,
      path: await pathEnv(),
      pathPrepend: cli.pathPrepend,
      vendorEnv: opts.vendorEnv,
    })
    const cwd = probeCwd()
    const flagProblem = acpExtraArgsProblem(cfg, opts.extraArgs) ?? acpFlagMapProblem(cfg, opts.flagMap)
    const helpP: Promise<HelpText | undefined> =
      cfg.probe.help !== undefined
        ? runHelp({ cli, args: cfg.probe.help.args, env, cwd }).catch((err: unknown) => ({
            error: err instanceof Error ? err.message : String(err),
          }))
        : Promise.resolve(undefined)
    // The handshake runs in Dim Factory's own probe folder, so the trust flag goes with it (only
    // there: a probe folder outside DIM_FACTORY_HOME is the user's, and gets no trust flag).
    const handshakeP: Promise<AcpHandshake | undefined> =
      flagProblem === undefined
        ? probeHandshake({
            launch: cfg.resolveLaunch({
              cli,
              model: undefined,
              trust: isDimFactoryOwnedCwd(cwd, dimFactoryHome),
              extraArgs: opts.extraArgs,
              flagMap: opts.flagMap,
              env,
              purpose: 'probe',
            }),
            cwd,
            // A vendor whose session/new only runs on Test ('forced') stops at initialize at launch.
            newSession: cfg.probe.newSession === 'forced' ? force : cfg.probe.newSession,
            timeoutMs: timing.initializeMs,
            requestMs: timing.requestMs,
          })
        : Promise.resolve(undefined)
    const [help, handshake] = await Promise.all([helpP, handshakeP])
    if (handshake !== undefined) facts = factsFrom(cfg, handshake, facts)
    // The handshake's session names the models; without one (no sign-in yet) the models an earlier session named
    // stay, else the vendor's static list.
    const cliModels = models.filter((m) => m.source === 'cli')
    models =
      handshake !== undefined && handshake.models.length > 0
        ? handshake.models
        : cliModels.length > 0
          ? cliModels
          : staticModels()
    const checks: CheckResult[] = [
      binCheck(cfg, cli, r.rejected, at),
      versionCheck(cfg, cli.version, help, at),
      cfg.probe.auth({ env: childEnvInput(), home, handshake, at }),
      handshake !== undefined
        ? protocolCheck(cfg, handshake, at)
        : protocolConfigCheck(cfg, flagProblem ?? 'the flags in your settings were refused', at),
      planCheck(cfg, facts, at),
    ]
    // Subscription auth is shown as an API-equivalent cost: the sign-in method only, never who or with what.
    const account = cfg.probe.account?.({ env: childEnvInput(), home, handshake, at })
    return {
      ...base,
      ok: !checks.some((c) => c.status === 'fail' && c.blocking),
      binary: toResolvedBinary(cli),
      version: cli.version,
      checks,
      capabilities: acpCapabilities(cfg, facts, models.filter((m) => m.source === 'cli').length),
      models,
      ...(account !== undefined ? { account } : {}),
    }
  }

  const support = (need: ReadinessNeed): Support => acpSupport(cfg, need, facts)

  /**
   * Cache the modes and models: a pass's session answer refreshes what the probe found (a probe that ran
   * before the sign-in could not start a session, so it named neither). Modes and models only; the agent's load and
   * resume capabilities stay the probe's.
   */
  const cacheSession = (info: SessionInfo): void => {
    if (info.models.length > 0) models = info.models.map((m) => ({ ...m }))
    if (info.modes !== undefined && info.modes.length > 0) {
      const modes = [...info.modes]
      facts = {
        ...facts,
        modes,
        plan: cfg.plan !== undefined && modes.includes(cfg.plan.acpMode),
      }
    }
  }

  const adapter: AcpAdapter = {
    id: cfg.id,
    displayName: cfg.displayName,
    transport: 'acp',
    managedFlags: cfg.managedFlags,
    forbiddenFlags: cfg.forbiddenFlags,
    ...(cfg.cliFlags !== undefined ? { cliFlags: cfg.cliFlags } : {}),
    testedUpTo: cfg.testedUpTo,
    versionFloor: cfg.versionFloor,
    versionRecommended: cfg.versionRecommended,
    config: cfg,
    resolveBinary,
    facts: () => ({ ...facts }),

    probe(o: ProbeOptions = {}): Promise<ProbeResult> {
      if (probed === undefined || o.force === true) {
        const p = runProbe(o.force === true)
        probed = p
        p.catch(() => {
          if (probed === p) probed = undefined
        })
      }
      return probed
    },

    async readiness(cwd: string, need: ReadinessNeed): Promise<CheckResult[]> {
      const at = now()
      const check = (
        id: string,
        status: CheckResult['status'],
        title: string,
        detail: string,
        extra: Partial<CheckResult> = {},
      ): CheckResult => ({
        id: `pass.${need.pass}.readiness.${id}`,
        scope: 'pass',
        status,
        blocking: status === 'fail',
        title,
        detail,
        recovery: [],
        at,
        ttlMs: READINESS_TTL_MS,
        ...extra,
      })
      const out: CheckResult[] = []
      const s = support(need)
      out.push(
        s.status === 'unsupported'
          ? check('mode', 'fail', `Mode not available for ${cfg.displayName}`, s.copy, {
              category: s.reason === 'mode-missing' ? 'flag_drift' : 'capability_missing',
            })
          : check('mode', 'pass', 'Mode', s.copy),
      )
      if (cfg.trustFlag !== undefined && cwd !== '') {
        // Readiness `trust`: a user folder needs the user's vendorFolder grant (Dim Factory's own need none).
        const t = await folderTrust({
          cwd,
          vendor: cfg.id,
          dimFactoryHome,
          engineTrusted: need.trustFolder,
          granted: opts.folderGranted ?? (() => Promise.resolve(false)),
        })
        out.push(
          t.trusted
            ? check(
                'trust',
                'pass',
                `Folder trusted for ${cfg.displayName}`,
                t.why === 'owned'
                  ? `A working folder of Dim Factory's own: ${cfg.displayName} runs here without asking about trust.`
                  : `You allowed ${cfg.displayName} to work in this folder.`,
              )
            : check(
                'trust',
                'fail',
                `${cfg.displayName} needs your OK for this folder`,
                `${cfg.displayName} only works in folders you trust. Trust this folder once and Dim Factory starts ${cfg.displayName} here without its own trust prompt; you can remove the trust in Settings.`,
                {
                  category: 'trust_required',
                  recovery: [
                    {
                      id: `${cfg.id}.trust-folder`,
                      label: `Trust this folder for ${cfg.displayName}`,
                      kind: 'grant',
                      grant: 'vendorFolder',
                      vendor: cfg.id,
                      detail: `Lets ${cfg.displayName} read and change files in this folder when a pass allows it. Dim Factory still asks you before edits and commands as each pass's mode says.`,
                    },
                  ],
                },
              ),
        )
      }
      // Grok: the user's own allow rules the agent applies before it asks. A read-only pass is not run
      // while any would let it change files unasked (rejecting every ask cannot stop them).
      const guard = cfg.readonlyAllowRules
      if (
        guard !== undefined &&
        cwd !== '' &&
        s.status !== 'unsupported' &&
        effectiveMode(need.pass, need.mode) === 'readonly'
      ) {
        const rules = guard.scan({ cwd, env: childEnvInput(), home })
        if (rules.length === 0) {
          out.push(
            check(
              guard.id,
              'pass',
              'No allow rules that change files',
              `${cfg.displayName} asks before every edit and command, and Dim Factory denies each one in this read-only pass.`,
            ),
          )
        } else {
          const copy = readonlyAllowRulesCopy(cfg.displayName, need.pass, rules, { cwd, home })
          const pass = need.pass === 'heal' || need.pass === 'catalog' ? 'all' : need.pass
          out.push(
            check(guard.id, 'fail', copy.title, copy.detail, {
              category: 'capability_missing',
              recovery: [
                {
                  id: `${cfg.id}.allow-rules.switch`,
                  label: pass === 'all' ? 'Use Claude instead' : `Use Claude for ${PURPOSE_LABEL[need.pass]}`,
                  kind: 'switch_vendor',
                  pass,
                  to: 'claude',
                  model: null,
                },
              ],
            }),
          )
        }
      }
      if (need.resumeSessionId !== undefined) {
        const r = await adapter.canResume(need.resumeSessionId, cwd)
        out.push(
          r.ok
            ? check(
                'resume',
                'pass',
                'Session can be continued',
                `${cfg.displayName} session ${need.resumeSessionId}`,
              )
            : check(
                'resume',
                'skip',
                'Fix will start a fresh session',
                `${cfg.displayName} cannot continue that session here.`,
              ),
        )
      }
      return out
    },

    support,

    canResume(sessionId: string, cwd: string): Promise<CanResumeResult> {
      // Token-free: the agent advertises session/load or session/resume, and (when the vendor can tell) its own
      // session store still has the session. No process is spawned.
      if (!facts.loadSession && !facts.resume) return Promise.resolve({ ok: false, reason: 'cannot-resume' })
      const exists = cfg.sessionExists?.({ sessionId, cwd, env: childEnvInput(), home })
      return Promise.resolve(exists === false ? { ok: false, reason: 'cannot-resume' } : { ok: true })
    },

    start(o: StartOptions): RunHandle {
      return new AcpRun(o, {
        config: cfg,
        resolve: cliForRun,
        baseEnv,
        pathEnv,
        vendorEnv: opts.vendorEnv,
        now,
        facts: { ...facts },
        dimFactoryHome,
        home,
        folderGranted: opts.folderGranted,
        planRoots: cfg.planFileRoots?.({ env: childEnvInput(), home }) ?? [],
        timing,
        onSpawn: opts.onSpawn,
        onSessionSetup: cacheSession,
      })
    },

    answer(h: RunHandle, requestId, d, why): void {
      if (h instanceof AcpRun) h.answer(requestId, d, why)
    },

    stop(h: RunHandle, reason: StopReason): Promise<void> {
      return h instanceof AcpRun ? h.stop(reason) : Promise.resolve()
    },

    async listModels(o: ListModelsOptions = {}): Promise<ModelInfo[]> {
      await adapter.probe(o.force === true ? { force: true } : {})
      return models.map((m) => ({ ...m }))
    },
  }
  return adapter
}
