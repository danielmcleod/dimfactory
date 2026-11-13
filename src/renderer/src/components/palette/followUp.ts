// What a palette choice or a deep link does once its page is on screen (UI standard: nothing scrolls on its own).
// The target is looked for as the page
// renders (a run's snapshot, a section's values may arrive a moment later, and a control may wait disabled until
// they do). Once it is there it is brought under the page's sticky header, only if it is not in view and only once,
// then focused without a second scroll. A follow-up is the direct result of the user's choice, so it gives up as soon
// as the user does something else (a key, a press, the wheel), when another follow-up starts, or after FOLLOW_UP_MS;
// a target that shows up after REVEAL_MS is focused where it is and the page is left alone.
import { findSettingsField, fieldIdCandidates, SETTING_FIELD_ATTR } from '../../pages/settings/index.ts'
import type { SettingsField } from '../../pages/settings/index.ts'
import { scrollIntoMain } from '../shell/mainScroll.ts'

/** A follow-up waits this long for its target at most. */
export const FOLLOW_UP_MS = 3000
/** Past this, a target is focused without moving the page (the move would no longer read as the user's). */
export const REVEAL_MS = 900
/** Room left between the sticky header and a target brought under it. */
const GAP = 8

export interface FollowUpTarget {
  /** What takes the focus. */
  focus: HTMLElement
  /** What must be in view (a whole row, a card): the focus target when absent. */
  reveal?: HTMLElement
}

let cancelCurrent: (() => void) | null = null

/** Drop the follow-up in progress, if any. */
export function cancelFollowUp(): void {
  cancelCurrent?.()
}

/** The page scroller (components/shell/Shell.tsx), when the shell is mounted. */
function pageScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main[data-testid="main"]') ?? document.querySelector('main')
}

/** Bring `el` under main's sticky header when any of it is out of the reading area; leave the page alone otherwise. */
export function revealOnce(el: HTMLElement): void {
  const main = pageScroller()
  if (main === null || !main.contains(el)) return
  const cs = getComputedStyle(main)
  const padTop = Number.parseFloat(cs.scrollPaddingTop) || 0
  const padBottom = Number.parseFloat(cs.scrollPaddingBottom) || 0
  const view = main.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.top >= view.top + padTop && r.bottom <= view.bottom - padBottom) return
  scrollIntoMain(main, el, { top: padTop + GAP })
}

/**
 * Look for a target now and as the page changes; when it is found, reveal it (within REVEAL_MS) and focus it. `find`
 * returns null while the target is not ready (not rendered yet, or still disabled).
 */
export function followUp(find: () => FollowUpTarget | null): void {
  cancelCurrent?.()
  const started = Date.now()
  let observer: MutationObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const inputs = ['pointerdown', 'keydown', 'wheel'] as const
  const stop = (): void => {
    observer?.disconnect()
    observer = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const type of inputs) window.removeEventListener(type, stop, true)
    if (cancelCurrent === stop) cancelCurrent = null
  }
  const attempt = (): boolean => {
    const t = find()
    if (t === null) return false
    stop()
    if (Date.now() - started <= REVEAL_MS) revealOnce(t.reveal ?? t.focus)
    t.focus.focus({ preventScroll: true })
    return true
  }
  if (attempt()) return
  cancelCurrent = stop
  for (const type of inputs) window.addEventListener(type, stop, true)
  timer = setTimeout(stop, FOLLOW_UP_MS)
  if (typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => {
    attempt()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'tabindex', SETTING_FIELD_ATTR, 'data-request-id'],
  })
}

// ---- Settings rows ---------------------------------------------------------------------------------------------------

/** Controls a row can hold, in the order a deep link prefers them: the chosen radio, then any enabled control. */
const CONTROLS = [
  'input[type="radio"]:checked:not([disabled])',
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  'a[href]',
] as const

/** A control waiting for its value (disabled while the section reads it). */
const WAITING = 'input[disabled], select[disabled], textarea[disabled], button[disabled]'

/** The first enabled control in `el` (itself included); null when there is none yet. */
export function controlIn(el: Element): HTMLElement | null {
  for (const sel of CONTROLS) {
    if (el.matches(sel) && el instanceof HTMLElement) return el
    const found = el.querySelector<HTMLElement>(sel)
    if (found !== null) return found
  }
  return null
}

/** Elements under `scope` whose accessible name is `name` (aria-label), in document order. */
function byAriaLabel(scope: Element, name: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[aria-label]')].filter(
    (e) => e.getAttribute('aria-label') === name,
  )
}

/** The element showing exactly `text` with no element inside it (a row's label, a legend), in document order. */
function byText(scope: Element, text: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('legend, label, span, p, h3, h4, div, th')].filter(
    (e) => e.childElementCount === 0 && (e.textContent ?? '').trim() === text,
  )
}

/** Where a row found by its label holds its control: the nearest of a few ancestors that has one. */
function rowOf(label: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = label
  for (let i = 0; i < 4 && el !== null; i++) {
    el = el.parentElement
    if (el === null) return null
    if (controlIn(el) !== null || el.querySelector(WAITING) !== null) return el
  }
  return null
}

/** A row found by name: ready, waiting (a control is there but disabled), or absent. */
function targetFrom(row: HTMLElement): FollowUpTarget | 'waiting' {
  const control = controlIn(row)
  return control === null ? 'waiting' : { focus: control, reveal: row }
}

/**
 * Where a Settings deep link lands: the row marked with the field id (or the nearest pointer above it), else the
 * index entry's control by its accessible name, else its row by its label. Null while it is not ready.
 */
export function locateSettingsField(field: string, entry: SettingsField | undefined): FollowUpTarget | null {
  const scope = document.querySelector('[data-testid="settings-content"]')
  if (scope === null) return null
  for (const id of fieldIdCandidates(field)) {
    const row = [...scope.querySelectorAll<HTMLElement>(`[${SETTING_FIELD_ATTR}]`)].find(
      (e) => e.getAttribute(SETTING_FIELD_ATTR) === id,
    )
    if (row !== undefined) {
      const t = targetFrom(row)
      return t === 'waiting' ? null : t
    }
  }
  if (entry === undefined) return null
  for (const name of [entry.control, entry.label]) {
    if (name === undefined) continue
    const control = byAriaLabel(scope, name)[0]
    if (control === undefined) continue
    // A later-version control is named inside its focusable hint (kit.tsx LaterHint).
    const hint = control.closest<HTMLElement>('[data-disabled-hint]')
    if (hint !== null) return { focus: hint }
    const ready = controlIn(control)
    return ready !== null ? { focus: ready } : null
  }
  for (const label of byText(scope, entry.label)) {
    const row = rowOf(label)
    if (row === null) continue
    const t = targetFrom(row)
    return t === 'waiting' ? null : t
  }
  return null
}

/** Focus the row a Settings deep link names, once its section shows it. */
export function focusSettingsField(section: string, field: string, sub?: string): void {
  const entry = findSettingsField(section, field, sub)
  followUp(() => locateSettingsField(field, entry))
}

// ---- Run view targets ------------------------------------------------------------------------------------------------

/** Focus (and bring under the Run view's header) the first element matching one of `selectors` once it shows. */
export function focusInRun(runId: string, selectors: readonly string[]): void {
  followUp(() => {
    const view = document.querySelector(`[data-testid="run-view"][data-run-id="${CSS.escape(runId)}"]`)
    if (view === null) return null
    for (const sel of selectors) {
      const el = view.querySelector<HTMLElement>(sel)
      if (el !== null) return { focus: el }
    }
    return null
  })
}
