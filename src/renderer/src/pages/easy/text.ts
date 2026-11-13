// Every word Easy mode shows, in one module (a test scans it for em dashes and pins the button labels' widths). Plain
// language for someone who does not write code: no step names, no vendor jargon, the next step always said. Dynamic
// lines are small functions over core's numbers; nothing here decides anything.
import { BRAND } from '@shared/brand.ts'
import type { AcceptanceStatus } from '@shared/acceptance.ts'
import { NODE_MIN_TEXT, NODE_RECOMMENDED_TEXT } from '@shared/easy.ts'
import type {
  EasyAttachNote,
  EasyKind,
  EasyMultiplayer,
  EasyNeed,
  EasyStack,
  Milestone,
} from '@shared/easy.ts'
import type { CardKind } from '@shared/run.ts'

// ---- shared bits ----------------------------------------------------------------------------------------------

/** `$1.40`; under a cent reads "less than $0.01". */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'less than $0.01'
  return `$${usd.toFixed(2)}`
}

/** `$5` for a whole amount, `$2.50` otherwise (limits the user typed). */
export function limitDollars(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
}

/** `1 minute`, `12 minutes`, `1 hour 5 minutes`. */
export function minutesText(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`
  const h = Math.floor(m / 60)
  const rest = m % 60
  const hours = `${h} ${h === 1 ? 'hour' : 'hours'}`
  return rest === 0 ? hours : `${hours} ${rest} ${rest === 1 ? 'minute' : 'minutes'}`
}

// ---- welcome and switching ------------------------------------------------------------------------------------

export const WELCOME_TITLE = `How would you like to use ${BRAND.displayName}?`
export const WELCOME_EASY = 'Make something for me'
export const WELCOME_EASY_NOTE =
  'Describe an idea. It asks you a few questions, builds it, checks it and explains how to use it.'
export const WELCOME_FULL = 'Full control'
export const WELCOME_FULL_NOTE = 'Choose the folder, the models and every step yourself.'
export const WELCOME_SWITCH_NOTE = 'You can switch at any time from the sidebar.'

export const SWITCH_GROUP_LABEL = `How you use ${BRAND.displayName}`
export const SWITCH_EASY = 'Easy'
export const SWITCH_FULL = 'Full'
export const SWITCH_LABELS: readonly string[] = [SWITCH_EASY, SWITCH_FULL]
export const SWITCH_EASY_HINT = 'Make something from an idea'
export const SWITCH_FULL_HINT = 'Full control over every step'
export const EXPERIENCE_ROW_NOTE =
  'Easy makes something from an idea and asks only plain questions. Full control shows every step. Switching never stops a run.'
export const PALETTE_TO_EASY = 'Switch to Easy mode'
export const PALETTE_TO_FULL = 'Switch to Full control'

export const NAV_HOME = 'Home'
export const NAV_PROJECTS = 'Projects'
export const NAV_OVERNIGHT = 'Overnight'
export const NAV_SETTINGS = 'Settings'

// ---- home -----------------------------------------------------------------------------------------------------

export const HOME_TITLE = 'What do you want to make?'
export const IDEA_LABEL = 'Your idea'
export const IDEA_PLACEHOLDER =
  'For example: a tip splitter my friends can open on their phones, to share the bill after dinner'
export const IDEA_HINT = 'Say who it is for and what they should be able to do. Plain words are fine.'
export const NEXT_LABEL = 'Next'
export const NEXT_DISABLED = 'Describe your idea first'

// "Help me think it through" (read-only, a few rounds, only on a click)
export const THINK_LABEL = 'Help me think it through'
export const THINK_TEXT =
  'Not sure yet? It asks a few questions, each with 2 or 3 directions to pick from, then writes a short brief for the box above. Nothing is made yet.'
export const THINK_DISABLED = 'Write a few words about your idea first, even a rough one'
/** What it sends and costs, said before the click (each round is one call). */
export function thinkCostText(vendor: string, usd: number | null, rounds: number): string {
  const cost =
    typeof usd !== 'number'
      ? ''
      : usd < 0.01
        ? ' Each round costs less than $0.01.'
        : ` Each round costs about ${dollars(usd)}.`
  return `Sends your idea and your answers to ${vendorName(vendor)}, at most ${rounds} rounds.${cost}`
}
export const THINK_TITLE = 'Thinking it through'
export function thinkRoundText(n: number, max: number): string {
  return `Question ${n} of at most ${max}`
}
export const THINK_PICK = 'Pick the closest, or say it your way below.'
export const THINK_OWN_LABEL = 'Your way'
export const THINK_OWN_PLACEHOLDER = 'For example: the second one, but with a booking form'
export const THINK_SEND = 'Use my words'
export const THINK_FINISH = 'Write the brief now'
export const THINK_STOP = 'Stop'
export const THINK_WAITING = 'Thinking about your answers…'
export const THINK_BRIEF_LABEL = 'Your brief'
export const THINK_USE = 'Put it in the idea box'
export const THINK_USED = 'The brief is in the idea box. Change anything you like, then press Next.'
export function thinkKindText(kind: EasyKind): string {
  return `It reads as: ${KIND_TEXT[kind]}.`
}
export const EXAMPLES_TITLE = 'Need an idea? Start from one of these'
export const EXAMPLE_USE = 'Use this example'

export interface EasyExample {
  kind: EasyKind
  /** Tells two examples of one kind apart (the card's id); absent: the kind. */
  id?: string
  title: string
  text: string
}

/** The gallery: clicking one fills the idea box with its text (editable); it never starts anything. */
export const EXAMPLES: readonly EasyExample[] = [
  {
    kind: 'app',
    title: 'An app',
    text: 'A tip splitter my friends can open on their phones: enter the bill, the tip and how many people, and see what each person pays.',
  },
  {
    kind: 'website',
    title: 'A website or landing page',
    text: 'A landing page for my bakery with our opening hours, a few photos of our cakes and a sign-up form for our newsletter.',
  },
  {
    kind: 'document',
    title: 'A guide or docs',
    text: 'A help guide for the customers of my knitting shop: how to order, how shipping works and how to care for the yarn.',
  },
  {
    kind: 'data',
    title: 'A report from data',
    text: 'A report from a sales spreadsheet that shows the monthly totals, the trend over the year and the best-selling products.',
  },
  {
    kind: 'research',
    title: 'A research memo',
    text: 'A research memo comparing three ways to take bookings for a small yoga studio, with a recommendation.',
  },
  {
    kind: 'checklist',
    title: 'A checklist or how-to',
    text: 'A step by step checklist for opening my cafe each morning, from unlocking the door to serving the first coffee.',
  },
  {
    kind: 'game',
    title: 'A game',
    text: "A snake game I can play on my phone or laptop: eat apples to grow, don't hit the walls, and remember my best score.",
  },
  {
    kind: 'game',
    id: 'game-photos',
    title: 'A game with your photos',
    text: 'A birthday memory game with our family photos: turn over two cards at a time and find the matching pairs.',
  },
]

export const ADD_FILES = 'Add files'
export const ADD_FILES_LABEL = 'Files for this project (optional)'
export const ADD_FILES_NOTE =
  'A spreadsheet, notes, a logo. They are copied into the new project; the originals stay where they are.'
export const PRIVACY_LINE = 'Your file is sent to Claude or Codex to build the report.'
/** Said when an added file is a photo (a memory game with family photos, a birthday quiz). */
export const PHOTO_PRIVACY_LINE =
  'Your photos are copied into the project and sent to Claude or Codex to build it. If you share what it makes, anyone with the link can see them.'
export const REMOVE_FILE = 'Remove'
export const ATTACH_CHECKING = 'Checking the files…'
export const FILES_LABEL = 'Files it starts with'

/** "sales.csv goes to data/ (1.2 MB)". */
export function attachLineText(dest: 'data' | 'assets', bytes: number, folder: boolean): string {
  const mb = bytes / (1024 * 1024)
  const size = mb >= 0.1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${folder ? 'A folder, copied' : 'Copied'} into ${dest}/ (${size})`
}

/** What to know about an added file (EasyAttachment.note), on its row. */
export const ATTACH_NOTE_TEXT: Readonly<Record<EasyAttachNote, string>> = {
  converted: 'Its first sheet is also copied as a CSV file, which the report reads.',
  unreadable:
    'This kind of spreadsheet cannot be read here. Save it as CSV (File, Save As, CSV) and add that file instead.',
  large: 'This file is large: the AI reads the start of it to plan, and the report reads all of it.',
}

export function filesCountText(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'} added. ${PRIVACY_LINE}`
}

export const WORK_EXISTING = 'Work on something I already have'
export const WORK_EXISTING_NOTE = 'Pick a folder on this computer and say what to change in it.'
export const OVERNIGHT_LINK = 'Make several things overnight'
export const OVERNIGHT_LINK_NOTE = 'Add a few ideas and let them be made one after another.'

export const PROJECTS_TITLE = 'Your projects'
export const PROJECTS_EMPTY = 'Nothing yet. What you make shows up here.'
export const PROJECTS_PAGE_TITLE = 'Your projects'
export const OPEN_LABEL = 'Open'
export const MAKE_CHANGE_SHORT = 'Make a change'
export const PROJECT_LABELS: readonly string[] = [OPEN_LABEL, MAKE_CHANGE_SHORT]

/** A project's last result, one short phrase. */
export function projectStatusText(status: string, outcome: string | undefined): string {
  switch (status) {
    case 'queued':
      return 'Waiting to start'
    case 'running':
      return 'Being made now'
    case 'waiting':
      return 'Waiting for you'
    case 'paused':
      return 'Paused'
    case 'failed':
      return 'Did not finish'
    case 'cancelled':
      return 'Stopped'
    case 'completed':
      return outcome === 'clean' || outcome === 'fixed' || outcome === 'no-changes' ? 'Ready' : 'Mostly ready'
    default:
      return 'Unknown'
  }
}

// ---- confirm --------------------------------------------------------------------------------------------------

export const CONFIRM_TITLE = "Here's what I'll make"
export const CONFIRM_LOADING = 'Working out what to make…'
export const KIND_LABEL = 'What it is'
export const KIND_TEXT: Readonly<Record<EasyKind, string>> = {
  app: 'An app',
  website: 'A website',
  document: 'A document or guide',
  data: 'A report from data',
  research: 'A research memo',
  checklist: 'A checklist or how-to',
  game: 'A game',
}

export function kindNote(source: 'chosen' | 'words' | 'default'): string {
  switch (source) {
    case 'chosen':
      return 'You picked this.'
    case 'words':
      return 'Picked from your words. Change it if it is not right.'
    case 'default':
      return 'Nothing in your words pointed to one kind, so this is a guess. Change it if it is not right.'
  }
}

/** Each kind as it reads inside a sentence ("Did you mean a website or an app?"). */
export const KIND_A: Readonly<Record<EasyKind, string>> = {
  app: 'an app',
  website: 'a website',
  document: 'a document or guide',
  data: 'a report from data',
  research: 'a research memo',
  checklist: 'a checklist or how-to',
  game: 'a game',
}

/** "Did you mean a website or an app?", "Did you mean a website, an app or a report from data?". */
export function didYouMeanText(kinds: readonly EasyKind[] = ['website', 'app']): string {
  const words = kinds.map((k) => KIND_A[k])
  const last = words.pop() ?? ''
  return words.length === 0 ? `Did you mean ${last}?` : `Did you mean ${words.join(', ')} or ${last}?`
}
export const AMBIGUOUS_NOTE = 'Your idea could be either. Pick the one you meant.'
export const HELP_CHOOSE = 'Help me choose'
/** What "Help me choose" does and costs, said before the click (it is the only way a model is asked here). */
export function helpChooseText(vendor: string, usd: number | null): string {
  const who = vendor === 'codex' ? 'Codex' : vendor === 'claude' ? 'Claude' : vendor
  const cost =
    usd === null ? '' : usd < 0.01 ? ' It costs less than $0.01.' : ` It costs about ${dollars(usd)}.`
  return `Sends your idea to ${who} to suggest one, nothing else.${cost}`
}
export function suggestedText(kind: EasyKind, reason: string): string {
  return `Suggested: ${KIND_TEXT[kind]}. ${reason}`.trim()
}
export const START_NEEDS_KIND = 'Pick what you meant first'

export function startsFromText(label: string): string {
  return `Starts from: ${label}.`
}

export function fallbackText(wanted: string, needs: 'node' | 'python', wantedId?: string): string {
  const tool = needs === 'node' ? 'Node.js' : 'Python'
  if (wantedId === 'game-3d-lite')
    return `A 3D game uses three.js, which is installed into the project with ${tool}. ${tool} is not installed, so it starts as a 2D game that needs nothing installed.`
  return `${wanted} needs ${tool}, which is not installed, so it starts from a version that needs nothing installed.`
}

/** The libraries the project installs into itself with npm: "Uses three.js, installed into the project (needs Node)". */
export function installsText(names: readonly string[]): string {
  const list =
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
  return `Uses ${list}, installed into the project (needs Node).`
}

/** A report from data with no data file added (the confirm screen), with Add files beside it. */
export const NO_DATA_FILE = 'No data file added: it will use example numbers.'
export const NO_DATA_FILE_NOTE =
  'Add your spreadsheet or CSV file to make the report from your own numbers. You can also swap it in later with Make a change.'

export const WHERE_LABEL = 'Where it is saved'
export const CHANGE_FOLDER = 'Change'
export const WHERE_NOTE = 'A new folder only for this project.'
/** Said under the folder when the default is in the user's folder because OneDrive syncs Documents. */
export const ONEDRIVE_NOTE =
  'Your Documents folder is synced with OneDrive, which can slow down or break app projects (they hold thousands of small files), so new projects go in your user folder instead. You can change this in Easy settings.'

// ---- how a website or app is built --------------------------------------------------------------------------

export const STACK_LABEL = 'How it is built'
export const STACK_TEXT: Readonly<Record<EasyStack, string>> = {
  react: 'React (recommended)',
  html: 'Plain HTML (no build step)',
}
export const STACK_NOTE: Readonly<Record<EasyStack, string>> = {
  react:
    'A modern app with a real look: light and dark, phone to desktop, and pages you can move between. It is installed, built and previewed for you.',
  html: 'Plain files that open in any browser, with nothing to install or build. Simpler, with fewer features.',
}
export const CHECK_AGAIN = 'Check again'
export const NODE_INSTALL_TITLE = 'How to install Node.js'

/** Why it is plain HTML: Node.js is missing, or too old for React's build tools. */
export function noReactText(version: string | null | undefined, old: boolean): string {
  const then = `To make it with React instead, install Node.js ${NODE_RECOMMENDED_TEXT} or newer, then press ${CHECK_AGAIN}.`
  if (old && version !== null && version !== undefined)
    return `Node.js ${version} is installed, but React's build tools need ${NODE_MIN_TEXT} or newer, so it is made with plain HTML: files that open in any browser. ${then}`
  return `Node.js is not installed, so it is made with plain HTML: files that open in any browser. ${then}`
}

/** How to install Node.js on this computer, step by step. */
export function nodeInstallSteps(platform: string): string[] {
  const site = `Open nodejs.org, download the LTS version (${NODE_RECOMMENDED_TEXT} or newer) and run the installer.`
  const other =
    platform === 'win32'
      ? 'Or, in PowerShell: winget install OpenJS.NodeJS.LTS'
      : platform === 'darwin'
        ? 'Or, in Terminal with Homebrew: brew install node'
        : "Or use your system's package manager, or nvm."
  return [site, other, `Come back here and press ${CHECK_AGAIN}.`]
}

// ---- what a website or app needs beyond its pages ----------------------------------------------------------------

export const NEEDS_LABEL = 'What it needs'
export const WORKS_LABEL = 'What will work'
export const NO_NEEDS_TEXT =
  'Everything runs in the browser, so it can go on any free host. Nothing is stored online.'

/** The one plain question asked about a need. */
export function needQuestion(need: EasyNeed, signup: boolean): string {
  switch (need) {
    case 'ai':
      return 'Your idea uses an AI service. That needs a small server so your key stays secret. Set one up for you?'
    case 'payments':
      return 'How should people pay?'
    case 'login':
      return 'Should people sign in with their own account?'
    case 'forms':
      return signup
        ? 'Should sign-ups be saved somewhere, or just emailed to you?'
        : 'Should messages from the form be saved somewhere, or just emailed to you?'
    case 'data':
      return 'Should what it remembers stay on each device, or be online so it is the same everywhere?'
    case 'blog':
      return 'How do you want to add new posts?'
  }
}

/** One way to meet a need: its label, what it adds, what it costs, which hosts cover it, and what then works. */
export interface NeedChoiceText {
  label: string
  adds: string
  cost: string
  hosts: string
  works: string
}

const SUPABASE_COST =
  "Supabase's free plan covers small projects (with limits on users and storage, and it pauses after a week unused); paid plans start when you outgrow it. Check Supabase's current pricing."
const SUPABASE_HOSTS =
  'Works with Netlify, Cloudflare Pages or GitHub Pages (all free), plus a free Supabase account.'
const ANY_HOST = 'Works on any host, GitHub Pages too.'

export const NEED_CHOICE_TEXT: Readonly<Record<EasyNeed, Readonly<Record<string, NeedChoiceText>>>> = {
  ai: {
    proxy: {
      label: 'Yes, set up a free server for the key',
      adds: "A small function on Netlify or Cloudflare Pages calls the AI service for the page, so your key stays in the host's settings and never goes into the page.",
      cost: "The function is free on Netlify's and Cloudflare's starter plans. The AI service charges for each use with your own key, and some have a small free allowance. Check the provider's current pricing.",
      hosts:
        'Works on Netlify or Cloudflare Pages (free plans). Not on GitHub Pages, which has no functions.',
      works: "The AI part works once you put your key in the host's settings. Your key is never in the page.",
    },
    keyless: {
      label: 'Use a free service that needs no key',
      adds: 'Calls a public service that needs no key (weather and maps often have one) straight from the page.',
      cost: "Free, within the service's fair-use limits. Check the provider's current terms.",
      hosts: ANY_HOST,
      works: 'It uses a public service with no key. If none fits, that part is left for later.',
    },
    none: {
      label: 'Leave the AI part out for now',
      adds: 'Everything else is made; the AI part can be added later with Make a change.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'There is no AI part yet. You can add it later.',
    },
  },
  payments: {
    links: {
      label: 'Link to a payment page (Stripe)',
      adds: 'Each Buy button opens a payment page Stripe hosts, so the site needs no server and never sees a card number.',
      cost: "No monthly fee: Stripe takes a fee from each sale. Check Stripe's current pricing.",
      hosts: ANY_HOST,
      works: "People pay on Stripe's own page. You paste in your payment links and see orders in Stripe.",
    },
    contact: {
      label: 'No online payments: people contact me to order',
      adds: 'The site shows what you offer and how to order.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'Nobody pays on the site. Orders come to you.',
    },
  },
  login: {
    hosted: {
      label: 'Yes, with a free sign-in service (Supabase)',
      adds: 'Accounts and sign-in run on Supabase, so the site itself stays simple to host.',
      cost: SUPABASE_COST,
      hosts: SUPABASE_HOSTS,
      works: 'Sign-in works once you connect your Supabase project.',
    },
    none: {
      label: 'No accounts for now',
      adds: 'Everyone uses it without signing in.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'There is no sign-in. Everyone sees the same thing.',
    },
  },
  forms: {
    email: {
      label: 'Just emailed to me (Netlify Forms)',
      adds: 'Netlify collects each form and emails it to you. There is no server to run.',
      cost: "Free on Netlify's starter plan up to a monthly number of submissions. Check Netlify's current pricing.",
      hosts: 'Works when the site is on Netlify.',
      works: 'They are emailed to you; nothing is stored in the site.',
    },
    list: {
      label: 'Saved in a list I can see (Supabase)',
      adds: 'Each one is saved in a table in your free Supabase project, where you can see and export them.',
      cost: SUPABASE_COST,
      hosts: SUPABASE_HOSTS,
      works: 'They are saved in a list in your Supabase project.',
    },
    none: {
      label: 'Not yet: it just says thank you',
      adds: 'The form is there, but nothing is sent yet.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'The form says thank you, but nothing is sent or saved yet.',
    },
  },
  data: {
    device: {
      label: 'On each device (free, nothing online)',
      adds: 'Things are saved in the browser of the person using it.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'What it remembers stays on each device. Nothing is stored online.',
    },
    online: {
      label: 'Online, the same everywhere (Supabase)',
      adds: 'Things are saved in your free Supabase project, so they are the same on every device.',
      cost: SUPABASE_COST,
      hosts: SUPABASE_HOSTS,
      works: 'What it remembers is saved online in your Supabase project.',
    },
  },
  blog: {
    files: {
      label: 'Add posts as files (with Make a change)',
      adds: 'Each post is a file in the project.',
      cost: 'Free.',
      hosts: ANY_HOST,
      works: 'New posts are added as files. There is no online editor.',
    },
    cms: {
      label: 'Write posts in the browser (Decap CMS)',
      adds: 'A free, open-source editor at /admin saves each post to your GitHub repository.',
      cost: 'Free.',
      hosts: 'Works on Netlify or Cloudflare Pages, with a GitHub account.',
      works: 'You write posts in the browser at /admin once it is connected to GitHub.',
    },
  },
}

/** What works for a need, as chosen ("Sign-ups are emailed to you; nothing is stored in the site."). */
export function worksText(need: EasyNeed, choice: string, signup: boolean): string {
  const t = NEED_CHOICE_TEXT[need][choice]?.works ?? ''
  if (need !== 'forms') return t
  const who = signup ? 'Sign-ups' : 'Messages from the form'
  return t.replace(/^They /, `${who} `)
}

/** "Also: sign-in (No accounts for now)." for the needs not asked about. */
export function alsoNeedText(need: EasyNeed, choice: string): string {
  return `${NEED_NAME[need]}: ${NEED_CHOICE_TEXT[need][choice]?.label ?? choice}`
}
export const NEED_NAME: Readonly<Record<EasyNeed, string>> = {
  ai: 'AI service',
  payments: 'Payments',
  login: 'Sign-in',
  forms: 'Form',
  data: 'Saving things',
  blog: 'Posts',
}
export const NEED_ALSO = 'Also decided for you (change any of them):'

/** The checks it runs before it says it is ready, in one sentence (empty: none). */
export function checksText(names: readonly string[]): string {
  const parts: string[] = []
  if (names.some((n) => /^tests$/i.test(n))) parts.push('runs its tests')
  if (names.some((n) => /^site check$/i.test(n))) parts.push('runs its checks')
  if (names.some((n) => /^build$/i.test(n))) parts.push('builds it')
  if (names.some((n) => /^page loads/i.test(n))) parts.push('opens the page to check it loads without errors')
  if (parts.length === 0) return ''
  const last = parts.pop() ?? ''
  return `Before it says it is ready, it ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}.`
}

export const WHAT_HAPPENS_LABEL = 'What happens'
export function whatHappensText(research: boolean): string {
  return research
    ? "I'll ask you a few questions and look at similar things for ideas. Then I'll show you the plan and build it. I'll check it, fix what I find, and explain how to use it."
    : "I'll ask you a few questions and show you the plan. Then I'll build it. I'll check it, fix what I find, and explain how to use it."
}

/** What a Quick run does, in plain words (one strong session, then the checks and one review). */
export const QUICK_HAPPENS_TEXT =
  "I'll build it in one go, then check it and have it reviewed once. I'll fix only what the checks find, and explain how to use it."

/** What the run does, for the depth it will have (Thorough: the plan first; Quick: straight to building). */
export function whatHappensFor(research: boolean, depth: 'direct' | 'full' | undefined): string {
  return depth === 'direct' ? QUICK_HAPPENS_TEXT : whatHappensText(research)
}

export const DEPTH_LABEL_EASY = 'How thorough'
/** The change screen's depth line before there is a change to decide for. */
export const CHANGE_DEPTH_WAIT = 'Type the change and Dim Factory chooses how thorough to be.'

export const COST_LABEL = 'Cost and time'
export const NO_ESTIMATE = 'No estimate yet: nothing like this has been made here before.'

/** "Usually 10 to 25 minutes and $1.00 to $3.00." */
export function estimateText(
  durationMs: { p50: number; p80: number },
  costUsd: { p50: number; p80: number } | null,
): string {
  const a = Math.max(1, Math.round(durationMs.p50 / 60_000))
  const b = Math.max(a, Math.round(durationMs.p80 / 60_000))
  const time = a === b ? `about ${minutesText(a)}` : `${a} to ${b} minutes`
  if (costUsd === null) return `Usually ${time}. No price is known yet for the models it uses.`
  const c = dollars(costUsd.p50)
  const d = dollars(Math.max(costUsd.p50, costUsd.p80))
  return c === d ? `Usually ${time} and about ${c}.` : `Usually ${time} and ${c} to ${d}.`
}

export const LIMIT_LABEL = 'Spending limit'
export const LIMIT_INPUT_LABEL = 'Stop if it costs more than (US dollars)'
export const LIMIT_NONE = 'No limit'
export const LIMIT_NONE_TEXT = 'No spending limit. Set one here if you want it to stop at an amount.'

export function limitText(maxCostUsd: number): string {
  return `It stops at ${limitDollars(maxCostUsd)}.`
}

export function overLimitText(maxCostUsd: number, raiseTo: number): string {
  return `This may cost more than your ${limitDollars(maxCostUsd)} limit. Raise it to ${limitDollars(raiseTo)}, or describe a smaller first version.`
}

export const RAISE_LABEL = 'Raise it'

export const CONSENT_LABEL = 'What it may do'
export const CONSENT_TEXT =
  'It will create and change files in this project folder only. It may also install the building blocks it needs from the internet, and run the project to test it. It will ask you before anything else.'
export const CONSENT_CHECK = 'Allow these for this project'
export const CONSENT_NOTE =
  'Only in this new folder: installing what the project lists, running its own scripts and checks, and opening it. Anything else still asks you. You can take it back at any time in Easy settings.'

// ---- the project permission -----------------------------------------------------------------------------------

/** "Approved under your project permission: 6". */
export function permissionUsesText(n: number): string {
  return `Approved under your project permission: ${n}`
}
export const PERMISSIONS_TITLE = 'Project permissions'
export const PERMISSIONS_INTRO =
  'Projects where you allowed installing what the project lists, running its own scripts and checks, and opening it, without asking each time. Only inside each project folder; anything else always asks. Taking it back works at once, even while it is being made.'
export const PERMISSIONS_NONE = 'No project has this permission.'
export const PERMISSIONS_LOADING = 'Reading the project permissions…'
export const REVOKE_PERMISSION = 'Take it back'
export function permissionSinceText(at: string): string {
  return `Allowed ${at}`
}

export const WHO_LABEL = 'Who does the work'
export function whoText(claude: boolean, codex: boolean): string {
  if (claude && codex) return 'Using Claude and Codex.'
  if (claude) return 'Using Claude.'
  if (codex) return 'Using Codex.'
  return 'Sign in to Claude or Codex to start.'
}
export const SET_UP_LABEL = 'Set up'

/** Setting up Claude or Codex, in Easy: plain steps, the commands to paste, and Check again. */
export const SETUP_TITLE = 'Set up Claude or Codex'
export const SETUP_INTRO =
  'The work is done by Claude Code or Codex on this computer, with your own account. Set up one of them (either is enough):'
export const SETUP_CLAUDE = 'Claude Code'
export const SETUP_CODEX = 'Codex'
export const COPY_LABEL = 'Copy'
export const COPIED = 'Copied. Paste it in the window and press Enter.'
export const SETUP_CHECK = 'Check again'
export const SETUP_CHECKING = 'Checking…'
export const SETUP_STILL = 'Still not ready. Finish the steps, then check again.'
export const SETUP_READY = 'Ready. You can start now.'

/** Where to paste a command on this computer. */
export function terminalName(platform: string): string {
  return platform === 'win32' ? 'PowerShell' : 'Terminal'
}

/** A vendor's install and sign-in commands on this computer (the vendors' own installers), in that order. */
export function setupCommands(platform: string, vendor: 'claude' | 'codex' = 'claude'): string[] {
  const win = platform === 'win32'
  if (vendor === 'codex')
    return [
      win
        ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
        : 'npm install -g @openai/codex@latest',
      'codex login',
    ]
  return [
    win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    'claude auth login',
  ]
}

/** The steps around the commands. */
export function setupSteps(platform: string): string[] {
  const where = terminalName(platform)
  return [
    platform === 'win32'
      ? 'Open PowerShell (type PowerShell in the Start menu).'
      : platform === 'darwin'
        ? 'Open Terminal (type Terminal in Spotlight).'
        : `Open ${where}.`,
    'Paste the first command to install it, then the second to sign in: your browser opens to sign in with your account.',
    'Come back here and press Check again.',
  ]
}

export const START_LABEL = 'Start'
export const BACK_LABEL = 'Back'
export const START_NEEDS_VENDOR = 'Sign in to Claude or Codex first'
export const START_LOADING = 'Getting things ready'
export const LIMIT_INVALID = 'Enter an amount above zero, or choose No limit'

// ---- the run --------------------------------------------------------------------------------------------------

export const MILESTONE_TITLE: Readonly<Record<Milestone, string>> = {
  understand: 'Understanding your idea',
  build: 'Building it',
  check: 'Checking it',
  fix: 'Fixing what we found',
  wrap: 'Wrapping up',
}

export const MILESTONE_STATE = {
  waiting: 'Not started',
  working: 'Working',
  needsYou: 'Needs you',
  done: 'Done',
  notNeeded: 'Not needed',
  stopped: 'Stopped',
  failed: 'Did not finish',
} as const
export type MilestoneState = keyof typeof MILESTONE_STATE

export const LINE = {
  gettingReady: 'Getting ready',
  thinkingQuestions: 'Thinking of a few questions',
  waitingAnswers: 'Waiting for your answers',
  lookingAround: 'Looking at similar things for ideas',
  waitingResearch: 'Waiting for you to look at what I found',
  writingPlan: 'Writing the plan',
  waitingPlan: 'Waiting for you to check the plan',
  checking: 'Checking it against the plan',
  nothingToFix: 'Nothing to fix',
  fixing: 'Fixing',
  fixed: 'Fixed',
  writingHowTo: 'Writing how to use it',
  done: 'Done',
  notNeeded: 'Not needed',
  stopped: 'Stopped',
  notStarted: 'Not started yet',
  needsAnswer: 'Waiting for your answer',
  failed: 'Something went wrong here',
} as const

export function buildingText(files: number): string {
  return `Building: ${files} ${files === 1 ? 'file' : 'files'} so far`
}

export function builtText(files: number): string {
  return `Made ${files} ${files === 1 ? 'file' : 'files'}`
}

export function toFixText(n: number): string {
  return `Found ${n} ${n === 1 ? 'thing' : 'things'} to fix`
}

export function roundText(n: number, of: number): string {
  return `Fixing, round ${n} of ${of}`
}

/** "12 minutes so far (about 8 more)". */
export function timeSoFarText(elapsedMs: number, leftMs: number | undefined): string {
  const min = Math.floor(elapsedMs / 60_000)
  const so = min < 1 ? 'Less than a minute so far' : `${minutesText(min)} so far`
  if (leftMs === undefined) return so
  return `${so} (about ${minutesText(Math.max(1, Math.round(leftMs / 60_000)))} more)`
}

/** "$1.40 spent", "$1.40 of $5", "No price yet". */
export function spentText(costUsd: number | null, limit: number | null): string {
  if (costUsd === null) return limit !== null ? `No price yet, limit ${limitDollars(limit)}` : 'No price yet'
  return limit !== null ? `${dollars(costUsd)} of ${limitDollars(limit)}` : `${dollars(costUsd)} spent`
}

export const RUN_TITLE_WORKING = 'Making it'
export const STOP_LABEL = 'Stop'
export const STOP_CONFIRM = "Stop now? What's been made so far stays in the folder."
export const STOP_YES = 'Stop now'
export const STOP_NO = 'Keep going'
export const STOP_LABELS: readonly string[] = [STOP_YES, STOP_NO]
export const SHOW_DETAILS = 'Show details'
export const NOW_DOING = 'What it is doing now'
export const NOW_NOTHING = 'Nothing right now.'
export const COST_BAR_LABEL = 'Money spent against your limit'
export const NEEDS_ANNOUNCE = 'It needs your answer.'
/** The pill over the page while something that needs the user is out of view (a click brings it into view). */
export const NEEDS_JUMP = 'It needs you: show me'
/** The time line while something waits for the user (the run is not counting down then). */
export const WAITING_FOR_YOU_TIME = 'Waiting for you'
export const PROGRESS_LABEL = 'Progress'
export const RUN_LOADING = 'Loading…'
export const RUN_NOT_OPENED = 'This run could not be opened.'

// ---- plain cards ----------------------------------------------------------------------------------------------

export const QUESTIONS_TITLE = 'A few questions'
export const QUESTIONS_INTRO =
  'Your answers shape what gets made. Pick one, write your own, or let me decide.'
export const YOU_DECIDE = 'You decide'
export const OTHER_LABEL = 'Something else'
export const OTHER_PLACEHOLDER = 'Your own answer'
export const CONTINUE_LABEL = 'Continue'
export const SKIP_LABEL = 'Skip'

export const PLAN_TITLE = 'The plan'
export const PLAN_CAN_DO = "When it's done, you'll be able to:"
export const PLAN_NO_CRITERIA =
  'The plan does not list what you will be able to do. Open the full plan to read it.'
export const SHOW_PLAN = 'Show the full plan'
export const HIDE_PLAN = 'Hide the full plan'
export const PLAN_TOGGLE_LABELS: readonly string[] = [SHOW_PLAN, HIDE_PLAN]
export const BUILD_IT = 'Build it'
export const CHANGE_SOMETHING = 'Change something'
export const PLAN_CHANGE_LABEL = 'What should change?'
export const PLAN_CHANGE_PLACEHOLDER = 'For example: no sign-up, just a contact email'
export const SEND_CHANGE = 'Build it with this change'
export const CANCEL_CHANGE = 'Cancel'
export const PLAN_CHANGE_HEADING = 'Changes the user asked for before building'
export const DONT_ASK_PLAN = "Don't ask me next time"
export const DONT_ASK_PLAN_NOTE =
  'Later projects start building right after the plan. You can turn this back on in Easy settings.'

export const RESEARCH_TITLE = 'I looked at similar things'
export const RESEARCH_INTRO =
  'Here is what I found that could help. Use it for the plan, or plan without it. The details are in Show details.'

export const RESEARCH_USE = 'Use what I found'
export const RESEARCH_SKIP = 'Plan without it'
export function researchFoundText(n: number): string {
  return `${n} ${n === 1 ? 'idea' : 'ideas'} from similar things, with their sources.`
}

export const ANSWER_NEEDED_TITLE = 'It needs your answer'
export const ANSWER_IN_DETAILS = 'This one needs a few words from you. Answer it in Show details.'

/** Plain titles for the cards Easy has no body of its own for (core's choices are shown as they are). */
export const CARD_TITLE: Readonly<Partial<Record<CardKind, string>>> = {
  'gate:beforeFix': 'Fix what was found?',
  insufficientContext: 'It needs to know a little more',
  planMutated: 'The plan changed while it was being checked',
  preflight: 'Something needs fixing before it can start',
  reconcile: 'Files changed in the folder while it worked',
  trust: "It wants to run the project's own checks",
  depsConsent: 'It wants to install the building blocks it needs',
  depsFailed: 'Installing the building blocks did not work',
  verifyEnv: "The project's checks cannot run on this computer",
  emptyFindings: 'The check gave no clear answer',
  retryPartial: 'A step stopped halfway',
  finalize: 'Ready to put the changes into your folder',
  finalizeConflicts: 'Some files changed in both places',
  interruptedApply: 'Putting the changes in was interrupted',
  stall: 'It has gone quiet',
  testsNotRed: 'The new checks already pass',
  restartFresh: 'It ran low on memory',
  loop: 'It keeps repeating the same step',
}

// ---- asks -----------------------------------------------------------------------------------------------------

export const ALLOW = 'Allow'
export const DONT_ALLOW = "Don't allow"
export const ASK_LABELS: readonly string[] = [ALLOW, DONT_ALLOW]
export const SHOW_PROBLEM = 'Show the details'
export const HIDE_PROBLEM = 'Hide the details'
export const PROBLEM_LABELS: readonly string[] = [SHOW_PROBLEM, HIDE_PROBLEM]
/** A check that stops the run before it starts, when its kind has no plain line of its own. */
export const PREFLIGHT_PLAIN =
  'Something on this computer needs fixing before it can start. Fix it, then press Recheck.'
export const SHOW_WHAT_RUNS = 'Show what will run'
export const HIDE_WHAT_RUNS = 'Hide what will run'
export const WHAT_RUNS_LABELS: readonly string[] = [SHOW_WHAT_RUNS, HIDE_WHAT_RUNS]
export const ASK_TIMEOUT_NOTE = 'If nobody answers in time, the answer is no.'

export function askInstallText(command: string): string {
  return `It wants to install building blocks it needs (${command}). This downloads code from the internet into this project folder.`
}
export const ASK_RUN_PROJECT = 'It wants to run the project to test it.'
export const ASK_RUN_COMMAND = 'It wants to run a command in this project folder.'
export function askEditInsideText(path: string): string {
  return `It wants to change a file in this project: ${path}`
}
export function askOutsideText(path: string): string {
  return `It wants to change a file outside this project: ${path}`
}
export function askNetworkText(host: string): string {
  return `It wants to reach a website: ${host}`
}
export const ASK_OTHER = 'It asks for permission to do something.'
export const ASK_OUTSIDE_NOTE = 'This is outside the project folder, so the safe answer is no.'

// ---- Easy bodies for core's cards -----------------------------------------------------------------------------

/** The trust card: what runs and where, in plain words. */
export function trustBodyText(commands: readonly string[]): string {
  const list = commands.length > 0 ? ` (${commands.join(', ')})` : ''
  return `Let it run the project's own checks${list}? This runs code it just wrote, inside this folder.`
}
export function depsBodyText(command: string | null): string {
  return `It wants to install the building blocks the project lists${command !== null ? ` (${command})` : ''}. This downloads code from the internet into this project folder.`
}
export const DEPS_FAILED_BODY =
  'Installing the building blocks did not work. Try again, or go on without them; the details are in Show details.'
export const VERIFY_ENV_BODY =
  "The project's checks need something this computer does not have. It can go on without them; the details are in Show details."
export const STALL_BODY =
  'It has not said anything for a while. You can wait a little longer or stop this step.'
export const RECONCILE_BODY =
  'Some files in the project folder changed while it was working. Choose whether to keep your changes.'
export const EMPTY_FINDINGS_BODY = 'The check finished without a clear answer. You can run it again or go on.'
/** The plan-mutated card in Easy: planning should only read the project, but files changed while it planned. */
export function planMutatedBodyText(files: number): string {
  const what = files === 1 ? '1 file' : files > 1 ? `${files} files` : 'some files'
  return `While it was making the plan, ${what} in your project changed. Making the plan should only read your project. Put them back as they were (you can undo that), or keep them.`
}
export const PLAN_MUTATED_REVERT = 'Put them back'
export const PLAN_MUTATED_KEEP = 'Keep them'
export const SHOW_FILES_CHANGED = 'Show which files'
export const HIDE_FILES_CHANGED = 'Hide the files'
export const FILES_CHANGED_LABELS: readonly string[] = [SHOW_FILES_CHANGED, HIDE_FILES_CHANGED]
/** Easy's own words for core's choices, by card kind and choice id (others keep core's label). */
export const EASY_CHOICE_LABEL: Readonly<Partial<Record<CardKind, Readonly<Record<string, string>>>>> = {
  planMutated: { 'revert-plan': PLAN_MUTATED_REVERT, keep: PLAN_MUTATED_KEEP },
}

// ---- done -----------------------------------------------------------------------------------------------------

/** What the Done title calls each kind of project ("Your guide is ready"). */
export const KIND_NOUN: Readonly<Record<EasyKind, string>> = {
  app: 'app',
  website: 'website',
  document: 'guide',
  data: 'report',
  research: 'memo',
  checklist: 'checklist',
  game: 'game',
}
export const PROJECT_NOUN = 'project'

export function readyTitle(what: string): string {
  return `Your ${what} is ready`
}
export function mostlyReadyTitle(open: number): string {
  return open > 0
    ? `Mostly ready: ${open} ${open === 1 ? 'thing still needs' : 'things still need'} work`
    : 'Mostly ready: a few things still need work'
}
export const FAILED_TITLE = 'It did not finish'
export const FAILED_TEXT =
  "Something went wrong before it was done. What's been made so far stays in the folder."
/** A pass Dim Factory stopped for repeating itself (failure runaway_loop). */
export const LOOP_STOPPED_TEXT =
  "The AI kept repeating the same step, so we stopped it. What's been made so far stays in the folder."
/** The vendor's name in a sentence (core's vendor id). */
export function vendorName(vendor: string | undefined): string {
  if (vendor === 'claude') return 'Claude'
  if (vendor === 'codex') return 'Codex'
  if (vendor === undefined || vendor === '') return 'The AI'
  return vendor.charAt(0).toUpperCase() + vendor.slice(1)
}

/** "3:00 PM" in the user's own time format. */
export function clockText(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Why a run did not finish, in one plain line per kind of failure (core's failure category), with what to do next.
 * "resetsAt": when a usage limit resets, when the vendor said.
 */
export function failureText(category: string, vendor?: string, resetsAt?: number): string {
  const who = vendorName(vendor)
  switch (category) {
    case 'auth_required':
    case 'auth_expired':
      return `You are signed out of ${who}. Sign in again (the command is below), then press Carry on.`
    case 'rate_limited':
    case 'quota_exceeded':
      return resetsAt !== undefined
        ? `You reached ${who}'s usage limit. It resets at ${clockText(resetsAt)}: press Carry on after that.`
        : `You reached ${who}'s usage limit. Press Carry on once it resets (your account page says when).`
    case 'billing':
      return `Your ${who} account needs a payment method or more credit. Sort that out on their website, then press Carry on.`
    case 'network':
      return `It could not reach ${who}: check your internet connection, then press Carry on.`
    case 'cli_missing':
      return `${who} is not installed on this computer, or it moved. Set it up again (the steps are below), then press Carry on.`
    case 'cli_version':
    case 'flag_drift':
      return `This version of ${who} does not work with ${BRAND.displayName}. Update it, then press Carry on.`
    case 'model_unavailable':
      return `The AI model it asked for is not available on your ${who} account. Press Carry on to try again.`
    case 'timeout_stall':
    case 'timeout_hard':
      return `The AI stopped answering for too long. Press Carry on to pick up where it stopped.`
    case 'context_exceeded':
    case 'turn_limit':
      return 'The job got too big to do in one go. Press Carry on to finish it in a new go.'
    case 'runaway_loop':
      return LOOP_STOPPED_TEXT
    case 'content_policy':
      return `The AI would not do this request. Try saying it another way with Make a change.`
    case 'disk_full':
      return 'Your disk is full. Free some space, then press Carry on.'
    case 'permission_denied':
    case 'ask_timeout':
      return 'It needed your permission for something and did not get it. Press Carry on to try again.'
    case 'git_missing':
      return `Git is not installed, and ${BRAND.displayName} needs it to keep undo. Install Git, then press Carry on.`
    case 'process_crash':
    case 'vendor_internal':
      return `${who} had a problem on its side. Press Carry on to try again.`
    default:
      return FAILED_TEXT
  }
}

/** The kinds of problem a check before the start can name with a plain line of their own. */
const PREFLIGHT_PLAIN_CATEGORIES: ReadonlySet<string> = new Set([
  'auth_required',
  'auth_expired',
  'rate_limited',
  'quota_exceeded',
  'billing',
  'network',
  'cli_missing',
  'cli_version',
  'flag_drift',
  'model_unavailable',
  'disk_full',
  'git_missing',
])

/** A check that stops the run before it starts, in plain words (core's failure category), with Recheck as the next step. */
export function preflightText(category: string | undefined, vendor?: string): string {
  if (category === undefined || !PREFLIGHT_PLAIN_CATEGORIES.has(category)) return PREFLIGHT_PLAIN
  return failureText(category, vendor).replace(/press Carry on/g, 'press Recheck')
}

/** Failures whose fix is to sign in again: the sign-in command is shown with them. */
export const SIGN_IN_CATEGORIES: readonly string[] = ['auth_required', 'auth_expired']
/** Failures whose fix is to set the vendor up again: the setup steps are shown with them. */
export const SETUP_CATEGORIES: readonly string[] = ['cli_missing']
export const SIGN_IN_LABEL = 'To sign in, paste this'
export const CARRY_ON = 'Carry on'
export const CARRY_ON_TEXT =
  'Carry on starts a new go that picks up where this one stopped. What was made so far stays in the folder.'
export const TRY_AGAIN_LABEL = 'What it can do now'

export const STOPPED_TITLE = 'You stopped it'
export const STOPPED_TEXT = "What's been made so far stays in the folder."

export function costStopTitle(limit: number): string {
  return `It stopped at your ${limitDollars(limit)} limit`
}
export function timeStopTitle(minutes: number): string {
  return `It stopped at your ${minutesText(minutes)} limit`
}
export const LIMIT_STOP_TEXT = "What's done so far is kept."
export function continueMoreLabel(more: number): string {
  return `Continue with ${limitDollars(more)} more`
}
export function continueTimeLabel(minutes: number): string {
  return `Continue for ${minutesText(minutes)} more`
}

export const OPEN_IT = 'Open it'
export const SAVE_PDF = 'Save as PDF'
export function savedPdfText(name: string): string {
  return `Saved as ${name} in the project folder.`
}
export const SHOW_FILES = 'Show the files'
/** A game's Done screen: Play it (the preview window), Open in browser, and How to play with its controls line. */
export const PLAY_IT = 'Play it'
export const OPEN_IN_BROWSER = 'Open in browser'
export const OPENED_IN_BROWSER = 'Opened in your browser.'
export const PLAYING = 'Opened in a preview window. Press F11 for full screen.'
export const HOW_TO_PLAY = 'How to play'
export const CONTROLS_LABEL = 'Controls'
export const CONTROLS_UNKNOWN = 'Read How to play below.'
export const OPEN_NOTHING = 'There is no page to open for this one. Show the files to see what it made.'
export const OPEN_TRUST_FIRST =
  'Opening it runs a command. Check it in Show details first, then open it from there.'
export const OPENED = 'Opened in a preview window.'
export const WHAT_IT_CAN_DO = 'What it can do'
export const NO_CHECKLIST = 'There was no list of things to check for this one.'
export const ACCEPTANCE_WORD: Readonly<Record<AcceptanceStatus, string>> = {
  met: 'Works',
  'not-met': 'Not yet',
  unknown: 'Not sure',
  'not-checked': 'Not checked',
}
export const HOW_TO_USE = 'How to use it'
export const HOW_TO_USE_LOADING = 'Loading how to use it…'
export const HOW_TO_USE_NONE = 'There is no explanation for this one.'
export const MAKE_CHANGE_TITLE = 'Make a change'
export const TRY_IT_TITLE = 'Try it for me'
export const TRY_IT = 'Try it for me'
export const TRY_IT_TEXT =
  'Dim Factory opens it in a hidden window and presses what a visitor would, filling in forms with made-up details.'
export const TRY_IT_LIMIT =
  'It has no internet, costs nothing, and leaves out anything like paying or deleting. It finds what breaks, not whether it does what you wanted, so please still look yourself.'
export const TRY_IT_SKIPPED = 'Left out:'
export const TRY_IT_FIX = 'Fix these'
export function tryItAsked(problems: readonly string[]): string {
  return `Trying it found these problems:\n${problems.map((p) => `- ${p}`).join('\n')}`.slice(0, 1800)
}
export const ASK_TITLE = 'Ask about it'
export const ASK_TEXT =
  'Ask anything about it, like how to change the colours or what a file does. Nothing is changed.'
export const ASK_LABEL = 'Your question'
export const ASK_PLACEHOLDER = 'For example: how do I change the colours?'
export const ASK = 'Ask'
export const ASK_DISABLED = 'Write your question first'
export const ASK_WAITING = 'Reading the project…'
/** What it sends and costs, said before the click. */
export function askCostText(vendor: string, usd: number | null): string {
  const cost =
    typeof usd !== 'number'
      ? ''
      : usd < 0.01
        ? ' It costs less than $0.01.'
        : ` It costs about ${dollars(usd)}.`
  return `${vendorName(vendor)} reads the project's files to answer, on its cheapest model.${cost}`
}
export const SHARE_CHECK_TITLE = 'Before I share it'
export const SHARE_CHECK = 'Check before sharing'
export const SHARE_CHECK_TEXT =
  "One check, on this computer with no internet and no cost: the title, the preview image a shared link shows, a phone's width, links that go nowhere, passwords or keys in the files, and people's email addresses or phone numbers."
export const SHARE_CHECK_DOC_TEXT =
  "One check, on this computer with no internet and no cost: links between its files that go nowhere, passwords or keys in the files, and people's email addresses or phone numbers."
export const SHARE_CHECK_CANNOT =
  'What it cannot know: whether links to other sites still work, how it looks on every phone, pages the site only makes as you click, and whether the words and pictures are yours to share. Personal details are only pointed out here, never sent anywhere.'
export const SHARE_CHECK_WAITING = 'Checking…'
export const SHARE_CHECK_FIX = 'Fix these'
export const SHARE_STATUS_WORD = { ok: 'Fine', problem: 'Fix', unknown: 'Look' } as const
export function shareCheckSummary(problems: number, look: number): string {
  if (problems === 0 && look === 0) return 'Nothing to fix before sharing.'
  const fix = problems === 0 ? 'Nothing to fix' : `${problems} ${problems === 1 ? 'thing' : 'things'} to fix`
  const see = look === 0 ? '' : `, and ${look} to look at yourself`
  return `${fix}${see}.`
}
export function shareCheckAsked(fixes: readonly string[]): string {
  return `A check before sharing found these problems:\n${fixes.map((f) => `- ${f}`).join('\n')}`.slice(
    0,
    1800,
  )
}
export const NOT_WORKING = "It's not working"
export const NOT_WORKING_HINT = 'Say what you see, then press this. It finds the cause first, then fixes it.'
export const MAKE_CHANGE_LABEL = 'What should change?'
export const MAKE_CHANGE_PLACEHOLDER = 'For example: make the buttons bigger and add a dark theme'
export const MAKE_CHANGE = 'Make this change'
export const MAKE_CHANGE_DISABLED = 'Say what should change first'
export const BUSY_FOLDER = 'Wait until the project is not being worked on.'
export const UNDO_EVERYTHING = 'Undo everything'
export const UNDO_EVERYTHING_TEXT =
  'Puts the folder back as it was before this run. You can undo that too, from the message that appears.'
export const NOTHING_TO_UNDO = 'This run made no changes to undo.'
export const REMEMBER_TITLE = 'For next time'
export const REMEMBER_TEXT =
  'Keep a short note about what was made, so a change you ask for later starts from it.'
export const REMEMBER_LABEL = 'Remember this for next time'
export const REMEMBERED = 'Remembered. The next change starts from it.'
export const REMEMBER_BUSY = 'Wait until the project is not being worked on, then remember it.'
export const SHARE_TITLE = 'Share it'
export const SHARE_PUBLIC = 'Putting it online makes it public.'
export const SHARE_INTRO =
  'Anyone with the address can see it. Make an upload file and drag it onto a hosting page, or follow the steps for a free place that fits this project. Nothing is uploaded for you.'
export const SHARE_SHOW = 'Show how to share it'
export const SHARE_HIDE = 'Hide how to share it'
export const SHARE_TOGGLE_LABELS: readonly string[] = [SHARE_SHOW, SHARE_HIDE]
/** A game's Share it: who can play it, the places that fit a game (itch.io first). */
export const SHARE_PLAY_INTRO =
  'Anyone with the link can play. Make an upload file for itch.io or a drag-and-drop host, or follow the steps for a free place that fits a game. Nothing is uploaded for you.'
/** A report from data's Share it: who can see the figures, and that the data files stay out of the upload file. */
export const SHARE_DATA =
  'This report shows figures from your data: anyone with the link can see them. The upload file leaves your data files out unless you include them.'
export const SHARE_PHOTOS =
  'This game shows your own photos: anyone with the link can see them. Share it only with people you would show them to.'
/** The facts left as marked spaces instead of being made up (the summary's Things to fill in). */
export const FILL_IN_TITLE = 'Things to fill in'
export const FILL_IN_NOTE =
  'Facts only you know were left as marked spaces instead of being made up. Fill them in yourself, or say them in Make a change.'

/** The project's history: every run in its folder, newest first, each with Go back to before it. */
export const HISTORY_TITLE = 'Project history'
export const HISTORY_TEXT =
  'Every change made to this project, newest first. Going back to before a change undoes it and every change after it; a message lets you undo that too.'
export const HISTORY_BACK = 'Go back to before this'
export const HISTORY_NOTHING = 'Nothing to undo in this one'
export const HISTORY_FIRST = 'First version'
export function historyRowText(displayNo: number, when: string, status: string): string {
  return `#${displayNo} · ${when} · ${status}`
}

/** Make a change: about what it costs and how it runs (said before the click; the line keeps its height). */
export function changeEstimateText(
  durationMs: { p50: number; p80: number } | null,
  costUsd: { p50: number; p80: number } | null,
  small: boolean,
  full: boolean,
  /** A Quick change: one strong session, so no lighter planning model. */
  quick = false,
): string {
  const est = durationMs !== null ? estimateText(durationMs, costUsd) : NO_ESTIMATE
  const how =
    small && !quick
      ? 'A small change, so it uses a lighter model.'
      : full
        ? 'It gets a full security check, since it touches keys or personal data.'
        : ''
  return how === '' ? est : `${est} ${how}`
}
/** Make a change for a report from data: add a new data file with the change. */
export const REMOVE_REFUSED = 'Remove the files that cannot be added first'
export const CHANGE_FILES_NOTE = 'A new data file goes into data/, and the report is made again from it.'

export const TRY_FIXING = 'Try fixing the rest'
export const TRY_FIXING_TEXT = 'Starts another round that only fixes what is still open.'

// ---- a folder you already have ----------------------------------------------------------------------------------

export const EXISTING_TITLE = 'Work on something you already have'
export const EXISTING_FOLDER_LABEL = 'The folder'
export const EXISTING_PICK = 'Pick a folder'
export const EXISTING_NONE = 'No folder picked yet.'
export const EXISTING_LOADING = 'Looking at the folder…'
export const EXISTING_HOW_LABEL = 'How it works'
export const EXISTING_MODE_TEXT = {
  isolated:
    'It works on a copy of this folder, so your files stay as they are while it works. At the end you choose: keep the changes, or throw them away.',
  inPlace: 'It works right in this folder. Undo everything puts the folder back as it was before.',
  needsUndo:
    'It works right in this folder. So that everything it does can be undone, it first turns on undo for this folder. That adds a hidden .git folder; your files stay as they are.',
} as const
/** A copy starts from the last commit: changes git has not saved yet would not be in it. */
export function uncommittedText(n: number): string {
  return `${n} ${n === 1 ? 'file has' : 'files have'} changes that are not saved in git yet, so a copy would not have them (settings files such as .env are never copied either). Choose how to go on:`
}
export const HOW_SAVE_FIRST = 'Save my changes first, then work on a copy'
export const HOW_SAVE_FIRST_NOTE =
  'Saves everything in the folder as one git commit, so the copy starts from the folder as it is now.'
export const HOW_IN_PLACE = 'Work right in the folder'
export const HOW_IN_PLACE_NOTE =
  'Changes your files directly. Undo everything puts them back as they were before the run.'
export const NEEDS_HOW = 'Choose how to go on with your unsaved changes first'
export const EXISTING_MADE_NOTE = 'You made this project here. The change builds on it.'
export const UNDO_CHECK = 'Turn on undo for this folder'
export const UNDO_CHECK_NOTE = 'Needed before it starts. Undo everything then puts the folder back as it was.'
export const EXISTING_ASKS_LABEL = 'What it may do'
export const EXISTING_ASKS =
  'It changes files in this folder only. It asks you before it installs anything, runs the project or its checks, or touches anything outside this folder. The project permission is only for new projects made here.'
export const EXISTING_CHANGE_LABEL = 'What should it do?'
export const EXISTING_CHANGE_PLACEHOLDER = 'For example: add a contact page and make the text easier to read'
export const NEEDS_FOLDER = 'Pick a folder first'
export const NEEDS_CHANGE = 'Say what it should do first'
export const NEEDS_UNDO = 'Turn on undo for this folder first'

// ---- keeping or throwing away the changes of a copy --------------------------------------------------------------

export const CHANGES_TITLE = 'Your changes'
export const CHANGES_READY_TITLE = 'Your changes are ready'
export function changesReadyText(files: number | null): string {
  const made =
    files === null
      ? 'It made the changes in a copy of your folder.'
      : `It changed ${files} ${files === 1 ? 'file' : 'files'} in a copy of your folder.`
  return `${made} Your folder has not changed yet. Keep these changes to put them in your folder, or throw them away.`
}
export const KEEP_CHANGES = 'Keep these changes'
export const THROW_AWAY = 'Throw them away'
export const CHANGES_LABELS: readonly string[] = [KEEP_CHANGES, THROW_AWAY]
export const THROW_CONFIRM = 'Throw these changes away?'
export const THROW_CONFIRM_TEXT =
  'Your folder stays as it is and the copy is deleted. You can still undo this for a few seconds.'
export const THROW_NO = 'Keep them for now'
export const THROW_LABELS: readonly string[] = [THROW_AWAY, THROW_NO]
export function changesKeptText(files: number | null): string {
  return files === null
    ? 'Kept: the changes are in your folder.'
    : `Kept: ${files} ${files === 1 ? 'file' : 'files'} changed in your folder.`
}
export const CHANGES_THROWING = 'Thrown away. You can still undo this for a few seconds.'
export const CHANGES_THROWN = 'Thrown away. Your folder is as it was.'
export const CHANGES_WAITING =
  'The changes are waiting in a copy of your folder. Keep them or throw them away.'
export const CHANGES_NONE = 'It made no changes, so there is nothing to keep.'
export const CHANGES_BUSY = 'Putting the changes in your folder…'
export const CHANGES_UNDONE = 'Your folder is back as it was before the changes.'
export const CHANGES_THROW_UNDONE = 'The changes are back, waiting in the copy.'
export const CHANGES_CONFLICTS =
  'Some files changed in your folder while it worked, so it left them as they are. Choose for each one in Show details.'

// ---- looking at the page ----------------------------------------------------------------------------------------

export const LOOK_TITLE = 'Look it over'
export const LOOK_TEXT =
  'Optional: it looks at a picture of the page and points out what looks wrong. It only looks; it changes nothing.'
export function lookPrivacyText(vendor: string, usd: number | null): string {
  const who = vendor === 'codex' ? 'Codex' : vendor === 'claude' ? 'Claude' : vendor
  const cost =
    usd === null ? '' : usd < 0.01 ? ' It costs less than $0.01.' : ` It costs about ${dollars(usd)}.`
  return `This sends a picture of the page to ${who}.${cost}`
}
export const LOOK_LABEL = 'Look it over'
export const LOOK_NONE = 'Nothing looked wrong.'
export const LOOK_FOUND = 'Things that may look wrong:'
export const FIX_THESE = 'Fix these'
export const LOOK_LOADING = 'Checking whether it can look…'

// ---- several ideas overnight -------------------------------------------------------------------------------------

export const OVERNIGHT_TITLE = 'Make several things overnight'
export const OVERNIGHT_INTRO =
  'Add a few ideas. Each one becomes a new project, made one after another while you are away.'
export const OVERNIGHT_AWAY =
  'While you are away it does not ask questions, stop to show you each plan or look at similar things. Anything that needs your permission still waits for you, and no answer in time means no.'
export const OVERNIGHT_IDEA_LABEL = 'Your idea'
export const OVERNIGHT_IDEA_PLACEHOLDER = 'For example: a landing page for my bakery with our opening hours'
export const OVERNIGHT_ADD = 'Add to the list'
export const OVERNIGHT_ADD_DISABLED = 'Describe the idea first'
export const OVERNIGHT_LIST_TITLE = 'The list'
export const OVERNIGHT_EMPTY = 'Nothing on the list yet.'
export const OVERNIGHT_START_NOW = 'Start now'
export const OVERNIGHT_PAUSE = 'Pause'
export const OVERNIGHT_RUN_LABELS: readonly string[] = [OVERNIGHT_START_NOW, OVERNIGHT_PAUSE]
export const OVERNIGHT_NOTHING_TO_START = 'Add an idea first'
export const OVERNIGHT_TIME_LABEL = 'Or start by itself every day at'
export const OVERNIGHT_SET_TIME = 'Set the time'
export const OVERNIGHT_TIME_INVALID = 'Enter a time like 22:00'
export const OVERNIGHT_TIME_PLACEHOLDER = '22:00'
export const WORDS_KIND = 'Decide from my words'
export function overnightScheduleText(start: string): string {
  return `It starts by itself every day at ${start}, while ${BRAND.displayName} is open. If it was closed then, it asks before it carries on.`
}
export const OVERNIGHT_NO_SCHEDULE = 'No time set: it starts only when you press Start now.'
export const OVERNIGHT_FINISHED = 'Everything on the list has been made. Open each one to see it.'
export const OVERNIGHT_STATE: Readonly<Record<'idle' | 'running' | 'paused', string>> = {
  idle: 'Not started.',
  running: 'Making them one after another.',
  paused: 'Paused.',
}
export const OVERNIGHT_ITEM_STATUS: Readonly<Record<string, string>> = {
  pending: 'Waiting its turn',
  running: 'Being made now',
  waiting: 'Waiting for you',
  blocked: 'Skipped for now',
  done: 'Ready',
  failed: 'Did not finish',
  stopped: 'Stopped',
}
export const OVERNIGHT_REMOVE = 'Remove'
export const OVERNIGHT_OPEN = 'Open'
export const OVERNIGHT_ITEM_LABELS: readonly string[] = [OVERNIGHT_OPEN, OVERNIGHT_REMOVE]
export const OVERNIGHT_CARRY_ON = 'Carry on'
export const OVERNIGHT_NOT_NOW = 'Not now'
export function overnightLimitText(limit: number | null): string {
  return limit === null
    ? 'No spending limit for each project. You can set one in Easy settings.'
    : `Each project stops at ${limitDollars(limit)}.`
}
export const OVERNIGHT_LOADING = 'Reading the list…'

/** What to know about an idea on the overnight list (core's EasyQueueWarning: its kind, a vague idea's candidates). */
export function overnightWarningText(
  kind: string,
  candidates: readonly EasyKind[] = [],
  /** The kind it is made as (absent: the first candidate). */
  madeAs?: EasyKind,
): string {
  if (kind === 'exampleData')
    return 'No data file: it will use example numbers. Add your file afterwards with Make a change.'
  if (kind === 'noResearch') return 'Made without looking at similar games first, since that needs you there.'
  const all: readonly EasyKind[] = candidates.length > 0 ? candidates : ['website', 'app']
  return `Your words could mean ${all.map((k) => KIND_A[k]).join(' or ')}: it is made as ${KIND_A[madeAs ?? all[0] ?? 'app']}. Remove it and pick the kind if that is wrong.`
}

/** "About $1.20 and 15 minutes" for one idea on the list. */
export function overnightEstimateText(
  durationMs: { p50: number; p80: number },
  costUsd: { p50: number; p80: number } | null,
): string {
  const min = Math.max(1, Math.round(durationMs.p80 / 60_000))
  return costUsd === null
    ? `Up to about ${minutesText(min)}`
    : `Up to about ${dollars(Math.max(costUsd.p50, costUsd.p80))} and ${minutesText(min)}`
}

/** The whole list: "Altogether up to about $4.50 and 1 hour 10 minutes" (ideas with no estimate left out). */
export function overnightTotalText(costUsd: number | null, minutes: number, unknown: number): string {
  const base =
    costUsd === null
      ? `Altogether up to about ${minutesText(minutes)}`
      : `Altogether up to about ${dollars(costUsd)} and ${minutesText(minutes)}`
  return unknown > 0 ? `${base}, plus ${unknown} with no estimate yet.` : `${base}.`
}

// ---- settings -------------------------------------------------------------------------------------------------

export const SETTINGS_TITLE = 'Easy settings'
export const SETTINGS_INTRO = 'How Easy mode makes new projects. Everything else is in All settings.'
export const ALL_SETTINGS = 'All settings'
export const PROJECTS_DIR_LABEL = 'Where new projects go'
export const USE_DEFAULT = 'Use the default'
export const NEW_LIMIT_LABEL = 'Spending limit for a new project'
export const CHANGE_LIMIT_LABEL = 'Spending limit for a change'
export const TIME_LIMIT_LABEL = 'Time limit'
export const TIME_LIMIT_INPUT = 'Stop after (minutes of work)'
export const TIME_LIMIT_NOTE = 'Time it spends waiting for you does not count.'
export const NO_TIME_LIMIT = 'No time limit'
export const PLAN_CHECK_LABEL = 'Show me the plan before building'
export const PERMISSIONS_SETTINGS_NOTE = 'Also listed in All settings, under Vendors, Trusted folders.'
export const SAVED = 'Saved'
export const SAVE_LABEL = 'Save'

// ---- a game's play-test -------------------------------------------------------------------------------------------

export const PLAYTESTED_TITLE = 'Play-tested'
export const PLAYTEST_TEXT =
  'Dim Factory played the game by itself, with real key presses, in a hidden window with no internet. Each check below is one thing a player does.'
export const PLAYTEST_NONE =
  'It was not play-tested yet: the game has no playtest.json, or its check did not run. Play-test it again to try.'
export const PLAYTEST_AGAIN = 'Play-test it again'
export const ALLOW_INTERNET = 'Allow internet for this preview'
export const INTERNET_ALLOWED = 'Internet allowed for this preview. Play it or play-test it again.'
/** `hosts`: the first hosts it tried to reach, joined ("a.example, b.example"). */
export function PLAYTEST_BLOCKED(hosts: string): string {
  return `It tried to load something from the internet (${hosts}). Game previews have no internet, so it was blocked: the game should bundle what it needs.`
}
export const SCENARIO_WORDS: Readonly<Record<'pass' | 'fail' | 'error', string>> = {
  pass: 'Works',
  fail: 'Not yet',
  error: 'Not played',
}
/** "Look it over" for a game: two pictures, the title screen and a moment of play. */
export const LOOK_GAME_TEXT =
  'Optional: it looks at two pictures of the game, the title screen and a moment of play, and points out what looks wrong: a hard-to-read score, a play area that does not fit, placeholder art. It only looks; it changes nothing.'
export function lookGamePrivacyText(vendor: string, usd: number | null, photos: boolean): string {
  const who = vendor === 'codex' ? 'Codex' : vendor === 'claude' ? 'Claude' : vendor
  const cost =
    usd === null ? '' : usd < 0.01 ? ' It costs less than $0.01.' : ` It costs about ${dollars(usd)}.`
  const mine = photos ? ' The pictures may show your own photos.' : ''
  return `This sends two pictures of the game to ${who}.${mine}${cost}`
}

/** The confirm screen when a game's idea asks for online multiplayer, which Easy never makes. */
export const ONLINE_TITLE = 'Online multiplayer needs a server you host'
export const ONLINE_NOTE =
  'Easy does not make games that need a server. Choose how people play together instead. (Full mode has an online template for people who host their own server.)'
export const MULTIPLAYER_TEXT: Readonly<Record<EasyMultiplayer, string>> = {
  'pass-and-play': 'Pass and play',
  'play-by-link': 'Play by link',
}
export const MULTIPLAYER_HINT: Readonly<Record<EasyMultiplayer, string>> = {
  'pass-and-play': 'Players take turns on the same device.',
  'play-by-link': 'Each move travels in a link you send to a friend. No server.',
}

// ---- two versions ("Make two and pick") -------------------------------------------------------------------------

export const TWO_LABEL = 'How many'
export const TWO_GROUP_LABEL = 'How many versions'
export const TWO_CHOICES: readonly { value: 'one' | 'two'; label: string; hint: string }[] = [
  { value: 'one', label: 'One', hint: 'One version is made' },
  { value: 'two', label: 'Two, then pick', hint: 'Two versions are made and you keep the one you like' },
]
export const TWO_OFF_LINE = 'One version is made.'
/** What two versions means, for who is ready: one AI each, or the same one twice. */
export function twoOnLine(how: 'pair' | 'twice' | null): string {
  return how === 'pair'
    ? 'Two versions are made, each by a different AI, each in its own copy. You open both and keep one.'
    : 'Two versions are made, each in its own copy. You open both and keep one.'
}
export const TWO_COST_NOTE =
  'That is for one version. Two cost about twice as much, and your limit applies to each one.'
/** The change box: what two versions of a change means and costs. */
export const TWO_CHANGE_ON_LINE =
  'The change is made twice, each in its own copy of your project. You open both and keep one. Two cost about twice as much, and the plan is not shown first.'
export const TWO_HAPPENS_NOTE =
  'With two versions the plan is not shown first, and you may be asked the same thing once for each.'

export const TWO_TITLE_WORKING = 'Making two versions'
export const TWO_TITLE_READY = 'Pick the one you like'
export const TWO_TITLE_PICKED = 'Two versions'
export const TWO_LOADING = 'Loading…'
export const TWO_NOT_OPENED = 'These two versions could not be opened.'
export const TWO_VERSION_LABEL: readonly [string, string] = ['First version', 'Second version']
export const TWO_NEEDS_LABEL: readonly [string, string] = ['For the first version', 'For the second version']

export type TwoState =
  'waiting' | 'working' | 'needsYou' | 'ready' | 'stopped' | 'failed' | 'kept' | 'notKept'
export const TWO_STATE: Readonly<Record<TwoState, string>> = {
  waiting: 'Waiting',
  working: 'Working',
  needsYou: 'Needs you',
  ready: 'Ready',
  stopped: 'Stopped',
  failed: 'Did not finish',
  kept: 'Kept',
  notKept: 'Not kept',
}

export type TwoStatus =
  | 'waiting'
  | 'working'
  | 'needsYou'
  | 'failed'
  | 'ready'
  | 'readyOne'
  | 'readyNone'
  | 'keptFirst'
  | 'keptSecond'
  | 'keptNone'
export const TWO_STATUS: Readonly<Record<TwoStatus, string>> = {
  waiting: 'The second version starts when the first has asked its questions.',
  working: 'Both versions are being made. You can leave this page; they keep going.',
  needsYou: 'Something below needs your answer.',
  failed: 'A version did not finish. Use See this one on it for what happened.',
  ready: 'Both are ready. Open each one, then keep the one you like.',
  readyOne: 'Only one version finished. You can keep it, or keep neither.',
  readyNone: 'Neither version finished. Your project was not changed.',
  keptFirst: 'You kept the first version. It is in your project now.',
  keptSecond: 'You kept the second version. It is in your project now.',
  keptNone: 'You kept neither. Your project was not changed.',
}
export const TWO_KEEP = 'Keep this one'
export const TWO_SEE = 'See this one'
export const TWO_NEITHER = 'Keep neither'
export const TWO_STOP = 'Stop both'
export const TWO_STOP_CONFIRM = 'Stop both versions now? Your project is not changed.'
export const TWO_GO_PROJECT = 'Go to your project'
export const TWO_NO_PICTURE = 'No picture yet'
export const TWO_NO_PICTURE_DONE = 'No picture for this one'
export function twoPictureAlt(version: string): string {
  return `${version}: how its page looked when it loaded`
}
/** Files a kept version could not add (the folder changed meanwhile). */
export function twoConflictsText(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'} could not be added. Show details to see which.`
}
/** A side's run page while it is one of two: where the choice is made. */
export const TWO_POINTER_TITLE = 'This is one of two versions'
export const TWO_POINTER_TEXT = 'Both are shown together. That is where you open them and keep one.'
export const TWO_POINTER_GO = 'See both versions'
