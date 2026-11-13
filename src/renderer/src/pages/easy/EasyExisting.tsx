// Easy mode's "Work on something I already have": the folder the user picked (from Easy's home, or Make a change on a
// project Easy did not make) and how a run works there, as core decided it (read only): in a copy of the folder when it
// is a git repository with commits (the user keeps or throws away the changes at the end), else right in the folder,
// after "Turn on undo for this folder" when it is no repository yet. A copy starts from the last commit, so a folder with
// changes git has not saved yet says how many, and the user saves them first (one commit) or works right in the folder. Then what it should do, the spending limit (a
// change's, from Easy settings; none unless set), what it may do (it always asks: the project permission is only for
// new projects Easy makes) and who does the work. Start runs it (easy.work; a project Easy made goes through
// easy.change) and opens its milestones. A folder it may not use (a whole drive, the home folder, a system folder)
// says why, with Pick a folder.
// UI standards: the screen appears whole once core answered; every line that can come and go keeps its height; Start
// and Back keep their labels.
import { ArrowLeft, FolderOpen, Play } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { EASY_CHANGE_MAX } from '@shared/easy.ts'
import type { EasyFolderView, EasyWorkHow } from '@shared/easy.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { useAppInfo } from '../../state/selectors.ts'
import { useEasyState } from '../../state/experience.ts'
import { pickExistingFolder } from './EasyHome.tsx'
import { Row } from './EasyNew.tsx'
import { VendorSetup } from './EasySetup.tsx'
import { parseLimit } from './model.ts'
import {
  BACK_LABEL,
  CHANGE_FOLDER,
  COST_LABEL,
  EXISTING_ASKS,
  EXISTING_ASKS_LABEL,
  EXISTING_CHANGE_LABEL,
  EXISTING_CHANGE_PLACEHOLDER,
  EXISTING_FOLDER_LABEL,
  EXISTING_HOW_LABEL,
  EXISTING_LOADING,
  EXISTING_MADE_NOTE,
  EXISTING_MODE_TEXT,
  EXISTING_NONE,
  EXISTING_PICK,
  EXISTING_TITLE,
  LIMIT_INPUT_LABEL,
  LIMIT_INVALID,
  LIMIT_NONE,
  LIMIT_NONE_TEXT,
  NEEDS_CHANGE,
  NEEDS_FOLDER,
  NEEDS_UNDO,
  NEEDS_HOW,
  HOW_IN_PLACE,
  HOW_IN_PLACE_NOTE,
  HOW_SAVE_FIRST,
  HOW_SAVE_FIRST_NOTE,
  uncommittedText,
  START_LABEL,
  START_LOADING,
  START_NEEDS_VENDOR,
  UNDO_CHECK,
  UNDO_CHECK_NOTE,
  WHO_LABEL,
  limitText,
  whoText,
} from './text.ts'

export function EasyExistingPage({ folder }: { folder: string | null }): React.JSX.Element {
  const settings = useEasyState()?.settings
  const platform = useAppInfo()?.platform ?? 'win32'
  const [view, setView] = useState<EasyFolderView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [change, setChange] = useState('')
  const [undo, setUndo] = useState(false)
  /** A copy with changes git has not saved yet: save them first, or work right in the folder (null: not chosen). */
  const [how, setHow] = useState<EasyWorkHow | null>(null)
  const [limitBox, setLimitBox] = useState('')
  const [starting, setStarting] = useState(false)
  const limitTouched = useRef(false)
  const changeId = useId()
  const undoId = useId()
  const limitId = useId()

  useEffect(() => {
    if (folder === null || folder.trim() === '') return
    let alive = true
    setView(null)
    setError(null)
    setUndo(false)
    setHow(null)
    void invoke('easy.inspectFolder', { folder }).then((r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setView(r.value)
    })
    return () => {
      alive = false
    }
  }, [folder])

  useEffect(() => {
    if (limitTouched.current || settings === undefined) return
    const cap = settings.changeMaxCostUsd
    setLimitBox(cap !== null ? String(cap) : '')
  }, [settings])

  const limit = parseLimit(limitBox)
  const usable = view !== null && view.problem === undefined && view.mode !== undefined
  const unsaved = usable && !view.made && view.mode === 'isolated' && (view.uncommitted ?? 0) > 0
  const reason =
    folder === null || folder.trim() === ''
      ? NEEDS_FOLDER
      : view === null
        ? START_LOADING
        : !usable
          ? (view.problem ?? NEEDS_FOLDER)
          : !view.vendors.ready
            ? START_NEEDS_VENDOR
            : change.trim() === ''
              ? NEEDS_CHANGE
              : view.mode === 'needsUndo' && !undo
                ? NEEDS_UNDO
                : unsaved && how === null
                  ? NEEDS_HOW
                  : limit === undefined
                    ? LIMIT_INVALID
                    : null

  /** Set up Claude or Codex, then Check again: the folder is read afresh (who is ready now). */
  const recheckVendors = async (): Promise<boolean> => {
    if (folder === null) return false
    const r = await invoke('easy.inspectFolder', { folder })
    if (!r.ok) {
      setError(r.error.message)
      return false
    }
    setView(r.value)
    return r.value.vendors.ready
  }

  const start = async (): Promise<void> => {
    if (view === null || reason !== null || limit === undefined || starting) return
    setStarting(true)
    const limits = { maxCostUsd: limit, maxMinutes: settings?.maxMinutes ?? null }
    const r = view.made
      ? await invoke('easy.change', { folder: view.folder, change: change.trim(), limits })
      : await invoke('easy.work', {
          folder: view.folder,
          change: change.trim(),
          ...(view.mode === 'needsUndo' ? { turnOnUndo: undo } : {}),
          ...(unsaved && how !== null ? { how } : {}),
          limits,
        })
    setStarting(false)
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    navigate({ name: 'easyRun', runId: r.value.runId })
  }

  const startButton = (
    <Button
      data-testid="easy-existing-start"
      icon={<Play aria-hidden />}
      loading={starting}
      disabled={reason !== null}
      onClick={() => void start()}
    >
      {START_LABEL}
    </Button>
  )
  const pickButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<FolderOpen aria-hidden />}
      data-testid="easy-existing-pick"
      onClick={() => void pickExistingFolder()}
    >
      {folder === null ? EXISTING_PICK : CHANGE_FOLDER}
    </Button>
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8" data-testid="easy-existing">
      <h1 className="text-2xl font-semibold">{EXISTING_TITLE}</h1>
      {folder === null || folder.trim() === '' ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">{EXISTING_NONE}</p>
          {pickButton}
        </div>
      ) : view === null ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="easy-existing-loading">
          {error ?? EXISTING_LOADING}
        </p>
      ) : (
        <div className="flex flex-col">
          <Row label={EXISTING_FOLDER_LABEL} testId="easy-existing-folder">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" data-testid="easy-existing-name">
                  {view.name}
                </span>
                {/* The end of a long path is what tells folders apart: the start is what gets cut. */}
                <span
                  dir="rtl"
                  className="truncate text-left font-mono text-xs text-muted-foreground"
                  title={view.folder}
                >
                  <bdi dir="ltr">{view.folder}</bdi>
                </span>
              </div>
              {pickButton}
            </div>
            {view.problem !== undefined && (
              <p role="alert" className="text-sm text-destructive" data-testid="easy-existing-problem">
                {view.problem}
              </p>
            )}
          </Row>
          {usable && view.mode !== undefined && (
            <>
              <Row label={EXISTING_HOW_LABEL} testId="easy-existing-how">
                <p className="text-sm" data-testid="easy-existing-mode" data-mode={view.mode}>
                  {EXISTING_MODE_TEXT[view.mode]}
                </p>
                {view.made && <p className="text-sm text-muted-foreground">{EXISTING_MADE_NOTE}</p>}
                {unsaved && (
                  <div className="flex flex-col gap-2" data-testid="easy-existing-unsaved">
                    <p className="text-sm font-medium" role="note" data-testid="easy-existing-unsaved-count">
                      {uncommittedText(view.uncommitted ?? 0)}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group">
                      {(
                        [
                          ['saveFirst', HOW_SAVE_FIRST, HOW_SAVE_FIRST_NOTE],
                          ['inPlace', HOW_IN_PLACE, HOW_IN_PLACE_NOTE],
                        ] as const
                      ).map(([id, label, note]) => (
                        <div key={id} className="flex min-w-0 flex-col items-start gap-1">
                          <Button
                            size="sm"
                            variant={how === id ? 'default' : 'outline'}
                            aria-pressed={how === id}
                            data-testid={`easy-existing-how-${id}`}
                            onClick={() => setHow(id)}
                          >
                            {label}
                          </Button>
                          <p className="text-xs text-muted-foreground">{note}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {view.mode === 'needsUndo' && (
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={undoId}
                      data-testid="easy-existing-undo"
                      className="mt-0.5"
                      checked={undo}
                      onCheckedChange={(v) => setUndo(v === true)}
                    />
                    <label htmlFor={undoId} className="text-sm">
                      {UNDO_CHECK}
                      <span className="block text-xs text-muted-foreground">{UNDO_CHECK_NOTE}</span>
                    </label>
                  </div>
                )}
              </Row>
              <Row label={EXISTING_CHANGE_LABEL} testId="easy-existing-change-row">
                <label htmlFor={changeId} className="sr-only">
                  {EXISTING_CHANGE_LABEL}
                </label>
                <Textarea
                  id={changeId}
                  data-testid="easy-existing-change"
                  rows={3}
                  maxLength={EASY_CHANGE_MAX}
                  className="h-20 resize-none"
                  placeholder={EXISTING_CHANGE_PLACEHOLDER}
                  value={change}
                  onChange={(e) => setChange(e.currentTarget.value)}
                />
              </Row>
              <Row label={COST_LABEL} testId="easy-existing-cost">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={limitId} className="text-sm">
                    {LIMIT_INPUT_LABEL}
                  </label>
                  <Input
                    id={limitId}
                    data-testid="easy-existing-limit"
                    inputMode="decimal"
                    className="h-8 w-28"
                    placeholder={LIMIT_NONE}
                    aria-invalid={limit === undefined || undefined}
                    value={limitBox}
                    onChange={(e) => {
                      limitTouched.current = true
                      setLimitBox(e.currentTarget.value)
                    }}
                  />
                </div>
                <p className="min-h-5 text-sm">
                  {limit === undefined ? LIMIT_INVALID : limit === null ? LIMIT_NONE_TEXT : limitText(limit)}
                </p>
              </Row>
              <Row label={EXISTING_ASKS_LABEL} testId="easy-existing-asks">
                <p className="text-sm">{EXISTING_ASKS}</p>
              </Row>
              <Row label={WHO_LABEL} testId="easy-existing-who">
                <p className="text-sm">{whoText(view.vendors.claude, view.vendors.codex)}</p>
                {!view.vendors.ready && (
                  <VendorSetup platform={platform} ready={view.vendors.ready} onChecked={recheckVendors} />
                )}
              </Row>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 border-t pt-4">
        <Button
          variant="outline"
          icon={<ArrowLeft aria-hidden />}
          data-testid="easy-existing-back"
          onClick={() => navigate({ name: 'easy' })}
        >
          {BACK_LABEL}
        </Button>
        <p
          className="min-h-5 min-w-0 flex-1 text-right text-sm text-destructive"
          role={error !== null && view !== null ? 'alert' : undefined}
          data-testid="easy-existing-error"
        >
          {view !== null ? (error ?? '') : ''}
        </p>
        {reason !== null ? <DisabledHint reason={reason}>{startButton}</DisabledHint> : startButton}
      </div>
    </div>
  )
}
