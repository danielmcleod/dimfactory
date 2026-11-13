// The Brief for app-core: the packs (built in, overridden per user and per project), what the folder and the task
// text say (no tokens), per-folder saved briefs, a brief checked and rendered for a run, and "Suggest choices" (one
// read-only model call, only on the user's click).
import { resolve } from 'node:path'
import { DEFAULT_CATEGORY, briefTestFirst } from '../../shared/brief.ts'
import type {
  BriefContext,
  BriefFact,
  BriefField,
  BriefInput,
  BriefSuggestResult,
  BriefSuggestTarget,
  Pack,
  PackView,
} from '../../shared/brief.ts'
import type { ResolvedTemplate } from '../../shared/config-schema.ts'
import { DimFactoryError } from '../errors.ts'
import { loadPacks, packById } from '../packs/load.ts'
import { briefRecord, checkBrief } from './brief.ts'
import type { BriefRecord } from './brief.ts'
import { detectCategory, keywordFields, scanFolder } from './detect.ts'
import type { FolderScan } from './detect.ts'
import { readSavedBrief, saveBrief } from './store.ts'
import { readGenericLenses, resolveLenses } from '../research/lenses.ts'
import type { ResolveLensesResult } from '../research/lenses.ts'
import { chooseSuggester, suggestChoices, suggestTarget } from './suggest.ts'
import type { SuggestDeps } from './suggest.ts'

/** A brief ready for a run: what resolved.json records, `{{brief}}`, and whether Test-first is on. */
export interface PreparedBrief {
  record: BriefRecord
  text: string
  testFirst: boolean
  /** A re-run: the Tests step's template its source recorded. */
  testsTemplate?: ResolvedTemplate
}

export interface BriefServiceDeps {
  home: string
  now: () => number
  /** Suggest choices: the healer's read-only route (registry, readiness, flag renames). */
  suggest: Omit<SuggestDeps, 'home' | 'now'>
  /** One call's cost at the catalog's price (the cost hint). */
  price?: (vendor: string, model: string | null, tokens: number) => number | null
}

/** The Plan pass's vendor and model as resolved for the folder: who Suggest choices asks. */
export interface SuggestWho {
  vendor: string
  model: string | null
}

export class BriefService {
  readonly #d: BriefServiceDeps
  constructor(d: BriefServiceDeps) {
    this.#d = d
  }

  async #packs(folder: string | undefined): Promise<{ views: PackView[]; issues: BriefContext['issues'] }> {
    const r = await loadPacks({ home: this.#d.home, ...(folder !== undefined ? { folder } : {}) })
    return { views: r.packs, issues: r.issues }
  }

  async #scan(folder: string | undefined, packs: readonly Pack[]): Promise<FolderScan | null> {
    return folder !== undefined ? scanFolder(folder, packs) : null
  }

  /** `brief.detect`. */
  async detect(req: { folder?: string; task?: string }, who: SuggestWho | null): Promise<BriefContext> {
    const folder = req.folder !== undefined ? resolve(req.folder) : undefined
    const { views, issues } = await this.#packs(folder)
    const packs = views.map((v) => v.pack)
    const scan = await this.#scan(folder, packs)
    const task = req.task ?? ''
    const category = detectCategory(task, scan, packs)
    const facts: Record<string, BriefFact[]> = {}
    const keyword: Record<string, Record<string, BriefField>> = {}
    for (const p of packs) {
      facts[p.id] = scan?.facts[p.id] ?? []
      keyword[p.id] = task.trim() !== '' ? keywordFields(task, p, facts[p.id] ?? []) : {}
    }
    const saved = folder !== undefined ? await readSavedBrief(this.#d.home, folder) : null
    return {
      packs: views,
      issues,
      category,
      facts,
      keywordFields: keyword,
      saved: saved !== null && packById(views, saved.category) !== undefined ? saved : null,
      suggest: await this.#target(who),
      research: readGenericLenses(),
    }
  }

  /**
   * The run's Research lenses (`ids`, empty: the defaults) for a run of `category` (its pack's lenses join the generic
   * ones; an unknown category has none of its own). `web`: the Research vendor can search the web from Dim Factory.
   */
  async researchLenses(
    folder: string,
    category: string,
    ids: readonly string[],
    web: boolean,
  ): Promise<ResolveLensesResult> {
    const { views } = await this.#packs(resolve(folder))
    const pack = packById(views, category)?.pack
    return resolveLenses(ids, { generic: readGenericLenses(), pack, web })
  }

  /** The brief's pack runs Research by default (`research.on`); false without a brief or for an unknown category. */
  async researchByDefault(folder: string, brief: BriefInput | undefined): Promise<boolean> {
    if (brief === undefined) return false
    const { views } = await this.#packs(resolve(folder))
    return packById(views, brief.category)?.pack.research?.on === true
  }

  async #target(who: SuggestWho | null): Promise<BriefSuggestTarget> {
    if (who === null) return suggestTarget({ vendor: null, model: null, ready: false })
    const chosen = await chooseSuggester({ home: this.#d.home, ...this.#d.suggest }, who.vendor, who.model)
    return suggestTarget({
      vendor: chosen?.vendor ?? null,
      model: chosen?.model ?? null,
      ready: chosen !== null,
      ...(this.#d.price !== undefined ? { price: this.#d.price } : {}),
    })
  }

  /** `brief.save` (null: Reset). */
  async save(folder: string, brief: BriefInput | null): Promise<void> {
    await saveBrief(this.#d.home, resolve(folder), brief, this.#d.now())
  }

  /**
   * A run's brief: checked against its pack (unknown groups or options, two values in a single-choice group, Other
   * text where none is taken: VALIDATION) and the folder's facts (locked groups keep what the repository has).
   * undefined without a brief. `task`: the run's task (the default look-and-feel bar is added for a UI project whose
   * task does not say how it should look).
   */
  async forRun(
    folder: string,
    brief: BriefInput | undefined,
    task?: string,
  ): Promise<PreparedBrief | undefined> {
    if (brief === undefined) return undefined
    const { views } = await this.#packs(resolve(folder))
    const view = packById(views, brief.category)
    if (view === undefined) {
      throw new DimFactoryError('VALIDATION', `There is no "${brief.category}" category for the brief.`)
    }
    const scan = await this.#scan(resolve(folder), [view.pack])
    const facts = scan?.facts[view.pack.id] ?? []
    const checked = checkBrief(brief, view.pack, facts)
    if (!checked.ok) {
      throw new DimFactoryError(
        'VALIDATION',
        `The brief does not fit its category: ${checked.problems.join(' ')}`,
        {
          details: { problems: checked.problems },
        },
      )
    }
    const record = briefRecord(view, checked.brief, facts, task !== undefined ? { task } : {})
    return { record, text: record.text, testFirst: record.testFirst }
  }

  /** The brief chooses Test-first (its pack offers it as a pipeline change); false for an unknown category. */
  async testFirst(folder: string, brief: BriefInput): Promise<boolean> {
    const { views } = await this.#packs(resolve(folder))
    return briefTestFirst(brief, packById(views, brief.category)?.pack)
  }

  /** `brief.suggest`. */
  async suggest(
    req: { folder: string; task: string; brief: BriefInput },
    who: SuggestWho,
  ): Promise<BriefSuggestResult> {
    const folder = resolve(req.folder)
    const { views } = await this.#packs(folder)
    const view = packById(views, req.brief.category) ?? packById(views, DEFAULT_CATEGORY)
    if (view === undefined) throw new DimFactoryError('VALIDATION', 'There is no category for the brief.')
    const scan = await this.#scan(folder, [view.pack])
    return suggestChoices(
      { home: this.#d.home, now: this.#d.now, ...this.#d.suggest },
      {
        task: req.task,
        pack: view.pack,
        brief: req.brief.category === view.pack.id ? req.brief : { category: view.pack.id, fields: {} },
        facts: scan?.facts[view.pack.id] ?? [],
        vendor: who.vendor,
        model: who.model,
      },
    )
  }
}
