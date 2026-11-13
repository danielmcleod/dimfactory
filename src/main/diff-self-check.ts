// The `--smoke-test`'s look at the Diff tab's highlighter (`@pierre/diffs`, with Shiki in a worker): the renderer's
// window hook (components/diff/selfCheckHook.ts) starts
// the bundled worker and has it highlight a diff, so a package that left the worker out, or a CSP that blocks it,
// fails the smoke instead of the user's first Diff tab. Electron-free: the page call is injected.

/** The renderer's DIFF_SELF_CHECK_HOOK (a test keeps them equal). */
export const DIFF_SELF_CHECK_HOOK = '__dimFactoryDiffCheck'

/** Evaluated in the page: the hook's answer (null when the worker highlighted), or why there is none. */
export const DIFF_SELF_CHECK_SCRIPT =
  `(async () => { const check = window['${DIFF_SELF_CHECK_HOOK}'];` +
  ` return typeof check === 'function' ? await check() : 'the renderer has no diff self-check' })()`

/** null when the Diff tab's highlighter works; otherwise one line for SMOKE FAIL. */
export async function diffSelfCheck(evaluate: (script: string) => Promise<unknown>): Promise<string | null> {
  let answer: unknown
  try {
    answer = await evaluate(DIFF_SELF_CHECK_SCRIPT)
  } catch (err) {
    return `the Diff tab's highlighter could not be checked: ${err instanceof Error ? err.message : String(err)}`
  }
  if (answer === null) return null
  return `the Diff tab's highlighter: ${typeof answer === 'string' ? answer : 'an unexpected answer'}`
}
