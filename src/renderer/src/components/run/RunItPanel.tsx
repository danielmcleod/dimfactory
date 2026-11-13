// "Run it" (Run & Preview): how a folder can be run, from core's token-free detection (preview.detect), with
// [Trust] and [Start]/[Stop] per command, the running preview's status and newest output, [Open preview] (Dim Factory's
// sandboxed preview window) and [Open in browser] as Settings → Preview says, the smoke check and its result, the
// non-blocking tool checks, and the folder's RUN.md. On a finished run it sits in "After the run" (collapsed until the
// user opens it: nothing is detected, and nothing starts, on its own); on demand it is the Run it page's body.
// UI standards: no button changes size (Start/Stop and Trust/Trusted reserve their widest label); the output is a
// fixed-height box of its newest lines that never scrolls (the page keeps its one scroll region) and has its full
// height from the moment a preview exists, so nothing below it moves as lines arrive.
import {
  AlertTriangle,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Stethoscope,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewTarget } from '@shared/ipc.ts'
import type {
  PreviewCommand,
  PreviewInfo,
  PreviewKind,
  PreviewOpenTarget,
  PreviewSessionView,
  PreviewSmokeView,
} from '@shared/preview.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import {
  setPreviewSmoke,
  upsertPreviewSessions,
  usePreviewSessions,
  usePreviewSmoke,
} from '../../state/previews.ts'
import { toast } from '../../state/toasts.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { useBusy } from './commands.ts'
import { LightMarkdown } from './LightMarkdown.tsx'
import {
  GameChecksList,
  NetworkRow,
  PhoneSizeToggle,
  PlaytestButton,
  PlaytestResult,
} from './GamePreview.tsx'
import type { PreviewPlaytestView } from '@shared/preview.ts'

export const RUN_IT_TITLE = 'Run it'
export const RUN_IT_INTRO = 'Start this project and preview it. Nothing runs until you press Start.'
export const SHOW_LABEL = 'Run it'
export const HIDE_LABEL = 'Hide'
export const START_LABEL = 'Start'
export const STOP_LABEL = 'Stop'
export const TRUST_LABEL = 'Trust'
export const TRUSTED_LABEL = 'Trusted'
export const OPEN_APP_LABEL = 'Open preview'
export const OPEN_BROWSER_LABEL = 'Open in browser'
export const SMOKE_LABEL = 'Smoke check'
export const COMPOSE_DOWN_LABEL = 'Stop containers too'
/** How many of the newest output lines the box shows. */
export const LOG_LINES = 12

export const DETECTING_TEXT = 'Looking for a way to run it…'
export const NOTHING_TEXT = 'Dim Factory found no way to run this folder.'
export const NO_RUN_MD_TEXT =
  'It has no RUN.md either. When Implement or Fix finds no way to run a project, they are asked to write one.'
export const UNTRUSTED_REASON = 'Trust it first: Dim Factory runs a command only after you trust it.'
export const NO_URL_REASON = 'Its output has not named a page yet.'
export const NOT_RUNNING_REASON = 'Start a preview first.'

const KIND_TEXT: Record<PreviewKind, string> = {
  server: 'Serves a page',
  static: 'Static files',
  app: 'Opens its own window',
  command: 'Prints output',
  document: 'A document',
}

const isLive = (s: PreviewSessionView): boolean =>
  s.status === 'starting' || s.status === 'running' || s.status === 'stopping'

/** The line beside [Stop containers too]: what it does, then how its `docker compose down` went. */
export function composeDownText(s: PreviewSessionView): string {
  const d = s.composeDown
  if (d === undefined) {
    return isLive(s)
      ? 'Stop ends only the compose command. This also runs docker compose down.'
      : 'The containers may still be running. This runs docker compose down.'
  }
  if (d.status === 'running') return 'Stopping the containers (docker compose down)…'
  if (d.status === 'done') return 'Containers stopped.'
  return `The containers were not stopped: ${d.reason ?? 'docker compose down failed'}.`
}

/**
 * [Stop containers too] for a docker compose preview: on the user's click only, the compose command stops and core
 * runs `docker compose down` for it (the same trusted runner). The label never changes; how it went shows beside it.
 */
function ComposeDownRow({
  session,
  busy,
  run,
}: {
  session: PreviewSessionView
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const tag = `down:${session.id}`
  const running = busy === tag || session.composeDown?.status === 'running'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="run-it-compose">
      <Button
        size="sm"
        variant="outline"
        icon={<Square aria-hidden />}
        loading={running}
        disabled={running}
        data-testid="run-it-compose-down"
        onClick={() =>
          run(tag, async () => {
            const r = await invoke('preview.stop', { sessionId: session.id, containers: true })
            if (!r.ok) toast({ level: 'error', message: r.error.message })
          })
        }
      >
        {COMPOSE_DOWN_LABEL}
      </Button>
      <span
        role="status"
        className="min-w-0 flex-1 basis-48 text-xs break-words text-muted-foreground"
        data-testid="run-it-compose-status"
        data-down={session.composeDown?.status ?? 'none'}
      >
        {composeDownText(session)}
      </span>
    </div>
  )
}

/** The trust line under a command (empty for the static server). */
export function trustText(c: PreviewCommand): string {
  switch (c.trust) {
    case 'trusted':
      return 'Trusted for this folder.'
    case 'untrusted':
      return 'Not trusted yet. Trust shows Dim Factory you have read what it runs.'
    case 'changed':
      return 'Changed since you trusted it. Read it again before you trust it.'
    case 'none':
      return ''
  }
}

/** The status line of a preview. */
export function sessionText(s: PreviewSessionView): string {
  switch (s.status) {
    case 'starting':
      return `Starting ${s.label}…`
    case 'running':
      if (s.url !== null) return `Running ${s.label} at ${s.url}`
      return s.kind === 'server' ? `Running ${s.label}. ${NO_URL_REASON}` : `Running ${s.label}.`
    case 'stopping':
      return `Stopping ${s.label}…`
    case 'stopped':
      return `${s.label} stopped.`
    case 'exited':
      return `${s.label} finished.`
    case 'failed':
      return `${s.label} ended: ${s.reason ?? 'it failed'}.`
  }
}

/** One line about a smoke check's result. */
export function smokeSummary(v: PreviewSmokeView): string {
  if (v.error !== undefined && !v.loaded) return v.error
  const e = v.consoleErrors.length
  const f = v.failedLoads.length
  if (e === 0 && f === 0) return 'The page loaded with no console errors and no failed loads.'
  const errors = e === 1 ? '1 console error' : `${e} console errors`
  const loads = f === 1 ? '1 failed load' : `${f} failed loads`
  return `The page loaded with ${[e > 0 ? errors : '', f > 0 ? loads : ''].filter((x) => x !== '').join(' and ')}.`
}

interface InfoState {
  info: PreviewInfo | null
  error: string | null
  loading: boolean
}

function usePreviewInfo(target: PreviewTarget, enabled: boolean): InfoState & { reload: () => void } {
  const [state, setState] = useState<InfoState>({ info: null, error: null, loading: false })
  const [nonce, setNonce] = useState(0)
  const key = `${target.runId ?? ''}\u0000${target.folder ?? ''}`
  const req = useRef(target)
  req.current = target
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    void invoke('preview.detect', req.current).then((r) => {
      if (!alive) return
      if (r.ok) {
        upsertPreviewSessions(r.value.sessions)
        setState({ info: r.value, error: null, loading: false })
      } else setState((s) => ({ info: s.info, error: r.error.message, loading: false }))
    })
    return () => {
      alive = false
    }
  }, [key, nonce, enabled])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

function CommandRow({
  c,
  live,
  busy,
  onTrust,
  onStart,
  onStop,
}: {
  c: PreviewCommand
  live: PreviewSessionView | undefined
  busy: string | null
  onTrust: () => void
  onStart: () => void
  onStop: () => void
}): React.JSX.Element {
  const needsTrust = c.kind !== 'static' && c.kind !== 'document'
  const trusted = !needsTrust || c.trust === 'trusted'
  const blocked = c.error !== undefined ? c.error : !trusted ? UNTRUSTED_REASON : null
  const t = trustText(c)
  const startStop = (
    <Button
      size="sm"
      variant={live !== undefined ? 'outline' : 'default'}
      labels={[START_LABEL, STOP_LABEL]}
      icon={live !== undefined ? <Square aria-hidden /> : <Play aria-hidden />}
      loading={busy === `start:${c.id}` || busy === `stop:${c.id}` || live?.status === 'stopping'}
      disabled={live === undefined && blocked !== null}
      data-testid={`run-it-start-${c.id}`}
      onClick={live !== undefined ? onStop : onStart}
    >
      {live !== undefined ? STOP_LABEL : START_LABEL}
    </Button>
  )
  return (
    <li
      data-testid={`run-it-command-${c.id}`}
      data-trust={c.trust}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3 py-2"
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <code className="font-mono text-xs break-all">{c.label}</code>
          <span className="text-xs text-muted-foreground">{KIND_TEXT[c.kind]}</span>
        </p>
        {c.note !== undefined && <p className="text-xs text-muted-foreground">{c.note}</p>}
        {c.urlHint !== undefined && <p className="text-xs text-muted-foreground">Expected at {c.urlHint}</p>}
        {t !== '' && (
          <p className="text-xs text-muted-foreground" data-testid={`run-it-trust-${c.id}`}>
            {t}
          </p>
        )}
        {c.error !== undefined && <p className="text-xs text-destructive">{c.error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {needsTrust && (
          <Button
            size="sm"
            variant="outline"
            labels={[TRUST_LABEL, TRUSTED_LABEL]}
            icon={<ShieldCheck aria-hidden />}
            loading={busy === `trust:${c.id}`}
            disabled={c.trust === 'trusted' || c.error !== undefined}
            data-testid={`run-it-trust-button-${c.id}`}
            onClick={onTrust}
          >
            {c.trust === 'trusted' ? TRUSTED_LABEL : TRUST_LABEL}
          </Button>
        )}
        {live === undefined && blocked !== null ? (
          <DisabledHint reason={blocked}>{startStop}</DisabledHint>
        ) : (
          startStop
        )}
      </div>
    </li>
  )
}

function OpenButtons({
  session,
  openIn,
  busy,
  run,
  onPlaytest,
}: {
  session: PreviewSessionView
  openIn: PreviewOpenTarget
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
  /** A game: [Play-test] plays its playtest.json; the result goes here. */
  onPlaytest?: (v: PreviewPlaytestView) => void
}): React.JSX.Element {
  const reason =
    session.status !== 'running' ? NOT_RUNNING_REASON : session.url === null ? NO_URL_REASON : null
  const open = (target: 'app' | 'browser'): void =>
    run(`open:${target}`, async () => {
      const r = await invoke('preview.open', { sessionId: session.id, target })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
    })
  const smoke = (): void =>
    run('smoke', async () => {
      const r = await invoke('preview.smoke', { sessionId: session.id })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
      else setPreviewSmoke(session.folder, r.value)
    })
  const button = (
    tag: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    testId: string,
  ): React.JSX.Element => {
    const b = (
      <Button
        size="sm"
        variant="outline"
        icon={icon}
        loading={busy === tag}
        disabled={reason !== null || (busy !== null && busy !== tag)}
        data-testid={testId}
        onClick={onClick}
      >
        {label}
      </Button>
    )
    return reason !== null ? (
      <DisabledHint key={tag} reason={reason}>
        {b}
      </DisabledHint>
    ) : (
      <span key={tag} className="contents">
        {b}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {openIn !== 'browser' &&
        button('open:app', OPEN_APP_LABEL, <Monitor aria-hidden />, () => open('app'), 'run-it-open-app')}
      {openIn !== 'app' &&
        button(
          'open:browser',
          OPEN_BROWSER_LABEL,
          <ExternalLink aria-hidden />,
          () => open('browser'),
          'run-it-open-browser',
        )}
      {button('smoke', SMOKE_LABEL, <Stethoscope aria-hidden />, smoke, 'run-it-smoke')}
      {session.game === true && onPlaytest !== undefined && reason === null && (
        <PlaytestButton session={session} busy={busy} run={run} onResult={onPlaytest} />
      )}
      {session.game === true && reason === null && openIn !== 'browser' && (
        <PhoneSizeToggle session={session} busy={busy} run={run} />
      )}
    </div>
  )
}

function SessionBox({ session }: { session: PreviewSessionView }): React.JSX.Element {
  const lines = session.tail.slice(-LOG_LINES)
  return (
    <div className="flex flex-col gap-1">
      <div
        role="log"
        aria-live="off"
        aria-label="Newest output of the preview"
        data-testid="run-it-log"
        className="flex flex-col justify-end overflow-hidden rounded-md bg-muted/40 px-3 py-2 font-mono text-xs leading-5"
        style={{ height: `calc(${LOG_LINES} * 1.25rem + 1rem)` }}
      >
        {lines.length === 0 ? (
          <span className="text-muted-foreground">No output yet.</span>
        ) : (
          lines.map((l, i) => (
            <div key={`${session.lines - lines.length + i}`} className="truncate whitespace-pre">
              {l === '' ? '\u00a0' : l}
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The newest {LOG_LINES} lines.
        {session.logPath !== undefined ? ` The whole output is kept in ${session.logPath}.` : ''}
      </p>
    </div>
  )
}

function SmokeResult({ v }: { v: PreviewSmokeView }): React.JSX.Element {
  return (
    <section
      aria-label="Smoke check"
      data-testid="run-it-smoke-result"
      data-errors={v.consoleErrors.length}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">Smoke check</h4>
      <div className="flex flex-wrap items-start gap-3">
        {v.thumbnail !== null && (
          <img
            src={v.thumbnail}
            alt="The preview page as the smoke check saw it"
            data-testid="run-it-smoke-thumbnail"
            className="w-60 max-w-full shrink-0 rounded border"
          />
        )}
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1 text-sm">
          <p data-testid="run-it-smoke-summary">{smokeSummary(v)}</p>
          {v.consoleErrors.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs">
              {v.consoleErrors.slice(0, 10).map((e, i) => (
                <li key={i} data-testid="run-it-smoke-error" className="break-words">
                  <span className="font-medium">Console error:</span> {e.message}
                  {e.source !== undefined && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({e.source}
                      {e.line !== undefined ? `:${e.line}` : ''})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {v.failedLoads.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs">
              {v.failedLoads.slice(0, 10).map((f, i) => (
                <li key={i} data-testid="run-it-smoke-failed" className="break-all">
                  <span className="font-medium">Failed to load:</span> {f.url} ({f.error})
                </li>
              ))}
            </ul>
          )}
          {v.checks !== undefined && v.checks.length > 0 && <GameChecksList checks={v.checks} />}
          {v.blocked !== undefined && v.blocked.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs" aria-label="Blocked requests">
              {v.blocked.slice(0, 10).map((b, i) => (
                <li key={i} data-testid="run-it-smoke-blocked" className="break-all">
                  <span className="font-medium">Blocked (no internet):</span> {b.url}
                </li>
              ))}
            </ul>
          )}
          {v.runId !== undefined ? (
            v.findings.length > 0 && (
              <div className="flex flex-col gap-0.5" data-testid="run-it-smoke-findings">
                <p className="text-xs text-muted-foreground">Kept with the run as findings:</p>
                <ul className="flex flex-col gap-0.5 text-xs">
                  {v.findings.map((f) => (
                    <li key={f.id} data-testid={`run-it-smoke-finding-${f.id}`}>
                      <span className="font-mono">[{f.severity}]</span> F{f.n} {f.title}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="run-it-smoke-note">
              This preview is not part of a run, so the result is a note here only.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

export interface RunItPanelProps {
  target: PreviewTarget
  /** In "After the run": a row with [Run it] that opens the panel (nothing is detected until then). */
  collapsible?: boolean
  className?: string
}

export function RunItPanel({ target, collapsible = false, className }: RunItPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(!collapsible)
  const { info, error, loading, reload } = usePreviewInfo(target, open)
  const sessions = usePreviewSessions(info?.folder ?? null)
  const [busy, run] = useBusy()
  const smoke = usePreviewSmoke(info?.folder ?? null, info?.smoke ?? null)
  const focus = sessions[0]
  const [playtest, setPlaytest] = useState<PreviewPlaytestView | null>(null)

  const trust = (c: PreviewCommand): void =>
    run(`trust:${c.id}`, async () => {
      const r = await invoke('preview.trust', {
        ...target,
        commandId: c.id,
        ...(c.hash !== undefined ? { hash: c.hash } : {}),
        trusted: true,
      })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
      reload()
    })
  const start = (c: PreviewCommand): void =>
    run(`start:${c.id}`, async () => {
      const r = await invoke('preview.start', { ...target, commandId: c.id })
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        reload()
      } else upsertPreviewSessions([r.value])
    })
  const stop = (c: PreviewCommand, s: PreviewSessionView): void =>
    run(`stop:${c.id}`, async () => {
      const r = await invoke('preview.stop', { sessionId: s.id })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
    })

  const body = (
    <div className="flex flex-col gap-3" data-testid="run-it-body">
      {info === null ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="run-it-status-line">
          {error !== null ? `Dim Factory could not look at the folder: ${error}` : DETECTING_TEXT}
        </p>
      ) : (
        <>
          {info.commands.length === 0 ? (
            <p className="text-sm" data-testid="run-it-nothing">
              {NOTHING_TEXT}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Ways to run it" data-testid="run-it-commands">
              {info.commands.map((c) => {
                const live = sessions.find((s) => s.commandId === c.id && isLive(s))
                return (
                  <CommandRow
                    key={c.id}
                    c={c}
                    live={live}
                    busy={busy}
                    onTrust={() => trust(c)}
                    onStart={() => start(c)}
                    onStop={() => live !== undefined && stop(c, live)}
                  />
                )
              })}
            </ul>
          )}
          {info.checks.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Checks">
              {info.checks.map((c) => (
                <li key={c.id} data-testid="run-it-check" className="flex items-start gap-1.5 text-xs">
                  <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{c.title}.</span> {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {focus !== undefined && (
            <div className="flex flex-col gap-2" data-testid="run-it-session" data-status={focus.status}>
              <p role="status" className="text-sm break-words" data-testid="run-it-status">
                {sessionText(focus)}
              </p>
              {(focus.kind === 'server' || focus.kind === 'static' || focus.kind === 'document') && (
                <OpenButtons
                  session={focus}
                  openIn={info.openIn}
                  busy={busy}
                  run={run}
                  onPlaytest={setPlaytest}
                />
              )}
              {focus.game === true && focus.network !== undefined && isLive(focus) && (
                <NetworkRow session={focus} busy={busy} run={run} />
              )}
              {focus.compose === true && <ComposeDownRow session={focus} busy={busy} run={run} />}
              <SessionBox session={focus} />
            </div>
          )}
          {smoke !== null && <SmokeResult v={smoke} />}
          {playtest !== null && focus !== undefined && playtest.sessionId === focus.id && (
            <PlaytestResult v={playtest} />
          )}
          {info.runMd !== null ? (
            <section aria-label="RUN.md" data-testid="run-it-run-md" className="rounded-md border p-3">
              <h4 className="mb-1 text-xs font-semibold text-muted-foreground uppercase">RUN.md</h4>
              <LightMarkdown text={info.runMd.text} className="text-sm" />
              {info.runMd.truncated && (
                <p className="mt-1 text-xs text-muted-foreground">Only the start of RUN.md is shown.</p>
              )}
            </section>
          ) : (
            info.commands.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="run-it-no-run-md">
                {NO_RUN_MD_TEXT}
              </p>
            )
          )}
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw aria-hidden />}
              loading={loading}
              data-testid="run-it-refresh"
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
      <div className={cn('flex flex-col gap-3', className)} data-testid="run-it">
        {body}
      </div>
    )
  }
  return (
    <section aria-label={RUN_IT_TITLE} data-testid="run-it" className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-sm">{RUN_IT_INTRO}</p>
        <Button
          size="sm"
          variant="outline"
          labels={[SHOW_LABEL, HIDE_LABEL]}
          icon={<Play aria-hidden />}
          aria-expanded={open}
          data-testid="run-it-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? HIDE_LABEL : SHOW_LABEL}
        </Button>
      </div>
      {open && body}
    </section>
  )
}
