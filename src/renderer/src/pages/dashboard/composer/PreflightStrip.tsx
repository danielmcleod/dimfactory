// The composer's preflight strip (live preflight): core's PreflightReport as one
// summary row, then on request its chips: blocking (red), then warnings (amber). Each chip shows its first fix inline
// and expands to its detail and every fix (the shared RecoveryActions: copy → "I ran it → Re-check", settings links,
// …; a fix for this run only hands core's checked ops to the composer's overrides). `✓ N checks ok` opens the list
// of what passed. When runs.start answered PREFLIGHT_BLOCKED, its authoritative report shows here instead under "No
// run was created" (data-testid `composer-blockers`, an alert), its chips expanded once shown, until the
// next live check replaces it. A check core offers the Codex sandbox setup for shows the sandbox chip
// (components/recovery/SandboxChip.tsx) as its fix: [Set up the Codex sandbox], progress, core's answer, and the
// elevated command behind [Set up as administrator instead] (codex-sandbox.spec.ts). Once per strip (a later
// chip with the same setup points at the first), and an open chip lists the setup before its other fixes.
//
// Core answers on its own schedule, so its answers never move the page (UI standard: async content never shifts the
// page). The summary row is one line of a fixed height: [Check again] [✓ N checks ok]
// what the checks say (cut with an ellipsis, whole in its title) [Show details]. The chips and the list of passed
// checks open only when the user asks for them. What blocks Run is also the status beside Run, its tooltip, and the
// composer's polite announcement. Open details keep the room they reached while the user leaves them open: a fix
// that works long after its click (the Codex sandbox setup takes seconds) drops its chip on core's schedule, and its
// room stays ("Nothing blocks the run now.") until the user hides the details, checks again or changes the folder. A
// chip the user opens or closes is measured again at once, so closing one gives its room back. While the details stay
// open, each chip also keeps its place and height (model.ts placeInSlots): a chip core drops on its own schedule
// leaves a "Cleared" line of the same height (or a newly reported chip takes its place), so the chips below it never
// move up by themselves; a chip reported later with no free place waits (the summary row counts it, and the details
// toggle's tooltip says how many wait) rather than push the page down. Opening or hiding the details, Check again, Run and a new
// folder lay the chips out afresh.
// A check core offers
// a vendorFolder grant for (Gemini's readiness `trust`) shows the folder trust chip (components/recovery/
// FolderTrustChip.tsx) as its fix: what trusting means in plain words and [Trust this folder for Gemini], which runs
// core's grant on the click; the live checks then run again and the block clears (gemini-trust.spec.ts).
// Once per strip and vendor, as the sandbox setup is: a later chip with the same grant points at the first.
import { Check, ChevronDown, OctagonX, RefreshCw, TriangleAlert } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { FolderTrustChip } from '../../../components/recovery/FolderTrustChip.tsx'
import {
  trustAbove,
  trustActionOf,
  trustVendorName,
  trustVendorOf,
} from '../../../components/recovery/folderTrust.ts'
import { RecoveryActions } from '../../../components/recovery/RecoveryActions.tsx'
import { SandboxChip } from '../../../components/recovery/SandboxChip.tsx'
import { setupActionOf } from '../../../components/recovery/sandboxSetup.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { StableLabel } from '../../../components/ui/StableLabel.tsx'
import { cn } from '../../../lib/cn.ts'
import { groupBySameFix, okChecks, placeInSlots } from './model.ts'
import type { HeldSlot } from './model.ts'

/** The details toggle reserves both labels' width. */
const DETAILS_LABELS: readonly string[] = ['Show details', 'Hide details']

export type StripSource = 'live' | 'start'

/** The ok chip keeps one width as the count changes: any 1- or 2-digit count fits (tabular digits). */
const OK_CHIP_RESERVE: readonly string[] = ['✓ 00 checks ok', '✓ 1 check ok']

export interface PreflightStripProps {
  /** The report to show (live, or runs.start's), or null before the first answer for this folder. */
  report: PreflightReport | null
  source: StripSource
  folder: string
  /** A live check is in flight. */
  checking: boolean
  /** Core could not run the live check (its message). */
  error: string | null
  onRecheck: () => Promise<void> | void
  /** A fix for this run only (config_patch `runOverrides`): core's checked ops for the composer's overrides. */
  onOverrides?: ((ops: JsonPatchOp[]) => unknown) | undefined
}

type Severity = 'blocking' | 'warning'

/** One chip of the open details (placeInSlots' item). */
interface ChipItem {
  g: { check: CheckResult; also: CheckResult[] }
  severity: Severity
}

/** A later chip whose fix is the same Codex sandbox setup (the setup control shows once per strip). */
export const SANDBOX_ABOVE = 'Set up the Codex sandbox from the first chip that offers it, above.'

/** The id of the first chip (blocking first) whose check offers each sandbox setup action. */
function sandboxHosts(groups: readonly { check: CheckResult }[]): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>()
  for (const g of groups) {
    const a = setupActionOf(g.check)
    if (a !== undefined && !hosts.has(a.id)) hosts.set(a.id, g.check.id)
  }
  return hosts
}

/** The id of the first chip (blocking first) whose check offers a vendorFolder grant, per vendor. */
function trustHosts(groups: readonly { check: CheckResult }[]): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>()
  for (const g of groups) {
    const a = trustActionOf(g.check)
    if (a !== undefined && !hosts.has(trustVendorOf(a))) hosts.set(trustVendorOf(a), g.check.id)
  }
  return hosts
}

function Chip({
  check,
  also,
  severity,
  folder,
  defaultOpen,
  sandboxHere,
  trustHere,
  onRecheck,
  onOverrides,
  onUserToggle,
  slot,
  minHeight,
}: {
  check: CheckResult
  /** Later checks core reported with exactly the same fixes (e.g. every pass of a vendor that needs a login). */
  also: readonly CheckResult[]
  severity: Severity
  folder: string
  defaultOpen: boolean
  /** This chip shows the sandbox setup control (the first one offering it). */
  sandboxHere: boolean
  /** This chip shows the folder trust control for its vendor (the first one offering it). */
  trustHere: boolean
  onRecheck: () => unknown
  onOverrides: PreflightStripProps['onOverrides']
  /** The user opened or closed this chip: the strip's kept room is measured again. */
  onUserToggle: () => void
  /** Its place in the open details, and the height that place keeps (px; see placeInSlots). */
  slot: number
  minHeight: number | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const Icon = severity === 'blocking' ? OctagonX : TriangleAlert
  const first = check.recovery[0]
  const sandbox = setupActionOf(check) !== undefined
  const expandable = check.detail !== '' || check.recovery.length > 1 || also.length > 0
  // A check offering the Codex sandbox setup shows the sandbox chip (setup first, the elevated command
  // behind its disclosure below it), once per strip: a later chip with the same setup points at it. Its other fixes
  // (Use Claude instead) follow in the open details.
  const sandboxPart = sandbox ? (
    sandboxHere ? (
      <SandboxChip
        check={check}
        ctx={{ folder }}
        onRecheck={onRecheck}
        testId={`preflight-sandbox-${check.id}`}
      />
    ) : (
      <p data-testid={`preflight-sandbox-elsewhere-${check.id}`} className="text-xs text-muted-foreground">
        {SANDBOX_ABOVE}
      </p>
    )
  ) : null
  // A check offering a vendorFolder grant (Gemini's readiness `trust`) shows the folder trust chip: what trusting
  // means and the grant's button, once per strip and vendor (a later chip points at the first). Its other fixes
  // (another vendor) follow in the open details, where core's own detail says what trusting means instead.
  const trust = trustActionOf(check)
  const trustVendor = trust !== undefined ? trustVendorOf(trust) : ''
  const trustPart =
    trust === undefined ? null : trustHere ? (
      <FolderTrustChip
        vendor={trustVendor}
        folder={folder}
        check={check}
        ctx={{ folder }}
        onRecheck={onRecheck}
        withMeans={!open || check.detail === ''}
        testId={`preflight-trust-${check.id}`}
      />
    ) : (
      <p data-testid={`preflight-trust-elsewhere-${check.id}`} className="text-xs text-muted-foreground">
        {trustAbove(trustVendorName(trustVendor))}
      </p>
    )
  const otherFixes = (
    sandbox
      ? check.recovery.filter(
          (a) => a.kind !== 'vendor_setup' && !(a.kind === 'shell_copy' && a.elevated === true),
        )
      : check.recovery
  ).filter((a) => a !== trust)
  return (
    <li
      data-testid={`preflight-chip-${check.id}`}
      data-check-id={check.id}
      data-also={also.length > 0 ? also.map((c) => c.id).join(' ') : undefined}
      data-severity={severity}
      data-slot={slot}
      style={minHeight !== undefined ? { minHeight } : undefined}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-2.5 py-1.5',
        severity === 'blocking' ? 'border-destructive/40 bg-destructive/5' : 'border-warning/40 bg-warning/5',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            severity === 'blocking' ? 'text-destructive' : 'text-warning',
          )}
        />
        <p className="min-w-0 flex-1 text-sm font-medium">
          <span className="sr-only">{severity === 'blocking' ? 'Blocks the run: ' : 'Warning: '}</span>
          {check.title}
          {also.length > 0 && (
            <span className="font-normal text-muted-foreground">
              {' '}
              · and {also.length} more with the same fix
            </span>
          )}
        </p>
        {expandable && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Hide details: ${check.title}` : `Show details and fixes: ${check.title}`}
            onClick={() => {
              setOpen((v) => !v)
              onUserToggle()
            }}
            className="rounded-md p-0.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>
      {open ? (
        <div className="flex flex-col gap-1.5 pl-6">
          {check.detail !== '' && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{check.detail}</p>
          )}
          {also.length > 0 && (
            <ul aria-label="Also reported" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {also.map((c, i) => (
                <li key={`${c.id}-${i}`} data-check-id={c.id}>
                  {c.title}
                </li>
              ))}
            </ul>
          )}
          {(sandboxPart !== null || trustPart !== null || otherFixes.length > 0) && (
            <div role="group" aria-label={`Ways to fix: ${check.title}`} className="flex flex-col gap-1.5">
              {sandboxPart}
              {trustPart}
              {otherFixes.length > 0 && (
                <RecoveryActions
                  actions={otherFixes}
                  folder={folder}
                  onRecheck={onRecheck}
                  onOverrides={onOverrides}
                  layout="commands"
                  check={check}
                />
              )}
            </div>
          )}
        </div>
      ) : sandbox ? (
        // codex-sandbox.spec.ts: a check core offers the Codex sandbox setup for gets the sandbox chip: the setup runs on the click,
        // its progress and core's new probe show beside it, the elevated command behind its disclosure; then the live
        // checks run again, so the block clears once the sandbox is ready.
        <div className="pl-6">{sandboxPart}</div>
      ) : trustPart !== null ? (
        // gemini-trust.spec.ts: the grant runs on the click, then the live checks run again and the block clears.
        <div className="pl-6">{trustPart}</div>
      ) : (
        first !== undefined && (
          <div className="pl-6">
            <RecoveryActions
              actions={[first]}
              folder={folder}
              onRecheck={onRecheck}
              onOverrides={onOverrides}
              check={check}
            />
          </div>
        )
      )}
    </li>
  )
}

/** What the checks say, in one line: `1 issue blocks the run: <first title> · 2 warnings`; '' when nothing is wrong. */
export function stripSummary(report: PreflightReport, start: boolean): string {
  const blocking = groupBySameFix(report.blocking)
  const warnings = groupBySameFix(report.warnings)
  const w = warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`
  const lead = start ? 'No run was created. ' : ''
  const first = blocking[0]?.check.title
  if (first !== undefined) {
    const b = blocking.length === 1 ? '1 issue blocks the run' : `${blocking.length} issues block the run`
    return `${lead}${b}: ${first}${warnings.length > 0 ? ` · ${w}` : ''}`
  }
  const firstWarning = warnings[0]?.check.title
  if (firstWarning !== undefined) return `${lead}${w}: ${firstWarning}`
  return start ? 'No run was created.' : ''
}

export function PreflightStrip({
  report,
  source,
  folder,
  checking,
  error,
  onRecheck,
  onOverrides,
}: PreflightStripProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [okOpen, setOkOpen] = useState(false)
  const detailsId = useId()
  const recheck = (): unknown => onRecheck()
  const start = source === 'start' && report !== null
  const ok = report !== null ? okChecks(report) : []
  const blocking = report !== null ? groupBySameFix(report.blocking) : []
  const warnings = report !== null ? groupBySameFix(report.warnings) : []
  const issues = blocking.length + warnings.length > 0
  const hosts = sandboxHosts([...blocking, ...warnings])
  const hostsHere = (c: CheckResult): boolean => {
    const a = setupActionOf(c)
    return a !== undefined && hosts.get(a.id) === c.id
  }
  const trusts = trustHosts([...blocking, ...warnings])
  const trustsHere = (c: CheckResult): boolean => {
    const a = trustActionOf(c)
    return a !== undefined && trusts.get(trustVendorOf(a)) === c.id
  }
  const summary = report !== null ? stripSummary(report, start) : ''
  const Icon = blocking.length > 0 ? OctagonX : TriangleAlert
  const info = !start && report !== null && report.info.length > 0 ? report.info : null
  // The tallest the open details have been for this folder since the user last opened them (px); see the header.
  const roomRef = useRef<HTMLDivElement | null>(null)
  const [room, setRoom] = useState<{ folder: string; px: number }>({ folder, px: 0 })
  // Bumped when the user opens or closes a chip: the room is measured again right after (their change may shrink it).
  const [measure, setMeasure] = useState(0)
  const kept = room.folder === folder ? room.px : 0
  useLayoutEffect(() => {
    const el = roomRef.current
    if (!open || el === null) return
    const grow = (): void => {
      const h = el.getBoundingClientRect().height
      setRoom((r) => {
        const px = r.folder === folder ? r.px : 0
        return h > px ? { folder, px: h } : r
      })
    }
    grow()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(grow)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, folder, issues, measure])
  // Each chip's place while the details stay open (placeInSlots), and the tallest each place has been (px). They start
  // afresh when the user opens or hides the details, checks again or runs, and for another folder.
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const hold = useRef<{ epoch: string; slots: HeldSlot[]; heights: number[] }>({
    epoch: '',
    slots: [],
    heights: [],
  })
  const epoch = JSON.stringify([folder, source, open, layoutEpoch])
  if (hold.current.epoch !== epoch) hold.current = { epoch, slots: [], heights: [] }
  const { rows, waiting } = open
    ? placeInSlots<ChipItem>(hold.current.slots, [
        ...blocking.map((g, i) => ({
          key: `${g.check.id}#${i}`,
          title: g.check.title,
          item: { g, severity: 'blocking' } satisfies ChipItem,
        })),
        ...warnings.map((g, i) => ({
          key: `${g.check.id}#${i}`,
          title: g.check.title,
          item: { g, severity: 'warning' } satisfies ChipItem,
        })),
      ])
    : { rows: [], waiting: 0 }
  // After each layout: the tallest each place has been, which it keeps (applied from the next render on).
  useLayoutEffect(() => {
    const el = roomRef.current
    if (el === null) return
    const heights = hold.current.heights
    for (const node of el.querySelectorAll<HTMLElement>('[data-slot]')) {
      const i = Number(node.dataset['slot'])
      const h = node.getBoundingClientRect().height
      if (Number.isInteger(i) && h > (heights[i] ?? 0)) heights[i] = h
    }
  })
  const slotHeight = (slot: number): number | undefined => {
    const h = hold.current.heights[slot]
    return h !== undefined && h > 0 ? h : undefined
  }
  const chipToggled = (): void => {
    setRoom({ folder, px: 0 })
    // The user changed a chip's height: every place is measured again.
    hold.current.heights = []
    setMeasure((n) => n + 1)
  }
  const toggleDetails = (): void => {
    setRoom({ folder, px: 0 })
    setLayoutEpoch((n) => n + 1)
    setOpen((v) => !v)
  }
  return (
    <section
      aria-label="Checks before the run"
      data-testid="preflight-strip"
      data-source={source}
      aria-busy={checking || undefined}
      className="flex flex-col gap-1.5"
    >
      {/* One line that never wraps: [Check again] first, so the texts after it come and go without moving it. */}
      <div data-testid="preflight-summary" className="flex h-7 min-w-0 items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="preflight-recheck"
          icon={<RefreshCw aria-hidden />}
          loading={checking}
          onClick={() => {
            setRoom({ folder, px: 0 })
            setLayoutEpoch((n) => n + 1)
            void onRecheck()
          }}
          className="h-6 text-xs text-muted-foreground"
        >
          Check again
        </Button>
        {info !== null && (
          <button
            type="button"
            data-testid="preflight-ok"
            aria-expanded={okOpen}
            onClick={() => setOkOpen((v) => !v)}
            className="inline-flex shrink-0 items-center rounded-full border border-success/40 px-2.5 py-0.5 text-xs text-success tabular-nums outline-none hover:bg-success/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <StableLabel labels={OK_CHIP_RESERVE}>
              ✓ {ok.length} {ok.length === 1 ? 'check' : 'checks'} ok
            </StableLabel>
          </button>
        )}
        {error !== null ? (
          <p
            className="min-w-0 flex-1 truncate text-xs text-destructive"
            data-testid="preflight-error"
            title={`Could not check this folder: ${error}`}
          >
            Could not check this folder: {error}
          </p>
        ) : report === null ? (
          <p
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="preflight-checking"
          >
            Checking the folder and vendors…
          </p>
        ) : (
          <p
            {...(start ? { role: 'alert', 'data-testid': 'composer-blockers' } : {})}
            data-severity={blocking.length > 0 ? 'blocking' : issues ? 'warning' : undefined}
            title={summary !== '' ? summary : undefined}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 text-xs',
              blocking.length > 0 ? 'font-medium text-destructive' : 'text-muted-foreground',
            )}
          >
            {issues && (
              <Icon
                aria-hidden
                className={cn('size-3.5 shrink-0', blocking.length > 0 ? 'text-destructive' : 'text-warning')}
              />
            )}
            <span className="min-w-0 truncate" data-testid="preflight-summary-text">
              {summary}
            </span>
          </p>
        )}
        {(issues || (open && kept > 0)) && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="preflight-details"
            aria-expanded={open}
            aria-controls={detailsId}
            icon={<ChevronDown aria-hidden className={cn('transition-transform', open && 'rotate-180')} />}
            labels={DETAILS_LABELS}
            title={
              open && waiting > 0
                ? `${waiting} more ${waiting === 1 ? 'check' : 'checks'} reported since the details opened: hide and show them to see ${waiting === 1 ? 'it' : 'them'}`
                : undefined
            }
            onClick={toggleDetails}
            className="h-6 text-xs"
          >
            {open ? 'Hide details' : 'Show details'}
          </Button>
        )}
      </div>
      {open && (issues || kept > 0) && (
        <div
          ref={roomRef}
          id={detailsId}
          data-testid="preflight-details-room"
          data-waiting={waiting > 0 ? waiting : undefined}
          style={kept > 0 ? { minHeight: kept } : undefined}
        >
          {issues ? (
            <ul data-testid="preflight-chips" className="flex flex-col gap-1.5">
              {rows.map((r) =>
                r.kind === 'chip' ? (
                  <Chip
                    key={`${r.item.severity === 'blocking' ? 'b' : 'w'}-${r.key}`}
                    check={r.item.g.check}
                    also={r.item.g.also}
                    severity={r.item.severity}
                    folder={folder}
                    defaultOpen={start && r.item.severity === 'blocking'}
                    sandboxHere={hostsHere(r.item.g.check)}
                    trustHere={trustsHere(r.item.g.check)}
                    onRecheck={recheck}
                    onOverrides={onOverrides}
                    onUserToggle={chipToggled}
                    slot={r.slot}
                    minHeight={slotHeight(r.slot)}
                  />
                ) : (
                  <li
                    key={`c-${r.key}`}
                    data-testid={`preflight-cleared-${r.key.replace(/#\d+$/, '')}`}
                    data-slot={r.slot}
                    style={slotHeight(r.slot) !== undefined ? { minHeight: slotHeight(r.slot) } : undefined}
                    className="flex items-start gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-sm text-muted-foreground"
                  >
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                    <p className="min-w-0 flex-1">Cleared: {r.title}</p>
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p data-testid="preflight-details-clear" className="text-xs text-muted-foreground">
              Nothing blocks the run now.
            </p>
          )}
        </div>
      )}
      {okOpen && info !== null && (
        <ul
          data-testid="preflight-ok-list"
          className="flex flex-col gap-0.5 pl-3 text-xs text-muted-foreground"
        >
          {info.map((c, i) => (
            <li key={`${c.id}-${i}`} data-check-id={c.id}>
              {c.status === 'skip' ? 'Skipped: ' : '✓ '}
              <span className="text-foreground">{c.title}</span>
              {c.detail !== '' ? ` · ${c.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
