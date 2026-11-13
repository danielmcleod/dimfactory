// Re-run from Fix of a paused run that holds its folder (sessions: "If the source still holds
// the folder lock, the source is cancelled (`stopped` snapshot) atomically with the new run's enqueue"; state-machine
// row R14 "a source still holding the lock is cancelled atomically first"; at boot "Never auto-resume").
// The app is killed while the run's Fix works; relaunched, the run is paused (interrupted) and still holds the folder.
// Another run started meanwhile queues behind it. From the paused run's header, Re-run ▾ → Re-run from Fix opens the
// findings picker at the end of the Flow tab, which says the run is stopped when the new one starts. Started: the
// source is cancelled, the re-run takes the folder before the run that was already queued (which now waits for the
// re-run), and its Fix resumes Implement's session (`--resume=<id>`) against the folder as the source left it.
import { expect, test } from './harness.ts'
import { fakeProc, fakeProcs, stepSessionId } from './attention-helpers.ts'
import { FINDING_TITLES, NO_GATES, RESUMED_FIX, findingsFlow, storedState } from './history-helpers.ts'

test('a paused run holding its folder, re-run from Fix: the source is cancelled and the re-run goes first', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // The source's Fix parks in a long sleep (the kill lands there); the re-run's Fix resumes and finishes.
  await e2e.start({
    scenario: findingsFlow([{ ...RESUMED_FIX, delayMs: 300_000 }, RESUMED_FIX]),
    config: NO_GATES,
  })
  const { runId: source } = await e2e.call('runs.start', {
    folder: e2e.sandbox,
    task: 'add a --version flag',
    overrides: {},
  })
  await e2e.waitForLiveProc(source, 'fix', 120_000)
  // The fake Fix has read its prompt and is parked in its sleep.
  await expect
    .poll(() =>
      fakeProcs(e2e).some(
        (p) => p.script === 'resume-1.script.jsonl' && p.stdin.some((l) => l.includes('"type":"user"')),
      ),
    )
    .toBe(true)
  const implId = stepSessionId(e2e, source, 'implement') ?? ''
  expect(fakeProc(e2e, 'resume-1.script.jsonl').argv).toContain(`--resume=${implId}`)
  await e2e.kill()

  // ---- relaunched: the run is paused and still holds the folder; a second run queues behind it ----
  const page = await e2e.launch()
  const paused = await e2e.waitForSummary(source, { status: 'paused' })
  expect(paused.lock).toBe('held')
  const { runId: queued } = await e2e.call('runs.start', {
    folder: e2e.sandbox,
    task: 'add a --help flag',
    overrides: {},
  })
  await e2e.waitForSummary(queued, (s) => s.status === 'queued' && s.blockedBy === source)

  // ---- the paused run (Open, from the notice), its header: Re-run ▾ → Re-run from Fix → the picker ----
  const notice = page.getByTestId('recovered-notice')
  await expect(notice).toContainText('1 run was paused because Dim Factory closed.')
  await notice.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${source}$`))
  await expect(page.getByTestId('run-view')).toBeVisible()
  await expect(notice).toHaveCount(0)
  await expect(page.getByTestId('run-status')).toContainText(/paused/i)
  await page.getByTestId('rerun-menu').click()
  // Either form of re-run stops the paused run first (R14): Re-run with same config says so as well.
  await expect(page.getByTestId('rerun-start-hint')).toHaveText(
    'Run #1 still holds its folder, so it is stopped when the new run starts.',
  )
  const item = page.getByTestId('rerun-from-fix')
  await expect(item).not.toHaveAttribute('data-disabled', /.*/)
  await expect(item).toContainText('Fix would continue the Implement session')
  await item.click()
  const picker = page.getByTestId(`fix-picker-${source}`)
  await expect(picker).toBeVisible()
  await expect(picker).toBeFocused()
  await expect(picker.getByTestId('fix-picker-stops-source')).toHaveText(
    'Run #1 still holds its folder, so it is stopped when the new run starts.',
  )
  await expect(picker.getByTestId('fix-picker-receives')).toHaveText('Fix will receive 2 must · 1 should')
  await picker.getByTestId('fix-picker-start').click()

  // ---- the source is cancelled; the re-run has the folder before the queued run ----
  await expect(page).not.toHaveURL(new RegExp(`#/runs/${source}$`))
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const rerun = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  expect(rerun).not.toBe(queued)
  const cancelled = await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
  expect(cancelled.steps.find((s) => s.key === 'fix')?.status).toBe('cancelled')
  // The run queued before the re-run now waits for the re-run (it was never let in between); it is then cancelled.
  await e2e.waitForSummary(rerun, (s) => s.lock === 'held')
  const third = await e2e.waitForSummary(queued, (s) => s.blockedBy === rerun)
  expect(third.status).toBe('queued')
  await e2e.call('runs.stop', { runId: queued })
  await e2e.waitForSummary(queued, { status: 'cancelled' })
  const ended = await e2e.waitForEnd(rerun)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  const fix = fakeProc(e2e, 'resume-2.script.jsonl')
  expect(fix.argv).toContain(`--resume=${implId}`)
  for (const t of Object.values(FINDING_TITLES)) expect(fix.stdin.join('\n')).toContain(t)
  // The re-run reconciled the folder against where the quit left the source (its `interrupted` snapshot).
  expect(storedState(e2e, rerun)['rerunOf']).toMatchObject({
    runId: source,
    displayNo: 1,
    from: 'fix',
    base: { label: 'interrupted' },
  })
  expect(e2e.pageErrors).toEqual([])
})
