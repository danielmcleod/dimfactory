// The short note that carries a pass's work into a fresh session (`{{state}}` of a fresh restart) and into a summarised
// one (the post-compaction reminder): the plan, the acceptance criteria and the files changed so far, at most
// STATE_NOTE_MAX_TOKENS. Pure: the caller reads the plan, the criteria and the changed files.
import { BYTES_PER_TOKEN } from '../../shared/context.ts'

/** The note's budget in tokens (estimated at BYTES_PER_TOKEN bytes each). */
export const STATE_NOTE_MAX_TOKENS = 1500
export const STATE_NOTE_MAX_BYTES = Math.floor(STATE_NOTE_MAX_TOKENS * BYTES_PER_TOKEN)

const CRITERIA_MAX = 12
const FILES_MAX = 40
const LINE_MAX = 200

export interface StateNoteInput {
  /** The pass the note is for. */
  step: 'implement' | 'fix'
  /** Why it is written: a fresh restart after compactions, or a reminder right after one. */
  why: 'restart' | 'reminder'
  /** Compactions the pass's session went through. */
  compactions: number
  /** The decided plan (absent: Plan was off). */
  plan?: string | null | undefined
  /** The plan's acceptance criteria (`AC1`… with their text). */
  criteria?: readonly { id: string; text: string }[] | undefined
  /** Paths the run changed so far, relative to its folder. */
  files?: readonly string[] | undefined
  /** Fix: the findings it was given (titles). */
  findings?: readonly string[] | undefined
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

const clip = (s: string, max = LINE_MAX): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Cut `text` to at most `max` UTF-8 bytes on a line boundary when it can (else a character boundary). */
function cutTo(text: string, max: number): string {
  if (max <= 0) return ''
  if (bytes(text) <= max) return text
  const lines = text.split('\n')
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const n = bytes(line) + 1
    if (used + n > max) break
    out.push(line)
    used += n
  }
  if (out.length > 0) return out.join('\n')
  let s = text
  while (s.length > 0 && bytes(s) > max) s = s.slice(0, Math.max(0, s.length - 64))
  return s
}

function list(items: readonly string[], max: number, more: (n: number) => string): string[] {
  const shown = items.slice(0, max).map((x) => `- ${clip(x)}`)
  if (items.length > max) shown.push(more(items.length - max))
  return shown
}

/**
 * The note, never over STATE_NOTE_MAX_BYTES: the opening, the criteria, the files and Fix's findings first (each
 * list capped), then as much of the plan as still fits.
 */
export function stateNote(i: StateNoteInput): string {
  const pass = i.step === 'fix' ? 'Fix' : 'Implement'
  const times = i.compactions === 1 ? 'once' : i.compactions === 2 ? 'twice' : `${i.compactions} times`
  const opening =
    i.why === 'restart'
      ? `You are continuing ${pass} in a fresh session. The previous session ran low on memory and summarised its notes ${times}, so this note says where the work stands. Check the files before you change them; do not redo finished work.`
      : `Reminder after the context was summarised: you are working on ${pass}. Keep to the plan and the criteria below; check a file before you change it.`
  const head: string[] = [opening]
  const criteria = i.criteria ?? []
  if (criteria.length > 0) {
    head.push(
      '',
      'Acceptance criteria:',
      ...list(
        criteria.map((c) => `${c.id}: ${c.text}`),
        CRITERIA_MAX,
        (n) => `- and ${n} more`,
      ),
    )
  }
  const findings = i.findings ?? []
  if (findings.length > 0) {
    head.push('', 'Findings to fix:', ...list(findings, CRITERIA_MAX, (n) => `- and ${n} more`))
  }
  const files = i.files ?? []
  head.push('', 'Files changed so far:')
  if (files.length === 0) head.push('- none yet')
  else head.push(...list(files, FILES_MAX, (n) => `- and ${n} more files`))
  let text = cutTo(head.join('\n'), STATE_NOTE_MAX_BYTES)
  const plan = (i.plan ?? '').trim()
  if (plan !== '') {
    const label = '\n\nThe plan:\n'
    const room = STATE_NOTE_MAX_BYTES - bytes(text) - bytes(label)
    const cut = cutTo(plan, room)
    if (cut.trim() !== '') text += `${label}${cut}${cut.length < plan.length ? '\n(the plan continues)' : ''}`
  }
  return cutTo(text, STATE_NOTE_MAX_BYTES)
}
