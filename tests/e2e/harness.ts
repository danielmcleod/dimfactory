// E2E harness (the E2E layer: the scenarios and the flows): every test gets its own temp root holding an
// isolated DIM_FACTORY_HOME whose user dimfactory.json points `vendors.claude` at the fake Claude launcher (the .cmd
// shim or shebang copy, run by the system node — never ELECTRON_RUN_AS_NODE), a fake scenario and a git sandbox.
// The app runs with DIM_FACTORY_E2E=1 and DIM_FACTORY_E2E_VENDOR_SEARCH=configured (vendor CLIs are looked up only at
// their configured paths, so no test ever finds or runs a real Claude, Codex, Gemini, Grok or Muse; a vendor without its
// options reads "not installed"). `codex` points `vendors.codex` at the fake Codex
// (codex-helpers.ts FakeCodex), `gemini` `vendors.gemini` at the fake Gemini (gemini-helpers.ts FakeGemini), `grok` and
// `muse` `vendors.grok` / `vendors.muse` at the fake Grok and Muse (grok-muse-helpers.ts). The app's own CODEX_HOME,
// GEMINI_CLI_HOME and GROK_HOME are folders inside the root (never ~/.codex, ~/.gemini or ~/.grok). The `e2e` fixture
// closes the app (gracefully, then by killing its process tree) and deletes the root even when the test fails.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { _electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import type { Cmd, E2EState, InvokeArgs, Res, Result } from '../../src/shared/ipc.ts'
import type { RunSnapshot, RunSummary, StepKey } from '../../src/shared/run.ts'
import { readFakeLog } from '../fake-cli/harness.ts'
import type { FakeLogEntry } from '../fake-cli/harness.ts'
import {
  REPO_ROOT,
  fakeClaudePath,
  hermeticEnv,
  makeSandbox,
  makeScenario,
} from '../integration/run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'
import { FakeCodex, fakeCodexPath } from './codex-helpers.ts'
import type { CodexFakeState } from './codex-helpers.ts'
import { FakeGemini, fakeGeminiPath } from './gemini-helpers.ts'
import type { GeminiFakeState } from './gemini-helpers.ts'
import { FakeGrok, FakeMuse, fakeGrokPath, fakeMusePath } from './grok-muse-helpers.ts'
import type { GrokFakeState, MuseFakeState } from './grok-muse-helpers.ts'

export { expect }

const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')
/** Electron start plus the first window on a machine where every process start costs about a second. */
const LAUNCH_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 20_000

export interface StartOptions {
  /** The fake Claude scenario (default: the plan, then NO FINDINGS reviewers; see makeScenario). */
  scenario?: ScenarioSpec
  /** Rewrite the scenario's scripts after makeScenario wrote them (long or slow streams). */
  editScenario?: (sc: Scenario) => void
  /** Extra user dimfactory.json keys (merged over the harness's profile, the pipeline and vendors). */
  config?: Record<string, unknown>
  /**
   * `full` (the default): the pipeline the specs drive (Thorough: Plan, its gate, two reviewers; Implement starting its
   * own session; every finding sent to Fix). `defaults`: the shipped defaults (adaptive depth, continuity, quieter
   * reviews), for their own specs.
   */
  pipeline?: 'full' | 'defaults'
  /** DIM_FACTORY_E2E_TIME_SCALE. */
  timeScale?: number
  /** DIM_FACTORY_E2E_PICK_FOLDER = the sandbox. */
  pickSandbox?: boolean
  /** Sandbox as a git repo (default true). */
  git?: boolean
  /**
   * The catalog's last refresh the home starts with (state.json `catalog.lastRefreshAt`, wall-clock ms). Default:
   * now, so no test meets a price refresh the calendar made due (the shipped prices' date plus 14 days); catalog.spec.ts moves
   * e2e.clock past it. null writes nothing (a fresh home). A state.json the test wrote before start is kept.
   */
  catalogLastRefreshAt?: number | null
  /** A fake Codex at `vendors.codex.path` with this state (default: no Codex, "not installed"). */
  codex?: Partial<CodexFakeState>
  /** A fake Gemini at `vendors.gemini.path` with this state (default: no Gemini, "not installed"). */
  gemini?: Partial<GeminiFakeState>
  /** A fake Grok at `vendors.grok.path` with this state (default: no Grok, "not installed"). */
  grok?: Partial<GrokFakeState>
  /** A fake Muse at `vendors.muse.path` with this state (default: no Muse, "not installed"). */
  muse?: Partial<MuseFakeState>
  /**
   * DIM_FACTORY_E2E_NEW_USER: the home counts as a new user's although the harness wrote its user file (Easy mode's
   * first-launch question). Default: an existing user's, as every other test expects.
   */
  newUser?: boolean
  /** DIM_FACTORY_E2E_PICK_FILES: dialog.pickFiles answers these absolute paths (Easy's Add files). */
  pickFiles?: string[]
  /** DIM_FACTORY_GROUNDING: run the grounding checks after each pass (default off: see the env below). */
  grounding?: boolean
  /**
   * More environment for the app (DIM_FACTORY_E2E_NODE: which Node.js Easy sees; DIM_FACTORY_E2E_DOCUMENTS: the
   * Documents folder). Applied after the harness's own.
   */
  env?: Record<string, string>
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

/** The user file with the pipeline the spec asked for under its own keys (its `passes` merged per pass). */
function withPipeline(pipeline: 'full' | 'defaults', cfg: Record<string, unknown>): Record<string, unknown> {
  if (pipeline === 'defaults') return cfg
  const own = (cfg['passes'] ?? {}) as Record<string, Record<string, unknown> | undefined>
  return {
    depth: 'full',
    ...cfg,
    passes: {
      ...own,
      implement: { continuePlan: false, ...own['implement'] },
      fix: { trigger: 'all', ...own['fix'] },
    },
  }
}

type Invoke = <C extends Cmd>(cmd: C, ...args: InvokeArgs<C>) => Promise<Result<Res<C>>>

export class E2EHarness {
  readonly root = mkdtempSync(join(tmpdir(), 'dim-factory-e2e-'))
  readonly home = join(this.root, 'home')
  /**
   * The app's user home for Grok's read-only allow-rules scan (DIM_FACTORY_E2E_USER_HOME), empty unless a
   * test writes Claude or Grok settings into it.
   */
  readonly userHome = join(this.root, 'user-home-app')
  sandbox = ''
  scenario: Scenario | null = null
  /** The fake Codex, when the test asked for one. */
  codex: FakeCodex | null = null
  /** The fake Gemini, when the test asked for one. */
  gemini: FakeGemini | null = null
  /** The fake Grok and the fake Muse, when the test asked for them. */
  grok: FakeGrok | null = null
  muse: FakeMuse | null = null
  app: ElectronApplication | null = null
  page: Page | null = null
  /** Console errors and uncaught page errors of every launch, in order. */
  readonly pageErrors: string[] = []
  #env: Record<string, string | undefined> = {}
  readonly #info: TestInfo

  constructor(info: TestInfo) {
    this.#info = info
  }

  /** Prepare the root (scenario, home, sandbox) and launch the app on the Dashboard. */
  async start(o: StartOptions = {}): Promise<Page> {
    if (!existsSync(MAIN_ENTRY)) throw new Error(`${MAIN_ENTRY} is missing: run 'pnpm e2e' (it builds first)`)
    const sc = await makeScenario(o.scenario ?? {}, this.root)
    o.editScenario?.(sc)
    this.scenario = sc
    this.sandbox = makeSandbox({ git: o.git !== false }, this.root)
    mkdirSync(this.userHome, { recursive: true })
    const claudeConfigDir = join(this.root, 'claude-config')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(claudeConfigDir, { recursive: true })
    if (o.codex !== undefined) this.codex = new FakeCodex(this.root, o.codex)
    if (o.gemini !== undefined) this.gemini = new FakeGemini(this.root, o.gemini)
    if (o.grok !== undefined) this.grok = new FakeGrok(this.root, o.grok)
    if (o.muse !== undefined) this.muse = new FakeMuse(this.root, o.muse)
    const config = withPipeline(o.pipeline ?? 'full', {
      profile: 'claude-only',
      vendors: {
        claude: { path: await fakeClaudePath(), env: { ...sc.env, CLAUDE_CONFIG_DIR: claudeConfigDir } },
        ...(this.codex !== null ? { codex: { path: await fakeCodexPath(), env: this.codex.env } } : {}),
        ...(this.gemini !== null ? { gemini: { path: await fakeGeminiPath(), env: this.gemini.env } } : {}),
        ...(this.grok !== null ? { grok: { path: await fakeGrokPath(), env: this.grok.env } } : {}),
        ...(this.muse !== null ? { muse: { path: await fakeMusePath(), env: this.muse.env } } : {}),
      },
      ...o.config,
    })
    writeFileSync(join(this.home, 'dimfactory.json'), `${JSON.stringify(config, null, 2)}\n`)
    const lastRefreshAt = o.catalogLastRefreshAt === undefined ? Date.now() : o.catalogLastRefreshAt
    const state = join(this.home, 'state.json')
    if (lastRefreshAt !== null && !existsSync(state)) {
      const doc = { schemaVersion: 1, catalog: { lastRefreshAt, snoozedUntil: null } }
      writeFileSync(state, `${JSON.stringify(doc, null, 2)}\n`)
    }
    this.#env = hermeticEnv({
      DIM_FACTORY_HOME: this.home,
      DIM_FACTORY_E2E: '1',
      // The fake replays recorded answers whose words do not match the files a scenario writes: the grounding checks
      // are off unless a test turns them on.
      DIM_FACTORY_GROUNDING: o.grounding === true ? 'on' : 'off',
      DIM_FACTORY_E2E_VENDOR_SEARCH: 'configured',
      // The app's own CODEX_HOME (never ~/.codex), inside the root this test deletes.
      CODEX_HOME: join(this.root, 'codex-home-app'),
      // Likewise the app's own GEMINI_CLI_HOME (never ~/.gemini; the fake Gemini's own is in its vendor env).
      GEMINI_CLI_HOME: join(this.root, 'gemini-home-app'),
      // And GROK_HOME (never ~/.grok; the fake Grok's own is in its vendor env).
      GROK_HOME: join(this.root, 'grok-home-app'),
      // The user home Grok's read-only allow-rules scan reads (never the developer's ~/.claude).
      DIM_FACTORY_E2E_USER_HOME: this.userHome,
      ...(o.timeScale !== undefined ? { DIM_FACTORY_E2E_TIME_SCALE: String(o.timeScale) } : {}),
      ...(o.pickSandbox === true ? { DIM_FACTORY_E2E_PICK_FOLDER: this.sandbox } : {}),
      ...(o.newUser === true ? { DIM_FACTORY_E2E_NEW_USER: '1' } : {}),
      ...(o.pickFiles !== undefined ? { DIM_FACTORY_E2E_PICK_FILES: o.pickFiles.join(delimiter) } : {}),
      ...o.env,
    })
    return this.launch()
  }

  /** Launch (or relaunch, after close/kill) the app with the same home and wait for the bridge. */
  async launch(): Promise<Page> {
    const app = await _electron.launch({
      // Chromium's stand-in camera and microphone: a machine with no microphone (a CI runner) answers getUserMedia
      // with NotFoundError before any permission is asked, so the permission checks (security.spec.ts) would test the
      // hardware, not the app's refusal. The stand-ins grant nothing: the app's permission handlers still decide.
      args: ['.', '--use-fake-device-for-media-stream'],
      cwd: REPO_ROOT,
      env: Object.fromEntries(
        Object.entries(this.#env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      timeout: LAUNCH_TIMEOUT_MS,
    })
    this.app = app
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS })
    this.page = page
    page.on('console', (m) => {
      if (m.type() === 'error') this.pageErrors.push(`console: ${m.text()}`)
    })
    page.on('pageerror', (e) => this.pageErrors.push(`pageerror: ${e.message}`))
    // The renderer's E2E hook appears once app.info answered (AppInfo.e2e).
    await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: LAUNCH_TIMEOUT_MS })
    return page
  }

  /**
   * The Dashboard's quick composer: the sandbox (typed, or Choose folder… with DIM_FACTORY_E2E_PICK_FOLDER), the
   * task, then Run (a click, or Ctrl/Cmd+Enter). Resolves once the Run view of the new run is open.
   */
  async runFromDashboard(task: string, o: { pick?: boolean; keyboard?: boolean } = {}): Promise<RunSummary> {
    const page = this.p
    await expect(page.getByTestId('composer')).toBeVisible()
    const folder = page.getByTestId('composer-folder-input')
    if (o.pick === true) {
      await page.getByTestId('composer-choose-folder').click()
      await expect(folder).toHaveValue(this.sandbox)
    } else {
      await folder.fill(this.sandbox)
      await folder.press('Enter')
    }
    const taskBox = page.getByTestId('composer-task')
    await taskBox.fill(task)
    // The profile's pass line appears once config.resolve answered for the folder.
    await expect(page.getByTestId('composer-passes')).toContainText('Claude')
    await expect(page.getByTestId('composer-run')).toBeEnabled()
    if (o.keyboard === true) {
      await taskBox.focus()
      await page.keyboard.press('ControlOrMeta+Enter')
    } else {
      await page.getByTestId('composer-run').click()
    }
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await this.onlyRun()
    await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
    await expect(page.getByTestId('run-view')).toBeVisible()
    return run
  }

  /** Wait for the gate after Plan and approve the plan as it is. */
  async approvePlan(): Promise<void> {
    const page = this.p
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    await gate.getByTestId('card-choice-approve').click()
    await expect(gate).toBeHidden()
  }

  get p(): Page {
    if (this.page === null) throw new Error('the app is not running')
    return this.page
  }

  /** window.dimFactory.invoke in the page (never rejects; a Result). */
  readonly invoke: Invoke = async (cmd, ...args) => {
    const result: unknown = await this.p.evaluate(
      ([c, r]) => (window.dimFactory.invoke as (cmd: string, req?: unknown) => Promise<unknown>)(c, r),
      [cmd, args[0]] as const,
    )
    return result as never
  }

  /** invoke, throwing on an error result. */
  async call<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Res<C>> {
    const r = await this.invoke(cmd, ...args)
    if (!r.ok) throw new Error(`${cmd} failed: ${r.error.code} ${r.error.message}`)
    return r.value
  }

  async e2eState(): Promise<E2EState> {
    return this.call('e2e.state')
  }

  async snapshot(runId: string): Promise<RunSnapshot> {
    return this.call('runs.get', { runId })
  }

  /** Poll runs.get until `pred` holds; returns the matching snapshot. */
  async waitForSnapshot(
    runId: string,
    pred: (s: RunSnapshot) => boolean,
    o: { timeoutMs?: number; what?: string } = {},
  ): Promise<RunSnapshot> {
    const end = Date.now() + (o.timeoutMs ?? 90_000)
    let last: RunSnapshot | undefined
    for (;;) {
      const r = await this.invoke('runs.get', { runId })
      if (r.ok) {
        last = r.value
        if (pred(r.value)) return r.value
      }
      if (Date.now() > end) {
        const s = last?.summary
        throw new Error(
          `run ${runId} never reached ${o.what ?? 'the expected state'}; last: ${s?.status}/${s?.phase} ` +
            `steps ${JSON.stringify(s?.steps.map((x) => `${x.key}:${x.status}`))}`,
        )
      }
      await this.p.waitForTimeout(250)
    }
  }

  /** Poll until the run's summary matches (status and/or phase, or a predicate). */
  async waitForSummary(
    runId: string,
    want: Partial<Pick<RunSummary, 'status' | 'phase'>> | ((s: RunSummary) => boolean),
    timeoutMs?: number,
  ): Promise<RunSummary> {
    const pred =
      typeof want === 'function'
        ? want
        : (s: RunSummary) =>
            (want.status === undefined || s.status === want.status) &&
            (want.phase === undefined || s.phase === want.phase)
    const what = typeof want === 'function' ? undefined : JSON.stringify(want)
    const snap = await this.waitForSnapshot(runId, (s) => pred(s.summary), {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(what !== undefined ? { what } : {}),
    })
    return snap.summary
  }

  /** Wait for a terminal status: completed, failed or cancelled. */
  async waitForEnd(runId: string, timeoutMs = 150_000): Promise<RunSummary> {
    return this.waitForSummary(runId, (s) => TERMINAL.has(s.status), timeoutMs)
  }

  /** One line for assertion messages: status, phase, outcome, failure, steps. */
  describeRun(s: RunSummary): string {
    const failure = s.failure !== undefined ? ` failure ${s.failure.step}:${s.failure.category}` : ''
    const steps = s.steps.map(
      (x) => `${x.key}:${x.status}${x.failureCategory !== undefined ? `(${x.failureCategory})` : ''}`,
    )
    return `run ${s.runId} ${s.status}/${s.phase} outcome ${s.outcome ?? '-'}${failure} steps ${steps.join(' ')}`
  }

  /** Wait until a step of the run has a live vendor process (e2e.state procs). */
  async waitForLiveProc(runId: string, step: StepKey, timeoutMs = 60_000): Promise<number> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const st = await this.e2eState()
      const p = st.procs.find((x) => x.runId === runId && x.step === step)
      if (p !== undefined) return p.pid
      if (Date.now() > end) throw new Error(`no live ${step} process for ${runId}`)
      await this.p.waitForTimeout(250)
    }
  }

  /** The single run in this home (runs.list), waiting for it to exist. */
  async onlyRun(timeoutMs = 30_000): Promise<RunSummary> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const r = await this.invoke('runs.list', {})
      if (r.ok && r.value.items.length > 0) {
        if (r.value.items.length > 1) throw new Error(`expected one run, found ${r.value.items.length}`)
        const only = r.value.items[0]
        if (only !== undefined) return only
      }
      if (Date.now() > end) throw new Error('no run was created')
      await this.p.waitForTimeout(250)
    }
  }

  /** The fake CLI's JSONL log (start/argv, script, stdin lines, exit). */
  fakeLog(): FakeLogEntry[] {
    return this.scenario === null || !existsSync(this.scenario.log) ? [] : readFakeLog(this.scenario.log)
  }

  /** The renderer's E2E hook: the stream buffer's full text of one step. */
  async streamText(runId: string, step: StepKey, attempt?: number): Promise<string> {
    return this.p.evaluate(
      ([r, s, a]) => {
        const hook = (window as unknown as Record<string, unknown>)['__dimFactoryE2E'] as
          | { streamText(runId: string, step: string, attempt?: number): string; flushStreams(): void }
          | undefined
        if (hook === undefined) throw new Error('the E2E hook is missing')
        hook.flushStreams()
        return a === null ? hook.streamText(r, s) : hook.streamText(r, s, a)
      },
      [runId, step, attempt ?? null] as const,
    )
  }

  /** Graceful close (Playwright's app.close → main's confirmed quit), then a tree kill if it lingers. */
  async close(): Promise<void> {
    const app = this.app
    this.app = null
    this.page = null
    if (app === null) return
    const pid = app.process().pid
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      app.close().then(
        () => true,
        () => false,
      ),
      new Promise<false>((r) => (timer = setTimeout(() => r(false), CLOSE_TIMEOUT_MS))),
    ])
    clearTimeout(timer)
    if (!closed && pid !== undefined) {
      this.#info.annotations.push({
        type: 'warning',
        description: `the app did not close in time; killed ${pid}`,
      })
      killTree(pid)
    }
  }

  /** Hard kill of the Electron main process tree (a crash, not a quit). */
  async kill(): Promise<void> {
    const app = this.app
    this.app = null
    this.page = null
    if (app === null) return
    const pid = app.process().pid
    const gone = new Promise<void>((r) => app.process().once('exit', () => r()))
    if (pid !== undefined) killTree(pid)
    await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))])
  }

  /** Attach the tails of the runs' event logs, the app logs and the fake log (after a failure). */
  async attachDiagnostics(): Promise<void> {
    const files: string[] = []
    const runs = join(this.home, 'runs')
    if (existsSync(runs))
      for (const d of readdirSync(runs, { withFileTypes: true }))
        if (d.isDirectory()) files.push(join(runs, d.name, 'events.jsonl'))
    const logs = join(this.home, 'logs')
    if (existsSync(logs)) for (const f of readdirSync(logs)) files.push(join(logs, f))
    if (this.scenario !== null) files.push(this.scenario.log)
    if (this.codex !== null) files.push(this.codex.log)
    if (this.gemini !== null) files.push(this.gemini.log)
    if (this.grok !== null) files.push(this.grok.log)
    if (this.muse !== null) files.push(this.muse.log)
    for (const f of files) {
      if (!existsSync(f) || !statSync(f).isFile()) continue
      const lines = readFileSync(f, 'utf8').split('\n')
      const tail = lines.slice(-300).map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l))
      await this.#info.attach(f.slice(this.root.length + 1).replace(/[\\/]/g, '__'), {
        body: tail.join('\n'),
        contentType: 'text/plain',
      })
    }
  }

  /** Close the app, stop any fake CLI still alive, delete the root. */
  async dispose(): Promise<void> {
    try {
      await this.close()
    } finally {
      killLeftoverFakes([
        ...this.fakeLog(),
        ...(this.codex?.entries() ?? []),
        ...(this.gemini?.entries() ?? []),
        ...(this.grok?.entries() ?? []),
        ...(this.muse?.entries() ?? []),
      ])
      if (process.env['DIM_FACTORY_KEEP_TMP'] !== '1')
        rmSync(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    }
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** A fake CLI process's command line: a launcher (or the entry) under tests/.bin. */
const FAKE_LAUNCHER = /tests[\\/]\.bin[\\/]/

/**
 * Fake CLI processes the log shows started but never exiting. The app should have stopped them; this only keeps a
 * failing test from leaving processes behind. A pid is killed only while its command line still runs the fake CLI,
 * so a reused pid is never touched.
 */
function killLeftoverFakes(entries: readonly FakeLogEntry[]): void {
  const started = new Set<number>()
  for (const e of entries) {
    if (e.kind === 'start') started.add(e.pid)
    if (e.kind === 'exit') started.delete(e.pid)
  }
  const alive = [...started].filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  if (alive.length === 0) return
  if (process.platform === 'win32') {
    const filter = alive.map((p) => `ProcessId=${p}`).join(' OR ')
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
          `Where-Object { $_.CommandLine -like '*tests?.bin?*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
    )
    return
  }
  for (const pid of alive) {
    const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout
    if (FAKE_LAUNCHER.test(cmd)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}

/** `test` with an `e2e` harness that always cleans up. */
export const test = base.extend<{ e2e: E2EHarness }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures need the destructuring parameter
  e2e: async ({}, use, testInfo) => {
    const h = new E2EHarness(testInfo)
    try {
      await use(h)
    } finally {
      if (h.pageErrors.length > 0)
        await testInfo.attach('renderer-errors', { body: h.pageErrors.join('\n'), contentType: 'text/plain' })
      if (testInfo.status !== testInfo.expectedStatus) await h.attachDiagnostics().catch(() => undefined)
      await h.dispose()
    }
  },
})
