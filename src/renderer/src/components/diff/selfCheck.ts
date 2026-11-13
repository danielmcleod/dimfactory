// The Diff tab's highlighter, checked end to end (the packaged --smoke-test; `@pierre/diffs`, with Shiki in a
// worker): the window's worker pool starts (the bundled worker script, under the app's CSP) and
// highlights a one-line TypeScript diff. Loaded on demand by selfCheckHook.ts; nothing in the app's flow calls it.
import { parsePatchFiles } from '@pierre/diffs'
import { getDiffPool } from './highlighter.ts'

const PATCH = [
  'diff --git a/self-check.ts b/self-check.ts',
  'index 1111111..2222222 100644',
  '--- a/self-check.ts',
  '+++ b/self-check.ts',
  '@@ -1 +1 @@',
  '-export const answer = 41',
  '+export const answer = 42',
  '',
].join('\n')

export const SELF_CHECK_TIMEOUT_MS = 30_000

/** null when the worker highlighted the diff; otherwise what went wrong, in words. */
export async function checkDiffHighlighter(timeoutMs = SELF_CHECK_TIMEOUT_MS): Promise<string | null> {
  const pool = getDiffPool()
  if (pool === undefined) return 'this window cannot start workers'
  const diff = parsePatchFiles(PATCH, 'diff-self-check', false).flatMap((p) => p.files)[0]
  if (diff === undefined) return 'the diff renderer could not read a patch'
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`the highlighter worker did not answer within ${Math.round(timeoutMs / 1000)} s`),
      timeoutMs,
    )
  })
  const work = (async (): Promise<string | null> => {
    await pool.initialize(['typescript'])
    if (!pool.isWorkingPool()) return 'the highlighter worker did not start'
    await pool.primeDiffHighlightCache(diff)
    return pool.getDiffResultCache(diff) !== undefined ? null : 'the highlighter worker returned nothing'
  })().catch(
    (err: unknown) => `the highlighter worker failed: ${err instanceof Error ? err.message : String(err)}`,
  )
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}
