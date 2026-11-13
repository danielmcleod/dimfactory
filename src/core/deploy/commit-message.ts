// The commit message and pull request text for a finished run (pure): a subject from the run's title (at most 72
// characters, cut at a word), then what the run was asked, how it was made (its passes, outcome, findings and checks)
// and the Deploy step's config files. Plain ASCII punctuation; nothing here claims the change is safe or tested beyond
// what the run's own checks said.
import { COMMIT_SUBJECT_MAX } from '../../shared/deploy.ts'
import type { PassStatus, RunOutcome, StepKey } from '../../shared/run.ts'

export interface RunFacts {
  displayNo: number
  title: string
  task: string
  outcome?: RunOutcome
  findings: { must: number; should: number }
  /** The run's steps as its summary lists them (the passes that ran). */
  steps: readonly { key: StepKey; status: PassStatus; vendor?: string; model?: string | null }[]
  files: number
  /** The Deploy step: its target and the files it wrote. */
  deploy?: { target?: string; written: readonly string[] }
  /** The verify commands that ran last, and how they ended. */
  verify?: readonly { name: string; status: string }[]
}

const PASS_LABEL: Partial<Record<StepKey, string>> = {
  clarify: 'Clarify',
  research: 'Research',
  plan: 'Plan',
  tests: 'Tests',
  implement: 'Implement',
  review: 'Review',
  critic: 'Critic',
  security: 'Security review',
  fix: 'Fix',
  recheck: 'Re-check',
  deploy: 'Deploy config',
}

const OUTCOME_TEXT: Readonly<Record<RunOutcome, string>> = {
  fixed: 'fixed what the reviewers found',
  clean: 'the reviewers found nothing to fix',
  'no-changes': 'no changes',
  'findings-open': 'some findings are still open',
  'verify-failed': 'completed with failing checks',
  'security-open': 'completed with security findings open',
  'fix-stopped': 'completed with findings open after Fix until green',
  'gates-failed': "completed without passing the project's quality gates",
  failed: 'failed',
}

/** Collapse whitespace, drop a trailing period, capitalize. */
function tidy(line: string): string {
  const t = line
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, '')
  return t === '' ? t : `${t.charAt(0).toUpperCase()}${t.slice(1)}`
}

/** The commit subject: the run's title, cut at a word to at most 72 characters. */
export function commitSubject(title: string, displayNo: number): string {
  const t = tidy(title.split(/\r?\n/, 1)[0] ?? '')
  if (t === '') return `Dim Factory run #${displayNo}`
  if (t.length <= COMMIT_SUBJECT_MAX) return t
  const cut = t.slice(0, COMMIT_SUBJECT_MAX + 1)
  const space = cut.lastIndexOf(' ')
  return (space >= 40 ? cut.slice(0, space) : t.slice(0, COMMIT_SUBJECT_MAX)).replace(/[.:;,\s]+$/, '')
}

/** Wrap prose at `width` (words longer than the width stay whole). */
export function wrap(text: string, width = 72): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (para.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.trim().split(/\s+/)) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    if (line !== '') out.push(line)
  }
  return out
}

function passesLine(f: RunFacts): string | undefined {
  const ran = f.steps
    .filter((s) => s.status === 'done' && PASS_LABEL[s.key] !== undefined)
    .map((s) => {
      const who = [s.vendor, s.model ?? undefined].filter((x): x is string => x !== undefined && x !== '')
      return `${PASS_LABEL[s.key] ?? s.key}${who.length > 0 ? ` (${who.join(' ')})` : ''}`
    })
  return ran.length > 0 ? `Passes: ${ran.join(', ')}.` : undefined
}

function factLines(f: RunFacts): string[] {
  const lines: string[] = []
  const outcome = f.outcome !== undefined ? OUTCOME_TEXT[f.outcome] : undefined
  lines.push(`Made by Dim Factory run #${f.displayNo}${outcome !== undefined ? ` (${outcome})` : ''}.`)
  const passes = passesLine(f)
  if (passes !== undefined) lines.push(passes)
  if (f.findings.must + f.findings.should > 0)
    lines.push(`Findings: ${f.findings.must} must, ${f.findings.should} should.`)
  if (f.verify !== undefined && f.verify.length > 0)
    lines.push(`Checks: ${f.verify.map((v) => `${v.name} ${v.status}`).join(', ')}.`)
  if (f.deploy !== undefined && f.deploy.written.length > 0)
    lines.push(
      `Deploy config${f.deploy.target !== undefined ? ` for ${f.deploy.target}` : ''}: ${f.deploy.written.join(', ')}.`,
    )
  lines.push(`Files changed: ${f.files}.`)
  return lines
}

/** The task as the body's opening paragraph (at most about 600 characters). */
function taskParagraph(task: string, title: string): string | undefined {
  const t = task.trim()
  if (t === '' || t === title.trim()) return undefined
  return t.length > 600 ? `${t.slice(0, 600).replace(/\s+\S*$/, '')} [...]` : t
}

/** The whole commit message: subject, blank line, the task, the run's facts (wrapped at 72). */
export function commitMessage(f: RunFacts): string {
  const out = [commitSubject(f.title, f.displayNo), '']
  const task = taskParagraph(f.task, f.title)
  if (task !== undefined) out.push(...wrap(task), '')
  for (const l of factLines(f)) out.push(...wrap(l))
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

/** The pull request's body (Markdown). */
export function prBody(f: RunFacts): string {
  const out: string[] = []
  const task = f.task.trim()
  if (task !== '')
    out.push('## What was asked', '', task.length > 2000 ? `${task.slice(0, 2000)} [...]` : task, '')
  out.push('## How it was made', '')
  for (const l of factLines(f)) out.push(`- ${l}`)
  out.push(
    '',
    'Opened with Dim Factory. Review the changes before merging: the checks above are only what the run checked.',
  )
  return `${out.join('\n')}\n`
}
