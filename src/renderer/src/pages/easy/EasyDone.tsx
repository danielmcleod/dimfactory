// Easy mode's Done screen: what happened in one title ("Your bakery landing page is ready", "Mostly ready: 2 things
// still need work", "It stopped at your $5 limit" with [Continue with $3 more], "You stopped it", "It did not finish"),
// then Open it (the rendered document for a document, memo or checklist, with Save as PDF; Dim Factory's own read-only
// server for a page; the project's own preview when its permission or a grant trusts it), Show the files and Show
// details; how many things the project permission approved during the run; How to use it first (the Explain summary),
// What it can do (the plan's checks as works / not yet), Make a change (a follow-up run in the same folder), For next
// time ("Remember this for next time": the project memory update core proposed for this run, written on one click),
// Share it (folded: putting it online makes it public; the Deploy helper's steps, nothing is executed), Try fixing the
// rest (when Fix can go on) and Undo everything (Revert all, with its own undo). A run that worked in a copy of the
// folder has "Your changes" instead of Undo everything: kept or thrown away, with that choice's own undo (and the two
// buttons again while the changes still wait in the copy). A website, an app or a game offers "Look it over" (EasyLook.tsx),
// and anything built offers "Ask about it" (EasyAsk.tsx: one read-only question about the project). A website, an app or
// a document offers "Before I share it" (EasyShareCheck.tsx: one local check, with Fix these going to Make a change).
// The summary's "Things to fill in" (facts left as marked spaces instead of made up) gets its own section; a run that
// did not finish says why in plain words, with the recovery core armed and Carry on (EasyFailed.tsx); Make a change
// shows about what the change costs and takes before the click (and, for a report from data, takes a new data file);
// a report from data's Share it says who can see its figures; the project history lists every run in the folder, each
// with "Go back to before this" (EasyHistory.tsx).
// UI standards: the screen appears whole once the summary, the stop reason, the project and its permission are read
// (nothing arrives later and moves the page); the Open it note and the memory line keep their lines; buttons keep their
// labels.
import {
  Brain,
  ExternalLink,
  FileDown,
  FilePlus,
  FolderOpen,
  Gamepad2,
  Globe,
  Play,
  RotateCcw,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { RunSnapshot } from '@shared/run.ts'
import { EASY_CHANGE_MAX, EASY_DOCUMENT_KINDS, EASY_PLAY_KINDS, EASY_VISUAL_KINDS } from '@shared/easy.ts'
import type { EasyAttachment, EasyChangeEstimate } from '@shared/easy.ts'
import type { MemoryView } from '@shared/factory.ts'
import { DeployPanel } from '../../components/deploy/DeployPanel.tsx'
import { explainWritten } from '../../components/run/ExplainSection.tsx'
import { LightMarkdown } from '../../components/run/LightMarkdown.tsx'
import { useRunOutput } from '../../components/run/outputs.ts'
import { revertAll, useFolderBusyReason } from '../../components/run/revert.ts'
import { runMadeNoChanges } from '../../components/run/RunEndPanel.tsx'
import { EASY_CONTEXT_TITLE, easyHealthNotes } from '../../components/run/text.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { href, navigate, useRoute } from '../../lib/router.ts'
import { useEasyPermission } from '../../state/easyPermission.ts'
import { useEasyState } from '../../state/experience.ts'
import { useMemoryVersion } from '../../state/queue.ts'
import { toast } from '../../state/toasts.ts'
import { ChangesLine } from './EasyChanges.tsx'
import { EasyPlaytest } from './EasyPlaytest.tsx'
import { EasyTryIt } from './EasyTryIt.tsx'
import { EasyAsk } from './EasyAsk.tsx'
import { EasyShareCheck } from './EasyShareCheck.tsx'
import { openSession } from './session.ts'
import { PHONE_OFF_NOTE, PHONE_ON_NOTE, PhoneSizeButton } from '../../components/run/GamePreview.tsx'
import { LookItOver, useVisual } from './EasyLook.tsx'
import { useRunLimits } from './EasyRun.tsx'
import { baseName, continueAmount, controlsLine, projectTitle, splitFillIns } from './model.ts'
import { EasyFailed } from './EasyFailed.tsx'
import { EasyDepth } from './EasyDepth.tsx'
import { Segmented } from '../../components/diff/Segmented.tsx'
import type { DepthSetting } from '@shared/depth.ts'
import { EasyHistory } from './EasyHistory.tsx'
import { useEasyProject } from './useProject.ts'
import {
  ACCEPTANCE_WORD,
  ADD_FILES,
  ATTACH_NOTE_TEXT,
  CHANGE_FILES_NOTE,
  REMOVE_FILE,
  REMOVE_REFUSED,
  changeEstimateText,
  BUSY_FOLDER,
  CHANGES_TITLE,
  CONTROLS_LABEL,
  CONTROLS_UNKNOWN,
  FAILED_TITLE,
  FILL_IN_NOTE,
  FILL_IN_TITLE,
  SHARE_DATA,
  HOW_TO_PLAY,
  HOW_TO_USE,
  HOW_TO_USE_LOADING,
  HOW_TO_USE_NONE,
  LIMIT_STOP_TEXT,
  MAKE_CHANGE,
  MAKE_CHANGE_DISABLED,
  MAKE_CHANGE_LABEL,
  MAKE_CHANGE_PLACEHOLDER,
  MAKE_CHANGE_TITLE,
  TWO_CHANGE_ON_LINE,
  TWO_CHOICES,
  TWO_GROUP_LABEL,
  TWO_OFF_LINE,
  NOT_WORKING,
  NOT_WORKING_HINT,
  NO_CHECKLIST,
  NOTHING_TO_UNDO,
  OPENED,
  OPENED_IN_BROWSER,
  OPEN_IN_BROWSER,
  OPEN_IT,
  PLAYING,
  PLAY_IT,
  OPEN_NOTHING,
  REMEMBERED,
  REMEMBER_BUSY,
  REMEMBER_LABEL,
  REMEMBER_TEXT,
  REMEMBER_TITLE,
  SAVE_PDF,
  SHARE_HIDE,
  SHARE_INTRO,
  SHARE_PHOTOS,
  SHARE_PLAY_INTRO,
  SHARE_PUBLIC,
  SHARE_SHOW,
  SHARE_TITLE,
  SHOW_DETAILS,
  SHOW_FILES,
  STOPPED_TEXT,
  STOPPED_TITLE,
  TRY_FIXING,
  TRY_FIXING_TEXT,
  UNDO_EVERYTHING,
  UNDO_EVERYTHING_TEXT,
  WHAT_IT_CAN_DO,
  continueMoreLabel,
  continueTimeLabel,
  costStopTitle,
  mostlyReadyTitle,
  readyTitle,
  KIND_NOUN,
  PROJECT_NOUN,
  permissionUsesText,
  savedPdfText,
  timeStopTitle,
  CHANGE_DEPTH_WAIT,
} from './text.ts'

/** How often, and how far apart, a missing summary file is asked for again. */
const EXPLAIN_TRIES = 10
const EXPLAIN_RETRY_MS = 500

const READY_OUTCOMES = new Set(['clean', 'fixed', 'no-changes'])
/** Outcomes that leave something for another Fix round to try. */
const FIXABLE = new Set(['findings-open', 'fix-stopped', 'verify-failed', 'security-open', 'gates-failed'])

function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} data-testid={testId} className="flex flex-col gap-2 border-t pt-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * Open it (and Save as PDF for a document), with Show the files and Show details beside it and its note on one
 * reserved line below. A run that built nothing (it stopped before Implement changed a file) has nothing to open:
 * only Show the files and Show details stay.
 */
function OpenIt({
  runId,
  document,
  play,
  built,
  quiet = false,
  children,
}: {
  runId: string
  /** Whether the run built anything: Implement ran or a file changed. */
  built: boolean
  /** A run that did not finish: Carry on is the main button, so Open it is a secondary one. */
  quiet?: boolean
  document: boolean
  /** A game: Play it (always the preview window, which takes the keyboard) and Open in browser. */
  play: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [note, setNote] = useState('')
  /** The preview window is at Phone size (as main last answered). */
  const [phone, setPhone] = useState(false)
  const togglePhone = (): void =>
    run('phone', async () => {
      const s = await openSession(runId, false)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      const r = await invoke('preview.phone', { sessionId: s.sessionId, phone: !phone })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      const on = r.value.phone === true
      setPhone(on)
      setNote(on ? PHONE_ON_NOTE : PHONE_OFF_NOTE)
    })
  const open = (where?: 'app' | 'browser'): void =>
    run(where === 'browser' ? 'browser' : 'open', async () => {
      const s = await openSession(runId, document)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      const target = where ?? s.openIn
      const o = await invoke('preview.open', { sessionId: s.sessionId, target })
      setNote(!o.ok ? o.error.message : target === 'browser' ? OPENED_IN_BROWSER : play ? PLAYING : OPENED)
    })
  const savePdf = (): void =>
    run('pdf', async () => {
      const s = await openSession(runId, true)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      if (s.kind !== 'document') {
        setNote(OPEN_NOTHING)
        return
      }
      const r = await invoke('preview.savePdf', { sessionId: s.sessionId })
      setNote(r.ok ? savedPdfText(baseName(r.value.path)) : r.error.message)
    })
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {!built ? null : play ? (
          <>
            <Button
              variant={quiet ? 'outline' : 'default'}
              icon={<Gamepad2 aria-hidden />}
              loading={busy === 'open'}
              disabled={busy !== null && busy !== 'open'}
              onClick={() => open('app')}
              data-testid="easy-play-it"
            >
              {PLAY_IT}
            </Button>
            <Button
              variant="outline"
              icon={<Globe aria-hidden />}
              loading={busy === 'browser'}
              disabled={busy !== null && busy !== 'browser'}
              onClick={() => open('browser')}
              data-testid="easy-open-browser"
            >
              {OPEN_IN_BROWSER}
            </Button>
            <PhoneSizeButton
              size="md"
              pressed={phone}
              loading={busy === 'phone'}
              disabled={busy !== null && busy !== 'phone'}
              onClick={togglePhone}
              testId="easy-phone-size"
            />
          </>
        ) : (
          <Button
            variant={quiet ? 'outline' : 'default'}
            icon={<Play aria-hidden />}
            loading={busy === 'open'}
            disabled={busy !== null && busy !== 'open'}
            onClick={() => open()}
            data-testid="easy-open-it"
          >
            {OPEN_IT}
          </Button>
        )}
        {built && document && (
          <Button
            variant="outline"
            icon={<FileDown aria-hidden />}
            loading={busy === 'pdf'}
            disabled={busy !== null && busy !== 'pdf'}
            onClick={savePdf}
            data-testid="easy-save-pdf"
          >
            {SAVE_PDF}
          </Button>
        )}
        {children}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-open-note">
        {note}
      </p>
    </div>
  )
}

/** How long after the last key press the change's estimate is asked for. */
const ESTIMATE_DELAY_MS = 600

/** What a change would cost and take, asked again a moment after the user stops typing (null: nothing to say yet). */
function useChangeEstimate(folder: string, text: string, depth: DepthSetting): EasyChangeEstimate | null {
  const [v, setV] = useState<EasyChangeEstimate | null>(null)
  useEffect(() => {
    const change = text.trim()
    if (change === '') {
      setV(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void invoke('easy.changeEstimate', { folder, change, ...(depth !== 'auto' ? { depth } : {}) }).then(
        (r) => {
          if (alive && r.ok) setV(r.value)
        },
      )
    }, ESTIMATE_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [folder, text, depth])
  return v
}

function MakeChange({
  snap,
  focus,
  data,
  seed,
}: {
  snap: RunSnapshot
  focus: boolean
  /** What Try it for me found, for It's not working. */
  seed: string | null
  /** A report from data: a new data file can go with the change. */
  data: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<EasyAttachment[]>([])
  const [busy, run] = useBusy()
  const settings = useEasyState()?.settings
  const folderBusy = useFolderBusyReason(snap.summary.runId)
  /** Quick or Thorough as the user chose it (Auto: Dim Factory decides). */
  const [depth, setDepth] = useState<DepthSetting>('auto')
  /** "Two, then pick": the change is made twice and the user keeps one. */
  const [two, setTwo] = useState(false)
  const estimate = useChangeEstimate(snap.summary.folder, text, depth)
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (seed === null) return
    setText(seed)
    box.current?.focus()
  }, [seed])
  useEffect(() => {
    // Asked for from the project list ("Make a change"): the user's own action brings the box into view.
    if (focus) box.current?.focus()
  }, [focus])
  const ok = files.filter((f) => f.error === undefined)
  const reason =
    folderBusy !== undefined
      ? BUSY_FOLDER
      : text.trim() === ''
        ? MAKE_CHANGE_DISABLED
        : ok.length !== files.length
          ? REMOVE_REFUSED
          : null
  const addFiles = (): void =>
    run('files', async () => {
      const r = await invoke('dialog.pickFiles', {})
      if (!r.ok || r.value.length === 0) return
      const have = files.map((f) => f.path)
      const checked = await invoke('easy.attachCheck', {
        paths: [...have, ...r.value.filter((p) => !have.includes(p))],
      })
      if (!checked.ok) {
        toast({ level: 'error', message: checked.error.message })
        return
      }
      setFiles(checked.value)
    })
  const go = (notWorking = false): void =>
    run('change', async () => {
      const r = await invoke('easy.change', {
        folder: snap.summary.folder,
        change: text.trim(),
        ...(notWorking ? { notWorking: true } : {}),
        limits: { maxCostUsd: settings?.changeMaxCostUsd ?? null, maxMinutes: settings?.maxMinutes ?? null },
        ...(ok.length > 0 ? { attachments: ok.map((f) => f.path) } : {}),
        ...(depth !== 'auto' ? { depth } : {}),
        ...(two ? { two: true } : {}),
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      if (r.value.matchId !== undefined) navigate({ name: 'easyTwo', matchId: r.value.matchId })
      else navigate({ name: 'easyRun', runId: r.value.runId })
    })
  const button = (
    <Button
      data-testid="easy-make-change"
      loading={busy !== null}
      disabled={reason !== null}
      onClick={() => go()}
    >
      {MAKE_CHANGE}
    </Button>
  )
  const notWorking = (
    <Button
      variant="outline"
      data-testid="easy-not-working"
      title={NOT_WORKING_HINT}
      loading={busy !== null}
      disabled={reason !== null}
      onClick={() => go(true)}
    >
      {NOT_WORKING}
    </Button>
  )
  return (
    <Section title={MAKE_CHANGE_TITLE} testId="easy-done-change">
      <label htmlFor={id} className="text-sm">
        {MAKE_CHANGE_LABEL}
      </label>
      <Textarea
        id={id}
        ref={box}
        data-testid="easy-change-text"
        rows={3}
        maxLength={EASY_CHANGE_MAX}
        className="h-20 resize-none"
        placeholder={MAKE_CHANGE_PLACEHOLDER}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      {/* Always there and one line high: the estimate fills it once the user has typed (nothing moves). */}
      <p className="min-h-5 text-sm text-muted-foreground" data-testid="easy-change-estimate">
        {estimate !== null
          ? changeEstimateText(
              estimate.estimate?.durationMs ?? null,
              estimate.estimate?.costUsd ?? null,
              estimate.small,
              estimate.security === 'full',
              estimate.depth?.depth === 'direct',
            )
          : ''}
      </p>
      <EasyDepth
        value={depth}
        decision={text.trim() !== '' ? estimate?.depth : undefined}
        onChange={setDepth}
        testId="easy-change-depth"
        waiting={text.trim() === '' ? CHANGE_DEPTH_WAIT : undefined}
      />
      {/* Always there (a change can be made twice in any folder Easy works in), so nothing arrives late. */}
      <div className="flex min-w-0 flex-col gap-1.5" data-testid="easy-change-two">
        {/* Its own row, so the choice keeps its widths instead of stretching across the column. */}
        <div className="flex">
          <Segmented
            label={TWO_GROUP_LABEL}
            testId="easy-change-two-choice"
            options={TWO_CHOICES}
            value={two ? 'two' : 'one'}
            onChange={(v) => setTwo(v === 'two')}
          />
        </div>
        {/* Two lines high always, so choosing moves nothing below it. */}
        <p className="min-h-10 text-sm text-muted-foreground" data-testid="easy-change-two-line">
          {two ? TWO_CHANGE_ON_LINE : TWO_OFF_LINE}
        </p>
      </div>
      {data && (
        <div className="flex flex-col gap-1" data-testid="easy-change-files">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              icon={<FilePlus aria-hidden />}
              loading={busy === 'files'}
              disabled={busy !== null && busy !== 'files'}
              onClick={addFiles}
              data-testid="easy-change-add-files"
            >
              {ADD_FILES}
            </Button>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">{CHANGE_FILES_NOTE}</p>
          </div>
          {files.length > 0 && (
            <ul className="flex flex-col gap-1">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="flex min-h-8 min-w-0 items-center gap-3 rounded-md border px-3 py-1"
                  data-testid="easy-change-file"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm" title={f.path}>
                      {f.name}
                    </span>
                    {(f.error !== undefined || f.note !== undefined) && (
                      <span className={f.error !== undefined ? 'text-xs text-destructive' : 'text-xs'}>
                        {f.error ?? (f.note !== undefined ? ATTACH_NOTE_TEXT[f.note] : '')}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X aria-hidden />}
                    aria-label={`${REMOVE_FILE}: ${f.name}`}
                    onClick={() => setFiles(files.filter((x) => x.path !== f.path))}
                  >
                    {REMOVE_FILE}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {reason !== null ? <DisabledHint reason={reason}>{button}</DisabledHint> : button}
        {reason !== null ? <DisabledHint reason={reason}>{notWorking}</DisabledHint> : notWorking}
      </div>
    </Section>
  )
}

/** The project memory update core proposed for this run (null: none, or not read yet), read again when it changes. */
function useMemoryProposal(folder: string): MemoryView | null {
  const version = useMemoryVersion(folder)
  const [v, setV] = useState<MemoryView | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('memory.get', { folder }).then((r) => {
      if (alive) setV(r.ok ? r.value : null)
    })
    return () => {
      alive = false
    }
  }, [folder, version])
  return v
}

/**
 * "Remember this for next time": the memory update core proposed when this run ended, written with one click
 * (memory.apply). The section is always there; only its one line changes (the button, or what happened).
 */
function Remember({ runId, folder }: { runId: string; folder: string }): React.JSX.Element {
  const view = useMemoryProposal(folder)
  const folderBusy = useFolderBusyReason(runId)
  const [busy, run] = useBusy()
  const [done, setDone] = useState(false)
  const pending = view?.pending.find((p) => p.runId === runId)
  const remember = (): void =>
    run('remember', async () => {
      if (pending === undefined) return
      const r = await invoke('memory.apply', { folder, id: pending.id })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      setDone(true)
    })
  const button = (
    <Button
      variant="outline"
      icon={<Brain aria-hidden />}
      loading={busy === 'remember'}
      disabled={pending === undefined || folderBusy !== undefined}
      onClick={remember}
      data-testid="easy-remember"
    >
      {REMEMBER_LABEL}
    </Button>
  )
  return (
    <Section title={REMEMBER_TITLE} testId="easy-done-remember">
      <p className="text-sm">{REMEMBER_TEXT}</p>
      <div className="flex min-h-9 items-center">
        {done ? (
          <p role="status" className="text-sm" data-testid="easy-remembered">
            {REMEMBERED}
          </p>
        ) : folderBusy !== undefined && pending !== undefined ? (
          <DisabledHint reason={REMEMBER_BUSY}>{button}</DisabledHint>
        ) : (
          button
        )}
      </div>
    </Section>
  )
}

export function EasyDone({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const s = snap.summary
  const runId = s.runId
  const route = useRoute()
  const limits = useRunLimits(runId, s.status === 'cancelled')
  const written = explainWritten(snap)
  // The summary file can land a moment after the run says it ended: a missing file is asked for again, a few times.
  const [tries, setTries] = useState(0)
  const [seed, setSeed] = useState<string | null>(null)
  const explain = useRunOutput(
    runId,
    'explain',
    `${snap.steps.explain.attempt}:${snap.steps.explain.status}:${tries}`,
    written,
  )
  const retry = written && explain.status === 'missing' && tries < EXPLAIN_TRIES
  useEffect(() => {
    if (!retry) return
    const t = setTimeout(() => setTries((n) => n + 1), EXPLAIN_RETRY_MS)
    return () => clearTimeout(t)
  }, [retry, tries])
  const [busy, run] = useBusy()
  const folderBusy = useFolderBusyReason(runId)
  const settings = useEasyState()?.settings
  const project = useEasyProject(s.folder)
  const permission = useEasyPermission(s.folder, runId)
  const looks =
    project !== 'loading' &&
    project !== null &&
    project.kind !== undefined &&
    EASY_VISUAL_KINDS.includes(project.kind) &&
    s.status === 'completed'
  const visual = useVisual(runId, looks)

  // The screen appears whole: the stop reason (a cancelled run), what Easy made it as, its permission, whether its page
  // can be looked at (a website, an app or a game), and the summary (when Explain wrote one) first.
  const waiting =
    (s.status === 'cancelled' && limits === 'loading') ||
    project === 'loading' ||
    permission === null ||
    (looks && visual === 'loading') ||
    (written && explain.status === 'loading') ||
    retry
  if (waiting) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status" data-testid="easy-done-loading">
        {HOW_TO_USE_LOADING}
      </p>
    )
  }
  const stop = limits !== 'loading' && limits !== null ? limits.stop : undefined
  const acceptance = snap.acceptance
  const open = acceptance?.counts.notMet ?? s.findings.must
  // Context health in plain words (core's report comes with the snapshot, so it never arrives later).
  const easyNotes = easyHealthNotes(snap.contextHealth?.items ?? [])

  const failed =
    stop === undefined && s.status !== 'cancelled' && (s.status === 'failed' || s.outcome === 'failed')
  let title: string
  let lead: string | null = null
  if (stop !== undefined) {
    title = stop.kind === 'cost' ? costStopTitle(stop.limit) : timeStopTitle(stop.limit)
    lead = LIMIT_STOP_TEXT
  } else if (s.status === 'cancelled') {
    title = STOPPED_TITLE
    lead = STOPPED_TEXT
  } else if (failed) {
    // The plain line, what to do and Carry on are EasyFailed's, under the header.
    title = FAILED_TITLE
  } else if (s.outcome !== undefined && READY_OUTCOMES.has(s.outcome)) {
    title = readyTitle(
      project !== null && project.kind !== undefined ? KIND_NOUN[project.kind] : PROJECT_NOUN,
    )
  } else {
    title = mostlyReadyTitle(open)
  }

  const more = stop !== undefined ? continueAmount(stop.limit) : 0
  const continueRun = (): void =>
    run('continue', async () => {
      if (stop === undefined) return
      const r = await invoke('easy.change', {
        folder: s.folder,
        continueRunId: runId,
        limits:
          stop.kind === 'cost'
            ? {
                maxCostUsd: more,
                maxMinutes: limits !== 'loading' ? (limits?.limits.maxMinutes ?? null) : null,
              }
            : { maxCostUsd: settings?.maxCostUsd ?? null, maxMinutes: more },
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      navigate({ name: 'easyRun', runId: r.value.runId })
    })
  const tryFixing = (): void =>
    run('fix', async () => {
      const r = await invoke('runs.rerun', { runId, from: 'fix' })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      navigate({ name: 'easyRun', runId: r.value.runId })
    })
  const showFiles = (): void => {
    void invoke('shell.open', { target: 'folder', path: s.folder }).then((r) => {
      if (!r.ok) toast({ level: 'error', message: r.error.message })
    })
  }
  const canFix = s.outcome !== undefined && FIXABLE.has(s.outcome) && snap.rerunFromFix.available
  const noChanges = runMadeNoChanges(snap)
  // Nothing to open, play or save as PDF when the run stopped before Implement built anything (a failure at Plan).
  const built = s.status === 'completed' || snap.steps.implement.attempt > 0 || s.progress.filesChanged > 0
  // A run in a copy of the folder: its changes are kept or thrown away (with their own undo), not reverted.
  const isolated = s.isolation === 'worktree'
  // A game: Play it, How to play with its controls line, and Share it says who can play (and that photos go with it).
  const play = project !== null && project.kind !== undefined && EASY_PLAY_KINDS.includes(project.kind)
  const photos = play && project?.photos === true
  const controls = written && explain.status === 'ready' ? controlsLine(explain.output.text) : null
  // The summary's Things to fill in gets its own section; How to use shows the rest.
  const summary = written && explain.status === 'ready' ? splitFillIns(explain.output.text) : null
  const fillIns = summary?.fillIns ?? []
  const data = project !== null && project.kind === 'data'
  const isWebKind = project?.kind === 'app' || project?.kind === 'website'
  const isDocument = project?.kind !== undefined && EASY_DOCUMENT_KINDS.includes(project.kind)

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8"
      data-testid="easy-done"
      data-run-id={runId}
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold" data-testid="easy-done-title">
            {title}
          </h1>
          <p
            className="truncate text-sm text-muted-foreground"
            title={s.folder}
            data-testid="easy-done-project"
          >
            {projectTitle(s.folder, project?.title)}
          </p>
          {lead !== null && <p className="text-sm text-muted-foreground">{lead}</p>}
          {(permission.granted || permission.runUses > 0) && (
            <p className="text-sm text-muted-foreground" data-testid="easy-permission-uses">
              {permissionUsesText(permission.runUses)}
            </p>
          )}
        </div>
        {failed && <EasyFailed snap={snap} />}
        {stop !== undefined && (
          <div>
            <Button
              icon={<RotateCcw aria-hidden />}
              loading={busy === 'continue'}
              disabled={busy !== null && busy !== 'continue'}
              onClick={continueRun}
              data-testid="easy-continue-more"
            >
              {stop.kind === 'cost' ? continueMoreLabel(more) : continueTimeLabel(more)}
            </Button>
          </div>
        )}
        <OpenIt
          runId={runId}
          document={project?.kind !== undefined && EASY_DOCUMENT_KINDS.includes(project.kind)}
          play={play}
          built={built}
          quiet={failed}
        >
          <Button
            variant="outline"
            icon={<FolderOpen aria-hidden />}
            onClick={showFiles}
            data-testid="easy-show-files"
          >
            {SHOW_FILES}
          </Button>
          <Button asChild variant="outline" data-testid="easy-show-details">
            <a href={href({ name: 'run', runId })}>
              <ExternalLink aria-hidden />
              {SHOW_DETAILS}
            </a>
          </Button>
        </OpenIt>
        {play && (
          <p className="h-5 truncate text-sm" title={controls ?? undefined} data-testid="easy-controls">
            <span className="font-medium">{CONTROLS_LABEL}: </span>
            {controls ?? CONTROLS_UNKNOWN}
          </p>
        )}
      </header>
      <Section title={play ? HOW_TO_PLAY : HOW_TO_USE} testId="easy-done-explain">
        {written && explain.status === 'ready' ? (
          <div data-testid="easy-explain-text">
            <LightMarkdown text={summary?.rest ?? explain.output.text} className="text-sm" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {written && explain.status === 'error' ? explain.message : HOW_TO_USE_NONE}
          </p>
        )}
      </Section>
      {fillIns.length > 0 && (
        <Section title={FILL_IN_TITLE} testId="easy-done-fill-ins">
          <p className="text-sm text-muted-foreground">{FILL_IN_NOTE}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="easy-fill-ins">
            {fillIns.map((l) => (
              <li key={l} className="break-words">
                {l}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={WHAT_IT_CAN_DO} testId="easy-done-can-do">
        {acceptance !== undefined && acceptance.items.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {acceptance.items.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-sm" data-status={i.status}>
                <span
                  className={
                    i.status === 'met'
                      ? 'w-20 shrink-0 font-medium text-st-done'
                      : i.status === 'not-met'
                        ? 'w-20 shrink-0 font-medium text-st-failed'
                        : 'w-20 shrink-0 font-medium text-muted-foreground'
                  }
                >
                  {ACCEPTANCE_WORD[i.status]}
                </span>
                <span className="min-w-0 break-words">{i.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{NO_CHECKLIST}</p>
        )}
      </Section>
      {easyNotes.length > 0 && (
        <Section title={EASY_CONTEXT_TITLE} testId="easy-done-context">
          <ul className="flex flex-col gap-1 text-sm" data-testid="easy-context-notes">
            {easyNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Section>
      )}
      {play && <EasyPlaytest runId={runId} snap={snap} />}
      {!play && isWebKind && <EasyTryIt runId={runId} onFix={setSeed} />}
      {looks && visual !== 'loading' && (
        <LookItOver runId={runId} folder={s.folder} state={visual} photos={photos} />
      )}
      {built && <EasyAsk runId={runId} />}
      <MakeChange snap={snap} focus={route.query['change'] === '1'} data={data} seed={seed} />
      <Remember runId={runId} folder={s.folder} />
      {built && (isWebKind || isDocument) && (
        <EasyShareCheck runId={runId} document={isDocument} onFix={setSeed} />
      )}
      <Section title={SHARE_TITLE} testId="easy-done-share">
        {photos && (
          <p className="text-sm font-medium" role="note" data-testid="easy-share-photos">
            {SHARE_PHOTOS}
          </p>
        )}
        {data && (
          <p className="text-sm font-medium" role="note" data-testid="easy-share-data">
            {SHARE_DATA}
          </p>
        )}
        <DeployPanel
          target={{ runId }}
          collapsible
          wording={{
            title: SHARE_TITLE,
            intro: `${SHARE_PUBLIC} ${play ? SHARE_PLAY_INTRO : SHARE_INTRO}`,
            show: SHARE_SHOW,
            hide: SHARE_HIDE,
          }}
        />
      </Section>
      <EasyHistory folderKey={s.folderKey} />
      {canFix && (
        <Section title={TRY_FIXING} testId="easy-done-fix">
          <p className="text-sm">{TRY_FIXING_TEXT}</p>
          <div>
            <Button
              variant="outline"
              icon={<Wrench aria-hidden />}
              loading={busy === 'fix'}
              disabled={busy !== null && busy !== 'fix'}
              onClick={tryFixing}
              data-testid="easy-try-fixing"
            >
              {TRY_FIXING}
            </Button>
          </div>
        </Section>
      )}
      {isolated && (
        <Section title={CHANGES_TITLE} testId="easy-done-changes">
          <ChangesLine snap={snap} ended />
        </Section>
      )}
      {!isolated && (
        <Section title={UNDO_EVERYTHING} testId="easy-done-undo">
          <p className="text-sm">{UNDO_EVERYTHING_TEXT}</p>
          <div>
            {noChanges || folderBusy !== undefined ? (
              <DisabledHint reason={noChanges ? NOTHING_TO_UNDO : (folderBusy ?? BUSY_FOLDER)}>
                <Button variant="outline" icon={<Undo2 aria-hidden />} disabled data-testid="easy-undo-all">
                  {UNDO_EVERYTHING}
                </Button>
              </DisabledHint>
            ) : (
              <Button
                variant="outline"
                icon={<Undo2 aria-hidden />}
                loading={busy === 'undo'}
                disabled={busy !== null && busy !== 'undo'}
                onClick={() => run('undo', () => revertAll(runId))}
                data-testid="easy-undo-all"
              >
                {UNDO_EVERYTHING}
              </Button>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}
