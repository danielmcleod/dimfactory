// File paths in a card (reconcile's paths beside core-built choices, planMutated's changed paths).
// The first few read in the card with "and N more" after them, and the full list is a disclosure the user
// opens. UI standard (one scroll region per screen): the full list reads in the page flow, never in a
// scroller of its own, and a very long one stops at PATHS_ALL_MAX with the count of the rest.
import { useId } from 'react'

/** Paths shown in the card before "and N more". */
export const PATHS_SHOWN = 5
/** The most paths the full list writes out (a branch switch can touch thousands of files). */
export const PATHS_ALL_MAX = 1000

const plural = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

export function PathList({
  label,
  paths,
  testId,
}: {
  /** What the files are, e.g. "Edited outside the run". */
  label: string
  paths: readonly string[]
  testId: string
}): React.JSX.Element | null {
  const labelId = useId()
  if (paths.length === 0) return null
  const shown = paths.slice(0, PATHS_SHOWN)
  const more = paths.length - shown.length
  const all = paths.slice(0, PATHS_ALL_MAX)
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <p id={labelId} className="text-xs font-medium text-muted-foreground">
        {label} ({plural(paths.length)})
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
        {shown.map((p, i) => (
          <li key={i} data-testid={`${testId}-path`} className="font-mono text-xs wrap-anywhere">
            {p}
          </li>
        ))}
        {more > 0 && (
          <li data-testid={`${testId}-more`} className="text-xs text-muted-foreground">
            and {more} more
          </li>
        )}
      </ul>
      {more > 0 && (
        <details className="text-xs">
          <summary
            data-testid={`${testId}-all`}
            className="cursor-pointer text-muted-foreground select-none hover:text-foreground"
          >
            Show all {plural(paths.length)}
          </summary>
          <ul data-testid={`${testId}-full`} className="mt-1 flex flex-col gap-0.5">
            {all.map((p, i) => (
              <li key={i} className="font-mono wrap-anywhere">
                {p}
              </li>
            ))}
          </ul>
          {paths.length > all.length && (
            <p className="mt-1 text-muted-foreground">and {paths.length - all.length} more not listed</p>
          )}
        </details>
      )}
    </div>
  )
}
