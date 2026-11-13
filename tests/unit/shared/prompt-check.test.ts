// The prompt check: which tasks get a hint and which stay quiet. No model call, nothing random. The rules lean toward
// saying nothing: a short exact task has no hint, and length alone never makes one.
import { describe, expect, it } from 'vitest'
import {
  BUG_PART_EXPECTED,
  BUG_PART_REPRO,
  PROMPT_HINTS_MAX,
  PROMPT_HINT_TEXT,
  PROMPT_LONG_WORDS,
  checkPrompt,
  informativeWords,
  loosePlace,
  namesTarget,
  promptCheckLine,
  promptHintLine,
  promptHintsKey,
} from '@shared/prompt-check.ts'
import type { PromptCheckInput, PromptHintKind } from '@shared/prompt-check.ts'

const kinds = (i: PromptCheckInput): PromptHintKind[] => checkPrompt(i).map((h) => h.kind)
const inProject = (task: string, recipe?: string): PromptHintKind[] =>
  kinds({ task, folder: 'project', recipe })

describe('short exact tasks stay quiet', () => {
  const exact = [
    'Rename getUser to fetchUser',
    'Add a --version flag that prints the package version',
    'Fix the typo in the README heading',
    'Update dependencies',
    'Fix the failing tests',
    'Fix lint errors',
    'Bump the version to 2.0.1',
    'Remove the unused import in src/app.ts',
    'Add a dark mode toggle to the settings page',
    'The total is off by one when the cart is empty; fix it',
    'Refactor parseArgs into two functions',
    'Translate the README to French',
    'Delete the old logo.png',
    'Make the "Sign up" button green',
    'Add pagination to the orders table',
    'Convert the project to TypeScript',
    'Write tests for parseDate()',
    'Fix #142',
    'The /settings route returns a 500',
  ]
  it.each(exact)('%s', (task) => {
    expect(inProject(task)).toEqual([])
  })

  it('an empty task has no hint', () => {
    expect(inProject('')).toEqual([])
    expect(inProject('   \n ')).toEqual([])
  })
})

describe('a task that names nothing', () => {
  it.each([
    ['Fix the bug', ['no-target']],
    ['Add pagination', ['no-target']],
    ['Add tests', ['no-target']],
    ['Make it better', ['no-target', 'no-outcome']],
    ['Clean up the code', ['no-target', 'no-outcome']],
    ['Improve performance', ['no-target', 'no-outcome']],
  ] as [string, PromptHintKind[]][])('%s', (task, want) => {
    expect(inProject(task)).toEqual(want)
  })

  it('says so only in a project: a new folder has nowhere to point at yet', () => {
    expect(kinds({ task: 'Add pagination', folder: 'new', recipe: 'add-feature' })).toEqual([])
    expect(kinds({ task: 'Make a report', folder: 'data' })).toEqual([])
  })

  it('counts what says something', () => {
    expect(informativeWords('Please fix the bug in the code')).toEqual([])
    expect(informativeWords('Fix crash on save')).toEqual(['crash', 'save'])
    expect(inProject('Fix crash on save')).toEqual([])
  })
})

describe('naming where', () => {
  it.each([
    'src/app.ts',
    'the login button',
    'the settings page',
    'handleSubmit',
    'user_id',
    '--dry-run',
    'the text "Welcome back"',
    'https://example.test/docs',
    'the README',
    'type errors',
  ])('%s names a place', (text) => {
    expect(namesTarget(`Change ${text}`)).toBe(true)
  })

  it.each(['the button', 'the page', 'it', 'the code', 'everything', "don't break it and don't stop"])(
    '%s does not',
    (text) => {
      expect(namesTarget(`Change ${text}`)).toBe(false)
    },
  )
})

describe('loose words', () => {
  it('a bare place could be any of them', () => {
    expect(loosePlace('Make the button bigger')).toBe('the button')
    expect(loosePlace('Make the login button bigger')).toBeUndefined()
    const hints = checkPrompt({ task: 'Make the button bigger and move it to the right', folder: 'project' })
    expect(hints.map((h) => h.kind)).toEqual(['loose'])
    expect(hints[0]?.text).toBe('"the button" could mean more than one thing here.')
  })

  it('"it" at the start of a short ask', () => {
    const hints = checkPrompt({ task: 'Make it responsive on mobile', folder: 'project' })
    expect(hints.map((h) => h.kind)).toEqual(['loose'])
    expect(hints[0]?.text).toBe(PROMPT_HINT_TEXT.looseIt.text)
  })

  it('stays quiet once something is named', () => {
    expect(inProject('On the settings page, make the button bigger')).toEqual([])
  })
})

describe('no outcome', () => {
  it.each(['Improve the dashboard performance', 'Redesign the home page', 'Clean up the code in utils.ts'])(
    '%s',
    (task) => {
      expect(inProject(task)).toEqual(['no-outcome'])
    },
  )

  it.each([
    'Improve the dashboard so the list loads in under a second',
    'Refactor src/auth.ts to use async and await',
    'Update the README with the install steps',
    'Change the header colour from blue to green',
    'Upgrade all packages',
  ])('%s says what it should become', (task) => {
    expect(inProject(task)).toEqual([])
  })
})

describe('the bug fix recipe', () => {
  it('names the parts that might be missing', () => {
    const one = checkPrompt({
      task: 'Saving an empty form shows a blank page',
      folder: 'project',
      recipe: 'bug-fix',
    })
    expect(one.map((h) => h.kind)).toEqual(['bug-parts'])
    expect(one[0]?.text).toContain(BUG_PART_EXPECTED)
    expect(one[0]?.text).not.toContain(BUG_PART_REPRO)
    const both = checkPrompt({ task: 'The export is broken', folder: 'project', recipe: 'bug-fix' })
    expect(both.map((h) => h.kind)).toEqual(['no-target', 'bug-parts'])
    expect(both[1]?.text).toContain(`${BUG_PART_REPRO} and ${BUG_PART_EXPECTED}`)
  })

  it('a full report has no hint, and other recipes are not held to it', () => {
    const full = 'When I save an empty form it shows a blank page. It should show a message instead.'
    expect(inProject(full, 'bug-fix')).toEqual([])
    expect(inProject('Saving an empty form shows a blank page', 'add-feature')).toEqual([])
    expect(inProject('Saving an empty form shows a blank page')).toEqual([])
  })
})

describe('something new', () => {
  it.each(['Make a website', 'A recipe app', 'Build a todo app'])('%s', (task) => {
    expect(kinds({ task, folder: 'new' })).toEqual(['new-parts'])
  })

  it.each([
    'A website for my bakery',
    'Build a todo app with due dates',
    'An app where friends split a bill',
    'A page to track my reading',
  ])('%s says who or what', (task) => {
    expect(kinds({ task, folder: 'new' })).toEqual([])
  })

  it('the new web app recipe asks the same in any folder; other recipes in a new folder do not', () => {
    expect(kinds({ task: 'A recipe app', folder: 'data', recipe: 'new-web-app' })).toEqual(['new-parts'])
    expect(kinds({ task: 'A recipe app', folder: 'new', recipe: 'new-game' })).toEqual([])
  })
})

describe('blanks and several jobs', () => {
  it('a blank left by Sharpen it comes first', () => {
    expect(inProject('On the [which page?] page, show the total in bold')[0]).toBe('blanks')
    expect(inProject('Show the total [in bold] on the cart page')).toEqual([])
  })

  it('two or more "also" make several jobs', () => {
    expect(inProject('Fix the login redirect. Also add a dark mode. Also rename the cart page.')).toEqual([
      'several-jobs',
    ])
    expect(inProject('Fix the login redirect and also log the reason')).toEqual([])
  })
})

describe('limits', () => {
  it(`returns at most ${PROMPT_HINTS_MAX} hints, most useful first`, () => {
    const got = inProject('Make it better [how?] and also this, plus that', 'bug-fix')
    expect(got).toEqual(['blanks', 'no-target', 'bug-parts'])
  })

  it('a long task has said enough for the word rules', () => {
    const long = Array.from({ length: PROMPT_LONG_WORDS + 1 }, () => 'improve').join(' ')
    expect(inProject(long)).toEqual([])
    const justShort = Array.from({ length: PROMPT_LONG_WORDS }, () => 'improve').join(' ')
    expect(inProject(justShort)).toEqual(['no-target', 'no-outcome'])
  })
})

describe('the words', () => {
  const all = [
    PROMPT_HINT_TEXT.blanks,
    PROMPT_HINT_TEXT.noTarget,
    PROMPT_HINT_TEXT.loosePlace('the button'),
    PROMPT_HINT_TEXT.looseIt,
    PROMPT_HINT_TEXT.bugParts([BUG_PART_REPRO, BUG_PART_EXPECTED]),
    PROMPT_HINT_TEXT.newParts,
    PROMPT_HINT_TEXT.noOutcome,
    PROMPT_HINT_TEXT.severalJobs,
  ]

  it('have no em dashes and end as sentences', () => {
    for (const h of all) {
      expect(`${h.text}${h.add}`).not.toMatch(/[—–]/)
      expect(h.text).toMatch(/\.$/)
      expect(h.add).toMatch(/\.$/)
    }
  })

  it('one line: the first hint and how many more', () => {
    const hints = checkPrompt({ task: 'Make it better', folder: 'project' })
    expect(promptHintLine(hints[0]!)).toBe(
      'This might not say where the change goes. Name the page, file or function, or quote the text you see on screen.',
    )
    expect(promptCheckLine(hints)).toBe(`${promptHintLine(hints[0]!)} (1 more)`)
    expect(promptCheckLine(hints.slice(0, 1))).toBe(promptHintLine(hints[0]!))
    expect(promptCheckLine([])).toBe('')
    expect(promptHintsKey(hints)).toBe('no-target,no-outcome')
  })
})
