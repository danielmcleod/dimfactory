// `dimf recipes [--folder <dir>]`: every recipe (built in, the user's `<home>/recipes/` files and the folder's
// `.dimfactory/recipes/` files) with its layer and what it turns on and off, plus the files that could not be used.
// Read-only. `dimf run --recipe <id>` runs with one.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { RECIPE_LAYER_LABEL, recipeSummary } from '../../shared/recipes.ts'
import type { RecipesList } from '../../shared/recipes.ts'
import { UsageError } from '../args.ts'
import type { CliIo } from '../io.ts'
import { EXIT, usage, withReadOnlyCore } from '../session.ts'

export const RECIPES_USAGE = 'dimf recipes [--folder <dir>] [--json] [--home dir]'

/** The list as lines: one block per recipe, then where the files live and the problems. */
export function recipeLines(list: RecipesList): string[] {
  const out: string[] = []
  const width = Math.max(0, ...list.recipes.map((v) => v.recipe.id.length))
  for (const v of list.recipes) {
    const r = v.recipe
    out.push(`${r.id.padEnd(width)}  ${r.label} (${RECIPE_LAYER_LABEL[v.layer]})`)
    out.push(`${' '.repeat(width)}  ${recipeSummary(r)}`)
    if (v.layer !== 'builtin') out.push(`${' '.repeat(width)}  File: ${v.path}`)
  }
  out.push('')
  out.push(`Your recipes: ${list.dirs.user}`)
  if (list.dirs.project !== null) out.push(`This folder's recipes: ${list.dirs.project}`)
  if (list.issues.length > 0) {
    out.push('')
    out.push('Recipe files that could not be used:')
    for (const i of list.issues) out.push(`  ${i.file}: ${i.message}`)
  }
  out.push('')
  out.push('Run with one: dimf run <folder> <task> --recipe <id>')
  return out
}

export async function recipesCommand(args: readonly string[], io: CliIo): Promise<number> {
  let v: { folder?: string | undefined; json?: boolean | undefined; home?: string | undefined }
  let folder: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        folder: { type: 'string' },
        json: { type: 'boolean', default: false },
        home: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    })
    v = parsed.values
    if (v.folder === '') throw new UsageError('--folder needs a folder')
    folder = v.folder !== undefined ? resolve(io.cwd, v.folder) : undefined
  } catch (err) {
    return usage(io, 'recipes', RECIPES_USAGE, err)
  }
  return withReadOnlyCore(
    io,
    v.home,
    async (core) => {
      const r = await core.invoke('recipes.list', folder !== undefined ? { folder } : {})
      if (!r.ok) {
        io.err(`dimf recipes: ${r.error.message}`)
        return r.error.code === 'VALIDATION' ? EXIT.usage : EXIT.failed
      }
      if (v.json === true) io.out(JSON.stringify(r.value, null, 2))
      else for (const l of recipeLines(r.value)) io.out(l)
      return EXIT.completed
    },
    { configBanner: false },
  )
}
