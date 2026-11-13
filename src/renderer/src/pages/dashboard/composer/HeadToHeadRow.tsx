// The composer's Head to head row: a switch, and when it is on, who builds each side (a vendor, its model and its
// effort level) and whether the names stay hidden on the comparison until a result is picked. Everything else in the
// composer applies to both sides. The switch's line has one height and one note beside it; the side pickers open on
// the person's own click and each keeps one width whatever it shows, so nothing moves on its own.
import { MATCH_SIDE_LABEL, MATCH_TEXT, sameContestant } from '@shared/match.ts'
import type { MatchContestant, MatchSide } from '@shared/match.ts'
import { supportsEffort } from '@shared/vendors.ts'
import type { ModelOption, ProbeView } from '@shared/vendors.ts'
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
import { EffortSelect } from './EffortSelect.tsx'
import { effortAfterModel, vendorChoiceText, vendorChoices } from './model.ts'
import { ModelField } from './ModelField.tsx'
import { probePicked } from './probePick.ts'

export interface HeadToHeadValue {
  on: boolean
  sides: [MatchContestant, MatchContestant]
  /** Hide the builders' names on the comparison until a result is picked. */
  blind: boolean
}

export const HEAD_TO_HEAD_OFF = 'Build this task twice, with two builders, and compare the results.'
export const HEAD_TO_HEAD_STATUS = 'Head to head: starts two builds'
export const BLIND_LABEL = 'Hide names until I pick'
export const BLIND_NOTE =
  'The comparison shows two results without saying who built which, until you keep one.'

/** The line beside the switch: what it is, or what to know about the two sides chosen. */
export function headToHeadNote(v: HeadToHeadValue, openTask: boolean): string {
  if (!v.on) return HEAD_TO_HEAD_OFF
  if (openTask) return MATCH_TEXT.openTask
  if (sameContestant(v.sides[0], v.sides[1])) return MATCH_TEXT.sameSides
  return MATCH_TEXT.twoBuilds
}

/**
 * The two sides a match starts with: side A builds as the run would have (the Implement pass's vendor, model and
 * effort), side B is the first other vendor that is ready, else the same again (two tries).
 */
export function defaultSides(
  implement: { vendor: string; model?: string | null; effort?: string | null },
  probes: readonly ProbeView[],
  presets: readonly { id: string; label: string }[],
): [MatchContestant, MatchContestant] {
  const a: MatchContestant = {
    vendor: implement.vendor,
    ...(typeof implement.model === 'string' ? { model: implement.model } : {}),
    ...(typeof implement.effort === 'string' ? { effort: implement.effort } : {}),
  }
  // Ready means probed and ready: a vendor nobody has checked yet is not offered on its own.
  const ready = new Set(probes.filter((p) => p.health === 'ready').map((p) => p.vendor))
  const other = vendorChoices(probes, presets, implement.vendor).find(
    (c) => c.group === 'primary' && !c.disabled && c.id !== implement.vendor && ready.has(c.id),
  )
  return [a, other !== undefined ? { vendor: other.id } : { ...a }]
}

export function SideRow({
  side,
  value,
  probes,
  presets,
  models,
  onWantModels,
  onChange,
}: {
  side: MatchSide
  value: MatchContestant
  probes: readonly ProbeView[]
  presets: readonly { id: string; label: string }[]
  models: readonly ModelOption[] | null
  onWantModels: (vendor: string) => void
  onChange: (c: MatchContestant) => void
}): React.JSX.Element {
  const label = MATCH_SIDE_LABEL[side]
  const choices = vendorChoices(probes, presets, value.vendor)
  const chosen = choices.find((c) => c.id === value.vendor)
  const labelId = `composer-h2h-${side}-label`
  const model = typeof value.model === 'string' ? value.model : null
  const effort = value.effort ?? null
  return (
    <div data-testid={`composer-h2h-side-${side}`} className="flex min-h-9 min-w-0 items-center gap-2">
      <span id={labelId} className="flex h-9 w-12 shrink-0 items-center text-xs font-medium">
        {label}
      </span>
      <Select
        value={value.vendor}
        onValueChange={(v) => {
          if (v === value.vendor) return
          // Another vendor's model and effort level would not run here.
          onChange({ vendor: v })
          if (choices.find((c) => c.id === v)?.group === 'more') void probePicked(v)
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid={`composer-h2h-vendor-${side}`}
          aria-label={`${label} vendor`}
          className="w-44 shrink-0"
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
      <div className="w-48 shrink-0">
        <ModelField
          pass={`h2h-${side}`}
          label={`${label} model`}
          value={model}
          options={models}
          noPricing={false}
          onWantOptions={() => onWantModels(value.vendor)}
          onCommit={(next) => {
            // A level the new model does not list goes back to the default.
            const kept = effortAfterModel(models, next, effort)
            onChange({
              vendor: value.vendor,
              ...(next !== null ? { model: next } : {}),
              ...(kept !== null ? { effort: kept } : {}),
            })
          }}
        />
      </div>
      {/* One width whether the vendor has an effort setting or not. */}
      <div className="flex h-9 w-36 shrink-0 items-center">
        {supportsEffort(value.vendor) ? (
          <EffortSelect
            id={`h2h-${side}`}
            label={`${label} effort`}
            model={model}
            value={effort}
            options={models}
            onWantOptions={() => onWantModels(value.vendor)}
            onChange={(next) =>
              onChange({
                vendor: value.vendor,
                ...(model !== null ? { model } : {}),
                ...(next !== null ? { effort: next } : {}),
              })
            }
          />
        ) : (
          <span className="truncate text-xs text-muted-foreground" title="This vendor has no effort setting">
            No effort setting
          </span>
        )}
      </div>
    </div>
  )
}

export function HeadToHeadRow({
  value,
  onChange,
  onToggle,
  probes,
  presets,
  models,
  onWantModels,
  openTask,
}: {
  value: HeadToHeadValue
  onChange: (v: HeadToHeadValue) => void
  /** The switch: turning it on fills in the two sides. */
  onToggle: (on: boolean) => void
  probes: readonly ProbeView[]
  presets: readonly { id: string; label: string }[]
  models: (vendor: string) => readonly ModelOption[] | null
  onWantModels: (vendor: string) => void
  /** The prompt check has a hint for this task. */
  openTask: boolean
}): React.JSX.Element {
  const note = headToHeadNote(value, openTask)
  const setSide = (i: 0 | 1, c: MatchContestant): void => {
    const sides: [MatchContestant, MatchContestant] = i === 0 ? [c, value.sides[1]] : [value.sides[0], c]
    onChange({ ...value, sides })
  }
  return (
    <div data-testid="composer-h2h" data-on={value.on} className="flex min-w-0 flex-col gap-1">
      <div className="flex h-7 min-w-0 items-center gap-2">
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <Switch
            data-testid="composer-h2h-switch"
            checked={value.on}
            onCheckedChange={onToggle}
            aria-describedby="composer-h2h-note"
          />
          <span className="text-xs font-medium text-muted-foreground">Head to head</span>
        </label>
        <p
          id="composer-h2h-note"
          data-testid="composer-h2h-note"
          title={note}
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {note}
        </p>
      </div>
      {value.on && (
        <div data-testid="composer-h2h-sides" className="flex min-w-0 flex-col gap-1 pl-11">
          <SideRow
            side="a"
            value={value.sides[0]}
            probes={probes}
            presets={presets}
            models={models(value.sides[0].vendor)}
            onWantModels={onWantModels}
            onChange={(c) => setSide(0, c)}
          />
          <SideRow
            side="b"
            value={value.sides[1]}
            probes={probes}
            presets={presets}
            models={models(value.sides[1].vendor)}
            onWantModels={onWantModels}
            onChange={(c) => setSide(1, c)}
          />
          <div className="flex h-7 min-w-0 items-center gap-2">
            <label className="flex shrink-0 cursor-pointer items-center gap-2">
              <Switch
                data-testid="composer-h2h-blind"
                checked={value.blind}
                onCheckedChange={(blind) => onChange({ ...value, blind })}
                aria-describedby="composer-h2h-blind-note"
              />
              <span className="text-xs font-medium text-muted-foreground">{BLIND_LABEL}</span>
            </label>
            <p
              id="composer-h2h-blind-note"
              title={BLIND_NOTE}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {BLIND_NOTE}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
