// Project memory around runs: the text a new run reads (`{{memory}}`), the update proposed when a run completes, and
// the proposals you approve or dismiss (memory.get / memory.apply / memory.dismiss). An approval writes the file only
// while no run works in its folder (a run's own snapshots would read the write as a change made outside it). An Auto
// run in a project that opted in (`memory.autoApply`, project file only) has its update written at its end, the same
// way and with the same checks; every other update waits for you.
import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { MemoryView } from '../../shared/factory.ts'
import { failedOutcomeText, queueResultOf } from '../../shared/factory.ts'
import type { RunSummary } from '../../shared/run.ts'
import { BRAND } from '../../shared/brand.ts'
import { DimFactoryError } from '../errors.ts'
import type { Logger } from '../log.ts'
import type { RunDoc } from '../supervisor/controller.ts'
import type { RunState } from '../supervisor/types.ts'
import {
  listProposals,
  memoryFileOf,
  proposalView,
  readMemory,
  readProposal,
  removeProposal,
  runNote,
  saveProposal,
  sha256,
  withRunNote,
  writeProposal,
} from './memory.ts'
import type { MemorySeed, RunNoteFacts } from './memory.ts'

export interface MemoryDeps {
  home: string
  log: Logger
  /** The folder's resolved config and the root its memory file lives at (the project root, else the repository's). */
  folderInfo(folder: string): Promise<{ config: ResolvedConfig | null; root: string }>
  readDoc(runId: string): Promise<RunDoc | null>
  /** Why the folder cannot be written now (a run works there), as UI copy; undefined when it can. */
  busy(folder: string): Promise<string | undefined>
  /** Something changed for the folder (the Queue page and the run's end panel read it again). */
  changed(folder: string): void
  /**
   * What a first memory file starts with for this folder (a project Easy made: what it is and the rules its changes
   * keep); null or absent: the plain skeleton. The proposal still waits for the user's approval.
   */
  firstNote?: (folder: string) => Promise<MemorySeed | null>
  now(): number
}

/** A run's end as its memory note says it. */
function outcomeText(s: RunSummary): string {
  const r = queueResultOf(s.status, s.outcome)
  if (r === 'done') {
    if (s.outcome === 'fixed') return 'Done, fixed what the reviewers found'
    if (s.outcome === 'clean') return 'Done, the reviewers found nothing to fix'
    return 'Done, some findings left open'
  }
  return (failedOutcomeText(s.outcome) ?? 'Ended').replace(/\.$/, '')
}

/** The last verify round's passed and failed commands. */
function checksOf(state: RunState): RunNoteFacts['checks'] {
  const v2 = state.steps['verify:2']
  const v1 = state.steps['verify:1']
  const round = v2.status === 'done' ? v2.verify : v1.status === 'done' ? v1.verify : undefined
  if (round === undefined) return undefined
  return {
    passed: round.commands.filter((c) => c.status === 'pass').map((c) => c.name),
    failed: round.commands.filter((c) => c.status === 'fail').map((c) => c.name),
  }
}

export class MemoryService {
  readonly #d: MemoryDeps

  constructor(d: MemoryDeps) {
    this.#d = d
  }

  /** The text a new run in `root` gets (`{{memory}}`), or undefined (memory off, no file). */
  async forRun(root: string, config: ResolvedConfig): Promise<string | undefined> {
    if (!config.memory.enabled) return undefined
    const r = await readMemory(memoryFileOf(root), config.memory.maxBytes)
    return r.text ?? undefined
  }

  async view(folder: string): Promise<MemoryView> {
    const { config, root } = await this.#d.folderInfo(folder)
    const m = config?.memory ?? { enabled: true, propose: true, autoApply: false, maxBytes: 16_000 }
    const file = memoryFileOf(root)
    const r = await readMemory(file, m.maxBytes)
    const pending = await Promise.all((await listProposals(this.#d.home, folder)).map((p) => proposalView(p)))
    return {
      folder,
      file,
      exists: r.exists,
      bytes: r.bytes,
      capped: r.capped,
      maxBytes: m.maxBytes,
      enabled: m.enabled,
      propose: m.propose,
      autoApply: m.autoApply,
      pending,
    }
  }

  /**
   * A completed run: propose its note (memory on and proposing). An Auto run in a project that opted in writes it
   * at once when the folder is free; otherwise, and when the write cannot happen, the proposal waits for you.
   */
  async onRunEnded(s: RunSummary): Promise<void> {
    if (s.status !== 'completed') return
    const { config, root } = await this.#d.folderInfo(s.folder)
    if (config === null || !config.memory.enabled || !config.memory.propose) return
    const doc = await this.#d.readDoc(s.runId)
    if (doc === null) return
    const st = doc.state
    const file = memoryFileOf(root)
    const current = await readFile(file, 'utf8').catch(() => null)
    // A project's first note starts the file with what the app knows of it (an Easy project: what it is and its rules).
    const seed = current === null ? await (this.#d.firstNote?.(s.folder) ?? null)?.catch(() => null) : null
    const checks = checksOf(st)
    const branch = st.branch?.name ?? st.isolation?.worktree?.branch
    const target = st.deploy?.plan?.target?.label
    const facts: RunNoteFacts = {
      displayNo: s.displayNo,
      title: s.title,
      at: s.endedAt ?? this.#d.now(),
      ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
      outcomeText: outcomeText(s),
      ...(branch !== undefined ? { branch } : {}),
      ...(checks !== undefined ? { checks } : {}),
      ...(target !== undefined ? { deployTarget: target } : {}),
      ...(st.recipe !== undefined ? { recipe: st.recipe.label } : {}),
    }
    const proposal = {
      id: s.runId,
      folder: s.folder,
      file,
      runId: s.runId,
      displayNo: s.displayNo,
      title: s.title,
      createdAt: this.#d.now(),
      baseSha256: current === null ? null : sha256(current),
      next: withRunNote(current, runNote(facts), seed),
    }
    if (st.config.auto && config.memory.autoApply && (await this.#d.busy(s.folder)) === undefined) {
      try {
        await writeProposal(proposal)
        this.#d.log.info('project memory updated by an Auto run (the project opted in)', { runId: s.runId })
        this.#d.changed(s.folder)
        return
      } catch (err) {
        this.#d.log.warn('project memory could not be written; the update waits for you', { err })
      }
    }
    await saveProposal(this.#d.home, proposal)
    this.#d.changed(s.folder)
  }

  /** Write a proposal you approved (CONFLICT when the file changed since, FOLDER_BUSY while a run works there). */
  async apply(folder: string, id: string): Promise<MemoryView> {
    const p = await readProposal(this.#d.home, folder, id)
    if (p === null) throw new DimFactoryError('NOT_FOUND', 'That update is no longer waiting.')
    const busy = await this.#d.busy(folder)
    if (busy !== undefined)
      throw new DimFactoryError(
        'FOLDER_BUSY',
        `${busy} Approve the ${BRAND.memoryFileName} update when it has finished.`,
      )
    await writeProposal(p)
    await removeProposal(this.#d.home, folder, id)
    this.#d.log.info('project memory updated (approved)', { runId: p.runId })
    this.#d.changed(folder)
    return this.view(folder)
  }

  async dismiss(folder: string, id: string): Promise<MemoryView> {
    await removeProposal(this.#d.home, folder, id)
    this.#d.changed(folder)
    return this.view(folder)
  }
}
