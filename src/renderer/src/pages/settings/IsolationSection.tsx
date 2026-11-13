// Settings → Isolation & Verify (defaults, and the verify commands with their trust state; the `isolation` and
// `verify` keys and trust.json).
// Both halves are live. The chosen project comes first, since every write goes to its dimfactory.json (or to your
// settings when no project is chosen). The Isolation half (isolation/IsolationGroup.tsx): run location, a new
// branch, the files copied into an isolated copy, the dependency install (ask, when trusted, never; and the command,
// split as core splits it with shell syntax refused) and applying on its own in Auto. The Verify half's defaults (on,
// after Implement and/or Fix, stop at the first failure, and the baseline check of isolated runs) are core's
// resolved values (config.resolve), and each control writes one config.patch with Undo (writeConfig). The commands are
// a project's: the configured list (`verify.commands`) and what discovery found there (verify.detect), each with its
// trust state; Trust and Untrust write trust.json (trust.set, with Undo), and turning a command on or off, removing it
// or adding one of your own replaces the list with one config.patch (Undo). A custom command is split as core splits
// it and shell syntax is refused with core's words (verify/argv.ts).
// Nothing is read until the section has been open a moment (sectionData.ts), so a section switch costs no IPC (performance.spec.ts);
// the command table, whose length is unknown until core answers, comes last, so nothing shown moves when it arrives.
// Clarify before Plan and Fix until green have their groups after the security review (isolation/RunLoopGroups.tsx).
// The rows carry their Settings index fields (index.ts), so the palette's links land on them.
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ResolvedConfig, VerifyCommandConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ResolvedWithProvenance, TrustGrantInput } from '@shared/ipc.ts'
import type { VerifyCommand } from '@shared/verify.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { writeConfig } from './general/configWrite.ts'
import type { ConfigTarget } from './general/configWrite.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { SourceBadge } from './general/SourceBadge.tsx'
import { IsolationGroup } from './isolation/IsolationGroup.tsx'
import type { IsolationSettings } from './isolation/IsolationGroup.tsx'
import { RunLoopGroups, runLoopOf } from './isolation/RunLoopGroups.tsx'
import { Group, SettingRow } from './kit.tsx'
import { useSectionData } from './sectionData.ts'
import { AddCommand } from './verify/AddCommand.tsx'
import { VerifyCommands } from './verify/VerifyCommands.tsx'
import { verifyRows, withEnabled, withoutRow, withSuggested } from './verify/model.ts'
import type { VerifyRow } from './verify/model.ts'
import { BRAND } from '@shared/brand.ts'

const UNDO_TOAST = 'verify-undo'

export const VERIFY_ENABLED_LABEL = 'Verify changes'
export const FAIL_FAST_LABEL = 'Stop at the first failure'
export const RUN_AFTER_LABEL = 'When to verify'
export const BASELINE_LABEL = 'Baseline check'
export const NO_PROJECT = 'Choose a project above to see its commands.'
export const READING_COMMANDS = 'Looking for commands…'
export const NO_COMMANDS =
  'No commands yet. Add one of your own, or add a script such as test to the project and detect again.'

type VerifySettings = ResolvedConfig['verify']
type RunAfter = VerifySettings['runAfter'][number]

const DEFAULT_VERIFY: VerifySettings = {
  enabled: false,
  commands: [],
  runAfter: ['implement', 'fix'],
  failFast: false,
  baseline: false,
}

/** The deep link's key: the section remounts with the link's folder when another link opens it. */
function linkKey(route: Route): string {
  if (route.name !== 'settings') return ''
  return `${route.subpath.join('/')}?${new URLSearchParams(route.query).toString()}`
}

export function IsolationSection(): React.JSX.Element {
  const route = useRoute()
  const folder = route.name === 'settings' ? (route.query['folder'] ?? null) : null
  return <IsolationBody key={linkKey(route)} initialFolder={folder !== '' ? folder : null} />
}

const DEFAULT_ISOLATION: IsolationSettings = {
  mode: 'inPlace',
  branch: 'none',
  branchPrefix: BRAND.branchPrefix,
  worktree: { copy: [], install: 'ask', installCommand: null, autoApply: false },
}

/**
 * core's resolved `isolation` (read defensively, like `verify`), with the values just written shown at once until core's
 * next answer replaces them; null while it loads.
 */
function isolationOf(
  view: ResolvedWithProvenance | null,
  pending: Readonly<Record<string, unknown>>,
): IsolationSettings | null {
  if (view === null) return null
  const i = (view.config as Partial<ResolvedConfig>).isolation
  const base: IsolationSettings = {
    ...DEFAULT_ISOLATION,
    ...(i ?? {}),
    worktree: { ...DEFAULT_ISOLATION.worktree, ...(i?.worktree ?? {}) },
  }
  const at = <T,>(key: string, cur: T): T => (key in pending ? (pending[key] as T) : cur)
  return {
    ...base,
    mode: at('/isolation/mode', base.mode),
    branch: at('/isolation/branch', base.branch),
    worktree: {
      copy: at('/isolation/worktree/copy', base.worktree.copy),
      install: at('/isolation/worktree/install', base.worktree.install),
      installCommand: at('/isolation/worktree/installCommand', base.worktree.installCommand),
      autoApply: at('/isolation/worktree/autoApply', base.worktree.autoApply),
    },
  }
}

/** The security advisor's settings as core resolved them (an older core or a test double may have no Security pass). */
function securityOf(
  view: ResolvedWithProvenance | null,
  pending: Readonly<Record<string, unknown>>,
): { enabled: boolean; recheck: boolean } | null {
  if (view === null) return null
  const passes = (view.config as Partial<ResolvedConfig>).passes as
    Partial<Record<string, { enabled?: boolean; recheck?: boolean }>> | undefined
  const sec = passes?.['security']
  const at = (key: string, cur: boolean): boolean => (typeof pending[key] === 'boolean' ? pending[key] : cur)
  return {
    enabled: at('/passes/security/enabled', sec?.enabled ?? false),
    recheck: at('/passes/security/recheck', sec?.recheck ?? true),
  }
}

/** The Security review switch's label (Settings and its tests). */
export const SECURITY_ENABLED_LABEL = 'Security review'
export const SECURITY_RECHECK_LABEL = 'Re-check after Fix'

/** core's resolved `verify` (read defensively: an older core or a test double may leave keys out). */
function verifyOf(view: ResolvedWithProvenance | null): VerifySettings | null {
  if (view === null) return null
  const v = (view.config as Partial<ResolvedConfig>).verify
  return { ...DEFAULT_VERIFY, ...(v ?? {}) }
}

function IsolationBody({ initialFolder }: { initialFolder: string | null }): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(initialFolder)
  const epoch = useConfigEpoch()
  const resolved = useSectionData(
    `resolve\u0000${folder ?? ''}`,
    () => invoke('config.resolve', folder !== null ? { folder } : {}),
    epoch,
  )
  const detected = useSectionData<VerifyCommand[]>(
    folder !== null ? `detect\u0000${folder}` : null,
    () => invoke('verify.detect', { folder: folder ?? '' }),
    epoch,
  )
  const verify = verifyOf(resolved.value)
  const target: ConfigTarget = folder !== null ? { scope: 'project', folder } : { scope: 'user' }

  // A value just written shows at once and until core's next answer replaces it.
  const [pending, setPending] = useState<Readonly<Record<string, unknown>>>({})
  useEffect(() => setPending({}), [resolved.value])
  const runLoop = runLoopOf(resolved.value, pending)
  // Research's generic lenses for its lens picker (brief.detect without a folder), read only while Research is on.
  const briefCtx = useSectionData(
    runLoop?.research === true ? 'brief-detect' : null,
    () => invoke('brief.detect', {}),
    epoch,
  )
  const [busy, setBusy] = useState<string | null>(null)

  const reload = (): void => {
    resolved.reload()
    detected.reload()
  }

  const write = async (
    key: string,
    ops: JsonPatchOp[],
    message: string,
    shown?: unknown,
  ): Promise<boolean> => {
    if (shown !== undefined) setPending((p) => ({ ...p, [key]: shown }))
    setBusy(key)
    const res = await writeConfig({ target, ops, message, toastId: UNDO_TOAST, onSettled: reload })
    setBusy(null)
    if (res === null) {
      setPending((p) => {
        const { [key]: _gone, ...rest } = p
        return rest
      })
    }
    return res !== null
  }

  const value = <K extends keyof VerifySettings>(k: K): VerifySettings[K] | undefined =>
    (pending[`/verify/${k}`] as VerifySettings[K] | undefined) ?? verify?.[k]

  const enabled = value('enabled')
  const runAfter = value('runAfter')
  const failFast = value('failFast')
  const baseline = value('baseline')
  const loading = verify === null
  const provenance = resolved.value?.provenance
  const isolation = isolationOf(resolved.value, pending)
  const security = securityOf(resolved.value, pending)

  const list: readonly VerifyCommandConfig[] = value('commands') ?? []
  // Async content never shifts the page: the rows show once both answers are in. Rows drawn from
  // config.resolve alone grew a Script line, or a diff row, when verify.detect answered after it.
  const listReady = folder !== null && verify !== null && (detected.value !== null || detected.error !== null)
  const rows = listReady ? verifyRows(list, detected.value) : []
  const commandsOff = folder === null ? NO_PROJECT : !listReady ? READING_COMMANDS : null
  const suggestions = rows.filter((r) => r.configIndex === null && r.suggested && r.error === null)
  const where = folder !== null ? folderBaseName(folder) : null

  const writeList = async (key: string, next: VerifyCommandConfig[], message: string): Promise<boolean> => {
    // The list just written shows at once (the row's switch, a removed row), until core's next answer.
    setPending((p) => ({ ...p, '/verify/commands': next }))
    const ok = await write(key, [{ op: 'replace', path: '/verify/commands', value: next }], message)
    if (!ok) {
      setPending((p) => {
        const { ['/verify/commands']: _gone, ...rest } = p
        return rest
      })
    }
    return ok
  }

  const onEnable = (row: VerifyRow, on: boolean): void => {
    void writeList(
      row.key,
      withEnabled(list, row, on),
      on ? `${row.name} runs in verify` : `${row.name} turned off`,
    )
  }
  const onRemove = (row: VerifyRow): void => {
    void writeList(row.key, withoutRow(list, row), `Removed ${row.name}`)
  }
  const onTrust = async (row: VerifyRow, trusted: boolean): Promise<void> => {
    if (folder === null) return
    const grant: TrustGrantInput = {
      kind: 'command',
      command: {
        kind: 'verify',
        argv: row.argv,
        cwdRel: row.cwdRel,
        ...(row.hash !== null ? { hash: row.hash } : {}),
      },
    }
    setBusy(row.key)
    const r = await invoke('trust.set', { folder, grant, trusted })
    setBusy(null)
    detected.reload()
    if (!r.ok) {
      toast({ level: 'error', message: r.error.message })
      return
    }
    const undo = async (): Promise<void> => {
      const u = await invoke('trust.set', { folder, grant, trusted: !trusted })
      if (!u.ok) toast({ level: 'error', message: u.error.message })
      detected.reload()
    }
    toast({
      id: UNDO_TOAST,
      level: 'info',
      message: trusted ? `Trusted ${row.name} for this project` : `${row.name} is no longer trusted`,
      action: { label: 'Undo', onClick: undo },
    })
  }

  const setRunAfter = (pass: RunAfter, on: boolean): void => {
    const cur = runAfter ?? DEFAULT_VERIFY.runAfter
    const next = (['implement', 'fix'] as const).filter((p) => (p === pass ? on : cur.includes(p)))
    const words =
      next.length === 0
        ? 'never'
        : next.map((p) => (p === 'implement' ? 'after Implement' : 'after Fix')).join(' and ')
    void write(
      '/verify/runAfter',
      [{ op: 'replace', path: '/verify/runAfter', value: next }],
      `Verify runs ${words}`,
      next,
    )
  }

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="settings-isolation"
      aria-busy={(loading && resolved.error === null) || undefined}
    >
      <p className="text-sm text-muted-foreground">
        Verify runs commands you trust, such as your tests, to check each change. A failing command becomes a
        must-fix finding for Fix; a command that cannot run on this computer is never a finding.
      </p>
      {resolved.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The settings could not be read: {resolved.error}
        </p>
      )}
      <Group
        title="Project"
        description="With a project chosen, changes here are saved to its settings; without one, the defaults are saved to your settings. Verify commands belong to a project."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="verify-folder" />
        <p role="status" data-testid="verify-scope" className="min-h-4 text-xs text-muted-foreground">
          {where !== null
            ? `Saved to ${where}'s dimfactory.json.`
            : 'Saved to your settings, for every project.'}
        </p>
      </Group>

      <IsolationGroup iso={isolation} provenance={provenance} busy={busy} write={write} />

      <Group
        title="Security review"
        description="An extra read-only reviewer on the strongest model checks each change for security problems, after a scan that costs no tokens (secrets in the change, and audits of the dependencies it adds or changes). It is off unless you turn it on here, in the thorough profile, or for one run in the composer."
      >
        <div>
          <SettingRow
            label={SECURITY_ENABLED_LABEL}
            description="Runs the security scan and reviewer on every run. It adds about one more review's cost."
            field="/passes/security/enabled"
          >
            <SourceBadge
              provenance={provenance?.['/passes/security/enabled']}
              loading={loading}
              testId="security-enabled-source"
            />
            <Switch
              data-testid="security-setting-enabled"
              aria-label={SECURITY_ENABLED_LABEL}
              checked={security?.enabled === true}
              disabled={security === null || busy === '/passes/security/enabled'}
              onCheckedChange={(v) =>
                void write(
                  '/passes/security/enabled',
                  [{ op: 'replace', path: '/passes/security/enabled', value: v }],
                  v ? 'Security review is on' : 'Security review is off',
                  v,
                )
              }
            />
          </SettingRow>
          <SettingRow
            label={SECURITY_RECHECK_LABEL}
            description="After Fix, a short read-only pass confirms each security must-fix is resolved; one still open ends the run as Completed with failures."
            field="/passes/security/recheck"
          >
            <SourceBadge
              provenance={provenance?.['/passes/security/recheck']}
              loading={loading}
              testId="security-recheck-source"
            />
            <Switch
              data-testid="security-setting-recheck"
              aria-label={SECURITY_RECHECK_LABEL}
              checked={security?.recheck === true}
              disabled={security === null || busy === '/passes/security/recheck'}
              onCheckedChange={(v) =>
                void write(
                  '/passes/security/recheck',
                  [{ op: 'replace', path: '/passes/security/recheck', value: v }],
                  v ? 'The security re-check after Fix is on' : 'The security re-check after Fix is off',
                  v,
                )
              }
            />
          </SettingRow>
        </div>
      </Group>

      <RunLoopGroups
        settings={runLoop}
        provenance={provenance}
        busy={busy}
        loading={loading}
        write={write}
        lenses={briefCtx.value?.research ?? null}
      />

      <Group title="Verify">
        <div>
          <SettingRow
            label={VERIFY_ENABLED_LABEL}
            description="Runs the commands below on every run. The composer can turn it off for one run."
            field="/verify/enabled"
          >
            <SourceBadge
              provenance={provenance?.['/verify/enabled']}
              loading={loading}
              testId="verify-enabled-source"
            />
            <Switch
              data-testid="verify-setting-enabled"
              aria-label={VERIFY_ENABLED_LABEL}
              checked={enabled === true}
              disabled={loading || busy === '/verify/enabled'}
              onCheckedChange={(v) =>
                void write(
                  '/verify/enabled',
                  [{ op: 'replace', path: '/verify/enabled', value: v }],
                  v ? 'Verify is on' : 'Verify is off',
                  v,
                )
              }
            />
          </SettingRow>
          <SettingRow
            label={RUN_AFTER_LABEL}
            description="After Implement, Review and Critic see the results. After Fix, a failure ends the run as Completed with failures."
            field="/verify/runAfter"
          >
            {(['implement', 'fix'] as const).map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  data-testid={`verify-after-${p}`}
                  checked={runAfter?.includes(p) === true}
                  disabled={loading || busy === '/verify/runAfter'}
                  onCheckedChange={(v) => setRunAfter(p, v === true)}
                />
                {p === 'implement' ? 'After Implement' : 'After Fix'}
              </label>
            ))}
          </SettingRow>
          <SettingRow
            label={FAIL_FAST_LABEL}
            description="Skip the remaining commands once one fails."
            field="/verify/failFast"
          >
            <SourceBadge
              provenance={provenance?.['/verify/failFast']}
              loading={loading}
              testId="verify-failfast-source"
            />
            <Switch
              data-testid="verify-setting-failfast"
              aria-label={FAIL_FAST_LABEL}
              checked={failFast === true}
              disabled={loading || busy === '/verify/failFast'}
              onCheckedChange={(v) =>
                void write(
                  '/verify/failFast',
                  [{ op: 'replace', path: '/verify/failFast', value: v }],
                  v ? 'Verify stops at the first failure' : 'Verify runs every command',
                  v,
                )
              }
            />
          </SettingRow>
          <SettingRow
            label="Check the commands before the run starts"
            description="Isolated runs only: failures that were already there are told apart from new ones."
            field="/verify/baseline"
          >
            <SourceBadge
              provenance={provenance?.['/verify/baseline']}
              loading={loading}
              testId="verify-baseline-source"
            />
            <Switch
              data-testid="verify-setting-baseline"
              aria-label={BASELINE_LABEL}
              checked={baseline === true}
              disabled={loading || busy === '/verify/baseline'}
              onCheckedChange={(v) =>
                void write(
                  '/verify/baseline',
                  [{ op: 'replace', path: '/verify/baseline', value: v }],
                  v ? 'Isolated runs check the commands first' : 'Isolated runs skip the first check',
                  v,
                )
              }
            />
          </SettingRow>
        </div>
      </Group>

      <Group
        title="Verify commands"
        description="A run uses the commands turned on here, and only once you trust them: trust covers the command and its script, so a changed script needs your trust again."
        field="/verify/commands"
      >
        <div className="flex flex-wrap items-center gap-2" data-setting-field="detect">
          <Button
            size="sm"
            variant="outline"
            data-testid="verify-detect"
            icon={<RefreshCw aria-hidden />}
            loading={folder !== null && detected.loading}
            disabled={folder === null}
            onClick={() => detected.reload()}
          >
            Detect commands
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="verify-use-suggested"
            disabled={commandsOff !== null || suggestions.length === 0 || busy !== null}
            onClick={() =>
              void writeList(
                'suggested',
                withSuggested(list, rows),
                `Added ${suggestions.length} detected ${suggestions.length === 1 ? 'command' : 'commands'}`,
              )
            }
          >
            Use the detected commands
          </Button>
        </div>
        <AddCommand
          list={list}
          disabledReason={commandsOff}
          onAdd={(entry) => writeList('add', [...list, entry], `Added ${entry.name}`)}
        />
        <VerifyCommands
          rows={rows}
          empty={commandsOff ?? NO_COMMANDS}
          busy={busy}
          disabledReason={commandsOff}
          onEnable={onEnable}
          onTrust={(r, t) => void onTrust(r, t)}
          onRemove={onRemove}
        />
        {detected.error !== null && (
          <p role="alert" className="text-xs text-destructive" data-testid="verify-detect-error">
            Commands could not be detected: {detected.error}
          </p>
        )}
      </Group>
    </div>
  )
}
