// Settings → Isolation & Verify: Clarify before Plan (`passes.plan.clarify`, `clarifyQuestions`, `clarifyInAuto`),
// Research before Plan (`passes.plan.research`, `researchLenses`: the generic lenses, from brief.detect),
// Fix until green (`passes.fix.rounds`, `recheck`, `maxCostUsd`, `maxMinutes`), the acceptance review
// (`passes.review.acceptance`) and Explain it to me (`passes.plan.explain`). The values are core's resolved ones
// (config.resolve), a value just written shows at once until core's next answer, and each control writes one
// config.patch with Undo through the section's `write`. A number the schema would refuse is refused here with the
// reason under its label, before anything is written.
import { useId, useState } from 'react'
import type { ProvenanceMap, ResolvedConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import { CLARIFY_MAX_QUESTIONS, FIX_ROUNDS_MAX } from '@shared/run.ts'
import type { GenericLenses } from '@shared/research.ts'
import { Button } from '../../../components/ui/Button.tsx'
import { Checkbox } from '../../../components/ui/Checkbox.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { cn } from '../../../lib/cn.ts'
import { GeneralRow, NumberField } from '../general/controls.tsx'
import { SourceBadge } from '../general/SourceBadge.tsx'
import { Group, SettingRow } from '../kit.tsx'

export const CLARIFY_LABEL = 'Clarify before Plan'
export const CLARIFY_QUESTIONS_LABEL = 'Most questions'
export const CLARIFY_IN_AUTO_LABEL = 'Ask in Auto'
export const RESEARCH_LABEL = 'Research before Plan'
export const RESEARCH_LENSES_LABEL = 'Lenses'
export const RESEARCH_DEFAULTS_LABEL = 'Use defaults'
export const FIX_ROUNDS_LABEL = 'Fix rounds'
export const FIX_RECHECK_LABEL = 'Re-check each round'
export const FIX_MAX_COST_LABEL = 'Max cost per run (USD)'
export const FIX_MAX_MINUTES_LABEL = 'Max working time per run (minutes)'
export const ACCEPTANCE_LABEL = 'Acceptance review'
export const EXPLAIN_LABEL = 'Explain it to me'

/** The rounds choice's words: 1 is a single Fix, more is Fix until green. */
export function roundsChoiceLabel(n: number): string {
  return n === 1 ? 'Single Fix' : `Up to ${n} rounds`
}

export interface RunLoopSettings {
  clarify: boolean
  clarifyQuestions: number
  clarifyInAuto: boolean
  research: boolean
  /** Empty: the defaults (the pack's, else the generic ones). */
  researchLenses: string[]
  rounds: number
  recheck: boolean
  maxCostUsd: number | null
  maxMinutes: number | null
  acceptance: boolean
  explain: boolean
}

/**
 * Clarify's and Fix until green's settings as core resolved them (an older core or a test double may leave the keys
 * out: their defaults), with the values just written shown at once; null while they load.
 */
export function runLoopOf(
  view: ResolvedWithProvenance | null,
  pending: Readonly<Record<string, unknown>>,
): RunLoopSettings | null {
  if (view === null) return null
  const passes = (view.config as Partial<ResolvedConfig>).passes as
    Partial<Record<string, Record<string, unknown>>> | undefined
  const plan = passes?.['plan'] ?? {}
  const fix = passes?.['fix'] ?? {}
  const review = passes?.['review'] ?? {}
  const pick = <T,>(key: string, cur: unknown, fallback: T, ok: (v: unknown) => boolean): T => {
    if (key in pending && ok(pending[key])) return pending[key] as T
    return ok(cur) ? (cur as T) : fallback
  }
  const bool = (v: unknown): boolean => typeof v === 'boolean'
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  const numOrNull = (v: unknown): boolean => v === null || num(v)
  return {
    clarify: pick('/passes/plan/clarify', plan['clarify'], false, bool),
    clarifyQuestions: pick('/passes/plan/clarifyQuestions', plan['clarifyQuestions'], 4, num),
    clarifyInAuto: pick('/passes/plan/clarifyInAuto', plan['clarifyInAuto'], false, bool),
    research: pick('/passes/plan/research', plan['research'], false, bool),
    researchLenses: pick<string[]>(
      '/passes/plan/researchLenses',
      plan['researchLenses'],
      [],
      (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    ),
    rounds: pick('/passes/fix/rounds', fix['rounds'], 1, num),
    recheck: pick('/passes/fix/recheck', fix['recheck'], true, bool),
    maxCostUsd: pick('/passes/fix/maxCostUsd', fix['maxCostUsd'], null, numOrNull),
    maxMinutes: pick('/passes/fix/maxMinutes', fix['maxMinutes'], null, numOrNull),
    acceptance: pick('/passes/review/acceptance', review['acceptance'], false, bool),
    explain: pick('/passes/plan/explain', plan['explain'], false, bool),
  }
}

/** A whole number from min to max, or the reason it is refused. */
export function parseWhole(text: string, min: number, max: number): number | string {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return `Type a whole number from ${min} to ${max}.`
  const n = Number(t)
  if (n < min || n > max) return `Type a whole number from ${min} to ${max}.`
  return n
}

/** An optional limit: empty is no limit (null), else a number above 0 up to max, or the reason it is refused. */
export function parseLimit(text: string, max: number, whole: boolean): number | null | string {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  const words = whole
    ? `Type a whole number from 1 to ${max}, or leave it empty for no limit.`
    : `Type an amount above 0 up to ${max}, or leave it empty for no limit.`
  if (!Number.isFinite(n) || n <= 0 || n > max) return words
  if (whole && !Number.isInteger(n)) return words
  return n
}

type Write = (key: string, ops: JsonPatchOp[], message: string, shown?: unknown) => Promise<boolean>

export function RunLoopGroups({
  settings,
  provenance,
  busy,
  loading,
  write,
  lenses = null,
}: {
  settings: RunLoopSettings | null
  provenance: ProvenanceMap | undefined
  busy: string | null
  loading: boolean
  write: Write
  /** Research's generic lenses (brief.detect); null while they load or when core cannot say. */
  lenses?: GenericLenses | null
}): React.JSX.Element {
  const errorBase = useId()
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const setError = (ptr: string, e: string | null): void =>
    setErrors((cur) => {
      if (e === null) {
        if (!(ptr in cur)) return cur
        const { [ptr]: _gone, ...rest } = cur
        return rest
      }
      return { ...cur, [ptr]: e }
    })
  const s = settings
  const off = s === null

  const toggle = (ptr: string, label: string, on: string, offText: string) => (
    <>
      <SourceBadge provenance={provenance?.[ptr]} loading={loading} testId={`setting-source-${ptr}`} />
      <Switch
        data-testid={`setting-${ptr}`}
        aria-label={label}
        checked={s !== null && (s[leaf(ptr)] as boolean)}
        disabled={off || busy === ptr}
        onCheckedChange={(v) =>
          void write(ptr, [{ op: 'replace', path: ptr, value: v }], v ? on : offText, v)
        }
      />
    </>
  )

  const commitNumber = async (
    ptr: string,
    parsed: number | null | string,
    message: (v: number | null) => string,
  ): Promise<boolean> => {
    if (typeof parsed === 'string') {
      setError(ptr, parsed)
      return false
    }
    setError(ptr, null)
    return write(ptr, [{ op: 'replace', path: ptr, value: parsed }], message(parsed), parsed)
  }

  const number = (
    ptr: string,
    label: string,
    suffix: string,
    value: string | null,
    parse: (text: string) => number | null | string,
    message: (v: number | null) => string,
  ) => (
    <>
      <NumberField
        testId={`setting-${ptr}`}
        label={label}
        suffix={suffix}
        value={value}
        disabled={busy === ptr}
        invalid={errors[ptr] !== undefined}
        errorId={`${errorBase}-${leaf(ptr)}`}
        onEdit={() => setError(ptr, null)}
        onCommit={(text) => commitNumber(ptr, parse(text), message)}
      />
      <SourceBadge provenance={provenance?.[ptr]} loading={loading} testId={`setting-source-${ptr}`} />
    </>
  )

  const rounds = s?.rounds ?? 1
  return (
    <>
      <Group
        title="Clarify before Plan"
        description="Before Plan, the Plan model may ask you a few multiple-choice questions about the task. Your answers join the brief that Plan, Implement and the reviewers read; any question can be left to Plan. It is off unless you turn it on here, in the thorough profile, or for one run in the composer."
      >
        <div>
          <SettingRow
            label={CLARIFY_LABEL}
            description="Asks before Plan on every run. It adds one short read-only pass."
            field="/passes/plan/clarify"
          >
            {toggle(
              '/passes/plan/clarify',
              CLARIFY_LABEL,
              'Clarify before Plan is on',
              'Clarify before Plan is off',
            )}
          </SettingRow>
          <GeneralRow
            field="/passes/plan/clarifyQuestions"
            label={CLARIFY_QUESTIONS_LABEL}
            description={`How many questions Clarify may ask, 1 to ${CLARIFY_MAX_QUESTIONS}.`}
            error={errors['/passes/plan/clarifyQuestions'] ?? null}
            errorId={`${errorBase}-clarifyQuestions`}
          >
            {number(
              '/passes/plan/clarifyQuestions',
              CLARIFY_QUESTIONS_LABEL,
              'max',
              s !== null ? String(s.clarifyQuestions) : null,
              (t) => parseWhole(t, 1, CLARIFY_MAX_QUESTIONS),
              (v) => `Clarify asks at most ${v ?? ''} ${v === 1 ? 'question' : 'questions'}`,
            )}
          </GeneralRow>
          <SettingRow
            label={CLARIFY_IN_AUTO_LABEL}
            description="Off: Auto skips Clarify. On: in Auto its questions still wait for you."
            field="/passes/plan/clarifyInAuto"
          >
            {toggle(
              '/passes/plan/clarifyInAuto',
              CLARIFY_IN_AUTO_LABEL,
              'Clarify asks in Auto too',
              'Auto skips Clarify',
            )}
          </SettingRow>
        </div>
      </Group>

      <Group
        title="Research before Plan"
        description="Before Plan, a confined read-only pass studies the problem space through the lenses you pick, on the web where the Plan vendor can search it (Claude, Codex) and in this repository. You review what it found and tick what Plan uses; Auto keeps the must-haves and recommendations. Web research is token-heavy. It is off unless you turn it on here, in the thorough profile, or for one run in the composer."
      >
        <div>
          <SettingRow
            label={RESEARCH_LABEL}
            description="Researches before Plan on every run, with a review card before Plan starts."
            field="/passes/plan/research"
          >
            {toggle(
              '/passes/plan/research',
              RESEARCH_LABEL,
              'Research before Plan is on',
              'Research before Plan is off',
            )}
          </SettingRow>
          {lenses !== null && (
            <SettingRow
              label={RESEARCH_LENSES_LABEL}
              description="The lenses a run researches. None chosen: the brief category's defaults, else the ticked defaults here. Category lenses (SEO, app store guidelines and so on) are picked in the composer."
              field="/passes/plan/researchLenses"
            >
              <SourceBadge
                provenance={provenance?.['/passes/plan/researchLenses']}
                loading={loading}
                testId="setting-source-/passes/plan/researchLenses"
              />
              <LensPicker
                lenses={lenses}
                chosen={s?.researchLenses ?? []}
                disabled={off || busy === '/passes/plan/researchLenses'}
                onChange={(ids) =>
                  void write(
                    '/passes/plan/researchLenses',
                    [{ op: 'replace', path: '/passes/plan/researchLenses', value: ids }],
                    ids.length === 0
                      ? 'Research uses the default lenses'
                      : `Research uses ${ids.length} ${ids.length === 1 ? 'lens' : 'lenses'}`,
                    ids,
                  )
                }
              />
            </SettingRow>
          )}
        </div>
      </Group>

      <Group
        title="Fix until green"
        description="After Fix, verify runs again and the open must findings are re-checked; while something still fails, Fix takes another round. It stops when the run is green, at the round cap, at a budget, or when a round makes no progress."
      >
        <div>
          <SettingRow
            label={FIX_ROUNDS_LABEL}
            description="A single Fix, or Fix until green for up to this many rounds."
            field="/passes/fix/rounds"
          >
            <SourceBadge
              provenance={provenance?.['/passes/fix/rounds']}
              loading={loading}
              testId="setting-source-/passes/fix/rounds"
            />
            <fieldset
              className="flex items-center gap-3"
              data-testid="setting-/passes/fix/rounds"
              disabled={off || busy === '/passes/fix/rounds'}
            >
              <legend className="sr-only">{FIX_ROUNDS_LABEL}</legend>
              {Array.from({ length: FIX_ROUNDS_MAX }, (_, i) => i + 1).map((n) => (
                <label
                  key={n}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 text-xs',
                    off && 'opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name={`${errorBase}-rounds`}
                    data-testid={`setting-fix-rounds-${n}`}
                    className="size-3.5 accent-primary"
                    checked={s !== null && rounds === n}
                    onChange={() =>
                      void write(
                        '/passes/fix/rounds',
                        [{ op: 'replace', path: '/passes/fix/rounds', value: n }],
                        n === 1 ? 'Fix runs once' : `Fix until green, up to ${n} rounds`,
                        n,
                      )
                    }
                  />
                  {roundsChoiceLabel(n)}
                </label>
              ))}
            </fieldset>
          </SettingRow>
          <SettingRow
            label={FIX_RECHECK_LABEL}
            description="After each round, a short read-only pass confirms which must findings the round resolved."
            field="/passes/fix/recheck"
          >
            {toggle(
              '/passes/fix/recheck',
              FIX_RECHECK_LABEL,
              'Each Fix round is re-checked',
              'Fix rounds are not re-checked',
            )}
          </SettingRow>
          <GeneralRow
            field="/passes/fix/maxCostUsd"
            label={FIX_MAX_COST_LABEL}
            description="Optional. No new round starts past this cost. Empty: no limit."
            error={errors['/passes/fix/maxCostUsd'] ?? null}
            errorId={`${errorBase}-maxCostUsd`}
          >
            {number(
              '/passes/fix/maxCostUsd',
              FIX_MAX_COST_LABEL,
              'USD',
              s !== null ? (s.maxCostUsd !== null ? String(s.maxCostUsd) : '') : null,
              (t) => parseLimit(t, 10_000, false),
              (v) => (v === null ? 'Fix until green has no cost limit' : `Fix until green stops at $${v}`),
            )}
          </GeneralRow>
          <GeneralRow
            field="/passes/fix/maxMinutes"
            label={FIX_MAX_MINUTES_LABEL}
            description="Optional. Time spent waiting for you does not count. Empty: no limit."
            error={errors['/passes/fix/maxMinutes'] ?? null}
            errorId={`${errorBase}-maxMinutes`}
          >
            {number(
              '/passes/fix/maxMinutes',
              FIX_MAX_MINUTES_LABEL,
              'min',
              s !== null ? (s.maxMinutes !== null ? String(s.maxMinutes) : '') : null,
              (t) => parseLimit(t, 1_440, true),
              (v) =>
                v === null ? 'Fix until green has no time limit' : `Fix until green stops after ${v} min`,
            )}
          </GeneralRow>
        </div>
      </Group>

      <Group
        title="Checking and explaining the result"
        description="Two optional read-only passes. The acceptance review checks the plan's acceptance criteria against the change after Implement's checks; with Fix until green, an unmet criterion becomes a must finding for Fix, otherwise it is a summary only. Explain it to me writes a plain-language summary at the end of the run: what was built, how to run it, what to try next and known limits."
      >
        <div>
          <SettingRow
            label={ACCEPTANCE_LABEL}
            description="Runs on the Review pass's model (Critic's, then Plan's, when Review is off). Each criterion reads Met, Not met or Unknown with evidence."
            field="/passes/review/acceptance"
          >
            {toggle(
              '/passes/review/acceptance',
              ACCEPTANCE_LABEL,
              'The acceptance review is on',
              'The acceptance review is off',
            )}
          </SettingRow>
          <SettingRow
            label={EXPLAIN_LABEL}
            description="Runs on the Plan pass's model (Review's when Plan is off) once the outcome is decided. The summary appears at the end of the run and in explain.md."
            field="/passes/plan/explain"
          >
            {toggle(
              '/passes/plan/explain',
              EXPLAIN_LABEL,
              'Explain it to me is on',
              'Explain it to me is off',
            )}
          </SettingRow>
        </div>
      </Group>
    </>
  )
}

/**
 * The generic lenses as checkboxes: the chosen ids ticked, or the defaults (muted) when none is chosen; ticking writes
 * the whole list, and "Use defaults" (constant label) writes an empty one. Ids of category lenses stay in the list.
 */
function LensPicker({
  lenses,
  chosen,
  disabled,
  onChange,
}: {
  lenses: GenericLenses
  chosen: readonly string[]
  disabled: boolean
  onChange: (ids: string[]) => void
}): React.JSX.Element {
  const defaults = chosen.length === 0
  const shown = defaults ? lenses.defaults : chosen
  const set = (id: string, on: boolean): void => {
    const next = new Set(shown)
    if (on) next.add(id)
    else next.delete(id)
    const generic = lenses.lenses.map((l) => l.id)
    // Generic lenses in their order, then any category lens ids the list already had.
    onChange([...generic.filter((x) => next.has(x)), ...[...next].filter((x) => !generic.includes(x))])
  }
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="setting-/passes/plan/researchLenses">
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
        {lenses.lenses.map((l) => (
          <label
            key={l.id}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 text-xs',
              defaults && 'text-muted-foreground',
            )}
          >
            <Checkbox
              data-testid={`setting-research-lens-${l.id}`}
              aria-label={l.label}
              checked={shown.includes(l.id)}
              disabled={disabled}
              onCheckedChange={(v) => set(l.id, v === true)}
            />
            {l.label}
          </label>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        data-testid="setting-research-lens-defaults"
        disabled={disabled || defaults}
        onClick={() => onChange([])}
      >
        {RESEARCH_DEFAULTS_LABEL}
      </Button>
    </div>
  )
}

/** The setting's key in RunLoopSettings from its pointer's last segment. */
function leaf(ptr: string): keyof RunLoopSettings {
  return ptr.slice(ptr.lastIndexOf('/') + 1) as keyof RunLoopSettings
}
