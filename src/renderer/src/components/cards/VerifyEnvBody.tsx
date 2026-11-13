// verifyEnv card ([Retry] [Skip verify]; environment failures are never findings: exit 127/9009, ENOENT,
// 'not recognized', or a missing module; failure category deps_missing).
// A verify command the environment could not run (a missing program or module) is not a problem with the change, so
// it opens this card instead of becoming a finding. Core's lead, then each command with what went wrong (core's reason,
// else its exit code) and its output excerpt (an inner region with a fixed maximum height, like a snag's raw error),
// any recovery core offers (a command to copy), core's closing words and its choices. Auto takes core's default.
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { RecoveryActions } from '../recovery/RecoveryActions.tsx'
import { REGION } from '../run/follow.tsx'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { VERIFY_REGION_MAX } from '../run/VerifyOutput.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { paragraphs, VERIFY_ENV_CHOICE, verifyEnvOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'

/** What went wrong with one command: core's reason, else its exit code. */
export function envWhy(c: { reason: string | null; exitCode: number | null }): string {
  if (c.reason !== null) return c.reason
  return c.exitCode !== null ? `It exited with code ${c.exitCode}.` : 'It did not start.'
}

export function VerifyEnvBody({
  runId,
  card,
  resolver,
}: {
  runId: string
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const v = verifyEnvOf(card)
  const paras = paragraphs(card.body)
  const structured = v.commands.length > 0
  // With the commands shown from the payload, core's list of them in the body is not repeated.
  const lead = structured ? ((paras[0] ?? '').split('\n')[0]?.trim() ?? '') : card.body
  const closing = structured && paras.length > 1 ? (paras.at(-1) ?? '') : ''
  const canRetry = card.choices.some((c) => c.id === VERIFY_ENV_CHOICE.retry)
  return (
    <div className="flex flex-col gap-3">
      {lead !== '' && <LightMarkdown text={lead} className="text-sm" />}
      {structured && (
        <ul className="flex flex-col gap-2" data-testid="verify-env-commands">
          {v.commands.map((c, i) => (
            <li
              key={`${i}:${c.name}`}
              className="flex min-w-0 flex-col gap-1"
              data-testid={`verify-env-${i}`}
            >
              <p className="text-sm">
                <span className="font-medium">{c.name}</span>
                {c.exitCode !== null && (
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">exit {c.exitCode}</span>
                )}
              </p>
              <code className="font-mono text-xs break-all text-muted-foreground">{c.command}</code>
              <p className="text-sm text-warning" data-testid={`verify-env-${i}-why`}>
                {envWhy(c)}
              </p>
              {c.excerpt !== null && (
                <pre
                  tabIndex={0}
                  aria-label={`Output of ${c.name}`}
                  data-testid={`verify-env-${i}-excerpt`}
                  data-scroll-region="verify-output"
                  className={cn(
                    'stream-text rounded-md border bg-muted/40 px-2 py-1 text-xs break-words whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    REGION,
                    VERIFY_REGION_MAX,
                  )}
                >
                  {c.excerpt}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {v.failure !== null && structured && (
        <p className="text-sm text-warning" data-testid="verify-env-failure">
          {v.failure}
        </p>
      )}
      {v.actions.length > 0 && (
        <RecoveryActions
          actions={v.actions}
          runId={runId}
          {...(canRetry ? { onRecheck: () => resolver.resolve(VERIFY_ENV_CHOICE.retry) } : {})}
        />
      )}
      {closing !== '' && <p className="text-sm text-muted-foreground">{closing}</p>}
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => (
          <ChoiceButton
            key={c.id}
            card={card}
            choice={c}
            busy={resolver.busy}
            onChoose={() => resolver.resolve(c.id)}
          />
        ))}
      </ChoiceRow>
    </div>
  )
}
