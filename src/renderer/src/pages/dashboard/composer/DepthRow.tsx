// The composer's depth row: Auto, Quick or Thorough (the run's `depth`, a run override), and core's decision in one
// line beside it ("Quick: one strong session plus checks. A small or medium change to an existing project."). The row
// has one height and the choice keeps its widths, so the decision arriving or changing moves nothing.
import type { DepthDecision, DepthSetting } from '@shared/depth.ts'
import { DEPTH_CHOICES, depthLine } from '@shared/depth.ts'
import { Segmented } from '../../../components/diff/Segmented.tsx'

/** What each choice does, in the choice's tooltip. */
const HINT: Readonly<Record<DepthSetting, string>> = {
  auto: 'Dim Factory chooses from the task and the folder',
  direct: "One strong build session in the vendor's own harness, then the checks and one independent review",
  full: 'Plan, build, two reviewers and fixes',
}

/** The line beside the choice: core's decision, or what happens before there is one. */
export function depthRowText(decision: DepthDecision | null, hasFolder: boolean): string {
  if (!hasFolder) return 'Dim Factory chooses Quick or Thorough once you choose a folder.'
  if (decision === null) return 'Choosing Quick or Thorough for this task…'
  return depthLine(decision)
}

export function DepthRow({
  value,
  decision,
  hasFolder,
  onChange,
}: {
  /** The run's own choice (absent: Auto). */
  value: DepthSetting | undefined
  decision: DepthDecision | null
  hasFolder: boolean
  onChange: (v: DepthSetting) => void
}): React.JSX.Element {
  const text = depthRowText(decision, hasFolder)
  return (
    <div data-testid="composer-depth" className="flex h-7 min-w-0 items-center gap-2">
      <span id="composer-depth-label" className="shrink-0 text-xs font-medium text-muted-foreground">
        Depth
      </span>
      <Segmented
        label="Depth"
        testId="composer-depth-choice"
        options={DEPTH_CHOICES.map((c) => ({ ...c, hint: HINT[c.value] }))}
        value={value ?? 'auto'}
        onChange={onChange}
      />
      <p
        data-testid="composer-depth-line"
        data-depth={decision?.depth}
        data-source={decision?.source}
        title={text}
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >
        {text}
      </p>
    </div>
  )
}
