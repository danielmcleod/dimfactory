// CLI handling of cards and asks: the core builds the choices; the CLI only picks.
//   TTY:     a numbered prompt from CardView.choices; a choice with `input` can open $EDITOR (or read stdin);
//            the gate before Fix is a checklist of the findings (toggle by number, a = all, n = none, Enter =
//            continue)
//   non-TTY: --cards stop (default) and --gates stop pause the run (exit 5); --cards default takes defaultChoice;
//            --gates approve approves the plan and continues to Fix with every finding
//   asks:    TTY `[a]llow once [r]un [d]eny` with the time left; --asks allow|deny answer at once; a non-TTY
//            `--asks ask` leaves the question to its timer (paused(ask-timeout), exit 5)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskDecision } from '../shared/events.ts'
import type { Finding } from '../shared/findings.ts'
import type { CardChoice, CardChoiceValue, CardView } from '../shared/run.ts'
import { CLARIFY_ANSWER_MAX } from '../shared/run.ts'
import { spawnInteractive } from '../core/proc/spawn.ts'
import {
  CHOICE,
  CLARIFY_CHOICE,
  RESEARCH_CHOICE,
  clarifyPayloadOf,
  researchPayloadOf,
} from '../core/supervisor/cards.ts'
import { RESEARCH_ANSWER_MAX, researchAnswerEntry } from '../shared/research.ts'
import type { ResearchPayload } from '../shared/research.ts'
import type { AskState } from '../core/supervisor/types.ts'
import type { RunPolicy } from './args.ts'
import type { CliIo, LineReader } from './io.ts'

export type CardOutcome =
  | { kind: 'choose'; choiceId: string; input?: CardChoiceValue }
  /** The CLI will not answer this card: the run waits on it (exit 5). */
  | { kind: 'stop'; why: string }
  /** Non-blocking card (stall): nothing to do. */
  | { kind: 'ignore' }

export type AskOutcome = { kind: 'answer'; decision: Exclude<AskDecision, 'cancel'> } | { kind: 'leave' }

export interface PromptSink {
  /** A line for the user (stdout, or stderr with --json). */
  line(text: string): void
  /** A prompt without a newline (the answer is typed after it). */
  ask(text: string): void
  endLine(): void
}

const GATE_KINDS: readonly string[] = ['gate:afterPlan', 'gate:beforeFix']

export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : `${pad}${l}`))
    .join('\n')
}

interface MenuItem {
  label: string
  choice: CardChoice
  edit?: 'plan' | 'task' | 'command'
}

function menuFor(card: CardView): MenuItem[] {
  const items: MenuItem[] = []
  for (const ch of card.choices) {
    if (ch.input === 'plan') {
      items.push({ label: ch.label, choice: ch })
      items.push({ label: `Edit the plan, then ${ch.label.toLowerCase()}`, choice: ch, edit: 'plan' })
    } else if (ch.input === 'task' || ch.input === 'command') {
      items.push({ label: ch.label, choice: ch, edit: ch.input })
    } else {
      items.push({ label: ch.label, choice: ch })
    }
  }
  return items
}

/** Text a choice edits: the plan of a plan gate, the task of an insufficient-context card. */
function initialText(card: CardView, edit: MenuItem['edit']): string {
  const p = card.payload
  if (p !== null && typeof p === 'object') {
    const v = edit === 'plan' ? (p as { plan?: unknown }).plan : (p as { task?: unknown }).task
    if (typeof v === 'string') return v
  }
  return card.body
}

/**
 * A card whose Enter must not pick anything: one whose choices can write a trust grant, the trust card (no
 * defaultChoice) and depsConsent ([Install] writes the `deps` grant). The user types the number of the choice
 * they mean, so a stray Enter never writes a grant.
 */
export function noEnterDefault(card: Pick<CardView, 'kind' | 'defaultChoice'>): boolean {
  return card.kind === 'depsConsent' || (card.kind === 'trust' && card.defaultChoice === undefined)
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** One research item the card can keep, as the terminal numbers it. */
interface ResearchItem {
  id: string
  text: string
}

/** The research card's items in order: features (with priority), standards, recommendations. */
export function researchItems(p: ResearchPayload): ResearchItem[] {
  const cites = (s: readonly string[]): string =>
    s.length > 0 ? ` (${s.length === 1 ? '1 source' : `${s.length} sources`})` : ''
  return [
    ...p.result.features.map((f) => ({
      id: f.id,
      text: `[${f.priority}] ${oneLine(f.feature)}${cites(f.sources)}`,
    })),
    ...p.result.standards.map((s) => ({
      id: s.id,
      text: `Standard: ${oneLine(s.standard)}${s.why !== undefined ? `: ${oneLine(s.why)}` : ''}${cites(s.sources)}`,
    })),
    ...p.result.options.map((o) => ({
      id: o.id,
      text: `Recommendation: ${oneLine(o.topic)}: ${oneLine(o.recommendation)}${cites(o.sources)}`,
    })),
  ]
}

/** The summary and the numbered items, `*` marking the suggested ones. */
function researchLines(p: ResearchPayload, items: readonly ResearchItem[]): string[] {
  const out: string[] = []
  for (const s of p.result.summary) out.push(`  ${oneLine(s)}`)
  if (!p.web) out.push('  (No web search: this repository only.)')
  items.forEach((it, i) => out.push(`  ${p.suggested.includes(it.id) ? '*' : ' '} ${i + 1}) ${it.text}`))
  for (const r of p.result.risks) out.push(`    Risk: ${oneLine(r.risk)}`)
  return out
}

/** `1,3`, `2-4`, `1 3` → the numbers (1..max, distinct, in order), or undefined when one does not fit. */
export function parseNumberList(text: string, max: number): number[] | undefined {
  const out: number[] = []
  for (const part of text.split(/[\s,]+/).filter((x) => x !== '')) {
    const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(part)
    if (m === null) return undefined
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : a
    if (a < 1 || b > max || a > b) return undefined
    for (let n = a; n <= b; n++) if (!out.includes(n)) out.push(n)
  }
  return out.length > 0 ? out.sort((x, y) => x - y) : undefined
}

function isFinding(v: unknown): v is Finding {
  if (v === null || typeof v !== 'object') return false
  const f = v as Record<string, unknown>
  return (
    typeof f['id'] === 'string' &&
    typeof f['n'] === 'number' &&
    (f['severity'] === 'must' || f['severity'] === 'should') &&
    typeof f['source'] === 'string' &&
    typeof f['title'] === 'string'
  )
}

/** A gate:beforeFix card's findings (`payload.findings`), default selection and notes. */
export function gateFindings(card: CardView): { findings: Finding[]; selected: string[]; notes: string[] } {
  const p = card.payload
  const rec = p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : {}
  const findings = Array.isArray(rec['findings']) ? rec['findings'].filter(isFinding) : []
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  return {
    findings,
    selected: strings(rec['selected']) ?? findings.map((f) => f.id),
    notes: strings(rec['notes']) ?? [],
  }
}

/** `2 3`, `2,3`, `F2`, `1-3` → finding numbers; null when a token is none of these. */
export function parseToggles(text: string): number[] | null {
  const out: number[] = []
  for (const tok of text.split(/[\s,]+/).filter((t) => t !== '')) {
    const one = /^f?(\d{1,4})$/i.exec(tok)
    const range = /^f?(\d{1,4})-f?(\d{1,4})$/i.exec(tok)
    if (one !== null) out.push(Number(one[1]))
    else if (range !== null) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (Math.abs(b - a) > 500) return null
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i)
    } else return null
  }
  return out
}

/** `$VISUAL` / `$EDITOR` split on whitespace (no shell); notepad on Windows, vi elsewhere. */
export function editorCommand(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = (env['VISUAL'] ?? env['EDITOR'] ?? '').trim()
  if (raw !== '') return raw.split(/\s+/)
  return process.platform === 'win32' ? ['notepad'] : ['vi']
}

export class Interaction {
  readonly #io: CliIo
  readonly #policy: RunPolicy
  readonly #sink: PromptSink
  readonly #reader: LineReader
  #chain: Promise<unknown> = Promise.resolve()
  #denyExplained = false

  constructor(io: CliIo, policy: RunPolicy, sink: PromptSink, reader: LineReader) {
    this.#io = io
    this.#policy = policy
    this.#sink = sink
    this.#reader = reader
  }

  /** One prompt at a time. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn)
    this.#chain = next.catch(() => undefined)
    return next
  }

  async #planFileText(): Promise<string | undefined> {
    const f = this.#policy.planFile
    if (f === undefined) return undefined
    if (f === '-') return this.#reader.all()
    return readFileSync(f, 'utf8')
  }

  decideCard(card: CardView, signal: AbortSignal): Promise<CardOutcome> {
    const gate = GATE_KINDS.includes(card.kind)
    if (gate) {
      const g = this.#policy.gates
      if (g === 'approve') {
        return this.#serial(async () => {
          const approve = card.choices.find((c) => c.primary === true) ?? card.choices[0]
          if (approve === undefined) return { kind: 'stop', why: 'the gate has no choices' }
          if (card.kind === 'gate:beforeFix') {
            // Continue with the default selection (every finding).
            const { findings } = gateFindings(card)
            const must = findings.filter((f) => f.severity === 'must').length
            this.#sink.line(
              `> Before Fix: ${approve.label.charAt(0).toLowerCase()}${approve.label.slice(1)} ` +
                `(${must} must · ${findings.length - must} should; --gates approve)`,
            )
            if (card.body.trim() !== '') this.#sink.line(indent(card.body))
            return { kind: 'choose', choiceId: approve.id }
          }
          const text = card.kind === 'gate:afterPlan' ? await this.#planFileText() : undefined
          this.#sink.line(
            `> ${card.title}: ${approve.label}${text !== undefined ? ' (with the plan from --plan-file)' : ''}`,
          )
          return text !== undefined && approve.input === 'plan'
            ? { kind: 'choose', choiceId: approve.id, input: text }
            : { kind: 'choose', choiceId: approve.id }
        })
      }
      if (g === 'stop' || !this.#policy.tty) {
        this.#showCard(card)
        return Promise.resolve({ kind: 'stop', why: `${card.title} (--gates ${g})` })
      }
      return this.#serial(() =>
        card.kind === 'gate:beforeFix' ? this.#promptFindings(card, signal) : this.#prompt(card, signal),
      )
    }
    if (!card.blocking) {
      this.#sink.line(`! ${card.title}. ${card.body}`)
      return Promise.resolve({ kind: 'ignore' })
    }
    const c = this.#policy.cards
    if (c === 'default') {
      if (card.defaultChoice !== undefined) {
        const ch = card.choices.find((x) => x.id === card.defaultChoice)
        this.#sink.line(`> ${card.title}: ${ch?.label ?? card.defaultChoice} (default)`)
        return Promise.resolve({ kind: 'choose', choiceId: card.defaultChoice })
      }
      this.#showCard(card)
      return Promise.resolve({ kind: 'stop', why: `${card.title} has no default choice` })
    }
    if (c === 'stop' || !this.#policy.tty) {
      this.#showCard(card)
      return Promise.resolve({ kind: 'stop', why: `${card.title} (--cards ${c})` })
    }
    // Clarify: each question in turn (an option's number, your own words, or Enter to leave it to Plan).
    if (card.kind === 'clarify') return this.#serial(() => this.#promptClarify(card, signal))
    // Research: which items Plan keeps (Enter: the must-haves and recommendations), then each open question.
    if (card.kind === 'research') return this.#serial(() => this.#promptResearch(card, signal))
    return this.#serial(() => this.#prompt(card, signal))
  }

  /**
   * The Clarify card (TTY): each question with its numbered options; a number picks one, other text is your own
   * answer ("Other"), Enter leaves the question to Plan. No answer at all skips the questions.
   */
  async #promptClarify(card: CardView, signal: AbortSignal): Promise<CardOutcome> {
    if (signal.aborted) return { kind: 'ignore' }
    const p = clarifyPayloadOf(card)
    if (p === undefined) return this.#prompt(card, signal)
    this.#sink.endLine()
    this.#sink.line(`? ${card.title}`)
    if (card.body.trim() !== '') this.#sink.line(indent(card.body))
    const answers: string[] = []
    for (const [i, q] of p.questions.entries()) {
      this.#sink.line(`  Question ${i + 1} of ${p.questions.length}: ${oneLine(q.question)}`)
      q.options.forEach((o, j) => this.#sink.line(`    ${j + 1}) ${oneLine(o)}`))
      this.#sink.line('    Type a number or your own answer; Enter leaves it to Plan.')
      for (;;) {
        this.#sink.ask('  > ')
        const answer = await this.#reader.line(signal)
        if (answer === null) {
          this.#sink.line('')
          return signal.aborted ? { kind: 'ignore' } : { kind: 'stop', why: 'no input' }
        }
        const a = answer.trim()
        const n = /^\d{1,2}$/.test(a) ? Number(a) : undefined
        if (n !== undefined && (n < 1 || n > q.options.length)) {
          this.#sink.line(`    Type 1 to ${q.options.length}, your own answer, or Enter.`)
          continue
        }
        if (a.length > CLARIFY_ANSWER_MAX) {
          this.#sink.line(`    Keep it under ${CLARIFY_ANSWER_MAX} characters.`)
          continue
        }
        answers.push(n !== undefined ? (q.options[n - 1] ?? '') : a)
        break
      }
    }
    if (answers.every((a) => a === '')) {
      this.#sink.line('> Skipped the questions.')
      return { kind: 'choose', choiceId: CLARIFY_CHOICE.skip }
    }
    return { kind: 'choose', choiceId: CLARIFY_CHOICE.answer, input: answers }
  }

  /**
   * The research card (TTY): the summary and the numbered items (features, standards, recommendations); Enter keeps the
   * suggested ones (the must-haves and recommendations), numbers keep those (`1,3,5`, `2-4`), `none` plans without
   * research. Then each open question: your answer, or Enter to leave it to Plan.
   */
  async #promptResearch(card: CardView, signal: AbortSignal): Promise<CardOutcome> {
    if (signal.aborted) return { kind: 'ignore' }
    const p = researchPayloadOf(card)
    if (p === undefined) return this.#prompt(card, signal)
    this.#sink.endLine()
    this.#sink.line(`? ${card.title}`)
    if (card.body.trim() !== '') this.#sink.line(indent(card.body))
    const items = researchItems(p)
    for (const l of researchLines(p, items)) this.#sink.line(l)
    const suggested = items.flatMap((it, i) => (p.suggested.includes(it.id) ? [i + 1] : []))
    this.#sink.line(
      `  Keep which? Numbers (1,3 or 2-4), Enter for ${suggested.length > 0 ? suggested.join(',') : 'none'}, or "none" to plan without research.`,
    )
    let kept: string[] | undefined
    for (;;) {
      this.#sink.ask('  > ')
      const answer = await this.#reader.line(signal)
      if (answer === null) {
        this.#sink.line('')
        return signal.aborted ? { kind: 'ignore' } : { kind: 'stop', why: 'no input' }
      }
      const a = answer.trim().toLowerCase()
      if (a === '') {
        kept = [...p.suggested]
        break
      }
      if (a === 'none' || a === 'n') {
        this.#sink.line('> Planning without the research.')
        return { kind: 'choose', choiceId: RESEARCH_CHOICE.skip }
      }
      const picked = parseNumberList(a, items.length)
      if (picked === undefined) {
        this.#sink.line(`    Type numbers from 1 to ${items.length}, Enter, or none.`)
        continue
      }
      kept = picked.map((n) => items[n - 1]?.id ?? '').filter((id) => id !== '')
      break
    }
    const input: string[] = [...kept]
    for (const [i, q] of p.result.questions.entries()) {
      this.#sink.line(`  Question ${i + 1} of ${p.result.questions.length}: ${oneLine(q.question)}`)
      this.#sink.line('    Type your answer; Enter leaves it to Plan.')
      for (;;) {
        this.#sink.ask('  > ')
        const answer = await this.#reader.line(signal)
        if (answer === null) {
          this.#sink.line('')
          return signal.aborted ? { kind: 'ignore' } : { kind: 'stop', why: 'no input' }
        }
        const a = answer.trim()
        if (a.length > RESEARCH_ANSWER_MAX) {
          this.#sink.line(`    Keep it under ${RESEARCH_ANSWER_MAX} characters.`)
          continue
        }
        if (a !== '') input.push(researchAnswerEntry(q.id, a))
        break
      }
    }
    return { kind: 'choose', choiceId: RESEARCH_CHOICE.use, input }
  }

  #showCard(card: CardView): void {
    this.#sink.line(`? ${card.title}`)
    if (card.body.trim() !== '') this.#sink.line(indent(card.body))
    // Clarify's questions, so a run stopped at them shows what it asks (answer them in the app or a terminal).
    const q = clarifyPayloadOf(card)?.questions ?? []
    q.forEach((x, i) =>
      this.#sink.line(`  ${i + 1}. ${oneLine(x.question)} (${x.options.map(oneLine).join(' · ')} · Other)`),
    )
    // Research's items and open questions, so a run stopped at its card shows what it found.
    const r = researchPayloadOf(card)
    if (r !== undefined) {
      for (const l of researchLines(r, researchItems(r))) this.#sink.line(l)
      r.result.questions.forEach((x, i) => this.#sink.line(`  Question ${i + 1}: ${oneLine(x.question)}`))
    }
    this.#sink.line(`  Choices: ${card.choices.map((c) => c.label).join(' · ')}`)
  }

  async #prompt(card: CardView, signal: AbortSignal): Promise<CardOutcome> {
    if (signal.aborted) return { kind: 'ignore' }
    this.#sink.endLine()
    this.#sink.line(`? ${card.title}`)
    if (card.body.trim() !== '') this.#sink.line(indent(card.body))
    const items = menuFor(card)
    // A card that grants trust has no Enter default (core gives it no defaultChoice: "never a default";
    // Auto never implies trust), so a stray Enter never writes a grant; nor does depsConsent's Install.
    // Others fall back to their primary choice.
    const def = noEnterDefault(card)
      ? -1
      : Math.max(
          0,
          items.findIndex(
            (i) => i.edit === undefined && (i.choice.id === card.defaultChoice || i.choice.primary === true),
          ),
        )
    items.forEach((it, i) => this.#sink.line(`  ${i + 1}) ${it.label}${i === def ? ' (default)' : ''}`))
    for (;;) {
      this.#sink.ask(def === -1 ? `Choose 1-${items.length}: ` : `Choose 1-${items.length} [${def + 1}]: `)
      const answer = await this.#reader.line(signal)
      if (answer === null) {
        this.#sink.line('')
        return signal.aborted ? { kind: 'ignore' } : { kind: 'stop', why: 'no input' }
      }
      const n = answer.trim() === '' ? def + 1 : Number.parseInt(answer.trim(), 10)
      const item = items[n - 1]
      if (item === undefined) {
        this.#sink.line(`  Type a number from 1 to ${items.length}.`)
        continue
      }
      if (item.edit === undefined) return { kind: 'choose', choiceId: item.choice.id }
      const edited = await this.edit(initialText(card, item.edit), item.edit)
      return edited === undefined
        ? { kind: 'choose', choiceId: item.choice.id }
        : { kind: 'choose', choiceId: item.choice.id, input: edited }
    }
  }

  /**
   * The gate before Fix (TTY): the findings as a checklist, all ticked. Numbers toggle findings (`2 3`, `F2`,
   * `1-3`), `a` ticks all, `n` none, `s` skips Fix, `c` cancels the run, Enter continues with the ticked ones.
   */
  async #promptFindings(card: CardView, signal: AbortSignal): Promise<CardOutcome> {
    if (signal.aborted) return { kind: 'ignore' }
    const { findings, selected, notes } = gateFindings(card)
    const go =
      card.choices.find((c) => c.input === 'findings') ?? card.choices.find((c) => c.primary === true)
    if (go === undefined) return this.#prompt(card, signal)
    const skip = card.choices.find((c) => c.id === CHOICE.skipFix)
    const cancel = card.choices.find((c) => c.id === CHOICE.cancel)
    const ticked = new Set(selected)
    this.#sink.endLine()
    this.#sink.line(`? ${card.title}`)
    for (const n of notes) this.#sink.line(`  Note: ${n}`)
    this.#printChecklist(findings, ticked)
    const keys = [
      'a = all',
      'n = none',
      ...(skip !== undefined ? ['s = skip Fix'] : []),
      ...(cancel !== undefined ? ['c = cancel the run'] : []),
    ]
    this.#sink.line(
      `  Fix addresses the ticked findings. Type numbers to tick or untick (e.g. "2 3"); ${keys.join(', ')}.`,
    )
    for (;;) {
      const n = ticked.size
      this.#sink.ask(`Press Enter to continue with ${n} finding${n === 1 ? '' : 's'}: `)
      const answer = await this.#reader.line(signal)
      if (answer === null) {
        this.#sink.line('')
        return signal.aborted ? { kind: 'ignore' } : { kind: 'stop', why: 'no input' }
      }
      const a = answer.trim().toLowerCase()
      if (a === '') {
        return {
          kind: 'choose',
          choiceId: go.id,
          input: findings.filter((f) => ticked.has(f.id)).map((f) => f.id),
        }
      }
      if (a === 's' && skip !== undefined) return { kind: 'choose', choiceId: skip.id }
      if (a === 'c' && cancel !== undefined) return { kind: 'choose', choiceId: cancel.id }
      if (a === 'a' || a === 'all') for (const f of findings) ticked.add(f.id)
      else if (a === 'n' || a === 'none') ticked.clear()
      else {
        const nums = parseToggles(a)
        const unknown = nums === null ? [a] : nums.filter((x) => !findings.some((f) => f.n === x))
        if (nums === null || unknown.length > 0) {
          this.#sink.line(
            `  "${answer.trim()}" is not a finding number. Use 1 to ${findings.length}, a, n` +
              `${skip !== undefined ? ', s' : ''}${cancel !== undefined ? ', c' : ''} or Enter.`,
          )
          continue
        }
        for (const x of nums) {
          const f = findings.find((y) => y.n === x)
          if (f === undefined) continue
          if (ticked.has(f.id)) ticked.delete(f.id)
          else ticked.add(f.id)
        }
      }
      this.#printChecklist(findings, ticked)
    }
  }

  #printChecklist(findings: readonly Finding[], ticked: ReadonlySet<string>): void {
    let must = 0
    let should = 0
    for (const f of findings) {
      const on = ticked.has(f.id)
      if (on && f.severity === 'must') must++
      else if (on) should++
      this.#sink.line(
        `  [${on ? 'x' : ' '}] ${String(f.n).padStart(2)}. [${f.severity}] (${f.source}) ${oneLine(f.title)}`,
      )
    }
    this.#sink.line(`  Fix will receive ${must} must · ${should} should.`)
  }

  /** $EDITOR on a temp file; falls back to pasting text on stdin (ended by a line with a single "."). */
  async edit(initial: string, what: string): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), 'dim-factory-edit-'))
    const file = join(dir, `${what}.md`)
    try {
      writeFileSync(file, initial.endsWith('\n') ? initial : `${initial}\n`, 'utf8')
      const [cmd, ...args] = editorCommand(this.#io.env)
      const r = cmd !== undefined ? await spawnInteractive(cmd, [...args, file]) : undefined
      if (r !== undefined && r.error === undefined && r.code === 0) {
        const text = readFileSync(file, 'utf8')
        return text.trim() === initial.trim() ? undefined : text
      }
      const why = r?.error?.message ?? (r !== undefined ? `exit ${r.code ?? r.signal ?? '?'}` : 'no editor')
      this.#sink.line(`  Could not use the editor (${why}).`)
      this.#sink.line(`  Paste the new ${what}; end with a line containing only "."`)
      const text = await this.#reader.until('.')
      return text.trim() === '' ? undefined : text
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  decideAsk(step: string, ask: AskState, now: () => number, signal: AbortSignal): Promise<AskOutcome> {
    const detail = ask.detail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
    const first = detail[0] ?? ask.kind
    const reason = ask.reason !== undefined && !detail.includes(ask.reason.trim()) ? ` · ${ask.reason}` : ''
    const head = `? ${step} asks (${ask.kind}): ${first}${reason}`
    const a = this.#policy.asks
    if (a === 'allow' || a === 'deny') {
      this.#sink.line(`${head}  -> ${a === 'allow' ? 'allowed once' : 'denied'} (--asks ${a})`)
      if (a === 'deny' && this.#policy.asksFromFlag !== true && !this.#denyExplained) {
        // The non-TTY default: say once why, and how to let the vendor go ahead.
        this.#denyExplained = true
        this.#sink.line(
          '  (There is no terminal to ask you, so Dim Factory answers no; the vendor carries on without it. ' +
            'Add --asks allow to let it run such commands.)',
        )
      }
      return Promise.resolve({ kind: 'answer', decision: a })
    }
    if (!this.#policy.tty) {
      this.#sink.line(
        `${head}  -> waiting (no terminal to ask; times out in ${formatRemaining(ask.expiresAt - now())})`,
      )
      return Promise.resolve({ kind: 'leave' })
    }
    return this.#serial(async () => {
      if (signal.aborted) return { kind: 'leave' }
      this.#sink.endLine()
      this.#sink.line(head)
      const opts = ['[a]llow once', ...(ask.allowSession ? ['[r]un (allow for this run)'] : []), '[d]eny']
      for (;;) {
        this.#sink.ask(`  ${opts.join('  ')}  (${formatRemaining(ask.expiresAt - now())} left): `)
        const answer = await this.#reader.line(signal)
        if (answer === null) {
          this.#sink.line('')
          return { kind: 'leave' }
        }
        const k = answer.trim().toLowerCase()
        if (k === 'a' || k === 'allow') return { kind: 'answer', decision: 'allow' }
        if ((k === 'r' || k === 'run') && ask.allowSession)
          return { kind: 'answer', decision: 'allow-session' }
        if (k === 'd' || k === 'deny' || (k === '' && ask.defaultToNo === true)) {
          return { kind: 'answer', decision: 'deny' }
        }
      }
    })
  }
}
