// The Diff tab's highlighter self-check (the packaged --smoke-test; the Diff tab's "Shiki in a worker";
// src/renderer/src/components/diff/selfCheck.ts): the worker pool starts and highlights a diff → null; a window
// without workers, a pool that fails to start, one that returns nothing and one that never answers each give their
// reason in words; the window hook main's --smoke-test calls has main's name and answers the check. The real worker is
// checked by the packaged smoke test and diff.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakePool {
  initialize: (langs?: string[]) => Promise<void>
  isWorkingPool: () => boolean
  primeDiffHighlightCache: (diff: unknown) => Promise<void>
  getDiffResultCache: (diff: unknown) => unknown
}

let pool: FakePool | undefined

vi.mock('@renderer/components/diff/highlighter.ts', () => ({
  DIFF_THEMES: { light: 'pierre-light', dark: 'pierre-dark' },
  getDiffPool: () => pool,
}))

const { checkDiffHighlighter } = await import('@renderer/components/diff/selfCheck.ts')
const { DIFF_SELF_CHECK_HOOK, installDiffSelfCheck } =
  await import('@renderer/components/diff/selfCheckHook.ts')
const main = await import('../../../src/main/diff-self-check.ts')

function working(over: Partial<FakePool> = {}): FakePool {
  const cache = new Map<unknown, unknown>()
  return {
    initialize: () => Promise.resolve(),
    isWorkingPool: () => true,
    primeDiffHighlightCache: (d) => {
      cache.set(d, { code: 'highlighted' })
      return Promise.resolve()
    },
    getDiffResultCache: (d) => cache.get(d),
    ...over,
  }
}

afterEach(() => {
  pool = undefined
})

describe('checkDiffHighlighter', () => {
  it('is null once the worker highlighted the diff (TypeScript loaded first)', async () => {
    const langs: (string[] | undefined)[] = []
    pool = working({
      initialize: (l) => {
        langs.push(l)
        return Promise.resolve()
      },
    })
    await expect(checkDiffHighlighter()).resolves.toBeNull()
    expect(langs).toEqual([['typescript']])
  })

  it('says why when there is no worker, it does not start, or it returns nothing', async () => {
    pool = undefined
    await expect(checkDiffHighlighter()).resolves.toBe('this window cannot start workers')
    pool = working({ initialize: () => Promise.reject(new Error('Failed to load worker script')) })
    await expect(checkDiffHighlighter()).resolves.toBe(
      'the highlighter worker failed: Failed to load worker script',
    )
    pool = working({ isWorkingPool: () => false })
    await expect(checkDiffHighlighter()).resolves.toBe('the highlighter worker did not start')
    pool = working({ getDiffResultCache: () => undefined })
    await expect(checkDiffHighlighter()).resolves.toBe('the highlighter worker returned nothing')
  })

  it('gives up when the worker never answers', async () => {
    pool = working({ primeDiffHighlightCache: () => new Promise<void>(() => undefined) })
    await expect(checkDiffHighlighter(1000)).resolves.toBe('the highlighter worker did not answer within 1 s')
  })
})

describe('the window hook main calls', () => {
  it("is main's hook name, and answers what the check answers", async () => {
    expect(DIFF_SELF_CHECK_HOOK).toBe(main.DIFF_SELF_CHECK_HOOK)
    const target: Record<string, unknown> = {}
    installDiffSelfCheck(target)
    const hook = target[DIFF_SELF_CHECK_HOOK]
    expect(typeof hook).toBe('function')
    pool = working()
    await expect((hook as () => Promise<string | null>)()).resolves.toBeNull()
    pool = undefined
    await expect((hook as () => Promise<string | null>)()).resolves.toBe('this window cannot start workers')
  })
})
