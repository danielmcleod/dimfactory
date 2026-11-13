// Keyboard focus survives a control's busy moment (accessibility). A control the
// app disables while it works (a Button's `loading`, a Settings field while its write is saved) drops the keyboard
// focus to the page when it turns disabled: Chromium moves focus off a disabled element, and a focus() call on one does
// nothing (Radix gives a Select's trigger the focus back that way when its list closes). The user's place was lost, and
// Tab started again from the top of the page. Now, when the control the keyboard was on (or was giving the focus to)
// turns disabled and the focus falls to the page, it gets the focus back once it is enabled again, without scrolling:
// only while the focus is still on the page, the control is still there, nothing else was focused or clicked
// meanwhile, and within KEEP_MS (it is the user's own place, never a jump later on). Only for the keyboard: after a
// click, the focus is left where the browser puts it (giving it back would open the control's tooltip, as a focus
// does, under the pointer of someone who never asked for it).

/** How long a disabled control keeps its claim on the focus. */
export const KEEP_MS = 30_000

export interface FocusKeeperOptions {
  doc?: Document
  now?: () => number
}

/** Install on the document; returns the removal function. */
export function installFocusKeeper(o: FocusKeeperOptions = {}): () => void {
  const doc = o.doc ?? document
  const now = o.now ?? (() => Date.now())
  const win = doc.defaultView
  if (win === null) return () => undefined
  const HTMLEl = win.HTMLElement
  /** The element that has the focus or was last asked to take it, while the keyboard is in use. */
  let intended: HTMLElement | null = null
  /** The control that lost the focus by turning disabled, and when. */
  let lost: { el: HTMLElement; at: number } | null = null
  /** The last input was a key (not a pointer): the focus is the keyboard user's place. */
  let keyboard = false

  const onPage = (): boolean => doc.activeElement === null || doc.activeElement === doc.body
  const isDisabled = (el: Element): boolean => el.hasAttribute('disabled')

  const proto = HTMLEl.prototype
  // The original focus(), read off the prototype (a plain property; restored on removal).
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const focus = proto.focus
  /** Who a focus() call was for; a disabled one does not take it, so its claim is kept until it is enabled. */
  const asked = (el: HTMLElement): void => {
    if (!keyboard) return
    intended = el
    if (isDisabled(el)) lost = { el, at: now() }
  }
  proto.focus = function (this: HTMLElement, options?: FocusOptions): void {
    asked(this)
    focus.call(this, options)
  }

  const onKeyDown = (): void => {
    keyboard = true
  }
  const onFocusIn = (e: FocusEvent): void => {
    intended = keyboard && e.target instanceof HTMLEl ? e.target : null
    lost = null
  }
  // A click anywhere is the user going somewhere else, with the pointer.
  const onPointerDown = (): void => {
    keyboard = false
    intended = null
    lost = null
  }

  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      if (r.type !== 'attributes' || !(r.target instanceof HTMLEl)) continue
      const el = r.target
      if (isDisabled(el)) {
        if (keyboard && (intended === el || el.contains(doc.activeElement))) lost = { el, at: now() }
        continue
      }
      if (lost?.el !== el) continue
      const claim = lost
      lost = null
      if (keyboard && now() - claim.at <= KEEP_MS && el.isConnected && onPage())
        focus.call(el, { preventScroll: true })
    }
  })
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['disabled'], subtree: true })
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    observer.disconnect()
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('pointerdown', onPointerDown, true)
    proto.focus = focus
  }
}
