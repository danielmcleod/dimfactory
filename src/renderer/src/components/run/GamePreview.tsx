// A game's preview in Run it: its network line with "Allow internet for this preview" (a game's preview reaches this
// computer only until the user allows more, one click), the smoke check's built-in game checks, Play-test (the game's
// playtest.json played in a hidden window) with its result, and Phone size (the preview window at 390 by 844 with touch
// emulation; a toggle). Core and main decide everything; this only formats.
// UI standards: the network line and the play-test status keep their height; the buttons keep their labels (the allow
// button is turned off once the internet is allowed rather than changing its words).
import { CircleCheck, CircleMinus, CircleX, Gamepad2, Globe, Smartphone, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { GameCheck, GameCheckStatus, ScenarioStatus } from '@shared/playtest.ts'
import type { PreviewPlaytestView, PreviewSessionView } from '@shared/preview.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { upsertPreviewSessions } from '../../state/previews.ts'
import { toast } from '../../state/toasts.ts'
import { Button } from '../ui/Button.tsx'

export const ALLOW_INTERNET_LABEL = 'Allow internet for this preview'
export const PLAYTEST_LABEL = 'Play-test'
export const PLAYTEST_TITLE = 'Play-test'
export const PHONE_SIZE_LABEL = 'Phone size'
/** Said under the buttons once Phone size is on (and off). */
export const PHONE_ON_NOTE =
  'The preview window is at phone size (390 by 844) with touch: a click is a tap. Press Phone size again, or Ctrl+Shift+M in the window, to go back.'
export const PHONE_OFF_NOTE = 'The preview window is back to its own size.'

/** The network line of a game's preview. */
export function networkText(s: Pick<PreviewSessionView, 'network' | 'blocked'>): string {
  if (s.network === 'internet') return 'Internet allowed for this preview.'
  const b = s.blocked
  const base = 'No internet: this game can reach only this computer, so it must bundle what it needs.'
  if (b === undefined || b.count === 0) return base
  const what = b.count === 1 ? '1 request' : `${b.count} requests`
  return `${base} Blocked ${what} to ${b.hosts.slice(0, 3).join(', ')}${b.hosts.length > 3 ? ' and more' : ''}.`
}

export function NetworkRow({
  session,
  busy,
  run,
}: {
  session: PreviewSessionView
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const tag = `net:${session.id}`
  const allowed = session.network === 'internet'
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="run-it-network"
      data-network={session.network}
    >
      <Button
        size="sm"
        variant="outline"
        icon={<Globe aria-hidden />}
        loading={busy === tag}
        disabled={allowed || (busy !== null && busy !== tag)}
        data-testid="run-it-allow-internet"
        onClick={() =>
          run(tag, async () => {
            const r = await invoke('preview.network', { sessionId: session.id, internet: true })
            if (!r.ok) toast({ level: 'error', message: r.error.message })
            else upsertPreviewSessions([r.value])
          })
        }
      >
        {ALLOW_INTERNET_LABEL}
      </Button>
      <span
        role="status"
        className="min-h-8 min-w-0 flex-1 basis-48 text-xs break-words text-muted-foreground"
        data-testid="run-it-network-text"
      >
        {networkText(session)}
      </span>
    </div>
  )
}

const CHECK_ICON: Record<GameCheckStatus, LucideIcon> = {
  pass: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  skipped: CircleMinus,
}
const CHECK_TONE: Record<GameCheckStatus, string> = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  skipped: 'text-muted-foreground',
}
export const CHECK_WORD: Record<GameCheckStatus, string> = {
  pass: 'OK',
  warn: 'Warning',
  fail: 'Problem',
  skipped: 'Not checked',
}

/** The built-in game checks, one line each. */
export function GameChecksList({ checks }: { checks: readonly GameCheck[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5 text-xs" aria-label="Game checks" data-testid="run-it-game-checks">
      {checks.map((c) => {
        const Icon = CHECK_ICON[c.status]
        return (
          <li
            key={c.id}
            className="flex min-w-0 items-start gap-1.5"
            data-testid={`run-it-game-check-${c.id}`}
            data-status={c.status}
          >
            <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', CHECK_TONE[c.status])} />
            <span className="sr-only">{CHECK_WORD[c.status]}: </span>
            <span className="min-w-0 break-words">
              {c.title}
              {c.detail !== undefined && c.status !== 'pass' && (
                <span className="text-muted-foreground"> ({c.detail})</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export const SCENARIO_WORD: Record<ScenarioStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  error: 'Not played',
}

/** One line about a play-test. */
export function playtestSummary(v: PreviewPlaytestView): string {
  if (v.report === null) return v.problem ?? 'Nothing was played.'
  if (v.report.error !== undefined && v.report.scenarios.length === 0) return v.report.error
  const all = v.report.scenarios
  const must = all.filter((s) => s.must)
  const failed = must.filter((s) => s.status !== 'pass').length
  if (all.length === 0) return 'The game was checked; playtest.json has no scenarios.'
  if (failed === 0) return `All ${must.length} required scenario${must.length === 1 ? '' : 's'} passed.`
  return `${failed} of ${must.length} required scenario${must.length === 1 ? '' : 's'} did not pass.`
}

export function PlaytestButton({
  session,
  busy,
  run,
  onResult,
}: {
  session: PreviewSessionView
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
  onResult: (v: PreviewPlaytestView) => void
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="outline"
      icon={<Gamepad2 aria-hidden />}
      loading={busy === 'playtest'}
      disabled={session.status !== 'running' || (busy !== null && busy !== 'playtest')}
      data-testid="run-it-playtest"
      onClick={() =>
        run('playtest', async () => {
          const r = await invoke('preview.playtest', { sessionId: session.id })
          if (!r.ok) toast({ level: 'error', message: r.error.message })
          else onResult(r.value)
        })
      }
    >
      {PLAYTEST_LABEL}
    </Button>
  )
}

export function PlaytestResult({
  v,
  testId = 'run-it-playtest-result',
}: {
  v: PreviewPlaytestView
  testId?: string
}): React.JSX.Element {
  const r = v.report
  return (
    <section
      aria-label={PLAYTEST_TITLE}
      data-testid={testId}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <h4 className="text-xs font-semibold text-muted-foreground uppercase">{PLAYTEST_TITLE}</h4>
      <p className="text-sm" data-testid={`${testId}-summary`}>
        {playtestSummary(v)}
      </p>
      {r !== null && r.scenarios.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Scenarios">
          {r.scenarios.map((s, i) => {
            const Icon = s.status === 'pass' ? CircleCheck : CircleX
            return (
              <li
                key={`${i}-${s.name}`}
                className="flex min-w-0 items-start gap-2"
                data-testid={`${testId}-scenario`}
                data-status={s.status}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    s.status === 'pass' ? 'text-success' : 'text-destructive',
                  )}
                />
                <span className="w-20 shrink-0 text-xs leading-5 text-muted-foreground">
                  {SCENARIO_WORD[s.status]}
                </span>
                <span className="min-w-0 break-words">
                  {s.name}
                  {!s.must && <span className="text-muted-foreground"> (not required)</span>}
                  {s.failure !== undefined && (
                    <span className="block text-xs text-muted-foreground">
                      Step {s.failure.step} ({s.failure.what}): {s.failure.message}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {r !== null && r.checks.length > 0 && <GameChecksList checks={r.checks} />}
    </section>
  )
}

/**
 * Phone size: a toggle (aria-pressed) that puts the game's preview window at phone size with touch emulation, opening
 * it first when it is not open. Its label never changes, so it keeps its size.
 */
export function PhoneSizeButton({
  pressed,
  loading,
  disabled,
  onClick,
  testId,
  size = 'sm',
}: {
  pressed: boolean
  loading: boolean
  disabled: boolean
  onClick: () => void
  testId: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <Button
      size={size}
      variant={pressed ? 'secondary' : 'outline'}
      icon={<Smartphone aria-hidden />}
      aria-pressed={pressed}
      loading={loading}
      disabled={disabled}
      data-testid={testId}
      data-pressed={pressed ? 'true' : 'false'}
      onClick={onClick}
    >
      {PHONE_SIZE_LABEL}
    </Button>
  )
}

/** Run it's Phone size for a running game's preview (the session view says whether it is on). */
export function PhoneSizeToggle({
  session,
  busy,
  run,
}: {
  session: PreviewSessionView
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const tag = `phone:${session.id}`
  const on = session.phone === true
  return (
    <PhoneSizeButton
      pressed={on}
      loading={busy === tag}
      disabled={session.status !== 'running' || (busy !== null && busy !== tag)}
      testId="run-it-phone"
      onClick={() =>
        run(tag, async () => {
          const r = await invoke('preview.phone', { sessionId: session.id, phone: !on })
          if (!r.ok) toast({ level: 'error', message: r.error.message })
          else upsertPreviewSessions([r.value])
        })
      }
    />
  )
}
