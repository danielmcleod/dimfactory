// Recipes as files: the built-in recipes are JSON files next to this module; a user file `<home>/recipes/<id>.json`
// replaces the built-in of its id, and a project file `<folder>/.dimfactory/recipes/<id>.json` replaces both. A file
// with a new id adds a recipe. A broken file is reported as an issue and skipped, never fatal. Each recipe keeps its
// layer, path and sha256 (a project recipe's Auto grant is bound to that sha256).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodError } from 'zod'
import { BRAND } from '../../shared/brand.ts'
import { BUILTIN_RECIPE_IDS, RECIPE_FILE_MAX_BYTES, RecipeZ } from '../../shared/recipes.ts'
import type { Recipe, RecipeIssue, RecipeLayer, RecipeView, RecipesList } from '../../shared/recipes.ts'
import { DimFactoryError } from '../errors.ts'
import { normalizeText, suggestName } from '../prompts/template.ts'

/**
 * Where the built-in recipes live: beside this module in the source tree, or in `recipes/` beside the bundled main
 * module. The first directory holding `bug-fix.json` wins.
 */
function defaultBuiltinDir(): string {
  const candidates = [
    fileURLToPath(new URL('./', import.meta.url)),
    fileURLToPath(new URL('./recipes/', import.meta.url)),
  ]
  return candidates.find((d) => existsSync(join(d, 'bug-fix.json'))) ?? (candidates[0] as string)
}

let builtinDirMemo: string | undefined
let builtinMemo: RecipeView[] | undefined

export function builtinRecipesDir(): string {
  builtinDirMemo ??= defaultBuiltinDir()
  return builtinDirMemo
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function describeZodError(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

type Parsed = { ok: true; recipe: Recipe; sha256: string } | { ok: false; message: string }

/** Parse and validate one recipe file's text; the file name (without .json) must be the recipe's id. */
export function parseRecipeText(raw: string, stem: string): Parsed {
  const text = normalizeText(raw)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `Not valid JSON: ${(err as Error).message}` }
  }
  const r = RecipeZ.safeParse(json)
  if (!r.success) return { ok: false, message: `Not a valid recipe: ${describeZodError(r.error)}` }
  if (r.data.id !== stem) {
    return { ok: false, message: `The file name must match the recipe id ("${r.data.id}.json")` }
  }
  return { ok: true, recipe: r.data, sha256: sha256(text) }
}

/** The built-in recipes in their fixed order. A broken built-in is a packaging bug, so it throws. */
export function readBuiltinRecipes(dir?: string): RecipeView[] {
  if (dir === undefined && builtinMemo !== undefined) return builtinMemo
  const base = dir ?? builtinRecipesDir()
  const views = BUILTIN_RECIPE_IDS.map((id): RecipeView => {
    const file = join(base, `${id}.json`)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(`Cannot read the built-in recipe ${file}: ${(err as Error).message}`, { cause: err })
    }
    const r = parseRecipeText(raw, id)
    if (!r.ok) throw new Error(`The built-in recipe ${file} is broken. ${r.message}`)
    return { recipe: r.recipe, layer: 'builtin', path: file, sha256: r.sha256 }
  })
  if (dir === undefined) builtinMemo = views
  return views
}

/** The recipe files of one layer directory, sorted by name; a missing directory has none. */
async function readLayer(dir: string, layer: RecipeLayer, issues: RecipeIssue[]): Promise<RecipeView[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      issues.push({ file: dir, message: `Cannot list the recipes folder: ${(err as Error).message}` })
    }
    return []
  }
  const views: RecipeView[] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, name)
    const stem = name.slice(0, -'.json'.length)
    try {
      const st = await stat(file)
      if (!st.isFile()) continue
      if (st.size > RECIPE_FILE_MAX_BYTES) {
        issues.push({ file, message: `Too large (${st.size} bytes; the limit is ${RECIPE_FILE_MAX_BYTES})` })
        continue
      }
      const r = parseRecipeText(await readFile(file, 'utf8'), stem)
      if (!r.ok) {
        issues.push({ file, message: r.message })
        continue
      }
      views.push({ recipe: r.recipe, layer, path: file, sha256: r.sha256 })
    } catch (err) {
      issues.push({ file, message: `Cannot read: ${(err as Error).message}` })
    }
  }
  return views
}

export interface LoadRecipesOptions {
  /** DIM_FACTORY_HOME (the user layer is `<home>/recipes/`). */
  home: string
  /** The run folder (the project layer is `<folder>/.dimfactory/recipes/`); omitted: no project layer. */
  folder?: string
  /** Test seam for the built-in directory. */
  builtinDir?: string
}

export function userRecipesDir(home: string): string {
  return join(home, 'recipes')
}

export function projectRecipesDir(folder: string): string {
  return join(folder, BRAND.projectDirName, 'recipes')
}

/**
 * Every recipe with its layer: project beats user beats built-in, per id. Built-ins keep their order (a file of the
 * same id replaces its built-in in place); added ids follow, sorted. Problems with files become issues.
 */
export async function loadRecipes(o: LoadRecipesOptions): Promise<RecipesList> {
  const issues: RecipeIssue[] = []
  const byId = new Map<string, RecipeView>()
  for (const v of readBuiltinRecipes(o.builtinDir)) byId.set(v.recipe.id, v)
  const builtinIds = [...byId.keys()]
  const userDir = userRecipesDir(o.home)
  for (const v of await readLayer(userDir, 'user', issues)) byId.set(v.recipe.id, v)
  const projectDir = o.folder !== undefined ? projectRecipesDir(o.folder) : null
  if (projectDir !== null) {
    for (const v of await readLayer(projectDir, 'project', issues)) byId.set(v.recipe.id, v)
  }
  const added = [...byId.keys()].filter((id) => !builtinIds.includes(id)).sort()
  const recipes = [...builtinIds, ...added].map((id) => byId.get(id) as RecipeView)
  return { recipes, issues, dirs: { user: userDir, project: projectDir } }
}

/**
 * The sha256 of the folder's project recipe `<id>.json` as the loader hashes it; null when there is no such file or it
 * is not a valid recipe (an invalid file is never used, so there is nothing to trust).
 */
export async function projectRecipeSha(folder: string, id: string): Promise<string | null> {
  const file = join(projectRecipesDir(folder), `${id}.json`)
  try {
    const st = await stat(file)
    if (!st.isFile() || st.size > RECIPE_FILE_MAX_BYTES) return null
    const r = parseRecipeText(await readFile(file, 'utf8'), id)
    return r.ok ? r.sha256 : null
  } catch {
    return null
  }
}

/** Load the layers and pick the recipe of `id` (VALIDATION with a did-you-mean when there is none). */
export async function resolveRecipe(o: LoadRecipesOptions & { id: string }): Promise<RecipeView> {
  return recipeById(await loadRecipes(o), o.id)
}

/** The recipe of `id`, or a VALIDATION error naming the recipes there are (with a "did you mean"). */
export function recipeById(list: Pick<RecipesList, 'recipes'>, id: string): RecipeView {
  const hit = list.recipes.find((v) => v.recipe.id === id)
  if (hit !== undefined) return hit
  const ids = list.recipes.map((v) => v.recipe.id)
  const hint = suggestName(id, ids)
  throw new DimFactoryError(
    'VALIDATION',
    `Unknown recipe "${id}"${hint !== undefined ? ` (did you mean "${hint}"?)` : ''}. Recipes: ${ids.join(', ')}.`,
  )
}
