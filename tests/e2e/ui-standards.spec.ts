// UI standards (the app's UI standards, which the user set on 2026-10-07). The app is walked with the fake Claude, and every screen it reaches is checked for three things:
//   - No em dash (U+2014) anywhere in the document. That means the body's innerText (which includes screen-reader-only
//     text and live regions), document.title, the title / aria-label / aria-description / aria-valuetext /
//     placeholder / alt / data-label attributes of every element, and every element's ::before and ::after generated
//     content (innerText leaves that out). data-label holds the reserved labels a StableLabel draws with CSS generated
//     content (`attr(data-label)`).
//   - No horizontal scrolling: no element inside <main> (main included) with overflow-x auto or scroll has
//     scrollWidth > clientWidth + 1, and neither does the document. This is checked at the default window size and at
//     the smallest one the app allows (900 × 600, read from the window itself).
//   - One scroll region per screen: the document never scrolls (html's scrollHeight ≤ clientHeight + 1), and the only
//     elements that do (overflow-y auto or scroll, scrollHeight > clientHeight + 1) are <main>, the page's scroller,
//     and the allowed inner regions, each marked data-scroll-region with a name on the whitelist (scroll-regions.ts:
//     a vendor stream, the log, a menu, the palette's results, …).
// The controls whose text or state changes must also keep their width (±0.5 px) through every state. A
// MutationObserver samples the control on every DOM change while the test drives it, so brief states (busy,
// Checking…, Starting…, a card choice being sent) are measured as well. Where state text sits beside a control, the
// control must also keep its place.
//
// 1. Logged out (the fake `auth status` answers "not logged in"):
//    - the Dashboard, empty and then blocked, with the pass rows open, the preflight strip and the setup card;
//    - then at the smallest window: Run keeps its place in its row (neither pushed along nor wrapped onto a new line)
//      while the status beside it goes from "Fix 1 issue to run" to nothing to Starting…;
//    - Settings → Vendors with the failing login check;
//    - the strip's login fix: one button that reads Copy, then [I ran it → Re-check], then Checking…;
//    - the "✓ N checks ok" chip keeps its width while logging in changes the count;
//    - Run through empty, blocked ("Fix 1 issue to run"), checking, enabled and starting.
// 2. A run:
//    - the Run view at the plan gate: Flow with the queued steps in the timeline (also at the smallest window), Log
//      and Config, and Edit/Preview;
//    - Run reading Queue beside "Folder busy" while that run holds the folder;
//    - Approve while it is being sent;
//    - the ask's Deny, and Undo while the pending deny counts down, in the Run view;
//    - Deny on the Dashboard (busy, then the toast's Undo);
//    - the completed run (Flow, also at the smallest window; Diff, Log), the Runs page and every Settings section once
//      it has what it reads (vendor Test, the notifications Pause/Resume).
// 3. The Diff tab of a run that changed 47 files (sources, an image, an EOL-only file): the file list closed
//    and open (Show / Hide the list keeps its width), Mark all reviewed through busy and its Undo (one width), the
//    diffs laid out split and stacked, at the default and the smallest window; then the Ctrl/Cmd+K palette open over
//    it (its results are the "palette" inner region), with results and with none.
// 4. A verify round: the composer's "Verify: N commands" (one width as the count arrives); the trust card
//    (Trust for this project through busy); the VerifyCard running (its output pane, the "verify-output" inner
//    region; a command's status word keeps one width from Waiting through Running to Passed) and failed (Show / Hide
//    the failure keeps its width); the verifyEnv card (Skip verify through busy); the gate before Fix with a finding
//    from Verify; then Settings → Isolation & Verify with a project's commands (one changed since it was trusted, its
//    script's diff under the row; Trust / Untrust and its busy state keep one width), at the default and the smallest
//    window.
// 5. An isolated run: the composer with Isolated run chosen (it keeps its width; the line under the controls
//    counts the uncommitted change it leaves out); the depsConsent card (Edit command's editor refusing shell syntax,
//    Install through busy); the PrepareCard installing (its output, the "prepare-output" inner region; the deps row's
//    status word keeps one width); the finalize card; the Diff tab's live Apply panel (Show / Hide the conflicts keeps
//    its width); Apply to folder through busy and the finalizeConflicts card (Show / Hide the run's change, Keep mine);
//    the applied run; then Settings → Isolation & Verify with the Isolation half live for a project (Edit / Done of the
//    copy-ins keeps one width), at the default and the smallest window.
// 6. The Runs history with 130 earlier runs (seeded before launch) and a run stopped at its findings gate: the
//    Stop toast with two actions (Revert all, Re-run from Fix); the summary tiles (one size from Loading… to their
//    figures, for each period); 100 runs, then all after Load more (one width through busy); every filter set with a
//    custom date range open, and none matching (Clear filters keeps its width enabled and disabled); Pin pressed and
//    not; a removed run's undo row and its toast (Undo keeps its width through busy); a row's actions menu and the
//    findings picker under the row; the Run view's Re-run menu (Re-run ▾ keeps its width while the picker's findings
//    are read) and its picker at the end of the Flow tab, whose start button keeps one width from 3 findings through
//    none and while it starts; the re-run from Fix, completed, and its row. At the default and the smallest window.
// 7. The catalog: the Dashboard's consent card once a refresh is due (Update now through busy; Not now and
//    Turn off keep their width while it is) and while the update runs; Settings → Catalog with the update running
//    (the review block's reserved line; Cancel through busy), Update now there through busy and disabled while it
//    runs, the changes waiting behind Show changes, the review table (Apply N changes keeps one width from 1 through 0
//    to 3 and while it applies), the applied state with its toast and the history's Undo, a price edited by hand (a
//    refused value in the row; Save through busy) and the history after an undo (Undo through busy). At the default
//    and the smallest window.
// 8. Codex with the fake Codex: on Windows the Dashboard with the Codex sandbox not set up (the strip's and the
//    setup card's sandbox chips), the chip through running, a setup that did not finish (the elevated command) and
//    ready ([Set up the Codex sandbox] keeps its width and place under its changing status line; once the sandbox is
//    ready the chip is that line alone, not cut at the default or the smallest window); Settings → Vendors
//    with the Codex card (Test through Checking…) and a local preset (its Test; the add form); a balanced run at
//    Claude's plan gate, a Codex command ask and the completed run whose Fix continued the Codex thread. At the default
//    and the smallest window.
// 9. Gemini with the fake Gemini: the Dashboard with four passes on Gemini in a folder not trusted for it (the
//    strip's trust chip and the setup card's; [Trust this folder for Gemini] keeps its width and place under its
//    changing status line, in both), trusted; a run on Gemini: its native plan at the gate, a Gemini ask, the completed
//    run whose Fix continued the Gemini session, the Log with the read-only Critic's auto-answered requests; Settings →
//    Vendors with the Gemini card (Test through Checking…) and its trusted folder (Revoke, then Undo). At the default
//    and the smallest window.
// 10. Grok and Muse with the fake Grok and the fake Muse: the "More" list with both (Grok; Muse with its
//    Experimental badge), open, at the default and the smallest window; Grok on Implement (its Approve edits not
//    available, the reason in words) and Muse on Critic (blocked: no read-only mode); Grok on Review and Muse on
//    Implement in a folder not trusted for Muse (the trust chip; [Trust this folder for Muse] keeps its width and place
//    under its changing status line), trusted; the run (Muse's Implement card with its no-relay copy, the completed run,
//    the Log with Grok's auto-answered requests); Settings → Vendors with the Grok and the Muse card (Test through
//    Checking… keeps its width; Muse's Experimental badge and trusted folder). At the default and the smallest window.
//
// The vendor text on screen (the plan, the streams) comes from the fake's recordings, and none of what they show has
// an em dash; a recording that did would need that text left out of the audit.
//
// Set DIM_FACTORY_E2E_SHOTS_DIR to also save screenshots of the Dashboard, the Run view at the plan gate and
// Settings → Vendors there.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { openDiffTab, openPalette, settingsLoaded, solidPng } from './diff-settings-helpers.ts'
import {
  CHATTY_SCRIPT,
  CHECK_ARGV,
  CHECK_SCRIPT,
  chattyArgv,
  releaseChatty,
  setScripts,
  trustCommand,
  verifyFlow,
  writeSandbox,
} from './verify-helpers.ts'
import { keepingClipboard, logOut } from './dashboard-helpers.ts'
import { advanceClock, nextAsk, toasts } from './attention-helpers.ts'
import { gitOut } from './git-helpers.ts'
import {
  INSTALL_SCRIPT,
  commitSandbox,
  isolatedConfig,
  releaseInstall,
  slowInstallArgv,
  writeBeforeResult,
} from './isolated-helpers.ts'
import { RESUMED_FIX, findingsFlow, manyRows, seedHistory } from './history-helpers.ts'
import {
  DAY_MS,
  E21_PROPOSAL,
  INTERVAL_DAYS,
  ROW,
  consentCard,
  loadRefreshConverter,
  withRefreshes,
} from './catalog-helpers.ts'
import { IS_WIN32, editPass, resumePass, threadIdNow } from './codex-helpers.ts'
import * as gem from './gemini-helpers.ts'
import { grokReview, museEditPass, pickFromMore } from './grok-muse-helpers.ts'
import { SCROLL_REGIONS } from './scroll-regions.ts'
import { VERSION_WRITE } from './scenarios.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

/** The tracked file an isolated run's Implement changes (the user edits it too: a conflict). */
const RUN_INDEX = { path: 'src/index.ts', content: 'export const greeting = "from the run"\n' }

/** U+2014, written as a code point so this file has no em dash of its own. */
const EM_DASH = String.fromCharCode(0x2014)
/** "The bounding-box width is identical (±0.5 px) across states." */
const TOLERANCE_PX = 0.5
const SHOTS_DIR = process.env['DIM_FACTORY_E2E_SHOTS_DIR'] ?? ''

/** A screenshot into DIM_FACTORY_E2E_SHOTS_DIR, if set; `frame` first brings the part worth seeing into view. */
async function shot(page: Page, name: string, frame?: () => Promise<void>): Promise<void> {
  if (SHOTS_DIR === '') return
  await frame?.()
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

// ---- the copy and layout audit --------------------------------------------------------------------------------------

/** Attributes whose text a user sees or hears (data-label: a StableLabel's reserved label). */
const TEXT_ATTRIBUTES = [
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'placeholder',
  'alt',
  'data-label',
] as const

interface AuditFindings {
  emDash: string[]
  scroll: string[]
  vertical: string[]
}

/** Both rules on the page as it is now; `where` names the screen in the failure message. */
async function audit(page: Page, where: string): Promise<void> {
  const found = await page.evaluate(
    ([em, attributes, regions]): AuditFindings => {
      const name = (el: Element): string => {
        const id = el.getAttribute('data-testid')
        if (id !== null) return `[data-testid="${id}"]`
        const owner = el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid')
        const cls =
          typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
        return `${el.tagName.toLowerCase()}${cls !== '' ? `.${cls}` : ''}${owner !== undefined && owner !== null ? ` in [data-testid="${owner}"]` : ''}`
      }
      const emDash: string[] = []
      if (document.title.includes(em)) emDash.push(`document.title: ${document.title}`)
      for (const line of document.body.innerText.split('\n'))
        if (line.includes(em)) emDash.push(`text: ${line.trim().slice(0, 200)}`)
      for (const el of document.body.querySelectorAll('*')) {
        for (const a of attributes) {
          const v = el.getAttribute(a)
          if (v?.includes(em) === true) emDash.push(`${name(el)} ${a}: ${v.slice(0, 200)}`)
        }
        // Generated content (a CSS `content`, escapes resolved), which innerText does not include.
        for (const pseudo of ['::before', '::after']) {
          const content = getComputedStyle(el, pseudo).content
          if (content.includes(em)) emDash.push(`${name(el)} ${pseudo} content: ${content.slice(0, 200)}`)
        }
      }

      // Every element under a root, open shadow roots included (the Diff tab's code view is @pierre/diffs' shadow
      // DOM): its scrollers count too.
      const deep = (root: Element | ShadowRoot): Element[] =>
        [...root.querySelectorAll('*')].flatMap((el) =>
          el.shadowRoot !== null ? [el, ...deep(el.shadowRoot)] : [el],
        )
      const scroll: string[] = []
      const doc = document.documentElement
      if (doc.scrollWidth > doc.clientWidth + 1)
        scroll.push(`the document: scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}`)
      const main = document.querySelector('main')
      if (main === null) scroll.push('there is no <main>')
      else
        for (const el of [main, ...deep(main)]) {
          const ox = getComputedStyle(el).overflowX
          if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1)
            scroll.push(`${name(el)}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`)
        }

      const vertical: string[] = []
      if (doc.scrollHeight > doc.clientHeight + 1)
        vertical.push(`the document: scrollHeight ${doc.scrollHeight} > clientHeight ${doc.clientHeight}`)
      for (const el of deep(document.body)) {
        const oy = getComputedStyle(el).overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1)
          if (el !== main && !el.hasAttribute('data-scroll-region'))
            vertical.push(`${name(el)}: scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`)
        const region = el.getAttribute('data-scroll-region')
        if (region !== null && !regions.includes(region))
          vertical.push(`${name(el)}: data-scroll-region="${region}" is not on the whitelist`)
      }
      return { emDash, scroll, vertical }
    },
    [EM_DASH, TEXT_ATTRIBUTES, SCROLL_REGIONS] as const,
  )
  expect(found.emDash, `${where}: em dashes in the UI`).toEqual([])
  expect(found.scroll, `${where}: horizontal scrolling`).toEqual([])
  expect(found.vertical, `${where}: a scroll region besides <main> and the marked inner regions`).toEqual([])
}

// ---- window sizes ---------------------------------------------------------------------------------------------------

type Size = readonly [width: number, height: number]

/** The window's size now and the smallest it allows (src/main/constants.ts WINDOW_SIZE.minWidth × minHeight). */
async function windowSizes(e2e: E2EHarness): Promise<{ size: Size; min: Size }> {
  if (e2e.app === null) throw new Error('the app is not running')
  return e2e.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const [w = 0, h = 0] = win.getSize()
    const [mw = 0, mh = 0] = win.getMinimumSize()
    return { size: [w, h] as const, min: [mw, mh] as const }
  })
}

/** Resize the window and wait until the page has laid itself out at the new size. */
async function resizeWindow(e2e: E2EHarness, page: Page, size: Size): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  const content = await e2e.app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    win.setSize(w, h)
    const [cw = 0, ch = 0] = win.getContentSize()
    return [cw, ch] as const
  }, size)
  await page.waitForFunction(
    ([cw, ch]) => Math.abs(window.innerWidth - cw) <= 1 && Math.abs(window.innerHeight - ch) <= 1,
    content,
  )
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** The smallest window the app allows, checked to be 900 × 600; resolves to a function that restores the size. */
async function toSmallestWindow(e2e: E2EHarness, page: Page): Promise<() => Promise<void>> {
  const { size, min } = await windowSizes(e2e)
  expect(min).toEqual([900, 600])
  await resizeWindow(e2e, page, min)
  return () => resizeWindow(e2e, page, size)
}

/** The audit at the smallest window as well, then back to the size it had. */
async function auditAtSmallest(e2e: E2EHarness, page: Page, where: string): Promise<void> {
  const restore = await toSmallestWindow(e2e, page)
  await audit(page, `${where} at the smallest window`)
  await restore()
}

// ---- control widths -------------------------------------------------------------------------------------------------

interface Sample {
  w: number
  /** Its height (checked with `fixedH`, e.g. a tile from Loading… to its figures). */
  h: number
  /**
   * Where the control sits across: its left edge from the anchor's left edge (Target.anchor), or with `edge: 'right'`
   * its right edge from the anchor's right edge; without an anchor, from the viewport's.
   */
  x: number
  /** Its top edge, from the anchor's top edge, else from the viewport's. */
  y: number
  /** The control's visible text (whitespace collapsed; a key chip's letter included). */
  label: string
  busy: boolean
  disabled: boolean
  testId: string
  /** The state text beside the control, when the target names it. */
  status: string
}

interface Target {
  /** CSS selector of the control; the first match (whose label matches `label`, if given) is sampled. */
  selector: string
  /** A regular expression (source) the control's label must match. */
  label?: string
  /** CSS selector of the state text shown beside the control. */
  status?: string
  /** CSS selector of the row the control sits in: `x` and `y` are measured from it. */
  anchor?: string
  /** Which edge `x` is measured from: the left (default), or the right for a control anchored at a row's end. */
  edge?: 'left' | 'right'
}

type TrackWindow = Window & { __uiTracks?: Record<string, () => Sample[]> }

/**
 * Start sampling a control on every DOM change (and now). The control is looked up again each time, so a remount
 * (a new wrapper, a route change and back) is followed; while it is absent nothing is sampled.
 */
async function track(page: Page, name: string, t: Target): Promise<void> {
  await page.evaluate(
    ([n, selector, labelRe, statusSel, anchorSel, edge]) => {
      const re = labelRe === null ? null : new RegExp(labelRe)
      const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const find = (): HTMLElement | null => {
        for (const el of document.querySelectorAll<HTMLElement>(selector))
          if (re === null || re.test(el.innerText.replace(/\s+/g, ' ').trim())) return el
        return null
      }
      const samples: Sample[] = []
      const take = (): void => {
        const el = find()
        if (el === null) return
        const r = el.getBoundingClientRect()
        if (r.width === 0) return
        const a =
          anchorSel === null ? null : (document.querySelector(anchorSel)?.getBoundingClientRect() ?? null)
        const s: Sample = {
          w: r.width,
          h: r.height,
          x: edge === 'right' ? (a?.right ?? window.innerWidth) - r.right : r.left - (a?.left ?? 0),
          y: r.top - (a?.top ?? 0),
          label: el.innerText.replace(/\s+/g, ' ').trim(),
          busy: el.getAttribute('aria-busy') === 'true',
          disabled: el.matches(':disabled'),
          testId: el.getAttribute('data-testid') ?? '',
          status: statusSel === null ? '' : text(document.querySelector(statusSel)),
        }
        const last = samples.at(-1)
        if (last === undefined || JSON.stringify(last) !== JSON.stringify(s)) samples.push(s)
      }
      take()
      const mo = new MutationObserver(take)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      const w = window as TrackWindow
      w.__uiTracks ??= {}
      w.__uiTracks[n] = () => {
        take()
        mo.disconnect()
        return samples
      }
    },
    [name, t.selector, t.label ?? null, t.status ?? null, t.anchor ?? null, t.edge ?? 'left'] as const,
  )
}

async function stopTracking(page: Page, name: string): Promise<Sample[]> {
  return page.evaluate((n) => {
    const stop = (window as TrackWindow).__uiTracks?.[n]
    if (stop === undefined) throw new Error(`no tracker called ${n}`)
    return stop()
  }, name)
}

function describeSamples(samples: readonly Sample[]): string {
  return samples
    .map(
      (s) =>
        `  ${s.testId !== '' ? `[${s.testId}] ` : ''}"${s.label}"${s.busy ? ' busy' : ''}${s.disabled ? ' disabled' : ''}` +
        `${s.status !== '' ? ` beside "${s.status}"` : ''}: ${s.w.toFixed(2)} × ${s.h.toFixed(2)} px at x ${s.x.toFixed(2)}, y ${s.y.toFixed(2)}`,
    )
    .join('\n')
}

/**
 * Every sample has the first one's width within ±0.5 px; with `fixedX`, also its place across from the anchor (the
 * state text beside it never pushes it along), with `fixedY` its place down (it never wraps onto a new line), and with
 * `fixedH` its height (a tile whose text changes never grows and pushes the page down).
 */
function expectSteady(
  samples: readonly Sample[],
  what: string,
  o: { fixedX?: boolean; fixedY?: boolean; fixedH?: boolean } = {},
): void {
  const first = samples[0]
  if (first === undefined) throw new Error(`${what}: the control was never measured`)
  const off = samples.filter(
    (s) =>
      Math.abs(s.w - first.w) > TOLERANCE_PX ||
      (o.fixedX === true && Math.abs(s.x - first.x) > TOLERANCE_PX) ||
      (o.fixedY === true && Math.abs(s.y - first.y) > TOLERANCE_PX) ||
      (o.fixedH === true && Math.abs(s.h - first.h) > TOLERANCE_PX),
  )
  expect(off, `${what} changed size or moved across its states:\n${describeSamples(samples)}`).toEqual([])
}

const seen = (samples: readonly Sample[], pick: (s: Sample) => string): string[] => [
  ...new Set(samples.map(pick)),
]

// ---- shared steps ---------------------------------------------------------------------------------------------------

const RUN_BUTTON: Target = {
  selector: '[data-testid="composer-run"]',
  status: '[data-testid="composer-run-status"]',
}

/** Open the composer's pass rows and every row in them. */
async function openPassRows(page: Page): Promise<void> {
  const toggle = page.getByTestId('composer-passes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const rows = page.locator('[data-testid^="pass-row-toggle-"]')
  await expect(rows.first()).toBeVisible()
  for (const row of await rows.all()) {
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
  }
}

/**
 * Open the preflight strip's chips. Core's answers never open them on their own (UI standard: async content never
 * shifts the page), so the user does, from the strip's summary row.
 */
async function showChecks(page: Page): Promise<void> {
  const toggle = page.getByTestId('preflight-details')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

async function typeFolderAndTask(page: Page, folder: string, task: string): Promise<void> {
  const input = page.getByTestId('composer-folder-input')
  await input.fill(folder)
  await input.press('Enter')
  await page.getByTestId('composer-task').fill(task)
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.evaluate((id) => {
    location.hash = `#/runs/${id}`
  }, runId)
  await expect(page.getByTestId('run-view')).toBeVisible()
}

// ---- 1. logged out ---------------------------------------------------------------------------------------------------

test(
  'UI standards: logged out, the Dashboard, the login fix and Run keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    let login = (): void => {
      throw new Error('the scenario was not logged out')
    }
    const page = await e2e.start({
      scenario: { plan: { recording: 'C06-plan-native-host' } },
      editScenario: (sc) => {
        login = logOut(sc).login
      },
    })
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'login-needed')
    await expect(page.getByTestId('setup-card')).toBeVisible()
    const run = page.getByTestId('composer-run')
    await expect(run).toBeVisible()

    // ---- the empty Dashboard; Run is sampled from here until the run starts ----
    await track(page, 'run', RUN_BUTTON)
    await audit(page, 'Dashboard (empty, logged out)')

    // ---- folder and task: the login blocker; the pass rows open ----
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await showChecks(page)
    const chip = page.getByTestId('preflight-strip').getByTestId('preflight-chip-vendor.claude.auth')
    await expect(chip).toHaveAttribute('data-severity', 'blocking')
    await expect(run).toBeDisabled()
    await expect(run).toHaveText('Run')
    await expect(run).toHaveAccessibleName('Run')
    await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run')
    await track(page, 'passes', { selector: '[data-testid="composer-passes-toggle"]' })
    await openPassRows(page)
    await audit(page, 'Dashboard (logged out: the login blocker, the pass rows open, the setup card)')

    // ---- the rest of this test at the smallest window: Run keeps its place at the end of its row ----
    await toSmallestWindow(e2e, page)
    await audit(page, 'Dashboard at the smallest window (logged out, the pass rows open)')
    const status = page.getByTestId('composer-run-status')
    await expect(status).toHaveText('Fix 1 issue to run')
    // Even here the whole status fits beside Run (it would be cut with an ellipsis before it could wrap the row).
    expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await track(page, 'run-place', {
      ...RUN_BUTTON,
      anchor: '[data-testid="composer-run-row"]',
      edge: 'right',
    })

    // ---- the login fix: Copy → [I ran it → Re-check] → Checking… → Copy again, one button of one width ----
    await track(page, 'fix', {
      selector: '[data-testid="preflight-chip-vendor.claude.auth"] [data-kind="shell_copy"]',
    })
    await keepingClipboard(e2e, async () => {
      await chip.getByTestId('recovery-claude.login').click()
      await expect(chip.getByTestId('recheck-claude.login')).toBeVisible()
    })
    // Only the visible label is exposed: the reserved labels are aria-hidden.
    await expect(chip.getByTestId('recheck-claude.login')).toHaveAccessibleName('I ran it → Re-check')
    await expect(page.getByText('Copied. Run it in a terminal.')).toBeVisible()
    await audit(page, 'Dashboard (the login command copied)')
    // Still logged out: the re-check offers the copy again.
    await chip.getByTestId('recheck-claude.login').click()
    await expect(chip.getByTestId('recovery-claude.login')).toBeVisible({ timeout: 30_000 })
    await expect(chip.getByTestId('recovery-claude.login')).toHaveAccessibleName('Copy the login command')
    const fix = await stopTracking(page, 'fix')
    expectSteady(fix, 'the login fix button (Copy / Re-check / Checking…)')
    expect(seen(fix, (s) => s.testId).sort()).toEqual(['recheck-claude.login', 'recovery-claude.login'])
    expect(seen(fix, (s) => s.label)).toEqual(
      expect.arrayContaining(['Copy the login command', 'I ran it → Re-check', 'Checking…']),
    )

    const passes = await stopTracking(page, 'passes')
    expectSteady(passes, 'the Passes / Hide passes toggle')

    // ---- Settings → Vendors with the failing login check and its fix ----
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'vendors')
    await expect(page.getByTestId('settings-vendor-claude')).toContainText('Claude Code is not logged in')
    await audit(page, 'Settings → Vendors (logged out)')
    await page.getByTestId('nav-dashboard').click()
    await expect(page.getByTestId('composer')).toBeVisible()

    // ---- logged in: copy, Re-check, and Run is enabled with nothing beside it ----
    login()
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    // The re-check after logging in passes more checks: the chip's count changes under the tracker.
    await expect(page.getByTestId('preflight-ok')).toBeVisible()
    await track(page, 'checks-ok', { selector: '[data-testid="preflight-ok"]' })
    // The Dashboard was left for Settings: its strip's chips are closed again.
    await showChecks(page)
    await keepingClipboard(e2e, async () => {
      await chip.getByTestId('recovery-claude.login').click()
      await expect(chip.getByTestId('recheck-claude.login')).toBeVisible()
    })
    await chip.getByTestId('recheck-claude.login').click()
    await expect(run).toBeEnabled({ timeout: 30_000 })
    await expect(run).toHaveText('Run')
    await expect(page.getByTestId('composer-run-status')).toHaveText('')
    await audit(page, 'Dashboard (logged in, ready to run)')
    const checksOk = await stopTracking(page, 'checks-ok')
    expectSteady(checksOk, 'the "✓ N checks ok" chip')
    expect(
      seen(checksOk, (s) => s.label).length,
      `the count never changed under the tracker:\n${describeSamples(checksOk)}`,
    ).toBeGreaterThan(1)

    // ---- Run: Starting… beside it, then the Run view ----
    await run.click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const created = await e2e.onlyRun()
    await expect(page.getByTestId('run-view')).toBeVisible()
    const runSamples = await stopTracking(page, 'run')
    expectSteady(runSamples, 'Run')
    expect(seen(runSamples, (s) => s.label)).toEqual(['Run'])
    expect(seen(runSamples, (s) => s.status)).toEqual(expect.arrayContaining(['', 'Fix 1 issue to run']))
    expect(
      runSamples.some((s) => s.busy),
      `Run was never measured while starting:\n${describeSamples(runSamples)}`,
    ).toBe(true)
    const place = await stopTracking(page, 'run-place')
    expectSteady(place, 'Run at the smallest window', { fixedX: true, fixedY: true })
    expect(seen(place, (s) => s.status)).toEqual(expect.arrayContaining(['', 'Fix 1 issue to run']))
    expect(
      place.some((s) => s.busy),
      `Run was never measured while starting:\n${describeSamples(place)}`,
    ).toBe(true)

    await e2e.call('runs.stop', { runId: created.runId })
    await e2e.waitForEnd(created.runId)
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 2. a run, the Runs page and Settings -----------------------------------------------------------------------------

test(
  'UI standards: the Run view, cards, asks, the Runs page and Settings keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    // Plan → the plan gate → Implement asks to run `npm --version` (twice; allowed once each) and writes a file →
    // NO FINDINGS reviewers → Fix skipped: a clean run.
    const page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
      },
    })
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
    const run = page.getByTestId('composer-run')
    await expect(run).toBeVisible()
    await track(page, 'run', RUN_BUTTON)

    // ---- the Dashboard ready to run: pass rows open, the checks that passed listed, the setup card ----
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await expect(run).toBeEnabled()
    await openPassRows(page)
    // (The "✓ N checks ok" chip's width is checked in the first test, where logging in changes its count.)
    const ok = page.getByTestId('preflight-ok')
    await expect(ok).toBeVisible()
    await ok.click()
    await expect(page.getByTestId('preflight-ok-list')).toBeVisible()
    await expect(page.getByTestId('setup-card')).toBeVisible()
    await audit(page, 'Dashboard (ready: pass rows open, checks listed, setup card)')
    await auditAtSmallest(e2e, page, 'Dashboard (ready: pass rows open, checks listed, setup card)')
    // The page scrolls in <main> only (the composer has no scroller of its own): its top (folder, task, Run) first.
    await shot(page, 'dashboard', () => page.getByTestId('main').evaluate((el) => el.scrollTo(0, 0)))
    await ok.click()
    await expect(page.getByTestId('preflight-ok-list')).toBeHidden()

    // ---- Run → the Run view at the plan gate ----
    await run.click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const created = await e2e.onlyRun()
    await expect(page.getByTestId('run-view')).toBeVisible()
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    // A queued step is a node in the timeline; its card joins the flow, at its end, once the step begins (UI
    // standard: nothing moves on its own).
    await expect(page.getByTestId('timeline-node-implement')).toBeVisible()
    await expect(page.getByTestId('pass-card-implement')).toHaveCount(0)
    await audit(page, 'Run view at the plan gate (Flow, the queued steps in the timeline)')
    // The step timeline's fixed-width nodes wrap rather than scroll once the window is too narrow for them.
    await auditAtSmallest(e2e, page, 'Run view at the plan gate (Flow, the queued steps in the timeline)')
    await shot(page, 'run-view-plan-gate', () =>
      gate.getByTestId('card-choice-approve').scrollIntoViewIfNeeded(),
    )

    // Edit / Preview: one toggle, both labels reserved.
    await track(page, 'plan-edit', {
      selector: '[data-testid="card-gate:afterPlan"] [data-testid="plan-edit"]',
    })
    await gate.getByTestId('plan-edit').click()
    await expect(gate.getByTestId('plan-editor')).toBeVisible()
    await audit(page, 'Run view at the plan gate (editing the plan)')
    await gate.getByTestId('plan-edit').click()
    await expect(gate.getByTestId('plan-editor')).toBeHidden()
    const planEdit = await stopTracking(page, 'plan-edit')
    expectSteady(planEdit, 'Edit / Preview')
    expect(planEdit.length).toBeGreaterThan(1)

    await page.getByTestId('run-tab-log').click()
    await expect(page.getByTestId('log-tab')).toBeVisible()
    await expect(page.getByTestId('log-rows')).toBeVisible()
    await audit(page, 'Run view at the plan gate (Log)')
    await page.getByTestId('run-tab-config').click()
    await expect(page.getByTestId('config-tab')).toBeVisible()
    await audit(page, 'Run view at the plan gate (Config)')
    await page.getByTestId('run-tab-flow').click()
    await expect(gate).toBeVisible()

    // ---- the Dashboard while the run holds the folder: Run reads Queue, "Folder busy" beside it ----
    await page.getByTestId('nav-dashboard').click()
    await expect(page.getByTestId('composer')).toBeVisible()
    await typeFolderAndTask(page, e2e.sandbox, 'add a --help flag')
    await expect(run).toHaveText('Queue')
    await expect(run).toHaveAccessibleName('Queue')
    await expect(page.getByTestId('composer-run-status')).toHaveText('Folder busy')
    await expect(page.getByTestId('needs-you')).toBeVisible()
    await audit(page, 'Dashboard (a run waiting at the plan gate; Run reads Queue)')
    await auditAtSmallest(e2e, page, 'Dashboard (a run waiting at the plan gate; Run reads Queue)')
    const runSamples = await stopTracking(page, 'run')
    expectSteady(runSamples, 'Run / Queue')
    expect(seen(runSamples, (s) => s.label).sort()).toEqual(['Queue', 'Run'])
    await page.getByTestId('composer-task').fill('')

    // ---- Approve while it is being sent ----
    await openRun(page, created.runId)
    await expect(gate).toBeVisible()
    await track(page, 'approve', {
      selector: '[data-testid="card-gate:afterPlan"] [data-testid="card-choice-approve"]',
    })
    await gate.getByTestId('card-choice-approve').click()
    await expect(gate).toBeHidden()
    const approve = await stopTracking(page, 'approve')
    expectSteady(approve, 'Approve')
    expect(
      approve.some((s) => s.busy),
      `Approve was never measured while being sent:\n${describeSamples(approve)}`,
    ).toBe(true)

    // ---- the ask in the Run view: Deny (busy), then Undo while the pending deny counts down ----
    const ask = page.getByTestId('ask-panel')
    const first = await nextAsk(page)
    await audit(page, 'Run view (an ask)')
    await track(page, 'deny', { selector: '[data-testid="ask-panel"] [data-testid="ask-deny"]' })
    await ask.getByTestId('ask-deny').click()
    const pending = page.getByTestId('ask-pending-deny')
    await expect(pending).toBeVisible()
    await track(page, 'undo', {
      selector: '[data-testid="ask-pending-deny"] [data-testid="ask-undo"]',
      status: '[data-testid="ask-pending-deny"] > span',
      anchor: '[data-testid="ask-pending-deny"]',
    })
    const deny = await stopTracking(page, 'deny')
    expectSteady(deny, 'Deny')
    expect(
      deny.some((s) => s.busy),
      `Deny was never measured while busy:\n${describeSamples(deny)}`,
    ).toBe(true)
    await expect(pending).toContainText(/Denied · sent in [12] s/)
    await audit(page, 'Run view (a pending deny)')
    await pending.getByTestId('ask-undo').click()
    await expect(ask.getByTestId('ask-allow')).toBeVisible()
    await expect(ask).toHaveAttribute('data-request-id', first)
    const undo = await stopTracking(page, 'undo')
    // The ticking count is in tabular figures: Undo neither resizes nor moves.
    expectSteady(undo, 'Undo', { fixedX: true })
    expect(
      seen(undo, (s) => s.status).length,
      `the countdown never ticked:\n${describeSamples(undo)}`,
    ).toBeGreaterThan(1)
    expect(
      undo.some((s) => s.busy),
      `Undo was never measured while busy:\n${describeSamples(undo)}`,
    ).toBe(true)
    await ask.getByTestId('ask-allow').click()

    // ---- the identical second ask from the Dashboard: Deny (busy), the toast's Undo, then Allow ----
    // Core leaves an ask out of Needs you while its deny waits out the grace, so the item goes and comes back.
    await nextAsk(page, first)
    await page.getByTestId('nav-dashboard').click()
    const item = page.locator('[data-testid^="needs-you-"][data-kind="ask"]')
    await expect(item).toBeVisible()
    await audit(page, 'Dashboard (an ask in Needs you)')
    await track(page, 'dashboard-deny', {
      selector: '[data-testid^="needs-you-"][data-kind="ask"] button',
      label: '^(Deny|Denied)$',
    })
    await item.getByRole('button', { name: 'Deny', exact: true }).click()
    const denied = toasts(page).filter({ hasText: 'Denied · Undo (3 s)' })
    await expect(denied).toBeVisible()
    await audit(page, 'Dashboard (a deny waiting for Undo)')
    await denied.getByRole('button', { name: 'Undo' }).click()
    await expect(item.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
    const dashboardDeny = await stopTracking(page, 'dashboard-deny')
    expectSteady(dashboardDeny, 'Deny on the Dashboard')
    expect(
      dashboardDeny.some((s) => s.busy),
      `Deny was never measured while busy:
${describeSamples(dashboardDeny)}`,
    ).toBe(true)
    await item.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(item).toBeHidden()

    // ---- the completed run ----
    const ended = await e2e.waitForEnd(created.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await openRun(page, created.runId)
    await expect(page.getByTestId('run-outcome')).toHaveText('Clean: no findings')
    await audit(page, 'Run view (completed, Flow)')
    await auditAtSmallest(e2e, page, 'Run view (completed, Flow)')
    await page.getByTestId('run-tab-diff').click()
    await expect(page.getByTestId('diff-tab')).toBeVisible()
    await expect(page.getByTestId('diff-tab')).toContainText('1 file changed')
    await audit(page, 'Run view (completed, Diff)')
    await page.getByTestId('run-tab-log').click()
    await expect(page.getByTestId('log-rows')).toBeVisible()
    await audit(page, 'Run view (completed, Log)')

    // ---- the Runs page ----
    await page.getByTestId('nav-runs').click()
    await expect(page.getByTestId(`runs-row-${created.runId}`)).toBeVisible()
    await audit(page, 'Runs')
    await auditAtSmallest(e2e, page, 'Runs')

    // ---- every Settings section ----
    await page.getByTestId('nav-settings').click()
    const links = page.locator('[data-testid^="settings-section-"]')
    await expect(links.first()).toBeVisible()
    const sections = (
      await links.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
    ).map((id) => id.slice('settings-section-'.length))
    expect(sections).toEqual(expect.arrayContaining(['vendors', 'appearance', 'notifications']))
    for (const id of sections) {
      await page.getByTestId(`settings-section-${id}`).click()
      const content = page.getByTestId('settings-content')
      await expect(content).toHaveAttribute('data-section', id)
      await settingsLoaded(page)
      if (id === 'vendors') {
        await expect(page.getByTestId('settings-vendor-claude')).toBeVisible()
        await audit(page, 'Settings → Vendors')
        await auditAtSmallest(e2e, page, 'Settings → Vendors')
        await shot(page, 'settings-vendors')
        // Test: the spinner takes the icon slot while the forced probe runs.
        await track(page, 'vendor-test', { selector: '[data-testid="vendor-test-claude"]' })
        await page.getByTestId('vendor-test-claude').click()
        await expect(page.getByTestId('vendor-test-claude')).toBeEnabled({ timeout: 30_000 })
        const vendorTest = await stopTracking(page, 'vendor-test')
        expectSteady(vendorTest, 'Test (Settings → Vendors)')
        expect(
          vendorTest.some((s) => s.busy),
          `Test was never measured while busy:
${describeSamples(vendorTest)}`,
        ).toBe(true)
        continue
      }
      if (id === 'notifications') {
        const pause = page.getByTestId('notif-pause')
        await expect(pause).toBeVisible()
        await audit(page, 'Settings → Notifications')
        await auditAtSmallest(e2e, page, 'Settings → Notifications')
        await track(page, 'notif-pause', { selector: '[data-testid="notif-pause"]' })
        await pause.click()
        await expect(pause).toHaveAttribute('data-paused', 'true')
        await audit(page, 'Settings → Notifications (paused)')
        await pause.click()
        await expect(pause).not.toHaveAttribute('data-paused', 'true')
        const pauseSamples = await stopTracking(page, 'notif-pause')
        expectSteady(pauseSamples, 'Pause / Resume (Settings → Notifications)')
        expect(seen(pauseSamples, (s) => s.label).length).toBeGreaterThan(1)
        continue
      }
      await audit(page, `Settings → ${id}`)
      await auditAtSmallest(e2e, page, `Settings → ${id}`)
    }
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 3. the Diff tab of a many-file run, and the palette -------------------------------------------------------------

/** What the run's Implement leaves besides src/version.ts: 44 sources, a changed image, an EOL-only file. */
const GENERATED = Array.from({ length: 44 }, (_, i) => ({
  path: `src/generated/module-${String(i + 1).padStart(2, '0')}.ts`,
  content: Array.from(
    { length: 6 + (i % 5) },
    (_, n) => `export const value${n} = ${i * 10 + n} // generated module ${i + 1}, line ${n + 1}`,
  ).join('\n'),
}))

test(
  'UI standards: the Diff tab of a many-file run and the palette keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(300_000)
    const page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE, delayMs: 10_000 }],
      },
    })
    const f = e2e.sandbox
    mkdirSync(join(f, 'assets'), { recursive: true })
    writeFileSync(join(f, 'assets/logo.png'), solidPng([200, 40, 40]))
    writeFileSync(join(f, 'notes.txt'), 'one\ntwo\n')
    gitOut(f, '-c', 'core.autocrlf=false', 'add', '-A')
    gitOut(f, 'commit', '-q', '-m', 'assets')

    const run = await e2e.runFromDashboard('add a --version flag')
    await e2e.approvePlan()
    await e2e.waitForLiveProc(run.runId, 'implement')
    mkdirSync(join(f, 'src/generated'), { recursive: true })
    for (const g of GENERATED) writeFileSync(join(f, g.path), `${g.content}\n`)
    writeFileSync(join(f, 'assets/logo.png'), solidPng([40, 40, 200]))
    writeFileSync(join(f, 'notes.txt'), 'one\r\ntwo\r\n')
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')

    // ---- the Diff tab: over 40 files, the list starts closed ----
    await openDiffTab(page, run.runId)
    await expect(page.getByTestId('diff-summary')).toContainText('47 files changed')
    const list = page.getByTestId('diff-list-toggle')
    await expect(list).toHaveAttribute('aria-expanded', 'false')
    const firstSource = page.locator('article[data-path="src/generated/module-01.ts"]')
    await expect(firstSource.locator('pre[data-diff-type]')).toHaveCount(1, { timeout: 30_000 })
    await audit(page, 'Diff tab (47 files, the list closed)')
    await auditAtSmallest(e2e, page, 'Diff tab (47 files, the list closed)')

    // Show / Hide the list: one width.
    await track(page, 'diff-list', { selector: '[data-testid="diff-list-toggle"]' })
    await list.click()
    await expect(list).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('diff-list-row')).toHaveCount(47)
    await audit(page, 'Diff tab (the list open)')
    await auditAtSmallest(e2e, page, 'Diff tab (the list open)')
    await list.click()
    await expect(list).toHaveAttribute('aria-expanded', 'false')
    const listSamples = await stopTracking(page, 'diff-list')
    expectSteady(listSamples, 'Show / Hide the list')
    expect(seen(listSamples, (s) => s.label).length).toBeGreaterThan(1)

    // Mark all reviewed: busy, then disabled with its reason; the toast's Undo brings it back. One width throughout.
    const markAll = page.getByTestId('diff-mark-all')
    await track(page, 'mark-all', { selector: '[data-testid="diff-mark-all"]' })
    await markAll.click()
    const marked = toasts(page).filter({ hasText: 'Marked 47 files reviewed' })
    await expect(marked).toHaveCount(1)
    await expect(markAll).toBeDisabled()
    await expect(page.getByTestId('diff-reviewed-count')).toContainText('47 of 47 reviewed')
    await audit(page, 'Diff tab (every file reviewed)')
    await marked.getByRole('button', { name: 'Undo' }).click()
    await expect(markAll).toBeEnabled()
    await expect(page.getByTestId('diff-reviewed-count')).toContainText('0 of 47 reviewed')
    expectSteady(await stopTracking(page, 'mark-all'), 'Mark all reviewed')

    // The whole page laid out (the user scrolls to its end: the last files' diffs, the image, the EOL-only row).
    await page.getByTestId('main').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(page.locator('[data-path="assets/logo.png"] [data-testid="diff-image-new"]')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[data-path="notes.txt"] [data-testid="diff-eol-only"]')).toBeVisible()
    await audit(page, 'Diff tab (scrolled to its end)')
    const layout = page.getByTestId('diff-layout')
    await layout.getByRole('radio', { name: 'Stacked' }).click()
    await expect(page.locator('pre[data-diff-type="single"]').first()).toBeVisible()
    await audit(page, 'Diff tab (stacked)')
    await auditAtSmallest(e2e, page, 'Diff tab (stacked)')
    await layout.getByRole('radio', { name: 'Split' }).click()
    await page.getByTestId('main').evaluate((el) => el.scrollTo({ top: 0 }))

    // ---- the palette over the Diff tab: with results, with none ----
    await openPalette(page)
    await expect(page.locator('[data-scroll-region="palette"]')).toBeVisible()
    await expect(page.getByTestId('palette-group-actions')).toBeVisible()
    await audit(page, 'the palette (in a run)')
    await auditAtSmallest(e2e, page, 'the palette (in a run)')
    await page.getByTestId('palette-input').fill('zzzz no such thing')
    await expect(page.getByTestId('palette')).toContainText('Nothing matches.')
    await audit(page, 'the palette (nothing matches)')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toHaveCount(0)
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 4. a verify round, its cards and Settings' Verify half ------------------------------------------------------------

test(
  'UI standards: a verify round, its cards and the Settings Verify half keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(300_000)
    // Verify on, after Implement only: `check` fails (Implement writes 0.1.0), `chatty` keeps the round running until
    // released, `lint` (npm run lint, not trusted yet) calls a program this computer does not have.
    const chatty = chattyArgv(e2e)
    const page = await e2e.start({
      scenario: verifyFlow('1.0.0'),
      config: {
        gates: { afterPlan: true, beforeFix: true },
        verify: {
          enabled: true,
          runAfter: ['implement'],
          commands: [
            { name: 'check', run: [...CHECK_ARGV] },
            { name: 'chatty', run: chatty },
            { name: 'lint', run: ['npm', 'run', 'lint'] },
          ],
        },
      },
      pickSandbox: true,
    })
    writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT, 'chatty.mjs': CHATTY_SCRIPT })
    setScripts(e2e, { lint: 'dim-factory-e2e-missing-linter --check .' })
    await trustCommand(e2e, CHECK_ARGV)
    await trustCommand(e2e, chatty)
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

    // ---- the composer: "Verify: 3 commands" keeps one width as the count arrives ----
    await track(page, 'verify-count', { selector: '[data-testid="verify-commands"]' })
    await openPassRows(page)
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await expect(page.getByTestId('verify-commands')).toHaveText('Verify: 3 commands')
    await expect(page.getByTestId('verify-enabled')).toBeChecked()
    const count = await stopTracking(page, 'verify-count')
    expectSteady(count, 'Verify: N commands')
    expect(seen(count, (s) => s.label)).toContain('Verify: 3 commands')
    await audit(page, 'Dashboard (Verify: 3 commands)')
    await auditAtSmallest(e2e, page, 'Dashboard (Verify: 3 commands)')

    // ---- the run: the plan gate, then the trust card for lint ----
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const created = await e2e.onlyRun()
    await e2e.approvePlan()
    const trust = page.getByTestId('card-trust')
    await expect(trust).toBeVisible({ timeout: 90_000 })
    await expect(trust.getByTestId('trust-command')).toHaveText('npm run lint')
    // The body is the package.json's scripts map, the lint script among them.
    await expect(trust.getByTestId('trust-script')).toContainText(
      '"lint": "dim-factory-e2e-missing-linter --check ."',
    )
    await audit(page, 'Run view (the trust card)')
    await auditAtSmallest(e2e, page, 'Run view (the trust card)')
    // The round's rows are there from the start; a command's status word keeps one width as it runs and ends.
    await track(page, 'chatty-status', { selector: '[data-testid="verify-command-verify:1-1-status"]' })
    await track(page, 'trust', { selector: '[data-testid="card-trust"] [data-testid="card-choice-trust"]' })
    await trust.getByTestId('card-choice-trust').click()
    await expect(trust).toBeHidden()
    const trustSamples = await stopTracking(page, 'trust')
    expectSteady(trustSamples, 'Trust for this project')
    expect(
      trustSamples.some((s) => s.busy),
      `Trust for this project was never measured while being sent:\n${describeSamples(trustSamples)}`,
    ).toBe(true)

    // ---- the round running: its output pane ----
    const card = page.getByTestId('pass-card-verify:1')
    await expect(card.getByTestId('verify-output-verify:1')).toContainText('chatty line 150', {
      timeout: 60_000,
    })
    await expect(card.getByTestId('verify-command-verify:1-1')).toHaveAttribute('data-status', 'running')
    await audit(page, 'Run view (a verify round running)')
    await auditAtSmallest(e2e, page, 'Run view (a verify round running)')

    // ---- the round ends: the verifyEnv card for lint, Skip verify ----
    releaseChatty(e2e)
    const env = page.getByTestId('card-verifyEnv')
    await expect(env).toBeVisible({ timeout: 60_000 })
    await expect(card.getByTestId('verify-command-verify:1-1')).toHaveAttribute('data-status', 'pass')
    const status = await stopTracking(page, 'chatty-status')
    expectSteady(status, "chatty's status (Waiting, Running, Passed)")
    expect(seen(status, (s) => s.label)).toEqual(expect.arrayContaining(['Running', 'Passed']))
    await expect(env.getByTestId('verify-env-0-why')).toHaveText(
      'A program it runs was not found: dim-factory-e2e-missing-linter',
    )
    await audit(page, 'Run view (the verifyEnv card)')
    await auditAtSmallest(e2e, page, 'Run view (the verifyEnv card)')

    // The failure's excerpt: Show / Hide the failure keeps one width.
    const toggle = '[data-testid="verify-command-verify:1-0-excerpt-toggle"]'
    await track(page, 'excerpt-toggle', { selector: toggle })
    await page.locator(toggle).click()
    await expect(card.getByTestId('verify-command-verify:1-0-excerpt')).toContainText(
      'expected version 1.0.0',
    )
    await audit(page, 'Run view (a failed verify round, its excerpt open)')
    await auditAtSmallest(e2e, page, 'Run view (a failed verify round, its excerpt open)')
    await page.locator(toggle).click()
    await expect(card.getByTestId('verify-command-verify:1-0-excerpt')).toHaveCount(0)
    await page.locator(toggle).click()
    const excerptToggle = await stopTracking(page, 'excerpt-toggle')
    expectSteady(excerptToggle, 'Show / Hide the failure')
    expect(seen(excerptToggle, (s) => s.label).sort()).toEqual(['Hide the failure', 'Show the failure'])

    await track(page, 'skip-verify', {
      selector: '[data-testid="card-verifyEnv"] [data-testid="card-choice-skip-verify"]',
    })
    await env.getByTestId('card-choice-skip-verify').click()
    await expect(env).toBeHidden()
    const skip = await stopTracking(page, 'skip-verify')
    expectSteady(skip, 'Skip verify')
    expect(
      skip.some((s) => s.busy),
      `Skip verify was never measured while being sent:\n${describeSamples(skip)}`,
    ).toBe(true)

    // ---- the gate before Fix with a finding from Verify, then the end ----
    const gate = page.getByTestId('card-gate:beforeFix')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    await expect(gate).toContainText('Verify')
    await audit(page, 'Run view (the gate before Fix with a finding from Verify)')
    await auditAtSmallest(e2e, page, 'Run view (the gate before Fix with a finding from Verify)')
    await gate.getByTestId('card-choice-continue').click()
    const ended = await e2e.waitForEnd(created.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await openRun(page, created.runId)
    await audit(page, 'Run view (completed, with a failed verify round)')
    await auditAtSmallest(e2e, page, 'Run view (completed, with a failed verify round)')

    // ---- Settings → Isolation & Verify with the project: a changed script, Trust / Untrust ----
    setScripts(e2e, { lint: 'dim-factory-e2e-missing-linter --check src' })
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-isolation').click()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'isolation')
    await page.getByTestId('verify-folder-choose').click()
    await settingsLoaded(page)
    const lint = page.getByTestId('verify-row-lint')
    await expect(lint).toHaveAttribute('data-trust', 'changed')
    await expect(page.getByTestId('verify-row-lint-diff')).toContainText(
      'dim-factory-e2e-missing-linter --check src',
    )
    await audit(page, "Settings → Isolation & Verify (a project's commands, one changed)")
    await auditAtSmallest(e2e, page, "Settings → Isolation & Verify (a project's commands, one changed)")
    await track(page, 'trust-button', { selector: '[data-testid="verify-row-lint-trust-button"]' })
    await page.getByTestId('verify-row-lint-trust-button').click()
    await expect(lint).toHaveAttribute('data-trust', 'trusted')
    await expect(page.getByTestId('verify-row-lint-trust-button')).toHaveText('Untrust')
    await page.getByTestId('verify-row-lint-trust-button').click()
    await expect(lint).toHaveAttribute('data-trust', 'untrusted')
    await expect(page.getByTestId('verify-row-lint-trust-button')).toHaveText('Trust')
    const trustButton = await stopTracking(page, 'trust-button')
    expectSteady(trustButton, 'Trust / Untrust (Settings → Isolation & Verify)')
    expect(seen(trustButton, (s) => s.label).sort()).toEqual(['Trust', 'Untrust'])
    await audit(page, "Settings → Isolation & Verify (a project's commands)")
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 5. an isolated run, its cards, the Apply panel and Settings' Isolation half ------------------------------------

test(
  'UI standards: an isolated run, its prepare and finalize cards, the Apply panel and the Settings Isolation half keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(300_000)
    // The run's isolated copy gets its dependencies from `node install.mjs <release>`, which keeps printing until the
    // test releases it; Implement changes src/index.ts (which the user also edits in the folder: a conflict) and
    // writes src/version.ts.
    const page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
      },
      editScenario: (sc) => writeBeforeResult(sc, 'implement-1', [RUN_INDEX]),
      config: isolatedConfig(
        { installCommand: slowInstallArgv(e2e) },
        { gates: { afterPlan: true, beforeFix: false } },
      ),
      pickSandbox: true,
    })
    commitSandbox(e2e, { 'install.mjs': INSTALL_SCRIPT })
    writeFileSync(join(e2e.sandbox, 'notes.txt'), 'my own notes\n')
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

    // ---- the composer: Isolated run keeps its width pressed; the line under it counts what it leaves out ----
    await openPassRows(page)
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await track(page, 'isolated', { selector: '[data-testid="isolation-worktree"]' })
    await page.getByTestId('isolation-worktree').click()
    await expect(page.getByTestId('isolation-worktree')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('isolation-warning')).toHaveText(
      '1 uncommitted change not included: isolated runs start from your last commit.',
      { timeout: 30_000 },
    )
    expectSteady(await stopTracking(page, 'isolated'), 'Isolated run')
    await audit(page, 'Dashboard (Isolated run chosen)')
    await auditAtSmallest(e2e, page, 'Dashboard (Isolated run chosen)')

    // ---- the depsConsent card: Edit command opens its editor in place; Install through busy ----
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const created = await e2e.onlyRun()
    const consent = page.getByTestId('card-depsConsent')
    await expect(consent).toBeVisible({ timeout: 120_000 })
    await audit(page, 'Run view (the depsConsent card)')
    await auditAtSmallest(e2e, page, 'Run view (the depsConsent card)')
    const editSel = '[data-testid="card-depsConsent"] [data-testid="card-choice-edit-command"]'
    await track(page, 'edit-command', { selector: editSel })
    await page.locator(editSel).click()
    await expect(consent.getByTestId('deps-edit')).toBeVisible()
    await consent.getByTestId('deps-edit-line').fill('node install.mjs | tee log.txt')
    await consent.getByTestId('deps-edit-use').click()
    await expect(consent.getByTestId('deps-edit-error')).not.toHaveText('')
    await audit(page, 'Run view (the depsConsent card, editing its command)')
    await consent.getByTestId('deps-edit-cancel').click()
    await expect(consent.getByTestId('deps-edit')).toHaveCount(0)
    expectSteady(await stopTracking(page, 'edit-command'), 'Edit command')
    const installSel = '[data-testid="card-depsConsent"] [data-testid="card-choice-install"]'
    await track(page, 'install', { selector: installSel })
    await page.locator(installSel).click()
    await expect(consent).toBeHidden()
    const install = await stopTracking(page, 'install')
    expectSteady(install, 'Install')
    expect(
      install.some((s) => s.busy),
      `Install was never measured while being sent:\n${describeSamples(install)}`,
    ).toBe(true)

    // ---- the PrepareCard running: its install output (the "prepare-output" inner region) ----
    const prep = page.getByTestId('pass-card-prepare')
    await track(page, 'deps-status', { selector: '[data-testid="prepare-step-deps-status"]' })
    await expect(prep.getByTestId('prepare-output')).toContainText('(60)', { timeout: 60_000 })
    await expect(prep.getByTestId('prepare-step-deps')).toHaveAttribute('data-status', 'running')
    await audit(page, 'Run view (installing dependencies, their output)')
    await auditAtSmallest(e2e, page, 'Run view (installing dependencies, their output)')
    releaseInstall(e2e)
    await expect(prep.getByTestId('prepare-step-deps')).toHaveAttribute('data-status', 'done', {
      timeout: 60_000,
    })
    const depsStatus = await stopTracking(page, 'deps-status')
    expectSteady(depsStatus, "The deps row's status (Running, Done)")
    expect(seen(depsStatus, (s) => s.label).length).toBeGreaterThanOrEqual(2)

    // ---- the plan gate; meanwhile the user edits a file the run changes too ----
    writeFileSync(join(e2e.sandbox, RUN_INDEX.path), 'export const greeting = "my edit"\n')
    await e2e.approvePlan()

    // ---- the finalize card ----
    const fin = page.getByTestId('card-finalize')
    await expect(fin).toBeVisible({ timeout: 180_000 })
    await expect(fin).toContainText('also changed in your folder')
    await audit(page, 'Run view (the finalize card)')
    await auditAtSmallest(e2e, page, 'Run view (the finalize card)')

    // ---- the Diff tab's Apply panel (live); Show / Hide the conflicts keeps one width ----
    await openDiffTab(page, created.runId)
    const panel = page.getByTestId('diff-apply-panel')
    await expect(panel.getByTestId('diff-apply-facts')).toHaveText('1 file to write · 1 conflict')
    await expect(panel.getByTestId('diff-apply')).toBeEnabled()
    await audit(page, 'Diff tab (the Apply panel)')
    await auditAtSmallest(e2e, page, 'Diff tab (the Apply panel)')
    const conflictsToggle = '[data-testid="diff-apply-conflicts-toggle"]'
    await track(page, 'conflicts-toggle', { selector: conflictsToggle })
    await page.locator(conflictsToggle).click()
    await expect(panel.getByTestId('diff-apply-conflicts')).toContainText(RUN_INDEX.path)
    await audit(page, 'Diff tab (the Apply panel, its conflicts open)')
    await page.locator(conflictsToggle).click()
    await expect(panel.getByTestId('diff-apply-conflicts')).toHaveCount(0)
    const toggleSamples = await stopTracking(page, 'conflicts-toggle')
    expectSteady(toggleSamples, 'Show / Hide the conflicts')
    expect(seen(toggleSamples, (s) => s.label).sort()).toEqual(['Hide the conflicts', 'Show the conflicts'])
    await openRun(page, created.runId)

    // ---- Apply to folder through busy, then the conflicts card ----
    const applySel = '[data-testid="card-finalize"] [data-testid="card-choice-apply"]'
    await track(page, 'apply', { selector: applySel })
    await page.locator(applySel).click()
    const conflicts = page.getByTestId('card-finalizeConflicts')
    await expect(conflicts).toBeVisible({ timeout: 60_000 })
    const apply = await stopTracking(page, 'apply')
    expectSteady(apply, 'Apply to folder')
    expect(
      apply.some((s) => s.busy),
      `Apply to folder was never measured while being sent:\n${describeSamples(apply)}`,
    ).toBe(true)
    await audit(page, 'Run view (the finalizeConflicts card)')
    await auditAtSmallest(e2e, page, 'Run view (the finalizeConflicts card)')
    const showChange = '[data-testid="conflict-0-toggle"]'
    await track(page, 'show-change', { selector: showChange })
    await page.locator(showChange).click()
    await expect(conflicts.getByTestId('conflict-diff')).toContainText('from the run')
    await audit(page, "Run view (the finalizeConflicts card, the run's change open)")
    await page.locator(showChange).click()
    await expect(conflicts.getByTestId('conflict-diff')).toHaveCount(0)
    const change = await stopTracking(page, 'show-change')
    expectSteady(change, "Show / Hide the run's change")
    expect(seen(change, (s) => s.label).sort()).toEqual(["Hide the run's change", "Show the run's change"])
    const keepSel = '[data-testid="card-finalizeConflicts"] [data-testid="card-choice-keep-mine"]'
    await track(page, 'keep-mine', { selector: keepSel })
    await page.locator(keepSel).click()
    await expect(conflicts).toBeHidden()
    expectSteady(await stopTracking(page, 'keep-mine'), 'Keep mine')
    const ended = await e2e.waitForEnd(created.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('finalize-state')).toHaveAttribute('data-state', 'applied')
    await audit(page, 'Run view (applied, with Undo)')
    await auditAtSmallest(e2e, page, 'Run view (applied, with Undo)')

    // ---- Settings → Isolation & Verify: the Isolation half with the project; Edit / Done keeps one width ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-isolation').click()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'isolation')
    await page.getByTestId('verify-folder-choose').click()
    await settingsLoaded(page)
    await expect(page.getByTestId('isolation-install-ask')).toBeChecked()
    await audit(page, 'Settings → Isolation & Verify (the Isolation half)')
    await auditAtSmallest(e2e, page, 'Settings → Isolation & Verify (the Isolation half)')
    await track(page, 'copy-edit', { selector: '[data-testid="isolation-copy-edit"]' })
    await page.getByTestId('isolation-copy-edit').click()
    await expect(page.getByTestId('isolation-copy-editor')).toBeVisible()
    await page.getByTestId('isolation-copy-input').fill('.env.local')
    await page.getByTestId('isolation-copy-add').click()
    await expect(page.getByTestId('isolation-copy-summary')).toHaveText('.env.local')
    await audit(page, 'Settings → Isolation & Verify (the copy-ins editor open)')
    await auditAtSmallest(e2e, page, 'Settings → Isolation & Verify (the copy-ins editor open)')
    await page.getByTestId('isolation-copy-edit').click()
    await expect(page.getByTestId('isolation-copy-editor')).toHaveCount(0)
    const copyEdit = await stopTracking(page, 'copy-edit')
    expectSteady(copyEdit, 'Edit / Done (files to copy in)')
    expect(seen(copyEdit, (s) => s.label).sort()).toEqual(['Done', 'Edit'])
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 6. the Runs history, its row actions, the Stop toast, the findings picker and the Re-run menu -------------------

test(
  'UI standards: the Runs history, its row actions, the findings picker and the Re-run menu keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    // 130 earlier runs (seeded before launch), then a run that waits at its findings gate (F1, F2 [must], F3 [should])
    // and is stopped there; its re-run from Fix resumes Implement's session.
    const api = join(e2e.root, 'projects', 'api')
    seedHistory(e2e, manyRows(130, api, 'earlier api run'))
    const page = await e2e.start({
      scenario: findingsFlow([RESUMED_FIX]),
      config: { gates: { afterPlan: false, beforeFix: true } },
    })
    const { runId: source } = await e2e.call('runs.start', {
      folder: e2e.sandbox,
      task: 'add a --version flag',
      overrides: {},
    })

    // ---- Stop at the gate before Fix: the toast offers Revert all and Re-run from Fix, under its message ----
    await openRun(page, source)
    await expect(page.getByTestId('card-gate:beforeFix')).toBeVisible({ timeout: 120_000 })
    await page.getByTestId('stop-run').click()
    const stopped = page.locator(`[data-toast-id="stopped:${source}"]`)
    await expect(stopped).toContainText('Run stopped · changes kept', { timeout: 30_000 })
    await expect(stopped.locator('[data-toast-action="primary"]')).toHaveText('Revert all')
    await expect(stopped.locator('[data-toast-action="secondary"]')).toHaveText('Re-run from Fix')
    await audit(page, 'Run view (stopped: the toast with Revert all and Re-run from Fix)')
    await auditAtSmallest(e2e, page, 'Run view (stopped: the toast with Revert all and Re-run from Fix)')
    await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
    await stopped.getByRole('button', { name: 'Dismiss' }).click()
    await expect(stopped).toHaveCount(0)

    // ---- the Runs page: the tiles keep their size from Loading… to their figures, for each period ----
    await track(page, 'stat-runs', { selector: '[data-testid="runs-stat-runs"]' })
    await track(page, 'stats-range', { selector: '[data-testid="runs-stats-range-30d"]' })
    await page.getByTestId('nav-runs').click()
    await expect(page.getByTestId('runs-stat-runs-value')).toHaveText('131')
    await page.getByTestId('runs-stats-range-30d').click()
    await expect(page.getByTestId('runs-stats-range-30d')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('runs-stats')).toHaveAttribute('data-status', 'ready')
    await page.getByTestId('runs-stats-range-24h').click()
    await expect(page.getByTestId('runs-stats')).toHaveAttribute('data-status', 'ready')
    const statRuns = await stopTracking(page, 'stat-runs')
    // Its width (the grid's) and its height: the second line never collapses while core answers.
    expectSteady(statRuns, 'The Runs tile (Loading…, then its figure)', { fixedH: true })
    expect(seen(statRuns, (s) => s.label).length).toBeGreaterThan(1)
    expectSteady(await stopTracking(page, 'stats-range'), 'The 30 days period button')
    await expect(page.getByTestId('runs-count')).toHaveText('100 runs')
    await audit(page, 'Runs (100 of 131 runs)')
    await auditAtSmallest(e2e, page, 'Runs (100 of 131 runs)')

    // ---- every filter set (a status, the folder, the vendor, a custom date range, a title); Clear filters ----
    await track(page, 'clear-filters', { selector: '[data-testid="runs-filter-clear"]' })
    await page.getByTestId('runs-filter-completed').click()
    await page.getByTestId('runs-filter-folder').selectOption(api)
    await page.getByTestId('runs-filter-vendor').selectOption('claude')
    await page.getByTestId('runs-filter-date').selectOption('custom')
    await expect(page.getByTestId('runs-filter-from')).toBeVisible()
    await page.getByTestId('runs-filter-text').fill('earlier api run 1')
    await expect(page.getByTestId('runs-count')).not.toHaveText('100 runs')
    await audit(page, 'Runs (every filter set, a custom date range open)')
    await auditAtSmallest(e2e, page, 'Runs (every filter set, a custom date range open)')
    await page.getByTestId('runs-filter-text').fill('no such run')
    await expect(page.getByText('No runs match these filters')).toBeVisible()
    await audit(page, 'Runs (no run matches the filters)')
    await page.getByTestId('runs-filter-clear').click()
    await expect(page.getByTestId('runs-filter-clear')).toBeDisabled()
    await expect(page.getByTestId('runs-count')).toHaveText('100 runs')
    const clearFilters = await stopTracking(page, 'clear-filters')
    expectSteady(clearFilters, 'Clear filters')
    expect(seen(clearFilters, (s) => String(s.disabled)).sort()).toEqual(['false', 'true'])

    // ---- Load more through its busy state, then every run on the page ----
    await track(page, 'load-more', { selector: '[data-testid="runs-load-more"]' })
    await page.getByTestId('runs-load-more').click()
    await expect(page.getByTestId('runs-count')).toHaveText('131 runs')
    const loadMore = await stopTracking(page, 'load-more')
    expectSteady(loadMore, 'Load more')
    expect(
      loadMore.some((s) => s.busy),
      `Load more was never measured while busy:\n${describeSamples(loadMore)}`,
    ).toBe(true)
    await audit(page, 'Runs (131 runs, after Load more)')

    // ---- Pin keeps its width pressed; Remove leaves an undo row; its Undo keeps its width through busy ----
    const pinSel = `[data-testid="runs-pin-${source}"]`
    await track(page, 'pin', { selector: pinSel })
    await page.locator(pinSel).click()
    await expect(page.locator(pinSel)).toHaveAttribute('aria-pressed', 'true')
    await audit(page, 'Runs (a pinned run)')
    await page.locator(pinSel).click()
    await expect(page.locator(pinSel)).toHaveAttribute('aria-pressed', 'false')
    expectSteady(await stopTracking(page, 'pin'), 'Pin')
    await page.getByTestId(`runs-remove-${source}`).click()
    await expect(page.getByTestId(`runs-row-${source}`)).toHaveAttribute('data-removed', 'removed')
    await expect(toasts(page).filter({ hasText: 'Run #131 removed' })).toBeVisible()
    await audit(page, 'Runs (an undo row and its toast)')
    await auditAtSmallest(e2e, page, 'Runs (an undo row and its toast)')
    await track(page, 'undo', { selector: `[data-testid="runs-undo-${source}"]` })
    await page.getByTestId(`runs-undo-${source}`).click()
    await expect(page.getByTestId(`runs-row-${source}`)).toHaveAttribute('data-status', 'cancelled')
    expectSteady(await stopTracking(page, 'undo'), 'Undo (a removed run)')

    // ---- the row's actions menu, then the findings picker under the row ----
    await page.getByTestId(`runs-menu-${source}`).click()
    await expect(page.getByTestId('runs-action-rerun-fix-text')).toHaveText(
      'Fix would continue the Implement session',
    )
    await audit(page, "Runs (a row's actions menu)")
    await auditAtSmallest(e2e, page, "Runs (a row's actions menu)")
    await page.getByTestId('runs-action-rerun-fix').click()
    const rowPicker = page.getByTestId(`runs-fix-picker-${source}`)
    await expect(rowPicker).toBeVisible()
    await audit(page, 'Runs (the findings picker under a row)')
    await auditAtSmallest(e2e, page, 'Runs (the findings picker under a row)')
    await rowPicker.getByTestId('fix-picker-cancel').click()
    await expect(rowPicker).toHaveCount(0)

    // ---- the Run view: Re-run ▾ keeps its width while the picker's findings are read; the picker in the Flow tab ----
    await openRun(page, source)
    await page.getByTestId('rerun-menu').click()
    await expect(page.getByTestId('rerun-from-fix')).toContainText('Fix would continue the Implement session')
    await audit(page, 'Run view (stopped, the Re-run menu open)')
    // In the smallest window the header takes its compact form, whose Re-run ▾ is a menu of its own.
    const restore = await toSmallestWindow(e2e, page)
    if ((await page.getByTestId('rerun-from-fix').count()) === 0) await page.getByTestId('rerun-menu').click()
    await expect(page.getByTestId('rerun-from-fix')).toBeVisible()
    await audit(page, 'Run view (stopped, the compact Re-run menu open) at the smallest window')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('rerun-from-fix')).toHaveCount(0)
    await restore()
    await page.getByTestId('rerun-menu').click()
    await track(page, 'rerun-menu', { selector: '[data-testid="rerun-menu"]' })
    await page.getByTestId('rerun-from-fix').click()
    const picker = page.getByTestId(`fix-picker-${source}`)
    await expect(picker).toBeVisible()
    expectSteady(await stopTracking(page, 'rerun-menu'), 'Re-run ▾')
    await audit(page, 'Run view (the findings picker)')
    await auditAtSmallest(e2e, page, 'Run view (the findings picker)')

    // The picker's start button: one width from 3 findings through none (disabled) and back, and while it starts.
    await track(page, 'picker-start', {
      selector: `[data-testid="fix-picker-${source}"] [data-testid="fix-picker-start"]`,
    })
    await picker.getByTestId('fix-picker-untick-all').click()
    await expect(picker.getByTestId('fix-picker-start')).toBeDisabled()
    await expect(picker.getByTestId('fix-picker-receives')).toHaveText('Fix will receive 0 must · 0 should')
    await audit(page, 'Run view (the findings picker, nothing ticked)')
    await picker.getByTestId('fix-picker-tick-all').click()
    await expect(picker.getByTestId('fix-picker-start')).toHaveText('Re-run from Fix with 3 findings')
    await picker.getByTestId('fix-picker-start').click()
    await expect(page).not.toHaveURL(new RegExp(`#/runs/${source}$`))
    const pickerStart = await stopTracking(page, 'picker-start')
    expectSteady(pickerStart, 'Re-run from Fix with N findings')
    expect(seen(pickerStart, (s) => s.label).length).toBeGreaterThan(1)
    expect(
      pickerStart.some((s) => s.busy),
      `the picker's start was never measured while busy:\n${describeSamples(pickerStart)}`,
    ).toBe(true)

    // ---- the re-run, done: its carried steps, then its row on the Runs page ----
    const rerun = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
    const ended = await e2e.waitForEnd(rerun)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('run-outcome')).toHaveText(/^Fixed/)
    await audit(page, 'Run view (a re-run from Fix, completed)')
    await auditAtSmallest(e2e, page, 'Run view (a re-run from Fix, completed)')
    await page.getByTestId('nav-runs').click()
    await expect(page.getByTestId(`runs-meta-${rerun}`)).toContainText('Re-run from Fix of #131')
    await audit(page, 'Runs (a re-run from Fix listed)')
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 7. the catalog: the consent card, Settings → Catalog's review, price editing and the history -------------

test(
  'UI standards: the catalog consent card, the review, price editing and the history keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    // The first refresh is held until it is cancelled; the second answers catalog.spec.ts's prices after a few seconds.
    await loadRefreshConverter()
    const page = await e2e.start({
      editScenario: withRefreshes([
        { proposal: E21_PROPOSAL, holdMs: 300_000 },
        { proposal: E21_PROPOSAL, holdMs: 3_000 },
      ]),
    })
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

    // ---- the consent card (15 days on, the refresh is due): Update now through busy ----
    await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
    const card = consentCard(page)
    await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
    await expect(card.getByTestId('catalog-card-estimate')).toHaveText(/^~\d+ min/)
    await audit(page, 'Dashboard (the catalog consent card)')
    await auditAtSmallest(e2e, page, 'Dashboard (the catalog consent card)')
    for (const id of ['catalog-card-update', 'catalog-card-snooze', 'catalog-card-off'])
      await track(page, id, { selector: `[data-testid="${id}"]` })
    await card.getByTestId('catalog-card-update').click()
    await expect(card).toHaveAttribute('data-mode', 'running')
    const update = await stopTracking(page, 'catalog-card-update')
    expectSteady(update, 'Update now (the consent card)')
    expect(
      update.some((s) => s.busy),
      `Update now was never measured while busy:\n${describeSamples(update)}`,
    ).toBe(true)
    // Not now and Turn off are disabled while Update now is busy: one width each.
    expectSteady(await stopTracking(page, 'catalog-card-snooze'), 'Not now (7 days)')
    expectSteady(await stopTracking(page, 'catalog-card-off'), 'Turn off')

    // ---- the card while the update runs ----
    await expect(card.getByTestId('catalog-card-progress')).not.toBeEmpty()
    await audit(page, 'Dashboard (the catalog card while the update runs)')
    await auditAtSmallest(e2e, page, 'Dashboard (the catalog card while the update runs)')

    // ---- Settings → Catalog while it runs: the review block's reserved line, Cancel through busy ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-catalog').click()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'catalog')
    await settingsLoaded(page)
    const review = page.getByTestId('catalog-review')
    await expect(review).toHaveAttribute('data-state', 'running')
    await audit(page, 'Settings → Catalog (an update running)')
    await auditAtSmallest(e2e, page, 'Settings → Catalog (an update running)')
    await track(page, 'review-cancel', { selector: '[data-testid="catalog-review-cancel"]' })
    await track(page, 'settings-update', { selector: '[data-testid="catalog-update"]' })
    await page.getByTestId('catalog-review-cancel').click()
    await expect(toasts(page).filter({ hasText: 'The price update was cancelled' })).toBeVisible()
    expectSteady(await stopTracking(page, 'review-cancel'), 'Cancel (the running update)')
    await expect(page.getByTestId('catalog-update')).toBeEnabled()
    await audit(page, 'Settings → Catalog (the update cancelled)')

    // ---- Update now from Settings (through busy, disabled while it runs); the changes wait behind Show changes ----
    await page.getByTestId('catalog-update').click()
    await expect(review).toHaveAttribute('data-state', 'running')
    await expect(review).toHaveAttribute('data-state', 'diff-ready', { timeout: 60_000 })
    await expect(page.getByTestId('catalog-update')).toBeEnabled()
    const settingsUpdate = await stopTracking(page, 'settings-update')
    expectSteady(settingsUpdate, 'Update now (Settings → Catalog)')
    expect(seen(settingsUpdate, (s) => String(s.disabled)).sort()).toEqual(['false', 'true'])
    await expect(page.getByTestId('catalog-review-show')).toBeVisible()
    await audit(page, 'Settings → Catalog (changes waiting behind Show changes)')
    await page.getByTestId('catalog-review-show').click()
    await expect(page.getByTestId('catalog-diff')).toBeVisible()
    await audit(page, 'Settings → Catalog (the review table)')
    await auditAtSmallest(e2e, page, 'Settings → Catalog (the review table)')

    // ---- Apply N changes: one width from 1 through 0 to 3 and back, and while it applies ----
    await track(page, 'apply', { selector: '[data-testid="catalog-diff-apply"]' })
    const tick = (id: string) => page.getByTestId(`catalog-diff-tick-${id}`)
    const apply = page.getByTestId('catalog-diff-apply')
    await tick(ROW.opusOutput).click()
    await expect(apply).toHaveText('Apply 0 changes')
    await expect(apply).toBeDisabled()
    await audit(page, 'Settings → Catalog (the review, nothing ticked)')
    for (const id of [ROW.opusOutput, ROW.sonnetInput, ROW.haikuOutput]) await tick(id).click()
    await expect(apply).toHaveText('Apply 3 changes')
    for (const id of [ROW.sonnetInput, ROW.haikuOutput]) await tick(id).click()
    await expect(apply).toHaveText('Apply 1 change')
    await apply.click()
    const updated = toasts(page).filter({ hasText: 'Prices updated' })
    await expect(updated).toBeVisible()
    const applySamples = await stopTracking(page, 'apply')
    expectSteady(applySamples, 'Apply N changes')
    expect(seen(applySamples, (s) => s.label).length).toBeGreaterThan(2)
    expect(
      applySamples.some((s) => s.busy),
      `Apply was never measured while busy:\n${describeSamples(applySamples)}`,
    ).toBe(true)
    await expect(page.getByTestId('catalog-history-undo')).toBeVisible()
    await audit(page, 'Settings → Catalog (applied: the toast, the history and its Undo)')
    await auditAtSmallest(e2e, page, 'Settings → Catalog (applied: the toast, the history and its Undo)')
    await updated.getByRole('button', { name: 'Dismiss' }).click()

    // ---- a price edited by hand: Edit, a refused value in the row, Save through busy ----
    const key = 'claude-claude-sonnet-5-5'
    await page.getByTestId(`catalog-edit-${key}`).click()
    const input = page.getByTestId(`catalog-edit-${key}-inputPerMTok`)
    await input.fill('abc')
    await track(page, 'save', { selector: `[data-testid="catalog-save-${key}"]` })
    await page.getByTestId(`catalog-save-${key}`).click()
    await expect(page.getByTestId(`catalog-edit-error-${key}`)).toContainText(
      'Use a number such as 3 or 0.30.',
    )
    await audit(page, 'Settings → Catalog (a price being edited, a value refused)')
    await auditAtSmallest(e2e, page, 'Settings → Catalog (a price being edited, a value refused)')
    await input.fill('2.5')
    await page.getByTestId(`catalog-save-${key}`).click()
    await expect(page.getByTestId(`catalog-edited-${key}`)).toBeVisible()
    expectSteady(await stopTracking(page, 'save'), 'Save (a price)')
    await audit(page, 'Settings → Catalog (a price edited by you)')

    // ---- the history's Undo through busy ----
    await track(page, 'history-undo', { selector: '[data-testid="catalog-history-undo"]' })
    await page.getByTestId('catalog-history-undo').click()
    await expect(page.getByTestId(`catalog-edited-${key}`)).toHaveCount(0)
    expectSteady(await stopTracking(page, 'history-undo'), 'Undo (the history)')
    await expect(page.getByTestId('catalog-history').locator('tbody tr')).toHaveCount(3)
    await audit(page, 'Settings → Catalog (the history after an undo)')
    await auditAtSmallest(e2e, page, 'Settings → Catalog (the history after an undo)')
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 8. Codex: the sandbox chip, the Codex vendor card, local presets and a cross-vendor run ------------------

/** The setup card's sandbox status as laid out: its words, and whether they are cut (an ellipsis, or no room at all). */
async function readyLine(page: Page): Promise<{ text: string; cut: boolean }> {
  const status = page.getByTestId('setup-codex-sandbox-status')
  await status.scrollIntoViewIfNeeded()
  return status.evaluate((el) => ({
    text: (el.textContent ?? '').trim(),
    cut: el.clientWidth === 0 || el.scrollWidth > el.clientWidth,
  }))
}

test(
  'UI standards: the Codex sandbox chip, the Codex vendor card, local presets and a cross-vendor run keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    const thread = threadIdNow('uistd')
    const implementTotal = { input: 24_576, cached: 16_384, output: 1_450, reasoning: 512 }
    const page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      },
      config: {
        profile: 'balanced',
        gates: { afterPlan: true, beforeFix: false },
        // Port 9 (discard) on this computer: nothing answers, so the preset's Test says what it could not reach.
        local: {
          presets: [
            {
              id: 'ollama',
              label: 'Ollama',
              baseUrl: 'http://127.0.0.1:9/v1',
              model: 'qwen3-coder',
              contextWindow: 16_384,
            },
          ],
        },
      },
      codex: {
        sandbox: IS_WIN32 ? 'notConfigured' : 'ready',
        setup: { delayMs: 1_500, success: false },
        edit: editPass({
          threadId: thread,
          turnId: 'turn-uistd-implement',
          text: 'Added the --version flag.',
          approval: { command: 'npm test', reason: 'Run the test suite' },
          write: VERSION_WRITE,
          total: implementTotal,
        }),
        resume: {
          threadId: thread,
          ops: resumePass({
            threadId: thread,
            turnId: 'turn-uistd-fix',
            text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 fixed',
            write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
            restored: implementTotal,
            total: { input: 55_296, cached: 40_960, output: 2_430, reasoning: 896 },
          }),
        },
      },
    })
    const fake = e2e.codex
    if (fake === null) throw new Error('no fake Codex')
    fake.writeRollout(thread)
    await expect(page.getByTestId('vendor-health-codex')).toHaveAttribute(
      'data-health',
      IS_WIN32 ? 'sandbox-needed' : 'ready',
      { timeout: 30_000 },
    )

    // ---- the Dashboard: balanced, the pass rows open ----
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Codex')
    await openPassRows(page)
    if (IS_WIN32) {
      // ---- Windows: the sandbox chips (the strip's and the setup card's) through every state ----
      await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run', {
        timeout: 30_000,
      })
      const details = page.getByTestId('preflight-details')
      if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click()
      await audit(page, 'Dashboard (balanced, the Codex sandbox not set up: its chips)')
      await auditAtSmallest(e2e, page, 'Dashboard (balanced, the Codex sandbox not set up: its chips)')
      await track(page, 'sandbox', {
        selector: '[data-testid="setup-codex-sandbox"]',
        status: '[data-testid="setup-codex-sandbox-status"]',
        anchor: '[data-testid="setup-codex-sandbox-chip"]',
      })
      const chip = page.getByTestId('setup-codex-sandbox-chip')
      await page.getByTestId('setup-codex-sandbox').click()
      await expect(chip).toHaveAttribute('data-phase', 'running')
      await audit(page, 'Dashboard (the Codex sandbox being set up)')
      // The unelevated setup does not finish: the elevated command, with I ran it → Re-check, behind its disclosure
      // (it never opens on its own; the user opens it).
      await expect(chip).toHaveAttribute('data-phase', 'failed', { timeout: 60_000 })
      await expect(page.getByTestId('setup-codex-sandbox-elevated')).toBeHidden()
      await track(page, 'sandbox-more', { selector: '[data-testid="setup-codex-sandbox-more"]' })
      await page.getByTestId('setup-codex-sandbox-more').click()
      await expect(page.getByTestId('setup-codex-sandbox-elevated')).toBeVisible()
      expectSteady(
        await stopTracking(page, 'sandbox-more'),
        'Set up as administrator instead (the setup card)',
        {
          fixedX: true,
          fixedY: true,
        },
      )
      await audit(page, 'Dashboard (the sandbox setup did not finish: the elevated command)')
      await auditAtSmallest(e2e, page, 'Dashboard (the sandbox setup did not finish: the elevated command)')
      // Again, and this time it works.
      fake.set({ setup: { delayMs: 1_500, success: true } })
      await page.getByTestId('setup-codex-sandbox').click()
      await expect(chip).toHaveAttribute('data-phase', 'running')
      await expect.poll(() => fake.requests('windowsSandbox/setupStart').length).toBe(2)
      fake.set({ sandbox: 'ready' })
      await expect(chip).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
      await audit(page, 'Dashboard (the Codex sandbox ready)')
      // A ready sandbox is the chip's status line alone, whole (beside the disabled button the
      // setup card cut it to "Codex s…" at the default window); at the smallest window too.
      await expect(page.getByTestId('setup-codex-sandbox')).toHaveCount(0)
      expect(await readyLine(page)).toEqual({ text: 'Codex sandbox ready', cut: false })
      const restore = await toSmallestWindow(e2e, page)
      expect(await readyLine(page), 'at the smallest window').toEqual({
        text: 'Codex sandbox ready',
        cut: false,
      })
      await restore()
      const sandbox = await stopTracking(page, 'sandbox')
      expectSteady(sandbox, 'Set up the Codex sandbox (the setup card)', { fixedX: true, fixedY: true })
      expect(seen(sandbox, (s) => s.label)).toEqual(['Set up the Codex sandbox'])
      expect(sandbox.some((s) => s.busy)).toBe(true)
    }
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
    await audit(page, 'Dashboard (balanced, Claude and Codex ready)')

    // ---- Settings → Vendors: the Codex card (Test through Checking…) and the local presets ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-vendors').click()
    await settingsLoaded(page)
    await expect(page.getByTestId('settings-vendor-codex')).toBeVisible()
    await track(page, 'codex-test', { selector: '[data-testid="vendor-test-codex"]' })
    await page.getByTestId('vendor-test-codex').click()
    await expect(page.getByTestId('vendor-test-codex')).toBeEnabled({ timeout: 30_000 })
    expectSteady(await stopTracking(page, 'codex-test'), 'Test (the Codex card)')
    await expect(page.getByTestId('local-preset-ollama')).toBeVisible()
    await track(page, 'preset-test', { selector: '[data-testid="local-preset-ollama-test"]' })
    await page.getByTestId('local-preset-ollama-test').click()
    await expect(page.getByTestId('local-preset-ollama-status')).not.toHaveText('', { timeout: 30_000 })
    await expect(page.getByTestId('local-preset-ollama-test')).toBeEnabled()
    expectSteady(await stopTracking(page, 'preset-test'), 'Test (a local preset)')
    await audit(page, 'Settings → Vendors (the Codex card, a local preset tested)')
    await auditAtSmallest(e2e, page, 'Settings → Vendors (the Codex card, a local preset tested)')
    await page.getByTestId('local-preset-add').click()
    await expect(page.getByTestId('local-preset-form')).toBeVisible()
    await audit(page, 'Settings → Vendors (adding a local model)')
    await page.getByTestId('local-preset-cancel').click()

    // ---- a cross-vendor run: Claude's plan at its gate, a Codex ask, the end ----
    await page.getByTestId('nav-dashboard').click()
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    await audit(page, "Run view (balanced: Claude's plan at its gate, Codex next)")
    await gate.getByTestId('card-choice-approve').click()
    const ask = page.getByTestId('ask-panel')
    await expect(ask).toBeVisible({ timeout: 90_000 })
    await audit(page, 'Run view (a Codex command ask)')
    await auditAtSmallest(e2e, page, 'Run view (a Codex command ask)')
    await ask.getByTestId('ask-allow').click()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('session-kind-fix')).toHaveText('Codex thread')
    await audit(page, 'Run view (cross-vendor, completed; Fix continued the Codex thread)')
    await auditAtSmallest(e2e, page, 'Run view (cross-vendor, completed; Fix continued the Codex thread)')
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 9. Gemini: the folder trust chips, a run on Gemini and the Gemini vendor card ----------------------------

test(
  'UI standards: the Gemini trust chips, a run on Gemini and the Gemini vendor card keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    const page = await e2e.start({
      // The Log tab is audited below and shows the Review's text (vendor output, not UI text): the findings without
      // their em dashes, so whatever part of it the Log has on screen never reads as an em dash in the UI.
      scenario: {
        review: [
          { recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS.split(` ${EM_DASH} `).join(': ') },
        ],
      },
      config: { passes: gem.GEMINI_WALK_PASSES, gates: { afterPlan: true, beforeFix: false } },
      gemini: gem.geminiWalk(),
    })
    const fake = e2e.gemini
    if (fake === null) throw new Error('no fake Gemini')
    await expect(page.getByTestId('vendor-health-gemini')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })
    // The setup card lists Gemini (and its trust chip) on a visit that starts with Gemini found.
    await gem.revisitDashboard(page)

    // ---- the Dashboard: four passes on Gemini in a folder not trusted for it; the chips (strip, setup card) ----
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Gemini')
    await openPassRows(page)
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await showChecks(page)
    const strip = page.getByTestId('preflight-strip')
    const grant = strip.locator('[data-kind="grant"]')
    await expect(grant).toHaveCount(1)
    const testId = (await grant.getAttribute('data-testid')) ?? ''
    expect(testId).toMatch(/^preflight-trust-pass\.\w+\.readiness\.trust$/)
    await expect(page.getByTestId(`${testId}-chip`)).toHaveAttribute('data-phase', 'needed')
    await expect(page.getByTestId('setup-gemini-trust-chip')).toHaveAttribute('data-phase', 'needed')
    await audit(page, 'Dashboard (passes on Gemini, the folder not trusted for it: the trust chips)')
    await auditAtSmallest(
      e2e,
      page,
      'Dashboard (passes on Gemini, the folder not trusted for it: the trust chips)',
    )
    await shot(page, 'gemini-dashboard-trust')
    // [Trust this folder for Gemini] keeps its width and place under its changing status line, in the strip and in
    // the setup card (one grant, shared).
    await track(page, 'trust', {
      selector: `[data-testid="${testId}"]`,
      status: `[data-testid="${testId}-status"]`,
      anchor: `[data-testid="${testId}-chip"]`,
    })
    await track(page, 'card-trust', {
      selector: '[data-testid="setup-gemini-trust"]',
      status: '[data-testid="setup-gemini-trust-status"]',
      anchor: '[data-testid="setup-gemini-trust-chip"]',
    })
    await grant.click()
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
    await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0)
    await expect(page.getByTestId('setup-gemini-trust-chip')).toHaveAttribute('data-phase', 'trusted')
    await expect(page.getByTestId('setup-gemini-trust')).toHaveCount(0)
    await audit(page, 'Dashboard (the folder trusted for Gemini)')
    await auditAtSmallest(e2e, page, 'Dashboard (the folder trusted for Gemini)')
    const trust = await stopTracking(page, 'trust')
    expectSteady(trust, 'Trust this folder for Gemini (the strip)', { fixedX: true, fixedY: true })
    expect(seen(trust, (s) => s.label)).toEqual(['Trust this folder for Gemini'])
    const cardTrust = await stopTracking(page, 'card-trust')
    expectSteady(cardTrust, 'Trust this folder for Gemini (the setup card)', { fixedX: true, fixedY: true })
    expect(seen(cardTrust, (s) => s.label)).toEqual(['Trust this folder for Gemini'])

    // ---- the run: Gemini's native plan at its gate, a Gemini ask, Critic auto-answered, Fix continuing ----
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText('Read the version from package.json in src/cli.ts.').first()).toBeVisible()
    await audit(page, "Run view (Gemini's native plan at its gate)")
    await auditAtSmallest(e2e, page, "Run view (Gemini's native plan at its gate)")
    await shot(page, 'gemini-run-plan-gate')
    await gate.getByTestId('card-choice-approve').click()
    const ask = page.getByTestId('ask-panel')
    await nextAsk(page)
    await expect(ask).toContainText('npm test')
    await expect(ask.getByTestId('ask-allow-session')).toBeVisible()
    await audit(page, 'Run view (a Gemini ask)')
    await auditAtSmallest(e2e, page, 'Run view (a Gemini ask)')
    await ask.getByTestId('ask-allow').click()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('session-line-fix')).toHaveAttribute('data-session', 'reused')
    await expect(page.getByTestId('session-id-fix')).toBeVisible()
    await audit(page, 'Run view (a run on Gemini, completed; Fix continued the Gemini session)')
    await auditAtSmallest(
      e2e,
      page,
      'Run view (a run on Gemini, completed; Fix continued the Gemini session)',
    )
    await openRun(page, run.runId)
    await page.getByTestId('run-tab-log').click()
    await expect(page.getByText('AUTO denied 2', { exact: true })).toBeVisible()
    await audit(page, "Run view's Log (Gemini's read-only Critic, auto-answered)")
    // Plan rejected its exit (never allowed), Implement's ask allowed once, Critic's two denied, Fix loaded the session.
    expect(fake.permissionAnswers().map((a) => a.optionId)).toEqual([
      'cancel',
      'proceed_once',
      'cancel',
      'cancel',
    ])
    expect(fake.calls('session/load')).toHaveLength(1)

    // ---- Settings → Vendors: the Gemini card (Test through Checking…), its trusted folder, Revoke and Undo ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-vendors').click()
    await settingsLoaded(page)
    await expect(page.getByTestId('settings-vendor-gemini')).toBeVisible()
    await track(page, 'gemini-test', { selector: '[data-testid="vendor-test-gemini"]' })
    await page.getByTestId('vendor-test-gemini').click()
    await expect(page.getByTestId('vendor-test-gemini')).toBeEnabled({ timeout: 30_000 })
    expectSteady(await stopTracking(page, 'gemini-test'), 'Test (the Gemini card)')
    const rows = page.getByTestId('vendor-trusted-gemini-row')
    await expect(rows).toHaveCount(1, { timeout: 30_000 })
    await audit(page, 'Settings → Vendors (the Gemini card, a trusted folder)')
    await auditAtSmallest(e2e, page, 'Settings → Vendors (the Gemini card, a trusted folder)')
    await shot(page, 'settings-gemini')
    const revoke = rows.first().locator('[data-testid^="vendor-trusted-gemini-revoke-"]')
    const revokeId = (await revoke.getAttribute('data-testid')) ?? ''
    await track(page, 'revoke', { selector: `[data-testid="${revokeId}"]` })
    await revoke.click()
    await expect(page.getByTestId('vendor-trusted-gemini-state')).toHaveText('None yet.')
    const revoked = toasts(page).filter({ hasText: 'Gemini no longer trusted in' })
    await expect(revoked).toHaveCount(1)
    await audit(page, 'Settings → Vendors (the folder no longer trusted, with Undo)')
    await revoked.getByRole('button', { name: 'Undo' }).click()
    await expect(rows).toHaveCount(1, { timeout: 30_000 })
    expectSteady(await stopTracking(page, 'revoke'), 'Revoke (a folder trusted for Gemini)')
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 10. Grok and Muse: the More list, the modes they cannot run, the Muse trust chip, a run and their cards ---

test(
  'UI standards: the More list with Grok and Muse, their blocked modes, the Muse trust chip, a run and their cards keep to the copy and control rules',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(360_000)
    const page = await e2e.start({
      scenario: { plan: { recording: 'C06-plan-native-host' } },
      config: { gates: { afterPlan: false, beforeFix: false } },
      grok: { readOnly: grokReview() },
      muse: {
        edit: museEditPass({
          write: VERSION_WRITE,
          escalation: true,
          text: 'Added the --version flag; fetching the changelog needed the network, which the sandbox refused.',
          usage: { input: 12_288, cached: 4_096, output: 512 },
          delayMs: 2_000,
        }),
      },
    })
    const grok = e2e.grok
    const muse = e2e.muse
    if (grok === null || muse === null) throw new Error('no fake Grok or Muse')
    await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('vendor-health-muse')).toHaveAttribute('data-health', /^(ready|warning)$/)
    await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
    await openPassRows(page)

    // ---- the More list, open: Grok, and Muse with its Experimental badge ----
    await page.getByTestId('pass-vendor-implement').click()
    const more = page.getByRole('listbox').getByRole('group').filter({ hasText: 'More' })
    await expect(more.getByRole('option', { name: /^Grok/ })).toBeVisible()
    await expect(more.getByRole('option', { name: /^Muse · Experimental/ })).toBeVisible()
    await audit(page, 'Dashboard (the More list with Grok and Muse)')
    await auditAtSmallest(e2e, page, 'Dashboard (the More list with Grok and Muse)')
    await shot(page, 'grok-muse-more-list')
    await page.keyboard.press('Escape')

    // ---- Grok on Implement (Approve edits not available) and Muse on Critic (no read-only mode): blocked ----
    await pickFromMore(page, 'implement', 'Grok')
    await pickFromMore(page, 'critic', 'Muse')
    await expect(page.getByTestId('pass-mode-copy-implement')).toContainText(
      'Not supported until Dim Factory',
    )
    await expect(page.getByTestId('pass-mode-copy-critic')).toContainText('Muse cannot run read-only')
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await showChecks(page)
    await expect(page.getByTestId('preflight-chip-pass.critic.mode')).toBeVisible()
    await audit(page, 'Dashboard (Grok on Implement, Muse on Critic: both blocked, with the reasons)')
    await auditAtSmallest(
      e2e,
      page,
      'Dashboard (Grok on Implement, Muse on Critic: both blocked, with the reasons)',
    )
    await page.getByTestId('pass-reset-critic').click()
    await expect(page.getByTestId('pass-summary-critic')).toContainText('Critic · Claude')

    // ---- Grok on Review, Muse on Implement in a folder not trusted for Muse: the trust chip ----
    await pickFromMore(page, 'implement', 'Muse')
    await pickFromMore(page, 'review', 'Grok')
    await expect(page.getByTestId('pass-mode-copy-implement')).toContainText(
      'Sandbox-gated, never prompts; escalations fail.',
    )
    const strip = page.getByTestId('preflight-strip')
    const grant = strip.locator('[data-kind="grant"]')
    await expect(grant).toHaveCount(1, { timeout: 30_000 })
    const testId = (await grant.getAttribute('data-testid')) ?? ''
    expect(testId).toMatch(/^preflight-trust-pass\.\w+\.readiness\.trust$/)
    await expect(page.getByTestId(`${testId}-chip`)).toHaveAttribute('data-phase', 'needed')
    await audit(page, 'Dashboard (Grok on Review, Muse on Implement, the folder not trusted for Muse)')
    await auditAtSmallest(
      e2e,
      page,
      'Dashboard (Grok on Review, Muse on Implement, the folder not trusted for Muse)',
    )
    await shot(page, 'grok-muse-dashboard-trust')
    await track(page, 'muse-trust', {
      selector: `[data-testid="${testId}"]`,
      status: `[data-testid="${testId}-status"]`,
      anchor: `[data-testid="${testId}-chip"]`,
    })
    await grant.click()
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
    await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0)
    await audit(page, 'Dashboard (the folder trusted for Muse)')
    await auditAtSmallest(e2e, page, 'Dashboard (the folder trusted for Muse)')
    const trust = await stopTracking(page, 'muse-trust')
    expectSteady(trust, 'Trust this folder for Muse (the strip)', { fixedX: true, fixedY: true })
    expect(seen(trust, (x) => x.label)).toEqual(['Trust this folder for Muse'])

    // ---- the run: Implement on Muse (its card's copy), Review on Grok (auto-answered), completed ----
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    const card = page.getByTestId('pass-card-implement')
    await expect(card).toHaveAttribute('data-status', 'running', { timeout: 90_000 })
    await expect(page.getByTestId('mode-copy-implement')).toContainText('questions are not relayed')
    await audit(page, "Run view (Implement on Muse: its card's no-relay copy)")
    await auditAtSmallest(e2e, page, "Run view (Implement on Muse: its card's no-relay copy)")
    await shot(page, 'grok-muse-run-muse')
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await audit(page, 'Run view (Muse Implement, Grok Review, completed)')
    await auditAtSmallest(e2e, page, 'Run view (Muse Implement, Grok Review, completed)')
    await openRun(page, run.runId)
    await page.getByTestId('run-tab-log').click()
    await expect(page.getByText('AUTO denied 2', { exact: true })).toBeVisible()
    await audit(page, "Run view's Log (Grok's read-only Review, auto-answered)")
    expect(grok.permissionAnswers().map((a) => a.optionId)).toEqual(['reject_once', 'reject_once'])

    // ---- Settings → Vendors: the Grok and the Muse card (Test through Checking…), Muse's trusted folder ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-vendors').click()
    await settingsLoaded(page)
    await expect(page.getByTestId('settings-vendor-grok')).toBeVisible()
    const museCard = page.getByTestId('settings-vendor-muse')
    await expect(museCard.getByText('Experimental', { exact: true })).toBeVisible()
    await expect(page.getByTestId('vendor-trusted-muse-row')).toHaveCount(1, { timeout: 30_000 })
    for (const v of ['grok', 'muse']) {
      await track(page, `${v}-test`, { selector: `[data-testid="vendor-test-${v}"]` })
      await page.getByTestId(`vendor-test-${v}`).click()
      await expect(page.getByTestId(`vendor-test-${v}`)).toBeEnabled({ timeout: 30_000 })
      expectSteady(await stopTracking(page, `${v}-test`), `Test (the ${v} card)`)
    }
    await audit(page, 'Settings → Vendors (the Grok and the Muse card, a folder trusted for Muse)')
    await auditAtSmallest(
      e2e,
      page,
      'Settings → Vendors (the Grok and the Muse card, a folder trusted for Muse)',
    )
    await shot(page, 'grok-muse-settings')
    expect(grok.errors()).toEqual([])
    expect(muse.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)
