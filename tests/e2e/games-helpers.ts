// "A game" in Easy mode, for the E2E specs: the fake Claude's scenario for a new game project (questions about how it is
// played, a look at similar games, a plan whose acceptance criteria are things a player does and sees, a real playable
// snake game as Implement's file, the acceptance review's verdicts and a summary with How to play), from a fixture game
// that runs on the starter engine the template copies into the project (tests/fixtures/games/snake).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Scenario, ScenarioSpec } from '../integration/run/scenario.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import { withPlan } from './easy-helpers.ts'

/** The gallery's game card. */
export const GAME_IDEA =
  "A snake game I can play on my phone or laptop: eat apples to grow, don't hit the walls, and remember my best score."

/** A real game on the starter engine (src/engine/, copied by the game-canvas template). */
export const GAME_HTML = readFileSync(
  join(REPO_ROOT, 'tests', 'fixtures', 'games', 'snake', 'index.html'),
  'utf8',
)

export const GAME_QUESTIONS = {
  questions: [
    { question: 'How do you play it?', options: ['Arrow keys on a laptop', 'Buttons on a phone'] },
    { question: 'Who is it for?', options: ['Everyone', 'Kids'] },
  ],
}

export const GAME_CRITERIA = [
  'Arrow keys steer the snake',
  'Eating an apple makes the snake longer and adds 10 points',
  'Your best score is still there after you reload',
  'P or Esc pauses the game, and so does leaving the window',
]

const GAME_VERDICTS = {
  verdicts: GAME_CRITERIA.map((_, i) => ({
    id: `AC${i + 1}`,
    status: 'met',
    evidence: 'index.html wires it through src/engine/input.js, loop.js and storage.js',
  })),
}

const GAME_RESEARCH = {
  summary: ['Snake games feel good when the controls answer at once and every apple gives clear feedback.'],
  features: [
    {
      feature: 'Steer with the arrow keys, with big on-screen buttons on a phone',
      priority: 'must',
      sources: ['https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum'],
    },
    {
      feature: 'Pause with P or Esc, and when the window loses focus',
      priority: 'must',
      sources: ['https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API'],
    },
  ],
  standards: [],
  options: [],
  risks: [],
  questions: [],
  sources: [
    {
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API',
      title: 'Page Visibility API',
    },
  ],
}

export const GAME_CONTROLS = 'arrow keys or the on-screen buttons to steer, P or Esc to pause, Space to start'

export const GAME_SUMMARY = [
  '## What was built',
  'Garden Snake: a snake game you can play in a browser on your laptop or phone.',
  '',
  '## How to play',
  `Controls: ${GAME_CONTROLS}`,
  'Eat the red apples to grow and score 10 points each. Do not hit the walls or your own tail.',
  '- Turn early: the snake keeps moving.',
  '- Your best score is kept on this device.',
  'Play it in Dim Factory opens the game; F11 makes the window full screen.',
  '',
  '## How to run it',
  '1. Press Play it in Dim Factory, or serve the folder with any static server.',
  '',
  '## What to try next',
  '- Beat your best score, then reload the page to see it is still there.',
  '',
  '## Known limits',
  '- None known.',
].join('\n')

/** The fake Claude for one game: Clarify and Explain on haiku (EASY_CONFIG) take the explain list in turn. */
export function gameScenario(): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    research: [
      { recording: 'C02-review-shape', text: `\`\`\`json\n${JSON.stringify(GAME_RESEARCH)}\n\`\`\`` },
    ],
    implement: [
      { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: GAME_HTML } },
    ],
    review: [
      { recording: 'C02-review-shape', text: JSON.stringify(GAME_VERDICTS), structured: GAME_VERDICTS },
    ],
    explain: [
      { recording: 'C02-review-shape', text: JSON.stringify(GAME_QUESTIONS) },
      { recording: 'C02-review-shape', text: GAME_SUMMARY },
    ],
  }
}

/** The recorded plan becomes the game's, with its play outcomes as the acceptance criteria. */
export function withGamePlan(sc: Scenario): void {
  withPlan(sc, [
    '# Plan: Garden Snake',
    '',
    '## Goal',
    'A snake game in index.html on the starter engine in src/engine/, played with the keyboard or touch buttons.',
    '',
    '## Steps',
    '1. Draw the garden, the snake and an apple on a canvas.',
    '2. Steer with input.js, move on the fixed-timestep loop, keep the best score with storage.js.',
    '',
    '## Acceptance criteria',
    ...GAME_CRITERIA.map((c) => `- ${c}`),
    '',
  ])
}
