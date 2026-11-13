// The inner scroll regions the app may have (UI standards: one scroll region per
// screen; inner scrollers are only for genuinely long content, with a fixed maximum height). Each carries
// data-scroll-region="<name>" with one of these names; the E2E guards (ui-standards.spec.ts, ui-layout.spec.ts, git-helpers' audit)
// fail on any other, so a new inner scroller has to be added here on purpose.
//   stream       a vendor's output (StreamPane)
//   log          the Log tab's rows
//   ask-detail   a long command in an ask
//   snag-output  a failure's raw output
//   card-input   a card's text box (the plan editor, a task to re-plan)
//   task-input   the composer's task box
//   menu         a dropdown menu or a select's list
//   palette      the Ctrl/Cmd+K palette's results (only while the palette is open)
//   verify-output a verify round's output, and a failing command's excerpt (VerifyCard, the verifyEnv card)
//   prepare-output an isolated run's dependency install output (PrepareCard, the depsFailed card's excerpt)
//   sharpen-text the composer's proposed rewrite of a task (PromptCheckRow, only after Sharpen it is clicked)
export const SCROLL_REGIONS: readonly string[] = [
  'stream',
  'log',
  'ask-detail',
  'snag-output',
  'card-input',
  'task-input',
  'menu',
  'palette',
  'verify-output',
  'prepare-output',
  'sharpen-text',
]
