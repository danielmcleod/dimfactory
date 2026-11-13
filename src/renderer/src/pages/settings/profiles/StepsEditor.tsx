// A profile's steps: the optional steps that ride on a pass (Clarify and its question count, Research and Explain on
// Plan, the acceptance review on Review, the Deploy step on Implement), Fix until green's rounds on Fix and the
// security advisor's re-check on Security. Each is one config.patch of `/profiles/<name>/<pass>/<key>` (the profile
// schema's own keys) in the profile's own file, with Undo (the caller writes). A built-in profile reads them as text.
// UI standards: every row is there from the start, one line high; a control that does not apply (the question count
// with Clarify off) stays in place, disabled, so nothing moves when a switch flips.
import type { ProfileConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { CLARIFY_MAX_QUESTIONS, FIX_ROUNDS_MAX } from '@shared/run.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { Switch } from '../../../components/ui/Switch.tsx'
import { PASS_BASE } from './builtins.ts'
import { profilePointer } from './model.ts'

/** What a profile runs of the optional steps, with the base values for what it leaves out. */
export interface ProfileSteps {
  clarify: boolean
  clarifyQuestions: number
  research: boolean
  acceptance: boolean
  explain: boolean
  rounds: number
  deploy: boolean
  securityRecheck: boolean
  /** The security advisor (the Security pass row's own switch): its re-check needs it. */
  security: boolean
}

export function profileSteps(def: ProfileConfig): ProfileSteps {
  const plan = { ...PASS_BASE.plan, ...(def.plan ?? {}) }
  const review = { ...PASS_BASE.review, ...(def.review ?? {}) }
  const implement = { ...PASS_BASE.implement, ...(def.implement ?? {}) }
  const fix = { ...PASS_BASE.fix, ...(def.fix ?? {}) }
  const security = { ...PASS_BASE.security, ...(def.security ?? {}) }
  return {
    clarify: plan.clarify === true,
    clarifyQuestions: plan.clarifyQuestions ?? 4,
    research: plan.research === true,
    acceptance: review.acceptance === true,
    explain: plan.explain === true,
    rounds: fix.rounds ?? 1,
    deploy: implement.deploy === true,
    securityRecheck: security.recheck !== false,
    security: security.enabled === true,
  }
}

export type StepKey = keyof Omit<ProfileSteps, 'security'>

/** Where each step's setting lives in a profile (the profile schema's keys). */
export const STEP_PATH: Readonly<Record<StepKey, readonly [string, string]>> = {
  clarify: ['plan', 'clarify'],
  clarifyQuestions: ['plan', 'clarifyQuestions'],
  research: ['plan', 'research'],
  acceptance: ['review', 'acceptance'],
  explain: ['plan', 'explain'],
  rounds: ['fix', 'rounds'],
  deploy: ['implement', 'deploy'],
  securityRecheck: ['security', 'recheck'],
}

export function stepOps(name: string, key: StepKey, value: boolean | number): JsonPatchOp[] {
  const [pass, field] = STEP_PATH[key]
  return [{ op: 'replace', path: profilePointer(name, pass, field), value }]
}

export const STEP_LABEL: Readonly<Record<StepKey, string>> = {
  clarify: 'Clarify before Plan',
  clarifyQuestions: 'Clarify questions',
  research: 'Research before Plan',
  acceptance: 'Acceptance review',
  explain: 'Explain it to me',
  rounds: 'Fix until green',
  deploy: 'Deploy step',
  securityRecheck: 'Security re-check',
}

const STEP_HELP: Readonly<Record<StepKey, string>> = {
  clarify: 'Plan may ask a few multiple-choice questions first.',
  clarifyQuestions: 'The most questions Clarify may ask.',
  research: 'A read-only study of the problem before Plan.',
  acceptance: "Checks each of the plan's acceptance criteria after Review.",
  explain: 'A plain-language summary of what was built, at the end.',
  rounds: 'Fix, verify and re-check again until green, up to this many rounds.',
  deploy: 'Writes the deploy config the target needs (never deploys).',
  securityRecheck: 'After Fix, confirms each security finding is resolved (with the security advisor on).',
}

export const roundsText = (n: number): string => (n <= 1 ? 'Single Fix' : `Up to ${n} rounds`)
const questionsText = (n: number): string => `${n} ${n === 1 ? 'question' : 'questions'}`

const ORDER: readonly StepKey[] = [
  'clarify',
  'clarifyQuestions',
  'research',
  'explain',
  'acceptance',
  'rounds',
  'deploy',
  'securityRecheck',
]

export interface StepsEditorProps {
  name: string
  definition: ProfileConfig
  editable: boolean
  /** The control being written (`steps/<key>`), shown busy. */
  writing: string | null
  onWrite: (ops: JsonPatchOp[], message: string, key: string) => void
}

function valueText(key: StepKey, s: ProfileSteps): string {
  if (key === 'clarifyQuestions') return questionsText(s.clarifyQuestions)
  if (key === 'rounds') return roundsText(s.rounds)
  return s[key] ? 'On' : 'Off'
}

export function StepsEditor({
  name,
  definition,
  editable,
  writing,
  onWrite,
}: StepsEditorProps): React.JSX.Element {
  const s = profileSteps(definition)
  const busy = (key: StepKey): boolean => writing === `steps/${key}`
  const write = (key: StepKey, value: boolean | number, words: string): void =>
    onWrite(stepOps(name, key, value), `${name}: ${words}`, `steps/${key}`)

  const control = (key: StepKey): React.ReactNode => {
    if (!editable)
      return (
        <span data-testid={`profile-step-${key}`} className="text-sm">
          {valueText(key, s)}
        </span>
      )
    if (key === 'clarifyQuestions')
      return (
        <Select
          value={String(s.clarifyQuestions)}
          // Always there; it applies once Clarify is on.
          disabled={busy(key) || !s.clarify}
          onValueChange={(v) => write(key, Number(v), `Clarify asks at most ${questionsText(Number(v))}`)}
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            data-testid={`profile-step-${key}`}
            aria-label={STEP_LABEL[key]}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: CLARIFY_MAX_QUESTIONS }, (_, i) => i + 1).map((n) => (
              <SelectItem key={n} value={String(n)}>
                {questionsText(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    if (key === 'rounds')
      return (
        <Select
          value={String(s.rounds)}
          disabled={busy(key)}
          onValueChange={(v) => write(key, Number(v), `Fix runs ${roundsText(Number(v)).toLowerCase()}`)}
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            data-testid={`profile-step-${key}`}
            aria-label={STEP_LABEL[key]}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: FIX_ROUNDS_MAX }, (_, i) => i + 1).map((n) => (
              <SelectItem key={n} value={String(n)}>
                {roundsText(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    const on = s[key]
    return (
      <Switch
        data-testid={`profile-step-${key}`}
        aria-label={STEP_LABEL[key]}
        checked={on}
        disabled={busy(key)}
        onCheckedChange={(v) => write(key, v, `${STEP_LABEL[key]} ${v ? 'on' : 'off'}`)}
      />
    )
  }

  return (
    <ul aria-label="Steps" data-testid="profile-steps" className="flex flex-col">
      {ORDER.map((key) => (
        <li
          key={key}
          data-testid={`profile-step-row-${key}`}
          className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-b py-1.5 last:border-b-0"
        >
          <span className="w-44 shrink-0 text-sm font-medium">{STEP_LABEL[key]}</span>
          <span className="flex w-36 shrink-0 items-center">{control(key)}</span>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{STEP_HELP[key]}</span>
        </li>
      ))}
    </ul>
  )
}
