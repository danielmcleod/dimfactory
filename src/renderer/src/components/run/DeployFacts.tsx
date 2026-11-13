// The Deploy step's facts on its card: what the run ships as and the target the step writes config for, the files it
// was asked to write (and those that were there already), then the files it wrote, with a link to its Diff tab
// segment. Presentation only: everything is core's (StepView.deploy). The step never deploys.
import type { DeployRunView } from '@shared/deploy.ts'
import { deployStepLine } from '../deploy/text.ts'

export function DeployFacts({ view }: { view: DeployRunView }): React.JSX.Element {
  const line = deployStepLine(view)
  return (
    <div className="flex flex-col gap-1" data-testid="deploy-facts" data-phase={view.phase}>
      {view.cls !== undefined && (
        <p className="text-xs text-muted-foreground" data-testid="deploy-facts-target">
          {view.cls.label}
          {view.target !== undefined ? `, for ${view.target.label}` : ''}
        </p>
      )}
      {line !== null && (
        <p className="text-sm" data-testid="deploy-facts-line">
          {line}
        </p>
      )}
      {view.files.length > 0 && view.written === undefined && (
        <ul className="flex flex-col gap-0.5 text-xs" data-testid="deploy-facts-files">
          {view.files.map((f) => (
            <li key={f.path}>
              <code className="font-mono">{f.path}</code>: {f.purpose}
            </li>
          ))}
        </ul>
      )}
      {view.present.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="deploy-facts-present">
          Already there, left as they are: {view.present.join(', ')}
        </p>
      )}
    </div>
  )
}
