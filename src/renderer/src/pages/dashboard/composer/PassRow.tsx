// One pass row of the Quick composer (per-pass keys and their provenance). Collapsed it
// is one line, `Plan · Claude · opus · Native plan ▾`; expanded it offers Vendor, Model, Mode and On/off, each with
// core's provenance badge, plus [Save to project] and [Reset]. Every value shown is core's resolved answer; a change
// becomes a run override that the composer sends back to core. A mode the vendor's probe marks unsupported (Codex's
// "Approve edits" without its Windows sandbox) or limited says so in the mode list, and core's mode copy under Mode
// takes the colour of core's `pass.<p>.mode` check (amber limited, red not available); a local preset's model box
// says the preset's model is used when it is empty. A vendor picked from "More" (Gemini) is probed, its choice
// reading "Checking…" until core answers; its mode list and copy are core's like any vendor's (Gemini ACP: read-only
// rejects every ask, "Approve edits" asks for shell and other tools, "Approve everything" with Auto only).
import { Save, Undo2 } from 'lucide-react'
import { useId } from 'react'
import type { ProvenanceMap } from '@shared/config-schema.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import type { ComposerSuggestions } from '@shared/ipc.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { Mode, PassName } from '@shared/run.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
import { supportsEffort } from '@shared/vendors.ts'
import { EXTENSION_LEVEL_LABEL, defaultExtensionLevel, isReadOnlyExtensionsPass } from '@shared/extensions.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import { stepLabel } from '../../../lib/format.ts'
import { FixSessionSelect, fixSessionReason } from './FixRow.tsx'
import { EffortSelect } from './EffortSelect.tsx'
import { ExtensionsCopy, ExtensionsSelect } from './ExtensionsSelect.tsx'
import {
  effortAfterModel,
  extensionsOf,
  fixResumeCheck,
  fixSessionOf,
  isRunProvenance,
  localPresetOf,
  localPresetVendors,
  MODE_LABEL,
  modeChoiceNote,
  modeChoices,
  modeCopy,
  modeCopyStatus,
  modeSupportOf,
  modelHasNoPricing,
  modelText,
  passEstimateText,
  passOf,
  PASSTHROUGH_NOT_SAVED,
  planModeText,
  provenanceAt,
  READ_ONLY_PASSES,
  vendorChoiceText,
  vendorChoices,
  vendorText,
  FIX_SESSION_LABEL,
} from './model.ts'
import type { FixSession, ResolvedView } from './model.ts'
import { ModelField } from './ModelField.tsx'
import type { FixField, PassValues } from './overrides.ts'
import { probePicked } from './probePick.ts'
import { ProvenanceBadge } from './ProvenanceBadge.tsx'

export interface PassRowProps {
  pass: PassName
  config: ResolvedView
  provenance: ProvenanceMap
  probes: readonly ProbeView[]
  report: PreflightReport | null
  estimate: RunEstimate | null
  models: readonly ModelOption[] | null
  open: boolean
  onToggle: () => void
  /** The row has run overrides (Save to project / Reset apply). */
  overridden: boolean
  /** Why Save to project is unavailable (no folder yet), else null. */
  saveBlocked: string | null
  onChange: (values: PassValues, remove?: readonly FixField[]) => void
  onSave: () => void
  onReset: () => void
  onWantModels: (vendor: string) => void
  /** Core's Critic swap and Fix session answers (config.resolve suggestions). */
  suggestions?: ComposerSuggestions | undefined
  /** Fix only: the vendor "Fresh, different vendor" would use, and choosing a session. */
  otherFixVendor?: string | null
  onFixSession?: (session: FixSession) => void
  saving?: boolean
}

/** `Plan · Claude · opus · Native plan`. */
export function passSummary(
  pass: PassName,
  config: ResolvedView,
  probes: readonly ProbeView[],
  report: PreflightReport | null,
  suggestions?: ComposerSuggestions,
): string {
  const p = passOf(config, pass)
  const head = stepLabel(pass)
  if (!p.enabled) return `${head} · off`
  const parts = [head, vendorText(p.vendor, config, probes), modelText(p.model)]
  if (p.effort !== undefined && p.effort !== null && supportsEffort(p.vendor))
    parts.push(`${p.effort} effort`)
  if (pass === 'plan') parts.push(planModeText(report) ?? MODE_LABEL[p.mode])
  else if (pass === 'fix') parts.push(FIX_SESSION_LABEL[fixSessionOf(config, suggestions)])
  else parts.push(MODE_LABEL[p.mode])
  // A level other than the pass's default is said on the collapsed row too.
  const level = extensionsOf(p, pass)
  if (level !== defaultExtensionLevel(pass)) parts.push(EXTENSION_LEVEL_LABEL[level])
  return parts.join(' · ')
}

function Field({
  label,
  htmlFor,
  labelId,
  children,
  badge,
}: {
  label: string
  htmlFor?: string
  labelId?: string
  children: React.ReactNode
  badge: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <label id={labelId} htmlFor={htmlFor} className="w-16 shrink-0 text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {badge}
    </div>
  )
}

export function PassRow(props: PassRowProps): React.JSX.Element {
  const { pass, config, provenance, probes, report, estimate, open, overridden } = props
  const id = useId()
  const p = passOf(config, pass)
  const label = stepLabel(pass)
  const prov = (field: string) => provenanceAt(provenance, pass, field)
  const runOverride = ['vendor', 'model', 'effort', 'mode', 'enabled', 'extensions'].some((f) =>
    isRunProvenance(prov(f)),
  )
  const level = extensionsOf(p, pass)
  // A project file cannot carry a read-only pass's Pass through: Save to project says so instead of failing.
  const saveBlocked =
    props.saveBlocked ??
    (isReadOnlyExtensionsPass(pass) && level === 'passthrough' && isRunProvenance(prov('extensions'))
      ? PASSTHROUGH_NOT_SAVED
      : null)
  const auto = config.auto
  const readOnly = READ_ONLY_PASSES.has(pass)
  const choices = vendorChoices(probes, localPresetVendors(config), p.vendor)
  const chosen = choices.find((c) => c.id === p.vendor)
  const modes = modeChoices(pass, auto)
  // Read-only passes have one mode; under Auto core resolves Implement and Fix to "Approve everything".
  const modeLocked = readOnly || auto
  const modeHint = readOnly
    ? `${label} always runs read-only`
    : auto
      ? 'Auto approves everything for Implement and Fix. Turn Auto off to choose.'
      : null
  const copy = modeCopy(report, pass)
  const copyStatus = modeCopyStatus(report, pass)
  // A local preset runs on Codex: Codex's probe says what each mode can do there.
  const preset = localPresetOf(config, p.vendor)
  const vendorView = probes.find((v) => v.vendor === (preset !== undefined ? 'codex' : p.vendor))
  const est = passEstimateText(estimate?.steps[pass])
  const summary = passSummary(pass, config, probes, report, props.suggestions)
  const panelId = `${id}-panel`

  const vendorSelect = (
    <Select
      value={p.vendor}
      onValueChange={(v) => {
        if (v === p.vendor) return
        // Another vendor's model and effort level would not run here.
        props.onChange({ vendor: v, model: null, effort: null })
        // A vendor picked from "More" is probed; its choice reads Checking… meanwhile.
        const picked = choices.find((c) => c.id === v)
        if (picked?.group === 'more' && localPresetOf(config, v) === undefined) void probePicked(v)
      }}
    >
      <SelectTrigger
        size="sm"
        data-testid={`pass-vendor-${pass}`}
        aria-labelledby={`${id}-vendor`}
        className="w-44"
        // The whole choice ("Muse · Experimental · …") when the trigger cuts it.
        title={chosen !== undefined ? vendorChoiceText(chosen) : undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {choices
            .filter((c) => c.group === 'primary')
            .map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={c.disabled} title={c.title}>
                {vendorChoiceText(c)}
              </SelectItem>
            ))}
        </SelectGroup>
        {choices.some((c) => c.group === 'more') && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>More</SelectLabel>
              {choices
                .filter((c) => c.group === 'more')
                .map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={c.disabled} title={c.title}>
                    {vendorChoiceText(c)}
                  </SelectItem>
                ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )

  const modeText = (m: Mode): string => {
    const note = modeChoiceNote(vendorView, m)
    return `${MODE_LABEL[m]}${note !== '' ? ` · ${note}` : ''}`
  }
  const modeSelect = (
    <Select
      value={p.mode}
      disabled={modeLocked}
      onValueChange={(v) => {
        if (v !== p.mode) props.onChange({ mode: v as Mode })
      }}
    >
      <SelectTrigger
        size="sm"
        data-testid={`pass-mode-${pass}`}
        aria-labelledby={`${id}-mode`}
        className="w-44"
        // The whole choice ("Approve edits · limited") when the trigger cuts it.
        title={modeText(p.mode)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(modes.includes(p.mode) ? modes : [...modes, p.mode]).map((m) => {
          // Still offered when the vendor cannot run it here: choosing it lets core's preflight say why and offer its
          // fix (Codex's "Approve edits" → the sandbox chip), where hiding it would leave the user no way to that fix.
          return (
            <SelectItem
              key={m}
              value={m}
              data-support={modeSupportOf(vendorView, m)?.status}
              title={modeSupportOf(vendorView, m)?.copy}
            >
              {modeText(m)}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )

  return (
    <li
      data-testid={`pass-row-${pass}`}
      data-run-override={runOverride || undefined}
      className={cn('rounded-md border-l-2', runOverride ? 'border-auto' : 'border-transparent')}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`pass-row-toggle-${pass}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={props.onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            !p.enabled && 'text-muted-foreground',
          )}
        >
          <span data-testid={`pass-summary-${pass}`} className="truncate">
            {summary}
          </span>
          <span
            aria-hidden
            className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
          >
            ▾
          </span>
        </button>
        {runOverride && !open && (
          <span
            className="text-[10px] font-semibold tracking-wide text-auto"
            aria-label={`${label} has run overrides`}
          >
            run
          </span>
        )}
        {est !== null && p.enabled && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{est}</span>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={`${label} settings`}
          className="flex flex-col gap-2 py-2 pr-2 pl-4"
        >
          <Field
            label="Vendor"
            labelId={`${id}-vendor`}
            badge={<ProvenanceBadge provenance={prov('vendor')} testId={`pass-provenance-${pass}-vendor`} />}
          >
            {vendorSelect}
          </Field>
          <Field
            label="Model"
            badge={<ProvenanceBadge provenance={prov('model')} testId={`pass-provenance-${pass}-model`} />}
          >
            <ModelField
              pass={pass}
              label={`${label} model`}
              value={p.model}
              options={props.models}
              noPricing={modelHasNoPricing(p.vendor, p.model, props.models, estimate)}
              {...(preset !== undefined ? { placeholder: `Preset model (${preset.model})` } : {})}
              onWantOptions={() => props.onWantModels(p.vendor)}
              onCommit={(model) => {
                // A level the new model does not list goes back to the default.
                const effort = p.effort ?? null
                const kept = effortAfterModel(props.models, model, effort)
                props.onChange(kept !== effort ? { model, effort: kept } : { model })
              }}
            />
          </Field>
          {supportsEffort(p.vendor) && (
            <Field
              label="Effort"
              badge={
                <ProvenanceBadge provenance={prov('effort')} testId={`pass-provenance-${pass}-effort`} />
              }
            >
              <EffortSelect
                id={pass}
                label={`${label} effort`}
                model={p.model}
                value={p.effort ?? null}
                options={props.models}
                onWantOptions={() => props.onWantModels(p.vendor)}
                onChange={(effort) => props.onChange({ effort })}
              />
            </Field>
          )}
          <Field
            label="Mode"
            labelId={`${id}-mode`}
            badge={<ProvenanceBadge provenance={prov('mode')} testId={`pass-provenance-${pass}-mode`} />}
          >
            {modeHint !== null ? (
              <Tooltip content={modeHint}>
                <span
                  tabIndex={0}
                  aria-label={`${label} mode: ${MODE_LABEL[p.mode]}. ${modeHint}`}
                  className="inline-flex rounded-md"
                >
                  {modeSelect}
                </span>
              </Tooltip>
            ) : (
              modeSelect
            )}
          </Field>
          {copy !== null && (
            <p
              data-testid={`pass-mode-copy-${pass}`}
              data-support={copyStatus ?? undefined}
              className={cn(
                'pl-18 text-xs',
                copyStatus === 'unsupported'
                  ? 'text-destructive'
                  : copyStatus === 'degraded'
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
            >
              {copy}
            </p>
          )}
          <Field
            label="Extensions"
            badge={
              <ProvenanceBadge
                provenance={prov('extensions')}
                testId={`pass-provenance-${pass}-extensions`}
              />
            }
          >
            <ExtensionsSelect
              id={pass}
              pass={pass}
              label={`${label} extensions`}
              value={level}
              onChange={(extensions) => props.onChange({ extensions })}
            />
          </Field>
          <ExtensionsCopy id={pass} pass={pass} vendor={p.vendor} value={level} className="pl-18" />
          <Field
            label="On"
            htmlFor={`${id}-enabled`}
            badge={
              <ProvenanceBadge provenance={prov('enabled')} testId={`pass-provenance-${pass}-enabled`} />
            }
          >
            <Switch
              id={`${id}-enabled`}
              data-testid={`pass-enabled-${pass}`}
              aria-label={`Run ${label}`}
              checked={p.enabled}
              onCheckedChange={(v) => props.onChange({ enabled: v })}
            />
          </Field>
          {pass === 'fix' && props.onFixSession !== undefined && (
            <FixSessionSelect
              value={fixSessionOf(config, props.suggestions)}
              otherVendor={
                props.otherFixVendor !== undefined && props.otherFixVendor !== null
                  ? vendorText(props.otherFixVendor, config, probes)
                  : null
              }
              resumeCheck={fixResumeCheck(report)}
              {...fixSessionReason(config, props.suggestions, probes)}
              onChange={props.onFixSession}
            />
          )}
          <div className="flex items-center gap-2 pl-18">
            {overridden && saveBlocked === null ? (
              <Button
                size="sm"
                variant="outline"
                data-testid={`pass-save-${pass}`}
                icon={<Save aria-hidden />}
                loading={props.saving === true}
                onClick={props.onSave}
              >
                Save to project
              </Button>
            ) : (
              <DisabledHint reason={saveBlocked ?? `${label} has no run overrides to save`}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  data-testid={`pass-save-${pass}`}
                  icon={<Save aria-hidden />}
                >
                  Save to project
                </Button>
              </DisabledHint>
            )}
            {overridden ? (
              <Button size="sm" variant="ghost" data-testid={`pass-reset-${pass}`} onClick={props.onReset}>
                <Undo2 aria-hidden />
                Reset
              </Button>
            ) : (
              <DisabledHint reason={`${label} has no run overrides`}>
                <Button size="sm" variant="ghost" disabled data-testid={`pass-reset-${pass}`}>
                  <Undo2 aria-hidden />
                  Reset
                </Button>
              </DisabledHint>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
