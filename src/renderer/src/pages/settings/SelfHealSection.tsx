// Settings → Self-heal (enabled, vendor, model, autoApplyConfigPatches, the last 10 heals; the user-only `selfHeal`
// keys). Values are core's resolved `selfHeal` (config.resolve,
// read again on every config change); each control writes the user file with config.patch and offers Undo (core's
// backup). The vendors are the ones this build can heal with (probes; HEAL_VENDORS, so a built Gemini is not
// offered); the models are vendors.models for the chosen vendor. The last 10 diagnoses are read-only and come from
// run state (StepView.heal of the runs the renderer has loaded); opening the section loads the snapshots of the most
// recent runs so the list covers them. Nothing is read until the section has been open for LOAD_DELAY_MS, so a
// section switch renders at once and passing through costs no IPC (performance.spec.ts).
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { HEAL_VENDORS } from '@shared/vendors.ts'
import { collectHeals, diagnosisText, healResultText } from '../../components/recovery/heal.ts'
import type { HealEntry } from '../../components/recovery/heal.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { categoryTitle, formatAgo, stepLabel } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { useNow } from '../../lib/ticker.ts'
import { useCatalogEpoch } from '../../state/catalog.ts'
import { ensureRun } from '../../state/runs.ts'
import { useConfigEpoch, useProbes } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { Group, SETTINGS_TABLE, SettingRow } from './kit.tsx'

type SelfHealSettings = ResolvedConfig['selfHeal']
type Key = keyof SelfHealSettings

/** How long the section is open before it reads its values. */
export const LOAD_DELAY_MS = 150
/** Recent runs whose snapshots the history loads (the newest first). */
export const HISTORY_RUNS = 20
export const HISTORY_SIZE = 10
/** Select value for "the CLI's own default model" (Radix Select reserves the empty string). */
export const CLI_DEFAULT = '__cli_default__'

export const ENABLED_LABEL = 'Diagnose unknown failures automatically'
export const AUTO_APPLY_LABEL = 'Apply safe config fixes without asking'
export const HISTORY_EMPTY = 'None yet.'
const UNDO_TOAST = 'selfheal-undo'
const HISTORY_COLUMNS = ['When', 'Run', 'Failure', 'Diagnosis', 'Result'] as const

const pointer = (key: Key): string => `/selfHeal/${key}`

function useResolvedSelfHeal(): {
  settings: SelfHealSettings | null
  error: string | null
  setLocal: (next: SelfHealSettings) => void
  reload: () => void
} {
  const epoch = useConfigEpoch()
  const [settings, setSettings] = useState<SelfHealSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void invoke('config.resolve', {}).then((r) => {
        if (!alive) return
        if (r.ok) {
          setSettings(r.value.config.selfHeal)
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

/** vendors.models for the chosen vendor, read once the section has loaded its values. */
function useModels(vendor: string | null): ModelOption[] {
  const [list, setList] = useState<{ vendor: string; models: ModelOption[] } | null>(null)
  // Read again when the catalog changes (an applied update can add models or prices).
  const catalogEpoch = useCatalogEpoch()
  useEffect(() => {
    if (vendor === null) return
    let alive = true
    void invoke('vendors.models', { vendor }).then((r) => {
      if (alive) setList({ vendor, models: r.ok ? r.value : [] })
    })
    return () => {
      alive = false
    }
  }, [vendor, catalogEpoch])
  return list !== null && list.vendor === vendor ? list.models : []
}

/** The healer has a read-only row for Claude and Codex only (not Gemini). */
const canHeal = (vendor: string): boolean => (HEAL_VENDORS as readonly string[]).includes(vendor)

/** The vendor a heal runs on, in words, with why it may not be used. */
function vendorNote(chosen: string, probes: readonly ProbeView[]): string | null {
  const p = probes.find((x) => x.vendor === chosen)
  if (p === undefined) return null
  if (!canHeal(chosen)) {
    return `${p.displayName} cannot diagnose failures. Dim Factory uses the first ready of Claude and Codex instead.`
  }
  if (p.health === 'ready' || p.health === 'warning' || p.checking) return null
  return `${p.displayName} is not ready (${p.healthDetail}). Dim Factory uses the first ready vendor instead.`
}

function modelText(m: Pick<ModelOption, 'id' | 'label'>): string {
  return m.label !== undefined && m.label !== m.id ? `${m.label} (${m.id})` : m.id
}

/** Loads the snapshots of the most recent runs (after the delay), then lists their heals, newest first. */
function useHealHistory(): HealEntry[] {
  useEffect(() => {
    const t = setTimeout(() => {
      for (const id of useStore.getState().summaries.order.slice(0, HISTORY_RUNS)) ensureRun(id)
    }, LOAD_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  const runs = useStore((s) => s.runs.byId)
  return useMemo(() => collectHeals(runs, HISTORY_SIZE), [runs])
}

function whatItSaid(e: HealEntry): string {
  const h = e.heal
  switch (h.status) {
    case 'ok':
    case 'cached':
      return h.diagnosis !== undefined && h.diagnosis.trim() !== '' ? diagnosisText(h) : 'No diagnosis'
    case 'failed':
      return h.error !== undefined && h.error !== '' ? h.error : 'The diagnosis failed'
    case 'disabled':
      return 'Self-heal was off'
    case 'running':
      return 'Diagnosing'
  }
}

function HealHistory(): React.JSX.Element {
  const entries = useHealHistory()
  const now = useNow(entries.length > 0)
  return (
    <div className={SETTINGS_TABLE.frame}>
      <table aria-label="Last 10 diagnoses" data-testid="selfheal-history" className={SETTINGS_TABLE.table}>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {HISTORY_COLUMNS.map((c) => (
              <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={HISTORY_COLUMNS.length} className="px-2 py-3 text-muted-foreground">
                {HISTORY_EMPTY}
              </td>
            </tr>
          ) : (
            entries.map((e) => (
              <tr
                key={`${e.runId}:${e.step}:${e.heal.at}`}
                data-testid={`selfheal-row-${e.runId}-${e.step}`}
                className="border-t"
              >
                <td className={SETTINGS_TABLE.cell} title={new Date(e.heal.at).toLocaleString()}>
                  {formatAgo(e.heal.at, now)}
                  {e.heal.trigger === 'auto' && (
                    <span className="block text-muted-foreground">Automatic</span>
                  )}
                </td>
                <td className={SETTINGS_TABLE.cell}>
                  <a
                    href={href({ name: 'run', runId: e.runId })}
                    title={e.title}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    #{e.displayNo} · {stepLabel(e.step)}
                  </a>
                </td>
                <td className={SETTINGS_TABLE.cell}>
                  {e.category !== undefined ? categoryTitle(e.category) : 'Not known'}
                </td>
                <td className={SETTINGS_TABLE.cell}>{whatItSaid(e)}</td>
                <td className={SETTINGS_TABLE.cell}>
                  {healResultText(e.heal)}
                  {e.heal.autoApplied !== undefined && (
                    <span className="block text-muted-foreground">Applied on its own</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A picker's place while the values load: drawn like the Select trigger at the same size, disabled. The Radix Select
 * itself mounts once there is a value to show, so opening the section stays quick (performance.spec.ts) and nothing moves when it does.
 */
function PickerPlaceholder({
  testId,
  label,
  className,
}: {
  testId: string
  label: string
  className: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled
      data-testid={testId}
      aria-label={label}
      className={cn(
        'flex h-7 max-w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-xs whitespace-nowrap text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span className="truncate">Loading…</span>
      <ChevronDown aria-hidden className="size-4 shrink-0 opacity-60" />
    </button>
  )
}

export function SelfHealSection(): React.JSX.Element {
  const { settings, error, setLocal, reload } = useResolvedSelfHeal()
  const probes = useProbes()
  const [writing, setWriting] = useState<Key | null>(null)
  const models = useModels(settings?.vendor ?? null)

  const undoWrite = async (res: ConfigWriteResult, key: Key): Promise<void> => {
    const r =
      res.backupId !== null
        ? await invoke('config.restoreBackup', { scope: 'user', backupId: res.backupId })
        : await invoke('config.patch', { scope: 'user', ops: [{ op: 'remove', path: pointer(key) }] })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    reload()
  }

  const write = async <K extends Key>(key: K, value: SelfHealSettings[K], said: string): Promise<void> => {
    if (settings === null || settings[key] === value) return
    const before = settings
    setLocal({ ...settings, [key]: value })
    setWriting(key)
    const r = await invoke('config.patch', {
      scope: 'user',
      ops: [{ op: 'replace', path: pointer(key), value }],
    })
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
      action: { label: 'Undo', onClick: () => undoWrite(res, key) },
    })
  }

  const off = settings === null
  // This build's vendors that can heal (stubs of later vendors and Gemini are left out), and the configured one
  // even when it is not here (its note says what runs instead).
  const vendors = probes.filter((p) => p.built && canHeal(p.vendor))
  const chosen = settings?.vendor ?? ''
  const vendorRows =
    chosen !== '' && !vendors.some((p) => p.vendor === chosen)
      ? [
          { vendor: chosen, displayName: probes.find((p) => p.vendor === chosen)?.displayName ?? chosen },
          ...vendors,
        ]
      : vendors
  const vendorWarning = settings !== null ? vendorNote(settings.vendor, probes) : null
  const model = settings?.model ?? null
  const modelRows =
    model !== null && !models.some((m) => m.id === model) ? [{ id: model }, ...models] : models
  const cliDefault = models.find((m) => m.isDefault === true)

  return (
    <div className="flex flex-col gap-6" data-testid="settings-self-heal" aria-busy={off || undefined}>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The self-heal settings could not be read: {error}
        </p>
      )}
      <Group
        title="Diagnose failures with AI"
        description="A model reads the failed pass's error output, never your code, task or plan, and suggests fixes. Dim Factory drops any suggestion it does not consider safe."
      >
        <div>
          <SettingRow
            label={ENABLED_LABEL}
            description="When a pass fails for a reason Dim Factory does not recognise. You can always ask from a failed pass."
          >
            <Switch
              data-testid="selfheal-enabled"
              aria-label={ENABLED_LABEL}
              checked={settings?.enabled ?? false}
              disabled={off || writing === 'enabled'}
              onCheckedChange={(v) => void write('enabled', v, `${ENABLED_LABEL}: ${v ? 'on' : 'off'}`)}
            />
          </SettingRow>
          <SettingRow label="Vendor" description="Runs read-only, with no tools that change anything.">
            {settings === null ? (
              <PickerPlaceholder testId="selfheal-vendor" label="Self-heal vendor" className="w-44" />
            ) : (
              <Select
                value={chosen}
                onValueChange={(v) => void write('vendor', v, `Self-heal vendor: ${v}`)}
                disabled={writing === 'vendor'}
              >
                <SelectTrigger
                  size="sm"
                  className="w-44 max-w-full"
                  data-testid="selfheal-vendor"
                  aria-label="Self-heal vendor"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vendorRows.map((p) => (
                    <SelectItem key={p.vendor} value={p.vendor}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingRow>
          <SettingRow label="Model">
            {settings === null ? (
              <PickerPlaceholder testId="selfheal-model" label="Self-heal model" className="w-64" />
            ) : (
              <Select
                value={model ?? CLI_DEFAULT}
                onValueChange={(v) => {
                  const next = v === CLI_DEFAULT ? null : v
                  void write(
                    'model',
                    next,
                    next === null ? "Self-heal uses the CLI's default model" : `Self-heal model: ${next}`,
                  )
                }}
                disabled={writing === 'model'}
              >
                <SelectTrigger
                  size="sm"
                  className="w-64 max-w-full"
                  data-testid="selfheal-model"
                  aria-label="Self-heal model"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CLI_DEFAULT}>
                    {cliDefault !== undefined ? `The CLI's default (${cliDefault.id})` : "The CLI's default"}
                  </SelectItem>
                  {modelRows.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {modelText(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingRow>
          <SettingRow
            label={AUTO_APPLY_LABEL}
            description="Only model, timeout and vendor flag changes. Each one uses the pass's automatic retry."
          >
            <Switch
              data-testid="selfheal-autoapply"
              aria-label={AUTO_APPLY_LABEL}
              checked={settings?.autoApplyConfigPatches ?? false}
              disabled={off || writing === 'autoApplyConfigPatches'}
              onCheckedChange={(v) =>
                void write('autoApplyConfigPatches', v, `${AUTO_APPLY_LABEL}: ${v ? 'on' : 'off'}`)
              }
            />
          </SettingRow>
        </div>
        {/* Reserved: the note comes and goes with the vendor's health, so its line is always there. */}
        <p role="status" data-testid="selfheal-vendor-note" className="min-h-4 text-xs text-muted-foreground">
          {vendorWarning ?? ''}
        </p>
      </Group>
      <Group title="Last 10 diagnoses" description="From your recent runs. Read-only.">
        <HealHistory />
      </Group>
    </div>
  )
}
