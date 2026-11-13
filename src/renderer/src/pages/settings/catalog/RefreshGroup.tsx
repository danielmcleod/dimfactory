// Settings → Catalog's refresh controls (schedule, AI vendor; `catalog.refresh` {enabled, intervalDays, vendor,
// model}). The schedule presets Off/7/14/30 go through
// catalog.setSchedule (Undo puts the old schedule back); the vendor and model are config writes (config.patch, user
// file, with Undo). Codex can read the price pages too (X17: read-only, ephemeral, web search) once its probe says
// it is installed and logged in; until then it is listed disabled with why (its health, or "Available in a later
// version" for a build without it). Choosing another vendor puts the model back to that vendor's CLI default in the
// same write. Core's plan still decides and says when it falls back (`fallbackNote`).
// Update now asks with the consent card's words and sends catalog.refresh `{consent: true}` only from its click.
//
// These are the section's fixed controls: their lines are reserved before core answers (one line each, cut with a
// tooltip), so nothing below them moves when the schedule, the plan or the job's state arrive or change.
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { CatalogJob, CatalogStatus } from '@shared/catalog.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../../../components/ui/DisabledHint.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { useCoreNow } from '../../../lib/coreClock.ts'
import { vendorName } from '../../../lib/format.ts'
import { modelOptionText, pickerOptions } from '../../../lib/modelOptions.ts'
import { setCatalogSchedule, startRefresh, useCatalogEpoch } from '../../../state/catalog.ts'
import { useConfigEpoch, useProbe } from '../../../state/selectors.ts'
import { toast } from '../../../state/toasts.ts'
import { Group, SettingRow } from '../kit.tsx'
import { changesText, consentLine, consentTitle, jobLine, planFacts, useRefreshPlan } from './consent.ts'
import {
  SCHEDULE_PRESETS,
  scheduleFacts,
  scheduleLabel,
  scheduleRestore,
  scheduleSaid,
  scheduleUpdate,
  scheduleValue,
} from './model.ts'

interface VendorChoice {
  id: string
  /** Why it cannot read the price pages now (listed, disabled, with this reason). */
  reason?: string
}

/** The vendors that can read price pages (Claude, and Codex's X17 route). */
export const REFRESH_VENDORS: readonly VendorChoice[] = [{ id: 'claude' }, { id: 'codex' }]

/**
 * Why Codex cannot read the price pages now, from its probe; null when it can. A build without Codex (a stub, or no
 * probe at all) is "Available in a later version", as switch_vendor says it. The refresh runs read-only, so a Windows
 * sandbox that is not set up does not stop it (only "Approve edits" needs the sandbox).
 */
export function refreshVendorReason(view: ProbeView | undefined): string | null {
  if (view === undefined || !view.built || view.health === 'not-built') return LATER_VERSION
  if (view.checking || view.health === 'checking') return `Checking ${view.displayName}…`
  if (view.health !== 'ready' && view.health !== 'warning' && view.health !== 'sandbox-needed')
    return `${view.displayName} is not ready: ${view.healthDetail}`
  const caps = view.probe?.capabilities as { web?: unknown } | undefined
  if (caps?.web === false) return `${view.displayName} cannot search the web here`
  return null
}

export const UPDATE_RUNNING_REASON = 'An update is running. Cancel it below to start another.'
const WRITE_TOAST = 'catalog-refresh-config'

/** Select value for "the CLI's own default model" (Radix Select reserves the empty string). */
export const CLI_DEFAULT = '__cli_default__'

type RefreshKey = 'vendor' | 'model'
interface RefreshConfig {
  vendor: string
  /** null: the CLI's default model. */
  model: string | null
}

/** The user's `catalog.refresh` vendor and model (config.resolve), read once the section is open. */
function useRefreshConfig(opened: boolean): {
  value: RefreshConfig | null
  error: string | null
  setLocal: (v: RefreshConfig) => void
  reload: () => void
} {
  const epoch = useConfigEpoch()
  const [value, setValue] = useState<RefreshConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!opened) return
    let alive = true
    void invoke('config.resolve', {}).then((r) => {
      if (!alive) return
      if (r.ok) {
        const refresh = r.value.config.catalog.refresh
        setValue({ vendor: refresh.vendor, model: refresh.model })
        setError(null)
      } else setError(r.error.message)
    })
    return () => {
      alive = false
    }
  }, [opened, epoch, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { value, error, setLocal: setValue, reload }
}

/** vendors.models for the refresh vendor, read again when the catalog changes. */
function useModels(vendor: string | null): ModelOption[] {
  const epoch = useCatalogEpoch()
  const [list, setList] = useState<{ vendor: string; models: ModelOption[] } | null>(null)
  useEffect(() => {
    if (vendor === null) return
    let alive = true
    void invoke('vendors.models', { vendor }).then((r) => {
      if (alive) setList({ vendor, models: r.ok ? r.value : [] })
    })
    return () => {
      alive = false
    }
  }, [vendor, epoch])
  return list !== null && list.vendor === vendor ? list.models : []
}

/** A dropdown's place until its value is known: drawn like the trigger, disabled. */
function Placeholder({
  testId,
  label,
  text,
  className,
}: {
  testId: string
  label: string
  text: string
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
      <span className="truncate">{text}</span>
      <ChevronDown aria-hidden className="size-4 shrink-0 opacity-60" />
    </button>
  )
}

export interface RefreshGroupProps {
  /** The section has been open SECTION_LOAD_DELAY_MS: core may be asked. */
  opened: boolean
  /** Core's status once the catalog has been read in this visit (null before, or when it could not be read). */
  status: CatalogStatus | null
  job: CatalogJob | null
  /** The catalog could not be read (the schedule then has no value to show). */
  failed: boolean
  /** The changes found are not on screen (the review was closed): bring them back. */
  onReview?: (() => void) | undefined
}

export function RefreshGroup({
  opened,
  status,
  job,
  failed,
  onReview,
}: RefreshGroupProps): React.JSX.Element {
  const config = useRefreshConfig(opened)
  const codexView = useProbe('codex')
  const plan = useRefreshPlan(opened)
  const models = useModels(config.value?.vendor ?? null)
  const now = useCoreNow(job?.state === 'running')
  const [writing, setWriting] = useState<RefreshKey | 'schedule' | null>(null)
  const [starting, setStarting] = useState(false)

  const pointer = (key: RefreshKey): string => `/catalog/refresh/${key}`

  const undoWrite = async (res: ConfigWriteResult, keys: readonly RefreshKey[]): Promise<void> => {
    const r =
      res.backupId !== null
        ? await invoke('config.restoreBackup', { scope: 'user', backupId: res.backupId })
        : await invoke('config.patch', {
            scope: 'user',
            ops: keys.map((key) => ({ op: 'remove' as const, path: pointer(key) })),
          })
    if (!r.ok) toast({ level: 'error', message: r.error.message })
    config.reload()
  }

  /**
   * One config write with Undo. A new vendor also puts the model back to that vendor's CLI default, since a model
   * id belongs to its vendor (Codex cannot run "sonnet"); Undo puts both back.
   */
  const write = async (key: RefreshKey, value: string | null, said: string): Promise<void> => {
    const cur = config.value
    if (cur === null || cur[key] === value) return
    const next: RefreshConfig =
      key === 'vendor' && value !== null ? { vendor: value, model: null } : { ...cur, [key]: value }
    const keys = (['vendor', 'model'] as const).filter((k) => next[k] !== cur[k])
    config.setLocal(next)
    setWriting(key)
    const r = await invoke('config.patch', {
      scope: 'user',
      ops: keys.map((k) => ({ op: 'replace' as const, path: pointer(k), value: next[k] })),
    })
    setWriting(null)
    if (!r.ok) {
      config.setLocal(cur)
      toast({ level: 'error', message: r.error.message })
      return
    }
    const res = r.value
    toast({
      id: WRITE_TOAST,
      level: 'info',
      message: said,
      action: { label: 'Undo', onClick: () => undoWrite(res, keys) },
    })
  }

  const schedule = status?.schedule ?? null
  const chosenSchedule = schedule !== null ? scheduleValue(schedule) : null
  const scheduleItems =
    chosenSchedule !== null && !SCHEDULE_PRESETS.some((p) => p.value === chosenSchedule)
      ? [...SCHEDULE_PRESETS, { value: chosenSchedule, label: scheduleLabel(chosenSchedule) }]
      : SCHEDULE_PRESETS

  const chooseSchedule = async (value: string): Promise<void> => {
    if (schedule === null || value === chosenSchedule) return
    setWriting('schedule')
    await setCatalogSchedule(scheduleUpdate(value), scheduleSaid(value), scheduleRestore(schedule))
    setWriting(null)
  }

  const vendor = config.value?.vendor ?? null
  const codexReason = refreshVendorReason(codexView)
  const choices: readonly VendorChoice[] = REFRESH_VENDORS.map((v) =>
    v.id === 'codex' && codexReason !== null ? { ...v, reason: codexReason } : v,
  )
  const vendorRows: readonly VendorChoice[] =
    vendor !== null && !choices.some((v) => v.id === vendor) ? [{ id: vendor }, ...choices] : choices
  const model = config.value?.model ?? null
  const modelRows = pickerOptions(models, model)
  const cliDefault = models.find((m) => m.isDefault === true)

  const running = job?.state === 'running'
  const canStart = status !== null && !running && !starting
  const update = async (): Promise<void> => {
    setStarting(true)
    await startRefresh(plan.status === 'ok' ? plan.plan : undefined)
    setStarting(false)
  }

  // One line of state beside Update now: the job's, else the schedule's.
  const line =
    job !== null && (job.state === 'running' || job.state === 'diff-ready' || job.state === 'failed')
      ? job.state === 'diff-ready'
        ? `${changesText(job.diff?.rows.length ?? 0)}.`
        : jobLine(job, now)
      : schedule !== null
        ? scheduleFacts(schedule, status?.refreshDue === true, now)
        : ''
  const note = plan.status === 'ok' ? (plan.plan.fallbackNote ?? '') : ''
  const consent = consentLine(plan.status === 'ok' ? plan.plan : null)
  const facts = planFacts(plan)

  const updateButton = (
    <Button
      size="sm"
      data-testid="catalog-update"
      icon={<RefreshCw aria-hidden />}
      loading={starting}
      disabled={!canStart}
      onClick={() => void update()}
    >
      Update now
    </Button>
  )

  return (
    <Group
      title="Update prices with AI"
      description="A model with web search reads the vendors' official price pages and proposes new prices for you to review. It never runs by itself."
    >
      <div>
        <SettingRow label="Check prices every" field="/catalog/refresh/intervalDays">
          {chosenSchedule === null ? (
            <Placeholder
              testId="catalog-schedule"
              label="Refresh interval"
              text={failed ? 'Not available' : 'Loading…'}
              className="w-32"
            />
          ) : (
            <Select
              value={chosenSchedule}
              onValueChange={(v) => void chooseSchedule(v)}
              disabled={writing === 'schedule'}
            >
              <SelectTrigger
                size="sm"
                className="w-32"
                data-testid="catalog-schedule"
                aria-label="Refresh interval"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scheduleItems.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingRow>
        <SettingRow
          label="Vendor that reads the price pages"
          description="Read-only, with web search. It cannot change files."
          field="/catalog/refresh/vendor"
        >
          {vendor === null ? (
            <Placeholder
              testId="catalog-refresh-vendor"
              label="Refresh vendor"
              text={config.error !== null ? 'Not available' : 'Loading…'}
              className="w-44"
            />
          ) : (
            <Select
              value={vendor}
              onValueChange={(v) => void write('vendor', v, `Prices are read by ${vendorName(v)}`)}
              disabled={writing === 'vendor'}
            >
              <SelectTrigger
                size="sm"
                className="w-44 max-w-full"
                data-testid="catalog-refresh-vendor"
                aria-label="Refresh vendor"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vendorRows.map((v) => (
                  <SelectItem
                    key={v.id}
                    value={v.id}
                    disabled={v.reason !== undefined && v.id !== vendor}
                    data-testid={`catalog-refresh-vendor-${v.id}`}
                  >
                    {v.reason !== undefined ? `${vendorName(v.id)} (${v.reason})` : vendorName(v.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingRow>
        <SettingRow label="Model" field="/catalog/refresh/model">
          {config.value === null ? (
            <Placeholder
              testId="catalog-refresh-model"
              label="Refresh model"
              text={config.error !== null ? 'Not available' : 'Loading…'}
              className="w-64"
            />
          ) : (
            <Select
              value={model ?? CLI_DEFAULT}
              onValueChange={(v) => {
                const next = v === CLI_DEFAULT ? null : v
                void write(
                  'model',
                  next,
                  next === null
                    ? "Prices are read with the CLI's default model"
                    : `Prices are read with ${next}`,
                )
              }}
              disabled={writing === 'model'}
            >
              <SelectTrigger
                size="sm"
                className="w-64 max-w-full"
                data-testid="catalog-refresh-model"
                aria-label="Refresh model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CLI_DEFAULT}>
                  {cliDefault !== undefined ? `The CLI's default (${cliDefault.id})` : "The CLI's default"}
                </SelectItem>
                {modelRows.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {modelOptionText(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingRow>
      </div>
      <div data-setting-field="update" className="flex flex-col gap-1.5">
        <p
          data-testid="catalog-consent"
          title={consentTitle(plan.status === 'ok' ? plan.plan : null)}
          className="truncate text-xs font-medium"
        >
          {consent}
        </p>
        <p
          data-testid="catalog-estimate"
          title={facts}
          className="truncate text-xs text-muted-foreground tabular-nums"
        >
          {facts}
        </p>
        <div className="flex min-w-0 items-center gap-2">
          {running ? (
            <DisabledHint reason={UPDATE_RUNNING_REASON}>{updateButton}</DisabledHint>
          ) : (
            updateButton
          )}
          <p
            role="status"
            data-testid="catalog-refresh-status"
            title={line}
            className={cn(
              'min-w-0 flex-1 truncate text-xs tabular-nums',
              job?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {line}
          </p>
          {onReview !== undefined && job?.state === 'diff-ready' && (
            <Button size="sm" variant="outline" data-testid="catalog-review-open" onClick={onReview}>
              Review changes
            </Button>
          )}
        </div>
        <p data-testid="catalog-refresh-note" title={note} className="min-h-4 truncate text-xs text-warning">
          {note}
        </p>
      </div>
    </Group>
  )
}
