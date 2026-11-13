// Kill and relaunch (at boot "Never auto-resume"): kill the app hard while Implement runs, then
// relaunch with the same DIM_FACTORY_HOME → the run is paused(interrupted), the notice says it was paused because
// Dim Factory closed, the Dashboard's needs-you strip and sidebar badge (and the tray) say it needs the user, and
// nothing resumes on its own (the fake never sees a second Implement spawn).
import { passArgvs, stdinByScript } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { PARKED_IMPLEMENT } from './scenarios.ts'

test(
  'a run killed during Implement comes back paused and does not resume',
  { tag: '@cross-os' },
  async ({ e2e }) => {
    let page = await e2e.start({ scenario: PARKED_IMPLEMENT })
    const run = await e2e.runFromDashboard('add a --version flag')
    await e2e.approvePlan()
    await e2e.waitForLiveProc(run.runId, 'implement')
    await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'running')
    const implementSpawns = (): number =>
      passArgvs(e2e.fakeLog()).filter((a) => a.includes('acceptEdits')).length
    // The fake Implement has read its prompt and is parked in its sleep.
    await expect
      .poll(() =>
        (stdinByScript(e2e.fakeLog()).get('implement-1.script.jsonl') ?? []).some((l) =>
          l.includes('"type":"user"'),
        ),
      )
      .toBe(true)
    expect(implementSpawns()).toBe(1)

    // A crash, not a quit: the main process tree dies without any shutdown.
    await e2e.kill()

    page = await e2e.launch()
    const notice = page.getByTestId('recovered-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toContainText('1 run was paused because Dim Factory closed.')
    await expect(notice).toContainText('Nothing resumes on its own')

    const snap = await e2e.waitForSnapshot(run.runId, (s) => s.summary.status === 'paused', {
      what: 'paused',
    })
    expect(snap.steps.implement.status).toBe('paused')
    expect(snap.steps.implement.pause).toBe('interrupted')

    // Recovery paused the run before main attached to the core: main hands the new page the current attention.
    const needsYou = page.getByTestId('needs-you')
    await expect(needsYou).toBeVisible()
    await expect(needsYou.getByTestId('needs-you-paused:implement')).toContainText('add a --version flag')
    await expect(page.getByTestId('nav-dashboard')).toContainText('1')
    await expect.poll(async () => (await e2e.e2eState()).tray.tooltip).toBe('1 run active · 1 needs you')

    // Open from the notice: the Implement card says why it paused and offers Resume.
    await notice.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
    await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'paused')
    const paused = page.getByTestId('paused-implement')
    await expect(paused).toBeVisible()
    await expect(paused.getByTestId('resume')).toBeEnabled()
    await expect(page.getByTestId('recovered-notice')).toHaveCount(0)

    // Nothing auto-resumes: no new Implement spawn and no live vendor process after a while.
    await page.waitForTimeout(5_000)
    expect(implementSpawns()).toBe(1)
    expect((await e2e.e2eState()).procs).toEqual([])
    expect((await e2e.snapshot(run.runId)).summary.status).toBe('paused')

    expect(e2e.pageErrors).toEqual([])
  },
)
