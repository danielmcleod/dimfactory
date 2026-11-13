// The Claude Code adapter: stdio control protocol over `claude -p`.
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CheckResult } from '../../../shared/preflight.ts'
import type {
  ModelInfo,
  ProbeResult,
  ReadinessNeed,
  ReadinessPurpose,
  Support,
} from '../../../shared/vendors.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import { resolvePathEnv } from '../../proc/path-env.ts'
import type { ResolveResult, ResolvedCli } from '../../proc/resolve-cli.ts'
import { resolveCli, toResolvedBinary } from '../../proc/resolve-cli.ts'
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
import {
  CLAUDE_DISPLAY_NAME,
  CLAUDE_VENDOR,
  CLI_FLAGS,
  ESCALATION_FLAGS,
  MANAGED_FLAGS,
  PLAN_NATIVE_COPY,
  PLAN_NATIVE_NO_SHELL_COPY,
  READONLY_NO_SHELL_COPY,
  TESTED_UP_TO,
  VERSION_FLOOR,
  VERSION_RECOMMENDED,
  claudeCapabilities,
  modeSupport,
} from './capabilities.ts'
import { claudeCliSpec } from './cli-spec.ts'
import {
  argvDisallowsShell,
  claudeConfigDir,
  claudeEnv,
  extraArgsProblem,
  flagMapProblem,
  probeArgv,
  routeFor,
} from './launch.ts'
import {
  authChecks,
  binCheck,
  initializeHandshake,
  listConnectors,
  planCheck,
  protocolCheck,
  protocolConfigCheck,
  runAuthStatus,
  versionCheck,
} from './probe.ts'
import type { HandshakeNames } from './probe.ts'
import type { ClaudeConnector, ConnectorListing } from '../../extensions/claude-connectors.ts'
import { connectorListingBlocked } from '../../extensions/claude-connectors.ts'
import type { RunTiming, SpawnHook } from './run.ts'
import { ClaudeRun } from './run.ts'
import { findTranscript } from './session.ts'
import { scanShellAllowRules } from './settings-scan.ts'
import { BRAND, HOME_ENV } from '../../../shared/brand.ts'

export { ClaudeRun } from './run.ts'
export { ClaudeNormalizer, normalizeRecording } from './normalize.ts'

export interface ClaudeAdapterOptions {
  /** `vendors.claude.path`. */
  configuredPath?: string | null
  /** `vendors.claude.env` (user config). */
  vendorEnv?: Record<string, string>
  /** `vendors.claude.{extraArgs,flagMap}`: the probe handshake uses them like a pass does. */
  extraArgs?: string[]
  flagMap?: Record<string, string>
  /** Dim Factory's own env (default process.env). */
  env?: EnvInput
  home?: string
  /** A fixed PATH for search and children (tests); default: path-env. */
  pathEnv?: string
  /** Working directory for the probe handshake (default `<DIM_FACTORY_HOME>/tmp/probe-cwd`). */
  probeCwd?: string
  now?: () => number
  timing?: Partial<RunTiming>
  /** Test seam: replaces binary resolution. */
  resolve?: (force: boolean) => Promise<ResolveResult>
  /** `configured`: look only at `configuredPath` (E2E hosts, never a real install); default the full search. */
  search?: 'all' | 'configured'
  /** After spawn, before the first stdin write (procs.json). */
  onSpawn?: SpawnHook
  /**
   * A pass whose allowed MCP servers name a claude.ai connector this app session has not listed yet lists them first
   * (no tokens, only where that starts no other MCP server). Off by default (tests and E2E hosts with a fake CLI).
   */
  connectorsOnDemand?: boolean
}

const READINESS_TTL_MS = 60_000

/** What a readiness check names the pass it is for (a check title the composer's strip lists beside the others). */
const READINESS_PURPOSE_LABEL: Readonly<Record<ReadinessPurpose, string>> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
  heal: 'the diagnosis',
  catalog: 'the price refresh',
}

export interface ClaudeAdapter extends Adapter {
  resolveBinary(force?: boolean): Promise<ResolveResult>
  /**
   * The skills and subagents the last probe's initialize-only handshake listed (no tokens; names only, in memory):
   * the user's, plugins' and claude.ai-synced ones a settings scan cannot see. Undefined before a probe answered.
   */
  handshakeNames(): HandshakeNames | undefined
  /**
   * The account's claude.ai connectors (extensions/claude-connectors.ts): listed by an initialize-only session that
   * asks `mcp_status` (no tokens), only where that session starts no other MCP server; kept in memory for this app
   * session's launches. `force` lists again.
   */
  listConnectors(o?: { force?: boolean }): Promise<ConnectorListing>
  /** The connectors the last successful listing found (undefined before one). */
  listedConnectors(): readonly ClaudeConnector[] | undefined
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): ClaudeAdapter {
  const baseEnv: EnvInput = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const now = opts.now ?? Date.now
  const capabilities = claudeCapabilities()
  let resolved: Promise<ResolveResult> | undefined
  let probed: Promise<ProbeResult> | undefined
  let lastNames: HandshakeNames | undefined
  let connectorsListed: Promise<ConnectorListing> | undefined
  let lastConnectors: ClaudeConnector[] | undefined

  const pathEnv = async (): Promise<string | undefined> =>
    opts.pathEnv ?? (await resolvePathEnv({ env: baseEnv })).path

  const resolveBinary = (force = false): Promise<ResolveResult> => {
    if (resolved === undefined || force) {
      const p = opts.resolve
        ? opts.resolve(force)
        : pathEnv().then((path) =>
            resolveCli(claudeCliSpec, {
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
    const raw = r.rejected.map((x) => `${x.path}: ${x.detail}`).join('\n')
    throw new AdapterError(
      makeFailure('cli_missing', 'Claude Code is not installed or could not be started.', {
        raw,
        classifiedBy: 'app',
      }),
    )
  }

  const configDir = (): string => claudeConfigDir({ ...baseEnv, ...opts.vendorEnv }, home)

  const probeCwd = (): string => {
    const dir =
      opts.probeCwd ?? join(getEnv(baseEnv, HOME_ENV) ?? join(home, BRAND.homeDirName), 'tmp', 'probe-cwd')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** An empty folder of Dim Factory's own for the connector listing (no project settings or `.mcp.json` of anyone's). */
  const connectorsCwd = (): string => {
    const dir = join(probeCwd(), '..', 'connectors-cwd')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const runConnectorListing = async (): Promise<ConnectorListing> => {
    const env = { ...baseEnv, ...opts.vendorEnv }
    const cwd = connectorsCwd()
    const blocked = connectorListingBlocked({ env, home, cwd })
    if (blocked !== undefined) return { ok: false, blocked }
    const problem = extraArgsProblem(opts.extraArgs) ?? flagMapProblem(opts.flagMap)
    if (problem !== undefined) return { ok: false, error: problem }
    const r = await resolveBinary()
    if (!r.ok) return { ok: false, error: 'Claude Code is not installed or could not be started.' }
    const childEnv = claudeEnv(baseEnv, {
      route: 'readonly',
      path: await pathEnv(),
      pathPrepend: r.cli.pathPrepend,
      vendorEnv: opts.vendorEnv,
    })
    return listConnectors({
      cli: r.cli,
      env: childEnv,
      cwd,
      args: probeArgv({ extraArgs: opts.extraArgs, flagMap: opts.flagMap, connectors: true }),
    })
  }

  const listClaudeConnectors = (o: { force?: boolean } = {}): Promise<ConnectorListing> => {
    if (connectorsListed === undefined || o.force === true) {
      const p = runConnectorListing().catch((err: unknown): ConnectorListing => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }))
      connectorsListed = p
      // A failed listing is not kept: the next pass or Settings tries again.
      void p.then((r) => {
        if (r.ok) lastConnectors = r.connectors
        else if (connectorsListed === p) connectorsListed = undefined
      })
    }
    return connectorsListed
  }

  const runProbe = async (force: boolean): Promise<ProbeResult> => {
    const at = now()
    const r = await resolveBinary(force)
    const base = {
      vendor: CLAUDE_VENDOR,
      at,
      route: 'stdio' as const,
      transport: 'claude-stdio' as const,
      capabilities,
    }
    if (!r.ok) return { ...base, ok: false, checks: [binCheck(undefined, r.rejected, at)], models: [] }
    const cli = r.cli
    const path = await pathEnv()
    const env = claudeEnv(baseEnv, {
      route: 'readonly',
      path,
      pathPrepend: cli.pathPrepend,
      vendorEnv: opts.vendorEnv,
    })
    const flagProblem = extraArgsProblem(opts.extraArgs) ?? flagMapProblem(opts.flagMap)
    const [auth, handshake] = await Promise.all([
      runAuthStatus(cli, env, home),
      flagProblem === undefined
        ? initializeHandshake({
            cli,
            env,
            cwd: probeCwd(),
            args: probeArgv({ extraArgs: opts.extraArgs, flagMap: opts.flagMap }),
          })
        : undefined,
    ])
    if (handshake?.names !== undefined) lastNames = handshake.names
    const a = authChecks(auth, env, at)
    const checks: CheckResult[] = [
      binCheck(cli, r.rejected, at),
      versionCheck(cli.version, at),
      ...a.checks,
      handshake !== undefined ? protocolCheck(handshake, at) : protocolConfigCheck(flagProblem ?? '', at),
      planCheck(cli.version, at),
    ]
    const result: ProbeResult = {
      ...base,
      ok: !checks.some((c) => c.status === 'fail' && c.blocking),
      binary: toResolvedBinary(cli),
      version: cli.version,
      checks,
      models: handshake?.models ?? [],
    }
    if (a.account !== undefined) result.account = a.account
    return result
  }

  /**
   * Live balanced run: a pass that is not an edit runs without Bash and PowerShell when the user's or the folder's
   * Claude settings allow shell commands that can change files (run.ts `disallowShell`, the same scan). A pass that has
   * started says what it ran with (`need.argv`: the cut in its `--disallowedTools`); one that has not is known only when
   * the caller names its folder (`need.cwd`). The healer and the price refresh never have a shell, so it is not theirs.
   */
  const shellOff = (need: ReadinessNeed): boolean => {
    if (need.pass === 'heal' || need.pass === 'catalog') return false
    if (routeFor({ step: need.pass, mode: need.mode, planNative: need.planNative }) === 'edit') return false
    if (need.argv !== undefined) return argvDisallowsShell(need.argv, opts.flagMap)
    if (need.cwd === undefined) return false
    return scanShellAllowRules(need.cwd, configDir()).length > 0
  }

  const support = (need: ReadinessNeed): Support => {
    const noShell = shellOff(need)
    if (need.pass === 'plan' && need.planNative)
      return { status: 'supported', copy: noShell ? PLAN_NATIVE_NO_SHELL_COPY : PLAN_NATIVE_COPY }
    const route = routeFor({ step: need.pass, mode: need.mode, planNative: need.planNative })
    if (route === 'readonly' && noShell) return { status: 'supported', copy: READONLY_NO_SHELL_COPY }
    return modeSupport(route === 'readonly' ? 'readonly' : need.mode)
  }

  const readinessId = (need: ReadinessNeed, id: string): string => `pass.${need.pass}.readiness.${id}`

  const adapter: ClaudeAdapter = {
    id: CLAUDE_VENDOR,
    displayName: CLAUDE_DISPLAY_NAME,
    transport: 'claude-stdio',
    managedFlags: MANAGED_FLAGS,
    forbiddenFlags: ESCALATION_FLAGS,
    cliFlags: CLI_FLAGS,
    testedUpTo: TESTED_UP_TO,
    versionFloor: VERSION_FLOOR,
    versionRecommended: VERSION_RECOMMENDED,
    resolveBinary,
    handshakeNames: () => lastNames,
    listConnectors: listClaudeConnectors,
    listedConnectors: () => lastConnectors,

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
        id: readinessId(need, id),
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
      const s = support({ ...need, cwd })
      out.push(
        s.status === 'unsupported'
          ? check('mode', 'fail', 'Mode not available for Claude', s.reason ?? s.copy, {
              category: 'capability_missing',
            })
          : check('mode', 'pass', 'Mode', s.copy),
      )
      const route = routeFor({ step: need.pass, mode: need.mode, planNative: need.planNative })
      if (route !== 'edit') {
        const rules = scanShellAllowRules(cwd, configDir())
        // Live balanced run: the composer's strip lists every pass's warning, so the title names the pass (three
        // identical "this read-only pass" lines told the user nothing about which passes they were).
        const pass = READINESS_PURPOSE_LABEL[need.pass]
        out.push(
          rules.length > 0
            ? check(
                'claude-allow-rules',
                'warn',
                `Shell is disabled for ${pass} (read-only)`,
                `Your Claude settings allow shell commands that can change files (${rules
                  .map((r) => r.rule)
                  .join(', ')}), so Dim Factory turns Bash and PowerShell off for this pass.`,
              )
            : check(
                'claude-allow-rules',
                'pass',
                'No risky shell allow-rules',
                'Read-only commands stay available.',
              ),
        )
      }
      if (need.mode === 'full' && process.platform !== 'win32' && process.getuid?.() === 0) {
        out.push(
          check(
            'claude-root',
            'fail',
            'Full mode cannot run as root',
            'Claude Code refuses bypassPermissions as root.',
            {
              category: 'config_invalid',
            },
          ),
        )
      }
      if (need.resumeSessionId !== undefined) {
        const r = await adapter.canResume(need.resumeSessionId, cwd)
        out.push(
          r.ok
            ? check('resume', 'pass', 'Session can be resumed', `Claude session ${need.resumeSessionId}`)
            : check(
                'resume',
                'skip',
                'Fix will start a fresh session',
                'The Claude transcript was not found.',
              ),
        )
      }
      return out
    },

    support,

    canResume(sessionId: string, cwd: string): Promise<CanResumeResult> {
      const r = findTranscript(configDir(), cwd, sessionId)
      return Promise.resolve(r.ok ? { ok: true } : { ok: false, reason: 'cannot-resume' })
    },

    // Pictures travel as image blocks in the first user message (the SDK's MessageParam content).
    acceptsImages: () => true,

    start(o: StartOptions): RunHandle {
      return new ClaudeRun(o, {
        resolve: cliForRun,
        baseEnv,
        pathEnv,
        vendorEnv: opts.vendorEnv,
        home,
        now,
        readPlanFile: (p) => {
          try {
            return readFileSync(p, 'utf8')
          } catch {
            return undefined
          }
        },
        ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
        ...(opts.onSpawn !== undefined ? { onSpawn: opts.onSpawn } : {}),
        ...(opts.connectorsOnDemand === true
          ? {
              connectors: async () => {
                const r = await listClaudeConnectors()
                return r.ok ? r.connectors : []
              },
            }
          : {}),
      })
    },

    answer(h: RunHandle, requestId, d, why): void {
      if (h instanceof ClaudeRun) h.answer(requestId, d, why)
    },

    stop(h: RunHandle, reason: StopReason): Promise<void> {
      return h instanceof ClaudeRun ? h.stop(reason) : Promise.resolve()
    },

    async listModels(o: ListModelsOptions = {}): Promise<ModelInfo[]> {
      return (await adapter.probe(o.force === true ? { force: true } : {})).models
    },
  }
  return adapter
}

export const claudeAdapter: ClaudeAdapter = createClaudeAdapter()
registerAdapter(claudeAdapter)
