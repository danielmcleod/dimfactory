// Engine drivers for an isolated run (worktree; R2/R5/R12): the verify flow for an isolated
// run, plus the controller's answers to the prepare stages, the lease and the finalize effects. Everything still
// goes through `reduce`.
import { expect } from 'vitest'
import { initRunState } from '@core/supervisor/machine.ts'
import type {
  DepsCommandState,
  InstallOutcome,
  PrepareStage,
  Reduction,
  RunConfig,
  WorktreeInfo,
} from '@core/supervisor/types.ts'
import { T0 } from '../../supervisor/helpers.ts'
import { VFlow, verifyFlowConfig } from '../../verify/machine-helpers.ts'
import type { VerifyOptions } from '../../verify/machine-helpers.ts'

export interface IsoOptions extends VerifyOptions {
  install?: 'ask' | 'auto' | 'never'
  autoApply?: boolean
  baseline?: boolean
}

export const WORKTREE: WorktreeInfo = {
  path: 'C:\\home\\worktrees\\20261005T120000Z-abcd',
  branch: 'dim/20261005-add-a-version-flag-abcd',
  base: '0123456789abcdef0123456789abcdef01234567',
  rel: '',
}

export function isoConfig(o: IsoOptions = {}): RunConfig {
  const c = verifyFlowConfig({ ...o, enabled: o.enabled ?? false })
  c.isolation = 'worktree'
  c.worktree = { install: o.install ?? 'ask', autoApply: o.autoApply ?? false }
  c.verify.baseline = o.baseline ?? false
  return c
}

export const PNPM: DepsCommandState = {
  manager: 'pnpm',
  argv: ['pnpm', 'install', '--frozen-lockfile'],
  cwdRel: '.',
  lockfile: 'pnpm-lock.yaml',
  source: 'detected',
  plan: { manager: 'pnpm', argv: ['pnpm', 'install', '--frozen-lockfile'], cwdRel: '.' },
}

export const install = (
  status: InstallOutcome['status'],
  o: Partial<InstallOutcome> = {},
): InstallOutcome => ({
  status,
  exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null,
  durationMs: 2_000,
  excerpt: status === 'fail' ? 'ERR_PNPM_LOCKFILE' : '',
  ...o,
})

/** An isolated run (Plan → gate → Implement → Review ∥ Critic → Fix as the verify VFlow) with the isolated-run answers. */
export class IFlow extends VFlow {
  constructor(o: IsoOptions = {}) {
    super(o)
    this.state = initRunState({
      runId: '20261005T120000Z-abcd',
      displayNo: 7,
      folder: 'C:\\tmp\\ts-small',
      folderKey: '0123456789abcdef',
      task: 'add a --version flag',
      profile: 'claude-only',
      createdAt: T0,
      config: isoConfig(o),
    })
  }

  prepReq(stage: PrepareStage): string {
    return this.req((r) => r.kind === 'prepare' && r.stage === stage, `prepare ${stage}`)
  }

  /** Step 1 and 2's answer: the worktree, uncommitted changes left out, copy-ins. */
  setup(o: { uncommitted?: number; copied?: number; notes?: string[] } = {}): Reduction {
    return this.send({
      t: 'prepare-result',
      req: this.prepReq('setup'),
      ok: true,
      worktree: { ...WORKTREE },
      ...(o.uncommitted !== undefined ? { uncommitted: o.uncommitted } : {}),
      ...(o.copied !== undefined ? { copied: o.copied } : {}),
      ...(o.notes !== undefined ? { notes: o.notes } : {}),
    })
  }

  /** Step 3's decision: nothing to install (null), or a command and its trust. */
  deps(
    command: DepsCommandState | null,
    trust: 'trusted' | 'untrusted' | 'changed' | 'invalid' = 'untrusted',
    o: { skip?: string; body?: string } = {},
  ): Reduction {
    return this.send({
      t: 'prepare-result',
      req: this.prepReq('rest'),
      ok: true,
      deps: command === null ? null : { command, trust, body: o.body ?? 'file pnpm-lock.yaml sha256 aa' },
      ...(o.skip !== undefined ? { skip: o.skip } : {}),
    })
  }

  installed(o: InstallOutcome = install('pass')): Reduction {
    return this.send({ t: 'prepare-result', req: this.prepReq('install'), ok: true, install: o })
  }

  ready(missing: { name: string; argv: string[]; reason?: string }[] = []): Reduction {
    return this.send({ t: 'prepare-result', req: this.prepReq('ready'), ok: true, missing })
  }

  /** R1 → R2 → preflight → setup (the worktree) → run-start → Plan spawned. Prepare's rest is still running. */
  override toPlanRunning(): this {
    this.create()
    this.lock()
    this.preflight()
    this.setup()
    this.snapshot('run-start', 'tree-base')
    this.passPreflight('plan')
    return this
  }

  /** Prepare's rest with nothing to install and (with verify on) a ready worktree. */
  finishPrepare(): this {
    this.deps(null)
    if (this.findReq((r) => r.kind === 'prepare' && r.stage === 'ready') !== undefined) this.ready()
    return this
  }

  override toImplementRunning(o: { session?: boolean } = {}): this {
    this.toPlanGate()
    if (this.state.cards.some((c) => c.view.kind === 'gate:afterPlan')) this.approve()
    if (this.state.flow.prepared !== 'all') this.finishPrepare()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    if (o.session !== false) this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  finReq(op: 'preview' | 'apply' | 'undo' | 'remove'): string {
    return this.req((r) => r.kind === 'finalize' && r.op === op, `finalize ${op}`)
  }

  preview(files = 3, conflicts: { path: string; reason?: string }[] = []): Reduction {
    return this.send({ t: 'finalize-preview', req: this.finReq('preview'), files, conflicts })
  }

  lease(): Reduction {
    return this.send({ t: 'lease-acquired' })
  }

  applied(
    applied: string[] = ['src/cli.ts'],
    conflicts: { path: string; reason?: string }[] = [],
    undoToken = 'apply-1',
  ): Reduction {
    return this.send({ t: 'apply-result', req: this.finReq('apply'), applied, conflicts, undoToken })
  }

  /** Implement made no changes: R6 completes `no-changes`, which an isolated run reaches through R12. */
  toR12NoChanges(): this {
    this.toImplementDone()
    this.snapshot('S1', 'tree-base')
    return this
  }

  /** Implement changed files; Review ∥ Critic report nothing; R8's skip rule: `clean` reaches R12. */
  toR12Clean(): this {
    this.toJoin()
    return this
  }

  cardOf(kind: Parameters<VFlow['card']>[0]): ReturnType<VFlow['card']> {
    const c = this.state.cards.find((x) => x.view.kind === kind)
    expect(c, `open ${kind} card`).toBeDefined()
    return c as ReturnType<VFlow['card']>
  }
}
