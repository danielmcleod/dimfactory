// What a website or app idea needs beyond pages in a browser, found in its words (local, no tokens): an AI or paid API
// (a key that must stay secret), taking payments, sign-in, a form that saves or sends, data stored online, a blog to
// post to. The confirm screen asks one plain question about the first need and says what each way of meeting it adds,
// costs and which free hosts cover it (the renderer's Easy text); the run's task gets one plain instruction per need,
// as the user chose it (the recommended way when they did not choose). Secrets never go in the page: an AI or paid
// API is called through a small server function by default.
import type { EasyKind, EasyNeed, EasyNeedAnswers, EasyNeedView } from '../../shared/easy.ts'
import { EASY_NEEDS, EASY_NEED_CHOICES, EASY_WEB_KINDS } from '../../shared/easy.ts'

/** A whole-word, any-case phrase (letters and digits around it do not count as a match). */
function phrase(p: string): RegExp {
  const body = p
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\s-]+/g, '[\\s-]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}

const words = (...ps: string[]): RegExp[] => ps.map(phrase)

/** The words that show each need. */
export const NEED_WORDS: Readonly<Record<EasyNeed, readonly RegExp[]>> = {
  ai: [
    ...words(
      'ai',
      'a.i.',
      'artificial intelligence',
      'chatgpt',
      'gpt',
      'openai',
      'llm',
      'chatbot',
      'chat bot',
      'machine learning',
      'api key',
      'weather api',
      'maps api',
      'google maps',
      'translation api',
      'image generation',
      'generate images',
    ),
    /\bpaid\s+api\b/i,
  ],
  payments: words(
    'online shop',
    'online store',
    'store front',
    'storefront',
    'sell',
    'selling',
    'sell online',
    'buy online',
    'buy tickets',
    'checkout',
    'check out',
    'payment',
    'payments',
    'pay online',
    'stripe',
    'paypal',
    'shopping cart',
    'cart',
    'donations',
    'donate',
  ),
  login: words(
    'login',
    'log in',
    'logins',
    'sign in',
    'signin',
    'accounts',
    'user accounts',
    'members area',
    'member area',
    'members only',
    'password',
    'profile page',
    'profiles',
  ),
  forms: words(
    'sign up',
    'signup',
    'sign ups',
    'signups',
    'newsletter',
    'waitlist',
    'wait list',
    'mailing list',
    'contact form',
    'form',
    'forms',
    'rsvp',
    'booking',
    'bookings',
    'book a',
    'reservation',
    'reservations',
    'enquiry',
    'inquiry',
    'enquiries',
    'collect emails',
    'leave their email',
    'registration',
  ),
  data: words(
    'database',
    'store data',
    'save data',
    'saved online',
    'save online',
    'between devices',
    'across devices',
    'sync',
    'shared list',
    'shared with',
    'leaderboard',
    'everyone can see',
    'real time',
    'realtime',
  ),
  blog: words('blog', 'blog posts', 'post articles', 'write posts', 'news posts', 'journal'),
}

/** Words that make a form a sign-up (its question says "sign-ups"). */
const SIGNUP_WORDS = words(
  'sign up',
  'signup',
  'sign ups',
  'signups',
  'newsletter',
  'waitlist',
  'wait list',
  'mailing list',
  'registration',
  'rsvp',
)

/** The needs an idea has (EASY_NEEDS order), for a website or an app; none for every other kind. */
export function detectNeeds(idea: string, kind: EasyKind): EasyNeedView[] {
  if (!EASY_WEB_KINDS.includes(kind)) return []
  const out: EasyNeedView[] = []
  for (const need of EASY_NEEDS) {
    if (!NEED_WORDS[need].some((w) => w.test(idea))) continue
    // A login usually means people sign up for it too; the login question covers that, not a separate form one.
    const choices = [...EASY_NEED_CHOICES[need]]
    out.push({
      need,
      choices,
      recommended: choices[0] as string,
      ...(need === 'forms' && SIGNUP_WORDS.some((w) => w.test(idea)) ? { signup: true as const } : {}),
    })
  }
  return out
}

/** The user's choice for a need (the recommended one when they made none, or one that need does not have). */
export function chosenWay(view: EasyNeedView, answers: EasyNeedAnswers | undefined): string {
  const a = answers?.[view.need]
  return a !== undefined && view.choices.includes(a) ? a : view.recommended
}

/** What the run is told for each need and way (plain instructions for the AI, never shown as UI copy). */
const TASK_NOTE: Readonly<Record<EasyNeed, Readonly<Record<string, string>>>> = {
  ai: {
    proxy:
      'It calls an AI or paid API. The key must never be in the page, in the built files or in a VITE_, NEXT_PUBLIC_ or REACT_APP_ variable. Put the call in one small server function (netlify/functions/<name>.mjs for Netlify, functions/api/<name>.js for Cloudflare Pages) that reads the key from an environment variable set in the host\'s settings, and have the page call /api/<name> (for Netlify add "/api/*  /.netlify/functions/:splat  200" above the single-page rule in public/_redirects). Add .env.example naming the variable with no value, and a README section "Setting your key" with the steps for Netlify and Cloudflare Pages. Until the key is set, the page shows a friendly message instead of failing.',
    keyless:
      'Where it needs data from another service, use a public API that needs no key (for example Open-Meteo for weather or OpenStreetMap for maps), called from the page. Never put a secret key in the page. If no keyless API can do the job, leave that part out and show a short note that it can be added later.',
    none: 'Leave out any AI or paid API for now: where it would go, show a short note that it can be added later. Never put a key in the page.',
  },
  payments: {
    links:
      'Sell through hosted payment links (such as Stripe Payment Links): each Buy button is a plain link to a [Fill in: payment link] the owner pastes in later. No card form in the page, no server and no secret keys.',
    contact:
      'Do not take payments on the site: show what is offered and how to order by getting in touch ([Fill in: how to order]). No card form, no checkout.',
  },
  login: {
    hosted:
      'Sign-in uses Supabase Auth from the page, with its public URL and anon key read from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public by design; never the service role key in the page). Turn on row level security for every table. Without the settings, the page says sign-in is not set up yet instead of failing. Add .env.example and a README section "Setting up sign-in" with the steps.',
    none: 'No accounts: everything works without signing in. Do not add sign-in.',
  },
  forms: {
    email:
      'The form is a Netlify form (a <form> with a name, data-netlify="true" and a hidden form-name field; for a React page keep a plain copy of the form, hidden, in index.html so Netlify finds it when it deploys) that shows a thank-you message after sending. Netlify emails each one to the owner; the site itself stores nothing. Say in the README that the form works once the site is on Netlify.',
    list: 'Form entries are saved in a Supabase table from the page (public URL and anon key from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY; row level security on, allowing only inserts from the page). Without the settings, the form says it is not set up yet. Add .env.example and a README section with the steps.',
    none: 'The form shows a thank-you message, but nothing is sent or saved yet; say so in the README.',
  },
  data: {
    device:
      'What it remembers is saved in the browser of the person using it (localStorage, read and written safely); it is not shared between devices or people. No server and no database.',
    online:
      'What it remembers is saved online in Supabase from the page (public URL and anon key from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY; row level security on for every table), so it is the same on every device. Without the settings it keeps working on this device only and says so. Add .env.example and a README section with the steps.',
  },
  blog: {
    files:
      'Posts are files in the project (one per post, in a posts folder), listed newest first; a new post is added by adding a file. No server and no online editor.',
    cms: 'Posts are Markdown files in the project, and the owner can also write them in the browser with Decap CMS (an admin/ page with its config; it saves posts to their Git repository). Add a README section "Writing posts" with the steps.',
  },
}

/** The task's note for an idea's needs, as the user chose them (empty: none). */
export function needsNote(views: readonly EasyNeedView[], answers: EasyNeedAnswers | undefined): string {
  if (views.length === 0) return ''
  return [
    'What it needs beyond pages in a browser (the user chose these; follow them):',
    ...views.map((v) => `- ${TASK_NOTE[v.need][chosenWay(v, answers)] ?? ''}`),
  ].join('\n')
}
