// A pass's changes against the rules in force, read from the shadow repository: the pass's start snapshot against the
// folder now, however the changes were made. Reads only; undoing is the controller's, before the end snapshot, so an
// undone change never reaches a diff or reads as an edit from outside the run.
import type { ChangedFile, GuardrailFinding, GuardrailRule, ManifestChange } from '../../shared/guardrails.ts'
import { checkChanges, isTestFile } from '../../shared/guardrails.ts'
import type { Shadow } from '../git/shadow.ts'
import { dependenciesIn, isManifest } from './manifests.ts'

async function fileAt(shadow: Shadow, tree: string, path: string): Promise<string> {
  const r = await shadow.git(['cat-file', 'blob', `${tree}:${path}`]).catch(() => null)
  return r?.stdout ?? ''
}

/** The lines each changed test file gained, from the diff. */
async function addedLinesOf(
  shadow: Shadow,
  a: string,
  b: string,
  paths: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const path of paths) {
    const r = await shadow
      .git(['diff-tree', '-r', '-p', '-U0', '--no-color', '--no-ext-diff', a, b, '--', path])
      .catch(() => null)
    const lines = (r?.stdout ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    out.set(
      path,
      lines.map((l) => l.slice(1)),
    )
  }
  return out
}

export interface PassChangeCheck {
  findings: GuardrailFinding[]
  /** Paths the undo must put back: a rename's old path goes with its new one. */
  undoPaths: string[]
}

export async function checkPassChanges(
  shadow: Shadow,
  start: string,
  now: string,
  rules: readonly GuardrailRule[],
  allowAgentSettings: boolean,
): Promise<PassChangeCheck> {
  const { changes: summary } = await shadow.diffSummary(start, now)
  const added = rules.some((r) => r.kind === 'testsNotWeakened')
    ? await addedLinesOf(
        shadow,
        start,
        now,
        summary.filter((c) => c.status !== 'D' && isTestFile(c.path)).map((c) => c.path),
      )
    : new Map<string, string[]>()
  const changes: ChangedFile[] = summary.map((c) => ({
    path: c.path,
    status: c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : 'modified',
    linesChanged: (c.added ?? 0) + (c.deleted ?? 0),
    addedLines: added.get(c.path) ?? [],
  }))
  const manifests: ManifestChange[] = []
  if (rules.some((r) => r.kind === 'newDependencies')) {
    for (const c of summary) {
      if (c.status === 'D' || !isManifest(c.path)) continue
      manifests.push({
        path: c.path,
        before: dependenciesIn(c.path, await fileAt(shadow, start, c.oldPath ?? c.path)),
        after: dependenciesIn(c.path, await fileAt(shadow, now, c.path)),
      })
    }
  }
  const findings = checkChanges(rules, changes, { manifests, allowAgentSettings })
  const undo = new Set(findings.filter((f) => f.onBreak === 'undo').map((f) => f.subject))
  const undoPaths = summary.flatMap((c) =>
    undo.has(c.path) ? [c.path, ...(c.oldPath !== undefined ? [c.oldPath] : [])] : [],
  )
  return { findings, undoPaths }
}
