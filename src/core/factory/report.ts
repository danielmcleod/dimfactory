// The daily report: every run started on a local day (queued or not) with its outcome and cost, today's spending, the
// failures, the queue pauses and the vendor fallbacks, as a view (the Queue page) and as markdown written to
// `<home>/reports/<date>.md` whenever the day's runs change. Pure but for the markdown file's write (service.ts).
import { basename } from 'node:path'
import type { DailyReportRun, DailyReportView } from '../../shared/factory.ts'
import { failedOutcomeText, queueResultOf } from '../../shared/factory.ts'
import type { RunSummary } from '../../shared/run.ts'
import { BRAND } from '../../shared/brand.ts'
import type { DayLedger } from './store.ts'
import { localDate } from './schedule.ts'
import { usd } from './budget.ts'
import { stepLabel } from '../supervisor/cards.ts'
import { CATEGORY_INFO } from '../heal/categories.ts'
import { VENDOR_DISPLAY_NAMES } from '../adapters/registry.ts'
import { isKnownVendor } from '../../shared/vendors.ts'

/** The runs created on the local day `date` (`YYYY-MM-DD`), oldest first. */
export function runsOfDay(summaries: readonly RunSummary[], date: string): RunSummary[] {
  return summaries.filter((s) => localDate(s.createdAt) === date).sort((a, b) => a.createdAt - b.createdAt)
}

/** What a day's runs spent (the priced ones) and how many have no price. */
export function spendOf(runs: readonly RunSummary[]): { usd: number; unpriced: number } {
  let total = 0
  let unpriced = 0
  for (const r of runs) {
    const c = r.progress.costUsd
    if (c === null) unpriced++
    else total += c
  }
  return { usd: Math.round(total * 1e6) / 1e6, unpriced }
}

const FAILURE_WORDS: Readonly<Record<string, string>> = {
  failed: 'Failed',
  cancelled: 'Stopped',
}

/** "Implement: Claude rate limit hit": the failed step and its category's title, the step's vendor named. */
export function failureTitle(s: Pick<RunSummary, 'failure' | 'steps'>): string | undefined {
  const f = s.failure
  if (f === undefined) return undefined
  const vendor = s.steps.find((x) => x.key === f.step)?.vendor
  const name =
    vendor === undefined ? 'The vendor' : isKnownVendor(vendor) ? VENDOR_DISPLAY_NAMES[vendor] : vendor
  return `${stepLabel(f.step)}: ${CATEGORY_INFO[f.category].title.replaceAll('{{vendor}}', name)}`
}

function failureOf(s: RunSummary): string | undefined {
  if (s.status === 'failed' || (s.status === 'cancelled' && s.outcome === 'failed')) {
    const t = failureTitle(s)
    return t !== undefined ? `Failed at ${t}` : 'Failed'
  }
  if (s.status === 'cancelled') return 'Stopped'
  if (s.status === 'completed') return failedOutcomeText(s.outcome)
  return undefined
}

export function buildReport(o: {
  date: string
  summaries: readonly RunSummary[]
  ledger: DayLedger
  file: string
}): DailyReportView {
  const day = runsOfDay(o.summaries, o.date)
  const queued = new Set(o.ledger.queueRuns)
  const runs: DailyReportRun[] = day.map((s) => {
    const failure = failureOf(s)
    return {
      runId: s.runId,
      displayNo: s.displayNo,
      folder: s.folder,
      title: s.title,
      status: s.status,
      ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
      costUsd: s.progress.costUsd,
      createdAt: s.createdAt,
      ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
      queued: queued.has(s.runId),
      ...(failure !== undefined ? { failure } : {}),
    }
  })
  const outcomes = { done: 0, failed: 0, stopped: 0, working: 0 }
  for (const s of day) {
    const r = s.status === 'failed' ? 'failed' : queueResultOf(s.status, s.outcome)
    if (r === undefined) outcomes.working++
    else outcomes[r]++
  }
  const spend = spendOf(day)
  const view: Omit<DailyReportView, 'markdown'> = {
    date: o.date,
    runs,
    spentUsd: spend.usd,
    unpriced: spend.unpriced,
    outcomes,
    pauses: [...o.ledger.pauses],
    fallbacks: [...o.ledger.fallbacks],
    file: o.file,
  }
  return { ...view, markdown: reportMarkdown(view) }
}

const time = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

function outcomeWord(r: DailyReportRun): string {
  if (r.status === 'completed') {
    const res = queueResultOf(r.status, r.outcome)
    return res === 'done' ? `Done (${r.outcome ?? 'completed'})` : `Failed (${r.outcome ?? 'completed'})`
  }
  return FAILURE_WORDS[r.status] ?? r.status.charAt(0).toUpperCase() + r.status.slice(1)
}

/** The report as markdown (no em dashes; costs are what the runs recorded). */
export function reportMarkdown(v: Omit<DailyReportView, 'markdown'>): string {
  const out: string[] = [`# ${BRAND.displayName} daily report: ${v.date}`, '']
  const n = v.runs.length
  out.push(
    `${n === 0 ? 'No runs' : n === 1 ? '1 run' : `${n} runs`} (${v.runs.filter((r) => r.queued).length} from a queue). ` +
      `Done ${v.outcomes.done}, failed ${v.outcomes.failed}, stopped ${v.outcomes.stopped}, still working ${v.outcomes.working}.`,
  )
  out.push(
    `Spent ${usd(v.spentUsd)}${v.unpriced > 0 ? ` (${v.unpriced} ${v.unpriced === 1 ? 'run has' : 'runs have'} no price)` : ''}. ` +
      'Costs are what each run recorded; a subscription login shows what the tokens would cost on the API.',
  )
  out.push('', '## Runs', '')
  if (n === 0) out.push('None.')
  else {
    out.push('| Run | Time | Folder | Task | Outcome | Cost | Queue |', '|---|---|---|---|---|---|---|')
    for (const r of v.runs) {
      out.push(
        `| #${r.displayNo} | ${time(r.createdAt)} | ${cell(basename(r.folder))} | ${cell(r.title)} | ${cell(outcomeWord(r))} | ${r.costUsd === null ? 'No price' : usd(r.costUsd)} | ${r.queued ? 'yes' : 'no'} |`,
      )
    }
  }
  const failures = v.runs.filter((r) => r.failure !== undefined)
  out.push('', '## Failures', '')
  if (failures.length === 0) out.push('None.')
  else
    for (const r of failures) out.push(`- Run #${r.displayNo} (${cell(r.title)}): ${cell(r.failure ?? '')}`)
  out.push('', '## Queue pauses', '')
  if (v.pauses.length === 0) out.push('None.')
  else for (const p of v.pauses) out.push(`- ${time(p.at)} ${cell(basename(p.folder))}: ${cell(p.text)}`)
  out.push('', '## Vendor fallbacks', '')
  if (v.fallbacks.length === 0) out.push('None.')
  else
    for (const f of v.fallbacks)
      out.push(`- ${time(f.at)} Run #${f.displayNo}, ${f.step}: ${f.from} to ${f.to} (${cell(f.why)})`)
  return `${out.join('\n')}\n`
}
