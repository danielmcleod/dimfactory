// recovery.execute's lookup and executors (src/core/recovery/dispatcher.ts; recovery actions and their
// executors): an action runs only when it is found where the UI got it (a run's open snags and open cards, the
// folder's latest preflight report, the app/vendor checks); shell_copy / settings_link / open_docs, and
// retry / skip_pass / close_run / resume through the run commands, are here; the rest is in tests/unit/self-heal, except
// vendor_setup (tests/unit/balanced/engine) and the vendorFolder grant (tests/unit/gemini/engine/grant-executor.test.ts).
import { describe, expect, it, vi } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { StepKey } from '@shared/run.ts'
import { DimFactoryError } from '@core/errors.ts'
import {
  LATER_KINDS,
  LATER_VERSION_MESSAGE,
  STALE_ACTION_MESSAGE,
  executeAction,
  findAction,
  payloadActions,
} from '@core/recovery/dispatcher.ts'
import type { ExecuteDeps, FoundAction, LookupDeps } from '@core/recovery/dispatcher.ts'
import { settingsHref } from '@core/recovery/routes.ts'
import { RecoveryActionStore } from '@core/recovery/store.ts'
import type { RunState } from '@core/supervisor/types.ts'

const RUN = '20261006T120000Z-ab12'
const FOLDER = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'

const login: RecoveryAction = {
  id: 'claude.login',
  label: 'Copy the login command',
  kind: 'shell_copy',
  command: 'claude auth login',
  shell: 'powershell',
  reason: 'Claude Code is not logged in',
  recheck: 'vendor.claude.auth',
}
const retry: RecoveryAction = { id: 'plan:retry', label: 'Retry', kind: 'retry', strategy: 'auto' }
const skip: RecoveryAction = {
  id: 'review:skip',
  label: 'Continue without Review',
  kind: 'skip_pass',
  pass: 'review',
}
const close: RecoveryAction = { id: 'run:close', label: 'Close run', kind: 'close_run' }

const result = (id: string, scope: CheckResult['scope'], recovery: RecoveryAction[]): CheckResult => ({
  id,
  scope,
  status: 'fail',
  blocking: true,
  title: id,
  detail: '',
  recovery,
  at: 0,
  ttlMs: 0,
})

const report = (...blocking: CheckResult[]): PreflightReport => ({
  mode: 'live',
  ok: blocking.length === 0,
  blocking,
  warnings: [],
  info: [],
})

/** A run state with the given steps' snags open (status failed) and cards open. */
function state(o: { snags?: StepKey[]; paused?: StepKey[]; cards?: RunState['cards'] } = {}): RunState {
  const steps: Record<string, { snagOpen: boolean; status: string }> = {}
  for (const k of ['preflight', 'plan', 'implement', 'review', 'critic', 'fix'] as const) {
    steps[k] = {
      snagOpen: o.snags?.includes(k) === true,
      status: o.snags?.includes(k) === true ? 'failed' : o.paused?.includes(k) === true ? 'paused' : 'queued',
    }
  }
  return { runId: RUN, steps, cards: o.cards ?? [] } as unknown as RunState
}

function deps(o: {
  run?: RunState | null
  snags?: Partial<Record<StepKey, RecoveryAction[]>>
  store?: RecoveryActionStore
  vendorChecks?: { vendor: string; checks: CheckResult[] }[]
}): LookupDeps & { snagReads: number } {
  const d = {
    snagReads: 0,
    runState: (runId: string) => Promise.resolve(runId === RUN ? (o.run ?? null) : null),
    snagActions: () => {
      d.snagReads++
      return Promise.resolve(new Map(Object.entries(o.snags ?? {})) as Map<StepKey, RecoveryAction[]>)
    },
    store: o.store ?? new RecoveryActionStore(),
    vendorChecks: () => o.vendorChecks ?? [],
  }
  return d
}

async function err(p: Promise<unknown>): Promise<DimFactoryError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  if (!(e instanceof DimFactoryError)) throw new Error(`expected a DimFactoryError, got ${String(e)}`)
  return e
}

describe('findAction', () => {
  it('finds a run action in its open snag, and only while the snag is open', async () => {
    const d = deps({ run: state({ snags: ['plan'] }), snags: { plan: [login, retry, close] } })
    const hit = await findAction({ actionId: 'plan:retry', runId: RUN }, d)
    expect(hit.action).toEqual(retry)
    expect(hit.source).toEqual({ kind: 'snag', runId: RUN, step: 'plan' })

    const resolved = deps({ run: state(), snags: { plan: [login, retry, close] } })
    const e = await err(findAction({ actionId: 'plan:retry', runId: RUN }, resolved))
    expect(e.code).toBe('NOT_FOUND')
    expect(e.message).toBe(STALE_ACTION_MESSAGE)
    // No snag open: the event log is not even read.
    expect(resolved.snagReads).toBe(0)
  })

  it("finds a fix in an open card's payload (the run's preflight card)", async () => {
    const card = {
      view: {
        id: 'preflight-1',
        kind: 'preflight',
        title: 'Claude Code is not logged in',
        body: '',
        payload: { blocking: [result('vendor.claude.auth', 'vendor', [login])], warnings: [] },
        blocking: true,
        choices: [{ id: 'recheck', label: 'Recheck' }],
      },
      step: 'preflight',
      openedAt: 0,
    } as RunState['cards'][number]
    const d = deps({ run: state({ cards: [card] }) })
    const hit = await findAction({ actionId: 'claude.login', runId: RUN }, d)
    expect(hit.source).toEqual({ kind: 'card', runId: RUN, cardId: 'preflight-1', step: 'preflight' })
    // A card choice is not a recovery action.
    await expect(findAction({ actionId: 'recheck', runId: RUN }, d)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('an unknown run is NOT_FOUND by name', async () => {
    const e = await err(findAction({ actionId: 'run:close', runId: 'nope' }, deps({ run: null })))
    expect(e).toMatchObject({ code: 'NOT_FOUND', message: 'Run nope not found.' })
  })

  it("finds a folder's action in its latest report; a newer report replaces it", async () => {
    const store = new RecoveryActionStore()
    const gitFix: RecoveryAction = {
      ...login,
      id: 'folder.git.abort',
      command: 'git merge --abort',
      recheck: 'folder.git',
    }
    store.record(FOLDER, report(result('folder.git', 'folder', [gitFix])))
    const d = deps({ store })
    const hit = await findAction({ actionId: 'folder.git.abort', folder: FOLDER }, d)
    expect(hit.source).toEqual({ kind: 'folder', folder: FOLDER, checkId: 'folder.git' })
    // Folder keys fold case where the file system does.
    if (process.platform === 'win32') {
      await expect(
        findAction({ actionId: 'folder.git.abort', folder: FOLDER.toUpperCase() }, d),
      ).resolves.toBeDefined()
    }
    store.record(FOLDER, report())
    await expect(findAction({ actionId: 'folder.git.abort', folder: FOLDER }, d)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: STALE_ACTION_MESSAGE,
    })
  })

  it("a folder action is not found from another folder; the latest report's app/vendor actions are global", async () => {
    const store = new RecoveryActionStore()
    const install: RecoveryAction = {
      ...login,
      id: 'app.git.install',
      command: 'winget install --id Git.Git -e',
      recheck: 'app.git',
    }
    const abort: RecoveryAction = {
      ...login,
      id: 'folder.git.abort',
      command: 'git merge --abort',
      recheck: 'folder.git',
    }
    store.record(
      FOLDER,
      report(
        result('app.git', 'app', [install]),
        result('vendor.claude.auth', 'vendor', [login]),
        result('folder.git', 'folder', [abort]),
      ),
    )
    const d = deps({ store })
    const other = `${FOLDER}-other`
    await expect(findAction({ actionId: 'folder.git.abort', folder: other }, d)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect((await findAction({ actionId: 'app.git.install', folder: other }, d)).source).toEqual({
      kind: 'app',
      checkId: 'app.git',
    })
    expect((await findAction({ actionId: 'claude.login' }, d)).source).toEqual({
      kind: 'vendor',
      vendor: 'claude',
      checkId: 'vendor.claude.auth',
    })
  })

  it('finds a vendor fix in the launch-probe store with no run or folder (Settings → Vendors, setup card)', async () => {
    const d = deps({
      vendorChecks: [{ vendor: 'claude', checks: [result('vendor.claude.auth', 'vendor', [login])] }],
    })
    const hit = await findAction({ actionId: 'claude.login' }, d)
    expect(hit.source).toEqual({ kind: 'vendor', vendor: 'claude', checkId: 'vendor.claude.auth' })
    await expect(findAction({ actionId: 'claude.install' }, d)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('runId and folder: the run first, then the folder', async () => {
    const store = new RecoveryActionStore()
    store.record(FOLDER, report(result('vendor.claude.auth', 'vendor', [login])))
    const d = deps({ run: state({ snags: ['plan'] }), snags: { plan: [retry] }, store })
    expect((await findAction({ actionId: 'plan:retry', runId: RUN, folder: FOLDER }, d)).source.kind).toBe(
      'snag',
    )
    expect((await findAction({ actionId: 'claude.login', runId: RUN, folder: FOLDER }, d)).source.kind).toBe(
      'folder',
    )
    // A run alone does not fall back to the global store.
    await expect(findAction({ actionId: 'claude.login', runId: RUN }, d)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('payloadActions finds actions nested in a payload and nothing else', () => {
    expect(
      payloadActions({ blocking: [{ recovery: [login, { id: 'x', label: 'y', kind: 'bogus' }] }], n: 1 }),
    ).toEqual([login])
  })
})

describe('executeAction', () => {
  /** Run commands as plain mock functions (asserted directly, never called with `this`). */
  interface RunMocks {
    retryPass: ReturnType<typeof vi.fn<ExecuteDeps['run']['retryPass']>>
    skipPass: ReturnType<typeof vi.fn<ExecuteDeps['run']['skipPass']>>
    closeRun: ReturnType<typeof vi.fn<ExecuteDeps['run']['closeRun']>>
    resumeRun: ReturnType<typeof vi.fn<ExecuteDeps['run']['resumeRun']>>
  }
  const run = (): RunMocks => ({
    retryPass: vi.fn<ExecuteDeps['run']['retryPass']>(() => Promise.resolve()),
    skipPass: vi.fn<ExecuteDeps['run']['skipPass']>(() => Promise.resolve()),
    closeRun: vi.fn<ExecuteDeps['run']['closeRun']>(() => Promise.resolve()),
    resumeRun: vi.fn<ExecuteDeps['run']['resumeRun']>(() => Promise.resolve()),
  })
  const snag = (
    action: RecoveryAction,
    step: StepKey = 'plan',
    st = state({ snags: [step] }),
  ): FoundAction => ({
    action,
    source: { kind: 'snag', runId: RUN, step },
    state: st,
  })
  const atFolder = (action: RecoveryAction): FoundAction => ({
    action,
    source: { kind: 'folder', folder: FOLDER, checkId: 'x' },
  })

  it('shell_copy answers the command to copy, never runs it, and marks its check for a re-check', async () => {
    const awaitRecheck = vi.fn()
    const r = await executeAction(atFolder(login), { run: run(), awaitRecheck })
    expect(r).toEqual({
      kind: 'shell_copy',
      copied: 'claude auth login',
      message: 'Copied. Run it in a terminal, then re-check.',
    })
    expect(awaitRecheck).toHaveBeenCalledWith('vendor.claude.auth')
    const elevated = await executeAction(atFolder({ ...login, elevated: true }), { run: run() })
    expect(elevated.message).toBe('Copied. Run it in an administrator terminal, then re-check.')
  })

  it('settings_link answers the renderer route', async () => {
    const link: RecoveryAction = {
      id: 'claude.set-path',
      label: 'Set the Claude Code path',
      kind: 'settings_link',
      route: 'settings/vendors',
      pointer: '/vendors/claude/path',
    }
    expect(await executeAction(atFolder(link), { run: run() })).toEqual({
      kind: 'settings_link',
      route: '#/settings/vendors?field=%2Fvendors%2Fclaude%2Fpath',
    })
    expect(settingsHref('composer', '/folder')).toBe('#/?field=%2Ffolder')
    expect(settingsHref('settings/storage', '')).toBe('#/settings/storage')
    expect(() => settingsHref('../../etc', '/x')).toThrow(DimFactoryError)
    expect(() => settingsHref('settings/vendors', 'path')).toThrow(DimFactoryError)
    expect(() => settingsHref('runs/x', '/x')).toThrow(DimFactoryError)
  })

  it('open_docs answers an allowlisted https URL, and refuses anything else', async () => {
    const docs: RecoveryAction = {
      id: 'claude.docs',
      label: 'Open the setup guide',
      kind: 'open_docs',
      url: 'https://code.claude.com/docs/en/setup',
    }
    expect(await executeAction(atFolder(docs), { run: run() })).toEqual({
      kind: 'open_docs',
      url: 'https://code.claude.com/docs/en/setup',
      message: 'Opening https://code.claude.com/docs/en/setup in your browser.',
    })
    for (const url of [
      'http://code.claude.com/docs',
      'https://evil.example/docs',
      'file:///C:/x',
      'javascript:1',
    ]) {
      const e = await err(executeAction(atFolder({ ...docs, url }), { run: run() }))
      expect(e).toMatchObject({
        code: 'VALIDATION',
        message: 'Only https links to known documentation sites open.',
      })
    }
  })

  it('retry / skip_pass / close_run go through the run commands', async () => {
    const r = run()
    expect(await executeAction(snag(retry), { run: r })).toMatchObject({
      kind: 'retry',
      message: 'Retrying Plan.',
    })
    expect(r.retryPass).toHaveBeenCalledWith(RUN, 'plan', 'auto')
    const resumeRetry: RecoveryAction = {
      id: 'implement:resume',
      label: 'Resume',
      kind: 'retry',
      strategy: 'resume',
    }
    await executeAction(snag(resumeRetry, 'implement'), { run: r })
    expect(r.retryPass).toHaveBeenLastCalledWith(RUN, 'implement', 'resume')
    expect(await executeAction(snag(skip, 'review'), { run: r })).toMatchObject({
      kind: 'skip_pass',
      message: 'Continuing without Review.',
    })
    expect(r.skipPass).toHaveBeenCalledWith(RUN, 'review')
    expect(await executeAction(snag(close), { run: r })).toEqual({
      kind: 'close_run',
      message: 'Run closed.',
    })
    expect(r.closeRun).toHaveBeenCalledWith(RUN)
  })

  it('a run-level fix outside a run, or a retry of a step that is not a pass, is refused', async () => {
    const r = run()
    await expect(executeAction(atFolder(retry), { run: r })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(executeAction(atFolder(close), { run: r })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(executeAction(snag(retry, 'preflight'), { run: r })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Only a failed pass can be retried.',
    })
    expect(r.retryPass).not.toHaveBeenCalled()
    expect(r.closeRun).not.toHaveBeenCalled()
  })

  it('resume: a paused run resumes; a failed pass resumes its session through a resume retry', async () => {
    const resume: RecoveryAction = {
      id: 'implement:continue',
      label: 'Continue',
      kind: 'resume',
      continuation: 'continue',
    }
    const r = run()
    await executeAction(snag(resume, 'implement', state({ paused: ['implement'] })), { run: r })
    expect(r.resumeRun).toHaveBeenCalledWith(RUN)
    await executeAction(snag(resume, 'implement'), { run: r })
    // The action's own continuation goes with the resume retry.
    expect(r.retryPass).toHaveBeenCalledWith(RUN, 'implement', 'resume', 'continue')
  })

  it('no kind is left for a later version; a core without the executor host still answers UNSUPPORTED', async () => {
    // config_patch, switch_vendor, grant, wait_until and heal are tested in tests/unit/self-heal; vendor_setup with
    // Codex (tests/unit/balanced/engine/vendor-setup.test.ts) and the vendorFolder grant with Gemini (
    // tests/unit/gemini/engine/grant-executor.test.ts). A core without the trust store cannot write the grant.
    const actions: RecoveryAction[] = [
      { id: 'd', label: 'd', kind: 'grant', grant: 'vendorFolder', vendor: 'gemini', detail: '' },
    ]
    expect(LATER_KINDS).toEqual([])
    const r = run()
    for (const a of actions) {
      const e = await err(executeAction(snag(a), { run: r }))
      expect(e).toMatchObject({ code: 'UNSUPPORTED', message: 'Trust grants are not available here.' })
      expect(e.message).not.toBe(LATER_VERSION_MESSAGE)
    }
    // vendor_setup is built; a core without its executor (no vendor setup host) still answers UNSUPPORTED.
    const setup: RecoveryAction = {
      id: 'b',
      label: 'b',
      kind: 'vendor_setup',
      vendor: 'codex',
      call: 'windowsSandbox/setupStart',
      params: {},
    }
    expect((await err(executeAction(snag(setup), { run: r }))).code).toBe('UNSUPPORTED')
    for (const f of [r.retryPass, r.skipPass, r.closeRun, r.resumeRun]) expect(f).not.toHaveBeenCalled()
  })
})
