// The optional steps' prompt templates the user may see and override in Settings › Prompts (like the passes'):
// Clarify and its plain-words twin, Research, the acceptance review, Explain and its plain-words twin, the Deploy
// step, and Quick runs' build prompt. Each is checked against its step's placeholders: the plain-words twins take
// Clarify's and Explain's, and `direct` takes Implement's.

export const STEP_PROMPT_NAMES = [
  'clarify',
  'clarify-easy',
  'research',
  'acceptance',
  'explain',
  'explain-easy',
  'deploy',
  'direct',
] as const
export type StepPromptName = (typeof STEP_PROMPT_NAMES)[number]

/** The step a template belongs to (its placeholders and its parser): a plain-words twin is its step's. */
export type StepPromptKind = 'clarify' | 'research' | 'acceptance' | 'explain' | 'deploy' | 'implement'

export function isStepPromptName(v: unknown): v is StepPromptName {
  return typeof v === 'string' && (STEP_PROMPT_NAMES as readonly string[]).includes(v)
}

export function stepPromptKind(name: StepPromptName): StepPromptKind {
  if (name === 'clarify-easy') return 'clarify'
  if (name === 'explain-easy') return 'explain'
  if (name === 'direct') return 'implement'
  return name
}
