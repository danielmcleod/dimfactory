// The composer's Recipe row: a menu of the folder's recipes (built in, yours, the project's) with None first, and a
// one-line note saying what the chosen recipe turns on. UI standard: the row is always there and one line high; the
// menu keeps one width (it is there, disabled, before the list arrives) and the note is cut to fit, so neither the
// list loading nor a choice moves anything.
import { RECIPE_LAYER_LABEL, recipeSummary } from '@shared/recipes.ts'
import type { RecipeView, RecipesList } from '@shared/recipes.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { NO_RECIPE, NO_RECIPE_LABEL } from './recipes.ts'

export const RECIPE_NOTE_NONE = 'Saved pipelines and briefs: a recipe sets the switches and fills the Brief.'

/** The note beside the menu: what the chosen recipe turns on (your own changes still win), or what recipes are. */
export function recipeNote(selected: RecipeView | undefined, error: string | null): string {
  if (selected !== undefined) return `${recipeSummary(selected.recipe)} Your own changes still win.`
  if (error !== null) return `Recipes could not be read: ${error}`
  return RECIPE_NOTE_NONE
}

export function RecipeRow({
  list,
  selected,
  error,
  onChange,
}: {
  list: RecipesList | null
  selected: RecipeView | undefined
  error: string | null
  onChange: (id: string | null) => void
}): React.JSX.Element {
  const id = 'composer-recipe'
  const note = recipeNote(selected, error)
  return (
    <div data-testid={`${id}-row`} className="flex min-h-7 min-w-0 items-center gap-2">
      <span id={`${id}-label`} className="shrink-0 text-xs font-medium text-muted-foreground">
        Recipe
      </span>
      <Select
        value={selected?.recipe.id ?? NO_RECIPE}
        onValueChange={(v) => onChange(v === NO_RECIPE ? null : v)}
        disabled={list === null}
      >
        <SelectTrigger
          size="sm"
          data-testid={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-note`}
          className="w-36 shrink-0 lg:w-44"
        >
          <SelectValue placeholder={NO_RECIPE_LABEL} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_RECIPE} data-testid={`${id}-option-none`}>
            {NO_RECIPE_LABEL}
          </SelectItem>
          {(list?.recipes ?? []).map((v) => (
            <SelectItem key={v.recipe.id} value={v.recipe.id} data-testid={`${id}-option-${v.recipe.id}`}>
              {v.layer === 'builtin' ? v.recipe.label : `${v.recipe.label} (${RECIPE_LAYER_LABEL[v.layer]})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        id={`${id}-note`}
        data-testid={`${id}-note`}
        title={selected !== undefined ? `${selected.recipe.description}\n${note}` : note}
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >
        {note}
      </p>
    </div>
  )
}
