// The Rematch page (#/rematch/<runId>): replay a run that ended against another builder. It says which run and who
// built it, takes the challenger (vendor, model, effort), and offers "Run both fresh" and hidden names. A vendor that
// has not run in the project before is agreed to here, before anything is sent. A run that cannot be replayed says
// why in the same place. Every line keeps its place: what does not apply yet is said in its own row.
import { FileQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MATCH_TEXT } from '@shared/match.ts'
import type { MatchContestant, RematchCheck } from '@shared/match.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { vendorName } from '../../lib/format.ts'
import { href, navigate } from '../../lib/router.ts'
import { useProbes } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { BLIND_LABEL, BLIND_NOTE, SideRow, defaultSides } from '../dashboard/composer/HeadToHeadRow.tsx'
import { useVendorModels } from '../dashboard/composer/useVendorModels.ts'
import { builderText } from './text.ts'

export const REMATCH_LOADING = 'Looking at the run…'
export const REMATCH_START = 'Start rematch'
export const FRESH_LABEL = 'Run both fresh'
export const FRESH_NOTE =
  'Builds the original’s side again too, now, so both sides’ numbers are from today. Costs two builds.'
export const RECORDED_NOTE =
  'Side A is the run as it was recorded, at no cost. Side B is built now, from the folder as it was when that run began.'
export const NOTHING_APPLIED =
  'Nothing is applied to your folder: you compare, pick and can save a result as a patch.'
export const KNOWN_VENDOR = 'This vendor has run in this project before.'

/** The line under the challenger: the vendor is new to the project (and has to be agreed to), or it is not. */
export function newVendorLine(check: RematchCheck | null, vendor: string): string | null {
  if (check?.knownVendors === undefined || check.knownVendors.includes(vendor)) return null
  return MATCH_TEXT.newVendor(vendorName(vendor))
}

export function RematchPage({ runId }: { runId: string }): React.JSX.Element {
  const probes = useProbes()
  const models = useVendorModels(probes)
  const [check, setCheck] = useState<RematchCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [challenger, setChallenger] = useState<MatchContestant | null>(null)
  const [fresh, setFresh] = useState(false)
  const [blind, setBlind] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let live = true
    void invoke('matches.rematchCheck', { runId }).then((r) => {
      if (!live) return
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setCheck(r.value)
    })
    return () => {
      live = false
    }
  }, [runId])
  // The challenger starts as the first other vendor that is ready, else the same builder again (another try).
  useEffect(() => {
    if (challenger !== null || check?.original === undefined) return
    setChallenger(defaultSides(check.original, probes, [])[1])
  }, [check, probes, challenger])

  const shell = (body: React.JSX.Element): React.JSX.Element => (
    <div data-testid="rematch-page" className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5">
      <h1 className="text-lg font-semibold">Rematch</h1>
      {body}
    </div>
  )
  if (error !== null) {
    return shell(
      <EmptyState
        icon={FileQuestion}
        title="This run cannot be looked at"
        description={error}
        action={
          <Button asChild variant="outline">
            <a href={href({ name: 'runs' })}>Go to Runs</a>
          </Button>
        }
      />,
    )
  }
  if (check === null) {
    return shell(
      <p data-testid="rematch-loading" className="text-sm text-muted-foreground">
        {REMATCH_LOADING}
      </p>,
    )
  }

  const vendor = challenger?.vendor ?? ''
  const newVendor = newVendorLine(check, vendor)
  const blocked =
    check.blocked ??
    (challenger === null
      ? 'Choose who builds the other side.'
      : newVendor !== null && !agreed
        ? 'Agree to send the project to this vendor first.'
        : null)
  const start = async (): Promise<void> => {
    if (challenger === null || blocked !== null || starting) return
    setStarting(true)
    const r = await invoke('matches.rematch', {
      runId,
      challenger,
      ...(fresh ? { fresh: true } : {}),
      ...(blind ? { blind: true } : {}),
      ...(newVendor !== null && agreed ? { confirmNewVendor: true } : {}),
    })
    setStarting(false)
    if (r.ok) navigate({ name: 'match', matchId: r.value.matchId })
    else toast({ level: 'error', message: r.error.message })
  }
  const button = (
    <Button
      data-testid="rematch-start"
      disabled={blocked !== null}
      loading={starting}
      onClick={() => void start()}
    >
      {REMATCH_START}
    </Button>
  )

  return shell(
    <>
      <section aria-label="The run" className="flex flex-col gap-1 rounded-lg border bg-card p-3">
        <p className="flex h-5 min-w-0 items-center gap-2 text-sm">
          <a
            data-testid="rematch-run"
            href={href({ name: 'run', runId })}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            Run #{check.displayNo ?? ''}
          </a>
          <span data-testid="rematch-original" className="min-w-0 flex-1 truncate text-muted-foreground">
            {check.original !== undefined
              ? `Built by ${builderText(check.original)}`
              : 'It never started building'}
          </span>
        </p>
        <p data-testid="rematch-task" className="line-clamp-2 text-sm" title={check.task}>
          {check.task ?? ''}
        </p>
        <p
          data-testid="rematch-blocked"
          role={check.blocked !== undefined ? 'alert' : undefined}
          className="min-h-5 text-xs text-warning"
        >
          {check.blocked ?? ''}
        </p>
      </section>

      <section aria-label="The challenger" className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Who builds the other side</h2>
        {challenger !== null ? (
          <SideRow
            side="b"
            value={challenger}
            probes={probes}
            presets={[]}
            models={models.options(challenger.vendor)}
            onWantModels={models.want}
            onChange={(c) => {
              setChallenger(c)
              if (c.vendor !== challenger.vendor) setAgreed(false)
            }}
          />
        ) : (
          <p className="flex min-h-9 items-center text-xs text-muted-foreground">
            No builder to choose from yet.
          </p>
        )}
        {/* One row whether the vendor is new to the project or not. */}
        <div className="flex h-7 min-w-0 items-center gap-2 pl-14">
          <Switch
            data-testid="rematch-agree"
            checked={newVendor !== null && agreed}
            disabled={newVendor === null}
            onCheckedChange={setAgreed}
            aria-describedby="rematch-vendor-note"
          />
          <p
            id="rematch-vendor-note"
            data-testid="rematch-vendor-note"
            title={newVendor ?? KNOWN_VENDOR}
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          >
            {newVendor ?? KNOWN_VENDOR}
          </p>
        </div>
      </section>

      <section aria-label="Options" className="flex flex-col gap-1">
        <div className="flex h-7 min-w-0 items-center gap-2">
          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <Switch data-testid="rematch-fresh" checked={fresh} onCheckedChange={setFresh} />
            <span className="text-xs font-medium text-muted-foreground">{FRESH_LABEL}</span>
          </label>
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={FRESH_NOTE}>
            {FRESH_NOTE}
          </p>
        </div>
        <div className="flex h-7 min-w-0 items-center gap-2">
          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <Switch data-testid="rematch-blind" checked={blind} onCheckedChange={setBlind} />
            <span className="text-xs font-medium text-muted-foreground">{BLIND_LABEL}</span>
          </label>
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={BLIND_NOTE}>
            {BLIND_NOTE}
          </p>
        </div>
      </section>

      <section aria-label="Start" className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          {fresh ? NOTHING_APPLIED : `${RECORDED_NOTE} ${NOTHING_APPLIED}`}
        </p>
        <div className="flex h-9 items-center gap-2">
          {blocked !== null ? <DisabledHint reason={blocked}>{button}</DisabledHint> : button}
        </div>
      </section>
    </>,
  )
}
