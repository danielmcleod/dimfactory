// Easy's depth choice (the confirm screen and the change screen): Auto, Quick or Thorough, and core's decision as one
// line ("Quick: one strong session plus checks. A small or medium change to an existing project."). The choice keeps
// its widths and the line keeps its height, so a new decision moves nothing.
import type { DepthDecision, DepthSetting } from '@shared/depth.ts'
import { DEPTH_CHOICES, depthLine } from '@shared/depth.ts'
import { Segmented } from '../../components/diff/Segmented.tsx'

const HINT: Readonly<Record<DepthSetting, string>> = {
  auto: 'Dim Factory chooses for you',
  direct: 'One strong session, then the checks and one review',
  full: 'A plan first, then two reviewers and fixes',
}

/** The line under the choice: core's decision, or a wait while it is asked. */
export function easyDepthText(decision: DepthDecision | undefined, waiting?: string): string {
  return decision !== undefined ? depthLine(decision) : (waiting ?? 'Choosing how thorough to be…')
}

export function EasyDepth({
  value,
  decision,
  onChange,
  testId,
  waiting,
}: {
  value: DepthSetting
  decision: DepthDecision | undefined
  onChange: (v: DepthSetting) => void
  testId: string
  /** The line while there is no decision (default: a short wait). */
  waiting?: string | undefined
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      {/* Its own row, so the choice keeps its widths instead of stretching across the column. */}
      <div className="flex">
        <Segmented
          label="How thorough"
          testId={`${testId}-choice`}
          options={DEPTH_CHOICES.map((c) => ({ ...c, hint: HINT[c.value] }))}
          value={value}
          onChange={onChange}
        />
      </div>
      <p
        className="min-h-5 text-sm text-muted-foreground"
        data-testid={`${testId}-line`}
        data-depth={decision?.depth}
        data-source={decision?.source}
      >
        {easyDepthText(decision, waiting)}
      </p>
    </div>
  )
}
