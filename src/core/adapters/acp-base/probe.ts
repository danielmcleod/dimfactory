// probe() for an ACP vendor: vendor.<v>.{bin,version,protocol,plan} (the ACP
// columns). Token-free: `--version` (the resolver), `--help` (flags), and one private agent: ACP initialize, then
// (when the vendor asks for it) session/new in Dim Factory's probe folder. Never session/prompt, never authenticate.
import { setTimeout as delay } from 'node:timers/promises'
import type { FailureCategory, RecoveryAction } from '../../../shared/failure.ts'
import type { CheckResult, CheckStatus, VendorCheck } from '../../../shared/preflight.ts'
import { vendorCheckId } from '../../../shared/preflight.ts'
import { redactText } from '../../../shared/redact.ts'
import type { Capabilities, ReadinessNeed, Support } from '../../../shared/vendors.ts'
import { commandFor, docsUrlFor, osFamily } from '../../heal/commands.ts'
import { JsonRpcError } from '../../proc/jsonrpc.ts'
import type { CandidateRejection, ResolvedCli } from '../../proc/resolve-cli.ts'
import { compareVersions } from '../../proc/resolve-cli.ts'
import { SpawnError, execCapture } from '../../proc/spawn.ts'
import { AcpClient, isAuthRequired, isPeerTimeout, readSession } from './client.ts'
import type { AcpFacts, AcpHandshake, AcpLaunch, AcpVendorConfig } from './config.ts'
import { effectiveMode } from './run.ts'
import {
  ACP_PROTOCOL_VERSION,
  acpErrorText,
  newSessionParams,
  resumeKindOf,
  resumeRouteOf,
} from './protocol.ts'
import { M } from './wire.ts'

export const PROBE_TTL_MS = 60 * 60 * 1000
export const HELP_TIMEOUT_MS = 30_000

type CheckExtra = Partial<Pick<CheckResult, 'category' | 'blocking'>> & { recovery?: RecoveryAction[] }

export function vendorCheck(
  vendor: string,
  check: VendorCheck,
  status: CheckStatus,
  title: string,
  detail: string,
  at: number,
  extra: CheckExtra = {},
): CheckResult {
  const out: CheckResult = {
    id: vendorCheckId(vendor, check),
    scope: 'vendor',
    status,
    blocking: extra.blocking ?? status === 'fail',
    title,
    detail,
    recovery: extra.recovery ?? [],
    at,
    ttlMs: PROBE_TTL_MS,
  }
  if (extra.category !== undefined) out.category = extra.category
  return out
}

// ---- recovery actions -----------------------------------------------------------------------------------------

export function shellCopy(
  vendor: string,
  id: string,
  label: string,
  kind: 'install' | 'login' | 'update' | 'pin',
  reason: string,
  recheck: VendorCheck,
  version?: string,
): RecoveryAction | undefined {
  const cmd = commandFor(kind, vendor, osFamily(), version)
  if (cmd === null) return undefined
  return {
    id,
    label,
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason: cmd.note !== undefined ? `${reason}. ${cmd.note}` : reason,
    recheck: vendorCheckId(vendor, recheck),
  }
}

export const defined = (list: (RecoveryAction | undefined)[]): RecoveryAction[] =>
  list.filter((a): a is RecoveryAction => a !== undefined)

/** The failure table's last resort: every pass on Claude (disabled while Claude is not ready). */
export function switchToClaude(vendor: string): RecoveryAction {
  return {
    id: `${vendor}.switch-vendor`,
    label: 'Use Claude instead',
    kind: 'switch_vendor',
    pass: 'all',
    to: 'claude',
    model: null,
  }
}

function installActions(cfg: Pick<AcpVendorConfig, 'id' | 'displayName'>): RecoveryAction[] {
  const docs = docsUrlFor(cfg.id)
  return defined([
    shellCopy(
      cfg.id,
      `${cfg.id}.install`,
      'Copy the install command',
      'install',
      `${cfg.displayName} is not installed`,
      'bin',
    ),
    {
      id: `${cfg.id}.set-path`,
      label: `Set the ${cfg.displayName} path`,
      kind: 'settings_link',
      route: 'settings/vendors',
      pointer: `/vendors/${cfg.id}/path`,
    },
    switchToClaude(cfg.id),
    docs !== null
      ? { id: `${cfg.id}.docs`, label: 'Open the setup guide', kind: 'open_docs', url: docs }
      : undefined,
  ])
}

const updateActions = (
  cfg: Pick<AcpVendorConfig, 'id' | 'displayName'>,
  recheck: VendorCheck,
): RecoveryAction[] =>
  defined([
    shellCopy(
      cfg.id,
      `${cfg.id}.update`,
      'Copy the update command',
      'update',
      `Update ${cfg.displayName}`,
      recheck,
    ),
  ])

// ---- bin / version ----------------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<ResolvedCli['source'], string> = {
  config: 'configured path',
  'well-known': 'standalone install',
  path: 'PATH',
  'npm-prefix': 'npm global prefix',
  'desktop-bundle': 'desktop app bundle',
}

/** vendor.<v>.bin: where the CLI is and what runs it (an npm shim runs as system `node <entry>`). */
export function binCheck(
  cfg: Pick<AcpVendorConfig, 'id' | 'displayName'>,
  cli: ResolvedCli | undefined,
  rejected: readonly CandidateRejection[],
  at: number,
): CheckResult {
  if (cli === undefined) {
    const why = rejected.map((r) => `${r.path}: ${r.detail}`).join('\n')
    return vendorCheck(
      cfg.id,
      'bin',
      'fail',
      `${cfg.displayName} is not installed`,
      why !== ''
        ? `No usable ${cfg.displayName} CLI was found.\n${why}`
        : `No ${cfg.displayName} CLI was found on this computer.`,
      at,
      { category: 'cli_missing', recovery: installActions(cfg) },
    )
  }
  const via = cli.kind === 'node-entry' ? `; runs with ${cli.command}` : ''
  const where = `${cli.path} (${SOURCE_LABEL[cli.source]}${via})`
  if (cli.warnings.length > 0) {
    return vendorCheck(
      cfg.id,
      'bin',
      'warn',
      `${cfg.displayName} found`,
      [where, ...cli.warnings].join('\n'),
      at,
    )
  }
  return vendorCheck(cfg.id, 'bin', 'pass', `${cfg.displayName} found`, where, at)
}

/** `--help` output (stdout and stderr), or why it could not be read. */
export interface HelpText {
  text?: string
  error?: string
}

export async function runHelp(o: {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  args: readonly string[]
  env: Record<string, string>
  cwd: string
  timeoutMs?: number
}): Promise<HelpText> {
  const r = await execCapture(o.cli.command, [...o.cli.prefixArgs, ...o.args], {
    env: o.env,
    cwd: o.cwd,
    timeoutMs: o.timeoutMs ?? HELP_TIMEOUT_MS,
  })
  if (r.error !== undefined) return { error: `${r.error.code}: ${r.error.message}` }
  if (r.timedOut) return { error: `${o.args.join(' ')} timed out` }
  return { text: `${r.stdout}\n${r.stderr}` }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `--flag` appears in help text as a flag (not as part of a longer flag name). */
export const helpHasFlag = (help: string, flag: string): boolean =>
  new RegExp(`(?:^|[\\s,\\[(])${escapeRe(flag)}(?![\\w-])`, 'm').test(help)

/**
 * vendor.<v>.version: below the floor fails; below the recommended version warns; newer than tested warns; a help
 * text without a required flag fails (flag_drift: Gemini without `--acp`), without an optional one warns.
 */
export function versionCheck(
  cfg: Pick<
    AcpVendorConfig,
    'id' | 'displayName' | 'versionFloor' | 'versionRecommended' | 'testedUpTo' | 'probe'
  >,
  version: string,
  help: HelpText | undefined,
  at: number,
): CheckResult {
  const name = cfg.displayName
  const spec = cfg.probe.help
  if (spec !== undefined) {
    if (help?.text === undefined) {
      return vendorCheck(
        cfg.id,
        'version',
        'warn',
        `${name} ${version}: could not read its options`,
        `${spec.args.join(' ')}: ${help?.error ?? 'no output'}`,
        at,
        {
          recovery: updateActions(cfg, 'version'),
        },
      )
    }
    const missing = spec.required.filter((f) => !helpHasFlag(help.text!, f))
    if (missing.length > 0) {
      return vendorCheck(
        cfg.id,
        'version',
        'fail',
        `${name} ${version} cannot talk to Dim Factory`,
        `This ${name} has no ${missing.join(', ')} option, which Dim Factory needs. Update ${name}.`,
        at,
        { category: 'flag_drift', recovery: updateActions(cfg, 'version') },
      )
    }
    const optional = (spec.optional ?? []).filter((f) => !helpHasFlag(help.text!, f))
    if (optional.length > 0) {
      return vendorCheck(
        cfg.id,
        'version',
        'warn',
        `${name} ${version} lacks ${optional.join(', ')}`,
        `Some passes cannot run until ${name} is updated.`,
        at,
        { recovery: updateActions(cfg, 'version') },
      )
    }
  }
  if (cfg.versionFloor !== '' && compareVersions(version, cfg.versionFloor) < 0) {
    return vendorCheck(
      cfg.id,
      'version',
      'fail',
      `${name} ${version} is too old`,
      `Dim Factory needs ${cfg.versionFloor} or newer (${cfg.versionRecommended} recommended).`,
      at,
      { category: 'cli_version', recovery: updateActions(cfg, 'version') },
    )
  }
  if (cfg.versionRecommended !== '' && compareVersions(version, cfg.versionRecommended) < 0) {
    return vendorCheck(
      cfg.id,
      'version',
      'warn',
      `${name} ${version} works; ${cfg.versionRecommended} is recommended`,
      `Update ${name} when convenient.`,
      at,
      { recovery: updateActions(cfg, 'version') },
    )
  }
  if (cfg.testedUpTo !== '' && compareVersions(version, cfg.testedUpTo) > 0) {
    return vendorCheck(
      cfg.id,
      'version',
      'warn',
      `${name} ${version} is newer than tested (${cfg.testedUpTo})`,
      `If a flag fails, apply the suggested flagMap patch or install ${cfg.testedUpTo}.`,
      at,
      {
        recovery: defined([
          shellCopy(
            cfg.id,
            `${cfg.id}.pin`,
            `Copy the install command for ${cfg.testedUpTo}`,
            'pin',
            'Install the tested version',
            'version',
            cfg.testedUpTo,
          ),
        ]),
      },
    )
  }
  // A vendor with no tested version (Grok, Muse) has its version recorded.
  const detail =
    cfg.testedUpTo !== ''
      ? `Tested up to ${cfg.testedUpTo}.`
      : `Version recorded. Dim Factory has not yet been tested against a live ${name}.`
  return vendorCheck(cfg.id, 'version', 'pass', `${name} ${version}`, detail, at)
}

// ---- the handshake ----------------------------------------------------------------------------------------------

/** stderr lines safe to show (redacted, capped). */
const safeLines = (lines: readonly string[]): string[] =>
  lines
    .map((l) => redactText(l, { mode: 'diagnostics' }).text.slice(0, 300))
    .filter((l) => l.trim() !== '')
    .slice(-5)

/**
 * One private agent: initialize, then session/new in `cwd` when `newSession` (modes, models, and whether it needs a
 * sign-in), then stdin closed. No prompt: no tokens.
 */
export async function probeHandshake(o: {
  launch: AcpLaunch
  cwd: string
  newSession: boolean
  timeoutMs: number
  requestMs: number
}): Promise<AcpHandshake> {
  const start = Date.now()
  const out: AcpHandshake = {
    ok: false,
    ms: 0,
    loadSession: false,
    resume: false,
    authRequired: false,
    models: [],
    stderr: [],
  }
  let client: AcpClient
  try {
    client = await AcpClient.spawn({ launch: o.launch, cwd: o.cwd, label: { purpose: 'probe' } })
  } catch (err) {
    const e = SpawnError.from(err, o.launch.exe)
    return { ...out, ms: Date.now() - start, error: `${e.code}: ${e.message}`, category: 'cli_missing' }
  }
  try {
    const info = await client.initialize(o.timeoutMs)
    out.ok = true
    out.loadSession = info.loadSession
    out.resume = info.resume
    if (info.protocolVersion !== undefined) out.protocolVersion = info.protocolVersion
    if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
      out.ok = false
      out.error = `the agent speaks ACP version ${String(info.protocolVersion ?? 'unknown')}, Dim Factory version ${ACP_PROTOCOL_VERSION}`
      out.category = 'flag_drift'
    } else if (o.newSession) {
      try {
        const s = readSession(
          await client.peer.request(M.sessionNew, newSessionParams(o.cwd), { timeoutMs: o.requestMs }),
        )
        out.sessionOk = s.sessionId !== undefined
        if (s.modes !== undefined) out.modes = s.modes
        if (s.currentMode !== undefined) out.currentMode = s.currentMode
        out.models = s.models
        if (s.sessionId === undefined) out.sessionError = 'session/new answered without a session id'
      } catch (err) {
        out.sessionOk = false
        out.authRequired = isAuthRequired(err)
        out.sessionError =
          err instanceof JsonRpcError
            ? `session/new was refused: ${acpErrorText(err).slice(0, 200)}`
            : isPeerTimeout(err)
              ? 'session/new did not answer'
              : err instanceof Error
                ? err.message
                : String(err)
      }
    }
  } catch (err) {
    out.error =
      err instanceof JsonRpcError
        ? `initialize was refused: ${acpErrorText(err).slice(0, 200)}`
        : isPeerTimeout(err)
          ? `initialize did not answer within ${Math.round(o.timeoutMs / 1000)} s`
          : err instanceof Error
            ? err.message
            : String(err)
    out.category = 'flag_drift'
  } finally {
    await Promise.race([client.shutdown(3_000), delay(10_000, undefined, { ref: false })])
    const exit = client.child.exitInfo()
    out.stderr = safeLines(client.child.stderrTail(20))
    if (!out.ok && exit !== null && exit.code !== null && exit.code !== 0) {
      out.error = `${out.error ?? 'the agent ended'} (exit ${exit.code})`
    }
    out.ms = Date.now() - start
  }
  return out
}

/** vendor.<v>.protocol: the ACP handshake (and session/new) answered; no tokens spent. */
export function protocolCheck(
  cfg: Pick<AcpVendorConfig, 'id' | 'displayName'>,
  h: AcpHandshake,
  at: number,
): CheckResult {
  const name = cfg.displayName
  const update = (): RecoveryAction[] =>
    defined([
      { id: `${cfg.id}.heal`, label: 'Diagnose with AI', kind: 'heal' },
      ...updateActions(cfg, 'protocol'),
    ])
  if (!h.ok) {
    const detail = [h.error ?? 'initialize failed', ...h.stderr].join('\n')
    const category: FailureCategory = h.category ?? 'flag_drift'
    return vendorCheck(
      cfg.id,
      'protocol',
      'fail',
      `${name} did not answer the startup handshake`,
      detail,
      at,
      {
        category,
        recovery: category === 'cli_missing' ? installActions(cfg) : update(),
      },
    )
  }
  const notes = [`ACP ${h.protocolVersion ?? ACP_PROTOCOL_VERSION} answered in ${h.ms} ms; no tokens spent.`]
  notes.push(
    h.loadSession || h.resume ? 'Fix can continue an earlier session.' : 'Fix always starts a fresh session.',
  )
  if (h.sessionOk === false && !h.authRequired) {
    return vendorCheck(
      cfg.id,
      'protocol',
      'fail',
      `${name} could not start a session`,
      [h.sessionError ?? 'session/new failed', ...h.stderr].join('\n'),
      at,
      { category: 'flag_drift', recovery: update() },
    )
  }
  if (h.authRequired) notes.push(`Starting a session needs a sign-in first.`)
  return vendorCheck(cfg.id, 'protocol', 'pass', 'ACP protocol works', notes.join(' '), at)
}

/** vendor.<v>.protocol when the user's extraArgs or flagMap are refused (every pass would refuse to start). */
export function protocolConfigCheck(
  cfg: Pick<AcpVendorConfig, 'id' | 'displayName'>,
  problem: string,
  at: number,
): CheckResult {
  return vendorCheck(
    cfg.id,
    'protocol',
    'fail',
    `${cfg.displayName} flags in your settings are not allowed`,
    problem,
    at,
    {
      category: 'config_invalid',
      recovery: [
        {
          id: `${cfg.id}.flags`,
          label: `Edit the ${cfg.displayName} flags`,
          kind: 'settings_link',
          route: 'settings/vendors',
          pointer: `/vendors/${cfg.id}`,
        },
      ],
    },
  )
}

/** vendor.<v>.plan: the native plan mode is one of the session's modes (plan ∈ availableModes). */
export function planCheck(
  cfg: Pick<AcpVendorConfig, 'id' | 'displayName' | 'planMode' | 'plan'>,
  facts: AcpFacts,
  at: number,
): CheckResult {
  const name = cfg.displayName
  if (cfg.planMode !== 'native' || cfg.plan === undefined) {
    return vendorCheck(
      cfg.id,
      'plan',
      'skip',
      'Plan runs read-only with the plan template',
      `${name} has no plan mode Dim Factory uses.`,
      at,
    )
  }
  if (facts.plan) {
    return vendorCheck(
      cfg.id,
      'plan',
      'pass',
      'Native plan mode',
      `Plan runs in ${name}'s own plan mode; Dim Factory captures the plan and never lets it leave plan mode.`,
      at,
    )
  }
  return vendorCheck(
    cfg.id,
    'plan',
    'skip',
    'Plan runs read-only with the plan template',
    facts.modes === undefined
      ? `Dim Factory could not list ${name}'s modes yet (it needs a sign-in to start a session).`
      : `This ${name} offers no plan mode (it may be turned off in its settings).`,
    at,
  )
}

/** The facts support() and start() read, from a handshake. */
export function factsFrom(cfg: Pick<AcpVendorConfig, 'plan'>, h: AcpHandshake, prev: AcpFacts): AcpFacts {
  if (!h.ok) return { ...prev, probed: false }
  const modes = h.modes ?? prev.modes
  const out: AcpFacts = {
    probed: true,
    loadSession: h.loadSession,
    resume: h.resume,
    plan: cfg.plan !== undefined && modes !== undefined && modes.includes(cfg.plan.acpMode),
  }
  if (modes !== undefined) out.modes = modes
  return out
}

// ---- support() and capabilities ------------------------------------------------------------------------------

/** The mode table for an ACP vendor (the ONLY source of its mode copy). */
export function acpSupport(cfg: AcpVendorConfig, need: ReadinessNeed, facts: AcpFacts): Support {
  const mode = effectiveMode(need.pass, need.mode)
  if (
    need.pass === 'plan' &&
    need.planNative &&
    cfg.planMode === 'native' &&
    cfg.plan !== undefined &&
    facts.plan
  ) {
    return { status: 'supported', copy: cfg.plan.copy }
  }
  const spec = cfg.modes[mode]
  // Grok autoedit: the copy says why, and no reason code goes with it. Support.reason is shown beside
  // the copy (the composer's mode line, the PassCard), so a code would reach the UI as "(mode-unsupported)".
  if (spec.status === 'unsupported') return { status: 'unsupported', copy: spec.copy }
  if (spec.acpMode !== null && facts.modes !== undefined && !facts.modes.includes(spec.acpMode)) {
    return {
      status: 'unsupported',
      copy: `This ${cfg.displayName} offers no "${spec.acpMode}" mode, so Dim Factory cannot run this mode. Update ${cfg.displayName}.`,
      reason: 'mode-missing',
    }
  }
  return { status: spec.status ?? 'supported', copy: spec.copy }
}

export function acpCapabilities(cfg: AcpVendorConfig, facts: AcpFacts, models: number): Capabilities {
  const pass = (mode: 'readonly' | 'autoedit' | 'full'): Support =>
    acpSupport(cfg, { pass: 'implement', mode, planNative: false, trustFolder: false }, facts)
  return {
    planMode: cfg.planMode === 'native' && cfg.plan !== undefined && facts.plan ? 'native' : 'emulated',
    askRelay: true,
    // session/resume when advertised (by id, no replay), else session/load (the replay is dropped).
    resume: resumeKindOf(resumeRouteOf({ loadSession: facts.loadSession, resumeSession: facts.resume })),
    // ACP: the session id comes from the session/new answer, never chosen up front.
    preassignSessionId: false,
    modelList: models > 0 ? 'cli' : 'static',
    usageCumulative: cfg.usage.cumulative,
    // allow-session selects the vendor's own session-scoped option (the decision table).
    allowSession: 'native',
    web: false,
    // Not checked against a recording: a Fix with another model starts fresh.
    resumeModelSwitch: false,
    resumeModeSwitch: false,
    // No effort setting: a pass's effort is left out of the launch.
    effort: false,
    reasoningIncludedInOutput: cfg.reasoningIncludedInOutput,
    modes: { readonly: pass('readonly'), autoedit: pass('autoedit'), full: pass('full') },
  }
}
