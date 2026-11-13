// probe() for Muse (the probe's Muse checks: bin resolve; version record; auth META_API_KEY;
// protocol "schema hash vs pinned (warn)"; plan emulated). Token-free: `--version` (the resolver), `exec --help` (the
// flags a pass needs) and the printed schema. Nothing runs a turn, and Muse's own files (settings, credentials) are
// never read.
import type { CheckResult, CheckStatus } from '../../../shared/preflight.ts'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { ProbeAccount } from '../../../shared/vendors.ts'
import type { EnvInput } from '../../proc/env.ts'
import { getEnv } from '../../proc/env.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { execCapture } from '../../proc/spawn.ts'
import { defined, helpHasFlag, shellCopy, switchToClaude, vendorCheck } from '../acp-base/probe.ts'
import type { HelpText } from '../acp-base/probe.ts'
import { MUSE_REQUIRED_EXEC_FLAGS } from './capabilities.ts'
import { MUSE_DISPLAY_NAME, MUSE_VENDOR } from './cli-spec.ts'
import type { MusePin } from './protocol.ts'
import { MUSE_SCHEMA_PROBE_ARGS, READ_PAYLOAD_TYPES, schemaHash } from './protocol.ts'

const NAME = MUSE_DISPLAY_NAME
export const MUSE_HELP_ARGS: readonly string[] = ['exec', '--help']
export const SCHEMA_TIMEOUT_MS = 20_000
const SCHEMA_MAX_BYTES = 8 * 1024 * 1024

const keySet = (env: EnvInput): boolean => (getEnv(env, 'META_API_KEY') ?? '').trim() !== ''

const update = (): RecoveryAction[] =>
  defined([
    shellCopy(MUSE_VENDOR, 'muse.update', 'Copy the update command', 'update', `Update ${NAME}`, 'protocol'),
  ])

/** vendor.muse.version: recorded, never judged (no floor; Muse support is Experimental). */
export function museVersionCheck(version: string, targetVersion: string, at: number): CheckResult {
  return vendorCheck(
    MUSE_VENDOR,
    'version',
    'pass',
    `${NAME} ${version}`,
    `Dim Factory records the version only. Its Muse support is Experimental and was written from Muse's documentation (${targetVersion}).`,
    at,
  )
}

/**
 * vendor.muse.auth (`META_API_KEY`). The key always wins over a stored sign-in (dev.meta.ai/docs/muse-code/auth),
 * so with it set Muse is signed in. Without it Dim Factory cannot tell (it never reads Muse's stored credentials): a
 * warning with the sign-in command, never a block.
 */
export function museAuthCheck(env: EnvInput, at: number): CheckResult {
  if (keySet(env)) {
    return vendorCheck(
      MUSE_VENDOR,
      'auth',
      'pass',
      'Signed in',
      `${NAME} signs in with an API key (META_API_KEY), which takes priority over a stored sign-in.`,
      at,
    )
  }
  return vendorCheck(
    MUSE_VENDOR,
    'auth',
    'warn',
    `${NAME} sign-in not checked`,
    `Dim Factory checks only META_API_KEY, and it is not set. If you signed in from ${NAME} itself, passes work; otherwise they stop with a sign-in error. Run ${NAME} once in a terminal and sign in, or set META_API_KEY.`,
    at,
    {
      category: 'auth_required',
      recovery: defined([
        shellCopy(
          MUSE_VENDOR,
          'muse.login',
          'Copy the sign-in command',
          'login',
          `${NAME} may not be signed in`,
          'auth',
        ),
        switchToClaude(MUSE_VENDOR),
      ]),
    },
  )
}

/** Subscription auth: the sign-in method only. An API key bills per token; a stored sign-in is not known. */
export function museAccount(env: EnvInput): ProbeAccount | undefined {
  return keySet(env) ? { method: 'api-key' } : undefined
}

/** What `muse schema …` printed, or why nothing was read. */
export interface SchemaText {
  args?: readonly string[]
  text?: string
  error?: string
}

/** The first schema command that prints something (MUSE_SCHEMA_PROBE_ARGS). */
export async function readSchema(o: {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  env: Record<string, string>
  cwd: string
  timeoutMs?: number
}): Promise<SchemaText> {
  let last = 'no output'
  for (const args of MUSE_SCHEMA_PROBE_ARGS) {
    const r = await execCapture(o.cli.command, [...o.cli.prefixArgs, ...args], {
      env: o.env,
      cwd: o.cwd,
      timeoutMs: o.timeoutMs ?? SCHEMA_TIMEOUT_MS,
      maxBytes: SCHEMA_MAX_BYTES,
    })
    if (r.error !== undefined) return { error: `${r.error.code}: ${r.error.message}` }
    if (r.timedOut) {
      last = `\`muse ${args.join(' ')}\` timed out`
      continue
    }
    const text = r.stdout.trim()
    if (r.code === 0 && text.startsWith('{')) return { args, text }
    last = `\`muse ${args.join(' ')}\` exited with code ${String(r.code)}`
  }
  return { error: last }
}

/**
 * vendor.muse.protocol: `muse exec --help` lists every flag a pass passes (a missing one fails: every pass would stop
 * with a usage error), and the schema Muse prints is compared with the pinned one (warn on a difference). Until someone pins a
 * real schema (MUSE_PIN.liveSchemaSha256), the shapes are synthesized and the check says so.
 */
export function museProtocolCheck(
  help: HelpText | undefined,
  schema: SchemaText | undefined,
  pin: MusePin,
  at: number,
): CheckResult {
  const helpText = help?.text
  if (helpText !== undefined) {
    const missing = MUSE_REQUIRED_EXEC_FLAGS.filter((f) => !helpHasFlag(helpText, f))
    if (missing.length > 0) {
      return vendorCheck(
        MUSE_VENDOR,
        'protocol',
        'fail',
        `${NAME} cannot run passes for Dim Factory`,
        `This ${NAME} has no ${missing.join(', ')} option for exec, which Dim Factory needs. Update ${NAME}.`,
        at,
        {
          category: 'flag_drift',
          recovery: defined([{ id: 'muse.heal', label: 'Diagnose with AI', kind: 'heal' }, ...update()]),
        },
      )
    }
  }
  // Each line says one thing; the first warning names the check.
  const warnings: string[] = []
  const lines: string[] = []
  if (helpText === undefined) {
    warnings.push(`${NAME}: could not read its exec options`)
    lines.push(`\`muse ${MUSE_HELP_ARGS.join(' ')}\`: ${help?.error ?? 'no output'}.`)
  } else {
    lines.push(`exec has ${MUSE_REQUIRED_EXEC_FLAGS.join(', ')}.`)
  }
  const schemaText = schema?.text
  if (schemaText === undefined) {
    warnings.push(`${NAME}: could not read its schema`)
    lines.push(`Schema: ${schema?.error ?? 'not read'}.`)
  } else {
    const hash = schemaHash(schemaText)
    const from = `\`muse ${(schema?.args ?? []).join(' ')}\` (sha256 ${hash.slice(0, 12)})`
    if (pin.liveSchemaSha256 === null) {
      warnings.push(`${NAME}'s event shapes are not pinned yet`)
      lines.push(
        `Dim Factory reads ${NAME}'s events with shapes written from its documentation; no schema from a real ${NAME} is pinned yet. This ${NAME} printed ${from}.`,
      )
    } else if (pin.liveSchemaSha256 !== hash) {
      warnings.push(`${NAME}'s schema changed since Dim Factory pinned it`)
      lines.push(
        `${from} differs from the pinned schema. If a pass misreads ${NAME}'s output, update Dim Factory.`,
      )
    } else {
      lines.push(`${from} matches the pinned schema.`)
    }
    const unnamed = READ_PAYLOAD_TYPES.filter((t) => !schemaText.includes(t))
    if (unnamed.length > 0) lines.push(`The schema does not name ${unnamed.join(', ')}.`)
  }
  lines.push('No tokens spent.')
  const status: CheckStatus = warnings.length > 0 ? 'warn' : 'pass'
  // Updating Muse helps only when it could not print its options or its schema. Shapes not pinned
  // yet, or a schema that differs from the pin, are Dim Factory's to follow (the detail says so), not an update of Muse.
  const updateHelps = helpText === undefined || schemaText === undefined
  return vendorCheck(
    MUSE_VENDOR,
    'protocol',
    status,
    warnings[0] ?? `${NAME} exec works with Dim Factory`,
    lines.join(' '),
    at,
    { recovery: status !== 'pass' && updateHelps ? update() : [] },
  )
}

/** vendor.muse.plan: Plan always needs a read-only pass, which Muse cannot run (so Plan is emulated). */
export function musePlanCheck(at: number): CheckResult {
  return vendorCheck(
    MUSE_VENDOR,
    'plan',
    'skip',
    `Plan does not run on ${NAME}`,
    `${NAME} has no read-only mode, so Plan (read-only, with the plan template) runs on another vendor.`,
    at,
  )
}
