// Helpers shared by the git E2E specs (reconciliation, branch prep,
// revert to S0, the plan-end guard; reconcile-restore.spec.ts): git in the sandbox (a fresh repo, a fixed identity), byte
// fingerprints, a merge left in conflict, a fake Implement that writes then parks, and the UI
// standards audit for the new cards (the same three rules ui-standards.spec.ts checks on every screen it walks: no em dash,
// nothing scrolls sideways, one scroll region) plus the control-width tracker.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'
import { SCROLL_REGIONS } from './scroll-regions.ts'

// ---- scenarios ------------------------------------------------------------------------------------------------------

/** Plan → Implement (writes src/version.ts) → Review finds 2 must + 1 should → Fix resumes Implement's session. */
export const WITH_FINDINGS: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE }],
}

/**
 * Rewrite `<name>.script.jsonl` so the pass writes `files` right after it reads its prompt, then parks in a long sleep
 * (the scenario's `delayMs`): what a vendor wrote before the user stopped it.
 */
export function writeThenPark(
  sc: Scenario,
  name: string,
  files: readonly { path: string; content: string }[],
): void {
  const file = join(sc.dir, `${name}.script.jsonl`)
  const ops = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { op: string; match?: { type?: string } })
  const user = ops.findIndex((o) => o.op === 'expectStdin' && o.match?.type === 'user')
  if (user === -1 || ops[user + 1]?.op !== 'sleep')
    throw new Error(`${name}: no user message followed by a sleep`)
  const writes = files.map((f) => ({ op: 'writeFile', path: f.path, content: f.content }))
  ops.splice(user + 1, 0, ...writes)
  writeFileSync(file, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
}

// ---- git and bytes --------------------------------------------------------------------------------------------------

/** git in the sandbox (a fresh repo with no hooks) with a fixed identity; `ok: false` instead of a throw. */
export function gitTry(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  )
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export function gitOut(cwd: string, ...args: string[]): string {
  const r = gitTry(cwd, ...args)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.err}`)
  return r.out.trim()
}

export const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Each file's sha256 (or 'absent'), keyed by its path relative to `dir`. */
export function fingerprint(dir: string, rels: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    rels.map((r) => [r, existsSync(join(dir, r)) ? sha256(join(dir, r)) : 'absent'] as const),
  )
}

/** Every ref and what it points at, plus HEAD's symbolic target (a fingerprint of the user's refs). */
export function refsOf(dir: string): string {
  const head = gitTry(dir, 'symbolic-ref', '-q', 'HEAD').out.trim()
  return `HEAD -> ${head}\n${gitOut(dir, 'for-each-ref', '--format=%(refname) %(objectname)')}`
}

/**
 * Leave the sandbox in a conflicted merge: a branch `other` and the current branch change src/index.ts differently,
 * then `git merge other` stops with the conflict (MERGE_HEAD and an unmerged path). Returns the current branch's name.
 */
export function mergeInConflict(dir: string): string {
  const main = gitOut(dir, 'symbolic-ref', '--short', 'HEAD')
  gitOut(dir, 'checkout', '-q', '-b', 'other')
  writeFileSync(join(dir, 'src/index.ts'), 'export const side = "other"\n')
  gitOut(dir, 'commit', '-q', '-am', 'other')
  gitOut(dir, 'checkout', '-q', main)
  writeFileSync(join(dir, 'src/index.ts'), 'export const side = "main"\n')
  gitOut(dir, 'commit', '-q', '-am', 'main')
  const merge = gitTry(dir, 'merge', 'other')
  if (merge.ok) throw new Error('the merge did not stop on a conflict')
  if (!existsSync(join(dir, '.git', 'MERGE_HEAD'))) throw new Error('no merge in progress')
  return main
}

// ---- the UI standards audit -----------------------------------------------------------------------------------

/** U+2014, written as a code point so this file has no em dash of its own. */
const EM_DASH = String.fromCharCode(0x2014)
/** "The bounding-box width is identical (±0.5 px) across states." */
const TOLERANCE_PX = 0.5
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

/**
 * The page as it is now (ui-standards.spec.ts' rules): no em dash in any text a user sees or hears (generated content
 * included), nothing scrolls sideways, and only <main> and the marked inner regions (named on the whitelist,
 * scroll-regions.ts) scroll. `where` names the screen.
 */
export async function auditScreen(page: Page, where: string): Promise<void> {
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
          if (ox !== 'auto' && ox !== 'scroll') continue
          // A pane inside a closed <details> (a done pass's "Vendor output") is laid out only when asked: after a
          // resize, Chromium's first scrollWidth for it can still be the wider window's. The first read brings its
          // layout up to date; the second is the measure (both panes, shown or folded, are still checked).
          void el.scrollWidth
          const sw = el.scrollWidth
          const cw = el.clientWidth
          if (sw > cw + 1) scroll.push(`${name(el)}: scrollWidth ${sw} > clientWidth ${cw}`)
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

type Size = readonly [width: number, height: number]

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

/** The audit at the window's size and at the smallest the app allows (900 × 600), then back. */
export async function auditBothSizes(e2e: E2EHarness, page: Page, where: string): Promise<void> {
  await auditScreen(page, where)
  if (e2e.app === null) throw new Error('the app is not running')
  const { size, min } = await e2e.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const [w = 0, h = 0] = win.getSize()
    const [mw = 0, mh = 0] = win.getMinimumSize()
    return { size: [w, h] as const, min: [mw, mh] as const }
  })
  expect(min).toEqual([900, 600])
  await resizeWindow(e2e, page, min)
  try {
    await auditScreen(page, `${where} at the smallest window`)
  } finally {
    await resizeWindow(e2e, page, size)
  }
}

// ---- control widths -------------------------------------------------------------------------------------------------

interface Sample {
  w: number
  label: string
  busy: boolean
  disabled: boolean
  testId: string
}

type TrackWindow = Window & { __m7Tracks?: Record<string, () => Sample[]> }

/**
 * Sample a control's width on every DOM change (and now) while the test drives it: the first element matching
 * `selector` (looked up again each time, so a remount or a testid that changes with the state is followed).
 */
export async function trackWidth(page: Page, name: string, selector: string): Promise<void> {
  await page.evaluate(
    ([n, sel]) => {
      const samples: Sample[] = []
      const take = (): void => {
        const el = document.querySelector<HTMLElement>(sel)
        if (el === null) return
        const r = el.getBoundingClientRect()
        if (r.width === 0) return
        const s: Sample = {
          w: r.width,
          label: el.innerText.replace(/\s+/g, ' ').trim(),
          busy: el.getAttribute('aria-busy') === 'true' || el.querySelector('.animate-spin') !== null,
          disabled: el.matches(':disabled'),
          testId: el.getAttribute('data-testid') ?? '',
        }
        const last = samples.at(-1)
        if (last === undefined || JSON.stringify(last) !== JSON.stringify(s)) samples.push(s)
      }
      take()
      const mo = new MutationObserver(take)
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      const w = window as TrackWindow
      w.__m7Tracks ??= {}
      w.__m7Tracks[n] = () => {
        take()
        mo.disconnect()
        return samples
      }
    },
    [name, selector] as const,
  )
}

/** Stop sampling; every sample has the first one's width (±0.5 px). Resolves with the samples. */
export async function expectSteadyWidth(page: Page, name: string, what: string): Promise<Sample[]> {
  const samples = await page.evaluate((n) => {
    const stop = (window as TrackWindow).__m7Tracks?.[n]
    if (stop === undefined) throw new Error(`no tracker called ${n}`)
    return stop()
  }, name)
  const first = samples[0]
  if (first === undefined) throw new Error(`${what}: the control was never measured`)
  const describe = samples
    .map(
      (s) =>
        `  [${s.testId}] "${s.label}"${s.busy ? ' busy' : ''}${s.disabled ? ' disabled' : ''}: ${s.w.toFixed(2)} px`,
    )
    .join('\n')
  const off = samples.filter((s) => Math.abs(s.w - first.w) > TOLERANCE_PX)
  expect(off, `${what} changed size across its states:\n${describe}`).toEqual([])
  return samples
}

/** <main>'s scroll offset (the page's one scroller). */
export async function mainScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('main')?.scrollTop ?? -1)
}
