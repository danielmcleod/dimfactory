// The composer's gates line (config `gates`): where the run stops for you,
// as core resolved it ("Stops after Plan · runs Fix without stopping"), with both gates as run-override toggles.
// Auto turns both off (core's resolve), so the toggles are locked while it is on. The text follows the toggles and
// their provenance badges reserve their width, so a click never moves the checkbox under the pointer (UI
// control standard).
import type { ProvenanceMap } from '@shared/config-schema.ts'
import { Checkbox } from '../../../components/ui/Checkbox.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import type { GateName } from './overrides.ts'
import { PROVENANCE_LABEL } from './model.ts'
import { ProvenanceBadge } from './ProvenanceBadge.tsx'

/**
 * Where a gate's value (or the run branch's, IsolationControls) can come from: the badge keeps the widest width,
 * whichever it shows.
 */
export const GATE_PROVENANCE_LABELS: readonly string[] = [
  PROVENANCE_LABEL.default,
  'profile',
  PROVENANCE_LABEL.user,
  PROVENANCE_LABEL.project,
  PROVENANCE_LABEL.recipe,
  PROVENANCE_LABEL.run,
  PROVENANCE_LABEL.auto,
]

export function gatesText(g: { afterPlan: boolean; beforeFix: boolean }, auto: boolean): string {
  if (auto) return 'Auto: runs through without stopping'
  return `${g.afterPlan ? 'Stops after Plan' : 'Runs Plan without stopping'} · ${
    g.beforeFix ? 'stops before Fix' : 'runs Fix without stopping'
  }`
}

const GATES: readonly { gate: GateName; label: string; testId: string }[] = [
  { gate: 'afterPlan', label: 'Stop after Plan', testId: 'gate-after-plan' },
  { gate: 'beforeFix', label: 'Stop before Fix', testId: 'gate-before-fix' },
]

export function GatesLine({
  gates,
  auto,
  provenance,
  onChange,
}: {
  gates: { afterPlan: boolean; beforeFix: boolean }
  auto: boolean
  provenance: ProvenanceMap
  onChange: (gate: GateName, value: boolean) => void
}): React.JSX.Element {
  return (
    <div data-testid="gates-line" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="w-16 font-medium text-muted-foreground">Gates</span>
      {GATES.map(({ gate, label, testId }) => {
        const box = (
          <label className="flex items-center gap-1.5">
            <Checkbox
              data-testid={testId}
              checked={gates[gate]}
              disabled={auto}
              aria-label={auto ? `${label} (off in Auto)` : label}
              onCheckedChange={(v) => onChange(gate, v === true)}
            />
            <span className={auto ? 'text-muted-foreground' : undefined}>{label}</span>
            <ProvenanceBadge
              provenance={provenance[`/gates/${gate}`]}
              testId={`gate-provenance-${gate}`}
              reserve={GATE_PROVENANCE_LABELS}
            />
          </label>
        )
        return auto ? (
          <Tooltip key={gate} content="Off in Auto">
            <span tabIndex={0} className="inline-flex rounded-md">
              {box}
            </span>
          </Tooltip>
        ) : (
          <span key={gate}>{box}</span>
        )
      })}
      <span data-testid="gates-text">{gatesText(gates, auto)}</span>
    </div>
  )
}
