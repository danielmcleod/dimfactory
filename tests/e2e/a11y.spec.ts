// Accessibility audit on the built app ("Accessibility: landmarks; streams
// use role=log; a polite live region for step transitions and an assertive one for asks; aria-keyshortcuts; reduced
// motion respected"; keyboard.spec.ts). Playwright's accessibility tree (ariaSnapshotJSON) and the DOM, no audit
// library. Every screen (Dashboard, each Settings section, Runs, the palette, the Run view at its gate, with an ask, at
// its end, its Diff, Log and Config tabs, the keyboard sheet) is checked for:
// - landmarks: one main, the Main navigation, and landmarks of one role told apart by their names;
// - headings: one h1, no level skipped, none hidden inside a button or a link;
// - a name on every control, ids that are unique and references (aria-labelledby, -describedby, -controls) that resolve;
// - the keyboard: Tab reaches every control (a roving group through its current member), never gets stuck, follows the
//   page (no positive tabindex), and every stop shows its focus (an outline or ring appears on it or just around it).
// Then the actions: the palette, a card, the Diff tab, a Settings field and a step's menu, keyboard only; asks and
// step transitions announced, and the announcement of an ask or card gone once it is answered; reduced motion stops
// the animations. Contrast is the renderer's tests (tests/renderer/tokens.test.ts and settings/contrast.test.ts,
// every theme × accent).
// The audit found and fixed: the run heading read "#1add…", the timeline's names "Plan : Done , 1s", a step's heading
// inside its disclosure button (left out of the page's headings) and the Flow tab's headings skipping a level, the
// tab panels showing no focus, every file's "Reviewed" box in the Diff tab named alike, two regions named "Trusted
// folders" and two named "Notifications", an unnamed sidebar beside a named complementary landmark, a banner landmark
// inside the keyboard sheet, a stale ask and "Plan ready for review." left in the live regions after they were
// answered, and a control that turns disabled while it saves (a Settings select) dropping the keyboard focus.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { FIXED_FLOW, PARKED_IMPLEMENT } from './scenarios.ts'

interface AxNode {
  role: string
  name?: string
  level?: number
  children?: (AxNode | string)[]
}

const CONTROLS = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'tab',
  'tablist',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'radiogroup',
])
const LANDMARKS = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'form',
  'region',
])

function walk(
  nodes: readonly (AxNode | string)[] | undefined,
  f: (n: AxNode, path: readonly string[]) => void,
  path: readonly string[] = [],
): void {
  for (const n of nodes ?? []) {
    if (typeof n === 'string') continue
    f(n, path)
    walk(n.children, f, [...path, `${n.role}${n.name !== undefined && n.name !== '' ? ` "${n.name}"` : ''}`])
  }
}

/** The tree and DOM checks of one screen; the problems found, each with where it is. */
async function audit(page: Page, where: string, o: { modal?: boolean } = {}): Promise<string[]> {
  const tree = (await page.ariaSnapshotJSON()) as unknown as AxNode[]
  const problems: string[] = []
  const landmarks: { role: string; name: string }[] = []
  const headings: { level: number; name: string }[] = []
  walk(tree, (n, path) => {
    const name = (n.name ?? '').trim()
    if (LANDMARKS.has(n.role)) landmarks.push({ role: n.role, name })
    if (n.role === 'heading') headings.push({ level: n.level ?? 0, name })
    if (CONTROLS.has(n.role) && name === '')
      problems.push(`unnamed ${n.role} in ${path.slice(-3).join(' > ')}`)
  })
  if (o.modal !== true) {
    const count = (role: string, name?: string): number =>
      landmarks.filter((l) => l.role === role && (name === undefined || l.name === name)).length
    if (count('main') !== 1) problems.push(`${count('main')} main landmarks`)
    if (count('navigation', 'Main') !== 1) problems.push('no Main navigation')
    // The app has no page header: a banner landmark is a <header> where it does not belong (the audit found one in the keyboard sheet).
    if (count('banner') > 0) problems.push('a banner landmark')
    const h1 = headings.filter((h) => h.level === 1)
    if (h1.length !== 1) problems.push(`${h1.length} h1 headings: ${h1.map((h) => h.name).join(', ')}`)
  }
  // Landmarks of one role are told apart by name.
  const byRole = new Map<string, string[]>()
  for (const l of landmarks) byRole.set(l.role, [...(byRole.get(l.role) ?? []), l.name])
  for (const [role, names] of byRole) {
    if (names.length < 2) continue
    if (names.some((n) => n === '')) problems.push(`an unnamed ${role} beside another ${role}`)
    const dup = names.filter((n, i) => n !== '' && names.indexOf(n) !== i)
    for (const d of new Set(dup)) problems.push(`two ${role} landmarks named "${d}"`)
  }
  // No heading level skipped (h2 → h4), from the first heading on.
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1]
    const h = headings[i]
    if (prev !== undefined && h !== undefined && h.level > prev.level + 1)
      problems.push(`heading level skipped: h${prev.level} "${prev.name}" → h${h.level} "${h.name}"`)
  }
  problems.push(
    ...(await page.evaluate(() => {
      const out: string[] = []
      const label = (el: Element): string =>
        `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') !== null ? `[${el.getAttribute('data-testid')}]` : ''}`
      for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')) {
        const inside = h.parentElement?.closest('button, a[href], [role=button], [role=link], summary')
        if (inside !== null && inside !== undefined)
          out.push(`heading "${h.textContent?.trim().slice(0, 40)}" inside ${label(inside)}`)
      }
      for (const el of document.querySelectorAll('[tabindex]')) {
        const t = Number(el.getAttribute('tabindex'))
        if (t > 0) out.push(`positive tabindex ${t} on ${label(el)}`)
      }
      const ids = new Map<string, number>()
      for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1)
      for (const [id, n] of ids) if (n > 1) out.push(`id "${id}" used ${n} times`)
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        for (const el of document.querySelectorAll(`[${attr}]`)) {
          // What a closed disclosure or an unselected tab controls is not drawn until it opens (ARIA allows that).
          const closed =
            attr === 'aria-controls' &&
            (el.getAttribute('aria-expanded') === 'false' || el.getAttribute('aria-selected') === 'false')
          if (closed) continue
          for (const ref of (el.getAttribute(attr) ?? '').split(/\s+/).filter((s) => s !== '')) {
            if (document.getElementById(ref) === null)
              out.push(`${attr}="${ref}" on ${label(el)} names nothing`)
          }
        }
      }
      for (const img of document.querySelectorAll('img')) {
        if (!img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true')
          out.push(`img without alt: ${label(img)}`)
      }
      return out
    })),
  )
  return problems.map((p) => `${where}: ${p}`)
}

/**
 * Tab from the top of the page until focus comes back round: every control the page can be used with is a stop (a
 * roving group through its current member), no stop is stuck, and each stop shows its focus: an outline or ring on
 * it or on one of its three nearest ancestors that was not there before it had the focus.
 */
async function tabAudit(page: Page, where: string, o: { max?: number } = {}): Promise<string[]> {
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const w = window as unknown as {
      __m17: { visited: Set<Element>; base: Map<Element, string>; order: Element[] }
    }
    // An outline counts only when it is drawn: a width or colour under outline-style none is no ring.
    const look = (el: Element): string => {
      const s = getComputedStyle(el)
      return `${s.outlineStyle === 'none' || s.outlineWidth === '0px' ? 'none' : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`} | ${s.boxShadow}`
    }
    const base = new Map<Element, string>()
    for (const el of document.querySelectorAll('*')) base.set(el, look(el))
    w.__m17 = { visited: new Set(), base, order: [] }
  })
  const problems: string[] = []
  const max = o.max ?? 400
  let first: string | null = null
  let back = false
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const w = window as unknown as {
        __m17: { visited: Set<Element>; base: Map<Element, string>; order: Element[] }
      }
      const el = document.activeElement
      if (el === null || el === document.body) return null
      const again = w.__m17.visited.has(el)
      w.__m17.visited.add(el)
      w.__m17.order.push(el)
      const look = (x: Element): string => {
        const s = getComputedStyle(x)
        return `${s.outlineStyle === 'none' || s.outlineWidth === '0px' ? 'none' : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`} | ${s.boxShadow}`
      }
      // The ring is the element's own, or that of a wrapper holding nothing else that takes the focus (the label of a
      // visually hidden radio, the palette's search row): a container of other controls changing is not this
      // control's focus showing.
      const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      const onlyThis = (x: Element): boolean =>
        [...x.querySelectorAll(TABBABLE)].every((t) => t === el || el.contains(t))
      let shown = false
      let x: Element | null = el
      for (let up = 0; up < 4 && x !== null && x !== document.body; up++, x = x.parentElement) {
        if (x !== el && !onlyThis(x)) break
        if (w.__m17.base.get(x) !== look(x)) shown = true
      }
      const id = el.getAttribute('data-testid') ?? ''
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40)
      return {
        key: `${el.tagName.toLowerCase()}${id !== '' ? `[${id}]` : ''} "${name}"`,
        again,
        shown,
        focusVisible: el.matches(':focus-visible'),
      }
    })
    if (stop === null) continue
    if (first === null) first = stop.key
    if (stop.again) {
      back = true
      break
    }
    if (!stop.shown) problems.push(`no visible focus on ${stop.key}`)
    if (!stop.focusVisible) problems.push(`not :focus-visible after Tab: ${stop.key}`)
  }
  if (!back) problems.push(`Tab never came back round in ${max} presses (a trap?)`)
  // Every control the page can be used with was a stop, or its roving group's current member was.
  problems.push(
    ...(await page.evaluate(() => {
      const w = window as unknown as { __m17: { visited: Set<Element> } }
      const w2 = window as unknown as { __m17: { base: Map<Element, string> } }
      const visited = w.__m17.visited
      const SEL =
        'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable="true"], [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=combobox], [role=slider], [role=spinbutton]'
      const ROVING = new Set([
        'radio',
        'tab',
        'menuitem',
        'menuitemradio',
        'menuitemcheckbox',
        'option',
        'treeitem',
      ])
      const GROUP =
        '[role=radiogroup], [role=tablist], [role=menu], [role=menubar], [role=listbox], [role=toolbar], [role=grid], [role=tree]'
      // Not drawn: hidden from assistive technology, inert, not rendered, or in a closed <details> (checkVisibility
      // sees content-visibility too).
      const hidden = (el: Element): boolean =>
        el.closest('[aria-hidden="true"], [inert]') !== null ||
        el.getClientRects().length === 0 ||
        !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: false }) ||
        (el.closest('details:not([open])') !== null && el.closest('summary') === null)
      const out: string[] = []
      const label = (el: Element): string =>
        `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') !== null ? `[${el.getAttribute('data-testid')}]` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
      for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
        if (visited.has(el) || hidden(el)) continue
        // Drawn only after the walk began (the Dashboard's compact Run bar, shown once its composer scrolled past):
        // the page's own controls behind it were walked.
        if (!w2.__m17.base.has(el)) continue
        if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue
        // A container that hands its focus on (a Radix tab list or toolbar): reached when what it holds was.
        if ([...visited].some((v) => v !== el && el.contains(v))) continue
        // A native radio group is one Tab stop (its checked radio); the arrows move within it.
        if (el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '') {
          const name = el.name
          const reachedGroup = [...visited].some(
            (v) => v instanceof HTMLInputElement && v.type === 'radio' && v.name === name,
          )
          if (!reachedGroup) out.push(`radio group "${name}" never reached by Tab`)
          continue
        }
        const role = el.getAttribute('role') ?? ''
        if (el.tabIndex < 0) {
          // Not a Tab stop by design, unless it is a member of a roving group none of whose members was reached.
          if (!ROVING.has(role)) continue
          const group = el.closest(GROUP)
          if (group === null) continue
          const reached = [...visited].some(
            (v) => group.contains(v) || (v.getAttribute('aria-controls') ?? '').split(' ').includes(group.id),
          )
          if (!reached) out.push(`roving group of ${label(el)} never reached`)
          continue
        }
        // A Tab stop inside an element that was reached and keeps the focus for its own items (none here).
        out.push(`never reached by Tab: ${label(el)}`)
      }
      return [...new Set(out)]
    })),
  )
  return problems.map((p) => `${where} (Tab): ${p}`)
}

const SETTINGS = [
  'general',
  'vendors',
  'profiles',
  'prompts',
  'self-heal',
  'catalog',
  'isolation',
  'appearance',
  'notifications',
  'diagnostics',
  'config',
] as const

async function go(page: Page, hash: string, ready: string): Promise<void> {
  await page.evaluate((h) => (location.hash = h), hash)
  await expect(page.getByTestId(ready)).toBeVisible()
  // Async content (vendor checks, section data) settles; the checks read what a user would meet.
  await page.waitForTimeout(800)
}

/** A run of FIXED_FLOW waiting at its plan gate. */
async function runToGate(e2e: E2EHarness): Promise<string> {
  const run = await e2e.runFromDashboard('add a --version flag')
  await expect(e2e.p.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  return run.runId
}

test('a11y: landmarks, headings, names, ids and the keyboard on every screen', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start({ scenario: FIXED_FLOW })
  const problems: string[] = []
  const both = async (where: string): Promise<void> => {
    problems.push(...(await audit(page, where)), ...(await tabAudit(page, where)))
  }

  await expect(page.getByTestId('composer')).toBeVisible()
  await page.waitForTimeout(1_500)
  await both('Dashboard')
  for (const s of SETTINGS) {
    await go(page, `#/settings/${s}`, `settings-section-${s}`)
    await both(`Settings ${s}`)
  }
  await go(page, '#/runs', 'nav-runs')
  await both('Runs (none yet)')

  await go(page, '#/', 'composer')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('palette')).toBeVisible()
  problems.push(...(await audit(page, 'Palette', { modal: true })))
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toBeHidden()

  const runId = await runToGate(e2e)
  await page.waitForTimeout(800)
  await both('Run view, plan gate')
  await page.getByTestId('card-gate:afterPlan').getByTestId('card-choice-approve').click()
  await expect(page.getByTestId('ask-panel')).toBeVisible({ timeout: 60_000 })
  problems.push(...(await audit(page, 'Run view, an ask')))
  await page.getByTestId('ask-panel').getByTestId('ask-allow').click()
  const ended = await e2e.waitForEnd(runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await page.waitForTimeout(1_000)
  await both('Run view, ended')
  for (const tab of ['diff', 'log', 'config'] as const) {
    await go(page, `#/runs/${runId}/${tab}`, `run-tab-${tab}`)
    if (tab === 'diff') await expect(page.getByTestId('diff-file').first()).toBeVisible()
    await both(`Run view, ${tab} tab`)
  }
  await go(page, '#/runs', 'nav-runs')
  await expect(page.getByTestId(`runs-pin-${runId}`)).toBeVisible()
  await both('Runs (one run)')
  await go(page, '#/', 'composer')
  await both('Dashboard after a run')
  await page.keyboard.press('Shift+Slash')
  await expect(page.getByTestId('keyboard-sheet')).toBeVisible()
  problems.push(...(await audit(page, 'Keyboard sheet')))

  expect(problems).toEqual([])
})

test('a11y: the palette, a card, the Diff tab, a Settings field and a step menu work from the keyboard alone', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: FIXED_FLOW })
  const focusedTestId = (): Promise<string | null> =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null)
  const tabTo = async (testId: string, max = 120): Promise<void> => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab')
      if ((await focusedTestId()) === testId) return
    }
    throw new Error(`Tab never reached ${testId}`)
  }

  // ---- the palette: open, find, choose; Escape gives the focus back ----
  await expect(page.getByTestId('composer')).toBeVisible()
  await tabTo('nav-settings')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.keyboard.type('Open Runs')
  await expect(page.getByTestId('palette-item-action:runs')).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/runs$/)
  await expect(page.getByTestId('palette')).toBeHidden()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-testid^="palette-item-"][data-selected="true"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toBeHidden()

  // ---- a Settings field: Tab to a select, open it, choose with the arrows; the focus stays on it while it saves ----
  // (Found in the audit: the select is disabled while its write is saved, which dropped the focus to the page; lib/focusKeeper.ts.)
  await page.evaluate(() => (location.hash = '#/settings/general'))
  const close = page.getByTestId('general-close')
  await expect(close).toHaveAttribute('role', 'combobox')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await tabTo('general-close')
  const before = await close.textContent()
  const activeOption = (): Promise<string | null> =>
    page.evaluate(() =>
      document.activeElement?.getAttribute('role') === 'option'
        ? (document.activeElement.textContent ?? '')
        : null,
    )
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect.poll(activeOption).toBe(before)
  await page.keyboard.press('ArrowDown')
  await expect.poll(activeOption).not.toBe(before)
  const chosen = await activeOption()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(close).toHaveText(chosen ?? '')
  await expect(close).toBeEnabled()
  await expect(close).toBeFocused()

  // ---- a card: the plan gate's choices are Tab stops; Enter on Approve approves ----
  await page.evaluate(() => (location.hash = '#/'))
  const runId = await runToGate(e2e)
  const gate = page.getByTestId('card-gate:afterPlan')
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('[data-testid="card-gate:afterPlan"]') !== null),
    )
    .toBe(true)
  await tabTo('card-choice-approve')
  await page.keyboard.press('Enter')
  await expect(gate).toBeHidden()

  // ---- the ask: focused, answered with A ----
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toBeVisible({ timeout: 60_000 })
  await expect(ask).toBeFocused()
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()
  const ended = await e2e.waitForEnd(runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // ---- a step's menu: Enter opens it on its first item, the arrows move, Escape closes it back to its button ----
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await tabTo('pass-menu-plan')
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByTestId('pass-menu-plan')).toBeFocused()

  // ---- the Diff tab: ⌘/Ctrl+⇧D opens it; J moves file to file, R marks the file reviewed ----
  await page.keyboard.press('ControlOrMeta+Shift+D')
  await expect(page).toHaveURL(new RegExp(`#/runs/${runId}/diff$`))
  const files = page.getByTestId('diff-file')
  await expect(files).toHaveCount(2)
  // Each file's Reviewed box names its file (every one used to be just "Reviewed").
  for (const path of await files.evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''))) {
    await expect(page.getByRole('checkbox', { name: `Reviewed ${path}`, exact: true })).toHaveCount(1)
  }
  await tabTo('diff-mark-all')
  await page.keyboard.press('j')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('diff-file')
  const first = await page.evaluate(() => document.activeElement?.getAttribute('data-path'))
  await page.keyboard.press('r')
  await expect(page.locator(`[data-testid="diff-file"][data-path="${first ?? ''}"]`)).toHaveAttribute(
    'data-reviewed',
    '',
  )
  await page.keyboard.press('j')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-path')))
    .not.toBe(first)
  expect(e2e.pageErrors).toEqual([])
})

test('a11y: asks and step transitions are announced, and an answered ask or card is no longer said', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: FIXED_FLOW })
  const runId = await runToGate(e2e)
  const steps = page.getByTestId('step-announcer')
  const asks = page.getByTestId('ask-announcer')
  const cards = page.getByTestId('card-announcer')
  await expect(steps).toHaveAttribute('aria-live', 'polite')
  await expect(asks).toHaveAttribute('aria-live', 'assertive')
  await expect(cards).toHaveAttribute('aria-live', 'assertive')
  await expect(cards).toHaveText('Plan ready for review.')

  // Approved: the card's announcement goes with it; the next step is announced politely.
  await page.getByTestId('card-gate:afterPlan').getByTestId('card-choice-approve').click()
  await expect(cards).toHaveText('')
  await expect(steps).toHaveText(/Implement: (Running|Waiting)/)

  // The ask: said assertively while it waits, and no longer once it is answered.
  await expect(page.getByTestId('ask-panel')).toBeVisible({ timeout: 60_000 })
  await expect(asks).toHaveText(/^Implement: Claude wants to run a command\. .+ minutes? left\.$/)
  await page.keyboard.press('a')
  await expect(page.getByTestId('ask-panel')).toBeHidden()
  await expect(asks).toHaveText('')
  await expect(asks.locator('[data-request-id]')).toHaveCount(0)

  const ended = await e2e.waitForEnd(runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(steps).toHaveText(/^Fix: Done/)
  // The streams are logs (role=log), not live regions that would read every token aloud.
  const logs = page.getByRole('log')
  expect(await logs.count()).toBeGreaterThan(0)
  for (const l of await logs.all()) expect(await l.getAttribute('aria-live')).not.toBe('assertive')
  // Toasts are said politely (the Notifications region's toasts are status messages).
  expect(await page.getByRole('region', { name: /Notifications/ }).count()).toBe(1)
})

test('a11y: with reduced motion the app runs no animation; without it, a running step does', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // Implement parks after reading its prompt: the step runs (and its icon spins) for as long as the test needs.
  const page = await e2e.start({ scenario: PARKED_IMPLEMENT, config: { gates: { afterPlan: false } } })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.waitForLiveProc(run.runId, 'implement')
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'running')
  const longAnimations = (): Promise<number> =>
    page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          const t = a.effect?.getComputedTiming()
          const d = typeof t?.duration === 'number' ? t.duration : 0
          return a.playState === 'running' && (d > 1 || t?.iterations === Infinity)
        }).length,
    )
  // The control: a running step spins its icon and pulses its dot.
  await expect.poll(longAnimations).toBeGreaterThan(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(longAnimations).toBe(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(longAnimations).toBeGreaterThan(0)
  await page.getByTestId('stop-run').click()
  await e2e.waitForEnd(run.runId)
})
