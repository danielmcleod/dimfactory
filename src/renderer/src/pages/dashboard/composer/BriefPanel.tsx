// The composer's Brief: what kind of work this is (the category, from core's packs), what the folder already says
// (locked facts), and the user's choices per group, each starting on "Let Dim Factory decide". Logic in
// brief-model.ts, core's answers and saving in useBrief.ts; this only draws them.
//
// Collapsed (the default) it is one line of fixed height: the disclosure, the category chip (one width), a slot for
// the Test-first tag (always reserved) and the summary ("3 choices · 2 from this repo"), with placeholders in the same
// places before core's detection answers, so its arrival changes words only. Opened (the user's action), the rows
// follow in the page's flow and never scroll inside: the category, "In this repo", one row per group, the actions
// line and a status line of fixed height. Until detection answers, the open panel keeps the height it had last time
// (useBriefHeight), so the rows arriving move nothing below (the Run row). Nothing that core answers later changes a
// chip's size: keyword and suggestion markers are outlines, an "Other" text takes a slot of fixed width, and the
// Suggest button keeps its label (its spinner takes the icon slot).
import { ChevronRight, Lock, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { BriefFact, PackGroup, PackOption } from '@shared/brief.ts'
import { APPROACH_GROUP, BRIEF_OTHER_MAX } from '@shared/brief.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import {
  DECIDE_LABEL,
  KEYWORD_TIP,
  NO_FACTS,
  NO_FOLDER_FACTS,
  OTHER_LABEL,
  PIPELINE_TAG,
  PLAN_TAG,
  SUGGESTED_TIP,
  choicesText,
  factTip,
  fieldOf,
  fromRepoText,
  locksOf,
  optionState,
  reasonOf,
} from './brief-model.ts'
import type { GroupLock, OptionState } from './brief-model.ts'
import type { BriefApi } from './useBrief.ts'

export const BRIEF_LABEL = 'Brief'
export const TEST_FIRST_TAG = 'Test-first'
export const SUGGEST_LABEL = 'Suggest choices'
export const SUGGESTING = 'Suggesting…'
const DETECTED = 'detected'

export interface BriefPanelProps {
  brief: BriefApi
  open: boolean
  onOpen: (open: boolean) => void
  /** The committed folder is a full path (facts and saving need one). */
  hasFolder: boolean
  /** The open panel's last measured height, reserved while detection is on its way. */
  reservedPx: number
  onMeasure?: (px: number) => void
}

// ---- chips ----------------------------------------------------------------------------------------------------------

const CHIP =
  'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full border px-2 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring'

function chipTone(on: boolean, muted = false): string {
  if (on) return 'border-primary/60 bg-primary/10 text-foreground'
  return muted
    ? 'border-dashed border-input text-muted-foreground'
    : 'border-input text-muted-foreground hover:bg-accent'
}

/** The marker a chip gets for where its value came from: an outline, so the chip keeps its size. */
function markerClass(source: OptionState['source']): string | false {
  if (source === 'keyword') return 'outline-1 outline-offset-1 outline-dotted outline-primary/70'
  if (source === 'suggested') return 'outline-1 outline-offset-1 outline-dashed outline-primary'
  return false
}

interface ChipProps {
  testId: string
  label: string
  on: boolean
  role: 'radio' | 'toggle'
  onClick?: () => void
  /** Shown on but fixed by a fact: focusable for its tooltip, not clickable. */
  locked?: boolean
  disabled?: boolean
  tip?: string | undefined
  /** What the marker means, for screen readers (aria-description). */
  description?: string | undefined
  marker?: OptionState['source']
  tag?: string | undefined
  source?: string
}

function Chip(p: ChipProps): React.JSX.Element {
  const inert = p.locked === true || p.disabled === true
  const state = p.role === 'radio' ? { role: 'radio', 'aria-checked': p.on } : { 'aria-pressed': p.on }
  const button = (
    <button
      type="button"
      data-testid={p.testId}
      data-on={p.on || undefined}
      data-source={p.source}
      aria-disabled={inert || undefined}
      {...state}
      {...(p.description !== undefined ? { 'aria-description': p.description } : {})}
      onClick={inert ? undefined : p.onClick}
      className={cn(
        CHIP,
        chipTone(p.on),
        markerClass(p.marker ?? null),
        inert && 'cursor-not-allowed',
        p.disabled === true && 'opacity-50',
      )}
    >
      {p.locked === true && <Lock aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">{p.label}</span>
      {p.tag !== undefined && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
          {p.tag}
        </span>
      )}
    </button>
  )
  return p.tip !== undefined && p.tip !== '' ? <Tooltip content={p.tip}>{button}</Tooltip> : button
}

function optionTag(groupId: string, o: PackOption): string | undefined {
  if (groupId !== APPROACH_GROUP || o.effect === undefined) return undefined
  return o.effect === 'pipeline' ? PIPELINE_TAG : PLAN_TAG
}

// ---- rows -----------------------------------------------------------------------------------------------------------

function Row({
  label,
  labelId,
  hint,
  children,
  testId,
}: {
  label: string
  labelId: string
  hint?: string | undefined
  children: React.ReactNode
  testId: string
}): React.JSX.Element {
  const text = (
    <span
      id={labelId}
      {...(hint !== undefined ? { tabIndex: 0 } : {})}
      className="w-28 shrink-0 truncate pt-1 text-xs font-medium text-muted-foreground"
    >
      {label}
    </span>
  )
  return (
    <div data-testid={testId} className="flex min-w-0 items-start gap-2">
      {hint !== undefined ? <Tooltip content={hint}>{text}</Tooltip> : text}
      {children}
    </div>
  )
}

/** The "Other" choice: a chip that opens a text box in the same slot (one width), so nothing else moves. */
function OtherSlot({
  group,
  text,
  on,
  marker,
  disabled,
  onCommit,
}: {
  group: PackGroup
  text: string | undefined
  on: boolean
  marker: OptionState['source']
  disabled: boolean
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text ?? '')
  const testId = `brief-other-${group.id}`
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== (text ?? '')) onCommit(draft)
  }
  return (
    <span className="inline-flex w-44 shrink-0" data-testid={`${testId}-slot`}>
      {editing ? (
        <input
          // The user opened it: focus follows their click.
          autoFocus
          data-testid={`${testId}-input`}
          aria-label={`${group.label}: other`}
          maxLength={BRIEF_OTHER_MAX}
          value={draft}
          placeholder="Say what"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(text ?? '')
              setEditing(false)
            }
          }}
          className="h-6 w-full min-w-0 rounded-full border border-primary/60 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <Chip
          testId={testId}
          label={on && text !== undefined ? `Other: ${text}` : OTHER_LABEL}
          on={on}
          role={group.multi ? 'toggle' : 'radio'}
          disabled={disabled}
          marker={marker}
          {...(on && text !== undefined ? { tip: text } : {})}
          onClick={() => {
            setDraft(text ?? '')
            setEditing(true)
          }}
        />
      )}
    </span>
  )
}

function GroupRow({
  brief,
  group,
  lock,
}: {
  brief: BriefApi
  group: PackGroup
  lock: GroupLock | undefined
}): React.JSX.Element | null {
  const labelId = useId()
  const pack = brief.pack?.pack
  if (pack === undefined) return null
  const field = fieldOf(brief.ctx, brief.draft, pack, group)
  const reason =
    field?.source === 'suggested' ? (reasonOf(brief.draft, pack.id, group.id) ?? SUGGESTED_TIP) : undefined
  const whole = lock?.whole === true
  const disabled = !brief.ready || whole
  const role = group.multi ? 'toggle' : 'radio'
  const markerTip = (source: OptionState['source']): string | undefined =>
    source === 'keyword' ? KEYWORD_TIP : source === 'suggested' ? reason : undefined
  const decideOn = field === undefined && !whole && (lock === undefined || lock.options.size === 0)
  const otherOn = field?.other !== undefined
  return (
    <Row label={group.label} labelId={labelId} hint={group.hint} testId={`brief-group-${group.id}`}>
      <div
        role={group.multi ? 'group' : 'radiogroup'}
        aria-labelledby={labelId}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
      >
        <Chip
          testId={`brief-decide-${group.id}`}
          label={DECIDE_LABEL}
          on={decideOn}
          role={role}
          disabled={disabled}
          onClick={() => brief.decide(group.id)}
        />
        {group.options.map((o) => {
          const st = optionState(field, lock, o.id)
          const lockFacts = st.locked ? lock?.facts.filter((f) => f.option === o.id) : undefined
          const lockTip =
            lockFacts !== undefined && lockFacts.length > 0 ? lockFacts.map(factTip).join('; ') : undefined
          const marker = markerTip(st.source)
          const tip = [lockTip ?? marker, o.hint].filter((s) => s !== undefined && s !== '').join(' · ')
          return (
            <Chip
              key={o.id}
              testId={`brief-option-${group.id}-${o.id}`}
              label={o.label}
              on={st.on}
              role={role}
              locked={st.locked}
              disabled={!st.locked && disabled}
              tip={tip}
              description={lockTip ?? marker}
              marker={st.source}
              {...(st.source !== null && st.source !== undefined ? { source: st.source } : {})}
              tag={optionTag(group.id, o)}
              onClick={() => brief.toggle(group.id, o.id)}
            />
          )
        })}
        {group.other && (
          <OtherSlot
            group={group}
            text={field?.other}
            on={otherOn}
            marker={otherOn ? (field?.source ?? null) : null}
            disabled={disabled}
            onCommit={(t) => brief.setOther(group.id, t)}
          />
        )}
      </div>
    </Row>
  )
}

function FactChip({ fact, locked }: { fact: BriefFact; locked: boolean }): React.JSX.Element {
  const tip = factTip(fact)
  return (
    <Tooltip content={tip}>
      <span
        tabIndex={0}
        data-testid={`brief-fact-${fact.group}${fact.option !== undefined ? `-${fact.option}` : ''}`}
        data-locked={locked || undefined}
        aria-description={tip}
        className={cn(
          CHIP,
          locked ? 'border-input text-foreground' : 'border-dashed border-input text-muted-foreground',
        )}
      >
        {locked && <Lock aria-hidden className="size-3 shrink-0" />}
        <span className="truncate">{fact.label}</span>
      </span>
    </Tooltip>
  )
}

// ---- the panel ------------------------------------------------------------------------------------------------------

function Toggle({
  open,
  onOpen,
  panelId,
}: {
  open: boolean
  onOpen: (open: boolean) => void
  panelId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="brief-toggle"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => onOpen(!open)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md py-0.5 pr-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      {BRIEF_LABEL}
    </button>
  )
}

/** The one-line summary (always this line, before and after detection). */
function SummaryLine({
  brief,
  open,
  onOpen,
  panelId,
}: {
  brief: BriefApi
  open: boolean
  onOpen: (open: boolean) => void
  panelId: string
}): React.JSX.Element {
  const { pack, ctx, summary } = brief
  const fromDetection =
    brief.draft.category === null &&
    ctx !== null &&
    ctx.category.source !== 'default' &&
    pack?.pack.id === brief.detected
  const category =
    pack !== undefined ? pack.pack.label : brief.status === 'error' ? 'Not available' : 'Detecting…'
  const text =
    brief.status === 'error'
      ? (brief.error ?? 'The Brief is not available')
      : !brief.ready
        ? 'Reading this folder…'
        : [
            choicesText(summary.choices),
            ...(summary.fromRepo > 0 ? [fromRepoText(summary.fromRepo)] : []),
          ].join(' · ')
  return (
    <div data-testid="brief-line" className="flex h-6 min-w-0 items-center gap-2">
      <Toggle open={open} onOpen={onOpen} panelId={panelId} />
      <span
        data-testid="brief-category"
        data-pending={!brief.ready || undefined}
        className="inline-flex h-5 w-44 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs"
      >
        <span className={cn('min-w-0 truncate', !brief.ready && 'text-muted-foreground')}>{category}</span>
        <span
          data-testid="brief-category-detected"
          aria-hidden={!fromDetection || undefined}
          className={cn('shrink-0 text-[10px] text-muted-foreground', !fromDetection && 'invisible')}
        >
          {DETECTED}
        </span>
      </span>
      {/* Always reserved, shown when the brief chooses Test-first. */}
      <span
        data-testid="brief-test-first"
        aria-hidden={!summary.testFirst || undefined}
        className={cn(
          'inline-flex h-5 shrink-0 items-center rounded-md bg-primary/10 px-1.5 text-[10px] font-medium text-primary',
          !summary.testFirst && 'invisible',
        )}
      >
        {TEST_FIRST_TAG}
      </span>
      <span
        data-testid="brief-summary"
        title={text}
        className={cn(
          'min-w-0 flex-1 truncate text-xs tabular-nums',
          brief.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {text}
      </span>
    </div>
  )
}

function Actions({ brief }: { brief: BriefApi }): React.JSX.Element {
  const s = brief.suggest
  const busy = s.state.status === 'busy'
  const suggest = (
    <Button
      size="sm"
      variant="outline"
      data-testid="brief-suggest"
      icon={<Sparkles aria-hidden />}
      loading={busy}
      disabled={s.disabledReason !== null}
      aria-describedby="brief-suggest-hint"
      onClick={s.run}
    >
      {SUGGEST_LABEL}
    </Button>
  )
  const reset = (
    <Button
      size="sm"
      variant="ghost"
      data-testid="brief-reset"
      icon={<RotateCcw aria-hidden />}
      disabled={brief.reset.disabledReason !== null}
      onClick={brief.reset.run}
    >
      Reset
    </Button>
  )
  return (
    <div data-testid="brief-actions" className="flex h-7 min-w-0 items-center gap-2">
      {s.disabledReason !== null && !busy ? (
        <DisabledHint reason={s.disabledReason}>{suggest}</DisabledHint>
      ) : (
        suggest
      )}
      <span
        id="brief-suggest-hint"
        data-testid="brief-suggest-hint"
        title={s.hint}
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >
        {s.hint}
      </span>
      {brief.reset.disabledReason !== null ? (
        <DisabledHint reason={brief.reset.disabledReason}>{reset}</DisabledHint>
      ) : (
        reset
      )}
    </div>
  )
}

function SuggestStatus({ brief }: { brief: BriefApi }): React.JSX.Element {
  const st = brief.suggest.state
  const text = st.status === 'busy' ? SUGGESTING : st.status === 'idle' ? '' : st.text
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="brief-suggest-status"
      title={text !== '' ? text : undefined}
      className={cn(
        'h-5 truncate text-xs',
        st.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {text}
    </p>
  )
}

export function BriefPanel({
  brief,
  open,
  onOpen,
  hasFolder,
  reservedPx,
  onMeasure,
}: BriefPanelProps): React.JSX.Element {
  const panelId = useId()
  const categoryLabelId = useId()
  const factsLabelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const pack = brief.pack?.pack
  const locks = locksOf(brief.ctx, pack)
  const facts = [...locks.locked, ...locks.info]
  const measuring = open && brief.ready

  // The open panel's height once its rows are in: what it reserves next time while detection is on its way.
  useEffect(() => {
    const el = root.current
    if (!measuring || el === null || onMeasure === undefined) return
    const measure = (): void => {
      const h = el.getBoundingClientRect().height
      if (h > 0) onMeasure(h)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measuring, onMeasure])

  return (
    <div data-testid="brief" className="flex flex-col gap-1.5">
      <SummaryLine brief={brief} open={open} onOpen={onOpen} panelId={panelId} />
      {open && (
        <div
          id={panelId}
          ref={root}
          data-testid="brief-panel"
          aria-busy={!brief.ready || undefined}
          style={!brief.ready && brief.status !== 'error' ? { minHeight: reservedPx } : undefined}
          className="flex flex-col gap-2 border-l pl-3"
        >
          {brief.ready && brief.ctx !== null && pack !== undefined ? (
            <>
              <Row label="Category" labelId={categoryLabelId} testId="brief-categories">
                <div
                  role="radiogroup"
                  aria-labelledby={categoryLabelId}
                  className="flex min-w-0 flex-1 flex-wrap gap-1.5"
                >
                  {brief.ctx.packs.map((p) => {
                    const detected = p.pack.id === brief.detected && brief.ctx?.category.source !== 'default'
                    return (
                      <Chip
                        key={p.pack.id}
                        testId={`brief-category-${p.pack.id}`}
                        label={p.pack.label}
                        on={p.pack.id === brief.category}
                        role="radio"
                        tip={[
                          detected && brief.ctx?.category.id === p.pack.id ? brief.ctx.category.reason : '',
                          p.pack.description,
                        ]
                          .filter((s) => s !== '')
                          .join(' · ')}
                        tag={detected ? DETECTED : undefined}
                        onClick={() => brief.setCategory(p.pack.id)}
                      />
                    )
                  })}
                </div>
              </Row>
              <Row label="In this repo" labelId={factsLabelId} testId="brief-facts">
                {facts.length > 0 ? (
                  <ul aria-labelledby={factsLabelId} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {facts.map((f, i) => (
                      <li key={`${i}:${f.group}:${f.option ?? f.label}`} className="contents">
                        <FactChip fact={f} locked={locks.byGroup.has(f.group)} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p
                    data-testid="brief-no-facts"
                    className="flex h-6 items-center text-xs text-muted-foreground"
                  >
                    {hasFolder ? NO_FACTS : NO_FOLDER_FACTS}
                  </p>
                )}
              </Row>
              {pack.groups.map((g) => (
                <GroupRow key={g.id} brief={brief} group={g} lock={locks.byGroup.get(g.id)} />
              ))}
              <Actions brief={brief} />
              <SuggestStatus brief={brief} />
            </>
          ) : (
            <p className="flex h-6 items-center text-xs text-muted-foreground" data-testid="brief-pending">
              {brief.status === 'error'
                ? (brief.error ?? 'The Brief is not available')
                : 'Reading this folder…'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
