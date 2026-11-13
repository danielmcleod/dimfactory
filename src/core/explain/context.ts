// What Explain it to me is told about a finished run, beyond the task, the brief and the plan: the files the run
// changed (names and line counts, never the diff), how to run the result (Run & Preview's detection and RUN.md), the
// latest verify results, the acceptance checklist and the Deploy step's target. Pure renderers plus one I/O helper
// (gatherExplainInputs) the controller calls before Explain's prompt is built; nothing here throws.
import type { AcceptanceView } from '../../shared/acceptance.ts'
import { ACCEPTANCE_STATUS_LABEL } from '../../shared/acceptance.ts'
import type { FileChange } from '../../shared/ipc.ts'
import type { PreviewCommand } from '../../shared/preview.ts'
import { PREVIEW_RUN_MD_MAX } from '../../shared/preview.ts'
import { detectPreviewCommands, readRunMd } from '../preview/detect.ts'

/** The most changed files Explain is told by name (the rest are counted). */
export const EXPLAIN_FILES_MAX = 60
/** The most run commands Explain is told about. */
export const EXPLAIN_COMMANDS_MAX = 6

const STATUS_WORD: Readonly<Record<FileChange['status'], string>> = {
  A: 'added',
  M: 'changed',
  D: 'deleted',
  R: 'renamed',
  T: 'changed',
}

/** `{{files}}`: "N files changed (+a, -d)" and one line per file, at most EXPLAIN_FILES_MAX; null without changes. */
export function renderChangedFiles(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null
  let added = 0
  let deleted = 0
  for (const c of changes) {
    added += c.added ?? 0
    deleted += c.deleted ?? 0
  }
  const lines = [
    `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed (${added} lines added, ${deleted} removed):`,
  ]
  for (const c of changes.slice(0, EXPLAIN_FILES_MAX)) {
    const from = c.status === 'R' && c.oldPath !== undefined ? ` (from ${c.oldPath})` : ''
    lines.push(`- ${STATUS_WORD[c.status]}: ${c.path}${from}`)
  }
  if (changes.length > EXPLAIN_FILES_MAX) lines.push(`- and ${changes.length - EXPLAIN_FILES_MAX} more`)
  return lines.join('\n')
}

/**
 * `{{run}}`: how to run the result as Dim Factory detects it (the commands Run & Preview would offer) and RUN.md's text
 * when the folder has one; null when neither says anything.
 */
export function renderHowToRun(
  commands: readonly Pick<PreviewCommand, 'label' | 'kind' | 'note' | 'urlHint'>[],
  runMd: { text: string; truncated: boolean } | null,
): string | null {
  const lines: string[] = []
  if (commands.length > 0) {
    lines.push('Ways Dim Factory found to run it:')
    for (const c of commands.slice(0, EXPLAIN_COMMANDS_MAX)) {
      const extra = [c.note, c.urlHint !== undefined ? `opens ${c.urlHint}` : undefined].filter(
        (x): x is string => x !== undefined && x !== '',
      )
      lines.push(`- ${c.label}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`)
    }
  }
  const md = runMd?.text.trim() ?? ''
  if (md !== '') {
    if (lines.length > 0) lines.push('')
    lines.push(`The project's RUN.md${runMd?.truncated === true ? ' (cut short)' : ''}:`, md)
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/** `{{acceptance}}` for Explain: the checklist, one line per criterion; null without criteria. */
export function renderChecklist(v: AcceptanceView | undefined): string | null {
  if (v === undefined || v.items.length === 0) return null
  return v.items
    .map((i) => {
      const why = i.evidence !== undefined ? ` (${i.evidence})` : ''
      return `- ${ACCEPTANCE_STATUS_LABEL[i.status]}: ${i.text}${why}`
    })
    .join('\n')
}

export interface ExplainInputs {
  files: string | null
  run: string | null
}

/**
 * The I/O half of Explain's context: how to run the folder (detection and RUN.md, token-free) and the files the run
 * changed (`changes`, read by the caller from its snapshots; a failure there passes null). Never throws.
 */
export async function gatherExplainInputs(
  folder: string,
  changes: () => Promise<readonly FileChange[] | null>,
): Promise<ExplainInputs> {
  const [commands, runMd, changed] = await Promise.all([
    detectPreviewCommands({ folder }).catch((): PreviewCommand[] => []),
    readRunMd(folder, PREVIEW_RUN_MD_MAX).catch(() => null),
    changes().catch(() => null),
  ])
  return {
    files: changed === null ? null : renderChangedFiles(changed),
    run: renderHowToRun(commands, runMd),
  }
}
