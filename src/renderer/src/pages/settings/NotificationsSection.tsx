// Settings → Notifications (event toggles, pause 1 h, [Send test], Windows AUMID ✓ CLSID ✗ [Repair]). Values are core's resolved
// `notifications` (config.resolve, read again on every config change); a switch writes the user file with
// config.patch and offers Undo (core's backup). Pausing is app state (state.set notificationsPausedUntil), the test
// notification and the Windows shortcut repair are main's (notifications.test / notifications.repairShortcut), and
// their replies are shown as they come. Values are read once the section has been open for LOAD_DELAY_MS, so a
// section switch renders at once and passing through costs no IPC (performance.spec.ts).
import { Bell, BellOff, Check, Send, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type {
  AppState,
  ConfigWriteResult,
  NotificationShortcutStatus,
  NotificationTestResult,
} from '@shared/ipc.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { useNow } from '../../lib/ticker.ts'
import { useAppInfo, useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { Group, SettingRow } from './kit.tsx'

type NotificationSettings = ResolvedConfig['notifications']

const PAUSE_LABEL = 'Pause for 1 hour'
const RESUME_LABEL = 'Resume'
/** The pause toggle reserves both labels' width, so pausing never resizes it. */
const PAUSE_LABELS: readonly string[] = [PAUSE_LABEL, RESUME_LABEL]
type EventId = keyof NotificationSettings['events']
type Flag = 'desktop' | 'sound' | 'onlyWhenUnfocused'

/** The notification events, in their order (mirrors NOTIFICATION_EVENTS in config-schema.ts; importing it would bundle zod). */
export const NOTIFY_EVENTS: readonly { id: EventId; label: string }[] = [
  { id: 'ask', label: 'A vendor asks for approval' },
  { id: 'gate', label: 'A plan or findings are ready for review' },
  { id: 'completed', label: 'A run completed' },
  { id: 'failed', label: 'A run failed' },
  { id: 'catalog', label: 'Model prices may be out of date' },
]

const FLAGS: readonly { id: Flag; label: string; description?: string; testId: string }[] = [
  { id: 'desktop', label: 'Show desktop notifications', testId: 'notif-desktop' },
  {
    id: 'onlyWhenUnfocused',
    label: 'Only while Dim Factory is in the background',
    description: 'While its window is in front, a message inside Dim Factory is used instead.',
    testId: 'notif-unfocused',
  },
  { id: 'sound', label: 'Play a sound', testId: 'notif-sound' },
]

export const PAUSE_MS = 60 * 60 * 1000
/** How long the section is open before it reads its values. */
export const LOAD_DELAY_MS = 150
export const NOT_PACKAGED = 'Available in the installed app'

const UNDO_TOAST = 'notifications-undo'

const timeOfDay = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What notifications.test answered, in words. */
export function testResultText(r: NotificationTestResult): string {
  const why = r.reason !== undefined && r.reason !== '' ? `: ${r.reason}` : ''
  if (!r.shown) return `Not shown${why}`
  return r.surface === 'native' ? `Sent as a desktop notification${why}` : `Shown inside Dim Factory${why}`
}

function useResolvedNotifications(): {
  settings: NotificationSettings | null
  error: string | null
  setLocal: (next: NotificationSettings) => void
  reload: () => void
} {
  const epoch = useConfigEpoch()
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('config.resolve', {}).then((r) => {
        if (!alive) return
        if (r.ok) {
          setSettings(r.value.config.notifications)
          setError(null)
        } else setError(r.error.message)
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [epoch, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { settings, error, setLocal: setSettings, reload }
}

/**
 * Repair without admin rights: a per-machine install's shortcut is in the Start menu for all users,
 * which only an administrator can change.
 */
export const NEEDS_ADMIN_TEXT =
  "Dim Factory's shortcut is in the Start menu for all users, and changing it needs administrator rights. Reinstall Dim Factory, or run it once as administrator and press Repair."

function Mark({ ok, name }: { ok: boolean; name: string }): React.JSX.Element {
  const Icon = ok ? Check : X
  return (
    <span className="inline-flex items-center gap-0.5">
      {name}
      <Icon aria-hidden className={ok ? 'size-3.5 text-success' : 'size-3.5 text-destructive'} />
      {/* One fixed-width glyph slot: a repair flipping ✗ to ✓ never nudges what follows. */}
      <span aria-hidden className="inline-block w-[1.1em] text-center">
        {ok ? '✓' : '✗'}
      </span>
      <span className="sr-only">{ok ? ' set up' : ' missing'}</span>
    </span>
  )
}

function WindowsIdentity({ initial }: { initial: { aumid: boolean; clsid: boolean } }): React.JSX.Element {
  const [marks, setMarks] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const repair = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('notifications.repairShortcut')
    setBusy(false)
    if (!r.ok) {
      setResult(r.error.message)
      return
    }
    const s: NotificationShortcutStatus = r.value
    if (!s.applicable) {
      setResult(NOT_PACKAGED)
      return
    }
    setMarks({ aumid: s.aumid, clsid: s.clsid })
    setResult(
      s.aumid && s.clsid
        ? 'Repaired: notification buttons work again.'
        : s.needsAdmin === true
          ? NEEDS_ADMIN_TEXT
          : 'The repair did not fix it. Reinstalling Dim Factory sets it up again.',
    )
  }

  return (
    <Group
      title="Windows notification setup"
      description="Windows needs Dim Factory's Start menu shortcut to show notifications with buttons."
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="notif-identity" className="inline-flex flex-wrap items-center gap-1.5">
          Notification identity: <Mark ok={marks.aumid} name="AUMID" />
          <span aria-hidden>·</span>
          <Mark ok={marks.clsid} name="CLSID" />
        </span>
        <Button
          size="sm"
          variant="outline"
          data-testid="notif-repair"
          icon={<Wrench aria-hidden />}
          loading={busy}
          disabled={result === NOT_PACKAGED}
          onClick={() => void repair()}
        >
          Repair
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground" data-testid="notif-repair-result">
        {result ?? ''}
      </p>
    </Group>
  )
}

export function NotificationsSection(): React.JSX.Element {
  const info = useAppInfo()
  const { settings, error, setLocal, reload } = useResolvedNotifications()
  const [pausedUntil, setPausedUntil] = useState<number | null>(null)
  const [pausing, setPausing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [writing, setWriting] = useState<string | null>(null)
  const now = useNow(pausedUntil !== null)

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('state.get').then((r) => {
        if (alive && r.ok) setPausedUntil(r.value.notifications.pausedUntil)
      })
    }, LOAD_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [])

  const undoWrite = async (res: ConfigWriteResult, pointer: string): Promise<void> => {
    const r =
      res.backupId !== null
        ? await invoke('config.restoreBackup', { scope: 'user', backupId: res.backupId })
        : await invoke('config.patch', { scope: 'user', ops: [{ op: 'remove', path: pointer }] })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    reload()
  }

  const write = async (
    pointer: string,
    value: boolean,
    next: NotificationSettings,
    said: string,
  ): Promise<void> => {
    if (settings === null) return
    const before = settings
    setLocal(next)
    setWriting(pointer)
    const r = await invoke('config.patch', { scope: 'user', ops: [{ op: 'replace', path: pointer, value }] })
    setWriting(null)
    if (!r.ok) {
      setLocal(before)
      toast({ level: 'error', message: r.error.message })
      return
    }
    const res = r.value
    toast({
      id: UNDO_TOAST,
      level: 'info',
      message: said,
      action: { label: 'Undo', onClick: () => undoWrite(res, pointer) },
    })
  }

  const setFlag = (flag: Flag, label: string, value: boolean): void => {
    if (settings === null) return
    void write(
      `/notifications/${flag}`,
      value,
      { ...settings, [flag]: value },
      `${label}: ${value ? 'on' : 'off'}`,
    )
  }
  const setEvent = (id: EventId, label: string, value: boolean): void => {
    if (settings === null) return
    void write(
      `/notifications/events/${id}`,
      value,
      { ...settings, events: { ...settings.events, [id]: value } },
      `${label}: ${value ? 'notify' : "don't notify"}`,
    )
  }

  const paused = pausedUntil !== null && pausedUntil > now
  const pause = async (): Promise<void> => {
    setPausing(true)
    const r = await invoke('state.set', { notificationsPausedUntil: paused ? null : Date.now() + PAUSE_MS })
    setPausing(false)
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    const state: AppState = r.value
    setPausedUntil(state.notifications.pausedUntil)
  }

  const sendTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const r = await invoke('notifications.test')
    setTesting(false)
    setTestResult(r.ok ? testResultText(r.value) : r.error.message)
  }

  const off = settings === null
  return (
    <div className="flex flex-col gap-6" data-testid="settings-notifications" aria-busy={off || undefined}>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The notification settings could not be read: {error}
        </p>
      )}
      <Group title="Desktop notifications">
        <div>
          {FLAGS.map((f) => (
            <SettingRow
              key={f.id}
              label={f.label}
              {...(f.description !== undefined ? { description: f.description } : {})}
            >
              <Switch
                data-testid={f.testId}
                aria-label={f.label}
                checked={settings?.[f.id] ?? false}
                disabled={off || writing === `/notifications/${f.id}`}
                onCheckedChange={(v) => setFlag(f.id, f.label, v)}
              />
            </SettingRow>
          ))}
        </div>
      </Group>
      <Group title="Notify me when">
        <div>
          {NOTIFY_EVENTS.map((e) => (
            <SettingRow key={e.id} label={e.label}>
              <Switch
                data-testid={`notif-event-${e.id}`}
                aria-label={e.label}
                checked={settings?.events[e.id] ?? false}
                disabled={off || writing === `/notifications/events/${e.id}`}
                onCheckedChange={(v) => setEvent(e.id, e.label, v)}
              />
            </SettingRow>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="notif-pause"
            data-paused={paused || undefined}
            icon={paused ? <Bell aria-hidden /> : <BellOff aria-hidden />}
            labels={PAUSE_LABELS}
            loading={pausing}
            onClick={() => void pause()}
          >
            {paused ? RESUME_LABEL : PAUSE_LABEL}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="notif-test"
            icon={<Send aria-hidden />}
            loading={testing}
            onClick={() => void sendTest()}
          >
            Send a test notification
          </Button>
          {/* After both buttons: the status coming and going never moves them. */}
          {paused && pausedUntil !== null && (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              data-testid="notif-paused"
            >
              <BellOff aria-hidden className="size-3.5" />
              Paused until {timeOfDay(pausedUntil)}
            </span>
          )}
        </div>
        <p role="status" className="text-xs text-muted-foreground" data-testid="notif-test-result">
          {testResult ?? ''}
        </p>
      </Group>
      {info?.notifications != null && (
        <WindowsIdentity
          key={`${info.notifications.aumid}:${info.notifications.clsid}`}
          initial={info.notifications}
        />
      )}
    </div>
  )
}
