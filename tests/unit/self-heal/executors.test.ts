// Executors behind recovery.execute (config_patch (this run via
// P22, the composer's overrides, `persist` through config.patch with the allowlist), switch_vendor (readiness checked
// again at the click), grant (largeFolder, projectAuto, command; vendorFolder), wait_until (arm/disarm), heal
// (a run's step; a check outside a run), and the lookup of a snag's AI suggestions.
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { StepKey, WaitView } from '@shared/run.ts'
import { DimFactoryError } from '@core/errors.ts'
import { LATER_VERSION_MESSAGE, executeAction, findAction } from '@core/recovery/dispatcher.ts'
import type {
  ExecuteDeps,
  FoundAction,
  LookupDeps,
  RecoveryConfigDeps,
  RunCommandDeps,
} from '@core/recovery/dispatcher.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import type { VendorReadiness } from '@core/recovery/switch-vendor.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { makeConfig } from '../supervisor/helpers.ts'

const RUN = '20261008T120000Z-heal1'
const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

function state(o: { failed?: StepKey[]; cards?: RunState['cards']; heal?: RecoveryAction[] } = {}): RunState {
  const steps: Record<string, unknown> = {}
  for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'fix'] as const) {
    const failed = o.failed?.includes(k) === true
    steps[k] = {
      snagOpen: failed,
      status: failed ? 'failed' : 'queued',
      ...(failed && o.heal !== undefined
        ? { heal: { status: 'ok', trigger: 'auto', at: 0, actions: o.heal, hidden: 0, healId: 1 } }
        : {}),
    }
  }
  return {
    runId: RUN,
    folder: FOLDER,
    steps,
    cards: o.cards ?? [],
    config: makeConfig(),
  } as unknown as RunState
}

type Fn<F extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<F>>

interface Mocks {
  run: {
    retryPass: Fn<RunCommandDeps['retryPass']>
    applyConfigPatch: Fn<NonNullable<RunCommandDeps['applyConfigPatch']>>
    heal: Fn<NonNullable<RunCommandDeps['heal']>>
    toggleWait: Fn<NonNullable<RunCommandDeps['toggleWait']>>
    resolveCard: Fn<NonNullable<RunCommandDeps['resolveCard']>>
  }
  config: { persist: Fn<RecoveryConfigDeps['persist']>; grant: Fn<RecoveryConfigDeps['grant']> }
  deps: ExecuteDeps
}

function mocks(o: { vendors?: VendorReadiness; wait?: WaitView | undefined } = {}): Mocks {
  const run: Mocks['run'] = {
    retryPass: vi.fn<RunCommandDeps['retryPass']>(() => Promise.resolve()),
    applyConfigPatch: vi.fn<NonNullable<RunCommandDeps['applyConfigPatch']>>(() => Promise.resolve()),
    heal: vi.fn<NonNullable<RunCommandDeps['heal']>>(() => Promise.resolve()),
    toggleWait: vi.fn<NonNullable<RunCommandDeps['toggleWait']>>(() => Promise.resolve(o.wait)),
    resolveCard: vi.fn<NonNullable<RunCommandDeps['resolveCard']>>(() => Promise.resolve()),
  }
  const config: Mocks['config'] = {
    persist: vi.fn<RecoveryConfigDeps['persist']>((scope, folder) =>
      Promise.resolve([
        {
          scope,
          ...(folder !== undefined ? { folder } : {}),
          path: 'dimfactory.json',
          backupId: 'b1',
          diff: '',
        },
      ]),
    ),
    grant: vi.fn<RecoveryConfigDeps['grant']>(() => Promise.resolve()),
  }
  const deps: ExecuteDeps = {
    run: {
      ...run,
      skipPass: () => Promise.resolve(),
      closeRun: () => Promise.resolve(),
      resumeRun: () => Promise.resolve(),
    },
    config: { ...config, managedFlags: () => ({ claude: ['--model', '--permission-mode'] }) },
    ...(o.vendors !== undefined ? { vendors: o.vendors } : {}),
    healCheck: () =>
      Promise.resolve({ status: 'ok', trigger: 'user', at: 0, actions: [], hidden: 0, diagnosis: 'Log in.' }),
  }
  return { run, config, deps }
}

const snag = (
  action: RecoveryAction,
  step: StepKey = 'implement',
  st = state({ failed: [step] }),
): FoundAction => ({
  action,
  source: { kind: 'snag', runId: RUN, step },
  state: st,
})
const atFolder = (action: RecoveryAction): FoundAction => ({
  action,
  source: { kind: 'folder', folder: FOLDER, checkId: 'x' },
})

async function err(p: Promise<unknown>): Promise<DimFactoryError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  if (!(e instanceof DimFactoryError)) throw new Error(`expected a DimFactoryError, got ${String(e)}`)
  return e
}

const patch = (o: Partial<Extract<RecoveryAction, { kind: 'config_patch' }>> = {}): RecoveryAction => ({
  id: 'implement:default-model',
  label: "Use Claude's default model",
  kind: 'config_patch',
  target: 'resolved',
  ops: [{ op: 'replace', path: '/passes/implement/model', value: null }],
  preview: '',
  ...o,
})

describe('config_patch', () => {
  it("a run's snag: P22 on the failed pass with the checked ops", async () => {
    const m = mocks()
    const r = await executeAction(snag(patch()), m.deps)
    expect(r).toEqual({ kind: 'config_patch', message: 'Applied. Retrying Implement.' })
    expect(m.run.applyConfigPatch).toHaveBeenCalledWith(RUN, {
      ops: [{ op: 'replace', path: '/passes/implement/model', value: null }],
      label: "Use Claude's default model",
      actionId: 'implement:default-model',
      step: 'implement',
    })
  })

  it('forbidden ops never reach the run or a file (whatever offered them)', async () => {
    const m = mocks()
    for (const ops of [
      [{ op: 'replace' as const, path: '/vendors/claude/path', value: 'x.exe' }],
      [{ op: 'replace' as const, path: '/passes/implement/mode', value: 'full' }],
      [{ op: 'replace' as const, path: '/auto', value: true }],
      [{ op: 'add' as const, path: '/vendors/claude/extraArgs/-', value: '--model=opus' }],
    ]) {
      const e = await err(executeAction(snag(patch({ ops, persist: { scope: 'user' } })), m.deps))
      expect(e.code).toBe('FORBIDDEN')
    }
    expect(m.run.applyConfigPatch).not.toHaveBeenCalled()
    expect(m.config.persist).not.toHaveBeenCalled()
  })

  it("a preflight card's fix changes the run's config, then rechecks", async () => {
    const m = mocks()
    const card = {
      view: {
        id: 'preflight-1',
        kind: 'preflight',
        title: '',
        body: '',
        payload: {},
        blocking: true,
        choices: [],
      },
      step: 'preflight',
      openedAt: 0,
    } as unknown as RunState['cards'][number]
    const found: FoundAction = {
      action: patch({ ops: [{ op: 'replace', path: '/timeouts/askMs', value: 120_000 }] }),
      source: { kind: 'card', runId: RUN, cardId: 'preflight-1', step: 'preflight' },
      state: state({ cards: [card] }),
    }
    const r = await executeAction(found, m.deps)
    expect(r.message).toBe('Applied to this run. Checking again.')
    expect(m.run.applyConfigPatch.mock.calls[0]?.[1]).not.toHaveProperty('step')
    expect(m.run.resolveCard).toHaveBeenCalledWith(RUN, 'preflight-1', 'recheck')
  })

  it("the composer's runOverrides come back to apply; a resolved patch outside a run is refused", async () => {
    const m = mocks()
    const off = patch({ target: 'runOverrides', ops: [{ op: 'add', path: '/auto', value: false }] })
    expect(await executeAction(atFolder(off), m.deps)).toEqual({
      kind: 'config_patch',
      overrides: [{ op: 'add', path: '/auto', value: false }],
      message: 'Changed for this run.',
    })
    expect((await err(executeAction(atFolder(patch()), m.deps))).code).toBe('VALIDATION')
    // A setting a run cannot override needs `persist`.
    const timeouts = patch({
      target: 'runOverrides',
      ops: [{ op: 'replace', path: '/timeouts/askMs', value: 120_000 }],
    })
    expect((await err(executeAction(atFolder(timeouts), m.deps))).code).toBe('VALIDATION')
    const saved = await executeAction(
      atFolder({ ...timeouts, persist: { scope: 'project' } } as RecoveryAction),
      m.deps,
    )
    expect(saved.overrides).toBeUndefined()
    expect(m.config.persist).toHaveBeenCalledWith('project', FOLDER, [
      { op: 'replace', path: '/timeouts/askMs', value: 120_000 },
    ])
    expect(saved.persisted).toEqual([
      { scope: 'project', folder: FOLDER, path: 'dimfactory.json', backupId: 'b1', diff: '' },
    ])
    expect(m.run.applyConfigPatch).not.toHaveBeenCalled()
  })

  it('persist from a run writes the same ops to the settings too', async () => {
    const m = mocks()
    const r = await executeAction(snag(patch({ persist: { scope: 'user' } })), m.deps)
    expect(m.config.persist).toHaveBeenCalledWith('user', FOLDER, [
      { op: 'replace', path: '/passes/implement/model', value: null },
    ])
    expect(r.message).toBe('Applied. Retrying Implement. Saved to your user settings.')
  })
})

describe('switch_vendor', () => {
  const action: RecoveryAction = {
    id: 'implement:switch',
    label: 'Use Codex instead',
    kind: 'switch_vendor',
    pass: 'implement',
    to: 'codex',
    model: null,
  }

  it('readiness is checked again at the click: unbuilt is UNSUPPORTED, not ready is CONFLICT', async () => {
    const unbuilt = mocks({
      vendors: {
        vendors: () => [{ id: 'codex', displayName: 'Codex', built: false }],
        readyFor: () => ({ ok: true }),
      },
    })
    expect(await err(executeAction(snag(action), unbuilt.deps))).toMatchObject({
      code: 'UNSUPPORTED',
      message: 'Codex is not available in this build.',
    })
    const notReady = mocks({
      vendors: {
        vendors: () => [{ id: 'codex', displayName: 'Codex', built: true }],
        readyFor: () => ({ ok: false, reason: 'Codex is not ready: Login needed.' }),
      },
    })
    expect(await err(executeAction(snag(action), notReady.deps))).toMatchObject({
      code: 'CONFLICT',
      message: 'Codex is not ready: Login needed.',
    })
    expect(unbuilt.run.applyConfigPatch).not.toHaveBeenCalled()
    expect(notReady.run.applyConfigPatch).not.toHaveBeenCalled()
    // A core without readiness answers with the action's own reason.
    const none = mocks()
    expect(
      await err(
        executeAction(
          snag({ ...action, disabledReason: 'Codex is not available in this build.' }),
          none.deps,
        ),
      ),
    ).toMatchObject({ code: 'UNSUPPORTED', message: 'Codex is not available in this build.' })
  })

  it('a ready vendor: the pass switches through P22 (vendor and model) and retries', async () => {
    const readyFor = vi.fn<VendorReadiness['readyFor']>(() => ({ ok: true }))
    const m = mocks({
      vendors: { vendors: () => [{ id: 'codex', displayName: 'Codex', built: true }], readyFor },
    })
    expect(await executeAction(snag(action), m.deps)).toEqual({
      kind: 'switch_vendor',
      message: 'Switched to Codex. Retrying Implement.',
    })
    expect(readyFor).toHaveBeenCalledWith('codex', 'implement', 'autoedit')
    expect(m.run.applyConfigPatch).toHaveBeenCalledWith(RUN, {
      ops: [
        { op: 'replace', path: '/passes/implement/vendor', value: 'codex' },
        { op: 'replace', path: '/passes/implement/model', value: null },
        // Claude's effort levels are not Codex's: the pass runs at Codex's default effort.
        { op: 'replace', path: '/passes/implement/effort', value: null },
      ],
      label: 'Use Codex instead',
      step: 'implement',
      actionId: 'implement:switch',
    })
  })
})

describe('grant', () => {
  const grant = (o: Partial<Extract<RecoveryAction, { kind: 'grant' }>>): RecoveryAction => ({
    id: 'g',
    label: 'Allow',
    kind: 'grant',
    grant: 'largeFolder',
    detail: '',
    ...o,
  })

  it('largeFolder, projectAuto (with the version shown) and command write trust.json for the folder', async () => {
    const m = mocks()
    expect(await executeAction(atFolder(grant({})), m.deps)).toEqual({
      kind: 'grant',
      message: 'Allowed. Re-check to continue.',
    })
    expect(m.config.grant).toHaveBeenLastCalledWith(FOLDER, { kind: 'largeFolder' }, undefined)
    const sha = 'a'.repeat(64)
    await executeAction(atFolder(grant({ grant: 'projectAuto', projectSha: sha })), m.deps)
    expect(m.config.grant).toHaveBeenLastCalledWith(
      FOLDER,
      { kind: 'projectAuto', projectSha: sha },
      undefined,
    )
    await executeAction(
      atFolder(
        grant({
          grant: 'command',
          command: { kind: 'verify', argv: ['npm', 'test'], cwdRel: '.', body: 'vitest' },
        }),
      ),
      m.deps,
    )
    expect(m.config.grant).toHaveBeenLastCalledWith(
      FOLDER,
      { kind: 'command', command: { kind: 'verify', argv: ['npm', 'test'], cwdRel: '.' } },
      'vitest',
    )
    expect((await err(executeAction(atFolder(grant({ grant: 'command' })), m.deps))).code).toBe('VALIDATION')
  })

  it('a snag grant retries the pass ("grant → retry"); vendorFolder too, since Gemini', async () => {
    const m = mocks()
    expect(await executeAction(snag(grant({})), m.deps)).toEqual({
      kind: 'grant',
      message: 'Allowed. Retrying Implement.',
    })
    expect(m.config.grant).toHaveBeenCalledWith(FOLDER, { kind: 'largeFolder' }, undefined)
    expect(m.run.retryPass).toHaveBeenCalledWith(RUN, 'implement', 'auto')
    // The vendorFolder grant writes trust.json for the folder and retries the pass the same way.
    const vf = await executeAction(snag(grant({ grant: 'vendorFolder', vendor: 'gemini' })), m.deps)
    expect(vf.message).not.toContain(LATER_VERSION_MESSAGE)
    expect(vf.message).toMatch(/Retrying Implement.$/)
    expect(m.config.grant).toHaveBeenLastCalledWith(FOLDER, { kind: 'vendorFolder', vendor: 'gemini' })
    expect(m.run.retryPass).toHaveBeenLastCalledWith(RUN, 'implement', 'auto')
    // An app-scope fix has no folder.
    const app = await err(
      executeAction({ action: grant({}), source: { kind: 'app', checkId: 'app.git' } }, m.deps),
    )
    expect(app.code).toBe('VALIDATION')
  })
})

describe('wait_until and heal', () => {
  const wait: RecoveryAction = {
    id: 'implement:wait',
    label: 'Retry at 14:05',
    kind: 'wait_until',
    until: 5,
    armed: true,
  }

  it("wait_until toggles the run's wait and answers it as it is now", async () => {
    const armed = mocks({ wait: { actionId: 'implement:wait', until: 5, armed: true } })
    expect(await executeAction(snag(wait), armed.deps)).toEqual({
      kind: 'wait_until',
      wait: { actionId: 'implement:wait', until: 5, armed: true },
      message: 'Dim Factory retries Implement when the wait is over.',
    })
    expect(armed.run.toggleWait).toHaveBeenCalledWith(RUN, 'implement')
    const off = mocks({ wait: { actionId: 'implement:wait', until: 5, armed: false, disarmed: 'user' } })
    expect((await executeAction(snag(wait), off.deps)).message).toBe(
      'Stopped waiting. Retry Implement when you are ready.',
    )
    const now = mocks({ wait: undefined })
    expect((await executeAction(snag(wait), now.deps)).message).toBe('Retrying Implement now.')
    expect((await err(executeAction(atFolder(wait), now.deps))).code).toBe('VALIDATION')
  })

  it("heal: a run's failed pass asks its controller; a check outside a run answers the outcome", async () => {
    const m = mocks()
    const heal: RecoveryAction = { id: 'implement:heal', label: 'Diagnose with AI', kind: 'heal' }
    expect(await executeAction(snag(heal), m.deps)).toEqual({
      kind: 'heal',
      message: 'Diagnosing with AI. This can take up to 90 seconds.',
    })
    expect(m.run.heal).toHaveBeenCalledWith(RUN, 'implement')
    const r = await executeAction(
      { action: heal, source: { kind: 'vendor', vendor: 'claude', checkId: 'vendor.claude.auth' } },
      m.deps,
    )
    expect(r).toMatchObject({
      kind: 'heal',
      message: 'Log in.',
      heal: { status: 'ok', diagnosis: 'Log in.' },
    })
  })

  it("findAction finds a snag's AI suggestions while the snag is open", async () => {
    const suggestion: RecoveryAction = {
      id: 'implement:heal-1',
      label: 'Rename the flag',
      kind: 'config_patch',
      target: 'resolved',
      ops: [{ op: 'add', path: '/vendors/claude/flagMap/--model', value: '--model-name' }],
      preview: '',
    }
    const deps = (st: RunState): LookupDeps => ({
      runState: () => Promise.resolve(st),
      snagActions: () => Promise.resolve(new Map<StepKey, RecoveryAction[]>([['implement', []]])),
      store: new RecoveryActionStore(),
      vendorChecks: () => [],
    })
    const hit = await findAction(
      { actionId: 'implement:heal-1', runId: RUN },
      deps(state({ failed: ['implement'], heal: [suggestion] })),
    )
    expect(hit.action).toEqual(suggestion)
    expect(hit.source).toEqual({ kind: 'snag', runId: RUN, step: 'implement' })
    const closed = state({ failed: [], heal: [suggestion] })
    await expect(
      findAction({ actionId: 'implement:heal-1', runId: RUN }, deps(closed)),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('RecoveryActionStore', () => {
  it("keeps a check's facts with its actions, and a run-less diagnosis's fixes where the check was", () => {
    const store = new RecoveryActionStore()
    const fix: RecoveryAction = { id: 'vendor.claude.login', label: 'Log in', kind: 'close_run' }
    store.record(FOLDER, {
      mode: 'live',
      ok: false,
      blocking: [
        {
          id: 'vendor.claude.auth',
          scope: 'vendor',
          status: 'fail',
          blocking: true,
          category: 'auth_required',
          title: 'Claude is not logged in',
          detail: 'Run claude auth login.',
          recovery: [fix],
          at: 0,
          ttlMs: 0,
        },
      ],
      warnings: [],
      info: [],
    })
    expect(store.global('vendor.claude.login')?.check).toEqual({
      title: 'Claude is not logged in',
      detail: 'Run claude auth login.',
      category: 'auth_required',
    })
    const suggestion: RecoveryAction = {
      id: 'probe:heal-1',
      label: 'Docs',
      kind: 'open_docs',
      url: 'https://claude.com',
    }
    store.addSuggested(undefined, { checkId: 'vendor.claude.auth', scope: 'vendor' }, [suggestion])
    expect(store.global('probe:heal-1')?.action).toEqual(suggestion)
    store.addSuggested(FOLDER, { checkId: 'folder.git', scope: 'folder' }, [
      { ...suggestion, id: 'probe:heal-2' },
    ])
    expect(store.folder(FOLDER, 'probe:heal-2')?.checkId).toBe('folder.git')
  })
})
