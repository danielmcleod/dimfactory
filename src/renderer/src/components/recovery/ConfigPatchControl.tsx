// A config fix with its change shown before it is applied (the config_patch recovery action, previewed as a diff in
// the snag card; P22: an applied patch retries the pass). Core offers a fix to apply
// to this run and, where keeping it makes sense, the same ops again with `persist` (saved to the project's or the
// user's config file). Both are one block here: the preview once, then [Apply to this run] and [Apply and save to
// project|user]. Core checks its config-patch allowlist on every execute and writes any file itself; a save answers the
// files it wrote and its toast offers Undo (execute.ts). The preview reads in the page flow, never in a scroller.
import { Save, Wrench } from 'lucide-react'
import type { JsonPatchOp, RecoveryAction, RecoveryActionOf } from '@shared/failure.ts'
import { cn } from '../../lib/cn.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'

export type ConfigPatchAction = RecoveryActionOf<'config_patch'>

export const APPLY_RUN_LABEL = 'Apply to this run'
/** A composer preflight fix: core hands the ops back for the run about to start. */
export const APPLY_NEXT_LABEL = 'Apply to the next run'
export const SAVE_PROJECT_LABEL = 'Apply and save to project'
export const SAVE_USER_LABEL = 'Apply and save to user'

/** One fix as core offers it: to apply to the run, and to save (by scope), with the same ops. */
export interface PatchGroup {
  /** The group's first action in core's order: where the block sits, and whether its first button is primary. */
  first: ConfigPatchAction
  apply?: ConfigPatchAction
  save: ConfigPatchAction[]
}

const groupKey = (a: ConfigPatchAction): string => `${a.target}\u0000${JSON.stringify(a.ops)}`

/** Group core's config_patch actions by fix (same target and ops); other actions are left out. */
export function patchGroups(actions: readonly RecoveryAction[]): Map<string, PatchGroup> {
  const groups = new Map<string, PatchGroup>()
  for (const a of actions) {
    if (a.kind !== 'config_patch') continue
    const key = groupKey(a)
    let g = groups.get(key)
    if (g === undefined) {
      g = { first: a, save: [] }
      groups.set(key, g)
    }
    if (a.persist !== undefined) g.save.push(a)
    else g.apply ??= a
  }
  return groups
}

/** The group a config_patch action belongs to, keyed as patchGroups keys it. */
export function patchGroupOf(
  groups: ReadonlyMap<string, PatchGroup>,
  a: ConfigPatchAction,
): PatchGroup | undefined {
  return groups.get(groupKey(a))
}

export function saveLabel(a: ConfigPatchAction): string {
  return a.persist?.scope === 'user' ? SAVE_USER_LABEL : SAVE_PROJECT_LABEL
}

// ---- preview ------------------------------------------------------------------------------------------------------

type LineKind = 'add' | 'del' | 'hunk' | 'same'
const MINUS = '−'

/** The kind of one line of core's preview (a unified diff, or `- old` / `+ new` lines). */
export function previewLineKind(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-') || line.startsWith(MINUS)) return 'del'
  return 'same'
}

const valueText = (v: unknown): string => {
  if (v === null) return 'null (the default)'
  // JSON values only (the ops came through IPC); `undefined` has no JSON form.
  return JSON.stringify(v) ?? 'nothing'
}

/** A preview from the ops when core sent none: `+ /path = value`, `- /path`. */
export function opsPreview(ops: readonly JsonPatchOp[]): string {
  return ops
    .flatMap((op) => {
      switch (op.op) {
        case 'add':
        case 'replace':
          return [`+ ${op.path} = ${valueText(op.value)}`]
        case 'remove':
          return [`- ${op.path}`]
        case 'test':
          return []
      }
    })
    .join('\n')
}

export function PatchPreview({
  action,
  testId,
}: {
  action: ConfigPatchAction
  testId?: string
}): React.JSX.Element {
  const text = action.preview.trim() !== '' ? action.preview : opsPreview(action.ops)
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const added = lines.filter((l) => previewLineKind(l) === 'add').length
  const removed = lines.filter((l) => previewLineKind(l) === 'del').length
  return (
    <div
      data-testid={testId}
      role="group"
      aria-label={`Change preview: ${added} added, ${removed} removed`}
      className="stream-text rounded-md border bg-background text-xs"
    >
      {lines.map((l, i) => {
        const kind = previewLineKind(l)
        return (
          <div
            key={i}
            data-kind={kind}
            className={cn(
              'px-2 break-words whitespace-pre-wrap',
              kind === 'add' && 'bg-diff-add-bg text-diff-add',
              kind === 'del' && 'bg-diff-del-bg text-diff-del',
              kind === 'hunk' && 'bg-muted text-muted-foreground',
            )}
          >
            {kind === 'add' && <span className="sr-only">Added: </span>}
            {kind === 'del' && <span className="sr-only">Removed: </span>}
            {l === '' ? ' ' : l}
          </div>
        )
      })}
    </div>
  )
}

// ---- the block ------------------------------------------------------------------------------------------------------

export interface ConfigPatchControlProps {
  group: PatchGroup
  /** A run's fix (Apply to this run), else a composer preflight's (Apply to the next run). */
  inRun: boolean
  /** The block's first button is the card's primary. */
  primary: boolean
  size: 'sm' | 'md'
  busy: string | null
  /** Run one of the group's actions (the caller's busy-guarded executor). */
  onExecute: (a: ConfigPatchAction) => void
  /** Why an action cannot run now, or null (laterReason / core without the executor). */
  reasonOf: (a: ConfigPatchAction) => string | null
}

function PatchButton({
  action,
  label,
  primary,
  icon,
  p,
}: {
  action: ConfigPatchAction
  label: string
  primary: boolean
  icon: React.JSX.Element
  p: ConfigPatchControlProps
}): React.JSX.Element {
  const reason = p.reasonOf(action)
  const button = (
    <Button
      size={p.size}
      variant={primary ? 'default' : 'outline'}
      data-testid={`recovery-${action.id}`}
      data-kind="config_patch"
      icon={icon}
      loading={p.busy === action.id}
      disabled={reason !== null || (p.busy !== null && p.busy !== action.id)}
      onClick={reason === null ? () => p.onExecute(action) : undefined}
    >
      {label}
    </Button>
  )
  return reason === null ? button : <DisabledHint reason={reason}>{button}</DisabledHint>
}

export function ConfigPatchControl(p: ConfigPatchControlProps): React.JSX.Element {
  const { group } = p
  const shown = group.apply ?? group.save[0] ?? group.first
  return (
    <div
      data-testid={`patch-${group.first.id}`}
      data-kind="config_patch"
      className="flex flex-col gap-1.5 rounded-md border bg-background/60 p-2"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Wrench aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">{shown.label}</span>
      </p>
      <PatchPreview action={shown} testId={`patch-preview-${group.first.id}`} />
      <div className="flex flex-wrap gap-2">
        {group.apply !== undefined && (
          <PatchButton
            action={group.apply}
            label={p.inRun ? APPLY_RUN_LABEL : APPLY_NEXT_LABEL}
            primary={p.primary}
            icon={<Wrench aria-hidden />}
            p={p}
          />
        )}
        {group.save.map((a, i) => (
          <PatchButton
            key={a.id}
            action={a}
            label={saveLabel(a)}
            primary={p.primary && group.apply === undefined && i === 0}
            icon={<Save aria-hidden />}
            p={p}
          />
        ))}
      </div>
    </div>
  )
}
