// The Deploy helper: what the folder ships as (core's local classification, with a picker when it is wrong), where it
// could go (each option's trade-offs, always under the cost caveat), the pre-flight checklist (what core checked, and
// the items only the user can tick, which read "Not checked" until then), and the chosen option's steps as commands to
// copy. Nothing here deploys, signs in or stores a token. On a finished run it sits in "After the run" (collapsed until
// the user opens it: nothing is read until then); on demand it is the Deploy page's body. Easy mode's Done screen shows
// it folded under its own words ("Share it": putting it online makes it public), passed as `wording`. For a static
// class, Drag and drop offers "Make an upload file" (UploadFile.tsx): a zip made on this computer, never uploaded.
// UI standards: buttons keep their size (Deploy/Hide reserve both labels); the option list keeps its rows when the
// choice changes (only the steps below it change); nothing appears above what the user is looking at on its own.
import { Copy, RefreshCw, Rocket } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeployClass, DeployCheckItem, DeployReport, DeployRunView } from '@shared/deploy.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { href } from '../../lib/router.ts'
import { toast } from '../../state/toasts.ts'
import { Button } from '../ui/Button.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { copyText, useBusy } from '../run/commands.ts'
import { UploadFile } from './UploadFile.tsx'
import {
  CLASS_PICK_LABEL,
  DEPLOY_INTRO,
  DEPLOY_TITLE,
  HIDE_LABEL,
  INSPECTING_TEXT,
  RECOMMENDED_LABEL,
  SHOW_LABEL,
  TICK_LABEL,
  checkStateText,
  classLine,
  deployStepLine,
} from './text.ts'

export interface DeployTargetProps {
  folder?: string
  runId?: string
}

interface ReportState {
  report: DeployReport | null
  error: string | null
  loading: boolean
}

function useDeployReport(
  target: DeployTargetProps,
  cls: DeployClass | undefined,
  enabled: boolean,
): ReportState & { reload: () => void; setReport: (r: DeployReport) => void } {
  const [state, setState] = useState<ReportState>({ report: null, error: null, loading: false })
  const [nonce, setNonce] = useState(0)
  const key = `${target.runId ?? ''}\u0000${target.folder ?? ''}\u0000${cls ?? ''}`
  const req = useRef(target)
  req.current = target
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    void invoke('deploy.inspect', { ...req.current, ...(cls !== undefined ? { cls } : {}) }).then((r) => {
      if (!alive) return
      if (r.ok) setState({ report: r.value, error: null, loading: false })
      else setState((s) => ({ report: s.report, error: r.error.message, loading: false }))
    })
    return () => {
      alive = false
    }
  }, [key, nonce, enabled, cls])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setReport = useCallback((r: DeployReport) => setState((s) => ({ ...s, report: r })), [])
  return { ...state, reload, setReport }
}

const STATE_CLASS: Readonly<Record<DeployCheckItem['state'], string>> = {
  ok: 'text-st-done',
  warn: 'text-warning',
  problem: 'text-destructive',
  'not-checked': 'text-muted-foreground',
}

function CheckRow({
  item,
  busy,
  onTick,
}: {
  item: DeployCheckItem
  busy: boolean
  onTick: (ticked: boolean) => void
}): React.JSX.Element {
  const ticked = item.tickedAt !== undefined
  return (
    <li
      data-testid={`deploy-check-${item.id}`}
      data-state={item.state}
      data-ticked={ticked ? 'true' : 'false'}
      className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border px-3 py-2"
    >
      <span
        className={cn(
          'w-24 shrink-0 text-xs font-medium',
          !item.auto && ticked ? 'text-foreground' : STATE_CLASS[item.state],
        )}
        data-testid={`deploy-check-${item.id}-state`}
      >
        {checkStateText(item)}
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium">{item.label}</p>
        <p className="text-xs text-muted-foreground">{item.detail}</p>
        {(item.evidence ?? []).length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs break-all">
            {(item.evidence ?? []).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>
      {!item.auto && (
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={ticked}
            disabled={busy}
            aria-label={`${TICK_LABEL}: ${item.label}`}
            data-testid={`deploy-tick-${item.id}`}
            onCheckedChange={(v) => onTick(v === true)}
          />
          {TICK_LABEL}
        </label>
      )}
    </li>
  )
}

function StepList({
  report,
  optionId,
}: {
  report: DeployReport
  optionId: string
}): React.JSX.Element | null {
  const [busy, run] = useBusy()
  const o = report.options.find((x) => x.id === optionId)
  if (o === undefined) return null
  return (
    <section aria-label={`Steps for ${o.label}`} data-testid="deploy-steps" className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">Steps for {o.label}</h4>
      <p className="text-xs text-muted-foreground" data-testid="deploy-commands-caveat">
        {report.caveats.commands}
        {o.needs !== undefined ? ` Needs ${o.needs}.` : ''}
      </p>
      <ol className="flex flex-col gap-2">
        {o.steps.map((s, i) => (
          <li key={s.id} data-testid={`deploy-step-${s.id}`} className="flex flex-col gap-1">
            <p className="text-sm">
              {i + 1}. {s.label}
            </p>
            {s.command !== undefined && (
              <div className="flex items-start gap-2">
                <code
                  data-testid="deploy-step-command"
                  className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs wrap-anywhere select-all"
                >
                  {s.command}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Copy: ${s.command}`}
                  data-testid={`deploy-step-copy-${s.id}`}
                  icon={<Copy aria-hidden />}
                  loading={busy === s.id}
                  disabled={busy !== null && busy !== s.id}
                  onClick={() => run(s.id, () => copyText(s.command ?? '', 'Command'))}
                >
                  Copy
                </Button>
              </div>
            )}
            {s.note !== undefined && <p className="text-xs text-muted-foreground">{s.note}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Options({
  report,
  chosen,
  onChoose,
}: {
  report: DeployReport
  chosen: string
  onChoose: (id: string) => void
}): React.JSX.Element {
  return (
    <section aria-label="Where it could go" data-testid="deploy-options" className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">Where it could go</h4>
      <ul role="radiogroup" aria-label="Deploy target" className="flex flex-col gap-2">
        {report.options.map((o) => {
          const on = o.id === chosen
          return (
            <li
              key={o.id}
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-testid={`deploy-option-${o.id}`}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on && 'border-primary',
              )}
              onClick={() => onChoose(o.id)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  onChoose(o.id)
                }
              }}
            >
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{o.label}</span>
                {o.recommended && <span className="text-xs text-muted-foreground">{RECOMMENDED_LABEL}</span>}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Free tier</dt>
                <dd>{o.freeTier}</dd>
                <dt className="text-muted-foreground">Cost</dt>
                <dd>{o.cost}</dd>
                <dt className="text-muted-foreground">Cold starts</dt>
                <dd>{o.coldStarts}</dd>
                <dt className="text-muted-foreground">Custom domains</dt>
                <dd>{o.customDomains}</dd>
                <dt className="text-muted-foreground">Data residency</dt>
                <dd>{o.dataResidency}</dd>
                {o.configs.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Config</dt>
                    <dd>
                      {o.configs.map((c, i) => (
                        <span key={c.kind}>
                          {i > 0 ? ', ' : ''}
                          <code className="font-mono">{c.path}</code> {c.present ? '(there)' : '(missing)'}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid="deploy-cost-caveat">
        {report.caveats.cost}
      </p>
    </section>
  )
}

/** The folded panel's own words (Easy mode's "Share it"); absent: the Deploy helper's. */
export interface DeployWording {
  title: string
  intro: string
  show: string
  hide: string
}

export interface DeployPanelProps {
  target: DeployTargetProps
  /** In "After the run": a row with [Deploy] that opens the panel (nothing is read until then). */
  collapsible?: boolean
  /** The run's Deploy step, when it had one. */
  step?: DeployRunView | undefined
  className?: string
  wording?: DeployWording
}

export function DeployPanel({
  target,
  collapsible = false,
  step,
  className,
  wording,
}: DeployPanelProps): React.JSX.Element {
  const words = wording ?? { title: DEPLOY_TITLE, intro: DEPLOY_INTRO, show: SHOW_LABEL, hide: HIDE_LABEL }
  const [open, setOpen] = useState(!collapsible)
  const [cls, setCls] = useState<DeployClass | undefined>(undefined)
  const { report, error, loading, reload, setReport } = useDeployReport(target, cls, open)
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const choice =
    chosen !== null && report?.options.some((o) => o.id === chosen) === true ? chosen : report?.target
  const stepLine = deployStepLine(step)

  const tick = (item: DeployCheckItem, ticked: boolean): void =>
    run(`tick:${item.id}`, async () => {
      const r = await invoke('deploy.tick', { ...target, item: item.id, ticked })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      if (report === null) return
      setReport({
        ...report,
        checklist: report.checklist.map((x) => {
          if (x.id !== item.id) return x
          const at = r.value.ticks[x.id]
          const { tickedAt: _t, ...rest } = x
          return at !== undefined ? { ...rest, tickedAt: at } : rest
        }),
      })
    })

  const body = (
    <div className="flex flex-col gap-4" data-testid="deploy-body">
      {stepLine !== null && (
        <p className="text-sm" data-testid="deploy-step-line">
          {stepLine}
          {target.runId !== undefined && step?.written !== undefined && step.written.length > 0 && (
            <>
              {' '}
              <a className="underline" href={href({ name: 'run', runId: target.runId, tab: 'diff' })}>
                Open the Diff tab
              </a>
            </>
          )}
        </p>
      )}
      {report === null ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="deploy-status-line">
          {error !== null ? `Dim Factory could not look at the folder: ${error}` : INSPECTING_TEXT}
        </p>
      ) : (
        <>
          <section aria-label="What it ships as" data-testid="deploy-class" className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase">What it ships as</h4>
            <p className="text-sm" data-testid="deploy-class-line" data-class={report.cls.id}>
              {classLine(report.cls)}
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {report.cls.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground" id="deploy-class-pick">
                {CLASS_PICK_LABEL}
              </span>
              <Select value={report.cls.id} onValueChange={(v) => setCls(v as DeployClass)}>
                <SelectTrigger
                  size="sm"
                  className="w-48"
                  aria-labelledby="deploy-class-pick"
                  data-testid="deploy-class-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {report.classes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>
          {report.upload !== undefined && (
            <UploadFile target={target} upload={report.upload} cls={cls} onBuilt={reload} />
          )}
          {report.options.length > 0 && choice !== undefined && choice !== null ? (
            <>
              <Options report={report} chosen={choice} onChoose={setChosen} />
              <StepList report={report} optionId={choice} />
            </>
          ) : (
            <p className="text-sm" data-testid="deploy-no-options">
              No deploy target is offered for a {report.cls.label.toLowerCase()} yet.
            </p>
          )}
          <section
            aria-label="Pre-flight checklist"
            data-testid="deploy-checklist"
            className="flex flex-col gap-2"
          >
            <h4 className="text-xs font-semibold text-muted-foreground uppercase">Pre-flight checklist</h4>
            <ul className="flex flex-col gap-2">
              {report.checklist.map((item) => (
                <CheckRow key={item.id} item={item} busy={busy !== null} onTick={(v) => tick(item, v)} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground" data-testid="deploy-security-caveat">
              {report.caveats.security}
            </p>
            {report.notes.map((n, i) => (
              <p key={i} className="text-xs text-muted-foreground" data-testid="deploy-note">
                {n}
              </p>
            ))}
          </section>
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw aria-hidden />}
              loading={loading}
              data-testid="deploy-refresh"
              onClick={reload}
            >
              Look again
            </Button>
          </div>
        </>
      )}
    </div>
  )

  if (!collapsible) {
    return (
      <div className={cn('flex flex-col gap-3', className)} data-testid="deploy">
        {body}
      </div>
    )
  }
  return (
    <section aria-label={words.title} data-testid="deploy" className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-sm" data-testid="deploy-intro">
          {words.intro}
        </p>
        <Button
          size="sm"
          variant="outline"
          labels={[words.show, words.hide]}
          icon={<Rocket aria-hidden />}
          aria-expanded={open}
          data-testid="deploy-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? words.hide : words.show}
        </Button>
      </div>
      {open && body}
    </section>
  )
}
