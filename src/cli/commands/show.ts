// `dimf show <runId> [--events] [--follow] [--json]` (read-only).
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { NO_RUN_COST, runCostGap } from '../../shared/cost-text.ts'
import type { RunEnvelope, RunSnapshot } from '../../shared/run.ts'
import { STEP_KEYS } from '../../shared/run.ts'
import { categoryTitle } from '../../core/heal/categories.ts'
import { stepLabel } from '../../core/supervisor/cards.ts'
import { UsageError } from '../args.ts'
import type { CliIo } from '../io.ts'
import { countsText, envelopeLine, formatDuration, formatTokens } from '../render.ts'
import { rerunFromFixLine } from './rerun.ts'
import { EXIT, usage, when, withReadOnlyCore } from '../session.ts'

export const SHOW_USAGE = 'dimf show <runId> [--events] [--follow] [--json] [--home dir]'

const HOME_OPT = { home: { type: 'string' }, json: { type: 'boolean', default: false } } as const

/** `dimf show <runId>`'s text (exported for tests). */
export function snapshotLines(s: RunSnapshot, runDir: string): string[] {
  const sum = s.summary
  const out: string[] = []
  const outcome = sum.outcome !== undefined ? ` (${sum.outcome})` : ''
  out.push(
    `Run #${sum.displayNo} · ${sum.status}${outcome} · phase ${sum.phase} · profile ${sum.profile}${sum.auto ? ' · AUTO' : ''}`,
  )
  out.push(`  Title:   ${sum.title}`)
  if (s.depth !== undefined) {
    out.push(`  Depth:   ${s.depth.depth === 'direct' ? 'Quick' : 'Thorough'}: ${s.depth.reason}`)
  }
  out.push(`  Folder:  ${sum.folder}`)
  out.push(
    `  Created: ${when(sum.createdAt)}${sum.endedAt !== undefined ? ` · ended ${when(sum.endedAt)}` : ''}`,
  )
  if (sum.blockedBy !== undefined) out.push(`  Blocked by run ${sum.blockedBy}`)
  // Where a re-run came from, and what `dimf rerun --from-fix` would do with this run.
  if (sum.rerunOf !== undefined) {
    out.push(
      `  Re-run:  of run #${sum.rerunOf.displayNo} (${sum.rerunOf.runId})${sum.rerunOf.from === 'fix' ? ' from Fix' : ''}`,
    )
  }
  out.push(`  Re-run from Fix: ${rerunFromFixLine(s.rerunFromFix)}`)
  out.push('  Steps:')
  for (const k of STEP_KEYS) {
    const st = s.steps[k]
    if (st.attempt === 0 && st.status === 'queued') continue
    const bits = [
      st.vendor,
      st.vendor !== undefined ? (st.model ?? 'default model') : undefined,
      k === 'plan' && st.planMode !== undefined ? `${st.planMode} plan` : st.mode,
      st.activeMs > 0 ? formatDuration(st.activeMs) : undefined,
      st.usage !== undefined
        ? `${formatTokens(st.usage.input + st.usage.output + (st.usage.cacheRead ?? 0) + (st.usage.cacheWrite ?? 0))} tok`
        : undefined,
      st.reason,
      st.pause,
      st.sessionNote,
    ].filter((x): x is string => x !== undefined && x !== '')
    out.push(`    ${stepLabel(k).padEnd(10)} ${st.status.padEnd(9)} ${bits.join(' · ')}`)
    if (st.failure !== undefined)
      out.push(`      ${categoryTitle(st.failure.category)}: ${st.failure.message}`)
  }
  for (const c of s.cards) out.push(`  Card: ${c.title} [${c.choices.map((ch) => ch.label).join(' | ')}]`)
  for (const a of s.asks) out.push(`  Ask (${a.step}): ${a.kind} ${a.detail} · expires ${when(a.expiresAt)}`)
  const p = sum.progress
  // Without a figure, the app's words for why (shared/cost-text.ts): No cost yet, No cost reported or No price.
  const cost = p.costUsd !== null ? `$${p.costUsd.toFixed(2)}` : NO_RUN_COST[runCostGap(sum) ?? 'unpriced']
  out.push(`  Progress: ${formatTokens(p.tokens)} tokens · ${cost} · ${p.filesChanged} files changed`)
  if (sum.findings.must + sum.findings.should > 0) out.push(`  Findings: ${countsText(sum.findings)}`)
  for (const n of s.notes) out.push(`  Note: ${n}`)
  out.push(`  Events: ${s.lastSeq} · Run folder: ${runDir}`)
  return out
}

function eventLine(env: RunEnvelope): string {
  const b = env.body
  const t = new Date(env.ts).toISOString().slice(11, 19)
  switch (b.t) {
    case 'ev':
      return `${env.seq} ${t} ${b.step} ${b.ev.type}${b.ev.type === 'text' ? ` ${JSON.stringify(b.ev.delta.slice(0, 80))}` : b.ev.type === 'tool' ? ` ${b.ev.name} ${b.ev.phase ?? ''}` : ''}`
    case 'step-status':
      return `${env.seq} ${t} ${b.step} → ${b.status}${b.reason !== undefined ? ` (${b.reason})` : ''}${b.pause !== undefined ? ` (${b.pause})` : ''}`
    case 'run-status':
      return `${env.seq} ${t} run → ${b.status} / ${b.phase}${b.outcome !== undefined ? ` (${b.outcome})` : ''}`
    case 'card':
      return `${env.seq} ${t} card ${b.card.kind} ${b.state}${b.choiceId !== undefined ? ` → ${b.choiceId}` : ''}`
    case 'snag':
      return `${env.seq} ${t} snag ${b.step}: ${b.failure.category} ${b.failure.message}`
    case 'ask-resolved':
      return `${env.seq} ${t} ask ${b.requestId} resolved by ${b.by}${b.decision !== undefined ? ` (${b.decision})` : ''}`
    case 'diff-stats':
      return `${env.seq} ${t} files changed ${b.files} (+${b.added} -${b.deleted})${b.live ? ' live' : ''}`
    case 'output':
      return `${env.seq} ${t} output ${b.file} v${b.version}`
    case 'guardrail':
      return `${env.seq} ${t} guardrail ${b.step} ${b.finding.rule}: ${b.finding.subject}${b.undone ? ' (put back)' : ''}`
    case 'usage':
      return `${env.seq} ${t} usage ${b.step} in ${b.usage.input} out ${b.usage.output}`
    case 'context':
      return `${env.seq} ${t} context ${b.step} ${b.percent !== undefined ? `${b.percent}%` : 'n/a'} compactions ${b.compactions}${b.compacting ? ' compacting' : ''}`
    case 'ask-extended':
    case 'auto-answered':
      return `${env.seq} ${t} ${b.t}`
  }
}

export async function showCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: {
    events?: boolean | undefined
    follow?: boolean | undefined
    json?: boolean | undefined
    home?: string | undefined
  }
  let runId: string
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        ...HOME_OPT,
        events: { type: 'boolean', default: false },
        follow: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    })
    v = parsed.values
    if (parsed.positionals.length !== 1) throw new UsageError('expected <runId>')
    runId = parsed.positionals[0] ?? ''
  } catch (err) {
    return usage(io, 'show', SHOW_USAGE, err)
  }
  return withReadOnlyCore(io, v.home, async (core) => {
    const snap = await core.invoke('runs.get', { runId })
    if (!snap.ok) {
      io.err(`dimf show: ${snap.error.message}`)
      return snap.error.code === 'NOT_FOUND' ? EXIT.usage : EXIT.failed
    }
    if (v.events !== true && v.follow !== true) {
      if (v.json === true) io.out(JSON.stringify(snap.value, null, 2))
      else for (const l of snapshotLines(snap.value, core.paths.run(runId).dir)) io.out(l)
      return EXIT.completed
    }
    let since = 0
    let stop = false
    const off = io.onInterrupt(() => {
      stop = true
    })
    try {
      for (;;) {
        const page = await core.invoke('runs.events', { runId, sinceSeq: since, limit: 2000 })
        if (!page.ok) {
          io.err(`dimf show: ${page.error.message}`)
          return EXIT.failed
        }
        for (const env of page.value.events) io.out(v.json === true ? envelopeLine(env) : eventLine(env))
        since = page.value.events.at(-1)?.seq ?? since
        if (page.value.more) continue
        if (v.follow !== true || stop) break
        const cur = await core.invoke('runs.get', { runId })
        const st = cur.ok ? cur.value.summary.status : 'completed'
        if ((st === 'completed' || st === 'cancelled') && since >= (cur.ok ? cur.value.lastSeq : since)) break
        await delay(500)
        if (stop) break
      }
    } finally {
      off()
    }
    return EXIT.completed
  })
}

// ---- runs ---------------------------------------------------------------------------------------------------------
