// Settings → Factory: how queued tasks run and what stops them (`factory`: Auto, the budgets and stop rules, isolated
// copies, how many at once; user only), the schedule (`factory.schedule`, user only, in-app only), fallback on a rate
// limit (`fallback`), model routing for the selected profile's routed steps (`profiles.<profile>.routing.<step>`),
// and with a project chosen, its project memory (`memory`, `memory.autoApply` only there) and quality gates
// (`quality`, project only). Values are core's resolved ones (config.resolve, for the chosen project), a value just
// written shows at once until core's next answer, and each control writes one config.patch with Undo (writeConfig).
// A box commits on Enter or blur; an empty box clears a limit (no limit) or a route (the step follows its pass).
import { useEffect, useId, useState } from 'react'
import type { FactorySettings, ResolvedConfig } from '@shared/config-schema.ts'
import { FACTORY_DEFAULTS } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { ROUTED_STEPS } from '@shared/run.ts'
import type { RoutedStep } from '@shared/run.ts'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { NumberField } from './general/controls.tsx'
import { pointer, writeConfig } from './general/configWrite.ts'
import type { ConfigTarget } from './general/configWrite.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { SourceBadge } from './general/SourceBadge.tsx'
import { Group, SettingRow } from './kit.tsx'
import { useSectionData } from './sectionData.ts'

const UNDO_TOAST = 'factory-undo'

export const SCHEDULE_OS_NOTE =
  'The schedule runs only while Dim Factory is open. Starting with the computer (a scheduled task or a startup entry) is not available yet; Dim Factory never adds one.'
export const RESUME_NOTE =
  'Off by default: when a schedule was due while Dim Factory was closed, it asks first. Runs that were interrupted never resume on their own either way.'
export const NEEDS_PROJECT =
  'Choose a project above: quality gates and writing memory without asking are set per project.'

export const ROUTED_STEP_LABEL: Readonly<Record<RoutedStep, string>> = {
  research: "Research (on Plan's vendor)",
  clarify: "Clarify (on Plan's vendor)",
  explain: "Explain (on Plan's vendor)",
  acceptance: "Acceptance review (on Review's vendor)",
  recheck: "Re-check (on Security's or Review's vendor)",
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export interface FactorySettingsView {
  factory: FactorySettings
  fallback: ResolvedConfig['fallback']
  memory: ResolvedConfig['memory']
  quality: ResolvedConfig['quality']
  routing: ResolvedConfig['routing']
  profile: string
  verifyNames: string[]
}

/** The factory's settings as core resolved them (keys an older core leaves out: their defaults), pending writes shown. */
export function factorySettingsOf(
  config: Partial<ResolvedConfig> | null,
  pending: Readonly<Record<string, unknown>>,
): FactorySettingsView | null {
  if (config === null) return null
  const at = <T,>(key: string, cur: T): T => (key in pending ? (pending[key] as T) : cur)
  const f = { ...FACTORY_DEFAULTS, ...(config.factory ?? {}) }
  const s = { ...FACTORY_DEFAULTS.schedule, ...(f.schedule ?? {}) }
  const factory: FactorySettings = {
    auto: at('/factory/auto', f.auto),
    maxCostPerRunUsd: at('/factory/maxCostPerRunUsd', f.maxCostPerRunUsd),
    maxCostPerDayUsd: at('/factory/maxCostPerDayUsd', f.maxCostPerDayUsd),
    maxMinutesPerRun: at('/factory/maxMinutesPerRun', f.maxMinutesPerRun),
    maxFixRounds: at('/factory/maxFixRounds', f.maxFixRounds),
    stopAfterFailures: at('/factory/stopAfterFailures', f.stopAfterFailures),
    skipBlocked: at('/factory/skipBlocked', f.skipBlocked),
    isolate: at('/factory/isolate', f.isolate),
    maxParallel: at('/factory/maxParallel', f.maxParallel),
    schedule: {
      enabled: at('/factory/schedule/enabled', s.enabled),
      start: at('/factory/schedule/start', s.start),
      end: at('/factory/schedule/end', s.end),
      days: at('/factory/schedule/days', [...s.days]),
      resumeAutomatically: at('/factory/schedule/resumeAutomatically', s.resumeAutomatically),
      onBattery: at('/factory/schedule/onBattery', s.onBattery),
    },
  }
  const fb = config.fallback ?? { enabled: false, vendors: [] }
  const m = config.memory ?? { enabled: true, propose: true, autoApply: false, maxBytes: 16_000 }
  const q = config.quality ?? { enabled: false, verify: [], security: false, acceptance: false }
  return {
    factory,
    fallback: {
      enabled: at('/fallback/enabled', fb.enabled),
      vendors: at('/fallback/vendors', [...fb.vendors]),
    },
    memory: {
      enabled: at('/memory/enabled', m.enabled),
      propose: at('/memory/propose', m.propose),
      autoApply: at('/memory/autoApply', m.autoApply),
      maxBytes: at('/memory/maxBytes', m.maxBytes),
    },
    quality: {
      enabled: at('/quality/enabled', q.enabled),
      verify: at('/quality/verify', [...q.verify]),
      security: at('/quality/security', q.security),
      acceptance: at('/quality/acceptance', q.acceptance),
    },
    routing: config.routing ?? {},
    profile: config.profile ?? 'balanced',
    verifyNames: (config.verify?.commands ?? []).filter((c) => c.enabled !== false).map((c) => c.name),
  }
}

/** A limit's box text ('' for no limit), and what a typed text means: a number, null (cleared) or undefined (refused). */
export function limitText(v: number | null): string {
  return v === null ? '' : String(v)
}
export function parseLimit(
  text: string,
  o: { int?: boolean; min?: number; max?: number } = {},
): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t.replace(/^\$/, ''))
  if (!Number.isFinite(n)) return undefined
  if (o.int === true && !Number.isInteger(n)) return undefined
  if (o.min !== undefined && n < o.min) return undefined
  if (o.max !== undefined && n > o.max) return undefined
  if (o.min === undefined && n <= 0) return undefined
  return n
}

/** A text box that commits on Enter or blur (Escape puts the saved value back). */
function TextField({
  value,
  label,
  testId,
  placeholder,
  disabled,
  width = 'w-40',
  onCommit,
}: {
  value: string | null
  label: string
  testId: string
  placeholder?: string
  disabled?: boolean
  width?: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = (): void => {
    if (value === null || text.trim() === value) return
    onCommit(text.trim())
  }
  return (
    <Input
      data-testid={testId}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      value={text}
      disabled={disabled === true || value === null}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') setText(value ?? '')
      }}
      className={`h-7 ${width} font-mono text-xs`}
    />
  )
}

export function FactorySection(): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null)
  const epoch = useConfigEpoch()
  const userView = useSectionData('factory-user', () => invoke('config.resolve', {}), epoch)
  const projectView = useSectionData(
    folder !== null ? `factory-project\u0000${folder}` : null,
    () => invoke('config.resolve', folder !== null ? { folder } : {}),
    epoch,
  )
  const [pending, setPending] = useState<Readonly<Record<string, unknown>>>({})
  useEffect(() => setPending({}), [userView.value, projectView.value])
  const [busy, setBusy] = useState<string | null>(null)
  const project = folder !== null ? projectView.value : null
  // User keys from the user view; memory and quality from the project's when one is chosen.
  const s = factorySettingsOf(
    (userView.value?.config as Partial<ResolvedConfig> | undefined) ?? null,
    pending,
  )
  const p = factorySettingsOf((project?.config as Partial<ResolvedConfig> | undefined) ?? null, pending)
  const mem = folder !== null ? p : s
  const userProv = userView.value?.provenance
  const projProv = project?.provenance
  const loading = s === null
  const errorId = useId()
  const [error, setError] = useState<string | null>(null)

  const write = async (
    key: string,
    ops: JsonPatchOp[],
    message: string,
    shown: unknown,
    target: ConfigTarget,
  ): Promise<boolean> => {
    setPending((x) => ({ ...x, [key]: shown }))
    setBusy(key)
    const res = await writeConfig({
      target,
      ops,
      message,
      toastId: UNDO_TOAST,
      onSettled: () => {
        userView.reload()
        projectView.reload()
      },
    })
    setBusy(null)
    if (res === null)
      setPending((x) => {
        const { [key]: _gone, ...rest } = x
        return rest
      })
    return res !== null
  }
  const user: ConfigTarget = { scope: 'user' }
  const memTarget: ConfigTarget = folder !== null ? { scope: 'project', folder } : user

  const toggle = (
    ptr: string,
    label: string,
    value: boolean | undefined,
    on: string,
    off: string,
    o: { target?: ConfigTarget; disabled?: boolean; prov?: typeof userProv } = {},
  ): React.JSX.Element => (
    <>
      <SourceBadge
        provenance={(o.prov ?? userProv)?.[ptr]}
        loading={loading}
        testId={`setting-source-${ptr}`}
      />
      <Switch
        data-testid={`setting-${ptr}`}
        aria-label={label}
        checked={value === true}
        disabled={loading || o.disabled === true || busy === ptr}
        onCheckedChange={(v) =>
          void write(ptr, [{ op: 'replace', path: ptr, value: v }], v ? on : off, v, o.target ?? user)
        }
      />
    </>
  )

  const limitField = (
    ptr: string,
    label: string,
    suffix: string,
    value: number | null | undefined,
    o: { int?: boolean; min?: number; max?: number; nullable?: boolean } = {},
  ): React.JSX.Element => (
    <>
      <SourceBadge provenance={userProv?.[ptr]} loading={loading} testId={`setting-source-${ptr}`} />
      <NumberField
        value={value === undefined ? null : limitText(value)}
        label={label}
        suffix={suffix}
        testId={`setting-${ptr}`}
        disabled={busy === ptr}
        errorId={errorId}
        invalid={error !== null && busy === null}
        onEdit={() => setError(null)}
        onCommit={async (text) => {
          const n = parseLimit(text, o)
          if (n === undefined || (n === null && o.nullable === false)) {
            setError(
              `${label}: enter a number${o.min !== undefined ? ` from ${o.min}` : ' above 0'}${o.max !== undefined ? ` to ${o.max}` : ''}${o.nullable === false ? '' : ', or leave it empty for no limit'}.`,
            )
            return false
          }
          return write(
            ptr,
            [{ op: 'replace', path: ptr, value: n }],
            n === null ? `${label}: no limit` : `${label}: ${n}`,
            n,
            user,
          )
        }}
      />
    </>
  )

  const f = s?.factory
  const sched = f?.schedule
  const days = sched?.days ?? []
  const where = folder !== null ? folderBaseName(folder) : null

  return (
    <div className="flex flex-col gap-6" data-testid="settings-factory" aria-busy={loading || undefined}>
      <p className="text-sm text-muted-foreground">
        The factory runs a folder&apos;s queued tasks one after another (Queue page), within these limits. A
        limit reached pauses the queue and says why; budgets are checked as each pass ends, with the costs the
        runs recorded.
      </p>
      {userView.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The settings could not be read: {userView.error}
        </p>
      )}
      <p id={errorId} role="alert" className="min-h-4 text-xs text-destructive" data-testid="factory-error">
        {error ?? ''}
      </p>
      <Group title="Queued tasks" description="How each queued task runs. Saved to your settings.">
        <SettingRow
          field="/factory/auto"
          label="Run queued tasks in Auto"
          description="Trust grants, blocking cards and the budgets still apply."
        >
          {toggle(
            '/factory/auto',
            'Run queued tasks in Auto',
            f?.auto,
            'Queued tasks run in Auto',
            'Queued tasks do not run in Auto',
          )}
        </SettingRow>
        <SettingRow
          field="/factory/skipBlocked"
          label="Skip blocked tasks"
          description="A task whose run needs you is left waiting and the queue goes on with the next. Off: the queue waits for you."
        >
          {toggle(
            '/factory/skipBlocked',
            'Skip blocked tasks',
            f?.skipBlocked,
            'The queue goes on past a task that needs you',
            'The queue waits for a task that needs you',
          )}
        </SettingRow>
        <SettingRow
          field="/factory/isolate"
          label="Run each task in an isolated copy"
          description="A folder's tasks can then run side by side; each task's changes stay on its copy's branch."
        >
          {toggle(
            '/factory/isolate',
            'Run each task in an isolated copy',
            f?.isolate,
            'Queued tasks run in isolated copies',
            'Queued tasks run in the folder',
          )}
        </SettingRow>
        <SettingRow field="/factory/maxParallel" label="Queued runs at once">
          {limitField('/factory/maxParallel', 'Queued runs at once', 'runs', f?.maxParallel, {
            int: true,
            min: 1,
            max: 8,
            nullable: false,
          })}
        </SettingRow>
      </Group>
      <Group
        title="Budgets and stop rules"
        description="Empty means no limit. A run that passes its limit is stopped, and the queue pauses with the reason."
      >
        <SettingRow field="/factory/maxCostPerRunUsd" label="Most cost per run">
          {limitField('/factory/maxCostPerRunUsd', 'Most cost per run', 'USD', f?.maxCostPerRunUsd, {
            max: 10_000,
          })}
        </SettingRow>
        <SettingRow
          field="/factory/maxCostPerDayUsd"
          label="Most cost per day"
          description="Every run of the day counts, queued or not."
        >
          {limitField('/factory/maxCostPerDayUsd', 'Most cost per day', 'USD', f?.maxCostPerDayUsd, {
            max: 100_000,
          })}
        </SettingRow>
        <SettingRow field="/factory/maxMinutesPerRun" label="Most time per run">
          {limitField('/factory/maxMinutesPerRun', 'Most time per run', 'min', f?.maxMinutesPerRun, {
            int: true,
            min: 1,
            max: 1440,
          })}
        </SettingRow>
        <SettingRow
          field="/factory/maxFixRounds"
          label="Most Fix rounds"
          description="Never more than a run's own settings allow (at most 3)."
        >
          {limitField('/factory/maxFixRounds', 'Most Fix rounds', 'rounds', f?.maxFixRounds, {
            int: true,
            min: 1,
            max: 3,
          })}
        </SettingRow>
        <SettingRow field="/factory/stopAfterFailures" label="Pause after failures in a row">
          {limitField(
            '/factory/stopAfterFailures',
            'Pause after failures in a row',
            'tasks',
            f?.stopAfterFailures,
            { int: true, min: 1, max: 100 },
          )}
        </SettingRow>
      </Group>
      <Group title="Schedule" description={SCHEDULE_OS_NOTE}>
        <SettingRow field="/factory/schedule/enabled" label="Run the queues on a schedule">
          {toggle(
            '/factory/schedule/enabled',
            'Run the queues on a schedule',
            sched?.enabled,
            'The queues run on the schedule',
            'No schedule',
          )}
        </SettingRow>
        <SettingRow field="/factory/schedule/start" label="Starts at" description="Local time, HH:MM.">
          <TextField
            value={sched?.start ?? null}
            label="Schedule starts at"
            testId="setting-/factory/schedule/start"
            width="w-20"
            disabled={busy === '/factory/schedule/start'}
            onCommit={(t) =>
              void write(
                '/factory/schedule/start',
                [{ op: 'replace', path: '/factory/schedule/start', value: t }],
                `The schedule starts at ${t}`,
                t,
                user,
              )
            }
          />
        </SettingRow>
        <SettingRow
          field="/factory/schedule/end"
          label="Ends at"
          description="Local time, HH:MM (before the start: the next day). Empty: runs until the queue is empty."
        >
          <TextField
            value={sched === undefined ? null : (sched.end ?? '')}
            label="Schedule ends at"
            testId="setting-/factory/schedule/end"
            width="w-20"
            disabled={busy === '/factory/schedule/end'}
            onCommit={(t) => {
              const v = t === '' ? null : t
              void write(
                '/factory/schedule/end',
                [{ op: 'replace', path: '/factory/schedule/end', value: v }],
                v === null ? 'The schedule has no end' : `The schedule ends at ${v}`,
                v,
                user,
              )
            }}
          />
        </SettingRow>
        <SettingRow field="/factory/schedule/days" label="Days">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Schedule days">
            {DAY_LABELS.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-xs">
                {/* Native boxes: seven of them render at once with the section (performance.spec.ts: a switch stays quick). */}
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  data-testid={`setting-schedule-day-${i}`}
                  aria-label={d}
                  checked={days.includes(i)}
                  disabled={
                    loading || busy === '/factory/schedule/days' || (days.includes(i) && days.length === 1)
                  }
                  onChange={(e) => {
                    const v = e.target.checked
                    const next = (v ? [...days, i] : days.filter((x) => x !== i)).sort((a, b) => a - b)
                    void write(
                      '/factory/schedule/days',
                      [{ op: 'replace', path: '/factory/schedule/days', value: next }],
                      'Schedule days changed',
                      next,
                      user,
                    )
                  }}
                />
                {d}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          field="/factory/schedule/resumeAutomatically"
          label="Resume automatically"
          description={RESUME_NOTE}
        >
          {toggle(
            '/factory/schedule/resumeAutomatically',
            'Resume automatically',
            sched?.resumeAutomatically,
            'A due schedule goes on by itself at launch',
            'A due schedule asks first at launch',
          )}
        </SettingRow>
        <SettingRow
          field="/factory/schedule/onBattery"
          label="Start on battery"
          description="Off: a scheduled start waits for power. A queue you start yourself always runs."
        >
          {toggle(
            '/factory/schedule/onBattery',
            'Start on battery',
            sched?.onBattery,
            'The schedule starts on battery too',
            'The schedule waits for power',
          )}
        </SettingRow>
      </Group>
      <Group
        title="Fallback on a rate limit"
        description="When a pass hits a rate limit or a used-up quota, move it to another ready vendor and retry it there, once per step, within the budgets. Every switch is noted on the run and in the daily report."
      >
        <SettingRow field="/fallback/enabled" label="Fall back to another vendor">
          {toggle(
            '/fallback/enabled',
            'Fall back to another vendor',
            s?.fallback.enabled,
            'Fallback on a rate limit is on',
            'Fallback on a rate limit is off',
          )}
        </SettingRow>
        <SettingRow
          field="/fallback/vendors"
          label="Vendors to try, in order"
          description="Vendor ids separated by commas (claude, codex, gemini, grok). Empty: Claude, then Codex, then the others."
        >
          <TextField
            value={s === null ? null : s.fallback.vendors.join(', ')}
            label="Fallback vendors"
            testId="setting-/fallback/vendors"
            placeholder="claude, codex"
            disabled={busy === '/fallback/vendors'}
            onCommit={(t) => {
              const list = t.split(/[\s,]+/).filter((x) => x !== '')
              void write(
                '/fallback/vendors',
                [{ op: 'replace', path: '/fallback/vendors', value: list }],
                'Fallback vendors changed',
                list,
                user,
              )
            }}
          />
        </SettingRow>
      </Group>
      <Group
        title="Model routing"
        description={`For the profile in use (${s?.profile ?? '…'}): a step that runs on another pass's vendor may run another model of it, a cheaper one for Research, say. Empty: the step runs the pass's model. Saved to your settings for this profile.`}
        testId="factory-routing"
      >
        {ROUTED_STEPS.map((step) => {
          const ptr = s !== null ? pointer('profiles', s.profile, 'routing', step, 'model') : ''
          const cur = s?.routing[step]?.model
          return (
            <SettingRow key={step} field={`/routing/${step}`} label={ROUTED_STEP_LABEL[step]}>
              <TextField
                value={s === null ? null : (cur ?? '')}
                label={`${ROUTED_STEP_LABEL[step]} model`}
                testId={`setting-routing-${step}`}
                placeholder="pass's model"
                disabled={busy === ptr}
                onCommit={(t) =>
                  void write(
                    ptr,
                    t === '' ? [{ op: 'remove', path: ptr }] : [{ op: 'replace', path: ptr, value: t }],
                    t === '' ? `${step} runs the pass's model` : `${step} runs ${t}`,
                    t === '' ? undefined : t,
                    user,
                  )
                }
              />
            </SettingRow>
          )
        })}
      </Group>
      <Group
        title="Project"
        description="Choose a project to set its memory and its quality gates. Without one, memory settings are saved to your settings, for every project."
      >
        <ProjectFolder folder={folder} onChange={setFolder} testId="factory-settings-folder" />
        <p role="status" data-testid="factory-scope" className="min-h-4 text-xs text-muted-foreground">
          {where !== null
            ? `Saved to ${where}'s dimfactory.json.`
            : 'Saved to your settings, for every project.'}
        </p>
      </Group>
      <Group
        title="Project memory"
        description="A DIM_FACTORY.md file at the project's root with its conventions, decisions and run notes, given to every pass. After each run an update is proposed for you to approve on the Queue page or at the run's end."
      >
        <SettingRow field="/memory/enabled" label="Give passes the project memory">
          {toggle(
            '/memory/enabled',
            'Give passes the project memory',
            mem?.memory.enabled,
            'Passes get the project memory',
            'Passes do not get the project memory',
            { target: memTarget, prov: folder !== null ? projProv : userProv },
          )}
        </SettingRow>
        <SettingRow field="/memory/propose" label="Propose an update after each run">
          {toggle(
            '/memory/propose',
            'Propose an update after each run',
            mem?.memory.propose,
            'An update is proposed after each run',
            'No update is proposed',
            { target: memTarget, prov: folder !== null ? projProv : userProv },
          )}
        </SettingRow>
        <SettingRow
          field="/memory/autoApply"
          label="Auto runs write it without asking"
          description="This project only. Every other run asks you first."
        >
          {toggle(
            '/memory/autoApply',
            'Auto runs write it without asking',
            p?.memory.autoApply,
            'Auto runs write the project memory',
            'Every update waits for you',
            { target: memTarget, disabled: folder === null, prov: projProv },
          )}
        </SettingRow>
      </Group>
      <Group
        title="Quality gates"
        description="The checks a run must pass to count as done. A run that misses one completes with failures, and a queue counts it as failed."
        testId="factory-quality"
      >
        {folder === null && (
          <p className="text-xs text-muted-foreground" data-testid="factory-quality-needs-project">
            {NEEDS_PROJECT}
          </p>
        )}
        <SettingRow field="/quality/enabled" label="Require quality gates">
          {toggle(
            '/quality/enabled',
            'Require quality gates',
            p?.quality.enabled,
            'Quality gates are required',
            'No quality gates',
            { target: memTarget, disabled: folder === null, prov: projProv },
          )}
        </SettingRow>
        <SettingRow
          field="/quality/verify"
          label="Verify commands that must pass"
          description="Tests, lint, a coverage command: add them under Isolation & Verify first."
        >
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Required verify commands"
            data-testid="factory-quality-verify"
          >
            {(p?.verifyNames ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {folder === null ? 'No project chosen.' : 'No verify commands.'}
              </span>
            ) : (
              (p?.verifyNames ?? []).map((name) => {
                const list = p?.quality.verify ?? []
                return (
                  <label key={name} className="flex items-center gap-1 text-xs">
                    <Checkbox
                      data-testid={`setting-quality-verify-${name}`}
                      aria-label={name}
                      checked={list.includes(name)}
                      disabled={folder === null || busy === '/quality/verify'}
                      onCheckedChange={(v) => {
                        const next = v === true ? [...list, name] : list.filter((x) => x !== name)
                        void write(
                          '/quality/verify',
                          [{ op: 'replace', path: '/quality/verify', value: next }],
                          'Required verify commands changed',
                          next,
                          memTarget,
                        )
                      }}
                    />
                    {name}
                  </label>
                )
              })
            )}
          </div>
        </SettingRow>
        <SettingRow field="/quality/security" label="Security review must pass">
          {toggle(
            '/quality/security',
            'Security review must pass',
            p?.quality.security,
            'The security review must pass',
            'The security review is not required',
            { target: memTarget, disabled: folder === null, prov: projProv },
          )}
        </SettingRow>
        <SettingRow field="/quality/acceptance" label="Every acceptance criterion must be met">
          {toggle(
            '/quality/acceptance',
            'Every acceptance criterion must be met',
            p?.quality.acceptance,
            'Every acceptance criterion must be met',
            'Acceptance criteria are not required',
            { target: memTarget, disabled: folder === null, prov: projProv },
          )}
        </SettingRow>
      </Group>
    </div>
  )
}
