// The prompt check: what a task leaves out, said before anything is spent. No model call and nothing random: the
// task's words, the kind of folder it runs in (new, a project, or only data) and the recipe. It returns at most three
// hints, each naming what might be missing and what to add. A hint never blocks a run, and length alone never makes
// one ("Rename getUser to fetchUser" is short and exact). These are heuristics: the wording says "might", and the rules
// lean toward saying nothing. Pure and shared: core answers `task.check` with it, and Easy reads it for its idea box.

export const PROMPT_HINT_KINDS = [
  'blanks',
  'no-target',
  'loose',
  'bug-parts',
  'new-parts',
  'no-outcome',
  'several-jobs',
] as const
export type PromptHintKind = (typeof PROMPT_HINT_KINDS)[number]

export interface PromptHint {
  kind: PromptHintKind
  /** What might be missing, as one sentence (no em dashes). */
  text: string
  /** What to add, as one sentence, with an example where one helps. */
  add: string
}

/** The folder as a run would find it: nothing yet, a project, or only data and documents to work on. */
export type PromptFolder = 'new' | 'project' | 'data'

export interface PromptCheckInput {
  task: string
  folder: PromptFolder
  /** The recipe's id (absent: none). */
  recipe?: string | undefined
}

/** Who would answer "Sharpen it", and about what the one call costs. */
export interface PromptSharpenHelper {
  vendor: string
  model: string | null
  usd: number | null
}

/** `task.check`: the hints for a task as typed, and who could sharpen it (asked only when there is a hint). */
export interface PromptCheckView {
  hints: PromptHint[]
  sharpen: PromptSharpenHelper | null
  /** Why nobody can sharpen it (UI copy), when `sharpen` is null and there are hints. */
  sharpenReason?: string
}

/** `task.sharpen`: the task rewritten for the person to accept, edit or ignore. */
export interface PromptSharpened {
  task: string
  vendor: string
}

/** The most hints one check returns. */
export const PROMPT_HINTS_MAX = 3
/** A task longer than this many words has said enough for the word rules to stay quiet. */
export const PROMPT_LONG_WORDS = 60
/** The longest task "Sharpen it" takes and the longest it may send back, in characters. */
export const PROMPT_SHARPEN_MAX = 4000
/** The most [question?] blanks a sharpened task may carry. */
export const PROMPT_SHARPEN_BLANKS = 4

/** The recipes whose parts the check knows. */
export const BUG_FIX_RECIPE = 'bug-fix'
export const NEW_APP_RECIPE = 'new-web-app'

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter((w) => w !== ''))

/** Words that carry no content of their own. */
const STOP =
  set(`a an the this that these those it its i we you me my our your us to of in on at for with and or but so
  is are was be been do does did can could would should will please just some any all more very really bit little lot
  also too there here up out as by from into if then than not no have has need needs want like i'd i'm it's let's get
  got hi hello hey thanks thank now when how what which where about them they their one`)

/** Things on a screen or in a code base that need a name before they say where ("the button" could be any button). */
const PLACE = set(`page screen button form menu table chart dialog modal tab field column row endpoint
  command function method class component test script file module section link list view route flag option setting
  panel card popup dropdown input label icon image title heading message email report query hook
  service model schema job workflow pipeline step bar box`)

/** Words every task could use: an ask made only of these names nothing. */
const GENERIC =
  set(`fix fixes fixing improve improved improvement improvements clean cleanup tidy optimize optimise
  refactor update change changes make makes polish enhance review check debug finish complete work working works add
  remove handle sort look looks help try build create write implement test tests tweak adjust rework redo modernize
  simplify speed bug bugs issue issues problem problems error errors thing things stuff everything something anything
  code codebase app application site website project program repo repository ui ux design style styles styling layout
  performance feature features functionality better nicer faster cleaner good great nice best properly correctly right
  well modern professional quality broken bad slow ugly wrong weird quick quickly simple easier`)

/** Parts of a project that are a place by themselves ("Update the README" says where). */
const AREA =
  set(`readme changelog license licence navbar sidebar header footer toolbar banner logo dashboard homepage login signup checkout cart search
  settings profile onboarding api database db cli docs documentation ci dockerfile dependencies deps packages lockfile
  linter lint eslint prettier typos typecheck tsconfig makefile sitemap favicon i18n translations analytics auth
  authentication navigation`)

const singular = (w: string): string => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)
const isPlace = (w: string): boolean => PLACE.has(w) || PLACE.has(singular(w))
const isFiller = (w: string): boolean => STOP.has(w) || GENERIC.has(w) || isPlace(w)

/** The task's words, lower case (letters or digits in a run). */
export function promptWords(task: string): string[] {
  return (task.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).map((w) => w.replace(/’/g, "'"))
}

/** The words that say something: not a stop word, not a word every task could use, not a bare place. */
export function informativeWords(task: string): string[] {
  return promptWords(task).filter((w) => !isFiller(w) && !AREA.has(w))
}

/** Text that names a place by its form: a file, a path, an identifier, a flag, quoted text, a URL, a version, a code. */
const NAMED: readonly RegExp[] = [
  // a file name (index.html, app.test.ts) or a version (2.0.1, v3.2)
  /(?<![\p{L}\p{N}])[\w-]{2,}\.[A-Za-z][A-Za-z0-9]{1,5}(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}.])v?\d+\.\d+/u,
  // a path (src/auth, docs\guide)
  /[\w.-]+[\\/][\w.-]+/,
  // an identifier: camelCase, PascalCase with two humps, snake_case, a call, a flag, an issue number
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Za-z]+_[A-Za-z0-9_]+\b/,
  /\b\w+\(\)/,
  /(?<![\w-])--?[A-Za-z][\w-]*/,
  /(?<!\w)#\d+\b/,
  // quoted text
  /"[^"\n]{2,}"|“[^”\n]{2,}”|`[^`\n]+`/,
  /(?<![\p{L}\p{N}])'[^'\n]{2,}'(?![\p{L}\p{N}])/u,
  // a URL or a route
  /https?:\/\/\S+/i,
  /(?:^|\s)\/[A-Za-z][\w/-]*/,
  // a status code, an error code
  /\b[45]\d\d\b/,
  /\b(?:TS|ERR_?|E)\d{2,}\b/,
  // what a check run names by itself
  /\b(?:failing|flaky|skipped)\s+(?:tests?|builds?|checks?|ci|pipeline)\b/i,
  /\b(?:type|lint|build|compile|compiler|typecheck|console)\s+(?:errors?|warnings?)\b/i,
]

/** Whether the task names where it applies: by form (a file, quoted text...), a part of a project, or a named place. */
export function namesTarget(task: string): boolean {
  if (NAMED.some((r) => r.test(task))) return true
  const words = promptWords(task)
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (AREA.has(w)) return true
    // "the settings page", "login button": a place with a word before it that says which.
    const before = i > 0 ? (words[i - 1] as string) : undefined
    if (isPlace(w) && before !== undefined && !isFiller(before)) return true
  }
  return false
}

/** The first bare place the task points at with "the", "this" or "that" ("the button"), or undefined. */
export function loosePlace(task: string): string | undefined {
  const m = /\b(the|this|that)\s+([\p{L}]+)\b/giu
  for (const hit of task.matchAll(m)) {
    const noun = (hit[2] as string).toLowerCase()
    if (isPlace(noun)) return `${(hit[1] as string).toLowerCase()} ${noun}`
  }
  return undefined
}

/** A task that opens by doing something to "it" ("Make it faster"). */
const LEADING_IT = /^\W*(?:(?:please|pls|can you|could you)\s+)*\p{L}+\s+it\b/iu

/** A verb that says something should change, not what it should become. */
const VAGUE_VERB =
  /\b(?:improve|optimi[sz]e|refactor|clean\s*up|tidy(?:\s+up)?|polish|enhance|rework|redesign|revamp|moderni[sz]e|simplify|tweak|adjust|speed\s+up|update|change)\b/i
const MAKE_BETTER =
  /\bmake\b[^.\n]{0,40}\b(?:better|nicer|faster|cleaner|prettier|simpler|good|great|modern|professional|pop|work)\b/i
/** Anything that reads as an end state: a goal, a condition, a number, a list, quoted text. */
const OUTCOME =
  /\b(?:so|should|must|needs?|until|instead|when|whenever|if|after|to|into|from|with|without|under|below|above|least|most|than|like|using|use|by|because|since|example)\b|e\.g|i\.e|\d|[:;]|["“`]/i
/** Updates whose end state is understood ("Update dependencies"). */
const UNDERSTOOD_UPDATE =
  /\b(?:update|upgrade|bump)\s+(?:the\s+|all\s+|our\s+)?(?:dependenc\w+|deps|packages?|lockfile|versions?)\b/i

/** A bug report's parts: how to make it happen, and what should happen instead. */
const REPRO =
  /\b(?:when|whenever|after|if|while|steps?|reproduce|repro|click\w*|press\w*|tap\w*|open\w*|run\w*|type\w*|submit\w*|load\w*|sav\w+|every time|sometimes|always|on\s+\p{L}+)\b/iu
const EXPECTED =
  /\b(?:should|expected?|instead|supposed|must|want|needs?\s+to|correct(?:ly)?|rather\s+than|ought)\b/i

/** A new thing's parts: who it is for, and what they can do with it. */
const AUDIENCE =
  /\b(?:for|users?|customers?|clients?|visitors?|people|someone|anyone|everyone|kids|children|students|teachers?|teams?|players?|family|friends|readers?|members?|guests?|staff|beginners?|parents?|my|our)\b/i
const CAPABILITY =
  /\b(?:can|could|lets?|allow\w*|able|where|which|with|so|should|must|that\s+(?:lets?|can|will|shows?|tracks?|helps?))\b|\bto\s+(?!make\b|build\b|create\b|have\b|get\b|do\b|be\b)\p{L}+/iu

/** Words that add one more job to a task. */
const ALSO =
  /\b(?:also|plus|additionally|another\s+thing|while\s+you(?:'|’)?re\s+at\s+it|on\s+top\s+of\s+that|as\s+well)\b/gi

/** A blank "Sharpen it" left for the person: a short question in square brackets. */
const BLANK = /\[[^[\]\n]{1,80}\?\]/

export const PROMPT_HINT_TEXT = {
  blanks: {
    text: 'The task still has parts in [brackets] to fill in.',
    add: 'Replace each one with your own words, or delete it.',
  },
  noTarget: {
    text: 'This might not say where the change goes.',
    add: 'Name the page, file or function, or quote the text you see on screen.',
  },
  loosePlace: (phrase: string) => ({
    text: `"${phrase}" could mean more than one thing here.`,
    add: 'Say which one, for example by the words on it or the page it is on.',
  }),
  looseIt: {
    text: '"it" might not be clear.',
    add: 'Say which page, file or part you mean.',
  },
  bugParts: (missing: readonly string[]) => ({
    text: `A bug fix goes best with three things, and this might be missing ${missing.join(' and ')}.`,
    add: 'For example: when I save an empty form it shows a blank page, and it should show a message.',
  }),
  newParts: {
    text: 'This might not say who it is for or what they can do with it.',
    add: 'For example: a booking page for my salon, where customers pick a time and get an email.',
  },
  noOutcome: {
    text: 'This might not say what should be true when it is done.',
    add: 'Add how you would check it, for example: the list loads in under a second.',
  },
  severalJobs: {
    text: 'This reads as several separate jobs.',
    add: 'One job per run is easier to check and to undo. The queue can run the others.',
  },
} as const

export const BUG_PART_REPRO = 'how to make it happen'
export const BUG_PART_EXPECTED = 'what should happen instead'

/** The hints for a task, most useful first, at most PROMPT_HINTS_MAX. An empty task has none. */
export function checkPrompt(i: PromptCheckInput): PromptHint[] {
  const task = i.task
  const words = promptWords(task)
  if (words.length === 0) return []
  const out: PromptHint[] = []
  const push = (kind: PromptHintKind, h: { text: string; add: string }): void => {
    out.push({ kind, text: h.text, add: h.add })
  }
  const short = words.length <= PROMPT_LONG_WORDS
  const named = namesTarget(task)

  if (BLANK.test(task)) push('blanks', PROMPT_HINT_TEXT.blanks)

  if (i.folder === 'project' && short && !named) {
    const informative = informativeWords(task).length
    if (informative <= 1) push('no-target', PROMPT_HINT_TEXT.noTarget)
    else {
      const place = loosePlace(task)
      if (place !== undefined) push('loose', PROMPT_HINT_TEXT.loosePlace(place))
      else if (informative <= 2 && LEADING_IT.test(task)) push('loose', PROMPT_HINT_TEXT.looseIt)
    }
  }

  if (i.recipe === BUG_FIX_RECIPE) {
    const missing = [
      ...(REPRO.test(task) ? [] : [BUG_PART_REPRO]),
      ...(EXPECTED.test(task) ? [] : [BUG_PART_EXPECTED]),
    ]
    if (missing.length > 0) push('bug-parts', PROMPT_HINT_TEXT.bugParts(missing))
  }

  const newThing = i.recipe === NEW_APP_RECIPE || (i.folder === 'new' && i.recipe === undefined)
  if (newThing && short && !AUDIENCE.test(task) && !CAPABILITY.test(task)) {
    push('new-parts', PROMPT_HINT_TEXT.newParts)
  }

  if (
    i.folder !== 'new' &&
    short &&
    (VAGUE_VERB.test(task) || MAKE_BETTER.test(task)) &&
    !OUTCOME.test(task) &&
    !UNDERSTOOD_UPDATE.test(task)
  ) {
    push('no-outcome', PROMPT_HINT_TEXT.noOutcome)
  }

  if ((task.match(ALSO) ?? []).length >= 2) push('several-jobs', PROMPT_HINT_TEXT.severalJobs)

  return out.slice(0, PROMPT_HINTS_MAX)
}

/** One hint as the line under the task box reads it. */
export function promptHintLine(h: PromptHint): string {
  return `${h.text} ${h.add}`
}

/** What the composer's line says: the first hint, and how many more there are. */
export function promptCheckLine(hints: readonly PromptHint[]): string {
  const first = hints[0]
  if (first === undefined) return ''
  const more = hints.length - 1
  return more > 0 ? `${promptHintLine(first)} (${more} more)` : promptHintLine(first)
}

/** The same hints, whatever their wording: what a dismissal remembers. */
export function promptHintsKey(hints: readonly PromptHint[]): string {
  return hints.map((h) => h.kind).join(',')
}
