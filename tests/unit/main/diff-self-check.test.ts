// The --smoke-test's Diff-tab highlighter check (packaged --smoke-test; the Diff tab's "Shiki in a
// worker"; src/main/diff-self-check.ts): the page script calls the renderer's window hook, and the answer becomes one
// SMOKE FAIL reason or none. (tests/renderer/diff/selfCheck.test.ts checks the hook's name is the renderer's.)
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  DIFF_SELF_CHECK_HOOK,
  DIFF_SELF_CHECK_SCRIPT,
  diffSelfCheck,
} from '../../../src/main/diff-self-check.ts'

/** The script as the page would run it, with `window` as given. */
function inPage(window: object): Promise<unknown> {
  return runInNewContext(DIFF_SELF_CHECK_SCRIPT, { window }) as Promise<unknown>
}

describe('diffSelfCheck', () => {
  it("the page script answers the hook's answer, or says the hook is missing", async () => {
    await expect(inPage({ [DIFF_SELF_CHECK_HOOK]: () => Promise.resolve(null) })).resolves.toBeNull()
    await expect(
      inPage({ [DIFF_SELF_CHECK_HOOK]: () => Promise.resolve('the highlighter worker did not start') }),
    ).resolves.toBe('the highlighter worker did not start')
    await expect(inPage({})).resolves.toBe('the renderer has no diff self-check')
  })

  it('passes when the worker highlighted, and words every failure as one reason', async () => {
    await expect(diffSelfCheck(() => Promise.resolve(null))).resolves.toBeNull()
    await expect(diffSelfCheck(() => Promise.resolve('this window cannot start workers'))).resolves.toBe(
      "the Diff tab's highlighter: this window cannot start workers",
    )
    await expect(diffSelfCheck(() => Promise.resolve(42))).resolves.toBe(
      "the Diff tab's highlighter: an unexpected answer",
    )
    await expect(diffSelfCheck(() => Promise.reject(new Error('Script failed to execute')))).resolves.toBe(
      "the Diff tab's highlighter could not be checked: Script failed to execute",
    )
  })

  it('evaluates the script it exports (the call the page gets)', async () => {
    let seen = ''
    await diffSelfCheck((script) => {
      seen = script
      return Promise.resolve(null)
    })
    expect(seen).toBe(DIFF_SELF_CHECK_SCRIPT)
    expect(seen).toContain(DIFF_SELF_CHECK_HOOK)
  })
})
