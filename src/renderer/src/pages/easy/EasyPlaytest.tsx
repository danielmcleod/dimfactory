// A game's Done screen: "Play-tested", what Dim Factory checked by playing it. First the run's own play-test (the
// Verify check's scenarios, passed or failed), then, on the user's click, "Play-test it again" (the game's preview,
// started when it is not running, and its playtest.json played in a hidden window with no internet), whose result
// replaces the list. When the game tried to reach the internet, one line says so with "Allow internet for this
// preview" (game previews have none until the user allows it).
// UI standards: the section is there from the first frame (the run's result is in the snapshot); the status line keeps
// its height; the buttons keep their labels.
import { Gamepad2, Globe } from 'lucide-react'
import { useState } from 'react'
import type { ScenarioStatus } from '@shared/playtest.ts'
import { PLAYTEST_COMMAND_NAME } from '@shared/playtest.ts'
import type { PreviewPlaytestView } from '@shared/preview.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { useBusy } from '../../components/run/commands.ts'
import { playtestSummary } from '../../components/run/GamePreview.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { upsertPreviewSessions } from '../../state/previews.ts'
import { openSession } from './session.ts'
import {
  ALLOW_INTERNET,
  INTERNET_ALLOWED,
  PLAYTESTED_TITLE,
  PLAYTEST_AGAIN,
  PLAYTEST_BLOCKED,
  PLAYTEST_NONE,
  PLAYTEST_TEXT,
  SCENARIO_WORDS,
} from './text.ts'

interface Line {
  name: string
  must: boolean
  status: ScenarioStatus
  message?: string
}

/** The run's last play-test (verify:2's when Fix ran, else verify:1's): its scenarios, or null when none ran. */
export function runScenarios(snap: RunSnapshot): Line[] | null {
  for (const k of ['verify:2', 'verify:1'] as const) {
    const c = snap.steps[k]?.verify?.commands.find((x) => x.name === PLAYTEST_COMMAND_NAME)
    if (c?.scenarios !== undefined && c.scenarios.length > 0) return c.scenarios
  }
  return null
}

export function EasyPlaytest({ runId, snap }: { runId: string; snap: RunSnapshot }): React.JSX.Element {
  const [busy, run] = useBusy()
  const [lines, setLines] = useState<Line[] | null>(() => runScenarios(snap))
  const [note, setNote] = useState('')
  const [blocked, setBlocked] = useState<{ sessionId: string; hosts: string[] } | null>(null)
  const [allowed, setAllowed] = useState(false)
  const again = (): void =>
    run('again', async () => {
      setNote('')
      const s = await openSession(runId, false)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      const r = await invoke('preview.playtest', { sessionId: s.sessionId })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      const v: PreviewPlaytestView = r.value
      setNote(playtestSummary(v))
      if (v.report !== null) {
        setLines(
          v.report.scenarios.map((x) => ({
            name: x.name,
            must: x.must,
            status: x.status,
            ...(x.failure !== undefined ? { message: x.failure.message } : {}),
          })),
        )
        const hosts = [...new Set(v.report.blocked.map((b) => b.host))]
        setBlocked(hosts.length > 0 ? { sessionId: s.sessionId, hosts } : null)
      }
    })
  const allow = (): void =>
    run('allow', async () => {
      if (blocked === null) return
      const r = await invoke('preview.network', { sessionId: blocked.sessionId, internet: true })
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      upsertPreviewSessions([r.value])
      setAllowed(true)
    })
  return (
    <section className="flex flex-col gap-2 border-t pt-4" data-testid="easy-done-playtest">
      <h2 className="text-base font-semibold">{PLAYTESTED_TITLE}</h2>
      <p className="text-sm">{PLAYTEST_TEXT}</p>
      {lines === null ? (
        <p className="text-sm text-muted-foreground" data-testid="easy-playtest-none">
          {PLAYTEST_NONE}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="easy-playtest-scenarios">
          {lines.map((l, i) => (
            <li
              key={`${i}-${l.name}`}
              className="flex items-start gap-2 text-sm"
              data-testid="easy-playtest-scenario"
              data-status={l.status}
            >
              <span
                className={
                  l.status === 'pass'
                    ? 'w-24 shrink-0 font-medium text-st-done'
                    : 'w-24 shrink-0 font-medium text-st-failed'
                }
              >
                {SCENARIO_WORDS[l.status]}
              </span>
              <span className="min-w-0 break-words">
                {l.name}
                {l.status !== 'pass' && l.message !== undefined && (
                  <span className="block text-xs text-muted-foreground">{l.message}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          icon={<Gamepad2 aria-hidden />}
          loading={busy === 'again'}
          disabled={busy !== null && busy !== 'again'}
          onClick={again}
          data-testid="easy-playtest-again"
        >
          {PLAYTEST_AGAIN}
        </Button>
        {blocked !== null && (
          <Button
            variant="outline"
            icon={<Globe aria-hidden />}
            loading={busy === 'allow'}
            disabled={allowed || (busy !== null && busy !== 'allow')}
            onClick={allow}
            data-testid="easy-playtest-allow-internet"
          >
            {ALLOW_INTERNET}
          </Button>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-playtest-note">
        {[
          note,
          blocked === null
            ? ''
            : allowed
              ? INTERNET_ALLOWED
              : PLAYTEST_BLOCKED(blocked.hosts.slice(0, 3).join(', ')),
        ]
          .filter((x) => x !== '')
          .join(' ')}
      </p>
    </section>
  )
}
