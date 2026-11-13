// Shiki in a worker for the Diff tab (`@pierre/diffs`, with Shiki in a worker). One pool
// of module workers for the window, made the first time a diff shows and kept (switching tabs does not tear it down).
// The workers use Shiki's JavaScript regex engine, not the Oniguruma WASM build, so the renderer's CSP needs no
// 'wasm-unsafe-eval'. Where workers cannot start (tests), @pierre/diffs highlights on the main thread instead.
// The policy: a worker takes its Content-Security-Policy from its own script's response, never from the page. The
// built renderer is served on app:// (src/main/renderer-files.ts), whose every response carries the policy as a
// header, so a worker started from its bundled file runs under it (no eval, scripts only from the app's own files)
// and worker-src needs nothing beyond 'self' (src/main/csp.ts). *(Over file:// the worker script came with no
// policy, and each worker started from a blob: module that imported it; the app:// scheme made that
// unnecessary.)* security.spec.ts checks that eval is refused in the workers.
// Both themes are loaded, and the app's light or dark theme picks one (PatchView's themeType), so a theme switch
// repaints without highlighting again. They are Shiki's Pierre themes with every token colour made readable on the
// diff's surfaces (diffTheme.ts), registered under Dim Factory's names before the pool asks for them. Only PatchView
// imports this module, and the Diff tab loads PatchView on demand, so none of it is in the app's first bundle.
import type { WorkerPoolManager } from '@pierre/diffs/worker'
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
import diffsWorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'
import { DIFF_THEMES, registerDiffThemes } from './diffTheme.ts'

/** The Shiki themes the diff view uses, light and dark (the app's theme chooses between them). */
export { DIFF_THEMES }

registerDiffThemes()

/** Workers in the pool: highlighting is per file, and a few files show at once. */
const POOL_SIZE = 2

/** The workers' name (DevTools, and the security E2E that finds them). */
export const DIFF_WORKER_NAME = 'diff-highlighter'

let pool: WorkerPoolManager | undefined

/** A highlighter worker: the bundled module worker, from the app's own origin. */
function startWorker(): Worker {
  return new Worker(diffsWorkerUrl, { type: 'module', name: DIFF_WORKER_NAME })
}

/** The window's highlighter pool (made on first use), or undefined where workers cannot run. */
export function getDiffPool(): WorkerPoolManager | undefined {
  if (typeof Worker === 'undefined') return undefined
  pool ??= getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: startWorker,
      poolSize: POOL_SIZE,
    },
    highlighterOptions: {
      theme: DIFF_THEMES,
      preferredHighlighter: 'shiki-js',
      lineDiffType: 'word-alt',
      langs: [],
    },
  })
  return pool
}
