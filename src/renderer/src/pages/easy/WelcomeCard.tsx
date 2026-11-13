// The first-launch question, asked once of a new user in the composer's place: "How would you like to use Dim Factory?"
// with two equal choices, Make something for me (Easy) and Full control. Existing users never see it (core decides:
// EasyState.askWelcome). Choosing writes `ui.experience`; Full shows the composer where the card was.
import { SlidersHorizontal, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import type { Experience } from '@shared/config-schema.ts'
import { Button } from '../../components/ui/Button.tsx'
import { navigate } from '../../lib/router.ts'
import { chooseExperience } from '../../state/experience.ts'
import {
  WELCOME_EASY,
  WELCOME_EASY_NOTE,
  WELCOME_FULL,
  WELCOME_FULL_NOTE,
  WELCOME_SWITCH_NOTE,
  WELCOME_TITLE,
} from './text.ts'

const CHOICES = [WELCOME_EASY, WELCOME_FULL] as const

export function WelcomeCard(): React.JSX.Element {
  const [busy, setBusy] = useState<Experience | null>(null)
  const pick = (e: Experience): void => {
    if (busy !== null) return
    setBusy(e)
    void chooseExperience(e).then((ok) => {
      setBusy(null)
      if (ok && e === 'easy') navigate({ name: 'easy' })
    })
  }
  return (
    <section
      aria-labelledby="welcome-heading"
      data-testid="welcome-card"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-6 pb-2"
    >
      <h2 id="welcome-heading" className="text-xl font-semibold">
        {WELCOME_TITLE}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex h-40 flex-col justify-between gap-3 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">{WELCOME_EASY_NOTE}</p>
          <Button
            labels={CHOICES}
            icon={<WandSparkles aria-hidden />}
            loading={busy === 'easy'}
            disabled={busy !== null}
            data-testid="welcome-easy"
            onClick={() => pick('easy')}
            className="w-full"
          >
            {WELCOME_EASY}
          </Button>
        </div>
        <div className="flex h-40 flex-col justify-between gap-3 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">{WELCOME_FULL_NOTE}</p>
          <Button
            variant="outline"
            labels={CHOICES}
            icon={<SlidersHorizontal aria-hidden />}
            loading={busy === 'full'}
            disabled={busy !== null}
            data-testid="welcome-full"
            onClick={() => pick('full')}
            className="w-full"
          >
            {WELCOME_FULL}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{WELCOME_SWITCH_NOTE}</p>
    </section>
  )
}
