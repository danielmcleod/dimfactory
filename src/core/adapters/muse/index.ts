// The Muse adapter on its exec route (`exec`, no relay, Experimental; transport
// 'muse-exec'). It replaces the registry stub (app-core registers it; the registry marks Muse Experimental, and no
// built-in profile names it). Readonly is unsupported, autoedit is `--disable-approval` (degraded), full is `--yolo`.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CheckResult } from '../../../shared/preflight.ts'
import type { ModelInfo, ProbeResult, ReadinessNeed, Support } from '../../../shared/vendors.ts'
import { resolveHome } from '../../home.ts'
import type { EnvInput } from '../../proc/env.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import type { ResolveResult, ResolvedCli } from '../../proc/resolve-cli.ts'
import { resolveCli, toResolvedBinary } from '../../proc/resolve-cli.ts'
import { binCheck, runHelp } from '../acp-base/probe.ts'
import type { HelpText } from '../acp-base/probe.ts'
import { folderTrust } from '../acp-base/trust.ts'
import { AdapterError, makeFailure } from '../errors.ts'
import { registerAdapter } from '../registry.ts'
import type {
  Adapter,
  CanResumeResult,
  ListModelsOptions,
  ProbeOptions,
  RunHandle,
  StartOptions,
  StopReason,
} from '../types.ts'
import type { MuseTiming } from './capabilities.ts'
import {
  DEFAULT_MUSE_TIMING,
  MUSE_CLI_FLAGS,
  MUSE_DEFAULT_MODEL,
  MUSE_FORBIDDEN_FLAGS,
  MUSE_MANAGED_FLAGS,
  museCapabilities,
  museSupport,
} from './capabilities.ts'
import { MUSE_DISPLAY_NAME, MUSE_VENDOR, museCliSpec } from './cli-spec.ts'
import { museEnv, museExtraArgsProblem, museFlagMapProblem } from './launch.ts'
import type { MusePin } from './protocol.ts'
import { MUSE_PIN } from './protocol.ts'
import type { SchemaText } from './probe.ts'
import {
  MUSE_HELP_ARGS,
  museAccount,
  museAuthCheck,
  musePlanCheck,
  museProtocolCheck,
  museVersionCheck,
  readSchema,
} from './probe.ts'
import { MuseRun } from './run.ts'
import type { MuseSpawnHook } from './run.ts'
import { ensureMuseSignals } from './signals.ts'

export { MuseNormalizer } from './normalize.ts'
export { MuseRun } from './run.ts'
export type { MuseSpawnHook } from './run.ts'
export { museCliSpec } from './cli-spec.ts'

export interface MuseAdapterOptions {
  /** `vendors.muse.path`. */
  configuredPath?: string | null
  /** `vendors.muse.env` (user config). */
  vendorEnv?: Record<string, string>
  /** `vendors.muse.{extraArgs,flagMap}`: checked by the probe as a pass would. */
  extraArgs?: string[]
  flagMap?: Record<string, string>
  /** Dim Factory's own env (default process.env). */
  env?: EnvInput
  home?: string
  /** DIM_FACTORY_HOME (default from the env): prompt files go under its runs/, its own folders need no grant. */
  dimFactoryHome?: string
  /** A fixed PATH for search and children (tests); default: path-env. */
  pathEnv?: string
  /** Working directory of the probe's commands (default `<DIM_FACTORY_HOME>/tmp/probe-cwd`). */
  probeCwd?: string
  now?: () => number
  timing?: Partial<MuseTiming>
  /** Test seam: replaces binary resolution. */
  resolve?: (force: boolean) => Promise<ResolveResult>
  /** `configured`: look only at `configuredPath` (E2E hosts, never a real install); default the full search. */
  search?: 'all' | 'configured'
  /** After spawn, before anything else (procs.json). */
  onSpawn?: MuseSpawnHook
  /** An extra trust.json lookup (the engine answers it through StartOptions.trustFolder, preflight through need). */
  folderGranted?: (cwd: string, vendor: string) => Promise<boolean>
  /** Test seam: the pin the protocol check compares with. */
  pin?: MusePin
}

export interface MuseAdapter extends Adapter {
  resolveBinary(force?: boolean): Promise<ResolveResult>
}

const READINESS_TTL_MS = 60_000

const staticModels = (): ModelInfo[] => [
  { id: MUSE_DEFAULT_MODEL, label: 'Muse Spark 1.2', isDefault: true, source: 'static' },
]

export function createMuseAdapter(opts: MuseAdapterOptions = {}): MuseAdapter {
  ensureMuseSignals()
  const baseEnv: EnvInput = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const dimFactoryHome = opts.dimFactoryHome ?? resolveHome({ env: baseEnv, userHome: home })
  const now = opts.now ?? Date.now
  const timing: MuseTiming = { ...DEFAULT_MUSE_TIMING, ...opts.timing }
  const pin = opts.pin ?? MUSE_PIN
  const childEnvInput = (): EnvInput => ({ ...baseEnv, ...opts.vendorEnv })
  let resolved: Promise<ResolveResult> | undefined
  let probed: Promise<ProbeResult> | undefined
  let seq = 0

  const pathEnv = async (): Promise<string | undefined> =>
    opts.pathEnv ?? (await resolvePathEnv({ env: baseEnv })).path

  const resolveBinary = (force = false): Promise<ResolveResult> => {
    if (resolved === undefined || force) {
      const p = opts.resolve
        ? opts.resolve(force)
        : pathEnv().then((path) =>
            resolveCli(museCliSpec, {
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
      makeFailure('cli_missing', `${MUSE_DISPLAY_NAME} is not installed or could not be started.`, {
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

  const cfg = { id: MUSE_VENDOR, displayName: MUSE_DISPLAY_NAME }

  const runProbe = async (force: boolean): Promise<ProbeResult> => {
    const at = now()
    const r = await resolveBinary(force)
    const base = { vendor: MUSE_VENDOR, at, route: 'exec' as const, transport: 'muse-exec' as const }
    const capabilities = museCapabilities()
    if (!r.ok) {
      return {
        ...base,
        ok: false,
        checks: [binCheck(cfg, undefined, r.rejected, at)],
        capabilities,
        models: [],
      }
    }
    const cli = r.cli
    const env = museEnv(baseEnv, {
      path: await pathEnv(),
      pathPrepend: cli.pathPrepend,
      vendorEnv: opts.vendorEnv,
    })
    const cwd = probeCwd()
    const flagProblem = museExtraArgsProblem(opts.extraArgs) ?? museFlagMapProblem(opts.flagMap)
    const [help, schema] = await Promise.all([
      runHelp({ cli, args: MUSE_HELP_ARGS, env, cwd }).catch((err: unknown): HelpText => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      readSchema({ cli, env, cwd }).catch((err: unknown): SchemaText => ({
        error: err instanceof Error ? err.message : String(err),
      })),
    ])
    const protocol = museProtocolCheck(help, schema, pin, at)
    const checks: CheckResult[] = [
      binCheck(cfg, cli, r.rejected, at),
      museVersionCheck(cli.version, pin.targetCliVersion, at),
      museAuthCheck(childEnvInput(), at),
      flagProblem !== undefined
        ? {
            ...protocol,
            status: 'fail',
            blocking: true,
            category: 'config_invalid',
            title: `${MUSE_DISPLAY_NAME} flags in your settings are not allowed`,
            detail: flagProblem,
            recovery: [
              {
                id: 'muse.flags',
                label: `Edit the ${MUSE_DISPLAY_NAME} flags`,
                kind: 'settings_link',
                route: 'settings/vendors',
                pointer: `/vendors/${MUSE_VENDOR}`,
              },
            ],
          }
        : protocol,
      musePlanCheck(at),
    ]
    const account = museAccount(childEnvInput())
    return {
      ...base,
      ok: !checks.some((c) => c.status === 'fail' && c.blocking),
      binary: toResolvedBinary(cli),
      version: cli.version,
      checks,
      capabilities,
      models: staticModels(),
      ...(account !== undefined ? { account } : {}),
    }
  }

  const support = (need: ReadinessNeed): Support => museSupport(need)

  const adapter: MuseAdapter = {
    id: MUSE_VENDOR,
    displayName: MUSE_DISPLAY_NAME,
    transport: 'muse-exec',
    managedFlags: MUSE_MANAGED_FLAGS,
    forbiddenFlags: MUSE_FORBIDDEN_FLAGS,
    cliFlags: MUSE_CLI_FLAGS,
    // The version is recorded, never judged.
    testedUpTo: '',
    versionFloor: '',
    versionRecommended: '',
    resolveBinary,

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
      // A degraded mode passes here, as Claude's and Codex's do: core's pass.<p>.mode and pass.<p>.relay warn.
      out.push(
        s.status === 'unsupported'
          ? check('mode', 'fail', `Mode not available for ${MUSE_DISPLAY_NAME}`, s.copy, {
              category: 'capability_missing',
            })
          : check('mode', 'pass', 'Mode', s.copy),
      )
      // A pass Muse cannot run at all (Plan, Review, Critic) gets the mode check alone. Trusting the
      // folder would not let it run, so no grant is offered for it.
      if (cwd !== '' && s.status !== 'unsupported') {
        // Readiness `trust`: "Gemini/Muse without a grant → fail, with a `grant vendorFolder` action".
        const t = await folderTrust({
          cwd,
          vendor: MUSE_VENDOR,
          dimFactoryHome,
          engineTrusted: need.trustFolder,
          granted: opts.folderGranted ?? (() => Promise.resolve(false)),
        })
        out.push(
          t.trusted
            ? check(
                'trust',
                'pass',
                `Folder trusted for ${MUSE_DISPLAY_NAME}`,
                t.why === 'owned'
                  ? `A working folder of Dim Factory's own: ${MUSE_DISPLAY_NAME} runs here without asking about trust.`
                  : `You allowed ${MUSE_DISPLAY_NAME} to work in this folder.`,
              )
            : check(
                'trust',
                'fail',
                `${MUSE_DISPLAY_NAME} needs your OK for this folder`,
                `${MUSE_DISPLAY_NAME} only works in folders you trust. Trust this folder once and Dim Factory starts ${MUSE_DISPLAY_NAME} here with --trust-workspace; you can remove the trust in Settings.`,
                {
                  category: 'trust_required',
                  recovery: [
                    {
                      id: `${MUSE_VENDOR}.trust-folder`,
                      label: `Trust this folder for ${MUSE_DISPLAY_NAME}`,
                      kind: 'grant',
                      grant: 'vendorFolder',
                      vendor: MUSE_VENDOR,
                      detail: `Lets ${MUSE_DISPLAY_NAME} read and change files in this folder when a pass allows it. ${MUSE_DISPLAY_NAME} cannot ask you anything, so it only runs Implement and Fix, in its sandbox or (in Auto) without one.`,
                    },
                  ],
                },
              ),
        )
      }
      if (need.resumeSessionId !== undefined) {
        out.push(
          check(
            'resume',
            'skip',
            'Fix will start a fresh session',
            `Dim Factory does not continue ${MUSE_DISPLAY_NAME} sessions yet.`,
          ),
        )
      }
      return out
    },

    support,

    canResume(): Promise<CanResumeResult> {
      // capabilities.resume 'none': Fix always starts fresh (no recording shows how exec answers a missing session).
      return Promise.resolve({ ok: false, reason: 'cannot-resume' })
    },

    start(o: StartOptions): RunHandle {
      return new MuseRun(o, {
        resolve: cliForRun,
        baseEnv,
        pathEnv,
        vendorEnv: opts.vendorEnv,
        dimFactoryHome,
        now,
        timing,
        onSpawn: opts.onSpawn,
        seq: ++seq,
      })
    },

    answer(): void {
      // exec relays nothing: there is never an ask to answer.
    },

    stop(h: RunHandle, reason: StopReason): Promise<void> {
      return h instanceof MuseRun ? h.stop(reason) : Promise.resolve()
    },

    /** Model lists: static until a session protocol client asks Muse (`model/list`). */
    listModels(_o?: ListModelsOptions): Promise<ModelInfo[]> {
      return Promise.resolve(staticModels())
    },
  }
  return adapter
}

/** The process-wide instance (the dev CLI's probe); app-core makes its own from the user's vendors.muse. */
export const museAdapter: MuseAdapter = createMuseAdapter()
registerAdapter(museAdapter, { experimental: true })
