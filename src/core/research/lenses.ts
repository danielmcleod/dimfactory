// Research lenses: the generic ones (packs/research-lenses.json) and the run's pack's own, which lenses a run
// researches, and the run's Research config (the lenses resolved to their questions, and whether it may search the web).
// A vendor without web search researches the repository lens only. Pure apart from reading the built-in lenses file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pack } from '../../shared/brief.ts'
import {
  GENERIC_SOURCE,
  GenericLensesZ,
  REPOSITORY_LENS,
  defaultLensIds,
  lensOptions,
} from '../../shared/research.ts'
import type { GenericLenses, ResearchLens, ResearchRunConfig } from '../../shared/research.ts'
import { builtinDir } from '../packs/load.ts'
import type { Support } from '../../shared/vendors.ts'

export const GENERIC_LENSES_FILE = 'research-lenses.json'

let memo: GenericLenses | undefined

/** The generic lenses (validated; a broken built-in file is a packaging bug, so it throws). */
export function readGenericLenses(dir?: string): GenericLenses {
  if (dir === undefined && memo !== undefined) return memo
  const file = join(dir ?? builtinDir(), GENERIC_LENSES_FILE)
  const parsed = GenericLensesZ.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
  if (!parsed.success)
    throw new Error(`The built-in research lenses ${file} are broken: ${parsed.error.message}`)
  if (dir === undefined) memo = parsed.data
  return parsed.data
}

export { GENERIC_SOURCE, defaultLensIds, lensOptions }

export interface ResolveLensesResult {
  config: ResearchRunConfig
  /** Lens ids that are neither generic nor the pack's. */
  unknown: string[]
}

/**
 * The run's Research config from the ticked lens ids (`ids`; empty: the defaults). `web`: the Research vendor can
 * search the web from Dim Factory. Without it the web lenses are left out (`offWeb`) and the repository lens runs,
 * so Research always has something to read.
 */
export function resolveLenses(
  ids: readonly string[],
  o: { generic: GenericLenses; pack?: Pack | undefined; web: boolean },
): ResolveLensesResult {
  const options = lensOptions(o.generic, o.pack)
  const byId = new Map(options.map((l) => [l.id, l]))
  const wanted = ids.length > 0 ? [...new Set(ids)] : defaultLensIds(o.generic, o.pack)
  const unknown = wanted.filter((id) => !byId.has(id))
  const picked = wanted.flatMap((id) => {
    const l = byId.get(id)
    return l !== undefined ? [{ id: l.id, label: l.label, ask: l.ask, web: l.web }] : []
  })
  if (o.web) return { config: { lenses: picked, web: true }, unknown }
  const offWeb = picked.filter((l) => l.web).map((l) => l.label)
  let lenses = picked.filter((l) => !l.web)
  if (lenses.length === 0) {
    const repo = byId.get(REPOSITORY_LENS)
    if (repo !== undefined) lenses = [{ id: repo.id, label: repo.label, ask: repo.ask, web: false }]
  }
  return {
    config: { lenses, web: false, ...(offWeb.length > 0 ? { offWeb } : {}) },
    unknown,
  }
}

/** Research's mode copy (StepView.modeCopy): what the confined pass may do. UI copy, no em dashes. */
export function researchSupport(web: boolean): Support {
  return web
    ? {
        status: 'supported',
        copy: 'Reads this repository and searches the web; no edits, no commands, no agents. Web pages are untrusted data.',
      }
    : {
        status: 'degraded',
        copy: 'No web search from this vendor: reads this repository only; no edits, no commands, no agents.',
      }
}

/** `{{lenses}}`: one numbered question per lens. */
export function renderLenses(lenses: readonly ResearchLens[]): string {
  return lenses
    .map((l, i) => `${i + 1}. ${l.label}${l.web ? '' : ' (repository only, no web)'}: ${l.ask}`)
    .join('\n')
}

/** `{{access}}`: what the Research pass may reach. */
export function renderAccess(web: boolean): string {
  return web
    ? 'You may search the web and read web pages, and read the files of this repository. You cannot edit files, run commands or start other agents.'
    : 'You have no web access in this run: read the files of this repository only. You cannot edit files, run commands or start other agents. Cite repository files as `repo:<path>`.'
}
