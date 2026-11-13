// Adaptive depth's classifier: Quick (direct) or Thorough (full) for a run, from what is known before it starts, with
// no model call and nothing random: the task's words (its size, and words of risky work such as sign-in, payments,
// data migrations or security, or of a large refactor), the folder (new or existing, how big), Easy or Full, the Brief
// (Test-first needs a plan) and what an Easy idea needs (a shop, a sign-in, data stored online). The first rule that
// matches decides and names the reason the composer and the Easy confirm screen show. Pure.
import type { Depth, DepthSignal } from '../../shared/depth.ts'

export interface DepthInput {
  /** The task as the run sends it. */
  task: string
  /** The folder as a run would find it: whether it holds a project yet, and roughly how big it is. */
  folder: FolderSize
  /** Easy mode (a beginner's run). */
  easy?: boolean
  /** Easy's "Make something new": a project made from an idea in a new folder. */
  newProject?: boolean
  /** The Brief's Test-first (its tests come from the plan's acceptance criteria). */
  testFirst?: boolean
  /** What an Easy idea needs beyond pages in a browser (needs.ts: payments, sign-in, data stored online...). */
  needs?: readonly string[]
}

/** What core knows of a folder: absent, or how many files it holds (capped; dependency and build folders left out). */
export interface FolderSize {
  exists: boolean
  /** Files a person or a pass edits (capped at FOLDER_COUNT_CAP); 0 for an empty or new folder. */
  files: number
  /** Every file is data or a document (a spreadsheet, a PDF, pictures): no project yet, only something to work on. */
  dataOnly?: boolean
}

export interface DepthVerdict {
  depth: Depth
  reason: string
  signals: DepthSignal[]
}

/** The most files the folder count looks at (a larger folder counts as large). */
export const FOLDER_COUNT_CAP = 5000
/** At or above this many files, a folder is a large repository. */
export const LARGE_REPO_FILES = 2000
/** A task longer than this many words is a large task. */
export const LARGE_TASK_WORDS = 160
/** In a large repository, a task longer than this many words is a sizeable change. */
export const LARGE_REPO_TASK_WORDS = 80
/** This many list items or more (numbered or bulleted lines) make a task large. */
export const LARGE_TASK_ITEMS = 8

/** A whole-word, any-case phrase (letters and digits around it do not count as a match). */
function phrase(p: string): RegExp {
  const body = p
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\s-]+/g, '[\\s-]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}
const words = (...ps: string[]): RegExp[] => ps.map(phrase)

/** Risky work, by what it touches; the reason names the first group found. */
export const RISK_WORDS: readonly { what: string; words: readonly RegExp[] }[] = [
  {
    what: 'sign-in',
    words: words(
      'auth',
      'authentication',
      'authorization',
      'authorisation',
      'login',
      'log in',
      'logins',
      'sign in',
      'sign-in',
      'signin',
      'sign up',
      'signup',
      'password',
      'passwords',
      'oauth',
      'jwt',
      'sso',
      'session token',
      'access control',
      'permissions',
      'rbac',
    ),
  },
  {
    what: 'payments',
    words: words(
      'payment',
      'payments',
      'checkout',
      'billing',
      'stripe',
      'paypal',
      'credit card',
      'card details',
      'subscription billing',
      'refund',
      'refunds',
    ),
  },
  {
    what: 'a data migration',
    words: [
      ...words(
        'migration',
        'migrations',
        'data migration',
        'schema change',
        'alter table',
        'drop table',
        'drop column',
        'backfill',
      ),
      /\bmigrat\w*\s+(?:the\s+)?(?:data|database|db|schema|tables?|records|users)\b/iu,
    ],
  },
  {
    what: 'security',
    words: words(
      'security',
      'vulnerability',
      'vulnerabilities',
      'cve',
      'xss',
      'csrf',
      'sql injection',
      'encryption',
      'encrypt',
      'decrypt',
      'secrets',
      'api keys',
      'credentials',
      'personal data',
      'pii',
      'gdpr',
    ),
  },
]

/** A refactor or rewrite word... */
const REFACTOR_VERBS = words(
  'refactor',
  'refactoring',
  'rewrite',
  're-write',
  'restructure',
  'rearchitect',
  're-architect',
  'overhaul',
  'migrate',
  'port',
  'convert',
)
/** ...over a large scope makes a large refactor. */
const REFACTOR_SCOPE = words(
  'whole',
  'entire',
  'everything',
  'all of the',
  'all files',
  'every file',
  'codebase',
  'code base',
  'across the',
  'architecture',
  'monorepo',
  'the app',
  'the project',
  'the application',
  'the backend',
  'the frontend',
)

const has = (text: string, list: readonly RegExp[]): boolean => list.some((r) => r.test(text))

/** The task's words (letters or digits in a run), for its size. */
export function wordCount(task: string): number {
  return (task.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []).length
}

/** Lines that are list items (`- x`, `* x`, `1. x`, `2) x`). */
export function listItems(task: string): number {
  return task.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/u.test(l)).length
}

/** The risky area the task names first, or undefined. */
export function riskOf(task: string): string | undefined {
  return RISK_WORDS.find((g) => has(task, g.words))?.what
}

/** The task reads as a large refactor: a refactor or rewrite word with a large scope. */
export function isLargeRefactor(task: string): boolean {
  return has(task, REFACTOR_VERBS) && has(task, REFACTOR_SCOPE)
}

/** The folder holds no project yet: missing, or no files of its own. */
export function isNewFolder(f: FolderSize): boolean {
  return !f.exists || f.files === 0
}

export const DEPTH_REASON = {
  risky: (what: string): string => `It touches ${what}, so it gets a plan and two reviewers.`,
  beginnerNew: 'A new project for a beginner: it is planned first and checked by two reviewers.',
  newProject: 'A new project: it is planned first and checked by two reviewers.',
  needs: (what: string): string => `It needs ${what}, so it gets a plan and two reviewers.`,
  testFirst: 'Test-first writes its tests from a plan.',
  largeRefactor: 'A large refactor: it is planned first and checked by two reviewers.',
  largeTask: 'A large task: it is planned first and checked by two reviewers.',
  largeRepo: 'A sizeable change in a large project: it is planned first.',
  small: 'A small or medium change to an existing project.',
  smallData: 'A small or medium task on the files in this folder.',
} as const

/** Easy's need ids in plain words (the reason names the first). */
const NEED_TEXT: Readonly<Record<string, string>> = {
  payments: 'payments',
  login: 'sign-in',
  data: 'data stored online',
  ai: 'an AI or paid service',
  forms: 'a form that saves or sends',
  blog: 'a blog to post to',
}

/** Needs that make a project risky enough for the full pipeline. */
const RISKY_NEEDS: ReadonlySet<string> = new Set(['payments', 'login', 'data', 'ai'])

/** Quick or Thorough, and why: the first rule that matches decides. */
export function classifyDepth(i: DepthInput): DepthVerdict {
  const task = i.task
  const full = (signal: DepthSignal, reason: string): DepthVerdict => ({
    depth: 'full',
    reason,
    signals: [signal],
  })
  const risk = riskOf(task)
  if (risk !== undefined) return full('risky', DEPTH_REASON.risky(risk))
  const fresh = i.newProject === true || isNewFolder(i.folder)
  if (fresh && i.easy === true) return full('beginner-new', DEPTH_REASON.beginnerNew)
  if (fresh) return full('new-project', DEPTH_REASON.newProject)
  const need = (i.needs ?? []).find((n) => RISKY_NEEDS.has(n))
  if (need !== undefined) return full('needs', DEPTH_REASON.needs(NEED_TEXT[need] ?? need))
  if (i.testFirst === true) return full('test-first', DEPTH_REASON.testFirst)
  if (isLargeRefactor(task)) return full('large-refactor', DEPTH_REASON.largeRefactor)
  const n = wordCount(task)
  if (n > LARGE_TASK_WORDS || listItems(task) >= LARGE_TASK_ITEMS)
    return full('large-task', DEPTH_REASON.largeTask)
  if (i.folder.files >= LARGE_REPO_FILES && n > LARGE_REPO_TASK_WORDS)
    return full('large-repo', DEPTH_REASON.largeRepo)
  return {
    depth: 'direct',
    reason: i.folder.dataOnly === true ? DEPTH_REASON.smallData : DEPTH_REASON.small,
    signals: ['small-change'],
  }
}
