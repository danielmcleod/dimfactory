// Settings → Prompts view helpers (lookup project → user → builtin, placeholders per template, Implement under 200
// words; tabs, placeholder chips, Implement word count, user/project scope, diff vs default, reset with undo). Pure
// functions that word what core's PromptView says (its
// source, path, allowed and required placeholders, and its template issues) and edit the text box; prompts/template.ts
// in core stays the only template parser: a save is checked there and refused with line-numbered errors.
import type { ConfigScope } from '@shared/config-schema.ts'
import type { PromptIssue, PromptView } from '@shared/ipc.ts'
import type { EditablePromptName } from '@shared/ipc.ts'
import { isStepPromptName } from '@shared/prompt-names.ts'
import type { StepPromptName } from '@shared/prompt-names.ts'
import { isPassName } from '@shared/run.ts'
import { stepLabel } from '../../../lib/format.ts'

export type PromptScope = ConfigScope
export type PromptSource = PromptView['source']

/** The built-in Implement prompt is under 200 words; a longer one of yours gets a warning. */
export const IMPLEMENT_WORD_LIMIT = 200

export const SOURCE_LABEL: Readonly<Record<PromptSource, string>> = {
  builtin: 'Built-in',
  user: 'Yours',
  project: 'This project',
}

export const SCOPE_LABEL: Readonly<Record<PromptScope, string>> = {
  user: 'You, in every project',
  project: 'One project',
}

/** Words as core counts them (prompt-files.ts): runs of non-space. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length
}

export function wordCountText(n: number): string {
  return `${n} ${n === 1 ? 'word' : 'words'}`
}

export function overWordLimit(pass: EditablePromptName, n: number): boolean {
  return pass === 'implement' && n > IMPLEMENT_WORD_LIMIT
}

/** `{{name}}`. */
export function placeholderTag(name: string): string {
  return `{{${name}}}`
}

/** Put `insert` in place of the selection [start, end); the caret goes after it. */
export function insertAt(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length))
  const b = Math.max(a, Math.min(end, text.length))
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length }
}

/** `Line 3, column 12: Unknown placeholder {{tsk}} …` (or the message alone for the whole text). */
export function issueText(i: Pick<PromptIssue, 'line' | 'col' | 'message'>): string {
  if (i.line === undefined) return i.message
  return `Line ${i.line}${i.col !== undefined ? `, column ${i.col}` : ''}: ${i.message}`
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** The issues of a refused prompts.save (VALIDATION `details`: core's template issues), or the message alone. */
export function issuesFromError(details: unknown, message: string): PromptIssue[] {
  if (Array.isArray(details)) {
    const out: PromptIssue[] = []
    for (const d of details) {
      if (!isObj(d) || typeof d['message'] !== 'string') continue
      out.push({
        code: typeof d['code'] === 'string' ? d['code'] : 'invalid',
        severity: d['severity'] === 'warning' ? 'warning' : 'error',
        message: d['message'],
        ...(typeof d['line'] === 'number' ? { line: d['line'] } : {}),
        ...(typeof d['col'] === 'number' ? { col: d['col'] } : {}),
        ...(typeof d['name'] === 'string' ? { name: d['name'] } : {}),
      })
    }
    if (out.length > 0) return out
  }
  return [{ code: 'invalid', severity: 'error', message }]
}

/** The offset of a 1-based line and column in `text` (for putting the caret on an issue). */
export function offsetOf(text: string, line: number, col = 1): number {
  let offset = 0
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', offset)
    if (nl === -1) return text.length
    offset = nl + 1
  }
  return Math.min(text.length, offset + Math.max(0, col - 1))
}

/** The cache key of a prompt as one scope sees it. */
export function promptKey(pass: EditablePromptName, scope: PromptScope, folder: string | null): string {
  return `${scope}|${scope === 'project' ? (folder ?? '') : ''}|${pass}`
}

/**
 * What the scope held before a write, for its Undo: core's `previous` when it says, else what the view showed
 * when it came from that scope (no override otherwise).
 */
export function previousText(before: PromptView, after: PromptView, scope: PromptScope): string | null {
  if (after.previous !== undefined && after.previous.scope === scope) return after.previous.text
  return before.source === scope ? before.text : null
}

/** One sentence on which template a scope uses now, and where a save goes. */
export function sourceExplanation(
  view: Pick<PromptView, 'source' | 'path'>,
  scope: PromptScope,
  project: string,
): string {
  const at = view.path !== null ? ` (${view.path})` : ''
  if (scope === 'user') {
    return view.source === 'user'
      ? `Your template${at}. Every project without a template of its own uses it.`
      : 'You have not changed this prompt: the text below is the built-in one. Save to use your own in every project without a template of its own.'
  }
  switch (view.source) {
    case 'project':
      return `${project}'s own template${at}. Runs in ${project} use it instead of yours and the built-in one. Commit it to share it with your team.`
    case 'user':
      return `${project} has no template of its own yet: it uses yours${at}. Save to give ${project} its own copy; your template stays as it is.`
    case 'builtin':
      return `${project} has no template of its own yet: it uses the built-in one. Save to give ${project} its own; other projects keep theirs.`
  }
}

/** Where Reset leaves a scope: the template the next layer down gives. */
export function resetResult(scope: PromptScope, view: Pick<PromptView, 'overrides'>): string {
  if (scope === 'user') return 'the built-in one'
  if (view.overrides === undefined) return 'your template, or the built-in one'
  return view.overrides.user ? 'your template' : 'the built-in one'
}

/** The optional steps' tabs: what each template is for. */
export const STEP_PROMPT_LABEL: Readonly<Record<StepPromptName, string>> = {
  clarify: 'Clarify',
  'clarify-easy': 'Clarify (plain words)',
  research: 'Research',
  acceptance: 'Acceptance review',
  explain: 'Explain',
  'explain-easy': 'Explain (plain words)',
  deploy: 'Deploy',
  direct: 'Implement (Quick runs)',
}

/** A prompt's name as its tab and messages say it: the pass's or the step's. */
export function promptLabel(name: EditablePromptName): string {
  return isStepPromptName(name) ? STEP_PROMPT_LABEL[name] : stepLabel(name)
}

export function isEditablePromptName(v: unknown): v is EditablePromptName {
  return isPassName(v) || isStepPromptName(v)
}
