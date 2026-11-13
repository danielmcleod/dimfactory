// "Try it for me": a walk through a finished page in a hidden window, as a first-time visitor would. It presses what a
// person would press, fills a form with made-up details, and reports what went wrong, with no model and no tokens. It
// leaves out anything that could cost money or lose something, and it can only find what a click shows up: whether the
// page does the right thing is still for the person to judge.

/** The most things one walk presses. */
export const TRY_IT_MAX_STEPS = 12

/** Words on a control the walk never presses. */
export const TRY_IT_SKIP =
  /\b(?:delete|remove|erase|destroy|clear|reset|empty|pay|buy|purchase|checkout|check out|order|subscribe|donate|log ?out|sign ?out|unsubscribe|publish|deploy|cancel my)\b/i

export interface TryItStep {
  /** What the walk pressed, as the page labels it. */
  did: string
  /** The page after it: what went wrong, if anything. */
  problems: string[]
}

export interface TryItReport {
  url: string
  loaded: boolean
  steps: TryItStep[]
  /** Controls left out because of what they say. */
  skipped: string[]
  /** Errors from opening the page, before anything was pressed. */
  openProblems: string[]
  error?: string
}

export const tryItProblems = (r: TryItReport): string[] => [
  ...(r.error !== undefined ? [r.error] : []),
  ...r.openProblems,
  ...r.steps.flatMap((s) => s.problems.map((p) => `After pressing "${s.did}": ${p}`)),
]

/** In plain words, the whole result. */
export function tryItSummary(r: TryItReport): string {
  if (!r.loaded) return r.error ?? 'The page did not open.'
  const n = r.steps.length
  if (n === 0 && tryItProblems(r).length === 0) return 'It opened with no errors, and had nothing to press.'
  const bad = tryItProblems(r).length
  const pressed = `Pressed ${n} thing${n === 1 ? '' : 's'}`
  return bad === 0
    ? `${pressed}, and nothing went wrong.`
    : `${pressed}, and found ${bad} problem${bad === 1 ? '' : 's'}.`
}

/**
 * Runs in the page: press the next thing nobody has pressed yet, and say what it was. Answers null when nothing is left.
 * What was pressed is kept for the walk across page changes. Links and forms that leave the page's own address are left
 * out (the window refuses them anyway), and so is everything with a word from TRY_IT_SKIP.
 */
export const TRY_IT_NEXT = `(() => {
  const KEY = '__dimTryIt'
  const skipWords = ${String(TRY_IT_SKIP)}
  let seen = {}
  try { seen = JSON.parse(sessionStorage.getItem(KEY) || '{}') } catch {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(seen)) } catch {} }
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.getAttribute('href') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 80)
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const sameSite = (a) => {
    try {
      const u = new URL(a.href, location.href)
      return u.origin === location.origin && !(u.pathname === location.pathname && u.search === location.search && u.hash === '')
    } catch { return false }
  }
  const sample = (el) => {
    const hint = (el.type + ' ' + el.name + ' ' + el.id + ' ' + (el.placeholder || '')).toLowerCase()
    if (el.type === 'email' || hint.includes('email')) return 'sam@example.com'
    if (el.type === 'number') return '3'
    if (el.type === 'tel' || hint.includes('phone')) return '5550100'
    if (el.type === 'url') return 'https://example.com'
    if (el.type === 'date') return '2030-01-15'
    if (hint.includes('name')) return 'Sam Example'
    return 'A short test message'
  }
  const fill = (form) => {
    for (const el of form.querySelectorAll('input, textarea, select')) {
      if (!visible(el) || el.disabled || el.readOnly || el.value) continue
      if (['submit', 'button', 'reset', 'file', 'hidden', 'image', 'password'].includes(el.type)) continue
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.required) el.checked = true; }
      else if (el.tagName === 'SELECT') { if (el.options.length > 1) el.selectedIndex = 1 }
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, sample(el))
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
  const skipped = []
  let target = null
  const all = document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], summary, a[href]')
  for (const el of all) {
    if (!visible(el) || el.disabled) continue
    const text = label(el)
    if (el.tagName === 'A' && !sameSite(el)) continue
    if (el.type === 'reset') continue
    if (skipWords.test(text)) { skipped.push(text); continue }
    const key = location.pathname + '|' + el.tagName + '|' + text
    if (seen[key] || target) continue
    target = { el, text, key }
  }
  if (!target) return { did: null, skipped }
  seen[target.key] = 1
  save()
  const form = target.el.form || target.el.closest('form')
  if (form) fill(form)
  target.el.click()
  return { did: target.text, skipped }
})()`

/** Runs in the page: what is wrong that a console would not say. */
export const TRY_IT_LOOK = `(() => ({
  blank: (document.body?.innerText ?? '').trim().length === 0 && document.querySelector('canvas, svg, img, video') === null,
}))()`
