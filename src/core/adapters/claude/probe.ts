// probe(): vendor.claude.{bin,version,auth,env,protocol,plan} (the probe checks).
// Spends no tokens: `--version`, `claude auth status` and an initialize-only handshake (fixture C16) that
// never sends a user message.
import { setTimeout as delay } from 'node:timers/promises'
import type { RecoveryAction } from '../../../shared/failure.ts'
import { redactText } from '../../../shared/redact.ts'
import type { CheckResult, CheckStatus } from '../../../shared/preflight.ts'
import { vendorCheckId } from '../../../shared/preflight.ts'
import type { VendorCheck } from '../../../shared/preflight.ts'
import type { ModelInfo, ProbeAccount } from '../../../shared/vendors.ts'
import { commandFor, docsUrlFor, osFamily } from '../../heal/commands.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import { stopChild } from '../../proc/kill.ts'
import type { CandidateRejection, ResolvedCli } from '../../proc/resolve-cli.ts'
import { compareVersions } from '../../proc/resolve-cli.ts'
import { SpawnError, execCapture, spawnChild } from '../../proc/spawn.ts'
import type { CaptureResult, ChildHandle } from '../../proc/spawn.ts'
import {
  CLAUDE_VENDOR,
  INITIALIZE_TIMEOUT_MS,
  TESTED_UP_TO,
  VERSION_FLOOR,
  VERSION_RECOMMENDED,
  BUILTIN_AGENTS,
} from './capabilities.ts'
import { probeArgv } from './launch.ts'
import type { ConnectorListing } from '../../extensions/claude-connectors.ts'
import { parseConnectors } from '../../extensions/claude-connectors.ts'
import type { SdkModelInfo } from './protocol.ts'
import { initializeRequest, obj, parseFrame, str } from './protocol.ts'

export const PROBE_TTL_MS = 60 * 60 * 1000
export const AUTH_TIMEOUT_MS = 15_000
const HANDSHAKE_EXIT_WAIT_MS = 10_000

type CheckExtra = Partial<Pick<CheckResult, 'category' | 'blocking'>> & { recovery?: RecoveryAction[] }

export function vendorCheck(
  check: VendorCheck,
  status: CheckStatus,
  title: string,
  detail: string,
  at: number,
  extra: CheckExtra = {},
): CheckResult {
  const out: CheckResult = {
    id: vendorCheckId(CLAUDE_VENDOR, check),
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

// ---- recovery actions ---------------------------------------------------------------------------------------

function shellCopy(
  id: string,
  label: string,
  kind: 'install' | 'login' | 'update' | 'pin' | 'unsetApiKey',
  reason: string,
  recheck: VendorCheck,
  version?: string,
): RecoveryAction | undefined {
  const cmd = commandFor(kind, CLAUDE_VENDOR, osFamily(), version)
  if (cmd === null) return undefined
  return {
    id,
    label,
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason,
    recheck: vendorCheckId(CLAUDE_VENDOR, recheck),
    ...(cmd.elevated === true ? { elevated: true } : {}),
  }
}

const defined = (list: (RecoveryAction | undefined)[]): RecoveryAction[] =>
  list.filter((a): a is RecoveryAction => a !== undefined)

function installActions(): RecoveryAction[] {
  const docs = docsUrlFor(CLAUDE_VENDOR)
  return defined([
    shellCopy('claude.install', 'Copy the install command', 'install', 'Claude Code is not installed', 'bin'),
    {
      id: 'claude.set-path',
      label: 'Set the Claude Code path',
      kind: 'settings_link',
      route: 'settings/vendors',
      pointer: '/vendors/claude/path',
    },
    {
      id: 'claude.switch-vendor',
      label: 'Use Codex instead',
      kind: 'switch_vendor',
      pass: 'all',
      to: 'codex',
      model: null,
    },
    docs !== null
      ? { id: 'claude.docs', label: 'Open the setup guide', kind: 'open_docs', url: docs }
      : undefined,
  ])
}

// ---- bin / version ----------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<ResolvedCli['source'], string> = {
  config: 'configured path',
  'well-known': 'well-known location',
  path: 'PATH',
  'npm-prefix': 'npm global prefix',
  'desktop-bundle': 'Claude Desktop bundle',
}

export function binCheck(
  cli: ResolvedCli | undefined,
  rejected: readonly CandidateRejection[],
  at: number,
): CheckResult {
  if (cli === undefined) {
    const why = rejected.map((r) => `${r.path}: ${r.detail}`).join('\n')
    return vendorCheck(
      'bin',
      'fail',
      'Claude Code is not installed',
      why !== ''
        ? `No usable Claude Code CLI was found.\n${why}`
        : 'No Claude Code CLI was found on this computer.',
      at,
      { category: 'cli_missing', recovery: installActions() },
    )
  }
  const via = cli.kind === 'node-entry' ? `; runs with ${cli.command}` : ''
  const where = `${cli.path} (${SOURCE_LABEL[cli.source]}${via})`
  if (cli.source === 'desktop-bundle' || cli.warnings.length > 0) {
    return vendorCheck(
      'bin',
      'warn',
      'Claude Code found (bundled copy)',
      [where, ...cli.warnings].join('\n'),
      at,
      {
        recovery: defined([
          shellCopy(
            'claude.install',
            'Copy the install command',
            'install',
            'Install a standalone Claude Code',
            'bin',
          ),
        ]),
      },
    )
  }
  return vendorCheck('bin', 'pass', 'Claude Code found', where, at)
}

export function versionCheck(version: string, at: number): CheckResult {
  if (compareVersions(version, VERSION_FLOOR) < 0) {
    return vendorCheck(
      'version',
      'fail',
      `Claude Code ${version} is too old`,
      `Dim Factory needs ${VERSION_FLOOR} or newer (${VERSION_RECOMMENDED} recommended).`,
      at,
      {
        category: 'cli_version',
        recovery: defined([
          shellCopy('claude.update', 'Copy the update command', 'update', 'Update Claude Code', 'version'),
        ]),
      },
    )
  }
  if (compareVersions(version, VERSION_RECOMMENDED) < 0) {
    return vendorCheck(
      'version',
      'warn',
      `Claude Code ${version} works; ${VERSION_RECOMMENDED} is recommended`,
      'Update Claude Code when convenient.',
      at,
      {
        recovery: defined([
          shellCopy('claude.update', 'Copy the update command', 'update', 'Update Claude Code', 'version'),
        ]),
      },
    )
  }
  if (compareVersions(version, TESTED_UP_TO) > 0) {
    return vendorCheck(
      'version',
      'warn',
      `Claude Code ${version} is newer than tested (${TESTED_UP_TO})`,
      `If a flag fails, apply the suggested flagMap patch or install ${TESTED_UP_TO}.`,
      at,
      {
        recovery: defined([
          shellCopy(
            'claude.pin',
            `Copy the install command for ${TESTED_UP_TO}`,
            'pin',
            'Install the tested version',
            'version',
            TESTED_UP_TO,
          ),
        ]),
      },
    )
  }
  return vendorCheck('version', 'pass', `Claude Code ${version}`, `Tested up to ${TESTED_UP_TO}.`, at)
}

// ---- auth -------------------------------------------------------------------------------------------------

export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  subscriptionType?: string
  apiKeySource?: string
}

/** `claude auth status` JSON (meta/auth-status*.txt); email and organization are never read. */
export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  const v = parseFrame(stdout.slice(start, end + 1).replace(/\r?\n/g, ' '))
  if (v === undefined || typeof v['loggedIn'] !== 'boolean') return undefined
  const out: AuthStatus = { loggedIn: v['loggedIn'] }
  for (const k of ['authMethod', 'apiProvider', 'subscriptionType', 'apiKeySource'] as const) {
    const s = str(v[k])
    if (s !== undefined) out[k] = s
  }
  return out
}

const ACCOUNT_LINE = /\b(?:e-?mail|organi[sz]ation|org(?:anization)?[ _-]?(?:id|name))\b/i

/** The first stderr line that names no account, redacted and capped. */
function safeStderr(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !ACCOUNT_LINE.test(l))
  return line === undefined ? '' : redactText(line, { mode: 'diagnostics' }).text.slice(0, 200)
}

export function authChecks(
  r: { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: SpawnError },
  env: EnvInput,
  at: number,
): { checks: CheckResult[]; account?: ProbeAccount } {
  const status = r.error === undefined && !r.timedOut ? parseAuthStatus(r.stdout) : undefined
  const login = shellCopy(
    'claude.login',
    'Copy the login command',
    'login',
    'Claude Code is not logged in',
    'auth',
  )
  const checks: CheckResult[] = []
  let account: ProbeAccount | undefined
  if (status === undefined) {
    // Never echo stdout: the text form prints the account email and organization (meta/auth-status-text.txt).
    const why =
      r.error?.message ??
      (r.timedOut
        ? 'timed out'
        : [`exit ${r.code ?? '?'}; the output was not the expected JSON`, safeStderr(r.stderr)]
            .filter((s) => s !== '')
            .join('; '))
    checks.push(
      vendorCheck(
        'auth',
        'warn',
        'Could not read the Claude login status',
        `claude auth status: ${why}`,
        at,
        {
          recovery: defined([login]),
        },
      ),
    )
  } else if (!status.loggedIn) {
    checks.push(
      vendorCheck(
        'auth',
        'fail',
        'Claude Code is not logged in',
        'Run the login command in a terminal, then re-check.',
        at,
        {
          category: 'auth_required',
          recovery: defined([login]),
        },
      ),
    )
  } else {
    account = { method: status.authMethod ?? 'unknown' }
    if (status.subscriptionType !== undefined) account.plan = status.subscriptionType
    const plan = status.subscriptionType !== undefined ? ` (${status.subscriptionType})` : ''
    checks.push(vendorCheck('auth', 'pass', 'Logged in', `${status.authMethod ?? 'unknown'}${plan}`, at))
  }
  const key = getEnv(env, 'ANTHROPIC_API_KEY')
  if (key !== undefined && key !== '' && status?.authMethod === 'api_key') {
    // The key is the login Claude Code reports; nothing overrides anything.
    checks.push(
      vendorCheck(
        'env',
        'pass',
        'Using ANTHROPIC_API_KEY',
        'Claude Code signs in with this API key and bills it. The key is not checked until a run.',
        at,
      ),
    )
  } else if (key !== undefined && key !== '') {
    checks.push(
      vendorCheck(
        'env',
        'warn',
        'ANTHROPIC_API_KEY is set',
        `The key overrides your ${status?.authMethod ?? 'current'} login in Dim Factory's headless runs.`,
        at,
        {
          recovery: defined([
            shellCopy(
              'claude.unset-key',
              'Copy the command to unset it',
              'unsetApiKey',
              'Use your Claude subscription',
              'env',
            ),
          ]),
        },
      ),
    )
  } else {
    checks.push(vendorCheck('env', 'pass', 'No API key override', 'ANTHROPIC_API_KEY is not set.', at))
  }
  return account !== undefined ? { checks, account } : { checks }
}

// ---- protocol handshake -----------------------------------------------------------------------------------

export function toModelInfo(m: SdkModelInfo): ModelInfo {
  const out: ModelInfo = { id: m.value, source: 'cli' }
  if (m.displayName) out.label = m.displayName
  if (m.resolvedModel !== undefined && m.resolvedModel !== m.value) out.aliases = [m.resolvedModel]
  if (m.value === 'default') out.isDefault = true
  if (m.supportedEffortLevels !== undefined && m.supportedEffortLevels.length > 0)
    out.efforts = [...m.supportedEffortLevels]
  return out
}

/**
 * What the initialize reply lists besides the CLI's own (names only, kept in memory for Settings > Extensions, never
 * logged or stored): the skills and commands it does not mark built in (the user's, the project's, plugins' and the
 * skills claude.ai syncs to the account) and the subagents that are not the CLI's.
 */
export interface HandshakeNames {
  skills: string[]
  agents: string[]
}

/** The names an initialize reply lists that are not the CLI's own (see {@link HandshakeNames}). */
export function handshakeNames(response: unknown): HandshakeNames {
  const r = obj(response)
  const names = (list: unknown, keep: (o: Record<string, unknown>) => boolean): string[] =>
    Array.isArray(list)
      ? [
          ...new Set(
            list.flatMap((c) => {
              const o = obj(c)
              const n = str(o?.['name'])
              return o !== undefined && n !== undefined && n !== '' && keep(o) ? [n] : []
            }),
          ),
        ]
      : []
  return {
    skills: names(r?.['commands'], (o) => o['builtin'] !== true),
    agents: names(r?.['agents'], (o) => !BUILTIN_AGENTS.includes(str(o['name']) ?? '')),
  }
}

export interface HandshakeResult {
  ok: boolean
  models: ModelInfo[]
  /** The user's, the project's and plugins' skills and subagents the reply listed (absent when it failed). */
  names?: HandshakeNames
  ms: number
  /** Frames other than the initialize reply (a model call would show up here). */
  unexpected: string[]
  error?: string
  exitCode?: number | null
  stderr: string[]
}

/** Spawn, send initialize, wait for its reply, close stdin. Never sends a user message. */
export async function initializeHandshake(o: {
  cli: ResolvedCli
  env: Record<string, string>
  cwd: string
  /** Default: {@link probeArgv} without user flags. */
  args?: readonly string[]
  timeoutMs?: number
  tap?: (dir: 'in' | 'out' | 'err', line: string) => void
}): Promise<HandshakeResult> {
  const start = Date.now()
  let child: ChildHandle
  try {
    child = await spawnChild({
      cli: o.cli,
      args: o.args ?? probeArgv(),
      cwd: o.cwd,
      env: o.env,
      label: { purpose: 'probe' },
      ...(o.tap !== undefined ? { tap: o.tap } : {}),
    })
  } catch (err) {
    const e = SpawnError.from(err, o.cli.command)
    return {
      ok: false,
      models: [],
      ms: Date.now() - start,
      unexpected: [],
      error: `${e.code}: ${e.message}`,
      stderr: [],
    }
  }
  const requestId = 'probe-init-1'
  const unexpected: string[] = []
  let models: ModelInfo[] = []
  let names: HandshakeNames | undefined
  let replied = false
  let replyError: string | undefined
  let onReply: () => void = () => undefined
  const replyP = new Promise<'reply'>((resolve) => {
    onReply = () => resolve('reply')
  })
  const reader = (async () => {
    for await (const line of child.lines('stdout')) {
      const f = parseFrame(line)
      if (f?.['type'] === 'control_response') {
        const body = obj(f['response'])
        if (str(body?.['request_id']) !== requestId) continue
        replied = true
        if (body?.['subtype'] === 'success') {
          const list = obj(body['response'])?.['models']
          if (Array.isArray(list)) models = list.flatMap((m) => (isSdkModel(m) ? [toModelInfo(m)] : []))
          names = handshakeNames(body['response'])
        } else {
          replyError = str(body?.['error']) ?? 'initialize failed'
        }
        child.closeStdin()
        onReply()
      } else if (f !== undefined && f['type'] !== 'keep_alive') {
        unexpected.push(
          `${str(f['type']) ?? '?'}${f['subtype'] !== undefined ? `/${str(f['subtype'])}` : ''}`,
        )
      }
    }
  })()
  await child.writeLine(initializeRequest(requestId))
  const timeoutMs = o.timeoutMs ?? INITIALIZE_TIMEOUT_MS
  const waited = await Promise.race([
    replyP,
    child.exited.then(() => 'exit' as const),
    delay(timeoutMs, 'timeout' as const, { ref: false }),
  ])
  if (waited === 'timeout' || !replied) child.closeStdin()
  const exitedInTime = await Promise.race([
    child.exited.then(() => true),
    delay(HANDSHAKE_EXIT_WAIT_MS, false, { ref: false }),
  ])
  if (!exitedInTime) await stopChild(child, { stdinWaitMs: 0 })
  const exit = await child.exited
  await reader.catch(() => undefined)
  const result: HandshakeResult = {
    ok: replied && replyError === undefined,
    models,
    ms: Date.now() - start,
    unexpected,
    exitCode: exit.code,
    stderr: child.stderrTail(20),
    ...(names !== undefined ? { names } : {}),
  }
  if (!replied)
    result.error =
      waited === 'timeout' ? `no initialize reply within ${timeoutMs} ms` : 'the CLI exited before replying'
  else if (replyError !== undefined) result.error = replyError
  return result
}

/** How long a connector listing waits for the connectors to leave `pending`, and how often it asks. */
export const CONNECTORS_WAIT_MS = 12_000
const CONNECTORS_POLL_MS = 1_000

/**
 * The claude.ai connectors of the account (extensions/claude-connectors.ts): an initialize-only session with strict MCP
 * off (`args`, default {@link connectorArgv}) that asks `mcp_status` until no connector is pending or `waitMs` has
 * passed, then closes stdin. Never sends a user message (no tokens, C22a). The caller checks first that the session
 * would start no other MCP server.
 */
export async function listConnectors(o: {
  cli: ResolvedCli
  env: Record<string, string>
  cwd: string
  args: readonly string[]
  timeoutMs?: number
  waitMs?: number
  pollMs?: number
}): Promise<ConnectorListing> {
  let child: ChildHandle
  try {
    child = await spawnChild({
      cli: o.cli,
      args: o.args,
      cwd: o.cwd,
      env: o.env,
      label: { purpose: 'probe' },
    })
  } catch (err) {
    const e = SpawnError.from(err, o.cli.command)
    return { ok: false, error: `${e.code}: ${e.message}` }
  }
  const waiters = new Map<string, (body: Record<string, unknown> | undefined) => void>()
  const reader = (async () => {
    for await (const line of child.lines('stdout')) {
      const f = parseFrame(line)
      if (f?.['type'] !== 'control_response') continue
      const body = obj(f['response'])
      const id = str(body?.['request_id'])
      const w = id !== undefined ? waiters.get(id) : undefined
      if (w !== undefined && id !== undefined) {
        waiters.delete(id)
        w(body)
      }
    }
  })()
  const exited = child.exited.then(() => undefined)
  const ask = async (
    id: string,
    frame: unknown,
    ms: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const reply = new Promise<Record<string, unknown> | undefined>((resolve) => waiters.set(id, resolve))
    await child.writeLine(frame)
    return Promise.race([reply, exited, delay(ms, undefined, { ref: false })])
  }
  let result: ConnectorListing = { ok: false, error: 'Claude Code did not answer the startup handshake' }
  try {
    const init = await ask(
      'connectors-init-1',
      initializeRequest('connectors-init-1'),
      o.timeoutMs ?? INITIALIZE_TIMEOUT_MS,
    )
    if (init?.['subtype'] === 'success') {
      const deadline = Date.now() + (o.waitMs ?? CONNECTORS_WAIT_MS)
      for (let n = 1; ; n++) {
        const id = `connectors-status-${n}`
        const body = await ask(
          id,
          { type: 'control_request', request_id: id, request: { subtype: 'mcp_status' } },
          o.timeoutMs ?? INITIALIZE_TIMEOUT_MS,
        )
        if (body?.['subtype'] !== 'success') {
          result = { ok: false, error: 'Claude Code did not report its MCP servers' }
          break
        }
        const connectors = parseConnectors(body['response'])
        result = { ok: true, connectors }
        if (!connectors.some((c) => c.status === 'pending') || Date.now() >= deadline) break
        await delay(o.pollMs ?? CONNECTORS_POLL_MS, undefined, { ref: false })
      }
    } else if (init !== undefined) {
      result = { ok: false, error: str(init['error']) ?? 'initialize failed' }
    }
  } finally {
    child.closeStdin()
    const exitedInTime = await Promise.race([
      child.exited.then(() => true),
      delay(HANDSHAKE_EXIT_WAIT_MS, false, { ref: false }),
    ])
    if (!exitedInTime) await stopChild(child, { stdinWaitMs: 0 })
    await child.exited
    await reader.catch(() => undefined)
  }
  return result
}

export function protocolCheck(h: HandshakeResult, at: number): CheckResult {
  if (!h.ok) {
    const detail = [h.error ?? 'initialize failed', ...h.stderr.slice(-5)].join('\n')
    return vendorCheck('protocol', 'fail', 'Claude Code did not answer the startup handshake', detail, at, {
      category: 'flag_drift',
      recovery: defined([
        { id: 'claude.heal', label: 'Diagnose with AI', kind: 'heal' },
        shellCopy('claude.update', 'Copy the update command', 'update', 'Update Claude Code', 'protocol'),
      ]),
    })
  }
  const extra = h.unexpected.length > 0 ? ` Unexpected frames: ${h.unexpected.join(', ')}.` : ''
  return vendorCheck(
    'protocol',
    h.unexpected.some((u) => u === 'result' || u === 'assistant') ? 'warn' : 'pass',
    'Control protocol works',
    `initialize answered in ${h.ms} ms with ${h.models.length} models; no tokens spent.${extra}`,
    at,
  )
}

/** `vendors.claude.{extraArgs,flagMap}` cannot be used: the handshake (and every pass) would refuse to start. */
export function protocolConfigCheck(problem: string, at: number): CheckResult {
  return vendorCheck('protocol', 'fail', 'Claude Code flags in your settings are not allowed', problem, at, {
    category: 'config_invalid',
    recovery: [
      {
        id: 'claude.flags',
        label: 'Edit the Claude flags',
        kind: 'settings_link',
        route: 'settings/vendors',
        pointer: '/vendors/claude',
      },
    ],
  })
}

export function planCheck(version: string | undefined, at: number): CheckResult {
  if (version !== undefined && compareVersions(version, VERSION_FLOOR) >= 0) {
    return vendorCheck(
      'plan',
      'pass',
      'Native plan mode',
      'Plan runs in Claude plan mode; Dim Factory captures the plan.',
      at,
    )
  }
  return vendorCheck('plan', 'skip', 'Native plan mode', 'Needs a supported Claude Code version.', at)
}

const isSdkModel = (m: unknown): m is SdkModelInfo => typeof obj(m)?.['value'] === 'string'

/** `claude auth status` with the pass env (JSON; exit 1 when logged out). */
export function runAuthStatus(
  cli: ResolvedCli,
  env: Record<string, string>,
  cwd: string,
): Promise<CaptureResult> {
  return execCapture(cli.command, [...cli.prefixArgs, 'auth', 'status'], {
    env,
    cwd,
    timeoutMs: AUTH_TIMEOUT_MS,
  })
}
