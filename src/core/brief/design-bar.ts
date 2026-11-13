// The default look-and-feel bar: when a run makes something people look at (a website, an app, a landing page) and
// neither the request nor the Brief says how it should look, the Brief's text (and so the Clarify, Plan and Implement
// prompts that carry it) gets a short "Look and feel" section: a coherent theme from design tokens, light and dark,
// responsive and accessible, real navigation and layout, loading, empty and error states, real words, and the publish
// basics. A project that already has its own look keeps it. Pure.
import type { BriefInput } from '../../shared/brief.ts'
import { requestPartOf } from '../../shared/templates.ts'

/** Software Brief choices that make the result something people look at in a browser or on a screen. */
const UI_PROJECT_TYPES = new Set([
  'spa',
  'multi-page',
  'static-site',
  'full-stack',
  'mobile',
  'browser-extension',
])
const UI_FRAMEWORKS = new Set(['react', 'vue', 'svelte', 'solid', 'angular', 'plain-html'])
const UI_DELIVERABLES = new Set(['static-html', 'spa-bundle', 'pwa'])

/** Words that say how it should look: the request already sets a look, so the default bar is left out. */
const DESIGN_WORDS: readonly RegExp[] = [
  /\bcolou?rs?\b/i,
  /\bcolou?r\s+scheme\b/i,
  /\bpalette\b/i,
  /\bfonts?\b/i,
  /\btypefaces?\b/i,
  /\btypography\b/i,
  /\bthemes?\b/i,
  /\bstyle\s+guide\b/i,
  /\bbrand(?:ing)?\s+(?:colou?rs?|guide|guidelines)\b/i,
  /\blook\s+and\s+feel\b/i,
  /\bminimal(?:ist)?\b/i,
  /\bretro\b/i,
  /\bpastel\b/i,
  /\bneon\b/i,
  /\bbrutalis[mt]\b/i,
  /\bglassmorphism\b/i,
  /\bmaterial\s+design\b/i,
  /\btailwind\b/i,
  /\bbootstrap\b/i,
]

/** The brief makes something people look at (a design project, or a software project with a user interface). */
export function isUiBrief(brief: Pick<BriefInput, 'category' | 'fields'>): boolean {
  if (brief.category === 'design') return true
  if (brief.category !== 'software') return false
  const has = (group: string, set: ReadonlySet<string>): boolean =>
    brief.fields[group]?.choices.some((c) => set.has(c)) === true
  if (brief.fields['uiFramework']?.choices.includes('none') === true) return false
  return (
    has('projectType', UI_PROJECT_TYPES) ||
    has('uiFramework', UI_FRAMEWORKS) ||
    has('deliverable', UI_DELIVERABLES)
  )
}

/** The request already says how it should look (an Easy task: the user's own words, not the template's outline). */
export function taskSetsLook(task: string): boolean {
  const own = requestPartOf(task)
  return DESIGN_WORDS.some((w) => w.test(own))
}

/** The default bar's lines. */
export const DESIGN_BAR_LINES: readonly string[] = [
  'If the project already has its own look, keep it. Otherwise:',
  "A coherent theme from design tokens (CSS custom properties): a palette with one accent colour, a type scale, a spacing scale and corner radius, used everywhere instead of one-off values. If the user's answers name a feel (clean and simple, bold and colourful, warm and friendly), the theme follows it.",
  'Light and dark: follow the system setting, with a toggle where it suits; every text colour meets WCAG AA contrast (4.5:1) in both.',
  'Responsive from a 360 px phone to a wide desktop; accessible: semantic landmarks, real navigation that works by keyboard, visible focus, labels and alt text.',
  'Anything that loads or can fail has loading, empty and error states written for people.',
  "Real, specific words instead of lorem ipsum. Never invent the owner's facts (prices, hours, addresses, testimonials): mark each [Fill in: ...].",
  'Pictures: marked image slots (what goes there, its file in assets/ and its size) instead of stock photos. No trackers, and no fonts, scripts or pictures from other websites.',
  'Publish basics: a page title and description, a social preview picture, a favicon and a not-found page.',
]

/** The "Look and feel" section for a run's Brief text (empty: not a UI project, or the request sets a look). */
export function designBarSection(brief: Pick<BriefInput, 'category' | 'fields'>, task: string): string {
  if (!isUiBrief(brief) || taskSetsLook(task)) return ''
  return [
    'Look and feel (a default: the request does not say how it should look):',
    ...DESIGN_BAR_LINES.map((l) => `- ${l}`),
  ].join('\n')
}
