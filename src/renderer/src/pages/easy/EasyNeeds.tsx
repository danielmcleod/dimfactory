// The confirm screen's rows for a website or app: "How it is built" (React by default, Plain HTML as an option; without
// Node.js, or with one too old, plain HTML with why and how to install Node.js, and Check again), "What it needs" (one
// plain question about the first thing the idea needs beyond pages in a browser, what each answer adds, costs and
// which free hosts cover it; the other needs decided the recommended way, each changeable) and "What will work".
// Core decides what is offered (easy.resolve); these rows only show it and send the user's choices back.
// UI standards: choice buttons keep their labels (the pressed one is marked, never relabelled), Check again keeps its
// label while it checks, and the explanation under a question keeps its three lines.
import { RefreshCw } from 'lucide-react'
import { useId } from 'react'
import { EASY_STACKS } from '@shared/easy.ts'
import type { EasyNeed, EasyNeedAnswers, EasyNeedView, EasyResolved, EasyStack } from '@shared/easy.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/Select.tsx'
import { Row } from './EasyRow.tsx'
import {
  CHECK_AGAIN,
  NEED_ALSO,
  NEED_CHOICE_TEXT,
  NEED_NAME,
  NEEDS_LABEL,
  NO_NEEDS_TEXT,
  NODE_INSTALL_TITLE,
  STACK_LABEL,
  STACK_NOTE,
  STACK_TEXT,
  WORKS_LABEL,
  needQuestion,
  noReactText,
  nodeInstallSteps,
  worksText,
} from './text.ts'

/** The way chosen for a need: the user's, else the recommended one. */
export function chosenWay(view: EasyNeedView, answers: EasyNeedAnswers): string {
  const a = answers[view.need]
  return a !== undefined && view.choices.includes(a) ? a : view.recommended
}

/** "How it is built": React or Plain HTML, or why it is plain HTML and how to install Node.js. */
export function StackRow({
  resolved,
  platform,
  checking,
  onPick,
  onCheckAgain,
}: {
  resolved: EasyResolved
  platform: string
  /** Check again is reading Node.js's version. */
  checking: boolean
  onPick: (s: EasyStack) => void
  onCheckAgain: () => void
}): React.JSX.Element | null {
  const groupId = useId()
  const stack = resolved.stack
  if (stack === undefined) return null
  return (
    <Row label={STACK_LABEL} testId="easy-confirm-stack">
      {stack.react ? (
        <>
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-labelledby={groupId}
            data-testid="easy-stack-choices"
          >
            <span id={groupId} className="sr-only">
              {STACK_LABEL}
            </span>
            {EASY_STACKS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={stack.chosen === s ? 'default' : 'outline'}
                aria-pressed={stack.chosen === s}
                data-testid={`easy-stack-${s}`}
                onClick={() => onPick(s)}
              >
                {STACK_TEXT[s]}
              </Button>
            ))}
          </div>
          <p className="min-h-10 text-sm text-muted-foreground" data-testid="easy-stack-note">
            {STACK_NOTE[stack.chosen]}
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-2" data-testid="easy-stack-no-node">
          <p className="text-sm font-medium">{STACK_TEXT.html}</p>
          <p className="text-sm" role="note" data-testid="easy-stack-why">
            {noReactText(resolved.toolchain.nodeVersion, resolved.toolchain.nodeOld === true)}
          </p>
          <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3">
            <h3 className="text-sm font-semibold">{NODE_INSTALL_TITLE}</h3>
            <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-sm" data-testid="easy-node-steps">
              {nodeInstallSteps(platform).map((s) => (
                <li key={s} className="break-words">
                  {s}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <Button
              size="sm"
              variant="outline"
              icon={<RefreshCw aria-hidden />}
              loading={checking}
              data-testid="easy-node-check-again"
              onClick={onCheckAgain}
            >
              {CHECK_AGAIN}
            </Button>
          </div>
        </div>
      )}
    </Row>
  )
}

/** One way to meet a need, explained: what it adds, what it costs, and which free hosts cover it. */
function WayExplained({ need, choice }: { need: EasyNeed; choice: string }): React.JSX.Element {
  const t = NEED_CHOICE_TEXT[need][choice]
  return (
    <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground" data-testid="easy-need-explain">
      <li>{t?.adds ?? ''}</li>
      <li data-testid="easy-need-cost">{t?.cost ?? ''}</li>
      <li data-testid="easy-need-hosts">{t?.hosts ?? ''}</li>
    </ul>
  )
}

/** "What it needs" (the one question, then the other needs decided for the user) and "What will work". */
export function NeedsRows({
  needs,
  answers,
  onAnswer,
}: {
  needs: readonly EasyNeedView[]
  answers: EasyNeedAnswers
  onAnswer: (need: EasyNeed, choice: string) => void
}): React.JSX.Element {
  const questionId = useId()
  const first = needs[0]
  const rest = needs.slice(1)
  return (
    <>
      {first !== undefined && (
        <Row label={NEEDS_LABEL} testId="easy-confirm-needs">
          <section aria-labelledby={questionId} className="flex flex-col gap-2" data-need={first.need}>
            <h3 id={questionId} className="text-sm font-semibold" data-testid="easy-need-question">
              {needQuestion(first.need, first.signup === true)}
            </h3>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={questionId}>
              {first.choices.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={chosenWay(first, answers) === c ? 'default' : 'outline'}
                  aria-pressed={chosenWay(first, answers) === c}
                  data-testid={`easy-need-${first.need}-${c}`}
                  onClick={() => onAnswer(first.need, c)}
                >
                  {NEED_CHOICE_TEXT[first.need][c]?.label ?? c}
                </Button>
              ))}
            </div>
            <WayExplained need={first.need} choice={chosenWay(first, answers)} />
          </section>
          {rest.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-2" data-testid="easy-need-also">
              <p className="text-sm">{NEED_ALSO}</p>
              {rest.map((v) => (
                <div key={v.need} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 shrink-0 text-sm">{NEED_NAME[v.need]}</span>
                  <div className="w-full max-w-sm">
                    <Select value={chosenWay(v, answers)} onValueChange={(c) => onAnswer(v.need, c)}>
                      <SelectTrigger
                        aria-label={NEED_NAME[v.need]}
                        data-testid={`easy-need-select-${v.need}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {v.choices.map((c) => (
                          <SelectItem key={c} value={c} data-testid={`easy-need-${v.need}-option-${c}`}>
                            {NEED_CHOICE_TEXT[v.need][c]?.label ?? c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Row>
      )}
      <Row label={WORKS_LABEL} testId="easy-confirm-works">
        {needs.length === 0 ? (
          <p className="text-sm">{NO_NEEDS_TEXT}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="easy-works-lines">
            {needs.map((v) => (
              <li key={v.need}>{worksText(v.need, chosenWay(v, answers), v.signup === true)}</li>
            ))}
          </ul>
        )}
      </Row>
    </>
  )
}
