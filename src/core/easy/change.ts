// What a "Make a change" request is, read from its words (local, no tokens): small enough for lighter models and no
// Critic, and whether it touches code that handles keys or people's data (the full security review then runs; every
// change gets the secret scan either way, and core also reads the change's diff: see `passes.security.review`).
import type { EasyKind } from '../../shared/easy.ts'
import { NEED_WORDS } from './needs.ts'

/** A whole-word, any-case phrase (letters and digits around it do not count as a match). */
function phrase(p: string): RegExp {
  const body = p
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\s-]+/g, '[\\s-]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}
const words = (...ps: string[]): RegExp[] => ps.map(phrase)

/**
 * "It's not working": what the person sees, and the order that keeps a fix honest. They are not expected to know the
 * cause, so nothing they say about it is taken as the cause.
 */
export function notWorkingTask(seen: string): string {
  return [
    `Something is not working. The person using this says: ${seen}`,
    '',
    'Work in this order:',
    '1. Make it happen yourself first, and note exactly what you see. If you cannot make it happen, say so plainly and do not change anything to guess at it.',
    '2. Find the cause. Read any error messages. Their words describe what they see, so they may not name the real cause.',
    '3. Fix the cause with the smallest change, not the symptom. Do not hide an error to make it go away.',
    '4. Do what you did in step 1 again and confirm it now works.',
    '',
    'Finish by saying, in plain words with no technical terms, what was wrong and how you checked it.',
  ].join('\n')
}

/** The longest change that can count as small (a sentence or two). */
export const SMALL_CHANGE_MAX = 160

/**
 * Words that make a change more than a tweak: a new page or feature, a rebuild, a move to other tools, many places at
 * once. A change with any of them is never small.
 */
const BIG_WORDS: readonly RegExp[] = words(
  'add a page',
  'new page',
  'another page',
  'pages',
  'new feature',
  'feature',
  'features',
  'section',
  'sections',
  'redesign',
  'rebuild',
  'rewrite',
  'refactor',
  'convert',
  'migrate',
  'framework',
  'react',
  'typescript',
  'database',
  'backend',
  'server',
  'api',
  'everywhere',
  'every page',
  'all pages',
  'whole site',
  'whole app',
  'level',
  'levels',
  'multiplayer',
  'game mode',
  'animation',
  'animations',
  'search',
  'filter',
  'filters',
  'upload',
  'dark mode',
  'dark theme',
  'translate',
  'chart',
  'charts',
)

/**
 * Words of a small tweak: wording, colours, sizes, a picture, a link, a typo. A short change with one of them and
 * none of BIG_WORDS (and no need such as payments or sign-in) is small.
 */
const SMALL_WORDS: readonly RegExp[] = words(
  'color',
  'colour',
  'colors',
  'colours',
  'font',
  'fonts',
  'text',
  'wording',
  'word',
  'words',
  'typo',
  'spelling',
  'title',
  'heading',
  'headline',
  'button',
  'buttons',
  'bigger',
  'smaller',
  'larger',
  'size',
  'spacing',
  'margin',
  'padding',
  'bold',
  'image',
  'picture',
  'photo',
  'logo',
  'icon',
  'link',
  'email address',
  'phone number',
  'hours',
  'opening hours',
  'price',
  'prices',
  'address',
  'footer',
  'background',
  'rename',
  'move',
  'swap',
  'replace',
  'remove',
  'change the',
  'fix the',
)

/**
 * A small change: short, about wording, colours, sizes, a picture or a link, naming nothing bigger and needing
 * nothing beyond the page. It runs with lighter models and no Critic.
 */
export function isSmallChange(change: string): boolean {
  const t = change.trim()
  if (t === '' || t.length > SMALL_CHANGE_MAX) return false
  if (t.split(/[.!?\n]+/).filter((s) => s.trim() !== '').length > 2) return false
  if (BIG_WORDS.some((w) => w.test(t))) return false
  if (Object.values(NEED_WORDS).some((ws) => ws.some((w) => w.test(t)))) return false
  return SMALL_WORDS.some((w) => w.test(t))
}

/** Words that mean code handling keys, accounts, money or people's data. */
const SENSITIVE_WORDS: readonly RegExp[] = [
  ...words(
    'key',
    'keys',
    'api key',
    'token',
    'secret',
    'password',
    'passwords',
    'credentials',
    'personal',
    'private',
    'customer data',
    'customers',
    'emails',
    'email list',
    'phone numbers',
    'addresses',
    'names',
    'upload',
    'cookie',
    'cookies',
    'tracking',
    'analytics',
    'supabase',
    'firebase',
    'stripe',
    'paypal',
  ),
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/,
]

/**
 * The change needs the full security review: its words name keys, accounts, payments, forms or people's data (the
 * needs detection's words included), or a data report gets new data. Every other change gets the secret scan, and the
 * review only when core finds such code in its diff (passes.security.review: 'sensitive').
 */
export function changeTouchesSensitive(
  change: string,
  o: { kind?: EasyKind | undefined; attached?: number } = {},
): boolean {
  const t = change.trim()
  if (SENSITIVE_WORDS.some((w) => w.test(t))) return true
  if (Object.values(NEED_WORDS).some((ws) => ws.some((w) => w.test(t)))) return true
  if (o.kind === 'data' && ((o.attached ?? 0) > 0 || /\b(?:data|csv|spreadsheet|file)\b/i.test(t)))
    return true
  return false
}
