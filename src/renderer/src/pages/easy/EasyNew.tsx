// Easy mode's confirm screen, "Here's what I'll make": what core decided locally for the idea (no tokens): the kind
// (a plain dropdown the user can change), the template it starts from, where it is saved [Change], what happens, the
// estimate and the spending limit (none unless the user sets one; a warning with [Raise it] when the estimate may pass
// it); for a website or app, how it is built (React, or Plain HTML; why it is plain HTML without Node.js), what it needs
// beyond pages (EasyNeeds.tsx) and the checks it runs before it is ready; the files it starts with (those added on the home screen, with the privacy line), what it may do (the project
// permission: one checkbox, for this new folder only, revocable), who does the work (with the steps to set up Claude or
// Codex right here when neither is ready), then Start and Back. A report from data with no file says it will use example
// numbers, with Add files beside it. Start makes
// the folder (copying the files in) and starts the run, then opens its milestones. A vague idea is asked about first
// ("Did you mean a website or an app?", plain choices decided locally; Start waits for the answer); a model only helps
// choose when the user presses Help me choose, which says beforehand that it sends the idea and about what it costs.
// UI standards: the screen appears whole once core answered (a kind change keeps the last answer on screen until the
// next one), every line that can come and go keeps its height, and Start and Back keep their labels.
import { ArrowLeft, FilePlus, FolderOpen, Play, Sparkles } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { EASY_KINDS, EASY_MULTIPLAYER, isEasyPhotoName } from '@shared/easy.ts'
import type {
  EasyAmbiguity,
  EasyIntentAnswer,
  EasyKind,
  EasyMultiplayer,
  EasyNeed,
  EasyNeedAnswers,
  EasyResolved,
  EasyStack,
} from '@shared/easy.ts'
import { projectFolder } from '../../components/newproject/model.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { useAppInfo } from '../../state/selectors.ts'
import { useEasyState } from '../../state/experience.ts'
import { draftNow, setDraft, useDraft } from './draft.ts'
import { NeedsRows, StackRow } from './EasyNeeds.tsx'
import { VendorSetup } from './EasySetup.tsx'
import { Row } from './EasyRow.tsx'
import { EasyDepth } from './EasyDepth.tsx'
import { Segmented } from '../../components/diff/Segmented.tsx'
import { easyTwoHow } from '@shared/easy.ts'
import type { DepthSetting } from '@shared/depth.ts'
import { baseName, parseLimit, raiseTo } from './model.ts'
import {
  BACK_LABEL,
  CHANGE_FOLDER,
  CONFIRM_LOADING,
  CONFIRM_TITLE,
  CONSENT_CHECK,
  CONSENT_LABEL,
  CONSENT_NOTE,
  CONSENT_TEXT,
  COST_LABEL,
  FILES_LABEL,
  PHOTO_PRIVACY_LINE,
  PRIVACY_LINE,
  KIND_LABEL,
  KIND_TEXT,
  LIMIT_INPUT_LABEL,
  LIMIT_INVALID,
  LIMIT_NONE,
  LIMIT_NONE_TEXT,
  NO_ESTIMATE,
  RAISE_LABEL,
  ADD_FILES,
  ATTACH_NOTE_TEXT,
  NO_DATA_FILE,
  NO_DATA_FILE_NOTE,
  START_LABEL,
  START_LOADING,
  START_NEEDS_VENDOR,
  TWO_CHOICES,
  TWO_COST_NOTE,
  TWO_GROUP_LABEL,
  TWO_HAPPENS_NOTE,
  TWO_LABEL,
  TWO_OFF_LINE,
  WHAT_HAPPENS_LABEL,
  twoOnLine,
  WHERE_LABEL,
  WHERE_NOTE,
  WHO_LABEL,
  AMBIGUOUS_NOTE,
  HELP_CHOOSE,
  START_NEEDS_KIND,
  didYouMeanText,
  helpChooseText,
  suggestedText,
  estimateText,
  fallbackText,
  installsText,
  kindNote,
  limitText,
  overLimitText,
  startsFromText,
  whatHappensFor,
  DEPTH_LABEL_EASY,
  whoText,
  MULTIPLAYER_HINT,
  MULTIPLAYER_TEXT,
  ONLINE_NOTE,
  ONLINE_TITLE,
  ONEDRIVE_NOTE,
  checksText,
} from './text.ts'

export { Row }

/**
 * "Did you mean a website or an app?": a vague idea's kinds as plain choices (no tokens). "Help me choose" is the only
 * way a model is asked here: one cheap read-only call, on the user's click, that says which it would pick and why; the
 * user still picks.
 */
function DidYouMean({
  idea,
  ambiguous,
  onPick,
}: {
  idea: string
  ambiguous: EasyAmbiguity
  onPick: (kind: EasyKind) => void
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<EasyIntentAnswer | null>(null)
  const [note, setNote] = useState('')
  const headingId = useId()
  const helper = ambiguous.helper
  const ask = async (): Promise<void> => {
    if (helper === null || asking) return
    setAsking(true)
    setNote('')
    const r = await invoke('easy.intent', { idea, candidates: ambiguous.candidates })
    setAsking(false)
    if (!r.ok) {
      setNote(r.error.message)
      return
    }
    setAnswer(r.value)
    setNote(suggestedText(r.value.kind, r.value.reason))
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="easy-did-you-mean"
      className="flex flex-col gap-2 rounded-lg border border-st-waiting/50 bg-card p-4"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {didYouMeanText(ambiguous.candidates)}
      </h2>
      <p className="text-sm text-muted-foreground">{AMBIGUOUS_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2">
        {ambiguous.candidates.map((k) => (
          <Button
            key={k}
            variant={answer?.kind === k ? 'default' : 'outline'}
            data-testid={`easy-meant-${k}`}
            onClick={() => onPick(k)}
          >
            {KIND_TEXT[k]}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2">
        {helper !== null ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<Sparkles aria-hidden />}
              loading={asking}
              data-testid="easy-help-choose"
              onClick={() => void ask()}
            >
              {HELP_CHOOSE}
            </Button>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="easy-help-choose-cost">
              {helpChooseText(helper.vendor, helper.usd)}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="easy-help-choose-off">
            {ambiguous.helperReason ?? ''}
          </p>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm" data-testid="easy-help-choose-note">
        {note}
      </p>
    </section>
  )
}

/**
 * A game whose idea asks for online multiplayer: Easy never makes it (it needs a server you host), so the user picks
 * how people play together instead. Two buttons (pressed: the choice); their labels never change.
 */
function OnlineInstead({
  chosen,
  onPick,
}: {
  chosen: EasyMultiplayer
  onPick: (m: EasyMultiplayer) => void
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      data-testid="easy-online"
      className="flex flex-col gap-2 rounded-lg border border-st-waiting/50 bg-card p-4"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {ONLINE_TITLE}
      </h2>
      <p className="text-sm text-muted-foreground">{ONLINE_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={headingId}>
        {EASY_MULTIPLAYER.map((m) => (
          <Button
            key={m}
            variant={chosen === m ? 'default' : 'outline'}
            aria-pressed={chosen === m}
            data-testid={`easy-online-${m}`}
            onClick={() => onPick(m)}
          >
            {MULTIPLAYER_TEXT[m]}
          </Button>
        ))}
      </div>
      <p className="text-sm" data-testid="easy-online-hint">
        {MULTIPLAYER_HINT[chosen]}
      </p>
    </section>
  )
}

export function EasyNewPage(): React.JSX.Element {
  const draft = useDraft()
  const info = useAppInfo()
  const platform = info?.platform ?? 'win32'
  const [resolved, setResolved] = useState<EasyResolved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [parent, setParent] = useState<string | null>(null)
  const [limitText_, setLimitText] = useState('')
  const [consent, setConsent] = useState(false)
  const [starting, setStarting] = useState(false)
  /** How people play together instead of online (only for an idea that asked for online play). */
  const [multiplayer, setMultiplayer] = useState<EasyMultiplayer | null>(null)
  /** A website or app: React or plain HTML as the user picked (null: core's default). */
  const [stack, setStack] = useState<EasyStack | null>(null)
  /** "Check again" after installing Node.js: each press reads its version afresh. */
  const [recheck, setRecheck] = useState(0)
  const [checking, setChecking] = useState(false)
  /** The user's answers about what the idea needs (absent: the recommended way). */
  const [answers, setAnswers] = useState<EasyNeedAnswers>({})
  /** Quick or Thorough as the user chose it (Auto: Dim Factory decides; the line says what and why). */
  const [depth, setDepth] = useState<DepthSetting>('auto')
  /** "Two, then pick": the idea is built twice and the user keeps one. */
  const [two, setTwo] = useState(false)
  const easyState = useEasyState()
  const limitTouched = useRef(false)
  /** Started: the draft is cleared on the way to the run, which is not a reason to go back home. */
  const leaving = useRef(false)
  const consentId = useId()
  const limitId = useId()
  const kindId = useId()

  useEffect(() => {
    if (draft.idea.trim() === '') {
      if (!leaving.current) navigate({ name: 'easy' }, { replace: true })
      return
    }
    let alive = true
    setLoading(true)
    void invoke('easy.resolve', {
      idea: draft.idea,
      ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
      ...(stack !== null ? { stack } : {}),
      ...(recheck > 0 ? { recheck: true } : {}),
      ...(depth !== 'auto' ? { depth } : {}),
    }).then((r) => {
      if (!alive) return
      setLoading(false)
      setChecking(false)
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setError(null)
      setResolved(r.value)
      if (!limitTouched.current) {
        const cap = r.value.limits.maxCostUsd
        setLimitText(cap !== null ? String(cap) : '')
      }
    })
    return () => {
      alive = false
    }
  }, [draft.idea, draft.kind, stack, recheck, depth])

  const limit = parseLimit(limitText_)
  const folder =
    resolved === null
      ? ''
      : parent !== null
        ? projectFolder(parent, resolved.folderName, platform) || resolved.folder
        : resolved.folder
  const est = resolved?.estimate ?? null
  const files = (draft.attachments ?? []).filter((a) => a.error === undefined)
  const over = limit !== null && limit !== undefined && est?.costUsd != null && est.costUsd.p80 > limit
  const reason =
    resolved === null || loading
      ? START_LOADING
      : !resolved.vendors.ready
        ? START_NEEDS_VENDOR
        : resolved.ambiguous !== undefined
          ? START_NEEDS_KIND
          : limit === undefined
            ? LIMIT_INVALID
            : null

  /** Set up Claude or Codex, then Check again: the idea is read afresh (who is ready now). */
  const recheckVendors = async (): Promise<boolean> => {
    const r = await invoke('easy.resolve', {
      idea: draft.idea,
      ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
      ...(stack !== null ? { stack } : {}),
    })
    if (!r.ok) {
      setError(r.error.message)
      return false
    }
    setResolved(r.value)
    return r.value.vendors.ready
  }
  /** Add files from the confirm screen (a report from data with none): checked by core, kept in the draft. */
  const addFiles = async (): Promise<void> => {
    const r = await invoke('dialog.pickFiles', {})
    if (!r.ok || r.value.length === 0) return
    const have = (draft.attachments ?? []).map((f) => f.path)
    const checked = await invoke('easy.attachCheck', {
      paths: [...have, ...r.value.filter((p) => !have.includes(p))],
    })
    if (!checked.ok) {
      setError(checked.error.message)
      return
    }
    setDraft({ ...draftNow(), attachments: checked.value })
  }

  const chooseFolder = async (): Promise<void> => {
    const r = await invoke('dialog.pickFolder', { defaultPath: parent ?? resolved?.projectsDir ?? '' })
    if (r.ok && r.value !== null) setParent(r.value)
  }
  const start = async (): Promise<void> => {
    if (resolved === null || reason !== null || limit === undefined || starting) return
    setStarting(true)
    const r = await invoke('easy.create', {
      idea: draft.idea,
      kind: resolved.kind,
      folder,
      limits: { maxCostUsd: limit, maxMinutes: resolved.limits.maxMinutes },
      consent,
      ...(files.length > 0 ? { attachments: files.map((f) => f.path) } : {}),
      ...(resolved.online !== undefined ? { multiplayer: multiplayer ?? resolved.online.instead } : {}),
      ...(resolved.stack !== undefined ? { stack: resolved.stack.chosen } : {}),
      ...(resolved.needs !== undefined && resolved.needs.length > 0 ? { needs: answers } : {}),
      ...(depth !== 'auto' ? { depth } : {}),
      ...(two ? { two: true } : {}),
    })
    setStarting(false)
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    leaving.current = true
    if (r.value.matchId !== undefined) navigate({ name: 'easyTwo', matchId: r.value.matchId })
    else navigate({ name: 'easyRun', runId: r.value.runId })
    setDraft({ idea: '' })
  }

  const startButton = (
    <Button
      data-testid="easy-start"
      icon={<Play aria-hidden />}
      loading={starting}
      disabled={reason !== null}
      onClick={() => void start()}
    >
      {START_LABEL}
    </Button>
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8" data-testid="easy-confirm">
      <h1 className="text-2xl font-semibold">{CONFIRM_TITLE}</h1>
      <blockquote
        className="border-l-2 pl-3 text-sm break-words text-muted-foreground"
        data-testid="easy-confirm-idea"
      >
        {draft.idea}
      </blockquote>
      {resolved === null ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="easy-confirm-loading">
          {error ?? CONFIRM_LOADING}
        </p>
      ) : (
        <div className="flex flex-col">
          {resolved.ambiguous !== undefined && (
            <div className="pb-4">
              <DidYouMean
                key={draft.idea}
                idea={draft.idea}
                ambiguous={resolved.ambiguous}
                onPick={(k) => setDraft({ ...draft, kind: k })}
              />
            </div>
          )}
          {resolved.online !== undefined && (
            <div className="pb-4">
              <OnlineInstead chosen={multiplayer ?? resolved.online.instead} onPick={setMultiplayer} />
            </div>
          )}
          <Row label={KIND_LABEL} testId="easy-confirm-kind">
            <div className="w-full max-w-xs">
              <Select
                value={resolved.kind}
                onValueChange={(v) => {
                  if ((EASY_KINDS as readonly string[]).includes(v))
                    setDraft({ ...draft, kind: v as EasyKind })
                }}
              >
                <SelectTrigger id={kindId} aria-label={KIND_LABEL} data-testid="easy-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EASY_KINDS.map((k) => (
                    <SelectItem key={k} value={k} data-testid={`easy-kind-${k}`}>
                      {KIND_TEXT[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              {kindNote(resolved.kindSource)} {startsFromText(resolved.template.label)}
            </p>
            <p className="min-h-5 text-sm text-muted-foreground" data-testid="easy-confirm-fallback">
              {resolved.fallback !== undefined
                ? fallbackText(
                    resolved.fallback.wanted.label,
                    resolved.fallback.needs,
                    resolved.fallback.wanted.id,
                  )
                : resolved.installs !== undefined && resolved.installs.length > 0
                  ? installsText(resolved.installs)
                  : ''}
            </p>
          </Row>
          <Row label={WHERE_LABEL} testId="easy-confirm-where">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" data-testid="easy-folder-name">
                  {baseName(folder)}
                </span>
                {/* The end of a long path is what tells folders apart: the start is what gets cut. */}
                <span
                  dir="rtl"
                  className="truncate text-left font-mono text-xs text-muted-foreground"
                  title={folder}
                >
                  <bdi dir="ltr" data-testid="easy-folder">
                    {folder}
                  </bdi>
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                icon={<FolderOpen aria-hidden />}
                data-testid="easy-folder-change"
                onClick={() => void chooseFolder()}
              >
                {CHANGE_FOLDER}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{WHERE_NOTE}</p>
            {parent === null &&
              easyState?.settings.projectsDir == null &&
              easyState?.defaultProjectsReason === 'onedrive' && (
                <p className="text-sm" role="note" data-testid="easy-onedrive-note">
                  {ONEDRIVE_NOTE}
                </p>
              )}
          </Row>
          <StackRow
            resolved={resolved}
            platform={platform}
            checking={checking}
            onPick={(s) => setStack(s)}
            onCheckAgain={() => {
              setChecking(true)
              setRecheck((n) => n + 1)
            }}
          />
          {resolved.stack !== undefined && (
            <NeedsRows
              needs={resolved.needs ?? []}
              answers={answers}
              onAnswer={(need: EasyNeed, choice: string) => setAnswers((a) => ({ ...a, [need]: choice }))}
            />
          )}
          <Row label={DEPTH_LABEL_EASY} testId="easy-confirm-depth">
            <EasyDepth value={depth} decision={resolved.depth} onChange={setDepth} testId="easy-depth" />
          </Row>
          <Row label={TWO_LABEL} testId="easy-confirm-two">
            {/* Its own row, so the choice keeps its widths instead of stretching across the column. */}
            <div className="flex">
              <Segmented
                label={TWO_GROUP_LABEL}
                testId="easy-two-choice"
                options={TWO_CHOICES}
                value={two ? 'two' : 'one'}
                onChange={(v) => setTwo(v === 'two')}
              />
            </div>
            <p className="min-h-10 text-sm text-muted-foreground" data-testid="easy-two-line">
              {two ? twoOnLine(easyTwoHow(resolved.vendors)) : TWO_OFF_LINE}
            </p>
          </Row>
          <Row label={WHAT_HAPPENS_LABEL} testId="easy-confirm-what">
            <p className="text-sm" data-testid="easy-confirm-what-text">
              {whatHappensFor(resolved.research, resolved.depth?.depth)}
            </p>
            {two && (
              <p className="text-sm" data-testid="easy-two-happens">
                {TWO_HAPPENS_NOTE}
              </p>
            )}
            {resolved.checks !== undefined && resolved.checks.length > 0 && (
              <p className="text-sm" data-testid="easy-confirm-checks">
                {checksText(resolved.checks)}
              </p>
            )}
          </Row>
          <Row label={COST_LABEL} testId="easy-confirm-cost">
            <p className="text-sm" data-testid="easy-estimate">
              {est !== null ? estimateText(est.durationMs, est.costUsd) : NO_ESTIMATE}
            </p>
            {two && (
              <p className="text-sm font-medium" role="note" data-testid="easy-two-cost">
                {TWO_COST_NOTE}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={limitId} className="text-sm">
                {LIMIT_INPUT_LABEL}
              </label>
              <Input
                id={limitId}
                data-testid="easy-limit"
                inputMode="decimal"
                className="h-8 w-28"
                placeholder={LIMIT_NONE}
                aria-invalid={limit === undefined || undefined}
                value={limitText_}
                onChange={(e) => {
                  limitTouched.current = true
                  setLimitText(e.currentTarget.value)
                }}
              />
            </div>
            <div className="flex min-h-9 flex-wrap items-center gap-2" data-testid="easy-limit-line">
              <p className="min-w-0 flex-1 text-sm" role={over ? 'alert' : undefined}>
                {limit === undefined
                  ? LIMIT_INVALID
                  : limit === null
                    ? LIMIT_NONE_TEXT
                    : over && est?.costUsd != null
                      ? overLimitText(limit, raiseTo(est.costUsd.p80))
                      : limitText(limit)}
              </p>
              {over && est?.costUsd != null && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="easy-limit-raise"
                  onClick={() => {
                    limitTouched.current = true
                    setLimitText(String(raiseTo(est.costUsd?.p80 ?? 0)))
                  }}
                >
                  {RAISE_LABEL}
                </Button>
              )}
            </div>
          </Row>
          {files.length === 0 && resolved.kind === 'data' && (
            <Row label={FILES_LABEL} testId="easy-confirm-no-data">
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-sm font-medium" role="note" data-testid="easy-no-data-line">
                  {NO_DATA_FILE}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<FilePlus aria-hidden />}
                  data-testid="easy-confirm-add-files"
                  onClick={() => void addFiles()}
                >
                  {ADD_FILES}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{NO_DATA_FILE_NOTE}</p>
            </Row>
          )}
          {files.length > 0 && (
            <Row label={FILES_LABEL} testId="easy-confirm-files">
              <ul className="flex flex-col gap-0.5 text-sm">
                {files.map((f) => (
                  <li key={f.path} className="flex min-w-0 flex-col" title={f.path}>
                    <span className="truncate">{f.name}</span>
                    {f.note !== undefined && (
                      <span className="text-xs text-muted-foreground" data-testid="easy-confirm-file-note">
                        {ATTACH_NOTE_TEXT[f.note]}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!files.every((f) => !f.folder && isEasyPhotoName(f.name)) && (
                <p className="text-sm font-medium" role="note" data-testid="easy-confirm-privacy">
                  {PRIVACY_LINE}
                </p>
              )}
              {files.some((f) => !f.folder && isEasyPhotoName(f.name)) && (
                <p className="text-sm font-medium" role="note" data-testid="easy-confirm-photo-privacy">
                  {PHOTO_PRIVACY_LINE}
                </p>
              )}
            </Row>
          )}
          <Row label={CONSENT_LABEL} testId="easy-confirm-consent">
            <p className="text-sm">{CONSENT_TEXT}</p>
            <div className="flex items-start gap-2">
              <Checkbox
                id={consentId}
                data-testid="easy-consent"
                className="mt-0.5"
                checked={consent}
                onCheckedChange={(v) => setConsent(v === true)}
              />
              <label htmlFor={consentId} className="text-sm">
                {CONSENT_CHECK}
                <span className="block text-xs text-muted-foreground">{CONSENT_NOTE}</span>
              </label>
            </div>
          </Row>
          <Row label={WHO_LABEL} testId="easy-confirm-who">
            <p className="text-sm">{whoText(resolved.vendors.claude, resolved.vendors.codex)}</p>
            {!resolved.vendors.ready && (
              <VendorSetup platform={platform} ready={resolved.vendors.ready} onChecked={recheckVendors} />
            )}
          </Row>
        </div>
      )}
      <div className="flex items-center gap-3 border-t pt-4">
        <Button
          variant="outline"
          icon={<ArrowLeft aria-hidden />}
          data-testid="easy-back"
          onClick={() => navigate({ name: 'easy' })}
        >
          {BACK_LABEL}
        </Button>
        <p
          className="min-h-5 min-w-0 flex-1 text-right text-sm text-destructive"
          role={error !== null && resolved !== null ? 'alert' : undefined}
          data-testid="easy-confirm-error"
        >
          {resolved !== null ? (error ?? '') : ''}
        </p>
        {reason !== null ? <DisabledHint reason={reason}>{startButton}</DisabledHint> : startButton}
      </div>
    </div>
  )
}
