// The Diff tab (diffs, revert to S0): a run whose
// Implement changes a tracked source file, an image (and adds one) and only the line endings of a text file, then
// Review finds issues and Fix writes a test. In the Diff tab:
//   - while Fix runs, a file's Revert is disabled with the reason ("revert disabled while busy");
//   - nothing in the tab moves on its own from then to the run's end (no layout shift without input moves anything in
//     it, the page does not scroll): the run's final list waits behind [Show the latest changes], shown on a click;
//   - the segments are Implement | Fix | Combined, each listing its own files;
//   - Split | Stacked lays the diff out side by side or stacked (the toolbar, and the S key), highlighted by Shiki in
//     its worker;
//   - the binary row previews both sides of the image (diff.blob), the added image's new side only, and the EOL-only
//     row says only the line endings changed;
//   - the summary bar's Open diff leads from the run's steps to the Diff tab (the first-run script's last step, found
//     on the live balanced run), where a Reviewed mark survives a reload of the window (core's review-state.json);
//   - a file's Revert puts its S0 bytes back (sha256) with an Undo toast whose Undo brings the run's bytes back, for a
//     text file and for the image; the Revert button keeps its width through its states;
//   - the tab passes the UI-standards audit (no em dash, no sideways scrolling, one scroll region) at both sizes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import {
  chooseSegment,
  diffFile,
  diffPaths,
  imageDecoded,
  openDiffTab,
  solidPng,
  unpromptedDiffShifts,
  watchDiffShifts,
} from './diff-settings-helpers.ts'
import { toasts } from './attention-helpers.ts'
import {
  auditBothSizes,
  expectSteadyWidth,
  fingerprint,
  gitOut,
  mainScrollTop,
  sha256,
  trackWidth,
} from './git-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'

const LOGO = 'assets/logo.png'
const NEW_IMAGE = 'assets/new.png'
const EOL = 'data/eol.txt'
const SOURCE = 'src/index.ts'
const LOGO_S0 = solidPng([200, 40, 40])
const LOGO_RUN = solidPng([40, 40, 200])
const NEW_PNG = solidPng([40, 160, 40], 6)
const EOL_S0 = 'one\ntwo\nthree\n'
const EOL_RUN = 'one\r\ntwo\r\nthree\r\n'
const SOURCE_RUN = [
  '// Greeting logic for the ts-small CLI.',
  '',
  'export interface Options {',
  '  name: string',
  '  shout: boolean',
  '  version: boolean',
  '}',
  '',
  'export function greet({ name, shout }: Options): string {',
  '  const text = `Hello there, ${name}!`',
  '  return shout ? text.toUpperCase() : text',
  '}',
  '',
].join('\n')

const IMPLEMENT_PATHS = [VERSION_WRITE.path, SOURCE, LOGO, NEW_IMAGE, EOL]
const ALL_PATHS = [...IMPLEMENT_PATHS, FIX_WRITE.path]

test('Diff: segments, split/stacked, image and EOL rows, Open diff, reviewed across a reload, revert + undo', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      // Implement waits after reading its prompt: the test writes the rest of its changes meanwhile (all in S0..S1).
      implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE, delayMs: 10_000 }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      // Fix keeps working long enough to look at the Diff tab while the folder is busy.
      resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE, delayMs: 15_000 }],
    },
  })
  const f = e2e.sandbox
  mkdirSync(join(f, 'assets'), { recursive: true })
  mkdirSync(join(f, 'data'), { recursive: true })
  writeFileSync(join(f, LOGO), LOGO_S0)
  writeFileSync(join(f, EOL), EOL_S0)
  gitOut(f, '-c', 'core.autocrlf=false', 'add', '-A')
  gitOut(f, 'commit', '-q', '-m', 'assets')
  const s0 = fingerprint(f, ALL_PATHS)

  const run = await e2e.runFromDashboard('add a --version flag')
  const runId = run.runId
  await e2e.approvePlan()
  await e2e.waitForLiveProc(runId, 'implement')
  writeFileSync(join(f, SOURCE), SOURCE_RUN)
  writeFileSync(join(f, LOGO), LOGO_RUN)
  writeFileSync(join(f, NEW_IMAGE), NEW_PNG)
  writeFileSync(join(f, EOL), EOL_RUN)

  // ---- while Fix runs: the Diff tab shows Implement's changes, and Revert waits with the reason ----
  await e2e.waitForLiveProc(runId, 'fix', 120_000)
  await openDiffTab(page, runId)
  const busySource = diffFile(page, SOURCE)
  await expect(busySource).toBeVisible()
  const busyRevert = busySource.getByTestId('diff-file-revert')
  await expect(busyRevert).toBeDisabled()
  await expect(busySource.locator('[data-disabled-hint]')).toContainText(
    'The run is still working in the folder.',
  )
  // Core refuses it too while the process holds the folder.
  const refused = await e2e.invoke('diff.revert', { runId, seg: 'implement', paths: [SOURCE] })
  expect(refused.ok ? 'reverted' : refused.error.code).toBe('FOLDER_BUSY')

  // ---- Fix to the run's end, with nobody touching the page: nothing in the tab moves ----
  await expect(busySource.locator('pre[data-diff-type]')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('diff-show-newer')).toHaveCount(0)
  const pathsDuringFix = await diffPaths(page)
  await watchDiffShifts(page)
  const scrolledBefore = await mainScrollTop(page)
  const ended = await e2e.waitForEnd(runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  // The run's final list (Fix's file, the Fix segment) is held: offered, not swapped in.
  const showNewer = page.getByTestId('diff-show-newer')
  await expect(showNewer).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_000)
  const moved = await unpromptedDiffShifts(page)
  expect(moved.inDiff, 'the Diff tab moved with no input between Fix and the run’s end').toEqual([])
  expect(moved.cls).toBeLessThan(0.02)
  expect(await mainScrollTop(page)).toBe(scrolledBefore)
  expect(await diffPaths(page)).toEqual(pathsDuringFix)
  await showNewer.click()
  await expect(showNewer).toHaveCount(0)
  const atEnd = fingerprint(f, ALL_PATHS)
  expect(atEnd[SOURCE]).not.toBe(s0[SOURCE])
  expect(atEnd[LOGO]).not.toBe(s0[LOGO])

  // ---- the segments: Implement | Fix | Combined, each with its own files ----
  const tab = page.getByTestId('diff-tab')
  await expect(page.getByTestId('diff-segments').getByRole('radio')).toHaveText([
    'Implement',
    'Fix',
    'Combined',
  ])
  await expect(tab).toHaveAttribute('data-segment', 'combined')
  await expect.poll(() => diffPaths(page).then((p) => [...p].sort())).toEqual([...ALL_PATHS].sort())
  await expect(page.getByTestId('diff-summary')).toContainText('6 files changed')
  await chooseSegment(page, 'Implement')
  await expect.poll(() => diffPaths(page).then((p) => [...p].sort())).toEqual([...IMPLEMENT_PATHS].sort())
  await chooseSegment(page, 'Fix')
  await expect.poll(() => diffPaths(page)).toEqual([FIX_WRITE.path])
  await expect(diffFile(page, FIX_WRITE.path).getByTestId('diff-file-path')).toHaveText(FIX_WRITE.path)
  await chooseSegment(page, 'Combined')
  await expect.poll(() => diffPaths(page).then((p) => p.length)).toBe(ALL_PATHS.length)

  // ---- Split | Stacked: the library's split and single layouts, highlighted in the worker ----
  const source = diffFile(page, SOURCE)
  await source.scrollIntoViewIfNeeded()
  const layout = page.getByTestId('diff-layout')
  await expect(layout.getByRole('radio', { name: 'Split' })).toHaveAttribute('aria-checked', 'true')
  await expect(source.locator('pre[data-diff-type="split"]')).toHaveCount(1, { timeout: 30_000 })
  // Shiki's tokens arrive from the worker (inline token colours on the code's spans).
  await expect
    .poll(() => source.locator('span[style*="--diffs-token"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0)
  await expect(source).toContainText('Hello there')
  await layout.getByRole('radio', { name: 'Stacked' }).click()
  await expect(source.locator('pre[data-diff-type="single"]')).toHaveCount(1)
  await expect(source.locator('pre[data-diff-type="split"]')).toHaveCount(0)
  // S switches back (a key of the Diff tab, with focus anywhere on the page but a field: here the Stacked button).
  await expect(layout.getByRole('radio', { name: 'Stacked' })).toBeFocused()
  await page.keyboard.press('s')
  await expect(layout.getByRole('radio', { name: 'Split' })).toHaveAttribute('aria-checked', 'true')
  await expect(source.locator('pre[data-diff-type="split"]')).toHaveCount(1)

  // ---- the binary rows: both sides of the changed image, the new side of the added one ----
  const logo = diffFile(page, LOGO)
  await logo.scrollIntoViewIfNeeded()
  await expect(logo.getByTestId('diff-binary')).toBeVisible()
  for (const side of ['old', 'new'] as const) {
    const img = logo.getByTestId(`diff-image-${side}`)
    await expect(img).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => imageDecoded(img)).toBe(true)
  }
  const added = diffFile(page, NEW_IMAGE)
  await added.scrollIntoViewIfNeeded()
  await expect(added.getByTestId('diff-image-new')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => imageDecoded(added.getByTestId('diff-image-new'))).toBe(true)
  await expect(added.getByTestId('diff-image-old')).toHaveCount(0)
  await expect(added.locator('figure[data-side="old"]')).toContainText('None')

  // ---- the EOL-only row ----
  const eol = diffFile(page, EOL)
  await eol.scrollIntoViewIfNeeded()
  await expect(eol.getByTestId('diff-eol-only')).toHaveText('Only line endings changed')

  await auditBothSizes(e2e, page, 'Diff tab (Combined: a source diff, images, an EOL-only file)')

  // ---- The first-run script's last step: the summary bar's Open diff leads to the Diff tab, where files are marked reviewed ----
  await page.getByTestId('run-tab-flow').click()
  await expect(page.getByTestId('diff-tab')).toHaveCount(0)
  await page.getByTestId('open-diff').click()
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  await expect.poll(() => diffPaths(page).then((p) => p.length)).toBe(ALL_PATHS.length)
  await source.scrollIntoViewIfNeeded()

  // ---- a Reviewed mark lasts across a reload of the window ----
  const reviewed = source.getByTestId('diff-file-reviewed')
  await reviewed.click()
  await expect(reviewed).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(async () => (await e2e.call('diff.files', { runId, seg: 'combined' })).reviewed)
    .toEqual([SOURCE])
  if (e2e.app === null) throw new Error('the app is not running')
  await e2e.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload())
  await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 60_000 })
  await expect(page.getByTestId('diff-tab')).toBeVisible()
  await expect(diffFile(page, SOURCE).getByTestId('diff-file-reviewed')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(diffFile(page, LOGO).getByTestId('diff-file-reviewed')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByTestId('diff-reviewed-count')).toContainText('1 of 6 reviewed')

  // ---- a file's Revert: S0's bytes, then Undo brings the run's back (a text file, then the image) ----
  for (const path of [SOURCE, LOGO]) {
    const section = diffFile(page, path)
    await section.scrollIntoViewIfNeeded()
    const selector = `article[data-testid="diff-file"][data-path="${path}"] [data-testid="diff-file-revert"]`
    await trackWidth(page, `revert-${path}`, selector)
    const revert = section.getByTestId('diff-file-revert')
    await expect(revert).toBeEnabled()
    await revert.click()
    const done = toasts(page).filter({ hasText: `Reverted ${path}` })
    await expect(done).toHaveCount(1)
    expect(sha256(join(f, path)), `${path} after its revert`).toBe(s0[path])
    await expectSteadyWidth(page, `revert-${path}`, `Revert (${path})`)
    await done.getByRole('button', { name: 'Undo' }).click()
    await expect(toasts(page).filter({ hasText: `Revert undone: ${path} is back` })).toHaveCount(1)
    expect(sha256(join(f, path)), `${path} after the undo`).toBe(atEnd[path])
  }
  // Nothing else in the folder moved.
  expect(fingerprint(f, ALL_PATHS)).toEqual(atEnd)

  expect(e2e.pageErrors).toEqual([])
})

test("the built app's diff highlighter worker starts under its CSP (the packaged smoke test's check)", async ({
  e2e,
}) => {
  const page = await e2e.start()
  const answer = await page.evaluate(async () => {
    const check = (window as unknown as Record<string, (() => Promise<string | null>) | undefined>)[
      '__dimFactoryDiffCheck'
    ]
    return check === undefined ? 'no hook' : await check()
  })
  expect(answer).toBeNull()
  expect(e2e.pageErrors).toEqual([])
})
