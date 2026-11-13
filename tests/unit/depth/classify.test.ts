// Adaptive depth's classifier: each kind of task → Quick (direct) or Thorough (full), with the reason the composer and
// the Easy confirm screen show. No model call, nothing random.
import { describe, expect, it } from 'vitest'
import {
  DEPTH_REASON,
  LARGE_REPO_FILES,
  classifyDepth,
  isLargeRefactor,
  listItems,
  riskOf,
  wordCount,
} from '@core/depth/classify.ts'
import type { DepthInput, FolderSize } from '@core/depth/classify.ts'
import type { Depth, DepthSignal } from '@shared/depth.ts'

const existing: FolderSize = { exists: true, files: 120 }
const empty: FolderSize = { exists: true, files: 0 }
const missing: FolderSize = { exists: false, files: 0 }
const large: FolderSize = { exists: true, files: LARGE_REPO_FILES + 10 }

const longTask = Array.from({ length: 170 }, (_, i) => `word${i}`).join(' ')
const listTask = ['Do these:', ...Array.from({ length: 8 }, (_, i) => `- item ${i + 1}`)].join('\n')
const mediumTask = Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ')

const rows: [string, DepthInput, Depth, DepthSignal, string][] = [
  [
    'a typo fix',
    { task: 'Fix the typo in the README heading', folder: existing },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'a bug fix',
    { task: 'The total is off by one when the cart is empty; fix it', folder: existing },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'a small feature',
    { task: 'Add a --version flag to the CLI', folder: existing },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'a medium task in a normal repo',
    { task: mediumTask, folder: existing },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'a small refactor',
    { task: 'Refactor parseArgs into two functions', folder: existing },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'sign-in',
    { task: 'Add a login page with password reset', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('sign-in'),
  ],
  [
    'OAuth',
    { task: 'Switch to OAuth for the API', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('sign-in'),
  ],
  [
    'payments',
    { task: 'Take payments with Stripe at checkout', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('payments'),
  ],
  [
    'a data migration',
    { task: 'Write a migration that splits the name column', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('a data migration'),
  ],
  [
    'migrating the database',
    { task: 'Migrate the database to the new schema', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('a data migration'),
  ],
  [
    'security',
    { task: 'Fix the XSS in the comment form', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('security'),
  ],
  [
    'secrets',
    { task: 'Move the API keys out of the code', folder: existing },
    'full',
    'risky',
    DEPTH_REASON.risky('security'),
  ],
  [
    'a new project (empty folder)',
    { task: 'A todo app', folder: empty },
    'full',
    'new-project',
    DEPTH_REASON.newProject,
  ],
  [
    'a new project (no folder yet)',
    { task: 'A todo app', folder: missing },
    'full',
    'new-project',
    DEPTH_REASON.newProject,
  ],
  [
    'a beginner new project (Easy)',
    { task: 'A page for my bakery', folder: missing, easy: true, newProject: true },
    'full',
    'beginner-new',
    DEPTH_REASON.beginnerNew,
  ],
  [
    'Easy: new project even in a folder with files',
    { task: 'A quiz game', folder: existing, easy: true, newProject: true },
    'full',
    'beginner-new',
    DEPTH_REASON.beginnerNew,
  ],
  [
    'an Easy change',
    { task: 'Make the title bigger', folder: existing, easy: true },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'an Easy change that needs sign-in',
    { task: 'Let members see their bookings', folder: existing, easy: true, needs: ['login'] },
    'full',
    'needs',
    DEPTH_REASON.needs('sign-in'),
  ],
  [
    'an Easy change that needs a form only',
    { task: 'Add a contact form', folder: existing, easy: true, needs: ['forms'] },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
  [
    'Test-first',
    { task: 'Add a --version flag', folder: existing, testFirst: true },
    'full',
    'test-first',
    DEPTH_REASON.testFirst,
  ],
  [
    'a large refactor',
    { task: 'Refactor the whole codebase to use async/await', folder: existing },
    'full',
    'large-refactor',
    DEPTH_REASON.largeRefactor,
  ],
  [
    'a rewrite of the app',
    { task: 'Rewrite the app in TypeScript', folder: existing },
    'full',
    'large-refactor',
    DEPTH_REASON.largeRefactor,
  ],
  ['a long task', { task: longTask, folder: existing }, 'full', 'large-task', DEPTH_REASON.largeTask],
  [
    'a long list of items',
    { task: listTask, folder: existing },
    'full',
    'large-task',
    DEPTH_REASON.largeTask,
  ],
  [
    'a medium task in a large repo',
    { task: mediumTask, folder: large },
    'full',
    'large-repo',
    DEPTH_REASON.largeRepo,
  ],
  [
    'a small task in a large repo',
    { task: 'Fix the typo in the footer', folder: large },
    'direct',
    'small-change',
    DEPTH_REASON.small,
  ],
]

describe('classifyDepth: each kind of task, Quick or Thorough, and why', () => {
  it.each(rows)('%s', (_name, input, depth, signal, reason) => {
    const v = classifyDepth(input)
    expect(v).toEqual({ depth, signals: [signal], reason })
  })

  it('is deterministic (the same input, the same answer)', () => {
    for (const [, input] of rows) expect(classifyDepth(input)).toEqual(classifyDepth(input))
  })

  it('risk wins over size and a new folder (the first rule that matches decides)', () => {
    expect(
      classifyDepth({ task: 'A shop with payments', folder: missing, easy: true, newProject: true }).signals,
    ).toEqual(['risky'])
  })

  it('reasons are plain sentences without em dashes', () => {
    for (const [, input] of rows) expect(classifyDepth(input).reason).not.toMatch(/—/)
  })
})

describe('the classifier parts', () => {
  it('counts words and list items', () => {
    expect(wordCount("Fix the user's cart, now")).toBe(5)
    expect(listItems('a\n- one\n* two\n1. three\n2) four\nnot - one')).toBe(4)
  })

  it('names the risky area, matching whole words only', () => {
    expect(riskOf('Add a sign-in page')).toBe('sign-in')
    expect(riskOf('Update the author bio')).toBeUndefined() // "auth" inside "author" is not a match
    expect(riskOf('Fix the password field')).toBe('sign-in')
    expect(riskOf('The checkout total is wrong')).toBe('payments')
  })

  it('a refactor word needs a large scope to be a large refactor', () => {
    expect(isLargeRefactor('Refactor this function')).toBe(false)
    expect(isLargeRefactor('Refactor the entire backend')).toBe(true)
    expect(isLargeRefactor('Convert the project to ESM')).toBe(true)
  })
})
