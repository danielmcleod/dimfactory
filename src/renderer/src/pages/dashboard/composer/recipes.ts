// The composer's Recipe picker, as logic: the folder's recipes (core's recipes.list), choosing one programmatically
// (selectComposerRecipe: the palette, a New project template), and a recipe's brief defaults applied to the Brief
// draft for the groups the user has not set. Core resolves the recipe as its own config layer (the composer sends its
// id with config.resolve, preflight.run, estimates.get and runs.start); the composer's own overrides still win.
import { useEffect, useRef, useState } from 'react'
import type { BriefContext, BriefField } from '@shared/brief.ts'
import { BRIEF_OTHER_MAX, fieldIsSet } from '@shared/brief.ts'
import { recipeBrief } from '@shared/recipes.ts'
import type { Recipe, RecipeView, RecipesList } from '@shared/recipes.ts'
import { invoke } from '../../../ipc/client.ts'
import { chooseCategory, locksOf, packOf } from './brief-model.ts'
import type { BriefDraft } from './brief-model.ts'

/** The picker's "None" item (a recipe id never has an underscore). */
export const NO_RECIPE = '__none'
export const NO_RECIPE_LABEL = 'None'
export const DEFAULT_TASK_PLACEHOLDER =
  'Describe the task, e.g. Add a --version flag that prints the package version'

/** The task box's placeholder: the recipe's hint, else the default one. */
export function taskPlaceholder(recipe: Recipe | undefined): string {
  return recipe?.taskHint ?? DEFAULT_TASK_PLACEHOLDER
}

/** The hover text of a recipe applied field: where the value came from. */
export function recipeReason(recipe: Recipe): string {
  return `From the recipe ${recipe.label}`
}

/**
 * The recipe's brief defaults in the draft: its category is shown (every category keeps its own fields, so switching
 * back restores them) and each of its fields fills a group the user has not set themselves and no fact from the folder
 * fixes, as a suggested value (its chip says it came from the recipe). The user's own choices stay as they are.
 */
export function applyRecipeToDraft(
  ctx: BriefContext | null,
  draft: BriefDraft,
  recipe: Recipe,
): { draft: BriefDraft; applied: number; category: string | null } {
  const brief = recipeBrief(recipe)
  if (brief === undefined) return { draft, applied: 0, category: null }
  const pack = packOf(ctx, brief.category)?.pack
  if (pack === undefined) return { draft, applied: 0, category: null }
  let next = draft.category === pack.id ? draft : chooseCategory(draft, pack.id)
  const locks = locksOf(ctx, pack)
  const reason = recipeReason(recipe)
  let applied = 0
  for (const [groupId, f] of Object.entries(brief.fields)) {
    const group = pack.groups.find((g) => g.id === groupId)
    if (group === undefined) continue
    const lock = locks.byGroup.get(group.id)
    if (lock?.whole === true) continue
    if (next.own[pack.id]?.[group.id]?.source === 'user') continue
    const known = new Set(group.options.map((o) => o.id))
    const choices = f.choices.filter((c) => known.has(c) && lock?.options.has(c) !== true)
    const one = group.multi ? choices : choices.slice(0, 1)
    const other =
      group.other && f.other !== undefined && f.other.trim() !== '' && (group.multi || one.length === 0)
        ? f.other.trim().slice(0, BRIEF_OTHER_MAX)
        : undefined
    const field: BriefField = { choices: one, ...(other !== undefined ? { other } : {}), source: 'suggested' }
    if (!fieldIsSet(field)) continue
    next = {
      ...next,
      own: { ...next.own, [pack.id]: { ...(next.own[pack.id] ?? {}), [group.id]: field } },
      reasons: { ...next.reasons, [pack.id]: { ...(next.reasons[pack.id] ?? {}), [group.id]: reason } },
    }
    applied++
  }
  return { draft: next, applied, category: pack.id }
}

export function recipeOf(list: RecipesList | null, id: string | null): RecipeView | undefined {
  if (list === null || id === null) return undefined
  return list.recipes.find((v) => v.recipe.id === id)
}

// ---- choosing a recipe from elsewhere ---------------------------------------------------------------------------

type Listener = (id: string | null) => void

/** A choice waiting for the composer is dropped after this long (as the palette's composer intent). */
export const RECIPE_INTENT_TTL_MS = 5000

const listeners = new Set<Listener>()
let pending: { id: string | null; at: number } | null = null

/**
 * Choose the composer's recipe by id (null: None), as picking it in the Recipe menu would: the palette or a New
 * project template call this. An id the folder has no recipe for is ignored by the composer. A choice made while the
 * composer is not mounted waits for its next mount, for a short while only.
 */
export function selectComposerRecipe(id: string | null): void {
  if (listeners.size === 0) {
    pending = { id, at: Date.now() }
    return
  }
  pending = null
  for (const l of [...listeners]) l(id)
}

/** The composer's side: called with each choice while mounted, and with one still waiting when it mounts. */
export function useRecipeIntent(handler: Listener): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const listener: Listener = (id) => ref.current(id)
    listeners.add(listener)
    const waiting = pending
    pending = null
    if (waiting !== null && Date.now() - waiting.at <= RECIPE_INTENT_TTL_MS) listener(waiting.id)
    return () => {
      listeners.delete(listener)
    }
  }, [])
}

/** Tests: forget listeners and a waiting choice. */
export function resetRecipeIntentForTests(): void {
  pending = null
  listeners.clear()
}

// ---- the list ---------------------------------------------------------------------------------------------------

export interface RecipesState {
  list: RecipesList | null
  /** recipes.list failed (the picker then offers None only). */
  error: string | null
}

/** recipes.list for the folder (and again when the config changes: a recipe file may have been added). */
export function useRecipes(folder: string | null, epoch: number): RecipesState {
  const [state, setState] = useState<RecipesState>({ list: null, error: null })
  useEffect(() => {
    let live = true
    void invoke('recipes.list', folder !== null ? { folder } : {}).then((r) => {
      if (!live) return
      if (r.ok) setState({ list: r.value, error: null })
      // An older core without recipes: the menu stays at None, with nothing to report.
      else if (r.error.code === 'UNSUPPORTED') setState({ list: null, error: null })
      else setState((prev) => ({ list: prev.list, error: r.error.message }))
    })
    return () => {
      live = false
    }
  }, [folder, epoch])
  return state
}
