// Settings → Recipes: every recipe core lists (recipes.list) with its layer (Built in, User, Project), what it turns
// on and off, where your recipe files and the chosen project's live, and the files that could not be used. Recipes are
// files: a user file `<home>/recipes/<id>.json` replaces the built-in of its id, a project file
// `<folder>/.dimfactory/recipes/<id>.json` replaces both and is shared by committing it. Read-only here; the composer's
// Recipe menu picks one for a run. The list's place is kept while it loads, so its arrival moves nothing above it.
import { RECIPE_LAYER_LABEL, recipeSummary } from '@shared/recipes.ts'
import type { RecipeLayer, RecipeView } from '@shared/recipes.ts'
import { useState } from 'react'
import { Badge } from '../../components/ui/Badge.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useConfigEpoch } from '../../state/selectors.ts'
import { ProjectFolder } from './general/ProjectFolder.tsx'
import { Group } from './kit.tsx'
import { useSectionData } from './sectionData.ts'

export const RECIPES_ABOUT =
  'A recipe is a saved pipeline plus a brief: the switches it turns on (Research, Test-first, Fix until green, the acceptance review and more) and the Brief choices it fills in. Pick one in the composer; your own changes for a run still win.'
export const RECIPE_FILES_NOTE =
  'A file with the same id as a built-in recipe replaces it. A project recipe that turns on Auto mode asks for your permission before it runs, and verify commands a recipe adds ask for your trust before they first run.'

const LAYER_CLASS: Readonly<Record<RecipeLayer, string>> = {
  builtin: 'text-muted-foreground',
  user: 'border-primary/40 text-foreground',
  project: 'border-info/50 text-info',
}

function RecipeItem({ view }: { view: RecipeView }): React.JSX.Element {
  const r = view.recipe
  return (
    <li
      data-testid={`recipe-${r.id}`}
      data-layer={view.layer}
      className="flex flex-col gap-0.5 rounded-md border px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Both cut where the row is narrow (a zoomed page, a wide font): the title says them in full. */}
        <span className="truncate text-sm font-medium" title={r.label}>
          {r.label}
        </span>
        <Badge
          variant="outline"
          data-testid={`recipe-${r.id}-layer`}
          className={cn('px-1 py-0 text-[10px] font-normal', LAYER_CLASS[view.layer])}
        >
          {RECIPE_LAYER_LABEL[view.layer]}
        </Badge>
        <span className="truncate font-mono text-xs text-muted-foreground" title={r.id}>
          {r.id}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{r.description}</p>
      <p className="text-xs" data-testid={`recipe-${r.id}-summary`}>
        {recipeSummary(r)}
      </p>
      {view.layer !== 'builtin' && (
        <p className="truncate text-xs text-muted-foreground" title={view.path}>
          {view.path}
        </p>
      )}
    </li>
  )
}

export function RecipesSection(): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null)
  const epoch = useConfigEpoch()
  const data = useSectionData(
    `recipes\u0000${folder ?? ''}`,
    () => invoke('recipes.list', folder !== null ? { folder } : {}),
    epoch,
  )
  const list = data.value
  return (
    <div className="flex flex-col gap-6" data-testid="recipes-section">
      <p className="text-sm text-muted-foreground">{RECIPES_ABOUT}</p>
      <ProjectFolder folder={folder} onChange={setFolder} testId="recipes-settings-folder" />
      <Group title="Your recipes and the built-in ones" field="recipes" testId="recipes-list-group">
        {/* The place is kept while the list loads (one line), so nothing below it moves when it arrives. */}
        {list === null ? (
          <p className="min-h-5 text-xs text-muted-foreground" data-testid="recipes-loading">
            {data.error !== null ? `Recipes could not be read: ${data.error}` : 'Reading the recipes…'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="recipes-list">
            {list.recipes.map((v) => (
              <RecipeItem key={v.recipe.id} view={v} />
            ))}
          </ul>
        )}
      </Group>
      <Group title="Recipe files" field="recipeFiles" testId="recipes-files-group">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Yours</dt>
          <dd className="truncate font-mono" data-testid="recipes-user-dir" title={list?.dirs.user}>
            {list?.dirs.user ?? ' '}
          </dd>
          <dt className="text-muted-foreground">This project's</dt>
          <dd
            className="truncate font-mono"
            data-testid="recipes-project-dir"
            title={list?.dirs.project ?? ''}
          >
            {list?.dirs.project ?? 'Choose a project above to see where its recipes live.'}
          </dd>
        </dl>
        <p className="text-xs text-muted-foreground">{RECIPE_FILES_NOTE}</p>
        {list !== null && list.issues.length > 0 && (
          <ul
            className="flex flex-col gap-1"
            data-testid="recipes-issues"
            aria-label="Recipe files with problems"
          >
            {list.issues.map((i) => (
              <li key={i.file} className="text-xs text-destructive">
                <span className="font-mono">{i.file}</span>: {i.message}
              </li>
            ))}
          </ul>
        )}
      </Group>
    </div>
  )
}
