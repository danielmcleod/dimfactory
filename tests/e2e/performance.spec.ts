// Performance: Implement streams ~5 MB of text deltas as fast as the fake can
// write them while the Run view shows it → fewer than 5 long tasks (> 50 ms) in the renderer; the same holds when a
// reload replays the 5 MB log and the finished pass is expanded; Settings section switches each render in under
// 200 ms. Main's event-loop delay (p95 < 100 ms, else the core moves to a utilityProcess) is measured over the
// stream and recorded in the report.
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { longText, streamDeltas, streamingImplement } from './scenarios.ts'

const TEXT = longText(5 * 1024 * 1024)
const CHUNK = 108
const MAX_LONG_TASKS = 5
const MAX_SWITCH_MS = 200
const MAX_EVENT_LOOP_P95_MS = 100
/** The newest line's marker: markdown renders "- line N: …" as a list item reading "line N: …". */
const LAST_LINE = /line \d+:/.exec(TEXT.trimEnd().split('\n').at(-1) ?? '')?.[0] ?? 'line'
/** Every Settings section (General, Profiles, Prompts, Catalog, Diagnostics and Config file included). */
const SECTIONS = [
  'general',
  'guardrails',
  'appearance',
  'vendors',
  'profiles',
  'extensions',
  'prompts',
  'recipes',
  'self-heal',
  'catalog',
  'isolation',
  'preview',
  'deploy',
  'factory',
  'notifications',
  'outside-agents',
  'diagnostics',
  'config',
]

interface LongTaskWindow extends Window {
  __e2eLongTasks?: number[]
}

/** Collect long tasks from the start of every document (survives reloads). */
const installLongTaskObserver = (): void => {
  const w = window as LongTaskWindow
  w.__e2eLongTasks = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__e2eLongTasks?.push(Math.round(e.duration))
  }).observe({ type: 'longtask', buffered: true })
}

async function takeLongTasks(e2e: E2EHarness): Promise<number[]> {
  return e2e.p.evaluate(() => {
    const w = window as LongTaskWindow
    const out = w.__e2eLongTasks
    if (out === undefined) throw new Error('the long-task observer is not installed in this document')
    w.__e2eLongTasks = []
    return out
  })
}

/** Restart main's since-reset event-loop histogram (a main-process global under DIM_FACTORY_E2E=1). */
async function resetEventLoop(e2e: E2EHarness): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  const done = await e2e.app.evaluate(() => {
    const g = (globalThis as { __dimFactoryE2E?: { eventLoop: { reset(): void } } }).__dimFactoryE2E
    g?.eventLoop.reset()
    return g !== undefined
  })
  if (!done) throw new Error('the main-process E2E globals are missing')
}

async function eventLoop(e2e: E2EHarness): Promise<{ p95: number; max: number }> {
  const extra = (await e2e.e2eState()).extra ?? {}
  return { p95: Number(extra['eventLoopP95Ms']), max: Number(extra['eventLoopMaxMs']) }
}

test(
  'a 5 MB stream stays responsive; Settings switches render in under 200 ms',
  { tag: '@cross-os' },
  async ({ e2e }, info) => {
    test.setTimeout(420_000)
    const report = (type: string, description: string): void => {
      info.annotations.push({ type, description })
      console.log(`[performance] ${type}: ${description}`)
    }
    const page = await e2e.start({
      scenario: streamingImplement(TEXT),
      editScenario: (sc) => streamDeltas(sc, 'implement-1', TEXT, { chunkSize: CHUNK }),
    })
    await page.addInitScript(installLongTaskObserver)
    await page.evaluate(installLongTaskObserver)
    const app = e2e.app
    if (app === null) throw new Error('the app is not running')

    const run = await e2e.runFromDashboard('add a --version flag')
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })

    // ---- Phase 1: the live 5 MB stream, on screen in the Run view ----
    await takeLongTasks(e2e)
    await resetEventLoop(e2e)
    const t0 = Date.now()
    await gate.getByTestId('card-choice-approve').click()
    // The pane keeps the newest 400 rows, so the first line scrolls out of the DOM; the buffer keeps the full text.
    await expect(page.getByTestId('stream-implement')).toContainText('line ', { timeout: 60_000 })
    await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.status === 'done', {
      what: 'Implement done',
      timeoutMs: 300_000,
    })
    await expect
      .poll(async () => (await e2e.streamText(run.runId, 'implement')).length, { timeout: 60_000 })
      .toBe(TEXT.length)
    const streamMs = Date.now() - t0
    const live = await takeLongTasks(e2e)
    const loop = await eventLoop(e2e)
    report(
      'live-stream',
      `${TEXT.length} chars in ${CHUNK}-char deltas, ${streamMs} ms; long tasks ${JSON.stringify(live)}`,
    )
    report('main-event-loop', `p95 ${loop.p95} ms, max ${loop.max} ms during the live stream`)
    expect(await e2e.streamText(run.runId, 'implement')).toBe(TEXT)

    // ---- Phase 2: reload → the focus replay pages the 5 MB log back in; then expand the finished pass ----
    await resetEventLoop(e2e)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload())
    await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 60_000 })
    await expect
      .poll(async () => (await e2e.streamText(run.runId, 'implement')).length, { timeout: 120_000 })
      .toBe(TEXT.length)
    const card = page.getByTestId('pass-card-implement')
    await expect(card).toHaveAttribute('data-status', 'done')
    await card.getByRole('button', { name: 'Implement', exact: true }).click()
    const pane = page.getByTestId('stream-implement')
    await expect(pane).toBeVisible()
    await expect(pane).toContainText(LAST_LINE, { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    const replay = await takeLongTasks(e2e)
    const replayLoop = await eventLoop(e2e)
    report('reload-replay', `long tasks ${JSON.stringify(replay)} (reload, 5 MB replay, expand)`)
    report(
      'main-event-loop-replay',
      `p95 ${replayLoop.p95} ms, max ${replayLoop.max} ms during the reload replay`,
    )
    expect(await e2e.streamText(run.runId, 'implement')).toBe(TEXT)

    // ---- Phase 3: Settings navigation ----
    const switches = await page.evaluate(async (ids) => {
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      location.hash = '#/settings/vendors'
      const shown = (id: string): boolean =>
        document.querySelector<HTMLElement>('[data-testid="settings-content"]')?.dataset['section'] === id
      for (let i = 0; i < 200 && !shown('vendors'); i++) await frame()
      const out: Record<string, number> = {}
      for (const id of ids) {
        const link = document.querySelector<HTMLElement>(`[data-testid="settings-section-${id}"]`)
        if (link === null) throw new Error(`no link for settings section ${id}`)
        const start = performance.now()
        link.click()
        while (!shown(id)) await new Promise((r) => requestAnimationFrame(r))
        await frame()
        out[id] = Math.round(performance.now() - start)
      }
      return out
    }, SECTIONS)
    report('settings-switch-ms', JSON.stringify(switches))
    // The walk covers every section the list offers.
    const listed = await page
      .locator('[data-testid^="settings-section-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')?.slice('settings-section-'.length)))

    // ---- Assertions (after reporting, so a failure still records every number) ----
    expect(live.length, `live stream long tasks ${JSON.stringify(live)}`).toBeLessThan(MAX_LONG_TASKS)
    expect(replay.length, `reload replay long tasks ${JSON.stringify(replay)}`).toBeLessThan(MAX_LONG_TASKS)
    expect([...listed].sort()).toEqual([...SECTIONS].sort())
    for (const [id, ms] of Object.entries(switches))
      expect(ms, `switch to Settings → ${id}`).toBeLessThan(MAX_SWITCH_MS)
    expect(loop.p95, 'main event-loop p95 during the live stream (ms)').toBeLessThan(MAX_EVENT_LOOP_P95_MS)
    expect(replayLoop.p95, 'main event-loop p95 during the reload replay (ms)').toBeLessThan(
      MAX_EVENT_LOOP_P95_MS,
    )

    expect(e2e.pageErrors).toEqual([])
  },
)
