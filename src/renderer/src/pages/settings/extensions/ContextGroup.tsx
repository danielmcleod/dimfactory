// Settings > Extensions > Context: the chosen project's Context report (core's `context.report{folder}`: what loads
// into its passes over its recent runs, how often runs with each one failed or had AI claims that did not match the
// run, and suggestions) and the context health options (user settings, written with config.patch and an Undo toast).
// UI standards: the report's one line is there from the start and the table opens only on a click (a <details>), so
// nothing below moves on its own; the table is part of the page (no scrollbar of its own); the switches never resize.
import { useEffect, useState } from 'react'
import type { CompactionReminder } from '@shared/config-schema.ts'
import type { ContextReport } from '@shared/context.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { invoke } from '../../../ipc/client.ts'
import { stepLabel } from '../../../lib/format.ts'
import { pointer, writeConfig } from '../general/configWrite.ts'
import { Group, SETTINGS_TABLE, SettingRow } from '../kit.tsx'
import { useSectionData } from '../sectionData.ts'
import {
  CONTEXT_GROUP_DESCRIPTION,
  CONTEXT_GROUP_TITLE,
  GROUNDING_LABEL,
  GROUNDING_NOTE,
  JUDGE_LABEL,
  JUDGE_NOTE,
  REGISTRY_LABEL,
  REGISTRY_NOTE,
  REMINDER_LABEL,
  REMINDER_NOTE,
  REMINDER_OPTIONS,
  contextOptionsOf,
  kindLabel,
  liftText,
  optionSavedText,
  recommendationText,
  reportSummaryText,
  tokensText,
} from './contextReport.ts'
import type { ContextOptionKey } from './contextReport.ts'

const UNDO_TOAST = 'context-health-undo'

type ContextOptions = NonNullable<ReturnType<typeof contextOptionsOf>>

export function ContextGroup({
  folder,
  config,
  epoch,
  onSettled,
}: {
  /** The project chosen above (null: none, so no report). */
  folder: string | null
  /** Core's resolved config (null while it loads). */
  config: unknown
  /** The config epoch: the report is read again after a config change. */
  epoch: number
  /** After a write and its Undo (the section reads the config again). */
  onSettled: () => void
}): React.JSX.Element {
  const report = useSectionData<ContextReport>(
    folder !== null ? `context\u0000${folder}` : null,
    () => invoke('context.report', { folder: folder ?? '' }),
    epoch,
  )
  const resolved = contextOptionsOf(config)
  const [pending, setPending] = useState<Partial<ContextOptions>>({})
  const [busy, setBusy] = useState<ContextOptionKey | null>(null)
  useEffect(() => setPending({}), [config])
  const shown = resolved !== null ? { ...resolved, ...pending } : null
  const off = shown === null

  const write = (key: ContextOptionKey, value: boolean | CompactionReminder): void => {
    setPending((p) => ({ ...p, [key]: value }))
    setBusy(key)
    void writeConfig({
      target: { scope: 'user' },
      ops: [{ op: 'add', path: pointer('contextHealth', key), value }],
      message: optionSavedText(key, value),
      toastId: UNDO_TOAST,
      onSettled,
    }).then((res) => {
      setBusy(null)
      if (res === null)
        setPending((p) => {
          const { [key]: _gone, ...rest } = p
          return rest
        })
    })
  }

  const r = folder !== null ? report.value : null
  const rows = r?.rows ?? []

  return (
    <Group title={CONTEXT_GROUP_TITLE} description={CONTEXT_GROUP_DESCRIPTION} testId="extensions-context">
      <div>
        <SettingRow label={GROUNDING_LABEL} description={GROUNDING_NOTE} field="/contextHealth/grounding">
          <Switch
            data-testid="context-grounding"
            aria-label={GROUNDING_LABEL}
            checked={shown?.grounding === true}
            disabled={off || busy === 'grounding'}
            onCheckedChange={(v) => write('grounding', v)}
          />
        </SettingRow>
        <SettingRow label={REGISTRY_LABEL} description={REGISTRY_NOTE} field="/contextHealth/registryCheck">
          <Switch
            data-testid="context-registry"
            aria-label={REGISTRY_LABEL}
            checked={shown?.registryCheck === true}
            disabled={off || busy === 'registryCheck'}
            onCheckedChange={(v) => write('registryCheck', v)}
          />
        </SettingRow>
        <SettingRow label={JUDGE_LABEL} description={JUDGE_NOTE} field="/contextHealth/aiJudge">
          <Switch
            data-testid="context-judge"
            aria-label={JUDGE_LABEL}
            checked={shown?.aiJudge === true}
            disabled={off || busy === 'aiJudge'}
            onCheckedChange={(v) => write('aiJudge', v)}
          />
        </SettingRow>
        <SettingRow
          label={REMINDER_LABEL}
          description={REMINDER_NOTE}
          field="/contextHealth/compactionReminder"
        >
          <Select
            value={shown?.compactionReminder ?? 'off'}
            onValueChange={(v) => write('compactionReminder', v as CompactionReminder)}
            disabled={off || busy === 'compactionReminder'}
          >
            <SelectTrigger
              size="sm"
              className="w-40 max-w-full"
              data-testid="context-reminder"
              aria-label={REMINDER_LABEL}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMINDER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div
        className="flex min-h-20 flex-col gap-2"
        data-setting-field="contextReport"
        data-testid="context-report"
        aria-busy={(folder !== null && report.value === null && report.error === null) || undefined}
      >
        <h4 className="text-xs font-medium text-muted-foreground">Project report</h4>
        {/* Two lines kept from the start: the answer arrives without moving anything below. */}
        <p role="status" className="min-h-8 text-xs" data-testid="context-report-summary">
          {folder === null
            ? 'Choose a project above to see what loads into its passes.'
            : reportSummaryText(r, report.loading, report.error)}
        </p>
        {r !== null && rows.length > 0 && (
          <details className="text-xs" data-testid="context-report-details">
            <summary className="cursor-pointer text-primary select-none">
              Contributors and suggestions
            </summary>
            <div className="mt-2 flex flex-col gap-3">
              {r.recommendations.length > 0 && (
                <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="context-report-suggestions">
                  {r.recommendations.map((rec) => (
                    <li key={`${rec.kind}-${rec.key}-${rec.kind === 'lift' ? rec.what : ''}`}>
                      {recommendationText(rec)}
                    </li>
                  ))}
                </ul>
              )}
              <div className={SETTINGS_TABLE.frame}>
                <table className={SETTINGS_TABLE.table} data-testid="context-report-table">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className={`${SETTINGS_TABLE.cell} w-[28%]`}>Name</th>
                      <th className={SETTINGS_TABLE.cell}>Kind</th>
                      <th className={SETTINGS_TABLE.cell}>Size</th>
                      <th className={SETTINGS_TABLE.cell}>Runs</th>
                      <th className={SETTINGS_TABLE.cell}>Failures</th>
                      <th className={SETTINGS_TABLE.cell}>Claims not matching</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-t" data-testid={`context-row-${row.key}`}>
                        <td className={`${SETTINGS_TABLE.cell} font-medium`}>{row.name}</td>
                        <td className={SETTINGS_TABLE.cell}>{kindLabel(row.kind)}</td>
                        <td className={SETTINGS_TABLE.cell}>
                          {tokensText(row.tokens)}
                          <span className="block text-muted-foreground">
                            {row.steps.map((s) => stepLabel(s)).join(', ')}
                          </span>
                        </td>
                        <td className={`${SETTINGS_TABLE.cell} tabular-nums`}>{row.runs}</td>
                        <td className={SETTINGS_TABLE.cell}>{liftText(row.failureLift, row.failureRate)}</td>
                        <td className={SETTINGS_TABLE.cell}>
                          {liftText(row.groundingLift, row.groundingRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground">
                Failures and claims compare runs that loaded each one with this project&rsquo;s average. Dim
                Factory keeps these names out of its logs.
              </p>
            </div>
          </details>
        )}
      </div>
    </Group>
  )
}
