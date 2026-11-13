// One vendor in Settings → Vendors: health, version against the floor /
// recommended / tested-up-to versions with core's warning, route, the executable path (save, auto-detect,
// candidates), default model, install command, every check with its fixes, and Test (= a forced probe). Flag
// overrides arrive in a later version. A deep link focuses the path or the model field. What each mode can
// do on this vendor's route (core's support() copy from the probe: Codex is sandbox-gated) and, for Codex on Windows,
// its sandbox: the sandbox chip with [Set up the Codex sandbox], its progress and core's answer. A vendor that works
// only in folders the user trusted for it (Gemini) lists those folders last, each with [Revoke] (Undo in its toast);
// its path, version against floor and tested-up-to, checks with fixes, default model and Test are every vendor's.
//
// A deep link scrolls the field into view: that is the direct result of the user's navigation (UI standard:
// nothing scrolls automatically except as the direct result of a user action). The model field waits for the user's
// settings, so it may exist only later; if the user has scrolled the page since the link was followed, the field is
// focused where it is and the page is left alone.
import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProbeView, SupportStatus } from '@shared/vendors.ts'
import { needsFolderTrust, supportsEffort } from '@shared/vendors.ts'
import { vendorCheckId } from '@shared/preflight.ts'
import { MODES } from '@shared/run.ts'
import type { Mode } from '@shared/run.ts'
import { SandboxChip } from '../../../components/recovery/SandboxChip.tsx'
import { winSandboxCheck } from '../../../components/recovery/sandboxSetup.ts'
import { useMainScroller } from '../../../components/shell/mainScroll.ts'
import { HealthDot, probeVersion, reprobe } from '../../../components/shell/VendorHealth.tsx'
import { Badge } from '../../../components/ui/Badge.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { getDimFactory } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { MODE_LABEL, modeSupportOf } from '../../dashboard/composer/model.ts'
import { LaterButton } from '../kit.tsx'
import { ChecksList } from './ChecksList.tsx'
import { DefaultEffort } from './DefaultEffort.tsx'
import { DefaultModel, useModels } from './DefaultModel.tsx'
import type { VendorField } from './deepLink.ts'
import { PathField } from './PathField.tsx'
import { TrustedFolders } from './TrustedFolders.tsx'
import type { VendorUserConfig } from './userConfig.ts'

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // The value sits beside its label where the card has room for both (the label's 7 rem and 12 rem of value), else
    // under it at the card's full width, however narrow: never wider than the card.
    <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
      <dt className="w-28 shrink-0 pt-0.5 text-muted-foreground">
        {htmlFor !== undefined ? <label htmlFor={htmlFor}>{label}</label> : label}
      </dt>
      <dd className="min-w-0 grow basis-48 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

/**
 * The vendor's default model and (for a vendor with an effort setting) default effort, from one read of its models
 * (vendors.models, else the probe's): the effort levels are the ones the default model lists.
 */
function ModelDefaults({
  view,
  config,
  modelId,
  onSaved,
}: {
  view: ProbeView
  config: VendorUserConfig
  modelId: string
  onSaved: () => void
}): React.JSX.Element {
  const models = useModels(view)
  return (
    <>
      <Field label="Default model" htmlFor={modelId}>
        <DefaultModel
          key={String(config.defaultModel)}
          view={view}
          models={models}
          current={config.defaultModel}
          triggerId={modelId}
          onSaved={onSaved}
        />
      </Field>
      {supportsEffort(view.vendor) && (
        <Field label="Default effort">
          <DefaultEffort
            key={String(config.defaultEffort)}
            view={view}
            models={models}
            model={config.defaultModel}
            current={config.defaultEffort}
            onSaved={onSaved}
          />
        </Field>
      )}
    </>
  )
}

/** Where the card's Sandbox row is: the checks list points there instead of repeating its fixes. */
export const SANDBOX_FIXES_ABOVE = 'Set it up in the Sandbox row above.'

const SUPPORT_WORD = { supported: 'Yes', degraded: 'Limited', unsupported: 'Not available' } as const

type ModeRow = { mode: Mode; s: { status: SupportStatus; copy: string } }

/** Each mode as core's probe states it on this route (support() per mode); empty when core did not say. */
export function modeRows(view: ProbeView): ModeRow[] {
  return MODES.flatMap((mode) => {
    const s = modeSupportOf(view, mode)
    return s !== undefined ? [{ mode, s }] : []
  })
}

function ModesList({ view, rows }: { view: ProbeView; rows: readonly ModeRow[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5" data-testid={`vendor-modes-${view.vendor}`}>
      {rows.map(({ mode, s }) => (
        <li key={mode} data-mode={mode} data-support={s.status}>
          <span className="font-medium">{MODE_LABEL[mode]}</span>
          <span
            className={cn(
              s.status === 'unsupported'
                ? 'text-destructive'
                : s.status === 'degraded'
                  ? 'text-warning'
                  : 'text-muted-foreground',
            )}
          >
            {`: ${SUPPORT_WORD[s.status]}${s.copy !== '' ? `. ${s.copy}` : ''}`}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** `at least 2.1.281 · recommended 2.1.287 · tested up to 2.1.289`. */
function supportedText(view: ProbeView): string | null {
  const parts = [
    view.versionFloor !== null ? `at least ${view.versionFloor}` : null,
    view.versionRecommended !== null ? `recommended ${view.versionRecommended}` : null,
    view.testedUpTo !== null ? `tested up to ${view.testedUpTo}` : null,
  ].filter((x) => x !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function VendorCard({
  view,
  config,
  focus,
  focusKey,
  onConfigSaved,
}: {
  view: ProbeView
  /** The user's settings for this vendor; null while they are being read. */
  config: VendorUserConfig | null
  /** The field a deep link points at (null: the card), or undefined when the link is not about this vendor. */
  focus: VendorField | null | undefined
  /** Changes with each navigation, so a link focuses once. */
  focusKey: string
  onConfigSaved: () => void
}): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const probe = view.probe
  const version = probeVersion(view)
  const vendor = view.vendor
  const pathId = `vendor-path-input-${vendor}`
  const modelId = `vendor-model-${vendor}`
  const versionCheck = probe?.checks.find((c) => c.id === vendorCheckId(vendor, 'version'))
  const versionNote = versionCheck !== undefined && versionCheck.status !== 'pass' ? versionCheck : undefined
  const install = probe?.checks
    .find((c) => c.id === vendorCheckId(vendor, 'bin'))
    ?.recovery.find((a) => a.kind === 'shell_copy')
  const supported = supportedText(view)
  const modes = modeRows(view)
  // Codex's Windows sandbox (probe `windowsSandbox/readiness`): a row of its own once core reports it, and on
  // Windows for Codex from the start (its line says it is being checked), so the row itself does not arrive later; a
  // sandbox that needs setting up gets the chip's button with core's first answer, as the checks below arrive.
  const sandboxCheck = winSandboxCheck(view)
  const sandboxRow =
    sandboxCheck !== undefined || (vendor === 'codex' && getDimFactory()?.platform === 'win32')

  // Once per navigation (focusKey), as soon as the field exists (the model picker waits for the user's settings).
  const focusedFor = useRef<string | null>(null)
  /** Where the page was scrolled when this navigation's link was followed. */
  const scrolledAt = useRef<{ key: string; top: number } | null>(null)
  const main = useMainScroller()
  const configReady = config !== null
  useEffect(() => {
    if (focus === undefined || focusedFor.current === focusKey) return
    if (scrolledAt.current?.key !== focusKey)
      scrolledAt.current = { key: focusKey, top: main?.scrollTop ?? 0 }
    const target =
      focus === 'path'
        ? document.getElementById(pathId)
        : focus === 'defaultModel'
          ? document.getElementById(modelId)
          : cardRef.current
    if (target === null) return
    focusedFor.current = focusKey
    const userScrolled = main !== null && Math.abs(main.scrollTop - scrolledAt.current.top) > 1
    if (!userScrolled) target.scrollIntoView?.({ block: 'center' })
    target.focus({ preventScroll: true })
  }, [focus, focusKey, configReady, pathId, modelId, main])

  const test = async (): Promise<void> => {
    setTesting(true)
    await reprobe(vendor)
    setTesting(false)
  }

  return (
    <article
      ref={cardRef}
      tabIndex={-1}
      data-testid={`settings-vendor-${vendor}`}
      aria-labelledby={`vendor-title-${vendor}`}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        focus !== undefined && 'ring-1 ring-ring/40',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <HealthDot health={testing || view.checking ? 'checking' : view.health} />
        <h3 id={`vendor-title-${vendor}`} className="text-sm font-semibold">
          {view.displayName}
        </h3>
        {view.experimental && <Badge variant="outline">Experimental</Badge>}
        {/* Takes the free space and truncates: "Checking…" vs a long health detail never wraps Test. */}
        <span
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
          aria-live="polite"
          title={testing || view.checking ? undefined : view.healthDetail}
        >
          {testing || view.checking ? 'Checking…' : view.healthDetail}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            data-testid={`vendor-test-${vendor}`}
            icon={<RefreshCw aria-hidden />}
            loading={testing || view.checking}
            title="Check this CLI again now (no tokens are spent)"
            onClick={() => void test()}
          >
            Test
          </Button>
        </div>
      </header>
      <dl className="flex flex-col gap-2 text-xs">
        <Field label="Version">
          <span className="tabular-nums">{version ?? 'Not found'}</span>
          {supported !== null && <span className="text-muted-foreground"> · {supported}</span>}
          {versionNote !== undefined && (
            <span
              className={cn('block', versionNote.status === 'fail' ? 'text-destructive' : 'text-warning')}
              data-testid={`vendor-version-note-${vendor}`}
            >
              {versionNote.title}
            </span>
          )}
        </Field>
        <Field label="Route">
          {probe?.route !== undefined
            ? `${probe.route}${probe.transport !== undefined ? ` (${probe.transport})` : ''}`
            : probe === null
              ? 'Not checked yet'
              : 'Unknown'}
        </Field>
        <Field label="Executable" htmlFor={pathId}>
          <PathField
            key={config?.path ?? ''}
            view={view}
            configured={config?.path}
            inputId={pathId}
            onSaved={onConfigSaved}
          />
        </Field>
        {config === null ? (
          <>
            <Field label="Default model" htmlFor={modelId}>
              <span className="text-muted-foreground">Reading your settings…</span>
            </Field>
            {supportsEffort(vendor) && (
              <Field label="Default effort">
                <span className="text-muted-foreground">Reading your settings…</span>
              </Field>
            )}
          </>
        ) : (
          <ModelDefaults view={view} config={config} modelId={modelId} onSaved={onConfigSaved} />
        )}
        {install?.kind === 'shell_copy' && (
          <Field label="Install command">
            <code className="font-mono select-all">{install.command}</code>
          </Field>
        )}
        <Field label="Flag overrides">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">For a CLI that renamed a flag.</span>
            <LaterButton>Edit overrides</LaterButton>
          </span>
        </Field>
        {probe !== null && <Field label="Checked">{new Date(probe.at).toLocaleString()}</Field>}
        {/* What the probe says, last (with the checks below): a first probe arriving moves nothing above it. */}
        <Field label="Modes">
          {probe === null ? (
            <span className="text-muted-foreground">Not checked yet</span>
          ) : modes.length > 0 ? (
            <ModesList view={view} rows={modes} />
          ) : (
            <span className="text-muted-foreground">Not reported</span>
          )}
        </Field>
        {sandboxRow && (
          <Field label="Sandbox">
            <div data-testid={`vendor-sandbox-${vendor}`}>
              <SandboxChip vendor={vendor} testId={`vendor-sandbox-setup-${vendor}`} />
            </div>
          </Field>
        )}
      </dl>
      {probe === null ? (
        <p className="text-xs text-muted-foreground">
          {view.checking ? 'Checking now…' : 'Not checked yet. Press Test to check it.'}
        </p>
      ) : (
        <ChecksList
          label={`${view.displayName} checks`}
          checks={probe.checks}
          fixesElsewhere={
            sandboxRow ? { [vendorCheckId(vendor, 'winSandbox')]: SANDBOX_FIXES_ABOVE } : undefined
          }
        />
      )}
      {/* Last in the card, since how many there are is known only once core answered. */}
      {needsFolderTrust(vendor) && <TrustedFolders vendor={vendor} name={view.displayName} />}
    </article>
  )
}
