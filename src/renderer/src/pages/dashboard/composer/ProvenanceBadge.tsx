// Where a composer value came from (core's provenance map): user / project / recipe / run, with run
// (and Auto) in amber. Core's provenance map is the only source; the badge formats it.
import type { Provenance } from '@shared/config-schema.ts'
import { Badge } from '../../../components/ui/Badge.tsx'
import { StableLabel } from '../../../components/ui/StableLabel.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import { isRunProvenance, provenanceLabel, provenanceTitle } from './model.ts'

export function ProvenanceBadge({
  provenance,
  testId,
  className,
  reserve,
}: {
  provenance: Provenance | undefined
  testId?: string
  className?: string
  /** Labels to reserve the width of, where the badge sits before other controls (the gates line). */
  reserve?: readonly string[]
}): React.JSX.Element | null {
  if (provenance === undefined) {
    // With `reserve`, the room stays (unseen) until core names the source, so its arrival moves nothing after it.
    if (reserve === undefined) return null
    return (
      <span aria-hidden className="invisible inline-flex">
        <Badge variant="outline" className={cn('px-1 py-0 text-[10px] font-normal', className)}>
          <StableLabel labels={reserve}>{''}</StableLabel>
        </Badge>
      </span>
    )
  }
  const run = isRunProvenance(provenance)
  const title = provenanceTitle(provenance)
  const label = provenanceLabel(provenance)
  return (
    <Tooltip content={title}>
      <span
        tabIndex={0}
        data-testid={testId}
        data-source={provenance.source}
        aria-label={`${label}: ${title}`}
        className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Badge
          variant={run ? 'auto' : 'outline'}
          className={cn('px-1 py-0 text-[10px] font-normal', !run && 'text-muted-foreground', className)}
        >
          {reserve !== undefined ? <StableLabel labels={reserve}>{label}</StableLabel> : label}
        </Badge>
      </span>
    </Tooltip>
  )
}
