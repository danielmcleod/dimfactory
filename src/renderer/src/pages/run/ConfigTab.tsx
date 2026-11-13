// The Run view's Config tab: what each pass ran with, read-only, from the snapshot's
// StepViews (vendor, model, mode with the adapter's copy, plan mode, route). The full resolved configuration and the
// prompt templates are in the run folder (resolved.json), which this tab opens. Below them, the guardrails in force for
// the run's folder as set now, each with where it comes from (always on, the preset, your rules or the project).
import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { GuardrailInForce, GuardrailPreset } from '@shared/guardrails.ts'
import { guardrailsInForce } from '@shared/guardrails.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { RECIPE_LAYER_LABEL } from '@shared/recipes.ts'
import { useBusy, runCommand } from '../../components/run/commands.ts'
import { shownSteps } from '../../components/run/steps.ts'
import { MODE_TEXT, configModelText, modelChipTitle, planModeText } from '../../components/run/text.ts'
import { Badge } from '../../components/ui/Badge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { invoke } from '../../ipc/client.ts'
import { runStepLabel, vendorName } from '../../lib/format.ts'

/** A value core did not record for the pass: a word, never a dash (UI copy standard). */
const NOT_RECORDED = 'Not recorded'

function NotRecorded(): React.JSX.Element {
  return <span className="font-sans text-sm text-muted-foreground">{NOT_RECORDED}</span>
}

const PRESET_NAME: Readonly<Record<GuardrailPreset, string>> = {
  off: 'Off',
  recommended: 'Recommended',
  strict: 'Strict',
}

type InForce = ReturnType<typeof guardrailsInForce>

/** Where a rule in force comes from, in words. */
export function guardrailFromText(r: GuardrailInForce, view: Pick<InForce, 'preset' | 'presetFrom'>): string {
  switch (r.from) {
    case 'always':
      return 'Always on'
    case 'preset':
      return `${PRESET_NAME[view.preset]} preset, ${view.presetFrom === 'project' ? 'set by this project' : 'yours'}`
    case 'user':
      return 'Your rules'
    case 'project':
      return 'This project'
  }
}

/**
 * The folder's guardrails as set now, from your own settings and the folder's: the run itself keeps the rules it
 * started with. Nothing shows until both are read, and a folder that cannot be read shows nothing.
 */
function FolderGuardrails({
  folder,
  rulesAtStart,
}: {
  folder: string
  rulesAtStart: number | undefined
}): React.JSX.Element | null {
  const [view, setView] = useState<InForce | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.all([invoke('config.resolve', {}), invoke('config.resolve', { folder })])
      .then(([user, merged]) => {
        if (alive && user.ok && merged.ok)
          setView(guardrailsInForce(user.value.config.guardrails, merged.value.config.guardrails))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [folder])
  if (view === null) return null
  return (
    <section
      aria-label="Guardrails for this folder"
      className="flex flex-col gap-1"
      data-testid="config-guardrails"
    >
      <h2 className="text-sm font-medium">Guardrails for this folder</h2>
      <p className="text-xs text-muted-foreground">
        As set now.
        {rulesAtStart !== undefined &&
          ` This run started with ${rulesAtStart} rule${rulesAtStart === 1 ? '' : 's'} in force, plus settings files.`}
      </p>
      <ul className="flex flex-col text-sm">
        {view.rules.map((r) => (
          <li key={r.label} className="flex flex-wrap justify-between gap-x-4 border-b py-1 last:border-b-0">
            <span className="min-w-0 break-words">{r.label}</span>
            <span className="text-muted-foreground" data-testid="config-guardrail-from">
              {guardrailFromText(r, view)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ConfigTab({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const s = snap.summary
  const [busy, run] = useBusy()
  const steps = shownSteps(snap).filter((v) => v.vendor !== undefined || v.mode !== undefined)
  return (
    <section aria-label="Run configuration" className="flex flex-col gap-3" data-testid="config-tab">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Profile</dt>
        <dd>{s.profile}</dd>
        {s.recipe !== undefined && (
          <>
            <dt className="text-muted-foreground">Recipe</dt>
            <dd data-testid="config-recipe">
              {s.recipe.label} ({RECIPE_LAYER_LABEL[s.recipe.layer]})
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Auto</dt>
        <dd>{s.auto ? 'On: gates are skipped and asks follow your rules' : 'Off'}</dd>
        <dt className="text-muted-foreground">Changes</dt>
        <dd>{s.isolation === 'worktree' ? 'Isolated worktree' : 'In place, in the folder'}</dd>
      </dl>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No pass has started yet, so no vendor settings are recorded.
        </p>
      ) : (
        // Not a scroller (UI standard: one scroll region per screen): the table fits the width, its cells wrap. Its columns
        // have fixed shares (table-fixed), so a value that arrives while a pass starts (its route, the model it ran)
        // never re-balances them (nothing moves on its own); Model and Route keep one line, cut with the full text in
        // their title, so the row keeps its height too.
        <div className="overflow-clip rounded-md border">
          <table className="w-full table-fixed text-sm [overflow-wrap:anywhere]">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[12%]" />
              <col className="w-[22%]" data-testid="config-col-model" />
              <col />
              <col className="w-[13%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">Pass</th>
                <th className="px-3 py-1.5 font-medium">Vendor</th>
                <th className="px-3 py-1.5 font-medium">Model</th>
                <th className="px-3 py-1.5 font-medium">Mode</th>
                <th className="px-3 py-1.5 font-medium">Planning</th>
                <th className="px-3 py-1.5 font-medium">Route</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((v) => (
                <tr key={v.key} className="border-t" data-testid={`config-row-${v.key}`}>
                  <td className="px-3 py-1.5 font-medium">{runStepLabel(v.key, snap.steps)}</td>
                  <td className="px-3 py-1.5">
                    {v.vendor !== undefined ? vendorName(v.vendor) : <NotRecorded />}
                  </td>
                  {v.model === undefined ? (
                    <td className="truncate px-3 py-1.5" title={NOT_RECORDED}>
                      <NotRecorded />
                    </td>
                  ) : (
                    <td
                      className="truncate px-3 py-1.5 font-mono text-xs"
                      title={
                        (modelChipTitle(v) ?? configModelText(v)) +
                        (v.effort !== undefined ? `, at ${v.effort} effort` : '')
                      }
                      data-testid={`config-model-${v.key}`}
                    >
                      {configModelText(v)}
                      {/* The effort level the pass runs at, when it names one (else its default). */}
                      {v.effort !== undefined && (
                        <span
                          data-testid={`config-effort-${v.key}`}
                          className="font-sans text-muted-foreground"
                        >
                          {` · ${v.effort} effort`}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    {v.modeCopy?.copy ?? (v.mode !== undefined ? MODE_TEXT[v.mode] : <NotRecorded />)}
                    {v.modeCopy !== undefined && v.modeCopy.status !== 'supported' && (
                      <Badge variant="auto" className="ml-1.5">
                        {v.modeCopy.status}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {v.key === 'plan'
                      ? (planModeText(v.planMode, v.vendor, v.planFallbackReason) ?? <NotRecorded />)
                      : ''}
                  </td>
                  <td className="truncate px-3 py-1.5 text-muted-foreground" title={v.route ?? NOT_RECORDED}>
                    {v.route ?? <NotRecorded />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>The prompt templates and every setting this run used are in its folder (resolved.json).</span>
        <Button
          size="sm"
          variant="outline"
          loading={busy === 'open'}
          icon={<FolderOpen aria-hidden />}
          onClick={() =>
            run('open', () => runCommand(null, 'shell.open', { target: 'runFolder', runId: s.runId }))
          }
        >
          Open run folder
        </Button>
      </div>
      <FolderGuardrails folder={s.folder} rulesAtStart={snap.guardrails?.rules} />
    </section>
  )
}
