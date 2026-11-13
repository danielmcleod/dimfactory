// The window hook main's `--smoke-test` calls (the packaged smoke test checks the Diff tab's Shiki worker;
// src/main/diff-self-check.ts): `window.__dimFactoryDiffCheck()` loads the diff renderer on demand and has its
// worker highlight a diff (selfCheck.ts), answering null or the problem in words. It proves the worker script ships in
// the package and starts under the CSP on app://. Installing it loads nothing: @pierre/diffs and Shiki stay out of
// the app's first bundle.

/** Main's copy is DIFF_SELF_CHECK_HOOK in src/main/diff-self-check.ts (a test keeps them equal). */
export const DIFF_SELF_CHECK_HOOK = '__dimFactoryDiffCheck'

export function installDiffSelfCheck(target: object = window): void {
  Object.defineProperty(target, DIFF_SELF_CHECK_HOOK, {
    configurable: true,
    value: async (): Promise<string | null> => {
      const m = await import('./selfCheck.ts')
      return m.checkDiffHighlighter()
    },
  })
}
