// Declarations for tests/fixtures/gemini/recipes/dim-factory-responder.mjs (live Gemini ACP recordings).

export const GEMINI_PREFS: { readonly allowSession: readonly string[]; readonly forbidden: readonly string[] }

export interface ResponderPass {
  step?: string
  mode?: string
  planNative?: boolean
  answers?: { decision: string }[]
  /** The user's Stop: with `after.type` 'ask', the first ask is answered by session/cancel + `cancelled`. */
  stop?: { after?: { type?: string } }
}

/**
 * Answers every agent request as the ACP base does (a --responders module's default export): one reply, or the reply
 * and Dim Factory's session/cancel in the order the base sends them (a plan exit; a Stop at an ask).
 */
export function dimFactoryResponder(
  pass: ResponderPass,
  prefs?: { readonly allowSession: readonly string[]; readonly forbidden: readonly string[] },
): (frame: unknown) => Record<string, unknown> | Record<string, unknown>[] | undefined
