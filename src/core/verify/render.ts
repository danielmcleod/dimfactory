// The verify round as prompt text and findings (with the templates' rendering rules).
//
// {{verify}}, one entry per command:
//   - PASS `pnpm run typecheck` (12s)
//   - FAIL `pnpm run test` (exit 1, 41s)            followed by the fenced excerpt (indented under the bullet)
//   - FAIL (already failing before this run) `cmd` (exit 1, 41s)    (baseline map) with its excerpt
//   - NOT RUN `cmd` (<reason>)                       could not run, skipped, not trusted
// Kept within the 16 KB {{verify}} cap by shortening the excerpts (their last lines stay), so the template never cuts
// a fence in half.
//
// Findings (source `verify`): `[must]` per failing command, `` `cmd` failed (exit N, Ts) `` with the excerpt;
// `[should]` instead when it also failed in the baseline (flag `preexisting`: it does not block the Fix skip rule);
// `[should]` per command Auto skipped as untrusted. Environment failures never become findings.
import type { Finding, Severity } from '../../shared/findings.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'
import { findingId } from '../findings/parse.ts'
import { VALUE_CAPS_BYTES } from '../prompts/template.ts'
import { isBuiltinCheckArgv } from '../../shared/pageload.ts'
import { displayArgv } from './argv.ts'
import { possibleHallucination } from '../grounding/hallucination.ts'

export const VERIFY_SECTION_CAP_BYTES = VALUE_CAPS_BYTES['verify'] ?? 16 * 1024

/** verify:0's results by command name (the isolated-run baseline writes `verify/baseline.json`). */
export type VerifyBaseline = Readonly<Record<string, 'pass' | 'fail' | 'env'>>

/** `12s`, `1m 41s`, `1h 02m` (whole seconds). */
export function formatVerifyDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `10m`, `90s`, `1h 30m`: a timeout as configured. */
export function formatTimeout(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s > 0 && s % 3600 === 0) return `${s / 3600}h`
  if (s > 0 && s % 60 === 0) return s >= 3600 ? `${Math.floor(s / 3600)}h ${(s % 3600) / 60}m` : `${s / 60}m`
  return formatVerifyDuration(ms)
}

/** The command as written (Dim Factory's own checks by their name: they are no program). */
const commandText = (r: Pick<VerifyCommandResult, 'argv' | 'name'>): string =>
  r.argv.length > 0 && !isBuiltinCheckArgv(r.argv) ? displayArgv(r.argv) : r.name

/** `(exit 1, 41s)`, `(timed out, 10m 00s)`, `(2 of 3 must scenarios failed, 12s)`. */
function facts(r: VerifyCommandResult): string {
  const must = r.scenarios?.filter((s) => s.must) ?? []
  const failed = must.filter((s) => s.status !== 'pass').length
  const head =
    r.timedOut === true
      ? 'timed out'
      : r.scenarios !== undefined
        ? `${failed} of ${must.length} must scenario${must.length === 1 ? '' : 's'} failed`
        : r.exitCode !== null
          ? `exit ${r.exitCode}`
          : 'no exit code'
  return `(${head}, ${formatVerifyDuration(r.durationMs)})`
}

/** A play-test's scenarios, one line each under its command: passed or failed (and why), and which are not required. */
function scenarioText(r: VerifyCommandResult): string[] {
  return (r.scenarios ?? []).map((s) => {
    const word = s.status === 'pass' ? 'passed' : s.status === 'fail' ? 'failed' : 'could not be played'
    const need = s.must ? '' : ' (not required)'
    return `  - ${word}: ${s.name}${need}${s.status !== 'pass' && s.message !== undefined ? `: ${s.message}` : ''}`
  })
}

/** A fence longer than any backtick run in `text`. */
function fenceFor(text: string): string {
  let longest = 0
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The excerpt as a fenced block, each line indented by `indent`. */
export function fencedExcerpt(excerpt: string, indent = ''): string {
  const fence = fenceFor(excerpt)
  const body = excerpt === '' ? [] : excerpt.split('\n')
  return [fence, ...body, fence].map((l) => (l === '' ? l : `${indent}${l}`)).join('\n')
}

const isBaselineFail = (r: VerifyCommandResult, baseline?: VerifyBaseline): boolean =>
  r.status === 'fail' && baseline?.[r.name] === 'fail'

function headLine(r: VerifyCommandResult, baseline?: VerifyBaseline): string {
  const cmd = `\`${commandText(r)}\``
  switch (r.status) {
    case 'pass':
      return `- PASS ${cmd} (${formatVerifyDuration(r.durationMs)})`
    case 'fail':
      return isBaselineFail(r, baseline)
        ? `- FAIL (already failing before this run) ${cmd} ${facts(r)}`
        : `- FAIL ${cmd} ${facts(r)}`
    case 'env':
      return `- NOT RUN ${cmd} (could not run: ${r.reason ?? 'the environment is missing something'})`
    case 'skipped-untrusted':
      return `- NOT RUN ${cmd} (${r.trust === 'changed' ? 'changed since it was trusted' : 'not trusted'})`
    case 'skipped':
      return `- NOT RUN ${cmd} (${r.reason ?? 'skipped'})`
  }
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Keep the last lines of `excerpt` within `max` bytes. */
function shortenExcerpt(excerpt: string, max: number): string {
  if (bytes(excerpt) <= max) return excerpt
  const lines = excerpt.split('\n')
  const out: string[] = []
  let used = 4
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? ''
    if (used + bytes(l) + 1 > max) break
    out.unshift(l)
    used += bytes(l) + 1
  }
  return ['…', ...out].join('\n')
}

/**
 * The {{verify}} value for a round's results. Empty for no results, so `{{#verify}}` drops its section.
 * `baseline`: commands that also failed before the run read "already failing before this run".
 */
export function renderVerifySection(
  results: readonly VerifyCommandResult[],
  baseline?: VerifyBaseline,
  capBytes = VERIFY_SECTION_CAP_BYTES,
): string {
  if (results.length === 0) return ''
  // A play-test's head carries its scenarios as passed or failed (what Acceptance reads for each criterion).
  const heads = results.map((r) => [headLine(r, baseline), ...scenarioText(r)].join('\n'))
  const withExcerpt = results.map((r) => r.status === 'fail' && r.excerpt.trim() !== '')
  const build = (excerptMax: number): string =>
    results
      .map((r, i) => {
        const head = heads[i] ?? ''
        if (withExcerpt[i] !== true) return head
        return `${head}\n${fencedExcerpt(shortenExcerpt(r.excerpt, excerptMax), '  ')}`
      })
      .join('\n')
  let text = build(Number.POSITIVE_INFINITY)
  if (bytes(text) <= capBytes) return text
  const fails = withExcerpt.filter(Boolean).length
  const fixed = bytes(heads.join('\n')) + fails * 32
  let per = Math.max(0, Math.floor((capBytes - fixed) / Math.max(1, fails)))
  text = build(per)
  while (bytes(text) > capBytes && per > 0) {
    per = Math.floor(per / 2)
    text = build(per)
  }
  return bytes(text) <= capBytes ? text : heads.join('\n')
}

export interface VerifyFindingsOptions {
  /** Findings' `round` (1 = verify:1 feeds the first Review ‖ Critic; 2 = verify:2). Default 1. */
  round?: number
  /** verify:0's results; a command failing there too is a `[should]` flagged `preexisting`. */
  baseline?: VerifyBaseline
}

/**
 * The round's findings (source `verify`), must first, numbered F1…: `[must]` per failing command (`[should]` +
 * `preexisting` when it also failed in the baseline) and `[should]` per command Auto skipped as untrusted.
 * Environment failures and other skips are never findings. Ids are stable per command and outcome. A failure whose
 * output shows a made-up name (grounding/hallucination.ts) is flagged `possible-hallucination`.
 */
export function verifyFindings(
  results: readonly VerifyCommandResult[],
  opts: VerifyFindingsOptions = {},
): Finding[] {
  const round = opts.round ?? 1
  const used = new Set<string>()
  const out: Finding[] = []
  const add = (
    r: VerifyCommandResult,
    severity: Severity,
    title: string,
    body: string,
    key: string,
  ): void => {
    let id = findingId('verify', `${key} ${commandText(r)}`)
    for (let n = 2; used.has(id); n++) id = `${findingId('verify', `${key} ${commandText(r)}`)}-${n}`
    used.add(id)
    const preexisting = key === 'fail' && isBaselineFail(r, opts.baseline)
    // A failure that names something that does not exist (a module, an export, a property): possibly made up.
    const invented = key === 'fail' && possibleHallucination(r.excerpt)
    out.push({
      id,
      n: 0,
      severity,
      source: 'verify',
      title,
      body,
      flags: [
        ...(preexisting ? (['preexisting'] as const) : []),
        ...(invented ? (['possible-hallucination'] as const) : []),
      ],
      round,
    })
  }
  for (const r of results) {
    const cmd = `\`${commandText(r)}\``
    if (r.status === 'fail') {
      const what =
        r.timedOut === true
          ? `${cmd} timed out (${formatVerifyDuration(r.durationMs)})`
          : `${cmd} failed ${facts(r)}`
      const body = r.excerpt.trim() === '' ? '' : fencedExcerpt(r.excerpt)
      if (isBaselineFail(r, opts.baseline))
        add(r, 'should', `${what} (already failing before this run)`, body, 'fail')
      else add(r, 'must', what, body, 'fail')
    } else if (r.status === 'skipped-untrusted') {
      const why =
        r.trust === 'changed'
          ? `${cmd} changed since it was trusted, so it was not run (it needs your approval)`
          : `${cmd} is not trusted, so it was not run (it needs your approval)`
      add(r, 'should', why, '', 'untrusted')
    }
  }
  const ordered = [...out.filter((f) => f.severity === 'must'), ...out.filter((f) => f.severity !== 'must')]
  return ordered.map((f, i) => ({ ...f, n: i + 1 }))
}

/** Whether the round's findings block the Fix skip rule (the latest verify has no `[must]` failures). */
export function verifyHasMustFailures(
  results: readonly VerifyCommandResult[],
  baseline?: VerifyBaseline,
): boolean {
  return results.some((r) => r.status === 'fail' && !isBaselineFail(r, baseline))
}
