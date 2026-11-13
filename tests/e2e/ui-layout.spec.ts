// UI layout (the UI standard "One scroll region per screen, and nothing moves on its own"). The app is walked with the fake Claude at two window
// sizes, 1280 × 900 and the smallest the app allows, 900 × 600 (window sizes, as ui-standards.spec.ts measures them).
//
// The layout audit, on every screen it reaches (the Dashboard with the pass rows collapsed and open, the preflight
// strip blocked and ok, the setup card, a menu open; a run at the plan gate in Flow, Log and Config; a live stream; a
// completed run, its Diff tab with two files' diffs laid out split and stacked, and the palette open over it; the Runs
// page; every Settings section once it has what it reads), every element of the page and of its open shadow roots (the
// Diff tab's code view is @pierre/diffs' shadow DOM):
//   (a) the document never scrolls: document.scrollingElement.scrollHeight ≤ clientHeight + 1;
//   (b) <main> is the page's one scroller: it scrolls vertically and has no data-scroll-region, and no other element
//       without data-scroll-region scrolls vertically (overflow-y auto/scroll and either content taller than it or a
//       max height that will make it scroll); no data-scroll-region sits inside another;
//   (c) every data-scroll-region (an allowed inner region: a stream, the log, a text box, a menu, the palette's results)
//       is named on the whitelist (scroll-regions.ts) and has a max height and overscroll-behavior contain;
//   (d) nothing scrolls sideways: no element with overflow-x auto/scroll is wider inside than out, nor the document;
//   (e) text cut with an ellipsis says itself in full: it or an element around it has a title or a tooltip.
//
// Nothing moves on its own, measured in the page while it lives:
//   - layout shifts: the sum of the layout-shift entries the browser reports without recent input (its CLS) stays
//     under 0.02, through a 10 s idle Dashboard while a run goes on (an ask arrives in Needs you), the rest of that
//     run until it ends with the Dashboard open, a whole live run in the Run view, and the Diff tab while its diffs
//     lay out;
//   - scrolling: <main> (and any element outside the inner regions, the document included) scrolls only within a
//     second of the user's input. That includes the moments a new ask, the plan gate and the findings gate arrive
//     while the user is somewhere else (scrolled away, or on the Log tab): the jump pill shows instead, and only a
//     click on it scrolls, bringing the target into the reading area and focus into it.
//     The test's own actions are the user's input (`act`): a Playwright click may scroll its target into view first.
//   - The compact Run bar shows once the composer's Run row is scrolled past (the wheel scrolling there moves nothing
//     else), and its Run starts the run.
//
// The guards are checked against planted regressions in the live page (a document that scrolls, a stray and a nested
// scroller, a region off the whitelist, a region without a cap, sideways scrolling in the page and inside a shadow
// root, a shift and a scroll nobody asked for), so a guard that stops seeing anything fails here instead of passing quietly.
//
// Page zoom is the user's (WCAG 1.4.4): the zoom keys step it, and at 125% and 150% in a 1280 × 900 window, as in the
// 900 × 600 one at 100%, the Run view's sticky block leaves at least 55% of the page to read (turning compact where
// the full one would not, and full again as soon as it fits at the page's width: zoomed to 150% and back), a switch
// between its forms keeps the reading position, scrolls nothing and happens once, and the Dashboard, Runs and
// Settings pass the audit at 150%. Keyboard focus moving through a sticky bar's own controls (Tab through the Run
// view's header, tabs and steps, Open diff in the SummaryBar, the Dashboard's compact Run bar) never scrolls the page,
// in either form of the block.
//
// Zoomed (webContents.setZoomFactor 1.25 and 1.5 in a 1280 × 900 window, beside 100% there and in the 900 × 600 one):
// the Dashboard (empty, then a folder and task in), a run at the plan gate, a live run (Implement streaming), the Runs
// page and every Settings section pass the audit (Settings also in the 900 × 600 window at 175%, where its section
// list moves above the section); the Run view's sticky block takes at most 45% of <main>'s height; the plan gate,
// brought to the top of the reading area, shows at least 200 CSS px of the plan's text between the sticky block and
// its action row; the SummaryBar cuts none of what it shows (what does not fit gives way whole); the Dashboard keeps
// nothing empty taller than 40 px between the folder row and the task box (no element without text or a control, and
// no stretch of the band); and Ctrl/Cmd+= changes the zoom (at 100% and at 150%). Each of these checks is seen to
// fail on a planted regression (the zoom keys gone, an empty block and the old empty note line under the folder
// chips, a tall step strip, a tall action row, a SummaryBar item too long, the bars unmarked), then pass once it is
// removed. On the icon rail (1280 × 900 at 175%) a count on a nav icon stays off the icon.
//
// The developer's own mouse never reaches the app under test: an E2E window ignores the OS pointer (src/main/window.ts),
// so one resting where the toast stack grows cannot pause a toast (hover pauses its timer by design). The toast burst
// runs with the OS pointer parked on the stack, and a test of its own moves the window under the resting pointer
// (no pointer event, no :hover), sees the guard fail once the window takes the OS pointer again, and checks that
// Playwright's input (move, click, wheel, hover) and webContents.sendInputEvent still arrive. For those pointer
// checks the window is raised above everything (the taskbar and always-on-top windows included), so they do not
// depend on what else is on the developer's screen. Where the pointer rests outside its display's work area (on the
// taskbar) or the session is locked, the guard-fails half is left out with a "not checked" note, and the burst notes
// that the pointer was not parked; everything else is checked unconditionally.
//
// A verify round at both sizes: the layout audit on the trust card, the VerifyCard running (its output pane, the
// `verify-output` inner region, scrolled by the user and not), failed (an excerpt open) and opened again, the verifyEnv
// card, the gate before Fix with a finding from Verify, and Settings → Isolation & Verify with a project's commands
// (one changed since it was trusted); no layout shift or scroll without input from Implement to the run's end; the
// output pane follows new output only while the user is at its bottom, offers Jump to latest otherwise, and follows
// again after it.
//
// An isolated run at both sizes: no layout shift or scroll without input from the run's start (the prepare rows
// planned from it) through the depsConsent card, the install (its output pane, the `prepare-output` inner region,
// follows new output only while the user is at its bottom, offers Jump to latest otherwise, and follows again after
// it), the plan, Implement in the copy and the finalize card, to the end after Keep mine; the layout audit on the
// depsConsent card, the install running and scrolled up, the finalize card, the Diff tab's live Apply panel (its
// conflicts open), the finalizeConflicts card (a file's change open), the applied run, and Settings → Isolation &
// Verify with the Isolation half for a project (the copy-ins editor open).
//
// Codex with the fake Codex at both sizes: on Windows the Dashboard blocked by the Codex sandbox (its chips), the
// setup running and the block clearing with nothing moving on its own; the Dashboard with balanced's pass rows open;
// Settings → Vendors with the Codex card and a local preset (and the add form); a cross-vendor run at the plan gate, a
// Codex command ask, and no layout shift or scroll without input from that ask to the run's end.
//
// Gemini with the fake Gemini at both sizes: the Dashboard as it loaded with Gemini installed (found in review: its
// launch probe answers seconds after the setup card showed; no layout shift without input, and none that moved the
// setup card's rows or the composer's lines); the Dashboard blocked because the folder is not trusted for Gemini
// (the strip's trust chip and the setup card's), the grant and the block clearing with nothing moving on its own; the
// pass rows open; Settings → Vendors with the Gemini card and its trusted folder; a run on Gemini at its native plan's
// gate, a Gemini ask, and no layout shift or scroll without input from that ask to the run's end (Gemini Implement,
// Review ∥ Gemini's read-only Critic, Gemini Fix continuing Implement's session).
//
// Grok and Muse with the fake Grok and the fake Muse at both sizes: the Dashboard as it loaded with both installed
// (their launch probes moved nothing); the "More" list open with both (Muse with its Experimental badge); Muse on
// Implement and Grok on Review, the strip blocked by the Muse trust chip, the grant and the block clearing with
// nothing moving on its own; Settings → Vendors with the Grok and the Muse card; a run with Muse's Implement and
// Grok's read-only Review, and no layout shift or scroll without input from Implement to the run's end.
//
// The Runs history at both sizes, with 130 earlier runs (seeded before launch): no layout shift or scroll without
// input while a run starts and fails with the page open (no row is inserted for it), while the user sets filters (a
// custom date range open), at Load more (the next page arrives below: the row above the button and main's scroll stay
// put), at Remove (an undo row of the same height in the row's place; the next row does not move) and through the 12 s
// in which the undo window passes and core deletes the run; the layout audit on those screens, a row's actions menu,
// the findings picker under the failed run's row (focused and in view), the failed run's Re-run menu and its picker at
// the end of the Flow tab (focused and in view), and the re-run from Fix, which keeps still from its start to its end.
//
// The catalog at both sizes: the consent card arrives at the end of the Dashboard's rail when the refresh comes
// due (e2e.clock) and moves nothing; through Update now it runs and then offers the review without a layout shift or a
// scroll nobody asked for; Settings → Catalog's review table (opened from the card: focus lands in sight) keeps still
// while the user ticks and unticks rows; an update started there keeps the review block at one place and height while
// it runs and its changes arrive (they wait behind Show changes; the price tables below do not move); the layout audit
// on the card in each state, the review table, the history with its Undo, the running update and a price being edited.
//
// Set DIM_FACTORY_E2E_LAYOUT_SHOTS_DIR to save screenshots there (dashboard-top, dashboard-scrolled, dashboard-blocked,
// run-plan-gate, run-live and settings-vendors at 1280 × 900; dashboard-small and run-small at 900 × 600). The zoomed
// test saves the whole window (Electron's capturePage): dashboard-100 and -150, run-plan-gate-100, -125 and -150,
// run-small (900 × 600), run-live-150, settings-vendors-150, settings-catalog-150 and settings-vendors-small-175.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { keepingClipboard, logOut } from './dashboard-helpers.ts'
import { settingsLoaded } from './diff-settings-helpers.ts'
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
import { advanceClock, simulateFocus } from './attention-helpers.ts'
import {
  INSTALL_SCRIPT,
  commitSandbox,
  isolatedConfig,
  releaseInstall,
  slowInstallArgv,
  writeBeforeResult,
} from './isolated-helpers.ts'
import {
  FAILED_FIX,
  NO_GATES,
  RESUMED_FIX,
  findingsFlow,
  manyRows,
  openRunsPage,
  rowIds,
  runRow,
  seedHistory,
} from './history-helpers.ts'
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
import { GEMINI_WALK_PASSES, geminiWalk, revisitDashboard } from './gemini-helpers.ts'
import { grokReview, museEditPass, pickFromMore } from './grok-muse-helpers.ts'
import { FIX_WRITE, VERSION_WRITE, longText, streamDeltas, streamingImplement } from './scenarios.ts'
import { SCROLL_REGIONS } from './scroll-regions.ts'

/** The window sizes walked: 1280 × 900, and the smallest the app allows (src/main/constants.ts WINDOW_SIZE). */
const SIZES = [
  { name: '1280x900', size: [1280, 900] as const, large: true },
  { name: '900x600', size: [900, 600] as const, large: false },
] as const

/** "Cumulative layout shift (layout-shift entries without hadRecentInput) < 0.02". */
const CLS_MAX = 0.02
/** A scroll this soon after the user's input is that input's (a wheel's smooth scroll, a click's jump). */
const INPUT_GRACE_MS = 1000
const IDLE_MS = 10_000
const SHOTS_DIR = process.env['DIM_FACTORY_E2E_LAYOUT_SHOTS_DIR'] ?? ''

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === '') return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await settle(page)
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

/** Two animation frames: what the last change laid out is on screen. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

// ---- window size ----------------------------------------------------------------------------------------------------

/** Size the window; `zoom` is the page zoom it is at (the page's CSS size is the window's over it). */
async function sizeWindow(
  e2e: E2EHarness,
  page: Page,
  size: readonly [number, number],
  zoom = 1,
): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  const content = await e2e.app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    win.setSize(w, h)
    const [cw = 0, ch = 0] = win.getContentSize()
    const [ww = 0, wh = 0] = win.getSize()
    return { content: [cw, ch] as const, window: [ww, wh] as const }
  }, size)
  // Within the 2 px a scaled display may round the window's frame to.
  for (const i of [0, 1] as const)
    expect(
      Math.abs(content.window[i] - size[i]),
      `the window is ${content.window.join(' × ')}`,
    ).toBeLessThanOrEqual(2)
  await page.waitForFunction(
    ([cw, ch, z]) => {
      const near = z === 1 ? 1 : 2 * z
      return Math.abs(window.innerWidth * z - cw) <= near && Math.abs(window.innerHeight * z - ch) <= near
    },
    [...content.content, zoom] as const,
  )
  await settle(page)
}

/**
 * Move the window (its size kept) so the resting OS pointer sits at the page's (x, y), in CSS px at zoom 1. An E2E
 * window ignores the OS pointer (src/main/window.ts), so this changes nothing the page can see.
 */
async function underOsPointer(e2e: E2EHarness, page: Page, x: number, y: number): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  await e2e.app.evaluate(
    ({ BrowserWindow, screen }, [px, py]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win === undefined) throw new Error('no window')
      const c = screen.getCursorScreenPoint()
      const w = win.getBounds()
      const content = win.getContentBounds()
      win.setPosition(Math.round(c.x - px - (content.x - w.x)), Math.round(c.y - py - (content.y - w.y)))
    },
    [x, y] as const,
  )
  await page.waitForTimeout(300)
  await settle(page)
}

/**
 * Raise the window above everything, the Windows taskbar and other always-on-top windows included, so nothing else
 * on the developer's screen sits between it and the resting OS pointer; `false` puts it back among the others.
 * 'screen-saver' is the level that goes over the taskbar (Electron keeps 'floating', the default, under it on
 * Windows) and over the macOS menu bar; `moveTop` puts it above windows already at that level.
 */
async function raiseWindow(e2e: E2EHarness, raise: boolean): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  await e2e.app.evaluate(({ BrowserWindow }, on) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    if (on) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } else win.setAlwaysOnTop(false)
  }, raise)
}

/**
 * Why the resting OS pointer cannot be over the window even when it is raised, or null when it can be: the pointer
 * rests outside its display's work area (on the taskbar or the Dock, which may still keep it), or the session is
 * locked (there is no input desktop for the pointer to act on).
 */
async function restingPointerOutOfReach(e2e: E2EHarness): Promise<string | null> {
  if (e2e.app === null) throw new Error('the app is not running')
  return e2e.app.evaluate(({ powerMonitor, screen }) => {
    if (powerMonitor.getSystemIdleState(3600) === 'locked') return 'the session is locked'
    const c = screen.getCursorScreenPoint()
    const a = screen.getDisplayNearestPoint(c).workArea
    if (c.x < a.x || c.y < a.y || c.x >= a.x + a.width || c.y >= a.y + a.height)
      return `the OS pointer rests at (${c.x}, ${c.y}), outside its display's work area (the taskbar or the Dock)`
    return null
  })
}

/** Record the page's pointer, mouse and wheel events from now on (`pointerSeen` reads them). */
async function recordPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & { __pointerSeen?: string[] }
    const seen: string[] = []
    w.__pointerSeen = seen
    for (const type of [
      'pointerover',
      'pointermove',
      'pointerdown',
      'mouseover',
      'mousemove',
      'mousedown',
      'click',
      'wheel',
    ]) {
      window.addEventListener(
        type,
        (e) => {
          const m = e as MouseEvent
          seen.push(`${type} at ${Math.round(m.clientX)},${Math.round(m.clientY)}`)
        },
        { capture: true, passive: true },
      )
    }
  })
}

async function pointerSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as Window & { __pointerSeen?: string[] }).__pointerSeen ?? [])])
}

async function clearPointerSeen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = (window as Window & { __pointerSeen?: string[] }).__pointerSeen
    if (seen !== undefined) seen.length = 0
  })
}

/** The elements under the pointer as the page sees it (`:hover`), outermost first. */
async function hovered(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(':hover')].map((el) =>
      el.dataset['testid'] !== undefined ? `${el.tagName}[${el.dataset['testid']}]` : el.tagName,
    ),
  )
}

// ---- the layout audit: (a)–(d) ----------------------------------------------------------------------------------------

interface LayoutFindings {
  document: string[]
  page: string[]
  regions: string[]
  sideways: string[]
  cut: string[]
}

/** (a)–(d) on the page as it is now; `where` names the screen in the failure message. */
async function audit(page: Page, where: string): Promise<void> {
  const found = await page.evaluate((allowed): LayoutFindings => {
    const name = (el: Element): string => {
      const id = el.getAttribute('data-testid')
      const region = el.getAttribute('data-scroll-region')
      const owner = el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid')
      const cls =
        typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
      return (
        `${el.tagName.toLowerCase()}${id !== null ? `[data-testid="${id}"]` : cls !== '' ? `.${cls}` : ''}` +
        `${region !== null ? `[data-scroll-region="${region}"]` : ''}` +
        `${id === null && owner !== undefined && owner !== null ? ` in [data-testid="${owner}"]` : ''}`
      )
    }
    const out: LayoutFindings = { document: [], page: [], regions: [], sideways: [], cut: [] }
    // Every element, open shadow roots included (the Diff tab's code view is @pierre/diffs' shadow DOM).
    const everything = (root: Document | ShadowRoot): Element[] =>
      [...root.querySelectorAll('*')].flatMap((el) =>
        el.shadowRoot !== null ? [el, ...everything(el.shadowRoot)] : [el],
      )
    const doc = document.scrollingElement ?? document.documentElement
    // (a) The document, and everything that holds <main> (body, #root, the shell), stays within the window: a
    // programmatic scroll (scrollIntoView, focus) can move an overflow:hidden box, so none may have room to.
    if (doc.scrollHeight > doc.clientHeight + 1)
      out.document.push(`the document: scrollHeight ${doc.scrollHeight} > clientHeight ${doc.clientHeight}`)
    const main = document.querySelector('main')
    for (let el = main?.parentElement ?? null; el !== null && el !== doc; el = el.parentElement)
      if (el.scrollHeight > el.clientHeight + 1)
        out.document.push(
          `${name(el)} around <main>: scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`,
        )
    // (b) <main> is held to the window (its content is reached by scrolling it, never cut off) and scrolls.
    if (main === null) out.page.push('there is no <main>')
    else {
      const oy = getComputedStyle(main).overflowY
      if (oy !== 'auto' && oy !== 'scroll')
        out.page.push(`<main> does not scroll vertically (overflow-y ${oy})`)
      if (main.hasAttribute('data-scroll-region')) out.page.push('<main> carries data-scroll-region')
      const bottom = main.getBoundingClientRect().bottom
      if (bottom > window.innerHeight + 1)
        out.page.push(`<main> reaches past the window (bottom ${Math.round(bottom)} > ${window.innerHeight})`)
    }
    if (doc.scrollWidth > doc.clientWidth + 1)
      out.sideways.push(`the document: scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}`)
    for (const el of everything(document)) {
      const cs = getComputedStyle(el)
      const region = el.hasAttribute('data-scroll-region')
      const oy = cs.overflowY
      const scrollsY = oy === 'auto' || oy === 'scroll'
      if (el !== main && !region && scrollsY) {
        if (el.scrollHeight > el.clientHeight + 1)
          out.page.push(
            `${name(el)} scrolls: scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`,
          )
        else if (cs.maxHeight !== 'none')
          out.page.push(`${name(el)} will scroll: overflow-y ${oy} under max-height ${cs.maxHeight}`)
      }
      if (region) {
        // (b) no region inside another; (c) a cap and a contained wheel.
        const outer = el.parentElement?.closest('[data-scroll-region]')
        if (outer !== null && outer !== undefined) out.page.push(`${name(el)} sits inside ${name(outer)}`)
        const regionName = el.getAttribute('data-scroll-region') ?? ''
        if (!allowed.includes(regionName)) out.regions.push(`${name(el)} is not on the whitelist`)
        if (cs.maxHeight === 'none') out.regions.push(`${name(el)} has no max-height`)
        if (cs.overscrollBehaviorY !== 'contain')
          out.regions.push(`${name(el)} has overscroll-behavior-y ${cs.overscrollBehaviorY}`)
      }
      // (d)
      const ox = cs.overflowX
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1)
        out.sideways.push(`${name(el)}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`)
      // (e)
      if (
        cs.textOverflow === 'ellipsis' &&
        el.scrollWidth > el.clientWidth + 1 &&
        el.closest('[title], [data-tooltip]') === null
      )
        out.cut.push(`${name(el)}: "${(el.textContent ?? '').trim().slice(0, 60)}"`)
    }
    return out
  }, SCROLL_REGIONS)
  expect(found.document, `${where}: (a) the document scrolls`).toEqual([])
  expect(found.page, `${where}: (b) a scroller besides <main> and the marked inner regions`).toEqual([])
  expect(
    found.regions,
    `${where}: (c) an inner region off the whitelist, without a max height or a contained wheel`,
  ).toEqual([])
  expect(found.sideways, `${where}: (d) sideways scrolling`).toEqual([])
  expect(found.cut, `${where}: (e) text cut with an ellipsis and no tooltip`).toEqual([])
}

// ---- nothing moves on its own: the in-page guard ------------------------------------------------------------------------

interface Shift {
  value: number
  input: boolean
  at: number
  sources: string[]
}

interface Scroll {
  at: number
  target: string
  top: number
  sinceInput: number
  /** What changed height in the page shortly before (a failure's clue: what the browser's scroll anchoring followed). */
  resized: string[]
}

/** Keyboard focus that landed where the user cannot see it: under a sticky bar, a toast, or off screen. */
interface FocusMiss {
  at: number
  target: string
  /** What the centre of the focused element's visible part hits instead ('nothing': it is off screen). */
  hit: string
  rect: string
}

interface Guard {
  lastInput: number
  /** The test is acting for the user (a Playwright click may scroll its target into view, and retry). */
  acting: boolean
  shifts: Shift[]
  scrolls: Scroll[]
  /** When the user last pressed Tab: the focus that follows is keyboard focus the browser brings into view. */
  lastTab: number
  focusMisses: FocusMiss[]
  /** null when a point of `el` (its visible centre, or `at`) shows `el`; else what is there instead. */
  hitTest?: (el: Element, at?: { x: number; y: number }) => string | null
  /** The text of every toast shown since the guard was installed. */
  toastsSeen: string[]
}

type GuardWindow = Window & { __layoutGuard?: Guard }

/**
 * Start watching the page (once per page): layout-shift entries, the user's input (pointer, keys, wheel, touch, and
 * the test's own actions through `user`) and every scroll of an element outside the inner regions (the document and
 * <main> included). An inner region (data-scroll-region) may scroll itself to follow its output; nothing else may.
 */
async function installGuard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as GuardWindow
    if (w.__layoutGuard !== undefined) return
    const g: Guard = {
      lastInput: Number.NEGATIVE_INFINITY,
      acting: false,
      shifts: [],
      scrolls: [],
      lastTab: Number.NEGATIVE_INFINITY,
      focusMisses: [],
      toastsSeen: [],
    }
    w.__layoutGuard = g
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue
          for (const li of [n, ...n.querySelectorAll('li[data-toast-id]')])
            if (li.matches('li[data-toast-id]')) g.toastsSeen.push((li.textContent ?? '').trim())
        }
    }).observe(document.body, { childList: true, subtree: true })
    const mark = (): void => {
      g.lastInput = performance.now()
    }
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(type, mark, { capture: true, passive: true })
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Tab') g.lastTab = performance.now()
      },
      { capture: true, passive: true },
    )
    // A pointer press after the Tab: what gets focus then is the pointer's (the browser does not scroll for it).
    window.addEventListener(
      'pointerdown',
      () => {
        g.lastTab = Number.NEGATIVE_INFINITY
      },
      { capture: true, passive: true },
    )
    const name = (n: Node | null | undefined): string => {
      const el = n instanceof Element ? n : (n?.parentElement ?? null)
      if (el === null) return 'a node'
      const id = el.getAttribute('data-testid')
      const owner = el.closest('[data-testid]')?.getAttribute('data-testid')
      const cls =
        typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
      return `${el.tagName.toLowerCase()}${id !== null ? `[${id}]` : `.${cls}`}${id === null && owner !== undefined && owner !== null ? ` in [${owner}]` : ''}`
    }
    interface LayoutShiftEntry extends PerformanceEntry {
      value: number
      hadRecentInput: boolean
      sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[]
    }
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LayoutShiftEntry[])
        g.shifts.push({
          value: e.value,
          // The browser's own flag lasts 500 ms after input; an action whose answer comes later (core answering
          // Approve on a loaded machine) is still the user's doing while the test is acting for them.
          input: e.hadRecentInput || g.acting,
          at: Math.round(e.startTime),
          sources: (e.sources ?? []).map(
            (s) =>
              `${name(s.node)} ${Math.round(s.previousRect.x)},${Math.round(s.previousRect.y)} ${Math.round(s.previousRect.width)}×${Math.round(s.previousRect.height)} → ` +
              `${Math.round(s.currentRect.x)},${Math.round(s.currentRect.y)} ${Math.round(s.currentRect.width)}×${Math.round(s.currentRect.height)}`,
          ),
        })
    }).observe({ type: 'layout-shift', buffered: true })
    // Keyboard focus the browser brought into view (Tab, Shift+Tab) must be seen: the centre of the focused element's
    // visible part (clipped to the window, <main> and an inner region it sits in) must hit the element itself, not a
    // sticky bar, a card's sticky action row or a toast over it. Checked once the browser has scrolled for it.
    g.hitTest = (el: Element, at?: { x: number; y: number }): string | null => {
      const r = el.getBoundingClientRect()
      let top = Math.max(r.top, 0)
      let bottom = Math.min(r.bottom, window.innerHeight)
      let left = Math.max(r.left, 0)
      let right = Math.min(r.right, window.innerWidth)
      for (const clip of [el.closest('main'), el.parentElement?.closest('[data-scroll-region]') ?? null]) {
        if (clip === null) continue
        const c = clip.getBoundingClientRect()
        top = Math.max(top, c.top)
        bottom = Math.min(bottom, c.bottom)
        left = Math.max(left, c.left)
        right = Math.min(right, c.right)
      }
      if (at === undefined && (bottom - top < 1 || right - left < 1)) return 'nothing (off screen)'
      const x = at?.x ?? (left + right) / 2
      const y = at?.y ?? (top + bottom) / 2
      const hit = document.elementFromPoint(x, y)
      if (hit !== null && (hit === el || el.contains(hit))) return null
      // A control that takes no pointer events (a busy button) is seen through by elementFromPoint: its own box.
      if (hit !== null && hit.contains(el) && getComputedStyle(el).pointerEvents === 'none') return null
      return hit === null ? 'nothing' : name(hit)
    }
    document.addEventListener(
      'focusin',
      (ev) => {
        const target = ev.target
        if (!(target instanceof Element) || performance.now() - g.lastTab > 300) return
        requestAnimationFrame(() => {
          if (document.activeElement !== target) return
          const r = target.getBoundingClientRect()
          // Zero-size or screen-reader-only targets have nothing to see.
          if (r.width < 2 || r.height < 2) return
          const hit = g.hitTest?.(target) ?? null
          if (hit !== null)
            g.focusMisses.push({
              at: Math.round(performance.now()),
              target: name(target),
              hit,
              rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`,
            })
        })
      },
      { capture: true },
    )
    // The blocks of the page, measured every 100 ms: a scroll's record says which of them changed height since.
    const BLOCKS =
      'main article, main section, main [data-testid="attention"], main [data-testid="run-sticky-top"]'
    let heights = new Map<Element, number>()
    const measure = (): Map<Element, number> =>
      new Map([...document.querySelectorAll(BLOCKS)].map((el) => [el, el.getBoundingClientRect().height]))
    setInterval(() => (heights = measure()), 100)
    document.addEventListener(
      'scroll',
      (ev) => {
        const t = ev.target
        const el = t instanceof Element ? t : document.scrollingElement
        if (el === null) return
        if (el.closest('[data-scroll-region]') !== null) return
        const now = performance.now()
        const resized: string[] = []
        for (const [block, h] of measure()) {
          const before = heights.get(block)
          if (before === undefined) resized.push(`${name(block)} appeared (${Math.round(h)} px)`)
          else if (Math.abs(before - h) > 1)
            resized.push(`${name(block)} ${Math.round(before)} → ${Math.round(h)} px`)
        }
        g.scrolls.push({
          at: Math.round(now),
          target: el === document.scrollingElement ? 'the document' : name(el),
          top: Math.round(el.scrollTop),
          sinceInput: g.acting ? 0 : Math.round(now - g.lastInput),
          resized: resized.slice(0, 6),
        })
      },
      { capture: true, passive: true },
    )
  })
}

/** The test acts for the user: what follows within INPUT_GRACE_MS is that action's doing. */
async function user(page: Page): Promise<void> {
  await acting(page, false)
}

async function acting(page: Page, on: boolean): Promise<void> {
  await page.evaluate((a) => {
    const g = (window as GuardWindow).__layoutGuard
    if (g === undefined) return
    g.acting = a
    g.lastInput = performance.now()
  }, on)
}

/**
 * The test performs a user action: whatever scrolls while it runs (Playwright brings a target into view, and may
 * retry) and within INPUT_GRACE_MS after it is that action's doing.
 */
async function act<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await acting(page, true)
  try {
    return await action()
  } finally {
    await acting(page, false)
  }
}

/** Forget what the guard saw so far: a new measuring window starts now. */
async function startWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as GuardWindow).__layoutGuard
    if (g === undefined) throw new Error('the layout guard is not installed')
    g.shifts.length = 0
    g.scrolls.length = 0
    g.focusMisses.length = 0
  })
}

interface WindowReport {
  cls: number
  shifts: Shift[]
  unprompted: Scroll[]
  focusMisses: FocusMiss[]
}

async function readWindow(page: Page): Promise<WindowReport> {
  const g = await page.evaluate(() => {
    const guard = (window as GuardWindow).__layoutGuard
    if (guard === undefined) throw new Error('the layout guard is not installed')
    return { shifts: [...guard.shifts], scrolls: [...guard.scrolls], focusMisses: [...guard.focusMisses] }
  })
  const shifts = g.shifts.filter((s) => !s.input)
  return {
    cls: shifts.reduce((sum, s) => sum + s.value, 0),
    shifts,
    unprompted: g.scrolls.filter((s) => s.sinceInput > INPUT_GRACE_MS),
    focusMisses: g.focusMisses,
  }
}

function describeShifts(shifts: readonly Shift[]): string {
  return shifts
    .filter((s) => s.value >= 0.0005)
    .map((s) => `  ${s.value.toFixed(4)} at ${s.at} ms: ${s.sources.join('; ')}`)
    .join('\n')
}

/** The window so far: CLS under CLS_MAX and no scroll without input. */
async function expectSteady(page: Page, where: string): Promise<WindowReport> {
  const r = await readWindow(page)
  test.info().annotations.push({
    type: 'steady',
    description:
      `${where}: CLS ${r.cls.toFixed(4)} over ${r.shifts.length} shifts; ${r.unprompted.length} scrolls without input` +
      (r.cls > 0
        ? `
${describeShifts(r.shifts)}`
        : ''),
  })
  expect(
    r.cls,
    `${where}: layout shifts without input add up to ${r.cls.toFixed(4)}:\n${describeShifts(r.shifts)}`,
  ).toBeLessThan(CLS_MAX)
  expect(
    r.unprompted.map(
      (s) =>
        `${s.target} scrolled to ${s.top} ${s.sinceInput} ms after the last input` +
        (s.resized.length > 0 ? ` (resized: ${s.resized.join('; ')})` : ''),
    ),
    `${where}: something scrolled without the user`,
  ).toEqual([])
  expectFocusSeen(r, where)
  return r
}

/** Every keyboard focus in the window landed where the user sees it. */
function expectFocusSeen(r: Pick<WindowReport, 'focusMisses'>, where: string): void {
  expect(
    r.focusMisses.map((m) => `${m.target} at ${m.rect} is under ${m.hit}`),
    `${where}: keyboard focus landed out of sight`,
  ).toEqual([])
}

/** Keyboard focus since the window began landed where the user sees it (no CLS or scroll checks). */
async function expectFocusClear(page: Page, where: string): Promise<void> {
  // The last focus is checked a frame after it lands.
  await settle(page)
  expectFocusSeen(await readWindow(page), where)
}

// ---- the page scroller --------------------------------------------------------------------------------------------------

function main(page: Page): Locator {
  return page.getByTestId('main')
}

async function mainTop(page: Page): Promise<number> {
  return main(page).evaluate((el) => el.scrollTop)
}

/** The user drags main's scrollbar to `top` (a user action). */
async function scrollMainTo(page: Page, top: number): Promise<void> {
  await user(page)
  await main(page).evaluate((el, t) => el.scrollTo({ top: t }), top)
  await settle(page)
}

/** The user brings an element to the top of the Run view's reading area (just under its sticky header). */
async function scrollToReading(page: Page, target: Locator): Promise<void> {
  await user(page)
  await target.evaluate((el) => {
    const m = document.querySelector('main')
    if (m === null) return
    const header =
      document.querySelector('[data-testid="run-sticky-top"]')?.getBoundingClientRect().height ?? 0
    const top = el.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop - header - 8
    m.scrollTo({ top: Math.max(0, top) })
  })
  await settle(page)
}

/**
 * Where an element is against the Run view's reading area (main's view less the sticky header and SummaryBar), or
 * against main's view off the Run view.
 */
async function whereIs(target: Locator): Promise<'in' | 'above' | 'below'> {
  return target.evaluate((el) => {
    const m = document.querySelector('main')
    if (m === null) throw new Error('no main')
    const view = m.getBoundingClientRect()
    const top =
      document.querySelector('[data-testid="run-sticky-top"]')?.getBoundingClientRect().bottom ?? view.top
    const bottom =
      document.querySelector('[data-testid="summary-bar"]')?.getBoundingClientRect().top ?? view.bottom
    const r = el.getBoundingClientRect()
    if (r.bottom <= top + 1) return 'above'
    if (r.top >= bottom - 1) return 'below'
    return 'in'
  })
}

/** A plan of 120 lines: longer than the reading area at any window size. */
const LONG_PLAN = Array.from(
  { length: 120 },
  (_, i) => `- Step ${i + 1}: move the loader so that project, user and profile layers merge in one pass`,
).join('\n')

/** The text of every toast shown since the guard was installed. */
async function toastsSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as GuardWindow).__layoutGuard?.toastsSeen ?? [])])
}

/** The toasts on screen that say `text`. */
function toastsSaying(page: Page, text: string): Locator {
  return page.getByTestId('toaster').locator('li[data-toast-id]', { hasText: text })
}

/**
 * Where the text cursor is at the end of a text box (its last line) is in sight: null, or what covers that point (a
 * sticky bar, a card's action row, a toast) or 'nothing' when it is off screen.
 */
async function caretHidden(box: Locator): Promise<string | null> {
  return box.evaluate((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const line = Number.parseFloat(cs.lineHeight) || 20
    const y =
      r.bottom - Number.parseFloat(cs.paddingBottom) - Number.parseFloat(cs.borderBottomWidth) - line / 2
    const g = (window as GuardWindow).__layoutGuard
    if (g?.hitTest === undefined) return 'no guard'
    return g.hitTest(el, { x: r.left + 24, y })
  })
}

/**
 * Every inner scroll region of the Run view (a stream, the log, a long command; menus are popovers) leaves page to
 * scroll in the reading area between the sticky header and the SummaryBar: it is at most the reading area less a
 * strip, and, brought to the reading area's top, a wheel over the page just below it scrolls <main>.
 */
async function expectRegionsLeavePage(page: Page, where: string): Promise<void> {
  const tall = await regionsFillingTheReadingArea(page)
  expect(tall, `${where}: an inner region fills the reading area`).toEqual([])
  const region = page.locator(
    '[data-testid="run-view"] [data-scroll-region]:not([data-scroll-region="menu"])',
  )
  let checked = 0
  for (const r of await region.all()) {
    if (!(await r.isVisible())) continue
    checked++
    await scrollToReading(page, r)
    // The page the reading area shows above or below the region (whichever is more), and a point in its middle.
    const point = await r.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const top =
        document.querySelector('[data-testid="run-sticky-top"]')?.getBoundingClientRect().bottom ?? 0
      const bottom = document.querySelector('[data-testid="summary-bar"]')?.getBoundingClientRect().top ?? 0
      const above = box.top - top
      const below = bottom - box.bottom
      const y = below >= above ? box.bottom + below / 2 : top + above / 2
      const x = box.left + box.width / 2
      const hit = document.elementFromPoint(x, y)
      return { x, y, room: Math.max(above, below), inRegion: hit?.closest('[data-scroll-region]') !== null }
    })
    const label = `${where}: ${await r.getAttribute('data-testid')}`
    expect(point.room, `${label}: no page beside the region in the reading area`).toBeGreaterThanOrEqual(20)
    expect(point.inRegion, `${label}: beside the region is another region`).toBe(false)
    const m = main(page)
    const before = await mainTop(page)
    const atEnd = await m.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    await page.mouse.move(point.x, point.y)
    await act(page, async () => {
      await page.mouse.wheel(0, atEnd ? -240 : 240)
      await page.waitForTimeout(400)
    })
    expect(await mainTop(page), `${label}: the wheel beside the region did not scroll the page`).not.toBe(
      before,
    )
  }
  expect(checked, `${where}: no inner region to check`).toBeGreaterThan(0)
}

/** The Run view's inner regions taller than the reading area less a strip (32 px): a wheel over them is trapped. */
async function regionsFillingTheReadingArea(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const m = document.querySelector('main')
    const top = document.querySelector('[data-testid="run-sticky-top"]')?.getBoundingClientRect().height ?? 0
    const bottom = document.querySelector('[data-testid="summary-bar"]')?.getBoundingClientRect().height ?? 0
    const reading = (m?.clientHeight ?? window.innerHeight) - top - bottom
    return [...document.querySelectorAll<HTMLElement>('[data-testid="run-view"] [data-scroll-region]')]
      .filter((el) => el.dataset['scrollRegion'] !== 'menu' && el.getClientRects().length > 0)
      .map((el) => ({ el, h: el.getBoundingClientRect().height }))
      .filter(({ h }) => h > reading - 32)
      .map(
        ({ el, h }) =>
          `${el.dataset['testid'] ?? el.dataset['scrollRegion'] ?? el.tagName} is ${Math.round(h)} px in a reading area of ${Math.round(reading)} px`,
      )
  })
}

/**
 * The user is elsewhere when `target` arrives: nothing scrolls, the jump pill offers it instead, and a click on the
 * pill brings the target into the reading area with focus in it.
 */
async function expectPillNotScroll(
  page: Page,
  o: { pill: string; target: Locator; label: string; away?: boolean; timeout?: number },
): Promise<void> {
  const before = await mainTop(page)
  const pill = page.getByTestId(o.pill)
  // Whichever shows first: the target on the page, or (on another tab) its pill. Then the page has not moved.
  await expect(o.away === true ? pill : o.target).toBeAttached({ timeout: o.timeout ?? 90_000 })
  await settle(page)
  await page.waitForTimeout(300)
  expect(await mainTop(page), `${o.label}: the page scrolled when it arrived`).toBe(before)
  await expect(pill, `${o.label}: no jump pill while it is out of view`).toBeVisible({ timeout: 10_000 })
  await expect(pill).toHaveText(o.label)
  if (o.away === true) await expect(pill).toHaveAttribute('data-where', 'away')
  else {
    await expect(o.target).toBeVisible()
    expect(await whereIs(o.target), `${o.label}: the pill showed for a target in view`).not.toBe('in')
  }
  await act(page, () => pill.click())
  await expect(o.target).toBeVisible()
  await expect
    .poll(() => whereIs(o.target), { message: `${o.label}: the pill did not bring it into view` })
    .toBe('in')
  await expect(pill).toBeHidden()
  expect(
    await o.target.evaluate((el) => el.contains(document.activeElement)),
    `${o.label}: focus is not in it after the jump`,
  ).toBe(true)
}

// ---- shared steps -----------------------------------------------------------------------------------------------------

async function typeFolderAndTask(page: Page, folder: string, task: string): Promise<void> {
  const input = page.getByTestId('composer-folder-input')
  await act(page, async () => {
    await input.fill(folder)
    await input.press('Enter')
    await page.getByTestId('composer-task').fill(task)
  })
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
}

async function setPassRows(page: Page, open: boolean): Promise<void> {
  const toggle = page.getByTestId('composer-passes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await act(page, () => toggle.click())
  await expect(toggle).toHaveAttribute('aria-expanded', String(open))
  if (!open) return
  const rows = page.locator('[data-testid^="pass-row-toggle-"]')
  await expect(rows.first()).toBeVisible()
  for (const row of await rows.all()) {
    if ((await row.getAttribute('aria-expanded')) !== 'true') await act(page, () => row.click())
    await expect(row).toHaveAttribute('aria-expanded', 'true')
  }
}

async function showChecks(page: Page): Promise<void> {
  const toggle = page.getByTestId('preflight-details')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await act(page, () => toggle.click())
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

async function tab(page: Page, which: 'flow' | 'diff' | 'log' | 'config'): Promise<void> {
  await act(page, () => page.getByTestId(`run-tab-${which}`).click())
  await expect(page.getByTestId(`run-tab-${which}`)).toHaveAttribute('data-state', 'active')
}

/** Open a menu, audit the page with it open (its list is an inner region), close it. */
async function auditMenu(page: Page, trigger: Locator, where: string): Promise<void> {
  await act(page, () => trigger.click())
  const menu = page.locator('[data-scroll-region="menu"]')
  await expect(menu.first()).toBeVisible()
  await audit(page, `${where} (a menu open)`)
  await act(page, () => page.keyboard.press('Escape'))
  await expect(menu).toHaveCount(0)
}

// ---- 1. the Dashboard ---------------------------------------------------------------------------------------------------

/** Plan → Implement (asks to run a command; then a long answer streamed in small deltas) → clean reviews. */
const DASHBOARD_TEXT = longText(12_000)

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the Dashboard has one scroller, keeps still while a run goes on, and its compact bar runs`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      let login = (): void => {
        throw new Error('the scenario was not logged out')
      }
      const page = await e2e.start({
        scenario: {
          plan: { recording: 'C06-plan-native-host' },
          implement: [{ recording: 'C03-accept-edits', write: VERSION_WRITE, text: DASHBOARD_TEXT }],
        },
        editScenario: (sc) => {
          login = logOut(sc).login
          streamDeltas(sc, 'implement-1', DASHBOARD_TEXT, { chunkSize: 60, sleepMs: 40 })
        },
        // The run goes on by itself (no plan gate), so the Dashboard has something to show while it is left alone.
        config: { gates: { afterPlan: false } },
      })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'login-needed')
      await expect(page.getByTestId('setup-card')).toBeVisible()
      await page.waitForTimeout(500)
      // The layout shifts since the page loaded (the observer reads the buffered ones too): the Dashboard filling in
      // (vendor health, the setup card, the composer's checks) moved nothing.
      await expectSteady(page, 'the Dashboard as it loaded')
      await audit(page, 'Dashboard (empty, logged out, the setup card)')

      // ---- the preflight strip blocked; the pass rows collapsed, then open; a menu ----
      await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
      await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run')
      await audit(page, 'Dashboard (preflight blocked, pass rows collapsed)')
      await showChecks(page)
      const chip = page.getByTestId('preflight-strip').getByTestId('preflight-chip-vendor.claude.auth')
      await expect(chip).toHaveAttribute('data-severity', 'blocking')
      await audit(page, 'Dashboard (preflight blocked, its checks open)')
      if (s.large) {
        await scrollMainTo(page, 0)
        await shot(page, 'dashboard-blocked')
      }
      await setPassRows(page, true)
      await audit(page, 'Dashboard (preflight blocked, pass rows open)')
      await auditMenu(page, page.getByTestId('composer-profile'), 'Dashboard (the profile)')

      // ---- logged in: the strip ok ----
      login()
      await keepingClipboard(e2e, async () => {
        await act(page, () => chip.getByTestId('recovery-claude.login').click())
        await expect(chip.getByTestId('recheck-claude.login')).toBeVisible()
      })
      await act(page, () => chip.getByTestId('recheck-claude.login').click())
      const run = page.getByTestId('composer-run')
      await expect(run).toBeEnabled({ timeout: 30_000 })
      await expect(page.getByTestId('preflight-ok')).toBeVisible()
      await audit(page, 'Dashboard (preflight ok, pass rows open)')
      await setPassRows(page, false)
      await audit(page, 'Dashboard (preflight ok, pass rows collapsed)')
      await scrollMainTo(page, 0)
      await shot(page, s.large ? 'dashboard-top' : 'dashboard-small')

      // ---- the compact bar: hidden at the top, shown once the Run row is scrolled past; its Run starts the run ----
      await setPassRows(page, true)
      // On a small window, reaching the pass rows' toggle scrolls the Run row away, so go back to the top first.
      await scrollMainTo(page, 0)
      const bar = page.getByTestId('compact-bar')
      await expect(bar).toBeHidden()
      const box = await main(page).boundingBox()
      if (box === null) throw new Error('main has no box')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      const row = page.getByTestId('composer-run-row')
      await startWindow(page)
      for (let i = 0; i < 20 && (await bar.isHidden()); i++) {
        await page.mouse.wheel(0, 120)
        await page.waitForTimeout(150)
      }
      await expect(bar).toBeVisible()
      // Shown once the Run row is under it (scrolled past), and showing it moved nothing (it overlays the page).
      expect(
        await row.evaluate((el) => el.getBoundingClientRect().bottom),
        'the compact bar shows while the Run row is still in view',
      ).toBeLessThanOrEqual(box.y + 48 + 1)
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Dashboard scrolled by the wheel until the compact bar showed')
      await expect(page.getByTestId('compact-task')).toContainText('add a --version flag')
      await expect(page.getByTestId('compact-run')).toBeEnabled()
      await audit(page, 'Dashboard (scrolled: the compact bar)')
      if (s.large) await shot(page, 'dashboard-scrolled')

      // ---- keyboard focus moving up the open pass rows lands below the compact bar, never under it ----
      await startWindow(page)
      await act(page, () =>
        page.evaluate(() => {
          const composer = document.querySelector('[data-testid="composer"]')
          const all = [
            ...(composer?.querySelectorAll<HTMLElement>(
              'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
            ) ?? []),
          ].filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
          all[Math.floor(all.length * 0.75)]?.focus({ preventScroll: true })
        }),
      )
      for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+Tab')
      await expectFocusClear(page, 'Shift+Tab up the open pass rows under the compact bar')
      // Back down to where the bar shows (the user's wheel), for its Run.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 20 && (await bar.isHidden()); i++) {
        await page.mouse.wheel(0, 120)
        await page.waitForTimeout(150)
      }
      await expect(bar).toBeVisible()
      await act(page, () => page.getByTestId('compact-run').click())
      await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
      const created = await e2e.onlyRun()
      await expect(page.getByTestId('run-view')).toBeVisible()

      // ---- back on the Dashboard: 10 s left alone while the run goes on and asks (Needs you) ----
      await act(page, () => page.getByTestId('nav-dashboard').click())
      await expect(page.getByTestId('composer')).toBeVisible()
      await expect(page.getByTestId(`active-run-${created.runId}`)).toBeVisible()
      await page.waitForTimeout(500)
      await startWindow(page)
      await page.waitForTimeout(IDLE_MS)
      // Still left alone: the window lasts until the ask is in Needs you, if it has not arrived yet.
      const ask = page.locator('[data-testid^="needs-you-"][data-kind="ask"]')
      await expect(ask).toBeVisible({ timeout: 60_000 })
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Dashboard left alone for 10 s while a run went on')
      await audit(page, 'Dashboard (a run asking in Needs you)')

      // ---- Allow from Needs you; then the run streams, reviews and ends while the Dashboard is open ----
      await act(page, () => ask.getByRole('button', { name: 'Allow', exact: true }).click())
      await expect(ask).toBeHidden()
      await page.waitForTimeout(1500)
      await startWindow(page)
      const ended = await e2e.waitForEnd(created.runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(2000)
      await expectSteady(page, 'the Dashboard while the run streamed and ended')
      // The ended run keeps its card for this visit; it joins Recent runs on the next one.
      const card = page.getByTestId(`active-run-${created.runId}`)
      await expect(card).toHaveAttribute('data-status', 'completed')
      await expect(page.getByTestId(`recent-run-${created.runId}`)).toHaveCount(0)
      await audit(page, 'Dashboard (the run ended while it was open)')
      await act(page, () => page.getByTestId('nav-runs').click())
      await act(page, () => page.getByTestId('nav-dashboard').click())
      await expect(page.getByTestId(`recent-run-${created.runId}`)).toBeVisible()
      await expect(card).toHaveCount(0)
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 2. a live run in the Run view, then the Runs page and Settings ---------------------------------------------------

/** Implement's answer, long enough to stream for several seconds. */
const RUN_TEXT = longText(16_000)

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: a live run keeps still, offers what arrives with a jump pill, and every screen has one scroller`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(360_000)
      // Plan (3 s) → the plan gate → Implement asks to run a command, then streams a long answer → Review finds
      // 2 must + 1 should (streamed) ∥ Critic → the gate before Fix → Fix resumes Implement's session → completed.
      const page = await e2e.start({
        scenario: {
          plan: { recording: 'C06-plan-native-host', delayMs: 3000 },
          implement: [{ recording: 'C03-accept-edits', write: VERSION_WRITE, text: RUN_TEXT }],
          review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
          resume: [
            {
              recording: 'C08b-resume-fix',
              write: FIX_WRITE,
              text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 skipped: not worth the churn',
            },
          ],
        },
        editScenario: (sc) => {
          streamDeltas(sc, 'implement-1', RUN_TEXT, { chunkSize: 40, sleepMs: 30 })
          streamDeltas(sc, 'review-1', REVIEW_WITH_FINDINGS, { chunkSize: 12, sleepMs: 60 })
        },
        config: { gates: { afterPlan: true, beforeFix: true } },
      })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      // The window has focus, so what the run tells the user comes as in-app toasts (the notification rules).
      await simulateFocus(e2e, true)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
      const created = await act(page, () => e2e.runFromDashboard('add a --version flag'))
      const runId = created.runId
      await settle(page)
      await startWindow(page)
      // Watching the Flow as the plan begins: its card lands at the end of the flow, moving nothing.
      await expect(page.getByTestId('stream-plan')).toBeVisible({ timeout: 60_000 })
      await page.waitForTimeout(500)

      // ---- the plan streams while the user reads the Log; the plan gate arrives there: a pill, no scroll ----
      await tab(page, 'log')
      await expect(page.getByTestId('log-rows')).toBeVisible()
      await audit(page, 'Run view (Log, while the plan runs)')
      const gate = page.getByTestId('card-gate:afterPlan')
      await expectPillNotScroll(page, {
        pill: 'jump-plan',
        target: gate,
        label: 'Plan ready for review',
        away: true,
      })
      await expect(page.getByTestId('run-tab-flow')).toHaveAttribute('data-state', 'active')

      // ---- at the plan gate: Flow (and editing the plan), Log, Config, a menu ----
      await audit(page, 'Run view at the plan gate (Flow)')
      await shot(page, s.large ? 'run-plan-gate' : 'run-small')
      await act(page, () => gate.getByTestId('plan-edit').click())
      const editor = gate.getByTestId('plan-editor')
      await expect(editor).toBeVisible()
      await audit(page, 'Run view at the plan gate (editing the plan)')
      // No in-app toast for this run's gate in its own view: the card says it, and a toast would cover its actions.
      await expect(toastsSaying(page, 'Plan ready')).toHaveCount(0)

      // ---- typing at the end of a long plan: the text cursor stays above the sticky action row ----
      const actions = gate.getByTestId('plan-gate-actions')
      await act(page, () => editor.fill(LONG_PLAN))
      await act(page, async () => {
        await editor.press('Control+End')
        await editor.pressSequentially(' and one more line', { delay: 10 })
      })
      await settle(page)
      expect(
        await caretHidden(editor),
        'the text cursor at the end of a long plan is out of sight',
      ).toBeNull()
      // Tab from the plan through the action row: focus lands in sight, and the row (in view wherever it sticks)
      // never scrolls the page under itself.
      await act(page, () => page.keyboard.press('Tab'))
      await expect(actions.locator(':focus')).toHaveCount(1)
      const rowTop = await mainTop(page)
      for (let i = 0; i < 12; i++) {
        if ((await actions.locator(':focus').count()) === 0) break
        await act(page, () => page.keyboard.press('Tab'))
        if ((await actions.locator(':focus').count()) > 0)
          expect(await mainTop(page), 'Tab inside the sticky action row scrolled the page').toBe(rowTop)
      }
      await expectFocusClear(page, 'Tab from the end of a long plan through its action row')
      await act(page, () => actions.getByRole('button', { name: 'Undo my edits' }).click())
      await act(page, () => gate.getByTestId('plan-edit').click())
      await expect(gate.getByTestId('plan-editor')).toBeHidden()
      await auditMenu(page, page.getByTestId('pass-menu-plan'), 'Run view at the plan gate')
      await tab(page, 'log')
      await audit(page, 'Run view at the plan gate (Log)')
      await tab(page, 'config')
      await expect(page.getByTestId('config-tab')).toBeVisible()
      await audit(page, 'Run view at the plan gate (Config)')
      await tab(page, 'flow')
      await expect(gate).toBeVisible()

      // ---- Approve; scrolled to the top, the ask arrives at the end of the page: a pill, no scroll ----
      // The click and what it visibly causes (the gate closes, Implement starts) are one user action, however long core
      // takes to answer.
      await act(page, async () => {
        await gate.getByTestId('card-choice-approve').click()
        await expect(gate).toBeHidden()
        await expect(page.getByTestId('pass-card-implement')).toBeVisible({ timeout: 60_000 })
      })
      await scrollMainTo(page, 0)
      const askPanel = page.getByTestId('ask-panel')
      await expectPillNotScroll(page, { pill: 'jump-ask', target: askPanel, label: 'Claude needs approval' })
      await audit(page, 'Run view (an ask)')
      await act(page, async () => {
        await askPanel.getByTestId('ask-allow').click()
        await expect(askPanel).toBeHidden()
      })

      // ---- the live stream ----
      const stream = page.getByTestId('stream-implement')
      await expect
        .poll(() => stream.evaluate((el) => Number(el.getAttribute('data-blocks') ?? 0)), { timeout: 60_000 })
        .toBeGreaterThan(0)
      await scrollToReading(page, page.getByTestId('pass-card-implement'))
      await audit(page, 'Run view (Implement streaming)')
      if (s.large) await shot(page, 'run-live')
      // The stream never fills the reading area: the wheel beside it scrolls the page, and its bottom edge ("Jump to
      // latest") is above the SummaryBar. The check sees a stream planted to fill it.
      await expectRegionsLeavePage(page, 'Run view (Implement streaming)')
      await stream.evaluate((el) => {
        el.style.maxHeight = 'none'
        el.style.height = `${window.innerHeight}px`
      })
      expect(
        await regionsFillingTheReadingArea(page),
        'the check did not see a stream filling it',
      ).toHaveLength(1)
      // The planted size lasts a rendered frame, as any real one does, before it is taken back. Undone within the same
      // frame, the scroll the plant caused (clamped to the top) arrives after the region is back to its own size and no
      // resize was ever observed, so it reads as the user scrolling up (a flake, 1 run in 10 at 900x600).
      await settle(page)
      await stream.evaluate((el) => {
        el.style.maxHeight = ''
        el.style.height = ''
      })
      await expect(page.getByTestId('stream-jump-implement')).toBeHidden()

      // ---- scrolled to the top, the gate before Fix arrives at the end: a pill, no scroll ----
      await scrollMainTo(page, 0)
      const findings = page.getByTestId('card-gate:beforeFix')
      await expectPillNotScroll(page, {
        pill: 'jump-findings',
        target: findings,
        label: 'Findings ready for review',
      })
      await audit(page, 'Run view (the gate before Fix)')
      // No in-app toast for this run's gate in its own view: it would cover Continue, Skip Fix or Cancel run.
      await expect(toastsSaying(page, 'Findings ready')).toHaveCount(0)
      // Tab through the findings and the action row: focus always lands in sight, never under the row or a toast.
      const fixActions = findings.getByTestId('before-fix-actions')
      let reachedActions = false
      for (let i = 0; i < 40; i++) {
        await act(page, () => page.keyboard.press('Tab'))
        if ((await fixActions.locator(':focus').count()) > 0) reachedActions = true
        if ((await findings.locator(':focus').count()) === 0) break
      }
      expect(reachedActions, 'Tab never reached the action row').toBe(true)
      await expectFocusClear(page, 'Tab through the findings gate')
      await act(page, () => findings.getByTestId('card-choice-continue').click())
      await expect(findings).toBeHidden()

      // ---- the run ends; nothing moved on its own all along ----
      const ended = await e2e.waitForEnd(runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 2 must · 1 should')
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Run view through a live run')
      // In-app toasts came (the ask's, the completion's), but none for this run's gates, which its view shows as cards
      // with jump pills: there a toast would only cover the card's actions.
      await expect
        .poll(
          async () =>
            (await toastsSeen(page)).some((t) => /needs approval|approvals waiting|^Completed · /.test(t)),
          {
            message: 'no in-app toast came at all',
          },
        )
        .toBe(true)
      expect((await toastsSeen(page)).filter((t) => /^(Plan|Findings) ready · /.test(t))).toEqual([])

      // ---- the completed run: Flow, Diff, Log ----
      await audit(page, 'Run view (completed, Flow)')
      await expectRegionsLeavePage(page, 'Run view (completed, Flow)')
      // Each file's diff lays out as it comes near the view (Shiki in its worker); a file holds its estimated
      // height until then, so nothing moves on its own while they arrive. Both layouts, then the palette over it.
      await startWindow(page)
      await tab(page, 'diff')
      await expect(page.getByTestId('diff-tab')).toContainText('2 files changed')
      await audit(page, 'Run view (completed, Diff)')
      const diffFiles = page.locator('article[data-testid="diff-file"]')
      await expect(diffFiles).toHaveCount(2)
      // (Both files are new: the library lays out a side with nothing to pair as one column even in Split.)
      for (const file of await diffFiles.all())
        await expect(file.locator('pre[data-diff-type]')).toHaveCount(1, { timeout: 30_000 })
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Diff tab while its diffs lay out')
      await audit(page, 'Run view (completed, Diff: the diffs laid out, split)')
      await act(page, () => page.getByTestId('diff-layout').getByRole('radio', { name: 'Stacked' }).click())
      await expect(page.locator('pre[data-diff-type="single"]')).toHaveCount(2)
      await audit(page, 'Run view (completed, Diff: stacked)')
      await act(page, () => page.keyboard.press('ControlOrMeta+k'))
      await expect(page.locator('[data-scroll-region="palette"]')).toBeVisible()
      await audit(page, 'the palette open over the Diff tab')
      await act(page, () => page.keyboard.press('Escape'))
      await expect(page.getByTestId('palette')).toHaveCount(0)
      await act(page, () => page.getByTestId('diff-layout').getByRole('radio', { name: 'Split' }).click())
      await tab(page, 'log')
      await audit(page, 'Run view (completed, Log)')
      await expectRegionsLeavePage(page, 'Run view (completed, Log)')
      await act(page, () =>
        page.evaluate((id) => {
          location.hash = `#/runs/${id}`
        }, runId),
      )
      await expect(page.getByTestId('run-tab-flow')).toHaveAttribute('data-state', 'active')
      await audit(page, 'Run view (completed, opened again: its cards collapsed)')

      // ---- the Runs page and every Settings section ----
      await act(page, () => page.getByTestId('nav-runs').click())
      await expect(page.getByTestId(`runs-row-${runId}`)).toBeVisible()
      await audit(page, 'Runs')
      await act(page, () => page.getByTestId('nav-settings').click())
      const links = page.locator('[data-testid^="settings-section-"]')
      await expect(links.first()).toBeVisible()
      const sections = (
        await links.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
      ).map((id) => id.slice('settings-section-'.length))
      expect(sections).toEqual(expect.arrayContaining(['vendors', 'appearance', 'notifications']))
      for (const id of sections) {
        await act(page, () => page.getByTestId(`settings-section-${id}`).click())
        await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', id)
        await settingsLoaded(page)
        if (id === 'vendors') {
          await expect(page.getByTestId('settings-vendor-claude')).toBeVisible()
          if (s.large) await shot(page, 'settings-vendors')
        }
        await audit(page, `Settings → ${id}`)
      }
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 3. the guards see what they guard against ------------------------------------------------------------------------

test('UI layout: each guard fails on a planted regression', { tag: ['@cross-os'] }, async ({ e2e }) => {
  test.setTimeout(180_000)
  const page = await e2e.start({ scenario: { plan: { recording: 'C06-plan-native-host' } } })
  await sizeWindow(e2e, page, [1280, 900])
  await installGuard(page)
  await expect(page.getByTestId('composer')).toBeVisible()
  await audit(page, 'the Dashboard before anything is planted')

  /** Plant something in the page; the audit must fail on it, and pass again once it is gone. */
  const plants: { what: string; rule: RegExp; plant: () => void }[] = [
    {
      what: 'something reaching past the window (an absolutely placed element outside a positioned page)',
      rule: /\(a\) the document scrolls/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.style.cssText = 'position:absolute;top:0;left:0;width:10px;height:3000px'
        document.body.append(d)
      },
    },
    {
      what: 'a scroller of its own in the page',
      rule: /\(b\) a scroller besides <main>/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.style.cssText = 'overflow-y:auto;height:100px'
        d.innerHTML = '<div style="height:400px"></div>'
        document.querySelector('[data-testid="composer"]')?.append(d)
      },
    },
    {
      what: 'a capped scroller that does not overflow yet (the old composer)',
      rule: /\(b\) a scroller besides <main>/,
      plant: () => {
        const c = document.querySelector<HTMLElement>('[data-testid="composer"]')
        if (c === null) return
        c.dataset['planted'] = 'style'
        c.style.cssText = 'overflow-y:auto;max-height:70vh'
      },
    },
    {
      what: 'a region inside a region',
      rule: /\(b\) a scroller besides <main>/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.dataset['scrollRegion'] = 'outer'
        d.style.cssText = 'overflow-y:auto;max-height:100px;overscroll-behavior:contain'
        d.innerHTML =
          '<div data-scroll-region="inner" style="overflow-y:auto;max-height:50px;overscroll-behavior:contain"></div>'
        document.querySelector('[data-testid="composer"]')?.append(d)
      },
    },
    {
      what: 'an inner region whose name is not on the whitelist',
      rule: /\(c\) an inner region/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.dataset['scrollRegion'] = 'stray'
        d.style.cssText = 'overflow-y:auto;max-height:100px;overscroll-behavior:contain'
        document.querySelector('[data-testid="composer"]')?.append(d)
      },
    },
    {
      what: 'a region with no max height',
      rule: /\(c\) an inner region/,
      plant: () => {
        const t = document.querySelector<HTMLElement>('[data-scroll-region="task-input"]')
        if (t === null) return
        t.dataset['planted'] = 'style'
        t.style.maxHeight = 'none'
      },
    },
    {
      what: 'a region whose wheel reaches the page',
      rule: /\(c\) an inner region/,
      plant: () => {
        const t = document.querySelector<HTMLElement>('[data-scroll-region="task-input"]')
        if (t === null) return
        t.dataset['planted'] = 'style'
        t.style.overscrollBehavior = 'auto'
      },
    },
    {
      what: 'sideways scrolling',
      rule: /\(d\) sideways scrolling/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.style.cssText = 'overflow-x:auto;overflow-y:hidden'
        d.innerHTML = '<div style="width:5000px;height:4px"></div>'
        document.querySelector('[data-testid="composer"]')?.append(d)
      },
    },
    {
      what: 'sideways scrolling inside a shadow root (the diff view is one)',
      rule: /\(d\) sideways scrolling/,
      plant: () => {
        const host = document.createElement('div')
        host.dataset['planted'] = ''
        const inner = host.attachShadow({ mode: 'open' })
        inner.innerHTML =
          '<div style="overflow-x:auto;overflow-y:hidden"><div style="width:5000px;height:4px"></div></div>'
        document.querySelector('[data-testid="composer"]')?.append(host)
      },
    },
    {
      what: 'text cut with an ellipsis and no tooltip',
      rule: /\(e\) text cut with an ellipsis/,
      plant: () => {
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.style.cssText = 'width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        d.textContent = 'A run title far too long for its place'
        document.querySelector('[data-testid="composer"]')?.append(d)
      },
    },
  ]
  for (const p of plants) {
    await page.evaluate(p.plant)
    const failure = await audit(page, `planted: ${p.what}`).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    expect(failure, `the audit did not see ${p.what}`).toMatch(p.rule)
    await page.evaluate(unplant)
    await audit(page, `after removing ${p.what}`)
  }

  // A shift nobody asked for: content pushed down under the user's eyes.
  await startWindow(page)
  await page.evaluate(
    (wait) =>
      new Promise<void>((r) =>
        setTimeout(() => {
          const d = document.createElement('div')
          d.dataset['planted'] = ''
          d.style.height = '240px'
          document.querySelector('[data-testid="composer"]')?.prepend(d)
          r()
        }, wait),
      ),
    PLANTED_SHIFT_AFTER_MS,
  )
  await page.waitForTimeout(500)
  const shifted = await expectSteady(page, 'planted: a shift').then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(shifted, 'the guard did not see a layout shift').toMatch(/layout shifts without input add up to/)
  await page.evaluate(unplant)

  // A scroll nobody asked for: main scrolls itself well after the last input.
  await setScrollable(page)
  await startWindow(page)
  await page.waitForTimeout(INPUT_GRACE_MS + 200)
  await main(page).evaluate((el) => el.scrollTo({ top: 200 }))
  await page.waitForTimeout(300)
  const scrolled = await expectSteady(page, 'planted: a scroll').then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(scrolled, 'the guard did not see a scroll without input').toMatch(
    /something scrolled without the user/,
  )
  // The same scroll as the user's own: allowed.
  await scrollMainTo(page, 0)
  await startWindow(page)
  await scrollMainTo(page, 150)
  await expectSteady(page, 'a scroll the user made')
  await page.evaluate(unplant)

  // Keyboard focus under something drawn over it (a sticky bar, a toast): Tab to a button with a layer over it.
  await scrollMainTo(page, 0)
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="composer"]')
    const a = document.createElement('button')
    const b = document.createElement('button')
    for (const [el, text] of [
      [a, 'planted a'],
      [b, 'planted b'],
    ] as const) {
      el.dataset['planted'] = ''
      el.textContent = text
      host?.prepend(el)
    }
    host?.prepend(a)
    const r = b.getBoundingClientRect()
    const cover = document.createElement('div')
    cover.dataset['planted'] = ''
    cover.dataset['testid'] = 'planted-cover'
    cover.style.cssText = `position:fixed;z-index:9999;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;background:transparent`
    document.body.append(cover)
    a.focus({ preventScroll: true })
  })
  await startWindow(page)
  await act(page, () => page.keyboard.press('Tab'))
  await expect(page.getByRole('button', { name: 'planted b' })).toBeFocused()
  const covered = await expectFocusClear(page, 'planted: focus under a layer').then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(covered, 'the guard did not see focus under a layer').toMatch(/planted-cover/)
  await page.evaluate(unplant)
  expect(e2e.pageErrors).toEqual([])
})

// ---- 4. a burst of toasts ----------------------------------------------------------------------------------------------

test('UI layout: a burst of toasts moves no toast on screen', { tag: ['@cross-os'] }, async ({ e2e }) => {
  test.setTimeout(120_000)
  const page = await e2e.start({ scenario: { plan: { recording: 'C06-plan-native-host' } } })
  await sizeWindow(e2e, page, [1280, 900])
  await installGuard(page)
  await expect(page.getByTestId('composer')).toBeVisible()
  // The OS pointer rests where the newest toast shows (hover pauses a toast's timer): the window ignores it. The
  // window is raised above everything for the burst, so that pointer is over it whatever else is on the screen.
  const stack = await page.getByTestId('toaster').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.right - r.width / 2, y: r.bottom - 20 }
  })
  await raiseWindow(e2e, true)
  await underOsPointer(e2e, page, stack.x, stack.y)
  const outOfReach = await restingPointerOutOfReach(e2e)
  if (outOfReach !== null) {
    test.info().annotations.push({
      type: 'pointer not parked',
      description: `The burst ran without the OS pointer over the stack: ${outOfReach}.`,
    })
  }
  await recordPointer(page)
  await page.waitForTimeout(500)
  await startWindow(page)
  // Every toast's place, every frame, while it is shown.
  await page.evaluate(() => {
    const w = window as Window & { __toastMoves?: string[] }
    const moves: string[] = []
    w.__toastMoves = moves
    const seen = new Map<string, number>()
    const tick = (): void => {
      for (const li of document.querySelectorAll('[data-testid="toaster"] li[data-toast-id]')) {
        const id = li.getAttribute('data-toast-id') ?? ''
        const y = li.querySelector('[data-toast-card]')?.getBoundingClientRect().bottom
        if (y === undefined) continue
        const before = seen.get(id)
        if (before !== undefined && Math.abs(before - y) > 0.5) moves.push(`${id}: ${before} → ${y}`)
        seen.set(id, y)
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
  // Nine failures 0.6 s apart, of two lengths and three lives: the oldest are pushed out (at most three are shown)
  // and some expire under newer ones, while nobody touches anything.
  await page.evaluate(async (hook) => {
    const api = (window as unknown as Record<string, { toast(input: unknown): string }>)[hook]
    for (let i = 1; i <= 9; i++) {
      api?.toast({
        level: 'error',
        message: `Failed · Something went wrong${i % 3 === 1 ? '' : ` in step ${i} of the run, so it stopped there`}`,
        durationMs: [6000, 9000, 7000][i % 3],
      })
      await new Promise((r) => setTimeout(r, 600))
    }
  }, '__dimFactoryE2E')
  await expect(page.getByTestId('toaster').locator('li[data-toast-id]')).toHaveCount(0, { timeout: 25_000 })
  await raiseWindow(e2e, false)
  const moves = await page.evaluate(() => (window as Window & { __toastMoves?: string[] }).__toastMoves ?? [])
  expect(moves, 'a toast on screen moved').toEqual([])
  expect(await pointerSeen(page), 'the OS pointer reached the page').toEqual([])
  await expectSteady(page, 'the Dashboard through a burst of toasts')
  expect(e2e.pageErrors).toEqual([])
})

test(
  'UI layout: the E2E window ignores the resting OS pointer, and injected input still arrives',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    // On Linux (X11) setIgnoreMouseEvents only stops the X server's events; Chromium still sends the page a move at
    // the resting OS pointer when the window moves under it. The guard is a test aid (users never run with it), so this
    // check holds on Windows and macOS only.
    test.skip(process.platform === 'linux', 'X11: Chromium sends the page moves at the resting OS pointer')
    test.setTimeout(120_000)
    const page = await e2e.start()
    await expect(page.getByTestId('composer')).toBeVisible()
    const app = e2e.app
    if (app === null) throw new Error('the app is not running')
    // A full-window target, planted and planted again under the resting pointer (a layout change makes the browser
    // look for the pointer again).
    const replant = async (): Promise<void> => {
      await page.evaluate(() => {
        document.querySelector('[data-testid="pointer-target"]')?.remove()
        const d = document.createElement('div')
        d.dataset['planted'] = ''
        d.dataset['testid'] = 'pointer-target'
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent'
        document.body.append(d)
      })
      await settle(page)
    }
    await recordPointer(page)
    await replant()
    // Raised above everything for the pointer checks, so nothing else on the developer's screen (the taskbar, an
    // always-on-top window) sits between the window and the resting pointer.
    await raiseWindow(e2e, true)
    await underOsPointer(e2e, page, 300, 240)
    await replant()
    await page.waitForTimeout(1000)
    expect(await pointerSeen(page), 'the resting OS pointer reached the page').toEqual([])
    expect(await hovered(page), 'the resting OS pointer hovers').toEqual([])

    // The guard sees what it guards against: once the window takes the OS pointer again, the resting pointer hovers
    // the target (the window is raised and moved under it again, and the target planted again, until the page hears
    // of it). Where the pointer cannot be over even a raised window (it rests on the taskbar, or the session is
    // locked) this half is left out, with a note; the halves above and below hold everywhere.
    const outOfReach = await restingPointerOutOfReach(e2e)
    if (outOfReach !== null) {
      test.info().annotations.push({
        type: 'not checked',
        description: `The guard failing once the window takes the OS pointer again: ${outOfReach}.`,
      })
    } else {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setIgnoreMouseEvents(false))
      let nudge = 0
      await expect
        .poll(
          async () => {
            nudge = 1 - nudge
            await raiseWindow(e2e, true)
            await underOsPointer(e2e, page, 300 + nudge, 240 + nudge)
            await replant()
            return (
              (await pointerSeen(page)).length > 0 && (await hovered(page)).includes('DIV[pointer-target]')
            )
          },
          { message: 'a window that takes the OS pointer hears the resting pointer', timeout: 15_000 },
        )
        .toBe(true)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setIgnoreMouseEvents(true))
    }
    await raiseWindow(e2e, false)

    // Injected input still arrives with the OS pointer ignored: Playwright's (CDP) move, click, wheel and hover …
    await clearPointerSeen(page)
    await page.mouse.move(100, 100)
    await page.mouse.click(120, 130)
    await page.mouse.wheel(0, 120)
    await page.getByTestId('pointer-target').hover({ position: { x: 200, y: 210 } })
    await expect
      .poll(() => pointerSeen(page))
      .toEqual(
        expect.arrayContaining([
          'mousemove at 100,100',
          'mousedown at 120,130',
          'click at 120,130',
          'wheel at 120,130',
          'mousemove at 200,210',
        ]),
      )
    expect(await hovered(page)).toContain('DIV[pointer-target]')
    // … and webContents.sendInputEvent's.
    await clearPointerSeen(page)
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      wc?.sendInputEvent({ type: 'mouseMove', x: 50, y: 60 })
      wc?.sendInputEvent({ type: 'mouseDown', x: 50, y: 60, button: 'left', clickCount: 1 })
      wc?.sendInputEvent({ type: 'mouseUp', x: 50, y: 60, button: 'left', clickCount: 1 })
      wc?.sendInputEvent({ type: 'mouseWheel', x: 50, y: 60, deltaX: 0, deltaY: -120 })
    })
    await expect
      .poll(() => pointerSeen(page))
      .toEqual(
        expect.arrayContaining([
          'mousemove at 50,60',
          'mousedown at 50,60',
          'click at 50,60',
          'wheel at 50,60',
        ]),
      )
    await page.evaluate(unplant)
    expect(e2e.pageErrors).toEqual([])
  },
)

/**
 * Remove what was planted (runs in the page): planted elements go, and an element whose style was planted
 * (data-planted="style") gets its own style back (none: the app styles with classes).
 */
function unplant(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-planted]')) {
    if (el.dataset['planted'] === 'style') {
      el.style.cssText = ''
      delete el.dataset['planted']
    } else el.remove()
  }
}

/** The message a check fails with, or null when it passes. */
async function failure(check: () => Promise<unknown>): Promise<string | null> {
  return check().then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
}

/** The planted shift waits this long first, past the last input's grace (hadRecentInput lasts 500 ms). */
const PLANTED_SHIFT_AFTER_MS = 1200

/** Make sure <main> has room to scroll (the empty Dashboard may fit the window). */
async function setScrollable(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = document.createElement('div')
    d.dataset['planted'] = ''
    d.style.height = '2000px'
    document.querySelector('[data-testid="main"] > *')?.append(d)
  })
}

// ---- 5. page zoom, and the Run view's compact sticky block ------------------------------------------------------------

/**
 * A key press as the OS delivers it. The zoom keys are main's (before-input-event, src/main/menu.ts), which
 * Playwright's own keyboard goes past.
 */
async function osKey(e2e: E2EHarness, keyCode: string): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  const modifiers: ('control' | 'meta')[] = [process.platform === 'darwin' ? 'meta' : 'control']
  await e2e.app.evaluate(
    ({ BrowserWindow }, [k, mods]) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      wc?.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: [...mods] })
      wc?.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: [...mods] })
    },
    [keyCode, modifiers] as const,
  )
}

async function zoomFactor(e2e: E2EHarness): Promise<number> {
  if (e2e.app === null) throw new Error('the app is not running')
  return e2e.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0,
  )
}

/** The zoom keys from 100%: Ctrl/Cmd+0, then Ctrl/Cmd+= until `factor`; then the page has laid itself out. */
async function zoomTo(e2e: E2EHarness, page: Page, factor: number): Promise<void> {
  await osKey(e2e, '0')
  await expect.poll(() => zoomFactor(e2e)).toBe(1)
  for (let i = 0; i < 6 && (await zoomFactor(e2e)) < factor - 0.001; i++) await osKey(e2e, '=')
  await expect.poll(() => zoomFactor(e2e)).toBe(factor)
  await page.waitForTimeout(300)
  await settle(page)
}

/** The Run view's sticky block form, and the reading area between it and the SummaryBar as a share of <main>. */
async function runLayout(page: Page): Promise<{ form: string | null; share: number }> {
  return page.evaluate(() => {
    const h = (sel: string): number => document.querySelector(sel)?.getBoundingClientRect().height ?? 0
    const main = document.querySelector('main')?.clientHeight ?? 1
    return {
      form: document.querySelector('[data-testid="run-sticky-top"]')?.getAttribute('data-form') ?? null,
      share: (main - h('[data-testid="run-sticky-top"]') - h('[data-testid="summary-bar"]')) / main,
    }
  })
}

test(
  'UI layout: page zoom works, the Run view leaves 55% of the page to read where it must, and its bars Tab in place',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: { plan: { recording: 'C06-plan-native-host' } },
      config: { gates: { afterPlan: true } },
    })
    await sizeWindow(e2e, page, [1280, 900])
    await expect(page.getByTestId('composer')).toBeVisible()

    // ---- the zoom keys step the zoom, Ctrl/Cmd+0 resets it, and nothing puts it back on its own ----
    expect(await zoomFactor(e2e)).toBe(1)
    await osKey(e2e, '=')
    await expect.poll(() => zoomFactor(e2e)).toBe(1.1)
    await osKey(e2e, '=')
    await expect.poll(() => zoomFactor(e2e)).toBe(1.25)
    await osKey(e2e, '-')
    await expect.poll(() => zoomFactor(e2e)).toBe(1.1)
    await page.waitForTimeout(500)
    expect(await zoomFactor(e2e)).toBe(1.1)
    await osKey(e2e, '0')
    await expect.poll(() => zoomFactor(e2e)).toBe(1)

    // ---- the Dashboard, Runs and Settings at 150% ----
    await zoomTo(e2e, page, 1.5)
    await audit(page, 'Dashboard at 150%')
    await page.getByTestId('nav-runs').click()
    await audit(page, 'Runs at 150%')
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-vendors').click()
    await expect(page.getByTestId('settings-vendor-claude')).toBeVisible()
    await audit(page, 'Settings → Vendors at 150%')
    await page.getByTestId('nav-dashboard').click()
    await zoomTo(e2e, page, 1)

    // ---- a run at the plan gate: the reading area at every size and zoom ----
    await e2e.runFromDashboard('add a --version flag')
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    const forms: string[] = []
    for (const [size, zoom, form] of [
      [[1280, 900], 1, 'full'],
      [[1280, 900], 1.25, 'full'],
      [[1280, 900], 1.5, 'compact'],
      [[900, 600], 1, 'compact'],
    ] as const) {
      // The window is sized at 100% (its CSS size is then its size), then zoomed.
      await zoomTo(e2e, page, 1)
      await sizeWindow(e2e, page, size)
      await zoomTo(e2e, page, zoom)
      const where = `the plan gate at ${size.join(' × ')}, ${zoom * 100}%`
      const l = await runLayout(page)
      forms.push(`${where}: ${l.form ?? 'none'} (${Math.round(l.share * 100)}% to read)`)
      expect(l.form, where).toBe(form)
      expect(l.share, `${where}: the reading area's share of the page`).toBeGreaterThanOrEqual(0.55)
      await audit(page, where)
      // The compact strip is one line: no step wraps onto a second.
      if (form === 'compact')
        expect(
          await page
            .getByTestId('phase-timeline')
            .evaluate(
              (el) =>
                new Set(
                  [...el.querySelectorAll('ol > li')].map((n) => Math.round(n.getBoundingClientRect().top)),
                ).size,
            ),
          `${where}: the step strip is one line`,
        ).toBe(1)
    }
    test.info().annotations.push({ type: 'forms', description: forms.join('; ') })

    // ---- zoomed to 150% and back with the keys: the full block is back as soon as it fits at the page's width ----
    await zoomTo(e2e, page, 1)
    await sizeWindow(e2e, page, [1280, 900])
    await zoomTo(e2e, page, 1.5)
    expect((await runLayout(page)).form, 'the plan gate at 1280 × 900, 150%').toBe('compact')
    for (const zoom of [1.25, 1.1, 1]) {
      await osKey(e2e, '-')
      await expect.poll(() => zoomFactor(e2e)).toBe(zoom)
      await page.waitForTimeout(300)
      await settle(page)
      const l = await runLayout(page)
      expect(l.form, `back from 150% to ${zoom * 100}% (${Math.round(l.share * 100)}% to read)`).toBe('full')
    }

    // ---- a switch keeps the reading position, scrolls nothing, and happens once (at 125%: the window's height
    // alone then decides the form) ----
    await zoomTo(e2e, page, 1.25)
    await installGuard(page)
    const plan = gate.getByTestId('plan-preview')
    // Room below the plan, so no window size holds the page at its end (that scrolls it, switch or not).
    await page.evaluate(() => {
      const d = document.createElement('div')
      d.dataset['planted'] = ''
      d.style.height = '1500px'
      document.querySelector('[data-testid="run-content"]')?.append(d)
    })
    await scrollToReading(page, plan)
    await page.evaluate(() => {
      const w = window as Window & { __formChanges?: string[] }
      w.__formChanges = []
      const top = document.querySelector('[data-testid="run-sticky-top"]')
      if (top === null) return
      new MutationObserver(() => w.__formChanges?.push(top.getAttribute('data-form') ?? '')).observe(top, {
        attributes: true,
        attributeFilter: ['data-form'],
      })
    })
    /** Where the plan sits under the sticky block (px), and main's offset. */
    const reading = (): Promise<{ below: number; top: number }> =>
      plan.evaluate((el) => {
        const block =
          document.querySelector('[data-testid="run-sticky-top"]')?.getBoundingClientRect().bottom ?? 0
        return {
          below: Math.round(el.getBoundingClientRect().top - block),
          top: Math.round(document.querySelector('main')?.scrollTop ?? 0),
        }
      })
    const before = await reading()
    expect(before.top, 'the page is scrolled for the check').toBeGreaterThan(0)
    await startWindow(page)
    // Only the height changes, so nothing reflows but the sticky block.
    await sizeWindow(e2e, page, [1280, 600], 1.25)
    expect((await runLayout(page)).form).toBe('compact')
    expect(await reading(), 'the switch to compact moved the reading position').toEqual(before)
    await sizeWindow(e2e, page, [1280, 900], 1.25)
    expect((await runLayout(page)).form).toBe('full')
    expect(await reading(), 'the switch back moved the reading position').toEqual(before)
    await page.waitForTimeout(500)
    const changes = await page.evaluate(
      () => (window as Window & { __formChanges?: string[] }).__formChanges ?? [],
    )
    expect(changes, 'the sticky block took turns between its forms').toEqual(['compact', 'full'])
    const r = await readWindow(page)
    expect(
      r.unprompted.map((s) => `${s.target} scrolled to ${s.top}`),
      'the switch scrolled the page',
    ).toEqual([])

    // ---- Tab through the sticky block's controls, and focus on Open diff, scroll nothing (full and compact) ----
    await zoomTo(e2e, page, 1)
    expect((await runLayout(page)).form).toBe('full')
    await expectBarsTabInPlace(page, 'the full block at 1280 × 900, 100%')
    // Planted: the bars unmarked, as before (their scroll padding stays while focus is on their own controls).
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-sticky-bar]')) {
        el.dataset['plantedBar'] = el.dataset['stickyBar'] ?? ''
        delete el.dataset['stickyBar']
      }
    })
    expect(
      await failure(() => expectBarsTabInPlace(page, 'planted: the bars unmarked')),
      'the check did not see Tab scroll the page',
    ).toMatch(/focus moving through the sticky bars scrolled the page/)
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-planted-bar]')) {
        el.dataset['stickyBar'] = el.dataset['plantedBar'] ?? ''
        delete el.dataset['plantedBar']
      }
    })
    await zoomTo(e2e, page, 1.5)
    expect((await runLayout(page)).form).toBe('compact')
    await expectBarsTabInPlace(page, 'the compact block at 1280 × 900, 150%')
    await zoomTo(e2e, page, 1)
    expect(e2e.pageErrors).toEqual([])
  },
)

/** The name of what has focus, for a failure message. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (el === null) return 'nothing'
    return el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase()
  })
}

/**
 * Keyboard focus moving through the Run view's sticky bars never scrolls the page: from the block's first control, Tab
 * through every control of the sticky block (header, tabs, step timeline or strip, jump pills), then focus Open diff in the SummaryBar.
 * Each is in view wherever the bar sticks, so <main>'s offset must not change (the page is scrolled first, so a
 * scroll would show).
 */
async function expectBarsTabInPlace(page: Page, where: string): Promise<void> {
  await scrollMainTo(page, 400)
  const top = await mainTop(page)
  expect(top, `${where}: the page is scrolled for the check`).toBeGreaterThan(100)
  const moved: string[] = []
  const note = async (): Promise<void> => {
    const now = await mainTop(page)
    if (now !== top) moved.push(`${await focusedName(page)} → ${now}`)
  }
  // The block's first control shown (the folder in the full header, Stop in the compact one), focused as Tab would.
  await page.evaluate(() => {
    const block = document.querySelector('[data-testid="run-sticky-top"]')
    const controls = block?.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), [tabindex="0"]') ?? []
    ;[...controls].find((el) => el.checkVisibility({ visibilityProperty: true }))?.focus()
  })
  await settle(page)
  await note()
  let stops = 0
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    await settle(page)
    const inTop = await page.evaluate(
      () =>
        document.activeElement?.closest('[data-testid="run-sticky-top"]') !== null &&
        document.activeElement !== null,
    )
    if (!inTop) break
    stops++
    await note()
  }
  expect(stops, `${where}: Tab went through the block's controls`).toBeGreaterThan(4)
  // Back where the check started (the Tab out of the block may scroll to what it lands on, which is right).
  await scrollMainTo(page, top)
  await page.getByTestId('open-diff').focus()
  await settle(page)
  await note()
  expect(moved, `${where}: focus moving through the sticky bars scrolled the page`).toEqual([])
}

// ---- 6. zoomed: every screen at 125% and 150% (webContents.setZoomFactor), with planted regressions ------------------

/** The plan gate shows at least this much of the plan's text (CSS px) between the sticky block and its action row. */
const PLAN_SHOWN_MIN = 200
/** The Run view's sticky block takes at most this share of <main>'s height. */
const STICKY_MAX = 0.45
/** Between the Dashboard's folder row and its task box, nothing empty is taller than this (CSS px). */
const EMPTY_MAX = 40

/** The views walked: 1280 × 900 at 100%, 125% and 150%, and the 900 × 600 window at 100%. */
const ZOOMED = [
  { name: '1280 × 900 at 100%', size: [1280, 900], zoom: 1, shot: '100' },
  { name: '1280 × 900 at 125%', size: [1280, 900], zoom: 1.25, shot: '125' },
  { name: '1280 × 900 at 150%', size: [1280, 900], zoom: 1.5, shot: '150' },
  { name: '900 × 600 at 100%', size: [900, 600], zoom: 1, shot: 'small' },
] as const
type Zoomed = (typeof ZOOMED)[number]
/** A window size and page zoom to look at. */
interface View {
  name: string
  size: readonly [number, number]
  zoom: number
  shot: string
}

/** Set the page zoom the way Electron does (webContents.setZoomFactor); then the page has laid itself out at it. */
async function setZoom(e2e: E2EHarness, page: Page, factor: number): Promise<void> {
  if (e2e.app === null) throw new Error('the app is not running')
  const width = await e2e.app.evaluate(({ BrowserWindow }, f) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    win.webContents.setZoomFactor(f)
    return win.getContentSize()[0] ?? 0
  }, factor)
  await expect.poll(() => zoomFactor(e2e)).toBeCloseTo(factor, 2)
  // The page's CSS width is the window's over the zoom.
  await page.waitForFunction(([w, f]) => Math.abs(window.innerWidth * f - w) <= 2 * f, [
    width,
    factor,
  ] as const)
  await page.waitForTimeout(200)
  await settle(page)
}

/** The window sized at 100% (its CSS size is then its size), then zoomed. */
async function showAt(e2e: E2EHarness, page: Page, v: View): Promise<void> {
  await setZoom(e2e, page, 1)
  await sizeWindow(e2e, page, v.size)
  await setZoom(e2e, page, v.zoom)
}

/** The whole window as the user sees it (Electron's capturePage: Playwright's screenshot crops under page zoom). */
async function windowShot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === '' || e2e.app === null) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await settle(page)
  const png = await e2e.app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage()
    return img?.toPNG().toString('base64') ?? ''
  })
  writeFileSync(join(SHOTS_DIR, `${name}.png`), Buffer.from(png, 'base64'))
}

/** Zoom is not locked: Ctrl/Cmd+= (as the OS delivers it) changes the zoom factor. The factor is put back after. */
async function expectZoomKeys(e2e: E2EHarness, page: Page, where: string): Promise<void> {
  const before = await zoomFactor(e2e)
  try {
    await osKey(e2e, '=')
    await expect
      .poll(() => zoomFactor(e2e), {
        message: `${where}: Ctrl/Cmd+= left the zoom at ${before}`,
        timeout: 3000,
      })
      .toBeGreaterThan(before + 0.001)
  } finally {
    await setZoom(e2e, page, before)
  }
}

/**
 * Nothing empty between the Dashboard's folder row and its task box: no element there taller than EMPTY_MAX with no
 * text and no control, and no stretch of the band taller than EMPTY_MAX that shows neither text nor a control (space
 * kept for something that is not there, such as an empty note line under the folder chips).
 */
async function expectNoEmptyBand(page: Page, where: string): Promise<void> {
  const found = await page.evaluate((max) => {
    const out: string[] = []
    const row = document.querySelector('[data-testid="composer-folder-input"]')?.parentElement ?? null
    const task = document.querySelector('[data-testid="composer-task"]')
    const composer = document.querySelector('[data-testid="composer"]')
    if (row === null || task === null || composer === null) return ['no folder row, task box or composer']
    const top = row.getBoundingClientRect().bottom
    const bottom = task.getBoundingClientRect().top
    const CONTROL =
      'button, input, textarea, select, a[href], [role="button"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])'
    const name = (el: Element): string => {
      const id = el.getAttribute('data-testid')
      const cls =
        typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
      return `${el.tagName.toLowerCase()}${id !== null ? `[data-testid="${id}"]` : cls !== '' ? `.${cls}` : ''}`
    }
    // An element wholly in the band, taller than the limit, that shows no text and holds no control.
    for (const el of composer.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height <= max || r.top < top - 0.5 || r.bottom > bottom + 0.5) continue
      // innerText leaves out text that is not shown (hidden, or a reserved label kept invisible).
      const text = el instanceof HTMLElement ? el.innerText : (el.textContent ?? '')
      if (text.trim() !== '' || el.matches(CONTROL) || el.querySelector(CONTROL) !== null) continue
      out.push(`${name(el)} is ${Math.round(r.height)} px tall and empty`)
    }
    // The band's widest stretch that no visible text (its line boxes) or control (its box) reaches into.
    const filled: [number, number][] = []
    const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const parent = n.parentElement
      if ((n.textContent ?? '').trim() === '' || parent === null) continue
      if (getComputedStyle(parent).visibility !== 'visible') continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) filled.push([r.top, r.bottom])
    }
    for (const el of composer.querySelectorAll(CONTROL)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) filled.push([r.top, r.bottom])
    }
    const spans = filled
      .map(([a, b]): [number, number] => [Math.max(a, top), Math.min(b, bottom)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0])
    spans.push([bottom, bottom])
    let at = top
    let widest = 0
    let from = top
    for (const [a, b] of spans) {
      if (a - at > widest) {
        widest = a - at
        from = at
      }
      at = Math.max(at, b)
    }
    if (widest > max)
      out.push(
        `an empty stretch of ${Math.round(widest)} px, ${Math.round(from - top)} px under the folder row`,
      )
    return out
  }, EMPTY_MAX)
  expect(found, `${where}: something empty between the folder row and the task box`).toEqual([])
}

/** The Run view's sticky block (header, tabs, steps) takes at most STICKY_MAX of <main>'s height. */
async function expectStickyShare(page: Page, where: string): Promise<number> {
  const share = await page.evaluate(() => {
    const main = document.querySelector('main')
    const top = document.querySelector('[data-testid="run-sticky-top"]')
    if (main === null || top === null || main.clientHeight === 0) return null
    return top.getBoundingClientRect().height / main.clientHeight
  })
  if (share === null) throw new Error(`${where}: there is no sticky block or <main>`)
  expect(share, `${where}: the sticky block's share of <main>'s height`).toBeLessThanOrEqual(STICKY_MAX)
  return share
}

/**
 * The plan gate brought to the top of the reading area (just under the sticky block, where its jump pill brings it):
 * at least PLAN_SHOWN_MIN CSS px of the plan's text show between the sticky block and the card's action row (and
 * above the SummaryBar).
 */
async function expectPlanShown(page: Page, where: string): Promise<number> {
  const gate = page.getByTestId('card-gate:afterPlan')
  await scrollToReading(page, gate)
  const shown = await gate.evaluate((card) => {
    const preview = card.querySelector('[data-testid="plan-preview"]')
    const row = card.querySelector('[data-testid="plan-gate-actions"]')
    const block = document.querySelector('[data-testid="run-sticky-top"]')
    const bar = document.querySelector('[data-testid="summary-bar"]')
    if (preview === null || row === null || block === null || bar === null) return null
    const p = preview.getBoundingClientRect()
    const cs = getComputedStyle(preview)
    const px = (v: string): number => Number.parseFloat(v) || 0
    const textTop = p.top + px(cs.borderTopWidth) + px(cs.paddingTop)
    const textBottom = p.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom)
    const top = Math.max(textTop, block.getBoundingClientRect().bottom)
    const bottom = Math.min(textBottom, row.getBoundingClientRect().top, bar.getBoundingClientRect().top)
    return Math.max(0, bottom - top)
  })
  if (shown === null) throw new Error(`${where}: no plan preview, action row, sticky block or SummaryBar`)
  expect(
    shown,
    `${where}: the plan text shown between the sticky block and the action row (CSS px)`,
  ).toBeGreaterThanOrEqual(PLAN_SHOWN_MIN)
  return shown
}

/** No item the SummaryBar shows is cut (what does not fit gives way whole), and Open diff is inside the bar. */
async function expectSummaryWhole(page: Page, where: string): Promise<void> {
  const cut = await page.getByTestId('summary-bar').evaluate((bar) => {
    const out: string[] = []
    for (const el of bar.querySelectorAll<HTMLElement>('[data-testid^="summary-"]')) {
      if (el.offsetParent === null) continue
      if (el.scrollWidth > el.clientWidth + 1)
        out.push(`${el.dataset['testid']} "${el.textContent}" (${el.clientWidth} of ${el.scrollWidth} px)`)
    }
    const b = bar.getBoundingClientRect()
    const open = bar.querySelector('[data-testid="open-diff"]')?.getBoundingClientRect()
    if (open === undefined || open.right > b.right + 0.5 || open.left < b.left)
      out.push('Open diff is not inside the bar')
    return out
  })
  expect(cut, `${where}: the SummaryBar cuts what it shows`).toEqual([])
}

/** On the icon rail, a count on a nav icon keeps off the icon (at most a sliver of a corner, under 1.5 px). */
async function expectRailBadgesOffIcons(page: Page, where: string): Promise<void> {
  const { over, checked } = await page.evaluate(() => {
    const out: string[] = []
    let checked = 0
    for (const id of ['nav-dashboard', 'nav-runs']) {
      const item = document.querySelector(`[data-testid="${id}"]`)
      const icon = item?.querySelector('svg')?.getBoundingClientRect()
      const badge = item?.querySelector('[aria-label]')?.getBoundingClientRect()
      if (icon === undefined || badge === undefined) continue
      checked++
      const w = Math.min(icon.right, badge.right) - Math.max(icon.left, badge.left)
      const h = Math.min(icon.bottom, badge.bottom) - Math.max(icon.top, badge.top)
      if (w > 1.5 && h > 1.5)
        out.push(`${id}: the count covers ${w.toFixed(1)} × ${h.toFixed(1)} px of the icon`)
    }
    return { over: out, checked }
  })
  expect(checked, `${where}: no count on the rail to check`).toBeGreaterThan(0)
  expect(over, `${where}: a count sits on its icon`).toEqual([])
}

/**
 * Settings sits at the foot of the sidebar: below Dashboard, Runs and the active runs, wholly in view, right above
 * the footer (vendor health dots and version), and in the same place with or without runs in the list.
 */
async function expectSettingsAtFoot(page: Page, where: string): Promise<{ top: number }> {
  const r = await page.evaluate(() => {
    const box = (sel: string): DOMRect | undefined => document.querySelector(sel)?.getBoundingClientRect()
    const settings = box('[data-testid="nav-settings"]')
    const runs = box('[data-testid="nav-runs"]')
    const aside = box('aside[aria-label="Sidebar"]')
    const footer = document
      .querySelector('ul[aria-label="Vendor health"]')
      ?.parentElement?.getBoundingClientRect()
    return { settings, runs, aside, footer }
  })
  const { settings, runs, aside, footer } = r
  expect(settings, `${where}: no Settings in the sidebar`).toBeDefined()
  if (settings === undefined || runs === undefined || aside === undefined || footer === undefined)
    throw new Error(`${where}: the sidebar is not whole`)
  expect(settings.top, `${where}: Settings is not below Runs`).toBeGreaterThanOrEqual(runs.bottom)
  expect(settings.bottom, `${where}: Settings runs into the footer`).toBeLessThanOrEqual(footer.top + 0.5)
  expect(
    footer.top - settings.bottom,
    `${where}: Settings is not at the foot (above the footer)`,
  ).toBeLessThan(16)
  expect(settings.top, `${where}: Settings is cut off at the top of the sidebar`).toBeGreaterThanOrEqual(
    aside.top,
  )
  return { top: settings.top }
}

/** Implement's answer: long enough to stream through every zoomed check of the live run. */
const ZOOM_RUN_TEXT = longText(30_000)

test(
  'UI layout: at 125% and 150% zoom every screen keeps one scroller, the plan shows, and nothing empty is kept',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(300_000)
    const page = await e2e.start({
      scenario: streamingImplement(ZOOM_RUN_TEXT),
      editScenario: (sc) => streamDeltas(sc, 'implement-1', ZOOM_RUN_TEXT, { chunkSize: 40, sleepMs: 40 }),
      config: { gates: { afterPlan: true } },
    })
    await sizeWindow(e2e, page, [1280, 900])
    await expect(page.getByTestId('composer')).toBeVisible()
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
    const measured: string[] = []
    const at1280 = (zooms: readonly number[]): Zoomed[] =>
      ZOOMED.filter((v) => v.size[0] === 1280 && zooms.includes(v.zoom))
    const [at100, , at150, small] = ZOOMED

    // ---- zoom is not locked: Ctrl/Cmd+= changes it, at 100% and at 150%; the check sees the zoom keys gone ----
    await expectZoomKeys(e2e, page, 'the Dashboard at 100%')
    await setZoom(e2e, page, 1.5)
    await expectZoomKeys(e2e, page, 'the Dashboard at 150%')
    await setZoom(e2e, page, 1)
    const app = e2e.app
    if (app === null) throw new Error('the app is not running')
    // Planted: the zoom keys gone, as under the old lock (main's key handler off, and no menu to carry them).
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc === undefined) throw new Error('no window')
      const g = globalThis as { __plantedZoomLock?: unknown }
      g.__plantedZoomLock = { keys: wc.listeners('before-input-event'), menu: Menu.getApplicationMenu() }
      wc.removeAllListeners('before-input-event')
      Menu.setApplicationMenu(null)
    })
    expect(
      await failure(() => expectZoomKeys(e2e, page, 'planted: the zoom keys gone')),
      'the check did not see the zoom locked',
    ).toMatch(/Ctrl\/Cmd\+= left the zoom at 1\b/)
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      const g = globalThis as {
        __plantedZoomLock?: { keys: ((...args: unknown[]) => void)[]; menu: Electron.Menu | null }
      }
      const planted = g.__plantedZoomLock
      if (wc === undefined || planted === undefined) throw new Error('nothing was planted')
      for (const listener of planted.keys)
        (wc as unknown as NodeJS.EventEmitter).on('before-input-event', listener)
      Menu.setApplicationMenu(planted.menu)
      delete g.__plantedZoomLock
    })
    await expectZoomKeys(e2e, page, 'the Dashboard at 100%, the zoom keys back')

    // ---- the Dashboard, empty and then filled in, in every view: one scroller and no empty band ----
    for (const filled of [false, true]) {
      if (filled) {
        await showAt(e2e, page, at100)
        await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
        await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
        await expect(page.getByTestId('preflight-ok')).toBeVisible({ timeout: 30_000 })
      }
      for (const v of ZOOMED) {
        await showAt(e2e, page, v)
        const where = `the Dashboard (${filled ? 'folder and task in' : 'empty'}) at ${v.name}`
        await audit(page, where)
        await expectNoEmptyBand(page, where)
        if (filled && v.size[0] === 1280 && v.zoom !== 1.25) {
          await scrollMainTo(page, 0)
          await windowShot(e2e, page, `dashboard-${v.shot}`)
        }
      }
    }
    // Planted at 150%: an empty block under the folder chips; then the old empty note line kept under them.
    await showAt(e2e, page, at150)
    const chipsLine = page.getByTestId('folder-chips').locator('xpath=..')
    await chipsLine.evaluate((line) => {
      const d = document.createElement('div')
      d.dataset['planted'] = ''
      d.style.height = '56px'
      line.after(d)
    })
    expect(
      await failure(() => expectNoEmptyBand(page, 'planted: an empty block')),
      'the check did not see an empty block',
    ).toMatch(/div is 56 px tall and empty/)
    await page.evaluate(unplant)
    await chipsLine.evaluate((line) => {
      line.dataset['planted'] = 'style'
      line.style.cssText = 'flex-direction:column;gap:6px;height:auto'
      const d = document.createElement('div')
      d.dataset['planted'] = ''
      d.style.height = '28px'
      line.append(d)
    })
    expect(
      await failure(() => expectNoEmptyBand(page, 'planted: the old note line')),
      'the check did not see an empty line kept under the chips',
    ).toMatch(/an empty stretch of \d+ px/)
    await page.evaluate(unplant)
    await expectNoEmptyBand(page, 'the Dashboard at 150%, the plants gone')

    // ---- the Dashboard's compact Run bar: focus on its controls scrolls nothing ----
    await showAt(e2e, page, at100)
    await setScrollable(page)
    await scrollMainTo(page, 600)
    await expect(page.getByTestId('compact-bar')).toBeVisible()
    const barTop = await mainTop(page)
    /** Focus on each of the bar's controls, from where the page is; what scrolled it. */
    const focusInBar = async (): Promise<string[]> => {
      const moved: string[] = []
      for (const id of ['compact-task', 'compact-run']) {
        await scrollMainTo(page, barTop)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.getByTestId(id).focus()
        await settle(page)
        const now = await mainTop(page)
        if (now !== barTop) moved.push(`${id} → ${now}`)
      }
      return moved
    }
    expect(await focusInBar(), 'focus on the compact Run bar scrolled the page').toEqual([])
    // Planted: the bar unmarked (its top scroll padding stays while focus is in it).
    const compactBar = page.getByTestId('compact-bar')
    await compactBar.evaluate((el) => el.removeAttribute('data-sticky-bar'))
    expect((await focusInBar()).length, 'the check did not see the unmarked bar scroll').toBeGreaterThan(0)
    await compactBar.evaluate((el) => el.setAttribute('data-sticky-bar', 'top'))
    expect(await focusInBar(), 'focus on the compact Run bar scrolled the page (marked again)').toEqual([])
    await page.evaluate(unplant)
    await scrollMainTo(page, 0)

    // ---- a run at the plan gate in every view ----
    await showAt(e2e, page, at100)
    const { runId } = await e2e.runFromDashboard('add a --version flag')
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    for (const v of ZOOMED) {
      await showAt(e2e, page, v)
      const where = `the plan gate at ${v.name}`
      await audit(page, where)
      const share = await expectStickyShare(page, where)
      const shown = await expectPlanShown(page, where)
      expect(
        await regionsFillingTheReadingArea(page),
        `${where}: an inner region fills the reading area`,
      ).toEqual([])
      const form = (await runLayout(page)).form ?? 'no'
      measured.push(
        `${where}: ${form} block, ${Math.round(share * 100)}% of <main>, ${Math.round(shown)} px of plan`,
      )
      await windowShot(e2e, page, v === small ? 'run-small' : `run-plan-gate-${v.shot}`)
    }
    // Planted at 150%: a tall step strip (as the old stretched timeline nodes were); then a taller action row.
    await showAt(e2e, page, at150)
    await page.getByTestId('phase-timeline').evaluate((el) => {
      el.dataset['planted'] = 'style'
      el.style.minHeight = '320px'
    })
    expect(
      await failure(() => expectStickyShare(page, 'planted: a tall step strip')),
      'the check did not see the sticky block take the page',
    ).toMatch(/the sticky block's share of <main>'s height/)
    await page.evaluate(unplant)
    await settle(page)
    await expectStickyShare(page, 'the plan gate at 150%, the tall strip gone')
    await gate.getByTestId('plan-gate-actions').evaluate((el) => {
      el.dataset['planted'] = 'style'
      el.style.paddingBottom = '160px'
    })
    expect(
      await failure(() => expectPlanShown(page, 'planted: a tall action row')),
      'the check did not see the plan squeezed',
    ).toMatch(/the plan text shown between the sticky block and the action row/)
    await page.evaluate(unplant)
    await settle(page)
    await expectPlanShown(page, 'the plan gate at 150%, the tall action row gone')

    // ---- the live run (Implement streaming), zoomed and in the small window ----
    await showAt(e2e, page, at100)
    await act(page, () => gate.getByTestId('card-choice-approve').click())
    await expect(gate).toBeHidden()
    const stream = page.getByTestId('stream-implement')
    await expect
      .poll(() => stream.evaluate((el) => Number(el.getAttribute('data-blocks') ?? 0)), { timeout: 60_000 })
      .toBeGreaterThan(0)
    for (const v of [...at1280([1.25, 1.5]), small]) {
      await showAt(e2e, page, v)
      await scrollToReading(page, page.getByTestId('pass-card-implement'))
      const where = `the live run at ${v.name}`
      await audit(page, where)
      const share = await expectStickyShare(page, where)
      expect(
        await regionsFillingTheReadingArea(page),
        `${where}: an inner region fills the reading area`,
      ).toEqual([])
      await expectSummaryWhole(page, where)
      const form = (await runLayout(page)).form ?? 'no'
      measured.push(`${where}: ${form} block, ${Math.round(share * 100)}% of <main>`)
      if (v === at150) await windowShot(e2e, page, 'run-live-150')
    }
    // Planted at 150%: something too long in the bar, which cuts the rest.
    await setZoom(e2e, page, 1.5)
    await page.getByTestId('summary-bar').evaluate((bar) => {
      const d = document.createElement('span')
      d.dataset['planted'] = ''
      d.style.cssText = 'flex-shrink:0;white-space:nowrap'
      d.textContent = 'planted '.repeat(40)
      bar.firstElementChild?.append(d)
    })
    expect(
      await failure(() => expectSummaryWhole(page, 'planted: a long item')),
      'the check did not see the SummaryBar cut',
    ).toMatch(/the SummaryBar cuts what it shows/)
    await page.evaluate(unplant)
    await settle(page)
    await expectSummaryWhole(page, 'the live run at 150%, the long item gone')
    // The icon rail (a 1280 px window from 175%), the run still live: the Runs count stays off its icon.
    await setZoom(e2e, page, 1.75)
    await expectRailBadgesOffIcons(page, 'the icon rail at 1280 × 900, 175%')
    await expectSettingsAtFoot(page, 'the icon rail at 1280 × 900, 175%, a run live')
    expect(
      (await e2e.snapshot(runId)).steps.implement.status,
      'the run was not live through its checks',
    ).toBe('running')

    // ---- the Runs page and every Settings section, zoomed ----
    await showAt(e2e, page, at100)
    // The live run is in the sidebar's list, and Settings is still at the foot, where it is with no run listed.
    await expect(page.getByTestId('nav-active-runs')).toBeVisible()
    await expectSettingsAtFoot(page, '1280 × 900 at 100%, a run live')
    await act(page, () => page.getByTestId('nav-runs').click())
    await expect(page.getByTestId(`runs-row-${runId}`)).toBeVisible()
    for (const v of at1280([1.25, 1.5])) {
      await setZoom(e2e, page, v.zoom)
      await audit(page, `Runs at ${v.name}`)
    }
    await setZoom(e2e, page, 1)
    await act(page, () => page.getByTestId('nav-settings').click())
    // The section list renders after the route change: wait for it before reading it.
    const sectionLinks = page.locator('[data-testid^="settings-section-"]')
    await expect.poll(() => sectionLinks.count()).toBeGreaterThan(10)
    const sections = await sectionLinks.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')?.slice('settings-section-'.length) ?? ''),
    )
    // 1280 × 900 at 125% and 150%; and (past the levels the layout must hold) the 900 × 600 window at 175%, where the
    // page is about 440 CSS px wide and the section list moves above the section.
    const settingsViews: View[] = [
      ...at1280([1.25, 1.5]),
      { name: '900 × 600 at 175%', size: [900, 600], zoom: 1.75, shot: 'small-175' },
    ]
    for (const v of settingsViews) {
      await showAt(e2e, page, v)
      for (const id of sections) {
        await act(page, () => page.getByTestId(`settings-section-${id}`).click())
        await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', id)
        await settingsLoaded(page)
        await audit(page, `Settings → ${id} at ${v.name}`)
        if (
          (v === at150 && (id === 'vendors' || id === 'catalog')) ||
          (v.zoom === 1.75 && id === 'vendors')
        ) {
          await scrollMainTo(page, 0)
          await windowShot(e2e, page, `settings-${id}-${v.shot}`)
        }
      }
    }
    await setZoom(e2e, page, 1)
    test.info().annotations.push({ type: 'zoomed', description: measured.join('; ') })

    const ended = await e2e.waitForEnd(runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(e2e.pageErrors).toEqual([])
  },
)

// ---- 4. a verify round --------------------------------------------------------------------------------------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: a verify round keeps still, its output follows only while pinned, and its cards and the Settings Verify half keep one scroller`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      // Verify on, after Implement only, with three commands: `check` fails (Implement writes 0.1.0), `chatty` keeps
      // the round running with output growing past the pane until the test releases it, and `lint` (npm run lint, not
      // trusted yet) calls a program this computer does not have.
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
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
      const created = await act(page, () => e2e.runFromDashboard('add a --version flag'))
      const runId = created.runId
      const gate = page.getByTestId('card-gate:afterPlan')
      await expect(gate).toBeVisible({ timeout: 90_000 })
      await act(page, async () => {
        await gate.getByTestId('card-choice-approve').click()
        await expect(gate).toBeHidden()
      })
      // From here the Run view stays open on the run: what core reports moves nothing on its own.
      await startWindow(page)

      // ---- Implement, then the trust card for lint at the end of the flow ----
      const trust = page.getByTestId('card-trust')
      await expect(trust).toBeAttached({ timeout: 90_000 })
      await expect(trust).toContainText('Trust the lint check?')
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Run view from Implement to the trust card')
      await scrollToReading(page, trust)
      await audit(page, 'Run view (the trust card)')
      await act(page, async () => {
        await trust.getByTestId('card-choice-trust').click()
        await expect(trust).toBeHidden()
      })

      // ---- the round runs: its output pane follows while the user is at its bottom ----
      const card = page.getByTestId('pass-card-verify:1')
      const pane = card.getByTestId('verify-output-verify:1')
      await expect(pane).toContainText('chatty line 150', { timeout: 60_000 })
      await expect(card).toHaveAttribute('data-status', 'running')
      await scrollToReading(page, card)
      await startWindow(page)
      const scrollable = (): Promise<boolean> => pane.evaluate((el) => el.scrollHeight > el.clientHeight + 40)
      await expect.poll(scrollable).toBe(true)
      const atEnd = (): Promise<boolean> =>
        pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24)
      const textLength = (): Promise<number> => pane.evaluate((el) => (el.textContent ?? '').length)
      let before = await textLength()
      await expect.poll(textLength, { message: 'the round output did not grow' }).toBeGreaterThan(before)
      await expect.poll(atEnd, { message: 'the pinned pane did not follow its output' }).toBe(true)
      const jump = card.getByTestId('verify-output-jump-verify:1')
      await expect(jump).toBeHidden()
      await expectSteady(page, 'the Run view while a verify round writes its output')
      await audit(page, 'Run view (a verify round running)')
      await expectRegionsLeavePage(page, 'Run view (a verify round running)')

      // Scrolled up by the user: it stays where they left it while output keeps coming; Jump to latest takes them back.
      await user(page)
      await pane.evaluate((el) => el.scrollTo({ top: 0 }))
      await expect(jump).toBeVisible()
      before = await textLength()
      await expect.poll(textLength, { message: 'the round output did not grow' }).toBeGreaterThan(before)
      await settle(page)
      expect(
        await pane.evaluate((el) => el.scrollTop),
        'the pane followed although the user scrolled up',
      ).toBe(0)
      await audit(page, 'Run view (a verify round running, its output scrolled up)')
      await act(page, () => jump.click())
      await expect(jump).toBeHidden()
      await expect.poll(atEnd).toBe(true)
      before = await textLength()
      await expect.poll(textLength).toBeGreaterThan(before)
      await expect.poll(atEnd, { message: 'the pane did not follow again after Jump to latest' }).toBe(true)

      // ---- the round ends: check failed, chatty passed, lint could not run (the verifyEnv card) ----
      await startWindow(page)
      releaseChatty(e2e)
      const env = page.getByTestId('card-verifyEnv')
      await expect(env).toBeAttached({ timeout: 60_000 })
      await expect(card.getByTestId('verify-command-verify:1-0')).toHaveAttribute('data-status', 'fail')
      await expect(card.getByTestId('verify-command-verify:1-1')).toHaveAttribute('data-status', 'pass')
      await expect(card.getByTestId('verify-command-verify:1-2')).toHaveAttribute('data-status', 'env')
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Run view as a verify round ends')
      await act(page, () => card.getByTestId('verify-command-verify:1-0-excerpt-toggle').click())
      await expect(card.getByTestId('verify-command-verify:1-0-excerpt')).toContainText(
        'expected version 1.0.0',
      )
      await scrollToReading(page, card)
      await audit(page, 'Run view (a verify round with a failure, its excerpt open)')
      await scrollToReading(page, env)
      await audit(page, 'Run view (the verifyEnv card)')
      await expectRegionsLeavePage(page, 'Run view (a failed verify round and the verifyEnv card)')
      await act(page, async () => {
        await env.getByTestId('card-choice-skip-verify').click()
        await expect(env).toBeHidden()
      })

      // ---- the reviewers, the gate before Fix (F1 from Verify), Fix and the end ----
      // Read from the top while the reviewers run, as in the live-run walk above: the gate before Fix arrives out of
      // view, as a jump pill, and nothing scrolls. (A reviewer card trades its live stream for its findings when done,
      // so where Review and Critic stack, in the 900 px window, one finishing above the other moves it while in view:
      // the PassCard's behaviour, not the verify round's.)
      await scrollMainTo(page, 0)
      await startWindow(page)
      const findings = page.getByTestId('card-gate:beforeFix')
      await expectPillNotScroll(page, {
        pill: 'jump-findings',
        target: findings,
        label: 'Findings ready for review',
      })
      await expectSteady(page, 'the Run view from the verify round to the gate before Fix')
      await audit(page, 'Run view (the gate before Fix with a finding from Verify)')
      await act(page, async () => {
        await findings.getByTestId('card-choice-continue').click()
        await expect(findings).toBeHidden()
      })
      const ended = await e2e.waitForEnd(runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Run view from the gate before Fix to the end')
      await audit(page, 'Run view (completed, with a failed verify round)')
      await expectRegionsLeavePage(page, 'Run view (completed, with a failed verify round)')

      // Opened again: the round is over, its rows come first with the excerpt open and its output in a disclosure.
      await act(page, () => page.getByTestId('nav-runs').click())
      await expect(page.getByTestId(`runs-row-${runId}`)).toBeVisible()
      await act(page, () =>
        page.evaluate((id) => {
          location.hash = `#/runs/${id}`
        }, runId),
      )
      const again = page.getByTestId('pass-card-verify:1')
      await act(page, () => again.getByRole('button', { name: 'Verify', exact: true }).click())
      // The first failure's excerpt is open; lint's opens on a click (no two inner regions stacked on their own).
      await expect(again.getByTestId('verify-command-verify:1-0-excerpt')).toBeVisible()
      await expect(again.getByTestId('verify-command-verify:1-2-excerpt')).toHaveCount(0)
      await audit(page, 'Run view (completed, opened again: the verify round open)')
      await expectRegionsLeavePage(page, 'Run view (completed, opened again: the verify round open)')
      // The user opens the round's output too.
      await act(page, () => again.getByTestId('verify-output-details-verify:1').locator('summary').click())
      await expect(again.getByTestId('verify-output-verify:1')).toContainText('chatty done')
      await audit(page, 'Run view (completed, opened again: the verify round and its output open)')

      // ---- Settings → Isolation & Verify for the project: the command table with a changed script ----
      setScripts(e2e, { lint: 'dim-factory-e2e-missing-linter --check src' })
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-isolation').click())
      await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'isolation')
      await act(page, () => page.getByTestId('verify-folder-choose').click())
      await settingsLoaded(page)
      await expect(page.getByTestId('verify-row-lint')).toHaveAttribute('data-trust', 'changed')
      await expect(page.getByTestId('verify-row-check')).toHaveAttribute('data-trust', 'trusted')
      await expect(page.getByTestId('verify-row-lint-diff')).toBeVisible()
      await audit(page, "Settings → Isolation & Verify (a project's commands, one changed)")
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 7. an isolated run ----------------------------------------------------------------------------------------------

/** The tracked file an isolated run's Implement changes (the user edits it too: a conflict). */
const RUN_INDEX = { path: 'src/index.ts', content: 'export const greeting = "from the run"\n' }

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: an isolated run keeps still, its install output follows only while pinned, and its cards, the Apply panel and the Settings Isolation half keep one scroller`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      // The isolated copy's install (`node install.mjs <release>`) prints a line every 100 ms until released; Implement
      // changes src/index.ts, which the user edits in the folder meanwhile (a conflict), and writes src/version.ts.
      const page = await e2e.start({
        scenario: {
          plan: { recording: 'C06-plan-native-host' },
          implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
        },
        editScenario: (sc) => writeBeforeResult(sc, 'implement-1', [RUN_INDEX]),
        config: isolatedConfig(
          { mode: 'worktree', installCommand: slowInstallArgv(e2e) },
          { gates: { afterPlan: true, beforeFix: false } },
        ),
        pickSandbox: true,
      })
      commitSandbox(e2e, { 'install.mjs': INSTALL_SCRIPT })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
      const created = await act(page, () => e2e.runFromDashboard('add a --version flag'))
      const runId = created.runId
      // From here the Run view stays open on the run: the prepare rows are there from its start, and what core reports
      // moves nothing on its own.
      await startWindow(page)

      // ---- prepare makes the copy, then asks before installing (the plan gate may come first) ----
      const consent = page.getByTestId('card-depsConsent')
      await expect(consent).toBeAttached({ timeout: 120_000 })
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Run view from the run’s start to the depsConsent card')
      await scrollToReading(page, consent)
      await audit(page, 'Run view (the depsConsent card)')
      await act(page, async () => {
        await consent.getByTestId('card-choice-install').click()
        await expect(consent).toBeHidden()
      })

      // ---- the install runs: its output pane follows while the user is at its bottom ----
      const prep = page.getByTestId('pass-card-prepare')
      const pane = prep.getByTestId('prepare-output')
      await expect(pane).toContainText('fetching package', { timeout: 60_000 })
      await expect(prep.getByTestId('prepare-step-deps')).toHaveAttribute('data-status', 'running')
      await scrollToReading(page, prep)
      await startWindow(page)
      const scrollable = (): Promise<boolean> => pane.evaluate((el) => el.scrollHeight > el.clientHeight + 40)
      await expect.poll(scrollable, { timeout: 60_000 }).toBe(true)
      const atEnd = (): Promise<boolean> =>
        pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24)
      const textLength = (): Promise<number> => pane.evaluate((el) => (el.textContent ?? '').length)
      let before = await textLength()
      await expect.poll(textLength, { message: 'the install output did not grow' }).toBeGreaterThan(before)
      await expect.poll(atEnd, { message: 'the pinned pane did not follow its output' }).toBe(true)
      const jump = prep.getByTestId('prepare-output-jump')
      await expect(jump).toBeHidden()
      await expectSteady(page, 'the Run view while the install writes its output')
      await audit(page, 'Run view (installing dependencies)')
      await expectRegionsLeavePage(page, 'Run view (installing dependencies)')

      // Scrolled up by the user: it stays where they left it; Jump to latest takes them back and it follows again.
      await user(page)
      await pane.evaluate((el) => el.scrollTo({ top: 0 }))
      await expect(jump).toBeVisible()
      before = await textLength()
      await expect.poll(textLength, { message: 'the install output did not grow' }).toBeGreaterThan(before)
      await settle(page)
      expect(
        await pane.evaluate((el) => el.scrollTop),
        'the pane followed although the user scrolled up',
      ).toBe(0)
      await audit(page, 'Run view (installing dependencies, the output scrolled up)')
      await act(page, () => jump.click())
      await expect(jump).toBeHidden()
      await expect.poll(atEnd).toBe(true)
      before = await textLength()
      await expect.poll(textLength).toBeGreaterThan(before)
      await expect.poll(atEnd, { message: 'the pane did not follow again after Jump to latest' }).toBe(true)

      // ---- the install ends; the plan gate; the user edits a file the run changes too ----
      await startWindow(page)
      releaseInstall(e2e)
      await expect(prep.getByTestId('prepare-step-deps')).toHaveAttribute('data-status', 'done', {
        timeout: 60_000,
      })
      const gate = page.getByTestId('card-gate:afterPlan')
      await expect(gate).toBeAttached({ timeout: 90_000 })
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Run view as the install ends and the plan arrives')
      writeFileSync(join(e2e.sandbox, RUN_INDEX.path), 'export const greeting = "my edit"\n')
      await scrollToReading(page, gate)
      await act(page, async () => {
        await gate.getByTestId('card-choice-approve').click()
        await expect(gate).toBeHidden()
      })

      // ---- Implement in the copy, the reviewers, then the finalize card ----
      await startWindow(page)
      const fin = page.getByTestId('card-finalize')
      await expect(fin).toBeAttached({ timeout: 180_000 })
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Run view from Implement to the finalize card')
      await scrollToReading(page, fin)
      await audit(page, 'Run view (the finalize card)')

      // ---- the Diff tab's live Apply panel, its conflicts open ----
      await tab(page, 'diff')
      await expect(page.getByTestId('diff-apply-facts')).toHaveText('1 file to write · 1 conflict')
      await audit(page, 'Diff tab (the Apply panel)')
      await act(page, () => page.getByTestId('diff-apply-conflicts-toggle').click())
      await expect(page.getByTestId('diff-apply-conflicts')).toContainText(RUN_INDEX.path)
      await audit(page, 'Diff tab (the Apply panel, its conflicts open)')
      await tab(page, 'flow')

      // ---- Apply to folder → the conflicts card, a file's change open → Keep mine → applied ----
      await scrollToReading(page, fin)
      await act(page, async () => {
        await fin.getByTestId('card-choice-apply').click()
        await expect(fin).toBeHidden()
      })
      const conflicts = page.getByTestId('card-finalizeConflicts')
      await expect(conflicts).toBeAttached({ timeout: 60_000 })
      await scrollToReading(page, conflicts)
      await audit(page, 'Run view (the finalizeConflicts card)')
      await act(page, () => conflicts.getByTestId('conflict-0-toggle').click())
      await expect(conflicts.getByTestId('conflict-diff')).toContainText('from the run')
      await audit(page, "Run view (the finalizeConflicts card, the run's change open)")
      await startWindow(page)
      await act(page, async () => {
        await conflicts.getByTestId('card-choice-keep-mine').click()
        await expect(conflicts).toBeHidden()
      })
      const ended = await e2e.waitForEnd(runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await expect(page.getByTestId('finalize-state')).toHaveAttribute('data-state', 'applied')
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Run view from Keep mine to the end')
      await audit(page, 'Run view (applied)')

      // ---- Settings → Isolation & Verify for the project: the Isolation half, the copy-ins editor open ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-isolation').click())
      await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'isolation')
      await act(page, () => page.getByTestId('verify-folder-choose').click())
      await settingsLoaded(page)
      await expect(page.getByTestId('isolation-install-ask')).toBeChecked()
      await audit(page, 'Settings → Isolation & Verify (the Isolation half)')
      await act(page, () => page.getByTestId('isolation-copy-edit').click())
      await expect(page.getByTestId('isolation-copy-editor')).toBeVisible()
      await audit(page, 'Settings → Isolation & Verify (the copy-ins editor open)')
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 8. the Runs history, Re-run from Fix's findings picker and the Re-run menu ----------------------------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the Runs history keeps still (a run ending, filters, Load more, an undo row and its delete), and the findings picker and the Re-run menu keep one scroller`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      // 130 earlier runs (seeded before launch); a run whose Fix fails keeps its folder; its re-run from Fix resumes.
      const api = join(e2e.root, 'projects', 'api')
      seedHistory(e2e, manyRows(130, api, 'earlier api run'))
      const page = await e2e.start({ scenario: findingsFlow([FAILED_FIX, RESUMED_FIX]), config: NO_GATES })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await act(page, () => openRunsPage(page))
      await expect(page.getByTestId('runs-count')).toHaveText('100 runs')
      await audit(page, 'Runs (100 of 130 runs)')

      // ---- a run starts and fails while the page is open: no row is inserted, nothing moves ----
      await scrollMainTo(page, 200)
      await startWindow(page)
      const top = await mainTop(page)
      const { runId: source } = await e2e.call('runs.start', {
        folder: e2e.sandbox,
        task: 'add a --version flag',
        overrides: {},
      })
      const failed = await e2e.waitForEnd(source)
      expect(failed.status, e2e.describeRun(failed)).toBe('failed')
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Runs page while a run starts and fails')
      expect(await mainTop(page)).toBe(top)
      expect(await rowIds(page)).not.toContain(source)

      // ---- the filters (the user's own clicks replace the list), a custom date range open ----
      await startWindow(page)
      await act(page, () => page.getByTestId('runs-filter-failed').click())
      await expect(runRow(page, source)).toBeVisible()
      await act(page, () => page.getByTestId('runs-filter-date').selectOption('custom'))
      await expect(page.getByTestId('runs-filter-from')).toBeVisible()
      await act(page, () => page.getByTestId('runs-filter-text').fill('version'))
      await expect(page.getByTestId('runs-count')).toHaveText('1 run')
      await page.waitForTimeout(500)
      await expectSteady(page, 'the Runs page as the user sets filters')
      await audit(page, 'Runs (filters set, a custom date range open)')
      await act(page, () => page.getByTestId('runs-filter-clear').click())
      await expect(page.getByTestId('runs-count')).toHaveText('100 runs')

      // ---- Load more: the next page arrives below; the row above the button stays where the user reads it ----
      await user(page)
      await page.getByTestId('runs-load-more').evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await settle(page)
      const before = await rowIds(page)
      const last = runRow(page, before.at(-1) ?? '')
      const lastY = (await last.boundingBox())?.y
      const scrolled = await mainTop(page)
      await startWindow(page)
      await act(page, () => page.getByTestId('runs-load-more').click())
      await expect(page.getByTestId('runs-count')).toHaveText('131 runs')
      await settle(page)
      expect((await last.boundingBox())?.y).toBe(lastY)
      expect(await mainTop(page)).toBe(scrolled)
      expect((await rowIds(page)).slice(0, before.length)).toEqual(before)
      await expectSteady(page, 'the Runs page (Load more)')
      await audit(page, 'Runs (131 runs, after Load more)')

      // ---- Remove: an undo row of the same height in its place; nothing moves while core deletes the run ----
      await scrollMainTo(page, 0)
      const ids = await rowIds(page)
      const target = ids[2] ?? ''
      const next = runRow(page, ids[3] ?? '')
      const nextY = (await next.boundingBox())?.y
      const height = (await runRow(page, target).boundingBox())?.height
      await startWindow(page)
      await act(page, () => page.getByTestId(`runs-remove-${target}`).click())
      await expect(runRow(page, target)).toHaveAttribute('data-removed', 'removed')
      expect((await runRow(page, target).boundingBox())?.height).toBe(height)
      expect((await next.boundingBox())?.y).toBe(nextY)
      await audit(page, 'Runs (an undo row)')
      // The undo window (10 s) passes and core deletes the run: the row stays as it is, and the page keeps still.
      await page.waitForTimeout(12_000)
      await expectSteady(page, 'the Runs page while a removed run is deleted')
      expect((await next.boundingBox())?.y).toBe(nextY)

      // ---- the failed run's row: its actions menu, then the findings picker under it (focused, in view) ----
      await act(page, () => page.getByTestId('runs-filter-failed').click())
      await expect(runRow(page, source)).toBeVisible()
      await auditMenu(page, page.getByTestId(`runs-menu-${source}`), 'Runs (the failed run)')
      await startWindow(page)
      await act(page, async () => {
        await page.getByTestId(`runs-menu-${source}`).click()
        await page.getByTestId('runs-action-rerun-fix').click()
      })
      const rowPicker = page.getByTestId(`runs-fix-picker-${source}`)
      await expect(rowPicker).toBeFocused()
      await expect.poll(() => whereIs(rowPicker)).toBe('in')
      await audit(page, 'Runs (the findings picker under a row)')
      await expectFocusClear(page, 'Runs (the findings picker under a row)')
      await act(page, () => rowPicker.getByTestId('fix-picker-cancel').click())
      await expect(rowPicker).toHaveCount(0)

      // ---- the failed run's view: Re-run ▾, then the picker at the end of the Flow tab, brought into view ----
      await act(page, () => page.locator(`[data-testid="runs-row-${source}"] a`).click())
      await expect(page.getByTestId('run-view')).toBeVisible()
      await auditMenu(page, page.getByTestId('rerun-menu'), 'Run view (failed)')
      await startWindow(page)
      await act(page, async () => {
        await page.getByTestId('rerun-menu').click()
        await page.getByTestId('rerun-from-fix').click()
      })
      const picker = page.getByTestId(`fix-picker-${source}`)
      await expect(picker).toBeFocused()
      await expect.poll(() => whereIs(picker)).toBe('in')
      await audit(page, 'Run view (failed, the findings picker)')
      await expectFocusClear(page, 'Run view (failed, the findings picker)')

      // ---- the re-run: from its start to its end in its own view, nothing moves on its own ----
      await act(page, () => picker.getByTestId('fix-picker-start').click())
      await expect(page).not.toHaveURL(new RegExp(`#/runs/${source}$`))
      await expect(page.getByTestId('run-view')).toBeVisible()
      await startWindow(page)
      const rerun = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
      const ended = await e2e.waitForEnd(rerun)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Run view of a re-run from Fix, from its start to its end')
      await audit(page, 'Run view (a re-run from Fix, completed: Plan, Implement, Review and Critic carried)')
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 9. the catalog ----------------------------------------------------------------------------------------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the catalog consent card arrives and runs without moving anything, and Settings → Catalog's review keeps its place with one scroller`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      // Two refreshes answer catalog.spec.ts's prices, each after a few seconds (the job is seen running).
      await loadRefreshConverter()
      const page = await e2e.start({
        editScenario: withRefreshes([
          { proposal: E21_PROPOSAL, holdMs: 4_000 },
          { proposal: E21_PROPOSAL, holdMs: 4_000 },
        ]),
      })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

      // ---- the refresh becomes due with the Dashboard open: the card arrives at the rail's end, nothing moves ----
      await startWindow(page)
      await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
      const card = consentCard(page)
      await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
      await expect(card.getByTestId('catalog-card-estimate')).toHaveText(/^~\d+ min/)
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Dashboard as the catalog consent card arrives')
      await audit(page, 'Dashboard (the catalog consent card)')

      // ---- Update now: the card runs, then offers the review; nothing moves on its own ----
      await act(page, () => card.getByTestId('catalog-card-update').click())
      await expect(card).toHaveAttribute('data-mode', 'running')
      await startWindow(page)
      await audit(page, 'Dashboard (the catalog card while the update runs)')
      await expect(card).toHaveAttribute('data-mode', 'review', { timeout: 60_000 })
      await page.waitForTimeout(1000)
      await expectSteady(page, 'the Dashboard while the update runs and ends')
      await audit(page, 'Dashboard (the catalog card: changes to review)')

      // ---- Review changes: Settings → Catalog's review table; ticking rows moves nothing ----
      await act(page, () => card.getByTestId('catalog-card-review').click())
      await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'catalog')
      const table = page.getByTestId('catalog-diff')
      await expect(table).toBeVisible({ timeout: 20_000 })
      await settingsLoaded(page)
      await page.waitForTimeout(1000)
      await expectFocusClear(page, 'Settings → Catalog (the review, from the card)')
      await audit(page, 'Settings → Catalog (the review table)')
      await startWindow(page)
      for (const id of [ROW.sonnetInput, ROW.sonnetInput, ROW.haikuOutput, ROW.haikuOutput])
        await act(page, () => page.getByTestId(`catalog-diff-tick-${id}`).click())
      await expect(page.getByTestId('catalog-diff-apply')).toHaveText('Apply 1 change')
      await page.waitForTimeout(500)
      await expectSteady(page, 'Settings → Catalog while rows are ticked and unticked')

      // ---- Apply (the user's action closes the review); the history and its Undo ----
      await act(page, () => page.getByTestId('catalog-diff-apply').click())
      await expect(page.getByTestId('catalog-history-undo')).toBeVisible()
      await audit(page, 'Settings → Catalog (applied: the history and its Undo)')

      // ---- an update started here: the review block keeps one place and height while it runs and ends ----
      await scrollMainTo(page, 0)
      await act(page, () => page.getByTestId('catalog-update').click())
      const review = page.getByTestId('catalog-review')
      await expect(review).toHaveAttribute('data-state', 'running')
      const reserved = page.getByTestId('catalog-review-reserved')
      const box = await reserved.boundingBox()
      const prices = page.getByTestId('catalog-prices')
      const pricesY = (await prices.boundingBox())?.y
      await startWindow(page)
      await audit(page, 'Settings → Catalog (an update running)')
      await expect(review).toHaveAttribute('data-state', 'diff-ready', { timeout: 60_000 })
      await expect(page.getByTestId('catalog-review-show')).toBeVisible()
      await page.waitForTimeout(1000)
      await expectSteady(page, 'Settings → Catalog while an update runs and its changes arrive')
      expect(await reserved.boundingBox()).toEqual(box)
      expect((await prices.boundingBox())?.y).toBe(pricesY)
      await audit(page, 'Settings → Catalog (changes waiting behind Show changes)')
      await act(page, () => page.getByTestId('catalog-review-show').click())
      await expect(table).toBeVisible()
      await audit(page, 'Settings → Catalog (the second review table)')

      // ---- a price being edited (its row's boxes and a refused value) ----
      const key = 'claude-claude-sonnet-5-5'
      await act(page, () => page.getByTestId(`catalog-edit-${key}`).click())
      await act(page, () => page.getByTestId(`catalog-edit-${key}-outputPerMTok`).fill('-1'))
      await act(page, () => page.getByTestId(`catalog-save-${key}`).click())
      await expect(page.getByTestId(`catalog-edit-error-${key}`)).toBeVisible()
      await audit(page, 'Settings → Catalog (a price being edited, a value refused)')
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- 9b. the catalog: a failed refresh, and prices turning stale, move nothing ----------------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: a refresh that fails keeps the Dashboard's catalog card, and prices turning stale keep Settings → Catalog still`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(300_000)
      // One refresh, started from Settings → Catalog, fails after a while (C18b: the answer never matched the schema).
      await loadRefreshConverter()
      const page = await e2e.start({ editScenario: withRefreshes([{ fails: true, holdMs: 8_000 }]) })
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

      // ---- Update now in Settings (no refresh is due), then the Dashboard, scrolled to the rail's end ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-catalog').click())
      await settingsLoaded(page)
      await act(page, () => page.getByTestId('catalog-update').click())
      await expect(page.getByTestId('catalog-review')).toHaveAttribute('data-state', 'running')
      await act(page, () => page.getByTestId('nav-dashboard').click())
      const card = consentCard(page)
      await expect(card).toHaveAttribute('data-mode', 'running')
      await scrollMainTo(page, 100_000)
      await startWindow(page)

      // ---- it fails: the card says so in the running card's layout and stays; nothing moves, nothing scrolls ----
      await expect(card).toHaveAttribute('data-mode', 'failed', { timeout: 60_000 })
      await expect(card.getByTestId('catalog-card-status')).toHaveText(/^The price update failed: /)
      await page.waitForTimeout(1500)
      await expectSteady(page, 'the Dashboard (scrolled to the rail’s end) as the refresh fails')
      await audit(page, 'Dashboard (the catalog card: the update failed)')
      // Close (the user's action) takes it away.
      await act(page, () => card.getByTestId('catalog-card-close').click())
      await expect(card).toHaveCount(0)

      // ---- Settings → Catalog open as the prices turn stale (and a refresh comes due): the tables keep still ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-catalog').click())
      await settingsLoaded(page)
      const prices = page.getByTestId('catalog-prices-claude')
      await expect(prices).toBeVisible()
      await scrollMainTo(page, 0)
      const y = (await prices.boundingBox())?.y
      await startWindow(page)
      await advanceClock(e2e, 2 * INTERVAL_DAYS * DAY_MS + DAY_MS)
      await expect(page.getByTestId('catalog-status-stale')).toHaveText(
        'Older than twice the refresh interval, so estimates may be off.',
        { timeout: 30_000 },
      )
      await page.waitForTimeout(1000)
      await expectSteady(page, 'Settings → Catalog as the prices turn stale')
      expect((await prices.boundingBox())?.y).toBe(y)
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- Codex: the sandbox chip, the Codex vendor card, local presets and a cross-vendor run ----------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the Codex sandbox setup, the Codex card, local presets and a cross-vendor run keep one scroller and keep still`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(360_000)
      const thread = threadIdNow(`uil${s.size[0]}`)
      const implementTotal = { input: 24_576, cached: 16_384, output: 1_450, reasoning: 512 }
      const page = await e2e.start({
        scenario: {
          plan: { recording: 'C06-plan-native-host' },
          review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        },
        config: {
          profile: 'balanced',
          gates: { afterPlan: true, beforeFix: false },
          local: {
            presets: [
              { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'qwen3-coder' },
            ],
          },
        },
        codex: {
          sandbox: IS_WIN32 ? 'notConfigured' : 'ready',
          // The first setup does not finish (core answers seconds after the click), the second works.
          setup: { delayMs: 2_500, success: false },
          edit: editPass({
            threadId: thread,
            turnId: 'turn-uil-implement',
            text: 'Added the --version flag.',
            approval: { command: 'npm test', reason: 'Run the test suite' },
            write: VERSION_WRITE,
            total: implementTotal,
            delayMs: 1_500,
          }),
          resume: {
            threadId: thread,
            ops: resumePass({
              threadId: thread,
              turnId: 'turn-uil-fix',
              text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 fixed',
              write: FIX_WRITE,
              restored: implementTotal,
              total: { input: 55_296, cached: 40_960, output: 2_430, reasoning: 896 },
              delayMs: 1_500,
            }),
          },
        },
      })
      const fake = e2e.codex
      if (fake === null) throw new Error('no fake Codex')
      fake.writeRollout(thread)
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-codex')).toHaveAttribute(
        'data-health',
        IS_WIN32 ? 'sandbox-needed' : 'ready',
        { timeout: 30_000 },
      )
      const input = page.getByTestId('composer-folder-input')
      await act(page, async () => {
        await input.fill(e2e.sandbox)
        await input.press('Enter')
        await page.getByTestId('composer-task').fill('add a --version flag')
      })
      await expect(page.getByTestId('composer-passes')).toContainText('Codex')

      if (IS_WIN32) {
        // ---- Windows: the strip blocked with the sandbox chip; the setup runs; nothing moves on its own ----
        await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run', {
          timeout: 30_000,
        })
        await showChecks(page)
        await audit(page, 'Dashboard (the Codex sandbox not set up: its chips)')
        const chip = page.getByTestId('setup-codex-sandbox-chip')
        // A setup that does not finish adds nothing on its own (the elevated command waits behind its
        // disclosure), so the page keeps still from the click to core's answer seconds later.
        await startWindow(page)
        await act(page, () => page.getByTestId('setup-codex-sandbox').click())
        await expect(chip).toHaveAttribute('data-phase', 'running')
        await audit(page, 'Dashboard (the Codex sandbox being set up)')
        await expect(chip).toHaveAttribute('data-phase', 'failed', { timeout: 60_000 })
        await page.waitForTimeout(1_000)
        await expectSteady(page, 'the Dashboard while a Codex sandbox setup runs and does not finish')
        await act(page, () => page.getByTestId('setup-codex-sandbox-more').click())
        await expect(page.getByTestId('setup-codex-sandbox-elevated')).toBeVisible()
        await audit(page, 'Dashboard (the sandbox setup did not finish: the elevated command opened)')
        // Again, and this time it works.
        fake.set({ setup: { delayMs: 1_500, success: true } })
        await startWindow(page)
        await act(page, () => page.getByTestId('setup-codex-sandbox').click())
        await expect(chip).toHaveAttribute('data-phase', 'running')
        await expect.poll(() => fake.requests('windowsSandbox/setupStart').length).toBe(2)
        fake.set({ sandbox: 'ready' })
        await expect(page.getByTestId('setup-codex-sandbox-chip')).toHaveAttribute('data-phase', 'ready', {
          timeout: 60_000,
        })
        await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
        await page.waitForTimeout(1_000)
        await expectSteady(page, 'the Dashboard while the Codex sandbox is set up and the block clears')
        await audit(page, 'Dashboard (the Codex sandbox ready)')
      }
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
      await setPassRows(page, true)
      await audit(page, 'Dashboard (balanced, the pass rows open)')

      // ---- Settings → Vendors: the Codex card and the local presets ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-vendors').click())
      await settingsLoaded(page)
      await expect(page.getByTestId('settings-vendor-codex')).toBeVisible()
      await expect(page.getByTestId('local-preset-ollama')).toBeVisible()
      await audit(page, 'Settings → Vendors (the Codex card, a local preset)')
      await act(page, () => page.getByTestId('local-preset-add').click())
      await expect(page.getByTestId('local-preset-form')).toBeVisible()
      await audit(page, 'Settings → Vendors (adding a local model)')
      await act(page, () => page.getByTestId('local-preset-cancel').click())

      // ---- a cross-vendor run in the Run view: nothing moves on its own from Implement to the end ----
      await act(page, () => page.getByTestId('nav-dashboard').click())
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
      await act(page, () => page.getByTestId('composer-run').click())
      await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
      const run = await e2e.onlyRun()
      const gate = page.getByTestId('card-gate:afterPlan')
      await expect(gate).toBeVisible({ timeout: 90_000 })
      await audit(page, 'Run view (balanced: the plan gate, Codex next)')
      await act(page, () => gate.getByTestId('card-choice-approve').click())
      const ask = page.getByTestId('ask-panel')
      await expect(ask).toBeVisible({ timeout: 90_000 })
      await audit(page, 'Run view (a Codex command ask)')
      await act(page, () => ask.getByTestId('ask-allow').click())
      await startWindow(page)
      const ended = await e2e.waitForEnd(run.runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(1_000)
      await expectSteady(
        page,
        'the Run view from the Codex ask to the end (Codex Implement, Review ∥ Critic, Codex Fix)',
      )
      await audit(page, 'Run view (cross-vendor, completed)')
      expect(fake.errors()).toEqual([])
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- Gemini: the folder trust chip, the Gemini vendor card and a run on Gemini -------------------------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the Gemini trust chip, the Gemini card and a run on Gemini keep one scroller and keep still`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(360_000)
      const page = await e2e.start({
        scenario: { review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }] },
        config: { passes: GEMINI_WALK_PASSES, gates: { afterPlan: true, beforeFix: false } },
        // Gemini's launch probe answers seconds after the Dashboard showed, as the reviewer measured it.
        gemini: { ...geminiWalk({ delayMs: 1_500 }), probeDelayMs: 4_000 },
      })
      const fake = e2e.gemini
      if (fake === null) throw new Error('no fake Gemini')
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      // When Gemini became ready (its health dot), on the page's clock: the layout shifts are timed on it too.
      await page.evaluate(() => {
        const w = window as { __geminiReadyAt?: number }
        const ready = (): boolean =>
          document.querySelector('[data-testid="vendor-health-gemini"]')?.getAttribute('data-health') ===
          'ready'
        if (ready()) return
        const mo = new MutationObserver(() => {
          if (w.__geminiReadyAt !== undefined || !ready()) return
          w.__geminiReadyAt = performance.now()
          mo.disconnect()
        })
        mo.observe(document.body, { subtree: true, childList: true, attributes: true })
      })
      await expect(page.getByTestId('vendor-health-gemini')).toHaveAttribute('data-health', 'ready', {
        timeout: 30_000,
      })

      // ---- The Dashboard as it loaded with Gemini installed. Its launch probe answers seconds after the
      //      setup card showed; that adds no row or trust chip to this visit's card and grows no composer line (the
      //      Critic swap chip's room is held), so nothing moved when it did ----
      await page.waitForTimeout(1_000)
      const loaded = await expectSteady(page, 'the Dashboard as it loaded, with Gemini installed')
      const readyAt = await page.evaluate(() => (window as { __geminiReadyAt?: number }).__geminiReadyAt)
      expect(readyAt, 'Gemini became ready after the layout guard was installed').toBeDefined()
      expect(
        loaded.shifts
          .filter((x) => x.at >= (readyAt ?? 0) - 100)
          .map((x) => `${x.value.toFixed(4)} at ${x.at} ms: ${x.sources.join('; ')}`),
        `nothing moved when Gemini became ready (at ${Math.round(readyAt ?? 0)} ms)`,
      ).toEqual([])
      // The next visit's card lists Gemini and its trust chip from the start.
      await act(page, () => revisitDashboard(page))
      const input = page.getByTestId('composer-folder-input')
      await act(page, async () => {
        await input.fill(e2e.sandbox)
        await input.press('Enter')
        await page.getByTestId('composer-task').fill('add a --version flag')
      })
      await expect(page.getByTestId('composer-passes')).toContainText('Gemini')

      // ---- the strip blocked with the trust chip; the grant; the block clears and nothing moves on its own ----
      await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
        timeout: 30_000,
      })
      await showChecks(page)
      const grant = page.getByTestId('preflight-strip').locator('[data-kind="grant"]')
      await expect(grant).toHaveCount(1)
      await expect(page.getByTestId('setup-gemini-trust-chip')).toHaveAttribute('data-phase', 'needed')
      await audit(page, 'Dashboard (passes on Gemini, the folder not trusted for it: the trust chips)')
      await startWindow(page)
      await act(page, () => grant.click())
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
      await expect(page.getByTestId('preflight-strip').locator('[data-severity="blocking"]')).toHaveCount(0)
      await expect(page.getByTestId('setup-gemini-trust-chip')).toHaveAttribute('data-phase', 'trusted')
      await page.waitForTimeout(1_000)
      await expectSteady(page, 'the Dashboard while the folder is trusted for Gemini and the block clears')
      await audit(page, 'Dashboard (the folder trusted for Gemini)')
      await setPassRows(page, true)
      await audit(page, 'Dashboard (passes on Gemini, the pass rows open)')

      // ---- Settings → Vendors: the Gemini card and its trusted folder ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-vendors').click())
      await settingsLoaded(page)
      await expect(page.getByTestId('settings-vendor-gemini')).toBeVisible()
      await expect(page.getByTestId('vendor-trusted-gemini-row')).toHaveCount(1, { timeout: 30_000 })
      await audit(page, 'Settings → Vendors (the Gemini card, a trusted folder)')

      // ---- a run on Gemini in the Run view: nothing moves on its own from the Gemini ask to the end ----
      await act(page, () => page.getByTestId('nav-dashboard').click())
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
      await act(page, () => page.getByTestId('composer-run').click())
      await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
      const run = await e2e.onlyRun()
      const gate = page.getByTestId('card-gate:afterPlan')
      await expect(gate).toBeVisible({ timeout: 90_000 })
      await audit(page, "Run view (Gemini's native plan at its gate)")
      await act(page, () => gate.getByTestId('card-choice-approve').click())
      const ask = page.getByTestId('ask-panel')
      await expect(ask).toBeVisible({ timeout: 90_000 })
      await audit(page, 'Run view (a Gemini ask)')
      await act(page, () => ask.getByTestId('ask-allow').click())
      await startWindow(page)
      const ended = await e2e.waitForEnd(run.runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(1_000)
      await expectSteady(
        page,
        "the Run view from the Gemini ask to the end (Gemini Implement, Review ∥ Gemini's Critic, Gemini Fix)",
      )
      await audit(page, 'Run view (a run on Gemini, completed)')
      expect(fake.calls('session/load')).toHaveLength(1)
      expect(fake.errors()).toEqual([])
      expect(e2e.pageErrors).toEqual([])
    },
  )
}

// ---- Grok and Muse: the More list, the Muse trust chip, their vendor cards and a run on them ----------------

for (const s of SIZES) {
  test(
    `UI layout ${s.name}: the More list with Grok and Muse, the Muse trust chip, their cards and a run on them keep one scroller and keep still`,
    { tag: ['@cross-os'] },
    async ({ e2e }) => {
      test.setTimeout(360_000)
      const page = await e2e.start({
        scenario: { plan: { recording: 'C06-plan-native-host' } },
        config: { gates: { afterPlan: false, beforeFix: false } },
        grok: { readOnly: grokReview({ delayMs: 1_500 }) },
        muse: {
          edit: museEditPass({
            write: VERSION_WRITE,
            escalation: true,
            text: 'Added the --version flag; fetching the changelog needed the network, which the sandbox refused.',
            usage: { input: 12_288, cached: 4_096, output: 512 },
            delayMs: 1_500,
          }),
        },
      })
      const grok = e2e.grok
      const muse = e2e.muse
      if (grok === null || muse === null) throw new Error('no fake Grok or Muse')
      await sizeWindow(e2e, page, s.size)
      await installGuard(page)
      await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
        timeout: 30_000,
      })
      await expect(page.getByTestId('vendor-health-muse')).toHaveAttribute('data-health', /^(ready|warning)$/)

      // ---- the Dashboard as it loaded with Grok and Muse installed: their probes moved nothing ----
      await page.waitForTimeout(1_000)
      await expectSteady(page, 'the Dashboard as it loaded, with Grok and Muse installed')
      await typeFolderAndTask(page, e2e.sandbox, 'add a --version flag')
      await setPassRows(page, true)

      // ---- the More list open, with Grok and Muse (Experimental) ----
      await auditMenu(
        page,
        page.getByTestId('pass-vendor-implement'),
        'Dashboard (the More list with Grok and Muse)',
      )
      await auditMenu(page, page.getByTestId('pass-vendor-review'), "Dashboard (Review's More list)")

      // ---- Muse on Implement, Grok on Review: the strip blocked by the Muse trust chip; the grant; nothing moves ----
      await act(page, () => pickFromMore(page, 'implement', 'Muse'))
      await act(page, () => pickFromMore(page, 'review', 'Grok'))
      await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
        timeout: 30_000,
      })
      await showChecks(page)
      const grant = page.getByTestId('preflight-strip').locator('[data-kind="grant"]')
      await expect(grant).toHaveCount(1)
      await audit(page, 'Dashboard (Grok on Review, Muse on Implement, the folder not trusted for Muse)')
      await startWindow(page)
      await act(page, () => grant.click())
      await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
      await expect(page.getByTestId('preflight-strip').locator('[data-severity="blocking"]')).toHaveCount(0)
      await page.waitForTimeout(1_000)
      await expectSteady(page, 'the Dashboard while the folder is trusted for Muse and the block clears')
      await audit(page, 'Dashboard (Grok on Review, Muse on Implement, the pass rows open)')

      // ---- a run in the Run view: Muse's Implement, Grok's read-only Review; nothing moves on its own ----
      // (The composer keeps its run overrides while the Dashboard is open: the run starts from here.)
      await act(page, () => page.getByTestId('composer-run').click())
      await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
      const run = await e2e.onlyRun()
      await expect(page.getByTestId('pass-card-implement')).toHaveAttribute('data-status', 'running', {
        timeout: 90_000,
      })
      await audit(page, 'Run view (Implement on Muse, running)')
      await startWindow(page)
      const ended = await e2e.waitForEnd(run.runId)
      expect(ended.status, e2e.describeRun(ended)).toBe('completed')
      await page.waitForTimeout(1_000)
      await expectSteady(page, "the Run view from Muse's Implement to the end (Grok's read-only Review)")
      await audit(page, 'Run view (Muse Implement, Grok Review, completed)')

      // ---- Settings → Vendors: the Grok and the Muse card (Experimental, its trusted folder) ----
      await act(page, () => page.getByTestId('nav-settings').click())
      await act(page, () => page.getByTestId('settings-section-vendors').click())
      await settingsLoaded(page)
      await expect(page.getByTestId('settings-vendor-grok')).toBeVisible()
      await expect(
        page.getByTestId('settings-vendor-muse').getByText('Experimental', { exact: true }),
      ).toBeVisible()
      await expect(page.getByTestId('vendor-trusted-muse-row')).toHaveCount(1, { timeout: 30_000 })
      await audit(page, 'Settings → Vendors (the Grok and the Muse card, a folder trusted for Muse)')

      expect(grok.permissionAnswers().map((a) => a.optionId)).toEqual(['reject_once', 'reject_once'])
      expect(muse.passes()).toHaveLength(1)
      expect(grok.errors()).toEqual([])
      expect(muse.errors()).toEqual([])
      expect(e2e.pageErrors).toEqual([])
    },
  )
}
