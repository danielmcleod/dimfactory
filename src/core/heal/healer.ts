// The self-healer (the internal/heal.md template; state machine row P17): builds the filtered input, consults
// the 24 h cache, runs the selfHeal vendor read-only (Claude: the read-only tool cut plus Bash, PowerShell,
// WebFetch and WebSearch disallowed) in a Dim Factory-owned folder for at most 90 s, and parses its one JSON block into
// safe RecoveryActions. The healer never sees the task, plan, diff or any file body, and never touches the user's
// folder.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Failure, FailureCategory, RecoveryAction } from '../../shared/failure.ts'
import { allowedExternalUrl } from '../../shared/external-links.ts'
import type { RedactOptions } from '../../shared/redact.ts'
import type { StepKey } from '../../shared/run.ts'
import type { ProbeResult } from '../../shared/vendors.ts'
import { HEAL_VENDORS } from '../../shared/vendors.ts'
import type { AdapterRegistry } from '../adapters/registry.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions } from '../adapters/types.ts'
import { gitVersion } from '../git/exec.ts'
import { homePaths } from '../home.ts'
import { normalizeText, render } from '../prompts/template.ts'
import { flagKey } from '../recovery/config-patch.ts'
import { docsUrlFor, osFamily } from './commands.ts'
import { HealCache, healCacheKey } from './heal-cache.ts'
import type { HealEnv } from './heal-input.ts'
import { buildHealInput, cleanHealText, healRedactOptions, localHealEnv } from './heal-input.ts'
import type { HealAnswer, SafeActionsContext } from './parse-heal.ts'
import { parseHealAnswer, toSafeActions } from './parse-heal.ts'

export {
  buildHealInput,
  filterHealLine,
  filterHealTail,
  readHealTail,
  projectFrame,
  HEAL_TAIL_LINES,
  HEAL_STRING_MAX,
} from './heal-input.ts'
export type { HealEnv, HealInput, HealInputContext } from './heal-input.ts'

/** The healer gets 90 s. */
export const HEAL_TIMEOUT_MS = 90_000
/** After the answer (or a stop), how long the process may take to exit before it is stopped again. */
const EXIT_GRACE_MS = 10_000
/** Read-only passes never ask; anything that still does is denied by the adapter or here. */
const HEAL_ASK_TIMEOUT_MS = 30_000
/** The raw error kept in a failed outcome. */
const ERROR_MAX = 2000
export const NO_HEALER_MESSAGE =
  'No AI vendor is ready to diagnose this. Self-heal uses your Self-heal vendor, ' +
  'or Claude or Codex when that one is not ready.'

// ---- contract (shared with the recovery dispatcher) ----------------------------------------------------------------

export interface HealRequest {
  runId?: string
  step?: StepKey | 'probe'
  failure: Failure
  trigger: 'auto' | 'user'
  /** The failing pass's vendor. */
  vendor: string
  vendorVersion: string | null
  /** The failing spawn's argv (procs.json), never the prompt. */
  passArgv: readonly string[]
  /** Evidence lines; filtered again here (heal-input.ts filterHealTail), so raw-log lines are safe too. */
  tail: readonly string[]
}

export interface HealOutcome {
  status: 'ok' | 'cached' | 'failed' | 'disabled'
  diagnosis?: string
  confidence?: 'high' | 'medium' | 'low'
  category?: FailureCategory
  /** Safe actions, with ids. */
  actions: RecoveryAction[]
  /** Unsafe or malformed suggestions dropped ("Dim Factory hid N unsafe suggestions"). */
  hidden: number
  error?: string
  at: number
}

export interface SelfHealSettings {
  enabled: boolean
  vendor: string
  model: string | null
  autoApplyConfigPatches: boolean
}

export type HealerLog = { [K in 'info' | 'warn']: (msg: string, data?: Record<string, unknown>) => void }

export interface HealerDeps {
  /** DIM_FACTORY_HOME (cwd `runs/<id>/heal/` or `tmp/heal/<id>/`, cache `heal/cache.json`). */
  home: string
  registry: Pick<AdapterRegistry, 'get' | 'isBuilt' | 'list'>
  /** The user's `selfHeal` settings. */
  selfHeal: SelfHealSettings
  /** Is the vendor ready to answer (default: its adapter is built and its probe is ok). */
  isReady?: (vendor: string) => Promise<boolean>
  /** The failing vendor's probe for the evidence (versions and check statuses only); default none. */
  probe?: (vendor: string) => Promise<ProbeResult | null>
  /**
   * `vendors.<id>.flagMap`: a renamed flag must reach the healer's own spawn too. extraArgs are left out, and so are
   * renames of the flags that keep the healer read-only and hermetic ({@link healerFlagMap}).
   */
  flagMap?: (vendor: string) => Readonly<Record<string, string>> | undefined
  /** OS and tool versions (default: this machine, git from core/git). */
  env?: () => Promise<HealEnv>
  /** null: no cache (tests); default `heal/cache.json`. */
  cache?: HealCache | null
  now?: () => number
  timeoutMs?: number
  /** The heal template text (default: internal/heal.md). */
  template?: string
  platform?: NodeJS.Platform
  redact?: RedactOptions
  log?: HealerLog
}

// ---- template ------------------------------------------------------------------------------------------------------

/**
 * Where internal/heal.md is read from: next to the sources (src/core/prompts/internal/), or, in the bundled app whose
 * core is out/main/index.js, `out/main/internal/` (the build copies it there).
 */
export const HEAL_TEMPLATE_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL('../prompts/internal/heal.md', import.meta.url)),
  fileURLToPath(new URL('./internal/heal.md', import.meta.url)),
]

let templateMemo: string | undefined

/** The heal template (internal/heal.md, normalized). Throws when no copy is found. */
export function readHealTemplate(candidates: readonly string[] = HEAL_TEMPLATE_CANDIDATES): string {
  if (candidates === HEAL_TEMPLATE_CANDIDATES && templateMemo !== undefined) return templateMemo
  for (const path of candidates) {
    try {
      const text = normalizeText(readFileSync(path, 'utf8'))
      if (candidates === HEAL_TEMPLATE_CANDIDATES) templateMemo = text
      return text
    } catch {
      // try the next location
    }
  }
  throw new Error(`The heal prompt template is missing (looked in ${candidates.join(', ')})`)
}

// ---- outcomes ------------------------------------------------------------------------------------------------------

const newIdPrefix = (): string => `heal-${randomBytes(4).toString('hex')}`

function displayName(deps: HealerDeps, vendor: string): string {
  return deps.registry.get(vendor)?.displayName ?? vendor
}

function docsAction(deps: HealerDeps, vendor: string, idPrefix: string): RecoveryAction[] {
  const raw = docsUrlFor(vendor)
  const url = raw === null ? null : allowedExternalUrl(raw)
  if (url === null) return []
  return [
    {
      id: `${idPrefix}-docs`,
      label: `Open the ${displayName(deps, vendor)} install docs`,
      kind: 'open_docs',
      url,
    },
  ]
}

function failed(
  deps: HealerDeps,
  req: HealRequest,
  error: string,
  idPrefix: string,
  at: number,
): HealOutcome {
  const text = error.length > ERROR_MAX ? `${error.slice(0, ERROR_MAX - 1)}\u2026` : error
  return { status: 'failed', error: text, actions: docsAction(deps, req.vendor, idPrefix), hidden: 0, at }
}

function answered(
  status: 'ok' | 'cached',
  answer: HealAnswer,
  ctx: SafeActionsContext,
  at: number,
): HealOutcome {
  const safe = toSafeActions(answer, ctx)
  const out: HealOutcome = {
    status,
    diagnosis: answer.diagnosis,
    confidence: answer.confidence,
    actions: safe.actions,
    hidden: safe.hidden,
    at,
  }
  if (answer.category !== undefined) out.category = answer.category
  return out
}

/** Managed flags of the vendors built into this Dim Factory (a heal may touch no other vendor's flags). */
function builtManagedFlags(registry: HealerDeps['registry']): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const e of registry.list()) if (e.built) out[e.id] = e.adapter.managedFlags
  return out
}

/** Every flag each built vendor's CLI already defines (never a flagMap rename target). */
function builtCliFlags(registry: HealerDeps['registry']): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const e of registry.list()) {
    if (e.built && e.adapter.cliFlags !== undefined) out[e.id] = e.adapter.cliFlags
  }
  return out
}

/**
 * The flags that hold the healer read-only and hermetic (the read-only tool cut with Bash, PowerShell, WebFetch and
 * WebSearch added, no MCP, no hooks, no prompts): the user's flagMap never renames them for the healer's own spawn
 * Should the CLI really have renamed one, the healer fails with the CLI's error and the vendor's docs.
 */
const HEALER_OWN_FLAGS: ReadonlySet<string> = new Set(
  [
    '--disallowedTools',
    '--disallowed-tools',
    '--strict-mcp-config',
    '--settings',
    '--permission-prompts',
    // Codex's read-only sandbox, its approvals and the ephemeral thread (exec route `--sandbox read-only`, …).
    '--sandbox',
    '-s',
    '--ask-for-approval',
    '--ephemeral',
    '--config',
  ].map(flagKey),
)

/** The user's flagMap as the healer's spawn uses it: without renames of {@link HEALER_OWN_FLAGS}. */
export function healerFlagMap(
  flagMap: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (flagMap === undefined) return undefined
  const out = Object.fromEntries(
    Object.entries(flagMap).filter(([from]) => !HEALER_OWN_FLAGS.has(flagKey(from))),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

// ---- vendor choice -----------------------------------------------------------------------------------------------

interface HealerChoice {
  vendor: string
  adapter: Adapter
  model: string | null
}

/**
 * The `selfHeal` vendor, else the first ready of claude and codex. Only the vendors the healer has a
 * read-only route for (HEAL_VENDORS: Claude's read-only tool cut, Codex read-only and ephemeral) run it; a
 * `selfHeal.vendor` such as
 * Gemini falls back like a vendor that is not ready.
 */
async function chooseHealer(deps: HealerDeps): Promise<HealerChoice | null> {
  const candidates = [...new Set([deps.selfHeal.vendor, ...HEAL_VENDORS])].filter((v) =>
    (HEAL_VENDORS as readonly string[]).includes(v),
  )
  for (const vendor of candidates) {
    if (!deps.registry.isBuilt(vendor)) continue
    const adapter = deps.registry.get(vendor)
    if (adapter === undefined) continue
    let ready: boolean
    try {
      ready = deps.isReady !== undefined ? await deps.isReady(vendor) : (await adapter.probe()).ok
    } catch {
      ready = false
    }
    if (!ready) continue
    // The configured model is an id for the configured vendor only; a fallback vendor uses its default.
    return { vendor, adapter, model: vendor === deps.selfHeal.vendor ? deps.selfHeal.model : null }
  }
  return null
}

// ---- one healer process --------------------------------------------------------------------------------------------

type Conversation = { kind: 'done'; text: string } | { kind: 'failed'; error: string }

function delay(ms: number): Promise<'late'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('late'), ms).unref()
  })
}

async function settleProcess(adapter: Adapter, handle: RunHandle): Promise<void> {
  const r = await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
  if (r !== 'late') return
  await adapter.stop(handle, 'user').catch(() => undefined)
  await Promise.race([handle.exited, delay(EXIT_GRACE_MS)])
}

function exitText(info: ExitInfo): string {
  return info.signal !== null ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`
}

async function converse(
  choice: HealerChoice,
  opts: StartOptions,
  timeoutMs: number,
  redact: RedactOptions,
): Promise<Conversation> {
  const { adapter } = choice
  const handle = adapter.start(opts)
  let text = ''
  const result = await new Promise<Conversation>((resolve) => {
    let settled = false
    const finish = (r: Conversation): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({
        kind: 'failed',
        error: `The diagnosis took longer than ${Math.round(timeoutMs / 1000)} s, so Dim Factory stopped it.`,
      })
      void adapter.stop(handle, 'timeout').catch(() => undefined)
    }, timeoutMs)
    handle.onEvent((e) => {
      switch (e.type) {
        case 'text':
          text += e.delta
          return
        case 'done':
          finish({ kind: 'done', text: e.result.trim() !== '' ? e.result : text })
          return
        case 'error':
          if (e.fatal) {
            const raw = e.raw.trim() !== '' ? `\n${cleanHealText(e.raw, redact, ERROR_MAX)}` : ''
            finish({ kind: 'failed', error: `${cleanHealText(e.message, redact, 500)}${raw}` })
          }
          return
        case 'ask':
          // A read-only heal never needs a permission; refuse anything that asks.
          adapter.answer(handle, e.requestId, 'deny')
          return
        case 'session':
        case 'tool':
          return
      }
    })
    void handle.exited.then((info) =>
      finish({
        kind: 'failed',
        error: `${adapter.displayName} ended without an answer (${exitText(info)}).`,
      }),
    )
  })
  await settleProcess(adapter, handle)
  return result
}

// ---- runHealer -----------------------------------------------------------------------------------------------------

async function defaultEnv(platform: NodeJS.Platform): Promise<HealEnv> {
  const git = await gitVersion().then(
    (v) => `${v.major}.${v.minor}.${v.patch}`,
    () => null,
  )
  return localHealEnv(git, platform)
}

/**
 * Diagnose one failure. Never throws: every problem (no ready vendor, a timeout, an unreadable answer) is a `failed`
 * outcome carrying the raw error and the failing vendor's install docs. `disabled` when self-heal is off and the
 * trigger is automatic (a user's "Diagnose with AI" still runs).
 */
export async function runHealer(deps: HealerDeps, req: HealRequest): Promise<HealOutcome> {
  const now = deps.now ?? Date.now
  const idPrefix = newIdPrefix()
  if (!deps.selfHeal.enabled && req.trigger === 'auto') {
    return {
      status: 'disabled',
      actions: [
        {
          id: `${idPrefix}-settings`,
          label: 'Open Self-heal settings',
          kind: 'settings_link',
          route: 'settings/self-heal',
          pointer: '/selfHeal/enabled',
        },
      ],
      hidden: 0,
      at: now(),
    }
  }
  const platform = deps.platform ?? process.platform
  const os = osFamily(platform)
  const redact = deps.redact ?? healRedactOptions()
  const log = deps.log
  let tmpDir: string | undefined
  try {
    const [env, probe] = await Promise.all([
      (deps.env?.() ?? defaultEnv(platform)).catch(() => localHealEnv(null, platform)),
      (deps.probe?.(req.vendor) ?? Promise.resolve(null)).catch(() => null),
    ])
    const input = buildHealInput(req, { env, probe, redact })
    const ctx: SafeActionsContext = {
      os,
      vendor: req.vendor,
      managedFlags: builtManagedFlags(deps.registry),
      cliFlags: builtCliFlags(deps.registry),
      inRun: req.runId !== undefined,
      idPrefix,
    }
    const cache =
      deps.cache === undefined ? new HealCache(homePaths(deps.home).healCache, { now }) : deps.cache
    const key = healCacheKey({
      category: req.failure.category,
      vendor: req.vendor,
      version: req.vendorVersion,
      signature: input.signature,
    })
    if (cache !== null) {
      const hit = await cache.get(key).catch(() => undefined)
      if (hit !== undefined) return answered('cached', hit.answer, ctx, now())
    }

    const choice = await chooseHealer(deps)
    if (choice === null) {
      return failed(deps, req, NO_HEALER_MESSAGE, idPrefix, now())
    }
    let prompt: string
    try {
      prompt = render(deps.template ?? readHealTemplate(), input.values, { template: 'heal' }).text
    } catch (err) {
      return failed(deps, req, err instanceof Error ? err.message : String(err), idPrefix, now())
    }

    const hp = homePaths(deps.home)
    let cwd: string
    if (req.runId !== undefined) {
      cwd = hp.run(req.runId).healDir
    } else {
      cwd = hp.healTmp(`${now()}-${idPrefix}`)
      tmpDir = cwd
    }
    await mkdir(cwd, { recursive: true })
    const flagMap = healerFlagMap(deps.flagMap?.(choice.vendor))
    const opts: StartOptions = {
      runId: req.runId ?? idPrefix,
      step: 'heal',
      cwd,
      prompt,
      model: choice.model,
      mode: 'readonly',
      planNative: false,
      allowRules: [],
      trustFolder: false,
      ephemeral: true,
      askTimeoutMs: HEAL_ASK_TIMEOUT_MS,
      ...(flagMap !== undefined ? { flagMap } : {}),
    }
    log?.info('self-heal started', {
      runId: req.runId,
      step: req.step,
      category: req.failure.category,
      healer: choice.vendor,
      trigger: req.trigger,
    })
    const r = await converse(choice, opts, deps.timeoutMs ?? HEAL_TIMEOUT_MS, redact)
    if (r.kind === 'failed') {
      log?.warn('self-heal failed', { runId: req.runId, step: req.step, healer: choice.vendor })
      return failed(deps, req, r.error, idPrefix, now())
    }
    const parsed = parseHealAnswer(r.text)
    if (!parsed.ok) {
      const excerpt = cleanHealText(r.text, redact, 600)
      return failed(
        deps,
        req,
        `${parsed.error}${excerpt !== '' ? `\nThe answer began: ${excerpt}` : ''}`,
        idPrefix,
        now(),
      )
    }
    if (cache !== null) {
      await cache
        .set(key, { at: now(), healer: choice.vendor, answer: parsed.answer })
        .catch((err: unknown) => {
          log?.warn('self-heal cache write failed', { err: err instanceof Error ? err.message : String(err) })
        })
    }
    const out = answered('ok', parsed.answer, ctx, now())
    log?.info('self-heal answered', {
      runId: req.runId,
      step: req.step,
      healer: choice.vendor,
      actions: out.actions.length,
      hidden: out.hidden,
    })
    return out
  } catch (err) {
    return failed(deps, req, err instanceof Error ? err.message : String(err), idPrefix, now())
  } finally {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
        () => undefined,
      )
    }
  }
}
