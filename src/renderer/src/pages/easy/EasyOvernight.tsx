// Easy mode's overnight list, "Make several things overnight": an Easy view of the factory's queue. Each idea added
// becomes a new project right away (its folder, its Brief, the project permission only when ticked for that idea) and
// one task on its own queue; the list is made one after another, from Start now or every day at a time the user sets
// (the factory's schedule, which never carries on by itself after the app was closed: a notice asks). While nobody is
// watching there are no questions, plan checks or looks at similar things; asks still wait, and no answer is a no.
// Budgets apply only when the user set them (Easy settings). The words say all this plainly.
// Each idea shows about what it may cost and take, and what to know before it is made (a report with no data file, a
// game made without looking at similar games, a vague idea); the list's total is under its heading.
// UI standards: one scroll region (the page); the list grows only when the user adds or removes an idea; a row's height
// is set when it is added (its warnings never change); the state line keeps its height; buttons keep their labels (Start now and Pause share one width).
import { CirclePlus, Clock, Pause, Play } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { EASY_IDEA_MAX, EASY_KINDS } from '@shared/easy.ts'
import type { EasyKind, EasyQueueView } from '@shared/easy.ts'
import type { Result } from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { navigate } from '../../lib/router.ts'
import { useEasyState } from '../../state/experience.ts'
import { useQueueStore } from '../../state/queue.ts'
import { toast } from '../../state/toasts.ts'
import { useBusy } from '../../components/run/commands.ts'
import { KIND_ICON } from './EasyHome.tsx'
import {
  CONSENT_CHECK,
  CONSENT_NOTE,
  KIND_LABEL,
  KIND_TEXT,
  OVERNIGHT_ADD,
  OVERNIGHT_ADD_DISABLED,
  OVERNIGHT_AWAY,
  OVERNIGHT_CARRY_ON,
  OVERNIGHT_EMPTY,
  OVERNIGHT_FINISHED,
  OVERNIGHT_IDEA_LABEL,
  OVERNIGHT_IDEA_PLACEHOLDER,
  OVERNIGHT_INTRO,
  OVERNIGHT_ITEM_LABELS,
  OVERNIGHT_ITEM_STATUS,
  OVERNIGHT_LIST_TITLE,
  OVERNIGHT_LOADING,
  OVERNIGHT_NO_SCHEDULE,
  OVERNIGHT_NOT_NOW,
  OVERNIGHT_NOTHING_TO_START,
  OVERNIGHT_OPEN,
  OVERNIGHT_PAUSE,
  OVERNIGHT_REMOVE,
  OVERNIGHT_RUN_LABELS,
  OVERNIGHT_SET_TIME,
  OVERNIGHT_START_NOW,
  OVERNIGHT_STATE,
  OVERNIGHT_TIME_INVALID,
  OVERNIGHT_TIME_LABEL,
  OVERNIGHT_TIME_PLACEHOLDER,
  OVERNIGHT_TITLE,
  WORDS_KIND,
  overnightEstimateText,
  overnightLimitText,
  overnightScheduleText,
  overnightTotalText,
  overnightWarningText,
} from './text.ts'

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** The ideas still to make, added up: the most it may cost and take (null: nothing waits). */
function listTotal(
  view: EasyQueueView | null,
): { usd: number | null; minutes: number; unknown: number } | null {
  const waiting = (view?.items ?? []).filter((i) => i.status === 'pending')
  if (waiting.length === 0) return null
  let usd: number | null = 0
  let minutes = 0
  let unknown = 0
  for (const i of waiting) {
    if (i.estimate === undefined) {
      unknown++
      continue
    }
    minutes += Math.max(1, Math.round(i.estimate.durationMs.p80 / 60_000))
    if (i.estimate.costUsd === null) usd = null
    else if (usd !== null) usd += Math.max(i.estimate.costUsd.p50, i.estimate.costUsd.p80)
  }
  return unknown === waiting.length ? null : { usd, minutes, unknown }
}

/** Core's overnight list, asked again whenever the factory's queues change. */
function useOvernight(): [EasyQueueView | null, (v: EasyQueueView) => void] {
  const version = useQueueStore((s) => s.version)
  const [v, setV] = useState<EasyQueueView | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('easy.queue').then((r) => {
      if (alive && r.ok) setV(r.value)
    })
    return () => {
      alive = false
    }
  }, [version])
  return [v, setV]
}

function AddIdea({ onAdded }: { onAdded: (v: EasyQueueView) => void }): React.JSX.Element {
  const settings = useEasyState()?.settings
  const [idea, setIdea] = useState('')
  const [kind, setKind] = useState<EasyKind | 'words'>('words')
  const [consent, setConsent] = useState(false)
  const [busy, run] = useBusy()
  const ideaId = useId()
  const kindId = useId()
  const consentId = useId()
  const add = (): void =>
    run('add', async () => {
      const text = idea.trim()
      if (text === '') return
      let k: EasyKind
      const guessed = kind === 'words'
      if (kind === 'words') {
        // Decided locally from the words, as the confirm screen does (no tokens).
        const r = await invoke('easy.resolve', { idea: text })
        if (!r.ok) {
          toast({ level: 'error', message: r.error.message })
          return
        }
        k = r.value.kind
      } else k = kind
      const r = await invoke('easy.queueAdd', {
        ideas: [{ idea: text, kind: k, consent, ...(guessed ? { guessed: true } : {}) }],
        limits: { maxCostUsd: settings?.maxCostUsd ?? null, maxMinutes: settings?.maxMinutes ?? null },
      })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      setIdea('')
      setKind('words')
      setConsent(false)
      onAdded(r.value)
    })
  const empty = idea.trim() === ''
  const button = (
    <Button
      icon={<CirclePlus aria-hidden />}
      loading={busy === 'add'}
      disabled={empty}
      onClick={add}
      data-testid="easy-overnight-add"
    >
      {OVERNIGHT_ADD}
    </Button>
  )
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-testid="easy-overnight-form">
      <label htmlFor={ideaId} className="text-sm font-semibold">
        {OVERNIGHT_IDEA_LABEL}
      </label>
      <Textarea
        id={ideaId}
        data-testid="easy-overnight-idea"
        rows={2}
        maxLength={EASY_IDEA_MAX}
        className="h-16 resize-none"
        placeholder={OVERNIGHT_IDEA_PLACEHOLDER}
        value={idea}
        onChange={(e) => setIdea(e.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={kindId} className="text-sm">
          {KIND_LABEL}
        </label>
        <div className="w-56">
          <Select value={kind} onValueChange={(v) => setKind(v as EasyKind | 'words')}>
            <SelectTrigger id={kindId} data-testid="easy-overnight-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="words">{WORDS_KIND}</SelectItem>
              {EASY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_TEXT[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={consentId}
          data-testid="easy-overnight-consent"
          className="mt-0.5"
          checked={consent}
          onCheckedChange={(v) => setConsent(v === true)}
        />
        <label htmlFor={consentId} className="text-sm">
          {CONSENT_CHECK}
          <span className="block text-xs text-muted-foreground">{CONSENT_NOTE}</span>
        </label>
      </div>
      <div>{empty ? <DisabledHint reason={OVERNIGHT_ADD_DISABLED}>{button}</DisabledHint> : button}</div>
    </section>
  )
}

export function EasyOvernightPage(): React.JSX.Element {
  const [view, setView] = useOvernight()
  const settings = useEasyState()?.settings
  const [busy, run] = useBusy()
  const [time, setTime] = useState('')
  const listId = useId()
  const timeId = useId()
  useEffect(() => {
    if (view !== null && time === '' && view.schedule.enabled) setTime(view.schedule.start)
  }, [view, time])

  const call = (key: string, f: () => Promise<Result<EasyQueueView>>): void =>
    run(key, async () => {
      const r = await f()
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      setView(r.value)
    })

  const pending = view?.items.some((i) => i.status === 'pending') === true
  // Every idea on the list has had its turn (none waits, none is being made).
  const finished =
    view !== null &&
    view.items.length > 0 &&
    view.items.every((i) => i.status === 'done' || i.status === 'failed' || i.status === 'stopped')
  const running = view?.state === 'running'
  const total = listTotal(view)
  const timeOk = CLOCK.test(time.trim())
  const runButton = (
    <Button
      labels={OVERNIGHT_RUN_LABELS}
      icon={running ? <Pause aria-hidden /> : <Play aria-hidden />}
      loading={busy === 'run'}
      disabled={!running && !pending}
      data-testid="easy-overnight-run"
      onClick={() => call('run', () => (running ? invoke('easy.queuePause') : invoke('easy.queueStart', {})))}
    >
      {running ? OVERNIGHT_PAUSE : OVERNIGHT_START_NOW}
    </Button>
  )
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8" data-testid="easy-overnight">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{OVERNIGHT_TITLE}</h1>
        <p className="text-sm">{OVERNIGHT_INTRO}</p>
        <p className="text-sm text-muted-foreground">{OVERNIGHT_AWAY}</p>
        <p className="text-sm text-muted-foreground" data-testid="easy-overnight-limit">
          {overnightLimitText(settings?.maxCostUsd ?? null)}
        </p>
      </header>
      {view?.notice !== undefined && (
        <section
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-st-waiting/50 bg-card p-4"
          data-testid="easy-overnight-notice"
        >
          <p className="text-sm">{view.notice.text}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy === 'notice'}
              data-testid="easy-overnight-carry-on"
              onClick={() =>
                call('notice', () => invoke('easy.queueStart', { noticeId: view.notice?.id ?? '' }))
              }
            >
              {OVERNIGHT_CARRY_ON}
            </Button>
            <Button
              variant="outline"
              data-testid="easy-overnight-not-now"
              onClick={() =>
                run('dismiss', async () => {
                  await invoke('queue.dismissNotice', { id: view.notice?.id ?? '' })
                  const r = await invoke('easy.queue')
                  if (r.ok) setView(r.value)
                })
              }
            >
              {OVERNIGHT_NOT_NOW}
            </Button>
          </div>
        </section>
      )}
      <AddIdea onAdded={setView} />
      <section aria-labelledby={listId} className="flex flex-col gap-3" data-testid="easy-overnight-list">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={listId} className="min-w-0 flex-1 text-base font-semibold">
            {OVERNIGHT_LIST_TITLE}
          </h2>
          {!running && !pending ? (
            <DisabledHint reason={OVERNIGHT_NOTHING_TO_START}>{runButton}</DisabledHint>
          ) : (
            runButton
          )}
        </div>
        <p className="min-h-5 text-sm text-muted-foreground" role="status" data-testid="easy-overnight-state">
          {view === null
            ? OVERNIGHT_LOADING
            : view.state === 'paused' && view.pause !== undefined
              ? `${OVERNIGHT_STATE.paused} ${view.pause}`
              : view.state === 'idle' && finished
                ? OVERNIGHT_FINISHED
                : OVERNIGHT_STATE[view.state]}
        </p>
        <p className="min-h-5 text-sm text-muted-foreground" data-testid="easy-overnight-total">
          {total !== null ? overnightTotalText(total.usd, total.minutes, total.unknown) : ''}
        </p>
        {view !== null && view.items.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="easy-overnight-empty">
            {OVERNIGHT_EMPTY}
          </p>
        )}
        {view !== null && view.items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {view.items.map((i) => {
              const Icon = i.kind !== undefined ? KIND_ICON[i.kind] : CirclePlus
              const removable = i.status !== 'running' && i.status !== 'waiting' && i.runId === undefined
              return (
                <li
                  key={i.folder}
                  data-testid="easy-overnight-item"
                  data-status={i.status}
                  className="flex min-h-16 items-center gap-3 rounded-md border px-3 py-2"
                >
                  <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={i.folder}>
                      {i.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={i.reason}>
                      {i.kind !== undefined ? `${KIND_TEXT[i.kind]} · ` : ''}
                      {OVERNIGHT_ITEM_STATUS[i.status] ?? i.status}
                      {i.reason !== undefined ? ` · ${i.reason}` : ''}
                      {i.estimate !== undefined
                        ? ` · ${overnightEstimateText(i.estimate.durationMs, i.estimate.costUsd)}`
                        : ''}
                    </span>
                    {(i.warnings ?? []).map((w) => (
                      <span
                        key={w.kind}
                        className="text-xs text-warning"
                        role="note"
                        data-testid="easy-overnight-warning"
                        data-warning={w.kind}
                      >
                        {overnightWarningText(w.kind, w.kind === 'vague' ? w.candidates : [], i.kind)}
                      </span>
                    ))}
                  </div>
                  {i.runId !== undefined ? (
                    <Button
                      size="sm"
                      variant="outline"
                      labels={OVERNIGHT_ITEM_LABELS}
                      data-testid="easy-overnight-open"
                      onClick={() => navigate({ name: 'easyRun', runId: i.runId ?? '' })}
                    >
                      {OVERNIGHT_OPEN}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      labels={OVERNIGHT_ITEM_LABELS}
                      disabled={!removable || busy !== null}
                      data-testid="easy-overnight-remove"
                      onClick={() =>
                        call(`remove:${i.folder}`, () => invoke('easy.queueRemove', { folder: i.folder }))
                      }
                    >
                      {OVERNIGHT_REMOVE}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2 border-t pt-4" data-testid="easy-overnight-schedule">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={timeId} className="text-sm">
            {OVERNIGHT_TIME_LABEL}
          </label>
          <Input
            id={timeId}
            data-testid="easy-overnight-time"
            inputMode="numeric"
            className="h-8 w-24"
            placeholder={OVERNIGHT_TIME_PLACEHOLDER}
            aria-invalid={time.trim() !== '' && !timeOk ? true : undefined}
            value={time}
            onChange={(e) => setTime(e.currentTarget.value)}
          />
          <Button
            size="sm"
            variant="outline"
            icon={<Clock aria-hidden />}
            loading={busy === 'time'}
            disabled={!timeOk}
            data-testid="easy-overnight-set-time"
            onClick={() => call('time', () => invoke('easy.queueStart', { at: time.trim() }))}
          >
            {OVERNIGHT_SET_TIME}
          </Button>
        </div>
        <p className="min-h-5 text-sm text-muted-foreground" data-testid="easy-overnight-when">
          {time.trim() !== '' && !timeOk
            ? OVERNIGHT_TIME_INVALID
            : view?.schedule.enabled === true
              ? overnightScheduleText(view.schedule.start)
              : OVERNIGHT_NO_SCHEDULE}
        </p>
      </section>
    </div>
  )
}
