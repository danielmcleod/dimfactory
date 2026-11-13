// Declarations for tests/fixtures/grok/recipes/dim-factory-responder.mjs (live Grok ACP recordings).

export const GROK_PREFS: {
  readonly allowSession: readonly string[]
  readonly forbidden: readonly string[]
  readonly forbiddenName: RegExp
}

export interface ResponderPass {
  step?: string
  mode?: string
  /** GR03: a study of Grok's default mode; every request is rejected as in a read-only pass. */
  study?: string
  answers?: { decision: string }[]
}

/** Answers every agent request as the ACP base does with the Grok configuration (a --responders module's default). */
export function dimFactoryResponder(
  pass: ResponderPass,
  prefs?: {
    readonly allowSession: readonly string[]
    readonly forbidden: readonly string[]
    readonly forbiddenName?: RegExp
  },
): (frame: unknown) => Record<string, unknown> | Record<string, unknown>[] | undefined
