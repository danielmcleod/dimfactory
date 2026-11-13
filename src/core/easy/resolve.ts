// Easy mode's idea resolver, pure: what kind of thing an idea asks for (Easy's own words first, then the Brief's
// category detection), which template makes it (a website or app: React when Node.js is ready, else plain HTML; every
// other kind: one that needs nothing installed unless the idea asks for a toolchain that is there), the project
// folder's name (from the idea) and a free folder for it, and the run's task. Local only: no tokens, no network,
// nothing created.
import { join } from 'node:path'
import type { BriefInput, Pack } from '../../shared/brief.ts'
import { EASY_SLUG_MAX, EASY_WEB_KINDS, isEasyPhotoName } from '../../shared/easy.ts'
import type { EasyKind, EasyMultiplayer, EasyStack, EasyToolchain } from '../../shared/easy.ts'
import type { Template } from '../../shared/templates.ts'
import { OUTLINE_INTRO, SCAFFOLD_EXISTING_NOTE, templateBrief } from '../../shared/templates.ts'
import { detectCategory, keywordFields } from '../brief/detect.ts'

// ---- kind -------------------------------------------------------------------------------------------------------

/** A whole-word, any-case phrase (letters and digits around it do not count as a match). */
function phrase(p: string): RegExp {
  const body = p
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\s-]+/g, '[\\s-]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}

const words = (...ps: string[]): RegExp[] => ps.map(phrase)

/** Something an idea is tested against: a phrase, or a rule over the whole idea. */
interface IdeaTest {
  test(idea: string): boolean
}

type KindWords = readonly (readonly [EasyKind, readonly IdeaTest[]])[]

/**
 * Words that say the idea is about numbers or a data file. "Chart" and "report from" mean a data report only alongside
 * one of them: "a chore chart", "a seating chart" and "a report from our school trip" are not data reports.
 */
const DATA_CONTEXT: readonly RegExp[] = words(
  'data',
  'csv',
  'spreadsheet',
  'spreadsheets',
  'excel',
  'xlsx',
  'numbers',
  'figures',
  'sales',
  'revenue',
  'income',
  'expenses',
  'budget',
  'statistics',
  'stats',
  'metrics',
  'kpi',
  'kpis',
  'survey results',
  'totals',
  'trend',
  'trends',
  'per month',
  'monthly',
  'over time',
)

/** A phrase that counts only when the idea also has a data word. */
function withData(...ps: string[]): IdeaTest {
  const own = words(...ps)
  return { test: (idea) => own.some((w) => w.test(idea)) && DATA_CONTEXT.some((w) => w.test(idea)) }
}

/** A word in a script with no spaces between words (Chinese, Japanese): matched anywhere in the idea. */
const anywhere = (...ps: string[]): RegExp[] =>
  ps.map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))

/**
 * Easy's own words for each kind, in two tiers checked in order: telling phrases first ("landing page", "help guide",
 * "csv", "checklist"), then single words that also turn up in other requests ("guide", "report", "site"). Within a
 * tier the kinds go data, research, checklist, document, game, website, app. The first match wins.
 */
const TELLING: KindWords = [
  [
    'data',
    [
      ...words('csv', 'spreadsheet', 'spreadsheets', 'excel', 'xlsx', 'dataset', 'data set', 'data report'),
      withData('report from'),
    ],
  ],
  [
    'research',
    words(
      'research memo',
      'decision memo',
      'pros and cons',
      'which is better',
      'compare',
      'comparing',
      'comparison',
    ),
  ],
  [
    'checklist',
    words(
      'checklist',
      'check list',
      'runbook',
      'step by step',
      'chore chart',
      'chore list',
      'packing list',
      'to do list',
      'todo list',
    ),
  ],
  [
    'document',
    words(
      'help site',
      'help guide',
      'help pages',
      'user guide',
      'documentation',
      'docs site',
      'handbook',
      'manual',
      'tutorial',
      'faq',
    ),
  ],
  [
    'game',
    words(
      'game',
      'games',
      'quiz',
      'trivia',
      'puzzle',
      'platformer',
      'arcade',
      'sudoku',
      'crossword',
      'word search',
      'hangman',
      'solitaire',
      'tic tac toe',
      'chess',
      'checkers',
      'escape room',
      'text adventure',
      'choose your own adventure',
      'interactive fiction',
      '3d maze',
      'marble run',
      'marble maze',
      'marble game',
    ),
  ],
  ['website', words('landing page', 'website', 'web site', 'homepage', 'home page', 'portfolio')],
  ['app', words('app', 'calculator', 'tracker', 'splitter', 'timer', 'planner', 'converter', 'generator')],
]

const SINGLE: KindWords = [
  [
    'data',
    [
      ...words('trends', 'statistics', 'my data', 'sales data'),
      withData('chart', 'charts', 'graph', 'graphs'),
    ],
  ],
  [
    'research',
    [
      ...words('research', 'memo', 'should i', 'should we', 'evaluate', 'alternatives to', 'recommendation'),
      /\bwhich\b[^.?!]*\bshould\b/i,
    ],
  ],
  ['checklist', words('procedure', 'routine', 'sop', 'chores')],
  [
    'document',
    words('guide', 'docs', 'how to', 'ebook', 'article', 'newsletter', 'report', 'essay', 'proposal'),
  ],
  ['website', words('site', 'blog', 'one page', 'web page', 'webpage')],
  ['app', words('application', 'tool', 'dashboard')],
]

/**
 * The main kinds in other languages (Spanish, French, German, Portuguese, Italian, then Chinese and Japanese), checked
 * last: an idea written in one of them still gets its kind (and is made in its language, as the prompts ask).
 */
const OTHER_LANGUAGES: KindWords = [
  [
    'data',
    [
      ...words(
        'hoja de cálculo',
        'informe de datos',
        'tableur',
        'rapport de données',
        'tabellenkalkulation',
        'datenbericht',
        'planilha',
        'relatório de dados',
        'foglio di calcolo',
        'rapporto dati',
      ),
      ...anywhere('电子表格', '数据报告', 'スプレッドシート', 'データレポート'),
    ],
  ],
  [
    'research',
    [
      ...words('comparar', 'comparación', 'comparer', 'comparaison', 'vergleich', 'vergleichen', 'confronto'),
      ...anywhere('比较', '比較'),
    ],
  ],
  [
    'checklist',
    [
      ...words(
        'lista de verificación',
        'lista de control',
        'liste de contrôle',
        'checkliste',
        'lista de verificação',
        'lista di controllo',
      ),
      ...anywhere('清单', 'チェックリスト'),
    ],
  ],
  [
    'document',
    [
      ...words('guía', 'manual', 'mode d’emploi', 'anleitung', 'handbuch', 'leitfaden', 'guia', 'guida'),
      ...anywhere('指南', '手册', 'ガイド', 'マニュアル'),
    ],
  ],
  ['game', [...words('juego', 'jeu', 'spiel', 'jogo', 'gioco'), ...anywhere('游戏', '遊戲', 'ゲーム')]],
  [
    'website',
    [
      ...words('sitio web', 'página web', 'site web', 'site internet', 'webseite', 'sito web'),
      ...anywhere('网站', '網站', 'ウェブサイト', 'ホームページ'),
    ],
  ],
  [
    'app',
    [
      ...words('aplicación', 'aplicativo', 'anwendung', 'applicazione'),
      ...anywhere('应用', '應用', 'アプリ'),
    ],
  ],
]

/** The tiers in the order they are checked. */
const KIND_TIERS: readonly KindWords[] = [TELLING, SINGLE, OTHER_LANGUAGES]

/** Every kind's words, telling phrases first (the order detectKind checks them in). */
export const KIND_WORDS: KindWords = KIND_TIERS.flat()

/** The kind of a pack the Brief detected (the fallback when Easy's own words name none). */
const PACK_KIND: Readonly<Record<string, EasyKind>> = {
  software: 'app',
  design: 'website',
  documents: 'document',
  data: 'data',
  'research-writing': 'research',
  operations: 'checklist',
  games: 'game',
}

export interface KindGuess {
  kind: EasyKind
  source: 'words' | 'default'
}

/**
 * The kind the Brief's category detection finds (undefined: none). Its data pack also counts "chart", "graph", "plot"
 * and "report": on their own those are not a data report (a seating chart, a trip report), so data needs one of the
 * data words too.
 */
function packKind(idea: string, packs: readonly Pack[]): EasyKind | undefined {
  const guess = detectCategory(idea, null, packs)
  const kind = PACK_KIND[guess.id]
  if (guess.source === 'default' || kind === undefined) return undefined
  if (kind === 'data' && !DATA_CONTEXT.some((w) => w.test(idea)) && !STRONG_DATA.some((w) => w.test(idea)))
    return undefined
  return kind
}

/** The data pack's words that mean a data report by themselves (its weak ones: chart, graph, plot, report). */
const STRONG_DATA: readonly RegExp[] = words(
  'dataset',
  'pandas',
  'notebook',
  'jupyter',
  'sql query',
  'forecast',
  'regression',
  'pivot table',
  'analysis',
  'analyze',
  'analyse',
  'visualize',
  'visualise',
  'visualization',
  'visualisation',
)

/** The kind an idea asks for: Easy's words, else the Brief's category detection, else an app. */
export function detectKind(idea: string, packs: readonly Pack[]): KindGuess {
  for (const [kind, words] of KIND_WORDS)
    if (words.some((w) => w.test(idea))) return { kind, source: 'words' }
  const kind = packKind(idea, packs)
  if (kind !== undefined) return { kind, source: 'words' }
  return { kind: 'app', source: 'default' }
}

/** What Easy asks a vague idea about when nothing in it points anywhere: the classic "a website or an app?". */
export const VAGUE_CANDIDATES: readonly EasyKind[] = ['website', 'app']

/**
 * The kinds a vague idea could mean, in order (empty: it is clear enough). Vague: the first tier of Easy's words that
 * matches names more than one kind ("a website for my app"), or nothing matches at all and the Brief's detection finds
 * no category either ("something for my bakery"). detectKind's answer is always one of them.
 */
export function ambiguousKinds(idea: string, packs: readonly Pack[]): EasyKind[] {
  for (const tier of KIND_TIERS) {
    const hits = tier.filter(([, ws]) => ws.some((w) => w.test(idea))).map(([k]) => k)
    const kinds = [...new Set(hits)]
    if (kinds.length === 0) continue
    return kinds.length > 1 ? kinds : []
  }
  if (packKind(idea, packs) !== undefined) return []
  // detectKind guesses an app here; the question puts the website first, as people usually ask it.
  return [...VAGUE_CANDIDATES]
}

// ---- template ---------------------------------------------------------------------------------------------------

/**
 * The template each kind starts from when the idea asks for nothing else and nothing is installed. A website or app
 * starts from React instead when Node.js is ready (REACT_TEMPLATE); these plain HTML ones are its "no build step"
 * option and what it is made with without Node.js.
 */
export const KIND_TEMPLATE: Readonly<Record<EasyKind, string>> = {
  app: 'static-site',
  website: 'static-site',
  document: 'docs-simple',
  data: 'data-report-web',
  research: 'explainer-memo',
  checklist: 'checklist',
  game: 'game-canvas',
}

/** A research memo that weighs options and recommends one (a question about choosing). */
export const DECISION_MEMO_TEMPLATE = 'decision-memo'
/**
 * Words that ask to choose between things: the research memo compares the options and recommends one. Without them it
 * explains the topic instead (a scored decision memo answers a question nobody asked).
 */
const RECOMMEND_WORDS: readonly IdeaTest[] = [
  ...words(
    'recommend',
    'recommendation',
    'which is better',
    'which one',
    'should i',
    'should we',
    'compare',
    'comparing',
    'comparison',
    'pros and cons',
    'versus',
    'vs',
    'decide',
    'decision',
    'choose',
    'choosing',
    'pick the best',
    'best option',
    'best way',
    'alternatives',
    'options for',
    'ways to',
  ),
  /\bwhich\b[^.?!]*\b(?:should|better|best)\b/i,
]

/** The operations runbook (services, deploys, roll-backs): for an idea about servers, never a person's checklist. */
export const RUNBOOK_TEMPLATE = 'runbook'
/** Words that make a checklist an operations runbook. */
const RUNBOOK_WORDS: readonly RegExp[] = words(
  'runbook',
  'server',
  'servers',
  'deploy',
  'deploys',
  'deployment',
  'roll back',
  'rollback',
  'incident',
  'incidents',
  'on call',
  'outage',
  'production',
  'kubernetes',
  'database backup',
  'restart the service',
)

/** The template of a checklist (a printable page with ticks) or a research memo (explain, or recommend). */
function plainTemplate(kind: EasyKind, idea: string): string | undefined {
  if (kind === 'checklist') return RUNBOOK_WORDS.some((w) => w.test(idea)) ? RUNBOOK_TEMPLATE : undefined
  if (kind === 'research')
    return RECOMMEND_WORDS.some((w) => w.test(idea)) ? DECISION_MEMO_TEMPLATE : undefined
  return undefined
}

const LANDING = [
  'landing page',
  'one page',
  'single page',
  'sign up',
  'signup',
  'waitlist',
  'coming soon',
].map(phrase)

/** The React templates (Vite, from a working starter) a website or app starts from when Node.js is ready. */
export const REACT_TEMPLATE = 'react-site'
export const REACT_LANDING_TEMPLATE = 'landing-react'
/** The plain HTML landing page (no build step). */
export const HTML_LANDING_TEMPLATE = 'landing-page'
/** Words that ask for React (or its tools) by name. */
const REACT_WORDS: readonly RegExp[] = ['react', 'vite', 'typescript', 'jsx'].map(phrase)
/** Words that ask for plain HTML: the website or app is made with no build step even when Node.js is ready. */
const HTML_WORDS: readonly RegExp[] = [
  'plain html',
  'html and css',
  'html only',
  'just html',
  'no build step',
  'no build',
  'no framework',
  'without a framework',
  'vanilla javascript',
  'vanilla js',
].map(phrase)

/**
 * How a website or app is built (undefined for every other kind): React when Node.js is ready, unless the user picked
 * plain HTML or the idea asks for it; plain HTML without Node.js (or with one too old for Vite), whatever was asked.
 */
export function chooseStack(
  kind: EasyKind,
  idea: string,
  toolchain: EasyToolchain,
  chosen?: EasyStack,
): { chosen: EasyStack; react: boolean } | undefined {
  if (!EASY_WEB_KINDS.includes(kind)) return undefined
  if (!toolchain.node) return { chosen: 'html', react: false }
  const wantsHtml = HTML_WORDS.some((w) => w.test(idea)) && !REACT_WORDS.some((w) => w.test(idea))
  return { chosen: chosen ?? (wantsHtml ? 'html' : 'react'), react: true }
}

/** The light 3D game template (three.js, installed into the project with npm). */
export const GAME_3D_TEMPLATE = 'game-3d-lite'
/** Words that ask for a game in 3D. */
const GAME_3D_WORDS: readonly RegExp[] = [
  '3d',
  'three.js',
  'threejs',
  'three js',
  'webgl',
  'marble',
  'marbles',
].map(phrase)

/** A template that needs a toolchain, chosen only when the idea asks for it by name and the toolchain is there. */
const TOOLCHAIN_ASKS: readonly {
  kind: EasyKind
  words: readonly RegExp[]
  template: string
  needs: 'node' | 'python'
  /** The template started instead when the toolchain is missing (default: the one the idea would get anyway). */
  instead?: string
}[] = [
  {
    kind: 'document',
    words: ['vitepress', 'docs site', 'documentation site'].map(phrase),
    template: 'docs-site',
    needs: 'node',
  },
  {
    kind: 'data',
    words: ['python', 'pandas', 'jupyter', 'notebook'].map(phrase),
    template: 'data-report',
    needs: 'python',
  },
  // A light 3D game installs three.js into the project with npm (Dim Factory never bundles it), so it needs Node.js;
  // without it the game is made in 2D, on a canvas (its nearest flat form). Checked before Vite: "a 3D game in
  // TypeScript" is a 3D game first.
  {
    kind: 'game',
    words: GAME_3D_WORDS,
    template: GAME_3D_TEMPLATE,
    needs: 'node',
    instead: KIND_TEMPLATE.game,
  },
  { kind: 'game', words: ['vite', 'typescript'].map(phrase), template: 'game-vite', needs: 'node' },
]

export interface TemplateChoice {
  templateId: string
  /** The idea asked for a toolchain template whose toolchain is missing: it and what it needs. */
  fallback?: { wanted: string; needs: 'node' | 'python' }
}

/**
 * A game's families of words and the template each starts from: a grid of buttons for boards, puzzles, words, cards
 * and memory games; a story or a quiz told as data; anything else is an arcade game on a canvas.
 */
const GAME_FAMILIES: readonly { template: string; words: readonly RegExp[] }[] = [
  {
    template: 'game-board',
    words: [
      'board',
      'puzzle',
      'puzzles',
      'word',
      'words',
      'card',
      'cards',
      'memory',
      'matching',
      'pairs',
      'sudoku',
      'crossword',
      'hangman',
      'solitaire',
      'tic tac toe',
      'chess',
      'checkers',
      'connect four',
      'tiles',
      'grid',
    ].map(phrase),
  },
  {
    template: 'game-tool',
    words: [
      'dice',
      'dice roller',
      'scorekeeper',
      'score keeper',
      'scoreboard',
      'initiative',
      'tracker',
      'bracket',
      'brackets',
      'tournament',
      'name generator',
      'team picker',
    ].map(phrase),
  },
  {
    template: 'game-phaser',
    words: [
      'platformer',
      'platform game',
      'jump and run',
      'side scroller',
      'top down',
      'dungeon crawler',
    ].map(phrase),
  },
  {
    template: 'game-story',
    words: [
      'story',
      'stories',
      'adventure',
      'quiz',
      'quizzes',
      'trivia',
      'interactive fiction',
      'escape room',
      'choose your own',
    ].map(phrase),
  },
]

/** Where in the idea a family is first named (Infinity: not at all). */
function firstMention(idea: string, words: readonly RegExp[]): number {
  let at = Number.POSITIVE_INFINITY
  for (const w of words) {
    const m = w.exec(idea)
    if (m !== null && m.index < at) at = m.index
  }
  return at
}

/** A game's template: the family the idea names first (a board family on a tie), else the arcade canvas. */
export function gameTemplate(idea: string): string {
  let best: { template: string; at: number } | null = null
  for (const f of GAME_FAMILIES) {
    const at = firstMention(idea, f.words)
    if (at !== Number.POSITIVE_INFINITY && (best === null || at < best.at))
      best = { template: f.template, at }
  }
  return best?.template ?? KIND_TEMPLATE.game
}

/**
 * The template for a kind and an idea, given what is installed and, for a website or app, how the user chose to build
 * it (`stack`; absent: React when Node.js is ready). An idea that asks for React by name while Node.js is not ready
 * gets the plain HTML template with a `fallback` that says why.
 */
export function chooseTemplate(
  kind: EasyKind,
  idea: string,
  toolchain: EasyToolchain,
  stack?: EasyStack,
): TemplateChoice {
  const landing = kind === 'website' && LANDING.some((w) => w.test(idea))
  const web = chooseStack(kind, idea, toolchain, stack)
  if (web !== undefined) {
    if (web.chosen === 'react') return { templateId: landing ? REACT_LANDING_TEMPLATE : REACT_TEMPLATE }
    const html = landing ? HTML_LANDING_TEMPLATE : KIND_TEMPLATE[kind]
    if (!web.react && REACT_WORDS.some((w) => w.test(idea)))
      return { templateId: html, fallback: { wanted: REACT_TEMPLATE, needs: 'node' } }
    return { templateId: html }
  }
  const base = kind === 'game' ? gameTemplate(idea) : (plainTemplate(kind, idea) ?? KIND_TEMPLATE[kind])
  const ask = TOOLCHAIN_ASKS.find((a) => a.kind === kind && a.words.some((w) => w.test(idea)))
  if (ask === undefined) return { templateId: base }
  if (toolchain[ask.needs]) return { templateId: ask.template }
  return { templateId: ask.instead ?? base, fallback: { wanted: ask.template, needs: ask.needs } }
}

// ---- online play (never in Easy) -----------------------------------------------------------------------------------

/** Words that ask for online multiplayer: people playing together from different computers, through a server. */
const ONLINE_WORDS: readonly RegExp[] = [
  ...[
    'online multiplayer',
    'multiplayer online',
    'real time multiplayer',
    'realtime multiplayer',
    'over the internet',
    'game server',
    'multiplayer server',
    'mmo',
    'mmorpg',
    'matchmaking',
    'online lobby',
    'online pvp',
  ].map(phrase),
  /\bonline\b[^.?!\n]*\b(?:multiplayer|friends|other players|opponents?|strangers)\b/i,
  /\b(?:multiplayer|friends|other players|opponents?)\b[^.?!\n]*\bonline\b/i,
]

/**
 * The idea asks for online multiplayer. Easy never makes it (it needs a server you host, which the Full-mode template
 * "Online multiplayer game" sets up): the game is made for pass and play on one device, or play by link, instead.
 */
export function asksOnlinePlay(idea: string): boolean {
  return ONLINE_WORDS.some((w) => w.test(idea))
}

/** What Easy offers instead of online play: play by link when the idea talks of sending it, else pass and play. */
export function onlineInstead(idea: string): EasyMultiplayer {
  return /\b(?:link|send|sending|email|text it)\b/i.test(idea) ? 'play-by-link' : 'pass-and-play'
}

/** The task's note for a game whose idea asked for online play (Easy makes it `instead`, with no server). */
export function onlineNote(instead: EasyMultiplayer): string {
  const how =
    instead === 'play-by-link'
      ? "play by link: the game's state travels in a link players send each other (checked like any untrusted input), with no server"
      : 'pass and play: players take turns on the same device'
  return `Online multiplayer is not part of this project: it needs a server you host, which Easy does not make. Make it ${how}. No server, no WebSockets and no network code.`
}

// ---- a game's Brief ---------------------------------------------------------------------------------------------

/** The Games pack's look that means the user's own photos. */
export const MY_PHOTOS = 'my-photos'
const ART_STYLE = 'artStyle'
/** The Games pack's players group and its online option, and the deliverable that is a game server (never in Easy). */
const PLAYERS = 'players'
const ONLINE = 'online'
const DELIVERABLE = 'deliverable'
const GAME_SERVER = 'game-server'
/** The Games pack's "Built with" group. */
const ENGINE = 'engine'

/**
 * The Brief a new project starts with. For a game, the idea's own words refine the template's choices (the Brief's
 * keyword rules over the Games pack: "two players" picks the players, "on my phone" adds the platform; a single-choice
 * group takes the idea's choice, a multi-choice group gets it added), and added photos make its look "My photos". Online
 * play is never chosen: an idea that asks for it gets `multiplayer` (pass and play, or play by link) instead, and a game
 * server is never its deliverable. What the game is built with stays the template's choice. Every other kind keeps the
 * template's Brief as it is.
 */
export function ideaBrief(
  kind: EasyKind,
  template: Template,
  idea: string,
  packs: readonly Pack[],
  attached: readonly string[] = [],
  multiplayer?: EasyMultiplayer,
): BriefInput {
  const brief = templateBrief(template)
  if (kind !== 'game') return brief
  const pack = packs.find((p) => p.id === brief.category)
  if (pack === undefined) return brief
  const fields = { ...brief.fields }
  for (const [group, field] of Object.entries(keywordFields(idea, pack, []))) {
    // What the game is built with is the template's (a 2D template started because Node.js is missing stays 2D, so
    // its Brief never says three.js).
    if (group === ENGINE && fields[ENGINE] !== undefined) continue
    const g = pack.groups.find((x) => x.id === group)
    const had = fields[group]
    fields[group] =
      g?.multi === true && had !== undefined
        ? { ...had, choices: [...new Set([...had.choices, ...field.choices])] }
        : { choices: [...field.choices], source: 'keyword' }
  }
  const players = fields[PLAYERS]
  if (asksOnlinePlay(idea) || players?.choices.includes(ONLINE) === true) {
    fields[PLAYERS] = { choices: [multiplayer ?? onlineInstead(idea)], source: 'user' }
  }
  const deliverable = fields[DELIVERABLE]
  if (deliverable?.choices.includes(GAME_SERVER) === true) {
    const rest = deliverable.choices.filter((c) => c !== GAME_SERVER)
    if (rest.length > 0) fields[DELIVERABLE] = { ...deliverable, choices: rest }
    else delete fields[DELIVERABLE]
  }
  const photos = attached.some((a) => isEasyPhotoName(a))
  const art = pack.groups.find((g) => g.id === ART_STYLE)
  if (photos && art?.options.some((o) => o.id === MY_PHOTOS) === true) {
    fields[ART_STYLE] = { choices: [MY_PHOTOS], source: 'user' }
  }
  return { category: brief.category, fields }
}

/**
 * A website's or app's Brief with its Easy recipe's look and quality choices (the recipe of the template's pack: for
 * software responsive, accessible and dark mode; for design phone and desktop, and design tokens) added where the
 * template leaves room: a group the template does not set takes them, a multi-choice group gets them added, and a
 * single choice the template made stays. Options the pack does not have are left out. Every other Brief is kept.
 */
export function withEasyLook(
  brief: BriefInput,
  defaults: BriefInput | undefined,
  packs: readonly Pack[],
): BriefInput {
  if (defaults === undefined || defaults.category !== brief.category) return brief
  const pack = packs.find((p) => p.id === brief.category)
  if (pack === undefined) return brief
  const fields = { ...brief.fields }
  for (const [group, f] of Object.entries(defaults.fields)) {
    const g = pack.groups.find((x) => x.id === group)
    if (g === undefined) continue
    const valid = f.choices.filter((c) => g.options.some((o) => o.id === c))
    const first = valid[0]
    if (first === undefined) continue
    const had = fields[group]
    if (had === undefined) fields[group] = { choices: g.multi === true ? valid : [first], source: 'user' }
    else if (g.multi === true) fields[group] = { ...had, choices: [...new Set([...had.choices, ...valid])] }
  }
  return { category: brief.category, fields }
}

/** The Brief chooses the user's own photos as a game's look. */
export function briefUsesPhotos(brief: BriefInput): boolean {
  return brief.fields[ART_STYLE]?.choices.includes(MY_PHOTOS) === true
}

// ---- folder -----------------------------------------------------------------------------------------------------

/** Words left out of a folder name. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or of for to in on at by with from into my our your their his her its me us them i we you it ' +
    'that this these those which who whom what where when how so as is are be can could would should will want ' +
    'wants need needs make build create please some any let lets'
  ).split(' '),
)

/** How many words of the idea a folder name keeps. */
const SLUG_WORDS = 3

/** Names Windows reserves for devices: never a folder name on its own. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A folder name for an idea: its first meaningful words in lower case, joined with dashes ("bakery-landing-page").
 * Accents are dropped from Latin letters ("café" → "cafe"); other scripts keep their letters ("パン屋のサイト"), cut to
 * EASY_SLUG_MAX characters, so an idea in Japanese or Greek gets a name of its own rather than "my-project".
 */
export function slugOf(idea: string): string {
  const words = idea
    .normalize('NFKD')
    // Accents come off Latin letters only (a Cyrillic й or a Japanese パ keeps its mark).
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !STOPWORDS.has(w))
  let slug = ''
  for (const w of words.slice(0, SLUG_WORDS)) {
    const next = slug === '' ? w : `${slug}-${w}`
    if ([...next].length > EASY_SLUG_MAX) break
    slug = next
  }
  if (slug === '') slug = [...(words[0] ?? '')].slice(0, EASY_SLUG_MAX).join('')
  if (slug === '') return 'my-project'
  return RESERVED.test(slug) ? `${slug}-project` : slug
}

/** The first free folder for a name in `dir`: `name`, then `name-2`, `name-3` and so on. */
export function freeFolder(
  dir: string,
  name: string,
  exists: (path: string) => boolean,
): { folder: string; name: string } {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`
    const folder = join(dir, candidate)
    if (!exists(folder)) return { folder, name: candidate }
  }
  const candidate = `${name}-${Date.now()}`
  return { folder: join(dir, candidate), name: candidate }
}

// ---- task -------------------------------------------------------------------------------------------------------

/**
 * The run's task for a new Easy project: the idea first (it wins), then the template's scaffold as the outline to start
 * from, then the note that a folder already holding a scaffold is built on.
 */
export function easyTask(template: Template, idea: string, multiplayer?: EasyMultiplayer): string {
  return [
    idea.trim(),
    OUTLINE_INTRO,
    template.task.trim(),
    ...(asksOnlinePlay(idea) ? [onlineNote(multiplayer ?? onlineInstead(idea))] : []),
    EASY_RULES_NOTE,
    SCAFFOLD_EXISTING_NOTE,
  ].join('\n\n')
}

/**
 * The rules every Easy run's task carries (Plan, Implement and the reviewers read the task): never invent the
 * person's own facts (marked slots instead, listed for them), and write in the language they wrote in.
 */
export const EASY_RULES_NOTE =
  "Never invent facts about the person's own business, club or life (prices, opening hours, addresses, phone numbers, policies, testimonials or reviews, team or staff names): where one belongs, write a clearly marked [Fill in: what goes here] slot and list every slot in the README under Things to fill in. Real, specific wording is welcome; lorem ipsum is not. Write every word people will read in the language this request is written in, and set <html lang> to match."

/** A change to a data report: the copy of the data the page keeps is written again from the data files. */
export const DATA_CHANGE_NOTE =
  'This is a data report. If the change adds, swaps or edits data in data/, write the copy of the data the page keeps (js/data.js) again from the new files, so the report never shows the old numbers, and take the "Example data" banner away once real data is in. Show totals, counts and averages, never personal columns such as names, email addresses or phone numbers.'

/** A change to a guide or checklist kept twice (Markdown and a page): both copies change together. */
export const TWO_COPIES_NOTE =
  'The words are kept twice (the Markdown files and the HTML page): make the change in both so they keep saying the same thing.'

/** The task of a follow-up run that makes a change to an existing Easy project. */
export function changeTask(
  change: string,
  o: { kind?: EasyKind | undefined; attached?: readonly string[] } = {},
): string {
  return [
    change.trim(),
    'This folder already holds the project. Make this change to it and keep everything else working as it is.',
    EASY_RULES_NOTE,
    ...(o.kind === 'data' ? [DATA_CHANGE_NOTE] : []),
    ...(o.kind === 'document' || o.kind === 'checklist' ? [TWO_COPIES_NOTE] : []),
    ...(o.attached !== undefined && o.attached.length > 0 ? [attachmentsNote(o.attached)] : []),
  ].join('\n\n')
}

/** The task of a follow-up run that carries on after a run stopped at its limit. */
export function continueTask(task: string): string {
  return [
    'An earlier run on this request stopped before it was finished; what it made is already in this folder. Build on it and finish the work, without starting over.',
    'The request:',
    task.trim(),
  ].join('\n\n')
}

/** The longest project title Easy shows (the run and Done screens' line under the heading). */
export const EASY_TITLE_MAX = 60

/**
 * A short title for a project from its idea: its first clause (up to a colon, a full stop, a question mark or a line
 * break), a leading "a", "an" or "the" left out, the first letter capitalized, cut at a word to EASY_TITLE_MAX with an
 * ellipsis. "A help guide for the customers of my knitting shop: how to order..." reads "Help guide for the customers
 * of my knitting shop".
 */
export function titleOf(idea: string): string {
  const first =
    idea
      .trim()
      .split(/[:\n\r]|[.?!](?:\s|$)/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? ''
  const bare = first.replace(/^(?:a|an|the)\s+/i, '').trim() || first
  let t = bare.charAt(0).toUpperCase() + bare.slice(1)
  if (t.length > EASY_TITLE_MAX) {
    const cut = t.slice(0, EASY_TITLE_MAX - 1)
    const at = cut.lastIndexOf(' ')
    t = `${(at > EASY_TITLE_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;-]+$/, '')}…`
  }
  return t
}

/** The task's note about the files the user added (copied into the project before the run). */
export function attachmentsNote(written: readonly string[]): string {
  return [
    'The user added these files to the project folder. Use them for what was asked; keep them where they are and do not send them anywhere:',
    ...written.map((w) => `- ${w}`),
    'A large data file need not be read in full: read its first rows to learn its columns, and let the code read all of it. A spreadsheet that came with a CSV copy of its first sheet is read from the CSV.',
  ].join('\n')
}
