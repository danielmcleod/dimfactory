// The Easy | Full switch at the foot of the sidebar (and the palette's "Switch to ..." actions, through
// switchExperience). Switching never stops or restarts a run and never loses work: a run's view follows to the other
// mode's view of the same run, and an idea typed in Easy goes into the Full composer's task box with its recipe.
// UI standards: two equal, fixed-width options; on the narrow rail they keep their icons and their names for screen
// readers and as tooltips.
import { SlidersHorizontal, WandSparkles } from 'lucide-react'
import type { Experience } from '@shared/config-schema.ts'
import { EASY_KIND_RECIPE } from '@shared/easy.ts'
import { cn } from '../../lib/cn.ts'
import { navigate, useRoute } from '../../lib/router.ts'
import type { Route } from '../../lib/router.ts'
import { chooseExperience, useExperience } from '../../state/experience.ts'
import { draftNow } from '../../pages/easy/draft.ts'
import {
  SWITCH_EASY,
  SWITCH_EASY_HINT,
  SWITCH_FULL,
  SWITCH_FULL_HINT,
  SWITCH_GROUP_LABEL,
} from '../../pages/easy/text.ts'
import { requestComposer } from '../palette/composerIntent.ts'
import { Tooltip } from '../ui/Tooltip.tsx'

/** Switch modes from where the user is: the same run in the other view, or the other mode's home. */
export async function switchExperience(to: Experience, route: Route): Promise<boolean> {
  if (!(await chooseExperience(to))) return false
  if (to === 'full') {
    if (route.name === 'easyRun') {
      navigate({ name: 'run', runId: route.runId })
      return true
    }
    // Two versions: the same match in Full mode's comparison.
    if (route.name === 'easyTwo') {
      navigate({ name: 'match', matchId: route.matchId })
      return true
    }
    // The Full Run view (Show details) stays where it is.
    if (route.name === 'run') return true
    const d = draftNow()
    navigate({ name: 'dashboard' })
    if (d.idea.trim() !== '') {
      requestComposer({ task: d.idea, ...(d.kind !== undefined ? { recipe: EASY_KIND_RECIPE[d.kind] } : {}) })
    }
    return true
  }
  if (route.name === 'run') navigate({ name: 'easyRun', runId: route.runId })
  else navigate({ name: 'easy' })
  return true
}

function Option({
  value,
  label,
  hint,
  icon,
  checked,
  onPick,
}: {
  value: Experience
  label: string
  hint: string
  icon: React.ReactNode
  checked: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <Tooltip content={hint} side="top">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={`${label}: ${hint}`}
        data-testid={`experience-${value}`}
        onClick={() => {
          if (!checked) onPick()
        }}
        className={cn(
          'flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-[5px] text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
          checked ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {icon}
        <span className="max-md:sr-only">{label}</span>
      </button>
    </Tooltip>
  )
}

export function ExperienceSwitch(): React.JSX.Element {
  const mode = useExperience()
  const route = useRoute()
  return (
    <div
      role="radiogroup"
      aria-label={SWITCH_GROUP_LABEL}
      data-testid="experience-switch"
      data-mode={mode}
      className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5 max-md:grid-cols-1"
    >
      <Option
        value="easy"
        label={SWITCH_EASY}
        hint={SWITCH_EASY_HINT}
        icon={<WandSparkles aria-hidden className="size-3.5 shrink-0" />}
        checked={mode === 'easy'}
        onPick={() => void switchExperience('easy', route)}
      />
      <Option
        value="full"
        label={SWITCH_FULL}
        hint={SWITCH_FULL_HINT}
        icon={<SlidersHorizontal aria-hidden className="size-3.5 shrink-0" />}
        checked={mode === 'full'}
        onPick={() => void switchExperience('full', route)}
      />
    </div>
  )
}
