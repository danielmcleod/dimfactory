// "A second identical ask is auto-answered in-process and in the next process" (Allow for this
// run: adapters emit `allow-rule`, the engine persists it to run.allowRules and passes the rules
// back in StartOptions; "Rules never leave the run"; Claude's `--allowedTools <nativeRules>`): Allow for this run
// (⇧A) on Implement's `npm --version`; the identical second ask in the same process is answered by core without a
// panel (`auto-answered`, allow-cache); Fix — the run's next vendor process, resuming Implement's session — starts
// with `--allowedTools Bash(npm --version)`; read-only passes and the next run never get the rule.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import {
  allowedTools,
  bodiesOf,
  fakeProc,
  fakeProcs,
  nextAsk,
  permissionAnswers,
  runBodies,
} from './attention-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'
import { runByNo } from './dashboard-helpers.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

/** Every request id the ask panel shows from now on (a MutationObserver in the page). */
async function watchAskPanel(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = []
    const w = window as unknown as { __askIds?: string[] }
    w.__askIds = seen
    const note = (): void => {
      for (const el of document.querySelectorAll('[data-testid="ask-panel"]')) {
        const id = el.getAttribute('data-request-id')
        if (id !== null && !seen.includes(id)) seen.push(id)
      }
    }
    note()
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-request-id'],
    })
  })
  return () => page.evaluate(() => (window as unknown as { __askIds?: string[] }).__askIds ?? [])
}

test(
  'allow for this run: the identical ask is answered in-process; the next process gets --allowedTools',
  {
    tag: ['@cross-os'],
  },
  async ({ e2e }) => {
    const page = await e2e.start({
      scenario: {
        plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
        implement: [
          // Two identical `npm --version` asks.
          { recording: 'C04a-ask-allow', write: VERSION_WRITE },
          { recording: 'C08a-session-id-implement', write: { path: 'src/other.ts', content: 'export {}\n' } },
        ],
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE }],
      },
      config: { gates: { afterPlan: false } },
    })
    const run = await e2e.runFromDashboard('add a --version flag')
    const shown = await watchAskPanel(page)

    // ---- ⇧A on the first ask ----
    const ask = page.getByTestId('ask-panel')
    const first = await nextAsk(page)
    await expect(ask).toBeFocused()
    await page.keyboard.press('Shift+A')
    await expect(ask).toBeHidden()
    await expect(page.getByTestId('allow-rules')).toContainText('Allowed for this run:')
    await expect(page.getByTestId('allow-rules')).toContainText('npm --version')

    // ---- in-process: the second identical ask never reaches the panel ----
    await expect.poll(() => permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl')).length).toBe(2)
    const answers = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
    expect(answers[0]).toEqual(
      expect.objectContaining({
        behavior: 'allow',
        updatedPermissions: [expect.objectContaining({ destination: 'session' })],
      }),
    )
    expect(answers[1]).toEqual(expect.objectContaining({ behavior: 'allow' }))

    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')
    expect(await shown()).toEqual([first])
    const bodies = await runBodies(e2e, run.runId)
    expect(bodiesOf(bodies, 'ev').filter((b) => b.ev.type === 'ask')).toHaveLength(1)
    expect(bodiesOf(bodies, 'auto-answered').filter((b) => b.step === 'implement')).toEqual([
      expect.objectContaining({ decision: 'allow', why: 'allow-cache', tool: 'Bash' }),
    ])
    const snap = await e2e.snapshot(run.runId)
    expect(snap.allowRules).toEqual([
      expect.objectContaining({
        vendor: 'claude',
        kind: 'shell',
        tool: 'Bash',
        nativeRules: ['Bash(npm --version)'],
      }),
    ])

    // ---- the next process: Fix resumes the session with the rule; read-only passes never get it ----
    const implement = fakeProc(e2e, 'implement-1.script.jsonl')
    const fix = fakeProc(e2e, 'resume-1.script.jsonl')
    expect(allowedTools(implement.argv)).toBeUndefined()
    expect(fix.argv.some((a) => a.startsWith('--resume='))).toBe(true)
    expect(allowedTools(fix.argv)).toContain('Bash(npm --version)')
    for (const p of fakeProcs(e2e).filter((x) => x.argv.includes('dontAsk')))
      expect(allowedTools(p.argv), p.script).toBeUndefined()

    // ---- the rule never leaves the run: the next run's Implement starts without it ----
    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByTestId('composer-folder-input')).toHaveValue(e2e.sandbox)
    await page.getByTestId('composer-task').fill('add a --help flag')
    await expect(page.getByTestId('composer-run')).toBeEnabled()
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const second = await runByNo(e2e, 2)
    const end2 = await e2e.waitForEnd(second.runId)
    expect(end2.status, e2e.describeRun(end2)).toBe('completed')
    expect((await e2e.snapshot(second.runId)).allowRules).toEqual([])
    expect(allowedTools(fakeProc(e2e, 'implement-2.script.jsonl').argv)).toBeUndefined()
    expect(e2e.pageErrors).toEqual([])
  },
)
